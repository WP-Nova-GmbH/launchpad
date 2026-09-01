import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayClientPrincipal,
  RelayMachineComputeUnavailableError,
  RelayMachineEnrollFailedError,
  RelayMachineEnrollProofInvalidError,
  RelayMachineEnrollUnavailableError,
  RelayMachineId,
  RelayOrganizationId,
  type RelayMachine,
  type RelayMachineComputeKind,
  type RelayMachineComputeUnavailableReason,
  type RelayMachineEnrollFailedReason,
  type RelayMachineEnrollProofInvalidReason,
  type RelayMachineRole,
} from "@t3tools/contracts/relay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";

import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";
import { requireAdmin, resolveMembership } from "./TenancyApi.ts";
import { currentTraceId } from "../observability.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as MachineComputeProvider from "../machines/MachineComputeProvider.ts";
import * as MachineEnroller from "../machines/MachineEnroller.ts";
import * as MachineLimits from "../machines/MachineLimits.ts";
import * as Machines from "../machines/Machines.ts";

export function toApiMachine(record: Machines.MachineRecord): RelayMachine {
  return {
    machineId: RelayMachineId.make(record.machineId),
    organizationId: RelayOrganizationId.make(record.organizationId),
    role: record.role,
    label: record.label,
    status: Machines.machineStatus(record),
    computeKind: record.computeKind,
    environmentId: record.environmentId === null ? null : EnvironmentId.make(record.environmentId),
    endpoint: Machines.enrolledMachineIdentity(record)?.endpoint ?? null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    enrolledAt: record.enrolledAt,
    seedExpiresAt: record.seedExpiresAt,
    deprovisionedAt: record.deprovisionedAt,
  };
}

const machineComputeUnavailable = Effect.fnUntraced(function* (
  reason: RelayMachineComputeUnavailableReason,
) {
  const traceId = yield* currentTraceId;
  return yield* new RelayMachineComputeUnavailableError({
    code: "machine_compute_unavailable",
    reason,
    traceId,
  });
});

const machineEnrollFailed = Effect.fnUntraced(function* (reason: RelayMachineEnrollFailedReason) {
  const traceId = yield* currentTraceId;
  return yield* new RelayMachineEnrollFailedError({
    code: "machine_enroll_failed",
    reason,
    traceId,
  });
});

const machineEnrollProofInvalid = Effect.fnUntraced(function* (
  reason: RelayMachineEnrollProofInvalidReason,
) {
  const traceId = yield* currentTraceId;
  return yield* new RelayMachineEnrollProofInvalidError({
    code: "machine_enroll_proof_invalid",
    reason,
    traceId,
  });
});

const machineEnrollUnavailable = Effect.fnUntraced(function* () {
  const traceId = yield* currentTraceId;
  return yield* new RelayMachineEnrollUnavailableError({
    code: "machine_enroll_unavailable",
    reason: "managed_endpoint_provisioning_failed",
    traceId,
  });
});

/**
 * The shared front half of both machine-creation paths: quota, a fresh seed
 * stored only as its hash, and the record. What happens to the seed afterwards
 * is what distinguishes them — a compute driver receives it, or the admin does.
 */
const mintMachineRecord = Effect.fnUntraced(function* (input: {
  readonly organizationId: string;
  readonly createdByUserId: string;
  readonly label: string;
  readonly role: RelayMachineRole;
  readonly computeKind: RelayMachineComputeKind;
}) {
  const machines = yield* Machines.Machines;
  const machineLimits = yield* MachineLimits.MachineLimits;
  const crypto = yield* Crypto.Crypto;
  const { organizationId } = input;

  yield* machineLimits
    .ensureCapacity({ organizationId })
    .pipe(Effect.catchTag("MachineLimitExceeded", () => tenancyConflict("machine_limit_reached")));
  const machineId = yield* crypto.randomUUIDv4.pipe(
    Effect.catch(() => relayInternalErrorResponse("internal_error")),
  );
  const seed = yield* Machines.makeMachineSeed(crypto).pipe(
    Effect.catch(() => relayInternalErrorResponse("internal_error")),
  );
  const seedHash = yield* Machines.hashMachineSeed(crypto, seed).pipe(
    Effect.catch(() => relayInternalErrorResponse("internal_error")),
  );
  const now = yield* DateTime.now;
  const created = yield* machines.create({
    machineId,
    organizationId,
    role: input.role,
    label: input.label,
    computeKind: input.computeKind,
    seedHash,
    seedExpiresAt: DateTime.formatIso(
      DateTime.add(now, { hours: Machines.MACHINE_SEED_EXPIRY_HOURS }),
    ),
    createdByUserId: input.createdByUserId,
  });
  return { created, seed };
});

