import * as NodeCrypto from "node:crypto";
import type { RelayMachineEnrollProofPayload } from "@t3tools/contracts/relay";
import { RELAY_MACHINE_ENROLL_PROOF_TYP } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as MachineEnroller from "./MachineEnroller.ts";
import * as Machines from "./Machines.ts";

const machineKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const otherKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const TEST_SEED = "t3mseed_test_seed_value";

function makeConfig(input?: { readonly tunnels?: boolean }) {
  return RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: {
      environment: "sandbox",
      teamId: "team-id",
      keyId: "key-id",
      privateKey: Redacted.make("private-key"),
      bundleId: "com.t3tools.t3code.dev",
    },
    apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "t3-code-relay",
    cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
    cloudMintPublicKey: "cloud-mint-public-key",
    github: undefined,
    managedEndpointBaseDomain: input?.tunnels ? "t3.example.test" : undefined,
    managedEndpointNamespace: input?.tunnels ? "test" : undefined,
  });
}

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const seedHashOf = (seed: string) =>
  Buffer.from(
    NodeCrypto.createHash("sha256").update(new TextEncoder().encode(seed)).digest(),
  ).toString("base64url");

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const makeProof = (input?: { readonly privateKey?: string }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const payload = {
      iss: "t3-env:env-machine-test",
      aud: "https://relay.example.test",
      sub: "env-machine-test",
      jti: "machine-enroll-jti",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      seed: TEST_SEED,
      environmentId: "env-machine-test" as RelayMachineEnrollProofPayload["environmentId"],
      descriptor: {
        environmentId: "env-machine-test" as RelayMachineEnrollProofPayload["environmentId"],
        label: "Machine Test Environment",
        platform: { os: "linux", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      environmentPublicKey: machineKeyPair.publicKey.trim(),
      endpoint: {
        httpBaseUrl: "http://127.0.0.1:23000/",
        wsBaseUrl: "ws://127.0.0.1:23000/",
        providerKind: "manual",
      },
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 4483 },
    } satisfies RelayMachineEnrollProofPayload;
    return signTestJwt(
      payload,
      RELAY_MACHINE_ENROLL_PROOF_TYP,
      input?.privateKey ?? machineKeyPair.privateKey,
    );
  });

// Static timestamps: far future stays valid and pre-epoch stays expired under
// the wall clock and the test clock alike.
const pendingMachine = (overrides?: Partial<Machines.MachineRecord>): Machines.MachineRecord => ({
  machineId: "machine-1",
  organizationId: "organization-1",
  role: "agent_executor",
  label: "Executor 1",
  computeKind: "docker",
  computeRef: "container-1",
  seedExpiresAt: "2100-01-01T00:00:00.000Z",
  environmentId: null,
  environmentPublicKey: null,
  endpointHttpBaseUrl: null,
  endpointWsBaseUrl: null,
  endpointProviderKind: null,
  createdByUserId: "user_admin",
  enrolledAt: null,
  deprovisionedAt: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

const unexpected = () => Effect.die("unexpected machine store call");

interface ClaimRecord {
  readonly machineId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly endpoint: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly providerKind: string;
  };
}

function testLayer(input?: {
  readonly tunnels?: boolean;
  readonly machine?: Machines.MachineRecord | null;
  readonly consume?: DpopProofs.DpopProofReplay["Service"]["consume"];
  readonly linkedPublicKeys?: ReadonlyArray<string>;
  readonly claimEnrollment?: Machines.Machines["Service"]["claimEnrollment"];
  readonly onClaim?: (claim: ClaimRecord) => void;
  readonly onProvision?: (provisionInput: {
    readonly userId: string;
    readonly environmentId: string;
    readonly origin: { readonly localHttpHost: string; readonly localHttpPort: number };
  }) => void;
  readonly activeByEnvironment?: Machines.MachineRecord | null;
}) {
  const machine = input?.machine ?? null;
  return MachineEnroller.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayConfiguration.RelayConfiguration, makeConfig(input)),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume: () => Effect.die("unexpected DPoP proof verification"),
          consume: input?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: Effect.void,
        }),
        Layer.succeed(
          Machines.Machines,
          Machines.Machines.of({
            create: unexpected,
            getById: () => Effect.succeed(machine),
            listForOrganization: unexpected,
            countActiveForOrganization: unexpected,
            getBySeedHash: ({ seedHash }) =>
              Effect.succeed(
                machine !== null && seedHash === seedHashOf(TEST_SEED) ? machine : null,
              ),
            getActiveByEnvironmentId: () => Effect.succeed(input?.activeByEnvironment ?? null),
            recordComputeRef: unexpected,
            claimEnrollment:
              input?.claimEnrollment ??
              ((claim) => {
                input?.onClaim?.(claim);
                return Effect.succeed(true);
              }),
            deprovision: unexpected,
            remove: unexpected,
          }),
        ),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          upsert: () => Effect.die("unexpected link upsert"),
          listUsersForEnvironment: () => Effect.succeed([]),
          listDeliveryUsersForEnvironment: () => Effect.succeed([]),
          listPublicKeysForEnvironment: () => Effect.succeed(input?.linkedPublicKeys ?? []),
          listForUser: () => Effect.succeed([]),
          getForUser: () => Effect.succeed(null),
          revokeForUser: () => Effect.succeed(false),
        }),
        Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
          create: () => Effect.succeed("t3env_credential_secret"),
          authenticate: () => Effect.succeedNone,
          revokeForEnvironmentPublicKey: () => Effect.succeed(false),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: () => Effect.void,
          release: () => Effect.succeed(true),
          provision: (provisionInput) => {
            input?.onProvision?.(provisionInput);
            return Effect.succeed({
              endpoint: {
                httpBaseUrl: "https://machine.t3.example.test/",
                wsBaseUrl: "wss://machine.t3.example.test/ws",
                providerKind: "cloudflare_tunnel" as const,
              },
              runtime: {
                providerKind: "cloudflare_tunnel" as const,
                connectorToken: "connector-token",
              },
            });
          },
        }),
        cryptoLayer,
      ),
    ),
  );
}

