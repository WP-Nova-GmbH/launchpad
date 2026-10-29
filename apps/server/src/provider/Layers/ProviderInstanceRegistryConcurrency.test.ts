import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

it.effect(
  "serializes overlapping settings and auth-source rebuilds without duplicate live instances",
  () =>
    Effect.gen(function* () {
      const building = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const driverKind = ProviderDriverKind.make("codex"),
        instanceId = ProviderInstanceId.make("codex");
      let alive = 0,
        maximum = 0;
      const closed: number[] = [],
        created: number[] = [];
      const config = Schema.Struct({ version: Schema.Int });
      const driver: ProviderDriver<typeof config.Type> = {
        driverKind,
        metadata: { displayName: "Test" },
        configSchema: config,
        defaultConfig: () => ({ version: 1 }),
        create: (input) =>
          Effect.gen(function* () {
            alive++;
            maximum = Math.max(maximum, alive);
            created.push(input.config.version);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                alive--;
                closed.push(input.config.version);
              }),
            );
            if (input.config.version === 2) {
              yield* Deferred.succeed(building, undefined);
              yield* Deferred.await(release);
            }
            return {
              instanceId,
              driverKind,
              enabled: true,
              displayName: undefined,
              continuationIdentity: { driverKind, continuationKey: "test" },
              snapshot: {
                getSnapshot: Effect.die("Unused"),
                refresh: Effect.die("Unused"),
                streamChanges: Stream.never,
                applyUsageLimits: () => Effect.void,
                resolveMaintenance: () => Effect.die("Unused"),
              },
              get adapter(): never {
                throw new Error("Unused");
              },
              get textGeneration(): never {
                throw new Error("Unused");
              },
            };
          }),
      };
      const map = (version: number) => ({ codex: { driver: driverKind, config: { version } } });
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: map(1),
      });
      const first = yield* mutator.reconcile(map(2)).pipe(Effect.forkChild);
      yield* Deferred.await(building);
      const second = yield* mutator
        .reconcile(map(3))
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(maximum).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(maximum).toBe(1);
      expect(alive).toBe(1);
      expect(created).toEqual([1, 2, 3]);
      expect(closed).toEqual([1, 2]);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
    }).pipe(Effect.scoped),
);
