import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as MachineComputeProvider from "../machines/MachineComputeProvider.ts";
import * as MachineLimits from "../machines/MachineLimits.ts";
import * as Machines from "../machines/Machines.ts";
import {
  connectMachineRecord,
  deprovisionMachineRecord,
  provisionMachineRecord,
} from "./MachinesApi.ts";

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  github: undefined,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

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

const unexpected = (what: string) => () => Effect.die(`unexpected ${what}`);

const enrolledMachine = (overrides?: Partial<Machines.MachineRecord>): Machines.MachineRecord => ({
  machineId: "machine-1",
  organizationId: "organization-1",
  role: "agent_executor",
  label: "Executor 1",
  computeKind: "docker",
  computeRef: "container-1",
  seedExpiresAt: "2100-01-01T00:00:00.000Z",
  environmentId: "env-machine-test",
  environmentPublicKey: "machine-public-key",
  endpointHttpBaseUrl: "https://machine.t3.example.test/",
  endpointWsBaseUrl: "wss://machine.t3.example.test/ws",
  endpointProviderKind: "cloudflare_tunnel",
  createdByUserId: "user_admin",
  enrolledAt: "2026-08-19T01:00:00.000Z",
  deprovisionedAt: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

function machinesLayer(overrides: Partial<Machines.Machines["Service"]>) {
  return Layer.succeed(
    Machines.Machines,
    Machines.Machines.of({
      create: unexpected("create"),
      getById: unexpected("getById"),
      listForOrganization: unexpected("listForOrganization"),
      countActiveForOrganization: unexpected("countActiveForOrganization"),
      getBySeedHash: unexpected("getBySeedHash"),
      getActiveByEnvironmentId: unexpected("getActiveByEnvironmentId"),
      recordComputeRef: unexpected("recordComputeRef"),
      claimEnrollment: unexpected("claimEnrollment"),
      deprovision: unexpected("deprovision"),
      remove: unexpected("remove"),
      ...overrides,
    }),
  );
}

function limitsLayer(overrides?: Partial<MachineLimits.MachineLimits["Service"]>) {
  return Layer.succeed(
    MachineLimits.MachineLimits,
    MachineLimits.MachineLimits.of({
      ensureCapacity: () => Effect.void,
      ...overrides,
    }),
  );
}

function computeLayer(
  overrides?: Partial<MachineComputeProvider.MachineComputeProvider["Service"]>,
) {
  return Layer.succeed(
    MachineComputeProvider.MachineComputeProvider,
    MachineComputeProvider.MachineComputeProvider.of({
      kind: "docker",
      create: unexpected("compute create"),
      destroy: unexpected("compute destroy"),
      ...overrides,
    }),
  );
}

function endpointLayer(
  overrides?: Partial<ManagedEndpointProvider.ManagedEndpointProvider["Service"]>,
) {
  return Layer.succeed(
    ManagedEndpointProvider.ManagedEndpointProvider,
    ManagedEndpointProvider.ManagedEndpointProvider.of({
      prepareDeprovision: () => Effect.succeed(null),
      deprovision: () => Effect.void,
      release: () => Effect.succeed(true),
      provision: unexpected("endpoint provision"),
      ...overrides,
    }),
  );
}

function credentialsLayer(
  overrides?: Partial<EnvironmentCredentials.EnvironmentCredentials["Service"]>,
) {
  return Layer.succeed(
    EnvironmentCredentials.EnvironmentCredentials,
    EnvironmentCredentials.EnvironmentCredentials.of({
      create: unexpected("credential create"),
      authenticate: unexpected("credential authenticate"),
      revokeForEnvironmentPublicKey: unexpected("credential revoke"),
      ...overrides,
    }),
  );
}

const baseLayer = Layer.mergeAll(RelayConfiguration.layer(relaySettings), cryptoLayer);

describe("provisionMachineRecord", () => {
  it.effect(
    "creates the record before compute and hands the driver a seed matching the stored hash",
    () => {
      const calls: Array<string> = [];
      let storedSeedHash: string | null = null;
      let driverSeed: string | null = null;
      let createdRecord: Machines.MachineRecord | null = null;
      return Effect.gen(function* () {
        const machine = yield* provisionMachineRecord({
          organizationId: "organization-1",
          createdByUserId: "user_admin",
          label: "Executor 1",
          role: "agent_executor",
        });
        expect(calls).toEqual(["create", "compute-create", "record-compute-ref"]);
        expect(driverSeed).toMatch(/^t3mseed_[0-9a-f]{64}$/);
        expect(storedSeedHash).toBe(seedHashOf(driverSeed ?? ""));
        expect(machine.status).toBe("awaiting_enrollment");
        expect(machine.computeKind).toBe("docker");
        expect(machine.role).toBe("agent_executor");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayer,
            limitsLayer(),
            credentialsLayer(),
            endpointLayer(),
            machinesLayer({
              create: (input) =>
                Effect.sync(() => {
                  calls.push("create");
                  storedSeedHash = input.seedHash;
                  createdRecord = {
                    ...input,
                    computeRef: null,
                    environmentId: null,
                    environmentPublicKey: null,
                    endpointHttpBaseUrl: null,
                    endpointWsBaseUrl: null,
                    endpointProviderKind: null,
                    enrolledAt: null,
                    deprovisionedAt: null,
                    createdAt: "2026-08-19T00:00:00.000Z",
                  };
                  return createdRecord;
                }),
              recordComputeRef: () =>
                Effect.sync(() => {
                  calls.push("record-compute-ref");
                }),
              getById: () => Effect.succeed(createdRecord),
            }),
            computeLayer({
              create: (input) =>
                Effect.sync(() => {
                  calls.push("compute-create");
                  driverSeed = input.seed;
                  expect(input.relayUrl).toBe("https://relay.example.test");
                  return { computeKind: "docker" as const, computeRef: "container-1" };
                }),
            }),
          ),
        ),
      );
    },
  );

  it.effect("refuses provisioning past the organization quota", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        provisionMachineRecord({
          organizationId: "organization-1",
          createdByUserId: "user_admin",
          label: "Executor 1",
          role: "agent_executor",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyConflictError",
        reason: "machine_limit_reached",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer({
            ensureCapacity: (input) =>
              Effect.fail(
                new MachineLimits.MachineLimitExceeded({
                  organizationId: input.organizationId,
                  maxMachines: 5,
                  activeMachines: 5,
                }),
              ),
          }),
          credentialsLayer(),
          endpointLayer(),
          machinesLayer({}),
          computeLayer(),
        ),
      ),
    ),
  );

  it.effect("removes the record when the compute driver fails", () => {
    let removedMachineId: string | null = null;
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        provisionMachineRecord({
          organizationId: "organization-1",
          createdByUserId: "user_admin",
          label: "Executor 1",
          role: "review_host",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayMachineComputeUnavailableError",
        reason: "request_failed",
      });
      expect(removedMachineId).not.toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer(),
          endpointLayer(),
          machinesLayer({
            create: (input) =>
              Effect.succeed({
                ...input,
                computeRef: null,
                environmentId: null,
                environmentPublicKey: null,
                endpointHttpBaseUrl: null,
                endpointWsBaseUrl: null,
                endpointProviderKind: null,
                enrolledAt: null,
                deprovisionedAt: null,
                createdAt: "2026-08-19T00:00:00.000Z",
              }),
            remove: (input) =>
              Effect.sync(() => {
                removedMachineId = input.machineId;
              }),
          }),
          computeLayer({
            create: (input) =>
              Effect.fail(
                new MachineComputeProvider.MachineComputeRequestFailed({
                  operation: "create",
                  computeKind: "docker",
                  machineId: input.machineId,
                  cause: new Error("driver down"),
                }),
              ),
          }),
        ),
      ),
    );
  });
});