export const provisionMachineRecord = Effect.fn("relay.api.machines.provisionMachineRecord")(
  function* (input: {
    readonly organizationId: string;
    readonly createdByUserId: string;
    readonly label: string;
    readonly role: RelayMachineRole;
  }) {
    const machines = yield* Machines.Machines;
    const computeProvider = yield* MachineComputeProvider.MachineComputeProvider;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const { created, seed } = yield* mintMachineRecord({
      ...input,
      computeKind: computeProvider.kind,
    });
    const machineId = created.machineId;
    // The record exists before the compute so enrollment can never race an
    // unknown seed; a driver failure removes the never-enrolled record rather
    // than leaving a machine that can never call home.
    const compute = yield* computeProvider
      .create({
        machineId,
        organizationId: input.organizationId,
        role: input.role,
        label: input.label,
        relayUrl: normalizeRelayIssuer(config.relayIssuer),
        seed,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("machine compute creation failed", {
            machineId,
            errorTag: error._tag,
          }).pipe(Effect.andThen(machines.remove({ machineId }).pipe(Effect.ignore))),
        ),
        Effect.catchTags({
          MachineComputeNotConfigured: () => machineComputeUnavailable("not_configured"),
          MachineComputeRequestFailed: () => machineComputeUnavailable("request_failed"),
        }),
      );
    yield* machines.recordComputeRef({ machineId, computeRef: compute.computeRef });
    const settled = yield* machines.getById({ machineId });
    return toApiMachine(settled ?? { ...created, computeRef: compute.computeRef });
  },
);

/**
 * The self-hosted variant of provisioning: same record, same seed mechanics,
 * no compute driver. The seed leaves the relay exactly once, in this response
 * — like an invitation token, the admin delivers it to the machine themselves
 * (ADR-0002's self-hosted case).
 */
export const connectMachineRecord = Effect.fn("relay.api.machines.connectMachineRecord")(
  function* (input: {
    readonly organizationId: string;
    readonly createdByUserId: string;
    readonly label: string;
    readonly role: RelayMachineRole;
  }) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const { created, seed } = yield* mintMachineRecord({ ...input, computeKind: "self_hosted" });
    return {
      machine: toApiMachine(created),
      seed,
      relayUrl: normalizeRelayIssuer(config.relayIssuer),
    };
  },
);

export const deprovisionMachineRecord = Effect.fn("relay.api.machines.deprovisionMachineRecord")(
  function* (input: { readonly organizationId: string; readonly machineId: string }) {
    const machines = yield* Machines.Machines;
    const computeProvider = yield* MachineComputeProvider.MachineComputeProvider;
    const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;

    const machine = yield* machines.getById({ machineId: input.machineId });
    if (!machine || machine.organizationId !== input.organizationId) {
      return yield* tenancyNotFound("machine_not_found");
    }
    const ownerKey = Machines.machineEndpointOwnerKey(machine.organizationId);
    // Teardown is ordered so a failure part-way leaves a retryable state:
    // tombstone first (auth dies with it), then credentials, then endpoint,
    // then compute. Deprovisioning an already-deprovisioned machine re-runs
    // the external teardown, which is how a failed Cloudflare or driver call
    // gets finished on retry.
    const deprovisionTarget =
      machine.environmentId === null
        ? null
        : yield* managedEndpointProvider
            .prepareDeprovision({
              userId: ownerKey,
              environmentId: machine.environmentId,
            })
            .pipe(
              Effect.catchTag("ManagedEndpointDeprovisioningFailed", () =>
                relayInternalErrorResponse("upstream_unavailable"),
              ),
            );
    yield* machines.deprovision({ machineId: machine.machineId });
    if (machine.environmentId !== null && machine.environmentPublicKey !== null) {
      yield* credentials.revokeForEnvironmentPublicKey({
        environmentId: machine.environmentId,
        environmentPublicKey: machine.environmentPublicKey,
      });
    }
    if (machine.environmentId !== null) {
      yield* managedEndpointProvider
        .deprovision({
          userId: ownerKey,
          environmentId: machine.environmentId,
          target: deprovisionTarget,
        })
        .pipe(
          Effect.catchTag("ManagedEndpointDeprovisioningFailed", () =>
            relayInternalErrorResponse("upstream_unavailable"),
          ),
        );
    }
    if (machine.computeRef !== null) {
      yield* computeProvider
        .destroy({ computeKind: machine.computeKind, computeRef: machine.computeRef })
        .pipe(
          Effect.catchTags({
            MachineComputeNotConfigured: () => machineComputeUnavailable("not_configured"),
            MachineComputeRequestFailed: () => machineComputeUnavailable("request_failed"),
          }),
        );
    }
    return { ok: true };
  },
);

