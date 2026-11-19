import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
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
  computeKind: "self_hosted",
  computeRef: null,
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

function endpointLayer(
  overrides?: Partial<ManagedEndpointProvider.ManagedEndpointProvider["Service"]>,
) {
  return Layer.succeed(
    ManagedEndpointProvider.ManagedEndpointProvider,
    ManagedEndpointProvider.ManagedEndpointProvider.of({
      prepareDeprovision: () => Effect.succeed(null),
      deprovision: () => Effect.succeed(true),
      release: () => Effect.succeed(true),
      provision: unexpected("endpoint provision"),
      reconcileOrigin: unexpected("endpoint reconcile"),
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
  for (const role of ["agent_executor", "review_host"] as const) {
    it.effect(`refuses retired ${role} provisioning before creating any machine state`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          provisionMachineRecord({
            organizationId: "organization-1",
            createdByUserId: "user_admin",
            label: "Old managed machine",
            role,
          }),
        );
        expect(error).toMatchObject({
          _tag: "RelayMachineComputeUnavailableError",
          reason: "retired",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayer,
            machinesLayer({}),
            limitsLayer({
              ensureCapacity: unexpected("quota reservation"),
            }),
          ),
        ),
      ),
    );
  }
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
        ),
      ),
    ),
  );

  for (const computeKind of ["docker", "hetzner"] as const) {
    it.effect(`refuses ${computeKind} cleanup before changing its live identity`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          deprovisionMachineRecord({
            organizationId: "organization-1",
            machineId: "machine-1",
          }),
        );
        expect(error).toMatchObject({
          _tag: "RelayMachineComputeUnavailableError",
          reason: "retired",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayer,
            machinesLayer({
              getById: () =>
                Effect.succeed(enrolledMachine({ computeKind, computeRef: "legacy-ref" })),
            }),
            credentialsLayer(),
            endpointLayer({ prepareDeprovision: unexpected("endpoint teardown") }),
          ),
        ),
      ),
    );
  }

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
                return true;
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
      expect(calls).toEqual(["tombstone"]);
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
        ),
      ),
    );
  });
});
