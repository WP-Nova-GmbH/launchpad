import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as Machines from "../machines/Machines.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";

const timestamp = "2026-08-19T00:00:00.000Z";

const principal = { environmentId: "environment-1", environmentPublicKey: "public-key-1" };

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

const unexpected = (name: string) => () => Effect.die(`unexpected ${name}`);

const check = (found: Machines.MachineRecord | null, environmentId = "environment-1") =>
  requireEnrolledExecutor({ environmentId }).pipe(
    Effect.provideService(RelayEnvironmentPrincipal, principal),
    Effect.provideService(
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

const expectUnauthorized = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => expect(error).toBeInstanceOf(HttpApiError.Unauthorized)),
  );

describe("requireEnrolledExecutor", () => {
  it.effect("returns the machine behind a matching enrolled agent executor", () =>
    Effect.map(check(machine()), (found) => {
      expect(found.machineId).toBe("machine-1");
      expect(found.organizationId).toBe("organization-1");
    }),
  );

  it.effect("refuses a request for another environment's id", () =>
    expectUnauthorized(check(machine(), "environment-2")),
  );

  it.effect("refuses an environment that is not a machine", () => expectUnauthorized(check(null)));

  it.effect("refuses a review host", () =>
    expectUnauthorized(check(machine({ role: "review_host" }))),
  );

  it.effect("refuses a machine whose key is not the credential's", () =>
    expectUnauthorized(check(machine({ environmentPublicKey: "public-key-2" }))),
  );
});