describe("connectMachineRecord", () => {
  it.effect("returns the seed exactly once and never touches a compute driver", () => {
    let storedSeedHash: string | null = null;
    return Effect.gen(function* () {
      const result = yield* connectMachineRecord({
        organizationId: "organization-1",
        createdByUserId: "user_admin",
        label: "Laptop",
        role: "agent_executor",
      });
      expect(result.seed).toMatch(/^t3mseed_[0-9a-f]{64}$/);
      expect(storedSeedHash).toBe(seedHashOf(result.seed));
      expect(result.relayUrl).toBe("https://relay.example.test");
      expect(result.machine.computeKind).toBe("self_hosted");
      expect(result.machine.status).toBe("awaiting_enrollment");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer(),
          endpointLayer(),
          machinesLayer({
            create: (input) =>
              Effect.sync(() => {
                storedSeedHash = input.seedHash;
                return {
                  ...input,
                  computeRef: null,
                  environmentId: null,
                  environmentPublicKey: null,
                  endpointHttpBaseUrl: null,
                  endpointWsBaseUrl: null,
                  endpointProviderKind: null,
                  enrolledAt: null,
                  deprovisionedAt: null,
                  createdAt: "2026-08-31T00:00:00.000Z",
                };
              }),
          }),
          // Every compute call is `unexpected`: a self-hosted machine has no driver.
          computeLayer(),
        ),
      ),
    );
  });

  it.effect("refuses connecting past the organization quota", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        connectMachineRecord({
          organizationId: "organization-1",
          createdByUserId: "user_admin",
          label: "Laptop",
          role: "agent_executor",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyConflictError",
        reason: "machine_limit_reached",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer({
            ensureCapacity: (input) =>
              Effect.fail(
                new MachineLimits.MachineLimitExceeded({
                  organizationId: input.organizationId,
                  maxMachines: 5,
                  activeMachines: 5,
                }),
              ),
          }),
          credentialsLayer(),
          endpointLayer(),
          machinesLayer({}),
          computeLayer(),
        ),
      ),
    ),
  );
});

