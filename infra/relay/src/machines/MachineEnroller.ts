import {
  RelayMachineEnrollProofPayload,
  RelayMachineEnrollProofInvalidReason,
  type RelayManagedEndpoint,
  type RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_MACHINE_ENROLL_PROOF_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as Machines from "./Machines.ts";

export class MachineEnrollProofInvalid extends Schema.TaggedErrorClass<MachineEnrollProofInvalid>()(
  "MachineEnrollProofInvalid",
  {
    environmentId: Schema.String,
    reason: RelayMachineEnrollProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "decode_payload",
      "verify_proof",
      "validate_descriptor",
      "verify_seed",
      "consume_proof_nonce",
      "verify_environment_unclaimed",
      "claim_enrollment",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Machine enrollment proof for environment '${this.environmentId}' is invalid during ${this.stage}: ${this.reason}`;
  }
}

export type MachineEnrollError =
  | MachineEnrollProofInvalid
  | Machines.MachinePersistenceError
  | DpopProofs.DpopProofReplayPersistenceError
  | EnvironmentLinks.EnvironmentPublicKeyListPersistenceError
  | EnvironmentCredentials.EnvironmentCredentialCreatePersistenceError
  | ManagedEndpointProvider.ManagedEndpointProviderError;

export interface MachineEnrollResult {
  readonly machine: Machines.MachineRecord;
  readonly endpoint: RelayManagedEndpoint;
  readonly endpointRuntime: RelayManagedEndpointRuntimeConfig | null;
  readonly environmentCredential: string;
}

export class MachineEnroller extends Context.Service<
  MachineEnroller,
  {
    readonly enroll: (input: {
      readonly proof: string;
    }) => Effect.Effect<MachineEnrollResult, MachineEnrollError>;
  }
>()("t3code-relay/machines/MachineEnroller") {}

const decodeProof = Schema.decodeUnknownEffect(RelayMachineEnrollProofPayload);

const make = Effect.gen(function* () {
  const machines = yield* Machines.Machines;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;

  return MachineEnroller.of({
    enroll: Effect.fn("relay.machine_enroller.enroll")(function* (input) {
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const unverified = yield* Effect.try({
        try: () => decodeRelayJwt(input.proof),
        catch: (cause) =>
          new MachineEnrollProofInvalid({
            environmentId: "unknown",
            reason: "invalid_signature_or_scope",
            stage: "decode_token",
            cause,
          }),
      });
      const candidate = yield* decodeProof(unverified).pipe(
        Effect.mapError(
          (cause) =>
            new MachineEnrollProofInvalid({
              environmentId: "unknown",
              reason: "invalid_signature_or_scope",
              stage: "decode_payload",
              cause,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": candidate.environmentId,
      });
      const relayIssuer = normalizeRelayIssuer(config.relayIssuer);
      const verified = yield* verifyRelayJwt({
        publicKey: candidate.environmentPublicKey,
        token: input.proof,
        typ: RELAY_MACHINE_ENROLL_PROOF_TYP,
        issuer: `t3-env:${candidate.environmentId}`,
        audience: relayIssuer,
        nowEpochSeconds: nowSeconds,
      }).pipe(
        Effect.flatMap(decodeProof),
        Effect.mapError(
          (cause) =>
            new MachineEnrollProofInvalid({
              environmentId: candidate.environmentId,
              reason: "invalid_signature_or_scope",
              stage: "verify_proof",
              cause,
            }),
        ),
      );
      if (
        verified.sub !== verified.environmentId ||
        verified.descriptor.environmentId !== verified.environmentId
      ) {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "validate_descriptor",
        });
      }

      const seedHash = yield* Machines.hashMachineSeed(crypto, verified.seed).pipe(
        Effect.mapError(
          (cause) =>
            new MachineEnrollProofInvalid({
              environmentId: verified.environmentId,
              reason: "seed_invalid",
              stage: "verify_seed",
              cause,
            }),
        ),
      );
      const machine = yield* machines.getBySeedHash({ seedHash });
      // One answer for unknown, consumed, expired, and deprovisioned alike:
      // this endpoint is unauthenticated, and the seed's state is nothing an
      // unauthenticated caller should be able to probe.
      if (
        machine === null ||
        machine.enrolledAt !== null ||
        machine.deprovisionedAt !== null ||
        Date.parse(machine.seedExpiresAt) <= now.epochMilliseconds
      ) {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "seed_invalid",
          stage: "verify_seed",
        });
      }
      yield* Effect.annotateCurrentSpan({
        "relay.machine_id": machine.machineId,
        "relay.organization_id": machine.organizationId,
      });

      const proofExpiresAt = DateTime.make(verified.exp * 1_000);
      if (proofExpiresAt._tag === "None") {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "verify_proof",
        });
      }
      const consumedNonce = yield* proofReplay.consume({
        thumbprint: verified.environmentPublicKey,
        jti: verified.jti,
        iat: verified.iat,
        expiresAt: proofExpiresAt.value,
      });
      if (!consumedNonce) {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "replayed_nonce",
          stage: "consume_proof_nonce",
        });
      }

      // The two trust paths never share an environment: an identity someone
      // already linked as a personal environment cannot become a machine, just
      // as a machine cannot be linked (ADR-0002).
      const linkedKeys = yield* links.listPublicKeysForEnvironment({
        environmentId: verified.environmentId,
      });
      const claimedBy = yield* machines.getActiveByEnvironmentId({
        environmentId: verified.environmentId,
      });
      if (
        linkedKeys.length > 0 ||
        (claimedBy !== null && claimedBy.machineId !== machine.machineId)
      ) {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "environment_already_linked",
          stage: "verify_environment_unclaimed",
        });
      }

      // With Cloudflare configured the relay owns the endpoint: a tunnel under
      // the org's synthetic owner key. Without it (the dev relay) the
      // machine's self-reported endpoint is recorded as `manual`, exactly like
      // a publish-only link — never used for routing.
      const tunnelsConfigured =
        config.managedEndpointBaseDomain !== undefined &&
        config.managedEndpointNamespace !== undefined;
      const provisioned = tunnelsConfigured
        ? yield* managedEndpointProvider.provision({
            userId: Machines.machineEndpointOwnerKey(machine.organizationId),
            environmentId: verified.environmentId,
            origin: verified.origin,
          })
        : null;
      const endpoint = provisioned?.endpoint ?? {
        httpBaseUrl: verified.endpoint.httpBaseUrl,
        wsBaseUrl: verified.endpoint.wsBaseUrl,
        providerKind: "manual" as const,
      };

      const claimed = yield* machines.claimEnrollment({
        machineId: machine.machineId,
        environmentId: verified.environmentId,
        environmentPublicKey: verified.environmentPublicKey,
        endpoint,
      });
      if (!claimed) {
        return yield* new MachineEnrollProofInvalid({
          environmentId: verified.environmentId,
          reason: "seed_invalid",
          stage: "claim_enrollment",
        });
      }
      const environmentCredential = yield* credentials.create({
        environmentId: verified.environmentId,
        environmentPublicKey: verified.environmentPublicKey,
      });
      const enrolled = yield* machines.getById({ machineId: machine.machineId });
      return {
        machine: enrolled ?? machine,
        endpoint,
        endpointRuntime: provisioned?.runtime ?? null,
        environmentCredential,
      };
    }),
  });
});

export const layer = Layer.effect(MachineEnroller, make);
