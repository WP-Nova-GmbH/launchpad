import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off - fixed in-process signing identities.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  AuthOrchestrationReadScope,
  REPOSITORY_POLICY_ACK_TYPE,
  REPOSITORY_POLICY_PROOF_TYPE,
} from "@t3tools/contracts";
import { signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "./config.ts";
import { applyRepositoryPolicyProof } from "./repositoryPolicy.ts";

const keys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
const encodeKeys = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String })),
);
const relayKeys = keys(),
  environmentKeys = keys(),
  wrongKeys = keys();
it.effect(
  "applies only the relay's environment-bound complete policy and signs its acknowledgement",
  () =>
    Effect.gen(function* () {
      const base = yield* RepositoryAccess;
      let appliedRevision = 0;
      let rejectApply = false;
      const activationRequests: boolean[] = [];
      const values = new Map([
        [CLOUD_MINT_PUBLIC_KEY, relayKeys.publicKey],
        [RELAY_ISSUER_SECRET, "https://relay.example"],
        ["cloud-link-ed25519-key-pair", yield* encodeKeys(environmentKeys)],
      ]);
      const secrets: ServerSecretStore["Service"] = {
        get: (name) =>
          Effect.succeed(
            Option.fromNullishOr(values.get(name)).pipe(
              Option.map((v) => new TextEncoder().encode(v)),
            ),
          ),
        set: () => Effect.void,
        create: () => Effect.void,
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.die("unused"),
      };
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const claims = {
        iss: "https://relay.example",
        aud: "t3-env:environment",
        sub: "org",
        jti: "policy",
        iat: now,
        exp: now + 120,
        environmentId: "environment",
        policy: {
          organizationId: "org",
          revision: 8,
          members: [{ userId: "user", role: "member" as const }],
          repositories: [],
        },
      };
      yield* Effect.gen(function* () {
        const forged = yield* signRelayJwt({
          privateKey: wrongKeys.privateKey,
          typ: REPOSITORY_POLICY_PROOF_TYPE,
          payload: claims,
        });
        expect(yield* applyRepositoryPolicyProof({ proof: forged }).pipe(Effect.isFailure)).toBe(
          true,
        );
        expect(appliedRevision).toBe(0);
        const wrongAudience = yield* signRelayJwt({
          privateKey: relayKeys.privateKey,
          typ: REPOSITORY_POLICY_PROOF_TYPE,
          payload: { ...claims, aud: "t3-env:other" },
        });
        expect(
          yield* applyRepositoryPolicyProof({ proof: wrongAudience }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(appliedRevision).toBe(0);
        const proof = yield* signRelayJwt({
          privateKey: relayKeys.privateKey,
          typ: REPOSITORY_POLICY_PROOF_TYPE,
          payload: claims,
        });
        rejectApply = true;
        expect(yield* applyRepositoryPolicyProof({ proof }, true).pipe(Effect.isFailure)).toBe(
          true,
        );
        expect(appliedRevision).toBe(0);
        rejectApply = false;
        const ack = yield* applyRepositoryPolicyProof({ proof });
        expect(appliedRevision).toBe(8);
        expect(activationRequests).toEqual([true, false]);
        const signed = yield* verifyRelayJwt({
          publicKey: environmentKeys.publicKey,
          token: ack.proof,
          typ: REPOSITORY_POLICY_ACK_TYPE,
          issuer: "t3-env:environment",
          audience: "https://relay.example",
          nowEpochSeconds: now,
        });
        expect(signed).toMatchObject({ environmentId: "environment", revision: 8 });
      }).pipe(
        Effect.provideService(ServerSecretStore, secrets),
        Effect.provideService(RepositoryAccess, {
          ...base,
          apply: (policy, activate = false) =>
            Effect.suspend(() => {
              activationRequests.push(activate);
              if (rejectApply)
                return Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "Policy persistence unavailable",
                    requiredScope: AuthOrchestrationReadScope,
                  }),
                );
              appliedRevision = policy.revision;
              return Effect.succeed(policy.revision);
            }),
        }),
        Effect.provide(
          Layer.mock(ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeCryptoLayer.layer)),
);