describe("deprovisionMachineRecord", () => {
  it.effect("answers not-found for machines of other organizations", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        deprovisionMachineRecord({ organizationId: "organization-2", machineId: "machine-1" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyNotFoundError",
        reason: "machine_not_found",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer(),
          endpointLayer(),
          machinesLayer({ getById: () => Effect.succeed(enrolledMachine()) }),
          computeLayer(),
        ),
      ),
    ),
  );

  it.effect("tombstones first, then revokes credentials, endpoint, and compute", () => {
    const calls: Array<string> = [];
    let endpointOwner: string | null = null;
    return Effect.gen(function* () {
      const result = yield* deprovisionMachineRecord({
        organizationId: "organization-1",
        machineId: "machine-1",
      });
      expect(result).toEqual({ ok: true });
      expect(calls).toEqual([
        "prepare-deprovision",
        "tombstone",
        "revoke-credentials",
        "deprovision-endpoint",
        "destroy-compute",
      ]);
      expect(endpointOwner).toBe("org:organization-1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer({
            revokeForEnvironmentPublicKey: (input) =>
              Effect.sync(() => {
                calls.push("revoke-credentials");
                expect(input).toEqual({
                  environmentId: "env-machine-test",
                  environmentPublicKey: "machine-public-key",
                });
                return true;
              }),
          }),
          endpointLayer({
            prepareDeprovision: () =>
              Effect.sync(() => {
                calls.push("prepare-deprovision");
                return null;
              }),
            deprovision: (input) =>
              Effect.sync(() => {
                calls.push("deprovision-endpoint");
                endpointOwner = input.userId;
              }),
          }),
          machinesLayer({
            getById: () => Effect.succeed(enrolledMachine()),
            deprovision: () =>
              Effect.sync(() => {
                calls.push("tombstone");
                return true;
              }),
          }),
          computeLayer({
            destroy: (input) =>
              Effect.sync(() => {
                calls.push("destroy-compute");
                expect(input).toEqual({ computeKind: "docker", computeRef: "container-1" });
              }),
          }),
        ),
      ),
    );
  });

  it.effect("tears down an enrolled self-hosted machine without a compute call", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const result = yield* deprovisionMachineRecord({
        organizationId: "organization-1",
        machineId: "machine-1",
      });
      expect(result).toEqual({ ok: true });
      expect(calls).toEqual([
        "prepare-deprovision",
        "tombstone",
        "revoke-credentials",
        "deprovision-endpoint",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer({
            revokeForEnvironmentPublicKey: () =>
              Effect.sync(() => {
                calls.push("revoke-credentials");
                return true;
              }),
          }),
          endpointLayer({
            prepareDeprovision: () =>
              Effect.sync(() => {
                calls.push("prepare-deprovision");
                return null;
              }),
            deprovision: () =>
              Effect.sync(() => {
                calls.push("deprovision-endpoint");
              }),
          }),
          machinesLayer({
            getById: () =>
              Effect.succeed(enrolledMachine({ computeKind: "self_hosted", computeRef: null })),
            deprovision: () =>
              Effect.sync(() => {
                calls.push("tombstone");
                return true;
              }),
          }),
          // A self-hosted machine has no compute ref, so destroy stays `unexpected`.
          computeLayer(),
        ),
      ),
    );
  });

  it.effect("skips credential and endpoint teardown for a machine that never enrolled", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const result = yield* deprovisionMachineRecord({
        organizationId: "organization-1",
        machineId: "machine-1",
      });
      expect(result).toEqual({ ok: true });
      expect(calls).toEqual(["tombstone", "destroy-compute"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          baseLayer,
          limitsLayer(),
          credentialsLayer(),
          endpointLayer({
            prepareDeprovision: unexpected("prepareDeprovision"),
            deprovision: unexpected("endpoint deprovision"),
          }),
          machinesLayer({
            getById: () =>
              Effect.succeed(
                enrolledMachine({
                  environmentId: null,
                  environmentPublicKey: null,
                  endpointHttpBaseUrl: null,
                  endpointWsBaseUrl: null,
                  endpointProviderKind: null,
                  enrolledAt: null,
                }),
              ),
            deprovision: () =>
              Effect.sync(() => {
                calls.push("tombstone");
                return true;
              }),
          }),
          computeLayer({
            destroy: () =>
              Effect.sync(() => {
                calls.push("destroy-compute");
              }),
          }),
        ),
      ),
    );
  });
});