export const machinesApi = HttpApiBuilder.group(
  RelayApi,
  "machines",
  Effect.fnUntraced(function* (handlers) {
    const machines = yield* Machines.Machines;

    return handlers
      .handle(
        "listMachines",
        Effect.fn("relay.api.machines.list")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* resolveMembership({ userId });
          const records = yield* machines.listForOrganization({
            organizationId: membership.organization.organizationId,
          });
          return { machines: records.map(toApiMachine) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "provisionMachine",
        Effect.fn("relay.api.machines.provision")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* provisionMachineRecord({
            organizationId: membership.organization.organizationId,
            createdByUserId: membership.userId,
            label: args.payload.label,
            role: args.payload.role,
          });
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "connectMachine",
        Effect.fn("relay.api.machines.connect")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* connectMachineRecord({
            organizationId: membership.organization.organizationId,
            createdByUserId: membership.userId,
            label: args.payload.label,
            role: args.payload.role,
          });
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "deprovisionMachine",
        Effect.fn("relay.api.machines.deprovision")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* deprovisionMachineRecord({
            organizationId: membership.organization.organizationId,
            machineId: args.params.machineId,
          });
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const machineEnrollmentApi = HttpApiBuilder.group(
  RelayApi,
  "machineEnrollment",
  Effect.fnUntraced(function* (handlers) {
    const enroller = yield* MachineEnroller.MachineEnroller;
    const config = yield* RelayConfiguration.RelayConfiguration;

    return handlers.handle(
      "enrollMachine",
      Effect.fn("relay.api.machines.enroll")(function* (args) {
        const result = yield* enroller.enroll({ proof: args.payload.proof }).pipe(
          Effect.catchTags({
            MachineEnrollProofInvalid: (error) => machineEnrollProofInvalid(error.reason),
            ManagedEndpointOriginNotAllowed: () => machineEnrollProofInvalid("origin_not_allowed"),
            ManagedEndpointProvisioningNotConfigured: () => machineEnrollUnavailable(),
            ManagedEndpointProvisioningFailed: () => machineEnrollUnavailable(),
            ManagedTunnelLimitExceeded: () => machineEnrollUnavailable(),
            MachinePersistenceError: () => machineEnrollFailed("enrollment_persistence_failed"),
            EnvironmentPublicKeyListPersistenceError: () =>
              machineEnrollFailed("enrollment_persistence_failed"),
            DpopProofReplayPersistenceError: () => machineEnrollFailed("replay_persistence_failed"),
            EnvironmentCredentialCreatePersistenceError: () =>
              machineEnrollFailed("credential_persistence_failed"),
          }),
        );
        const machine = result.machine;
        if (machine.environmentId === null) {
          return yield* machineEnrollFailed("internal_error");
        }
        return {
          ok: true,
          machineId: RelayMachineId.make(machine.machineId),
          organizationId: RelayOrganizationId.make(machine.organizationId),
          role: machine.role,
          environmentId: EnvironmentId.make(machine.environmentId),
          endpoint: result.endpoint,
          endpointRuntime: result.endpointRuntime,
          relayIssuer: normalizeRelayIssuer(config.relayIssuer),
          environmentCredential: result.environmentCredential,
          cloudMintPublicKey: config.cloudMintPublicKey,
        };
      }),
    );
  }),
);
