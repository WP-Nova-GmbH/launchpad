/**
 * Keeps the organization's machines saved on this device.
 *
 * A machine belongs to the whole organization, so nobody should have to press
 * Connect for it: every complete relay listing registers the machines it
 * names and drops the ones it no longer does (the admin destroyed them).
 * Personal links stay the user's business and are never added or removed
 * here.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { RelayConnectionRegistration } from "../connection/catalog.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { RelayEnvironmentDiscoveryState } from "./discovery.ts";

export type MachineSyncRegistry = Pick<
  EnvironmentRegistry.EnvironmentRegistry["Service"],
  "entries" | "register" | "remove"
>;

interface DiscoveredMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function discoveredMachines(
  state: RelayEnvironmentDiscoveryState,
): ReadonlyArray<DiscoveredMachine> | null {
  if (!state.listed) {
    return null;
  }
  return [...state.environments.values()]
    .filter((entry) => entry.environment.source === "machine")
    .map((entry) => ({
      environmentId: entry.environment.environmentId,
      label: entry.environment.label,
    }));
}

function machinesKey(machines: ReadonlyArray<DiscoveredMachine> | null): string | null {
  return machines === null
    ? null
    : machines.map((machine) => `${machine.environmentId}\t${machine.label}`).join("\n");
}

/** Reconciles the saved catalog against one complete listing. */
export const reconcileOrganizationMachines = Effect.fn("RelayMachineSync.reconcile")(function* (
  registry: MachineSyncRegistry,
  machines: ReadonlyArray<DiscoveredMachine>,
) {
  const entries = yield* SubscriptionRef.get(registry.entries);
  const discovered = new Set(machines.map((machine) => machine.environmentId));

  for (const machine of machines) {
    const existing = entries.get(machine.environmentId)?.target;
    if (
      existing !== undefined &&
      (existing._tag !== "RelayConnectionTarget" || existing.source === "machine")
    ) {
      continue;
    }
    // Absent, or saved by hand before machines were tagged: register it as
    // the organization's so it is kept in sync from here on.
    yield* registry
      .register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: machine.environmentId,
            label: machine.label,
            source: "machine",
          }),
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not save organization machine", {
            environmentId: machine.environmentId,
            error,
          }),
        ),
      );
  }

  for (const [environmentId, entry] of entries) {
    if (
      entry.target._tag !== "RelayConnectionTarget" ||
      entry.target.source !== "machine" ||
      discovered.has(environmentId)
    ) {
      continue;
    }
    yield* registry.remove(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not drop a destroyed organization machine", {
          environmentId,
          error,
        }),
      ),
    );
  }
});

/** Runs for the life of the scope, following every complete listing. */
export function syncOrganizationMachines(
  discovery: SubscriptionRef.SubscriptionRef<RelayEnvironmentDiscoveryState>,
  registry: MachineSyncRegistry,
): Effect.Effect<void> {
  return Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(discovery)),
    SubscriptionRef.changes(discovery),
  ).pipe(
    Stream.map(discoveredMachines),
    Stream.changesWith((left, right) => machinesKey(left) === machinesKey(right)),
    Stream.runForEach((machines) =>
      machines === null ? Effect.void : reconcileOrganizationMachines(registry, machines),
    ),
  );
}
