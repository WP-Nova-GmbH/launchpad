import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayOrganizationMachineLimits } from "../persistence/schema.ts";
import * as Machines from "./Machines.ts";

/**
 * Machines an organization may hold at once — one shared quota across agent
 * executors and review hosts — unless a row in
 * `relay_organization_machine_limits` overrides it. This is the billing lever
 * for "buy managed machines".
 */
export const DEFAULT_ORGANIZATION_MACHINE_LIMIT = 5;

export class MachineLimitPersistenceError extends Schema.TaggedErrorClass<MachineLimitPersistenceError>()(
  "MachineLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-machines"]),
    organizationId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Machine limit '${this.operation}' failed for organization '${this.organizationId}'`;
  }
}

export class MachineLimitExceeded extends Schema.TaggedErrorClass<MachineLimitExceeded>()(
  "MachineLimitExceeded",
  {
    organizationId: Schema.String,
    maxMachines: Schema.Number,
    activeMachines: Schema.Number,
  },
) {
  override get message(): string {
    return `Machine limit reached for organization '${this.organizationId}': ${this.activeMachines} of ${this.maxMachines} machines in use`;
  }
}

export class MachineLimits extends Context.Service<
  MachineLimits,
  {
    readonly ensureCapacity: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<
      void,
      MachineLimitExceeded | MachineLimitPersistenceError | Machines.MachinePersistenceError
    >;
  }
>()("t3code-relay/machines/MachineLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const machines = yield* Machines.Machines;

  return MachineLimits.of({
    ensureCapacity: Effect.fn("relay.machine_limits.ensure_capacity")(function* (input) {
      const overrides = yield* db
        .select({ maxMachines: relayOrganizationMachineLimits.maxMachines })
        .from(relayOrganizationMachineLimits)
        .where(eq(relayOrganizationMachineLimits.organizationId, input.organizationId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachineLimitPersistenceError({
                operation: "load-limit",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      const maxMachines = overrides[0]?.maxMachines ?? DEFAULT_ORGANIZATION_MACHINE_LIMIT;
      const activeMachines = yield* machines.countActiveForOrganization({
        organizationId: input.organizationId,
      });
      if (activeMachines >= maxMachines) {
        return yield* new MachineLimitExceeded({
          organizationId: input.organizationId,
          maxMachines,
          activeMachines,
        });
      }
    }),
  });
});

export const layer = Layer.effect(MachineLimits, make);
