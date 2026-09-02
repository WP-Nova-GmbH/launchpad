import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  type RelayConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import {
  EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
  type RelayDiscoveredEnvironment,
  type RelayEnvironmentDiscoveryState,
} from "./discovery.ts";
import {
  reconcileOrganizationMachines,
  syncOrganizationMachines,
  type MachineSyncRegistry,
} from "./machineSync.ts";

function record(
  id: string,
  label: string,
  source: RelayClientEnvironmentRecord["source"],
): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    endpoint: {
      httpBaseUrl: `https://${id}.example.test`,
      wsBaseUrl: `wss://${id}.example.test`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-06-01T00:00:00.000Z",
    source,
  };
}

function listed(
  environments: ReadonlyArray<RelayClientEnvironmentRecord>,
): RelayEnvironmentDiscoveryState {
  return {
    ...EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
    environments: new Map(
      environments.map((environment): [string, RelayDiscoveredEnvironment] => [
        environment.environmentId,
        { environment, availability: "checking", status: Option.none(), error: Option.none() },
      ]),
    ),
    listed: true,
  };
}

function relayEntry(
  id: string,
  label: string,
  source?: "link" | "machine",
): ConnectionCatalogEntry {
  return {
    target: new RelayConnectionTarget({
      environmentId: EnvironmentId.make(id),
      label,
      ...(source === undefined ? {} : { source }),
    }),
    profile: Option.none(),
  };
}

/** Waits for the list behind `ref` to reach `length` entries. */
function awaitLength<A>(ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<A>>, length: number) {
  return Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(ref)),
    SubscriptionRef.changes(ref),
  ).pipe(
    Stream.filter((values) => values.length >= length),
    Stream.runHead,
    Effect.asVoid,
  );
}

const makeRegistry = Effect.fn("MachineSyncTest.makeRegistry")(function* (
  initial: ReadonlyArray<ConnectionCatalogEntry>,
) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(initial.map((entry) => [entry.target.environmentId, entry])),
  );
  const registered = yield* SubscriptionRef.make<ReadonlyArray<RelayConnectionRegistration>>([]);
  const removed = yield* SubscriptionRef.make<ReadonlyArray<EnvironmentId>>([]);
  const registry: MachineSyncRegistry = {
    entries,
    register: (registration) =>
      Effect.gen(function* () {
        if (registration._tag !== "RelayConnectionRegistration") {
          return yield* Effect.die("only relay registrations expected");
        }
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(registration.target.environmentId, {
            target: registration.target,
            profile: Option.none(),
          }),
        );
        yield* SubscriptionRef.update(registered, (current) => [...current, registration]);
      }),
    remove: (environmentId) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* SubscriptionRef.update(removed, (current) => [...current, environmentId]);
      }),
  };
  return { registry, entries, registered, removed };
});

describe("organization machine sync", () => {
  it.effect("saves listed machines and leaves personal links alone", () =>
    Effect.gen(function* () {
      const { registry, registered, removed } = yield* makeRegistry([]);

      yield* reconcileOrganizationMachines(registry, [
        { environmentId: EnvironmentId.make("machine-1"), label: "Executor 1" },
      ]);

      const saved = yield* SubscriptionRef.get(registered);
      expect(saved.map((registration) => registration.target)).toEqual([
        new RelayConnectionTarget({
          environmentId: EnvironmentId.make("machine-1"),
          label: "Executor 1",
          source: "machine",
        }),
      ]);
      expect(yield* SubscriptionRef.get(removed)).toEqual([]);
    }),
  );

  it.effect("drops a saved machine the listing no longer names, and nothing else", () =>
    Effect.gen(function* () {
      const { registry, registered, removed } = yield* makeRegistry([
        relayEntry("machine-gone", "Destroyed executor", "machine"),
        relayEntry("machine-kept", "Executor", "machine"),
        relayEntry("link-1", "My laptop", "link"),
        relayEntry("link-legacy", "Saved before source existed"),
        {
          target: new BearerConnectionTarget({
            environmentId: EnvironmentId.make("bearer-1"),
            label: "LAN box",
            connectionId: "bearer:bearer-1",
          }),
          profile: Option.none(),
        },
      ]);

      yield* reconcileOrganizationMachines(registry, [
        { environmentId: EnvironmentId.make("machine-kept"), label: "Executor" },
      ]);

      expect(yield* SubscriptionRef.get(removed)).toEqual([EnvironmentId.make("machine-gone")]);
      expect(yield* SubscriptionRef.get(registered)).toEqual([]);
    }),
  );

  it.effect("re-tags a machine that was connected by hand before it was tagged", () =>
    Effect.gen(function* () {
      const { registry, registered, entries } = yield* makeRegistry([
        relayEntry("machine-1", "Executor 1"),
      ]);

      yield* reconcileOrganizationMachines(registry, [
        { environmentId: EnvironmentId.make("machine-1"), label: "Executor 1" },
      ]);

      expect((yield* SubscriptionRef.get(registered)).length).toBe(1);
      const entry = (yield* SubscriptionRef.get(entries)).get(EnvironmentId.make("machine-1"));
      expect(entry?.target._tag === "RelayConnectionTarget" ? entry.target.source : null).toBe(
        "machine",
      );
    }),
  );

  it.effect("acts only on complete listings and only when the machine set changes", () =>
    Effect.gen(function* () {
      const { registry, registered, removed } = yield* makeRegistry([
        relayEntry("machine-old", "Old executor", "machine"),
      ]);
      const discovery = yield* SubscriptionRef.make<RelayEnvironmentDiscoveryState>(
        EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
      );
      const fiber = yield* Effect.forkScoped(syncOrganizationMachines(discovery, registry));

      // A refresh in flight, a failed refresh, and a signed-out state all
      // leave an empty map behind. None of them may drop the saved machine.
      yield* SubscriptionRef.set(discovery, {
        ...EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
        refreshing: true,
      });
      yield* SubscriptionRef.set(discovery, EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);

      const machine = record("machine-1", "Executor 1", "machine");
      const link = record("link-1", "My laptop", "link");
      yield* SubscriptionRef.set(discovery, listed([machine, link]));
      yield* awaitLength(registered, 1);
      yield* awaitLength(removed, 1);
      expect(yield* SubscriptionRef.get(removed)).toEqual([EnvironmentId.make("machine-old")]);

      // Status updates change the state without changing the machine set;
      // the admin destroying the machine does. Only the second one acts, so
      // once that removal lands, the registration count proves the first
      // one did nothing.
      yield* SubscriptionRef.update(discovery, (current) => ({ ...current, refreshing: false }));
      yield* SubscriptionRef.set(discovery, listed([link]));
      yield* awaitLength(removed, 2);
      expect(yield* SubscriptionRef.get(removed)).toEqual([
        EnvironmentId.make("machine-old"),
        EnvironmentId.make("machine-1"),
      ]);
      expect((yield* SubscriptionRef.get(registered)).length).toBe(1);

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );
});
