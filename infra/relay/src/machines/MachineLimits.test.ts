import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayOrganizationMachineLimits } from "../persistence/schema.ts";
import * as MachineLimits from "./MachineLimits.ts";
import * as Machines from "./Machines.ts";

const unexpected = () => Effect.die("unexpected machine store call");

function layerWith(input: {
  readonly overrideRows?: Effect.Effect<ReadonlyArray<{ readonly maxMachines: number }>, Error>;
  readonly activeMachines?: number;
}) {
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        expect(table).toBe(relayOrganizationMachineLimits);
        return {
          where: () => ({
            limit: () => input.overrideRows ?? Effect.succeed([]),
          }),
        };
      },
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  return MachineLimits.layer.pipe(
    Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
    Layer.provide(
      Layer.succeed(
        Machines.Machines,
        Machines.Machines.of({
          create: unexpected,
          getById: unexpected,
          listForOrganization: unexpected,
          countActiveForOrganization: () => Effect.succeed(input.activeMachines ?? 0),
          getBySeedHash: unexpected,
          getActiveByEnvironmentId: unexpected,
          recordComputeRef: unexpected,
          claimEnrollment: unexpected,
          deprovision: unexpected,
          remove: unexpected,
        }),
      ),
    ),
  );
}

describe("MachineLimits", () => {
  it.effect("allows provisioning below the default limit", () =>
    Effect.gen(function* () {
      const limits = yield* MachineLimits.MachineLimits;
      yield* limits.ensureCapacity({ organizationId: "organization-1" });
    }).pipe(
      Effect.provide(
        layerWith({ activeMachines: MachineLimits.DEFAULT_ORGANIZATION_MACHINE_LIMIT - 1 }),
      ),
    ),
  );

  it.effect("rejects provisioning at the default limit", () =>
    Effect.gen(function* () {
      const limits = yield* MachineLimits.MachineLimits;
      const error = yield* Effect.flip(limits.ensureCapacity({ organizationId: "organization-1" }));
      expect(error).toMatchObject({
        _tag: "MachineLimitExceeded",
        organizationId: "organization-1",
        maxMachines: MachineLimits.DEFAULT_ORGANIZATION_MACHINE_LIMIT,
        activeMachines: MachineLimits.DEFAULT_ORGANIZATION_MACHINE_LIMIT,
      });
    }).pipe(
      Effect.provide(
        layerWith({ activeMachines: MachineLimits.DEFAULT_ORGANIZATION_MACHINE_LIMIT }),
      ),
    ),
  );

  it.effect("honors a per-organization override in either direction", () =>
    Effect.gen(function* () {
      const limits = yield* MachineLimits.MachineLimits;
      yield* limits.ensureCapacity({ organizationId: "organization-1" });
    }).pipe(
      Effect.provide(
        layerWith({
          overrideRows: Effect.succeed([{ maxMachines: 25 }]),
          activeMachines: 10,
        }),
      ),
    ),
  );

  it.effect("rejects at a lowered per-organization override", () =>
    Effect.gen(function* () {
      const limits = yield* MachineLimits.MachineLimits;
      const error = yield* Effect.flip(limits.ensureCapacity({ organizationId: "organization-1" }));
      expect(error).toMatchObject({
        _tag: "MachineLimitExceeded",
        maxMachines: 1,
        activeMachines: 1,
      });
    }).pipe(
      Effect.provide(
        layerWith({ overrideRows: Effect.succeed([{ maxMachines: 1 }]), activeMachines: 1 }),
      ),
    ),
  );

  it.effect("retains database failures with operation and organization identity", () => {
    const cause = new Error("database unavailable");
    return Effect.gen(function* () {
      const limits = yield* MachineLimits.MachineLimits;
      const error = yield* Effect.flip(limits.ensureCapacity({ organizationId: "organization-1" }));
      expect(error).toMatchObject({
        _tag: "MachineLimitPersistenceError",
        operation: "load-limit",
        organizationId: "organization-1",
      });
      expect(error).toHaveProperty("cause", cause);
    }).pipe(Effect.provide(layerWith({ overrideRows: Effect.fail(cause) })));
  });
});