const isProofInvalid = Schema.is(MachineEnroller.MachineEnrollProofInvalid);

const enrollWith = (
  layer: ReturnType<typeof testLayer>,
  input?: { readonly privateKey?: string },
) =>
  Effect.gen(function* () {
    const enroller = yield* MachineEnroller.MachineEnroller;
    const proof = yield* makeProof(input);
    return yield* enroller.enroll({ proof });
  }).pipe(Effect.provide(layer));

describe("MachineEnroller", () => {
  it.effect("enrolls with the machine's own endpoint when tunnels are not configured", () => {
    let claimed: ClaimRecord | null = null;
    return Effect.gen(function* () {
      const result = yield* enrollWith(
        testLayer({
          machine: pendingMachine(),
          onClaim: (claim) => {
            claimed = claim;
          },
        }),
      );
      expect(result.environmentCredential).toBe("t3env_credential_secret");
      expect(result.endpointRuntime).toBeNull();
      expect(result.endpoint).toEqual({
        httpBaseUrl: "http://127.0.0.1:23000/",
        wsBaseUrl: "ws://127.0.0.1:23000/",
        providerKind: "manual",
      });
      expect(claimed).toMatchObject({
        machineId: "machine-1",
        environmentId: "env-machine-test",
        environmentPublicKey: machineKeyPair.publicKey.trim(),
      });
    });
  });

  it.effect("provisions the managed endpoint under the organization owner key", () => {
    let provisionedFor: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: { readonly localHttpHost: string; readonly localHttpPort: number };
    } | null = null;
    return Effect.gen(function* () {
      const result = yield* enrollWith(
        testLayer({
          tunnels: true,
          machine: pendingMachine(),
          onProvision: (provisionInput) => {
            provisionedFor = provisionInput;
          },
        }),
      );
      expect(provisionedFor).toEqual({
        userId: "org:organization-1",
        environmentId: "env-machine-test",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 4483 },
      });
      expect(result.endpoint.providerKind).toBe("cloudflare_tunnel");
      expect(result.endpointRuntime?.connectorToken).toBe("connector-token");
    });
  });

  it.effect("answers seed_invalid alike for unknown, consumed, and expired seeds", () =>
    Effect.gen(function* () {
      const unknownSeed = yield* Effect.flip(enrollWith(testLayer({ machine: null })));
      expect(isProofInvalid(unknownSeed) && unknownSeed.reason).toBe("seed_invalid");

      const consumedSeed = yield* Effect.flip(
        enrollWith(
          testLayer({
            machine: pendingMachine({
              enrolledAt: "2026-08-19T00:00:00.000Z",
              environmentId: "env-machine-test",
            }),
          }),
        ),
      );
      expect(isProofInvalid(consumedSeed) && consumedSeed.reason).toBe("seed_invalid");

      const expiredSeed = yield* Effect.flip(
        enrollWith(
          testLayer({ machine: pendingMachine({ seedExpiresAt: "1969-12-31T00:00:00.000Z" }) }),
        ),
      );
      expect(isProofInvalid(expiredSeed) && expiredSeed.reason).toBe("seed_invalid");
    }),
  );

  it.effect("rejects a proof signed by a key that does not match its public key", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enrollWith(testLayer({ machine: pendingMachine() }), {
          privateKey: otherKeyPair.privateKey,
        }),
      );
      expect(isProofInvalid(error) && error.reason).toBe("invalid_signature_or_scope");
    }),
  );

  it.effect("rejects a replayed proof nonce", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enrollWith(testLayer({ machine: pendingMachine(), consume: () => Effect.succeed(false) })),
      );
      expect(isProofInvalid(error) && error.reason).toBe("replayed_nonce");
    }),
  );

  it.effect("refuses an environment that is already linked as a personal environment", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enrollWith(testLayer({ machine: pendingMachine(), linkedPublicKeys: ["some-public-key"] })),
      );
      expect(isProofInvalid(error) && error.reason).toBe("environment_already_linked");
    }),
  );

  it.effect("refuses an environment another machine already claimed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enrollWith(
          testLayer({
            machine: pendingMachine(),
            activeByEnvironment: pendingMachine({
              machineId: "machine-2",
              environmentId: "env-machine-test",
              enrolledAt: "2026-08-19T00:00:00.000Z",
            }),
          }),
        ),
      );
      expect(isProofInvalid(error) && error.reason).toBe("environment_already_linked");
    }),
  );

  it.effect("treats a lost enrollment claim race as a consumed seed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enrollWith(
          testLayer({ machine: pendingMachine(), claimEnrollment: () => Effect.succeed(false) }),
        ),
      );
      expect(isProofInvalid(error) && error.reason).toBe("seed_invalid");
    }),
  );
});
