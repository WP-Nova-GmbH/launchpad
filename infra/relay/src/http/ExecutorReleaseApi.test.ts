import { RelayEnvironmentPrincipal, RelayTenancyNotFoundError } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as RelayConfiguration from "../Config.ts";
import * as Machines from "../machines/Machines.ts";
import { resolveExecutorRelease } from "./ExecutorReleaseApi.ts";

const timestamp = "2026-09-02T00:00:00.000Z";

function settings(
  executorSource: RelayConfiguration.ExecutorSourceRelease | undefined,
): RelayConfiguration.RelayConfiguration["Service"] {
  return {
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
    executorSource,
  };
}

const principal = { environmentId: "environment-1", environmentPublicKey: "public-key-1" };

const unexpected = (name: string) => () => Effect.die(`unexpected ${name}`);

function machine(overrides: Partial<Machines.MachineRecord> = {}): Machines.MachineRecord {
  return {
    machineId: "machine-1",
    organizationId: "organization-1",
    role: "agent_executor",
    label: "Executor 1",
    computeKind: "self_hosted",
    computeRef: null,
    seedExpiresAt: timestamp,
    environmentId: "environment-1",
    environmentPublicKey: "public-key-1",
    endpointHttpBaseUrl: null,
    endpointWsBaseUrl: null,
    endpointProviderKind: null,
    createdByUserId: "user-1",
    enrolledAt: timestamp,
    deprovisionedAt: null,
    createdAt: timestamp,
    ...overrides,
  };
}

function layers(
  found: Machines.MachineRecord | null,
  executorSource: RelayConfiguration.ExecutorSourceRelease | undefined,
) {
  return Layer.mergeAll(
    Layer.succeed(RelayConfiguration.RelayConfiguration, settings(executorSource)),
    Layer.succeed(
      Machines.Machines,
      Machines.Machines.of({
        create: unexpected("create"),
        getById: unexpected("getById"),
        listForOrganization: unexpected("listForOrganization"),
        countActiveForOrganization: unexpected("countActiveForOrganization"),
        getBySeedHash: unexpected("getBySeedHash"),
        getActiveByEnvironmentId: () => Effect.succeed(found),
        recordComputeRef: unexpected("recordComputeRef"),
        claimEnrollment: unexpected("claimEnrollment"),
        deprovision: unexpected("deprovision"),
        remove: unexpected("remove"),
      }),
    ),
  );
}

const source = { gitUrl: "https://github.com/acme/launchpad.git", ref: "main" };

describe("resolveExecutorRelease", () => {
  it.effect("names the configured source for an enrolled executor", () =>
    Effect.gen(function* () {
      const result = yield* resolveExecutorRelease({ environmentId: "environment-1" });
      expect(result.release).toEqual(source);
      expect(result.machine.machineId).toBe("machine-1");
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provide(layers(machine(), source)),
    ),
  );

  it.effect("tells an executor when this relay does not track a source", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveExecutorRelease({ environmentId: "environment-1" }));
      expect(error).toBeInstanceOf(RelayTenancyNotFoundError);
      expect((error as RelayTenancyNotFoundError).reason).toBe("executor_source_not_configured");
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provide(layers(machine(), undefined)),
    ),
  );

  it.effect("refuses a review host", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveExecutorRelease({ environmentId: "environment-1" }));
      expect(error).toBeInstanceOf(HttpApiError.Unauthorized);
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provide(layers(machine({ role: "review_host" }), source)),
    ),
  );
});
