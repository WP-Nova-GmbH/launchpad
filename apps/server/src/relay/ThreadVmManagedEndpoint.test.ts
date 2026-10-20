import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import {
  runThreadVmManagedEndpointWith,
  ThreadVmManagedEndpointError,
} from "./ThreadVmManagedEndpoint.ts";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";

const config = {
  providerKind: "cloudflare_tunnel" as const,
  tunnelId: "tunnel-1",
  connectorToken: "private-token",
};
const endpoint = {
  providerKind: "cloudflare_tunnel" as const,
  httpBaseUrl: "https://vm.test/",
  wsBaseUrl: "wss://vm.test/ws",
};
const fixture = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
  const applied = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig | null>();
  const released: string[] = [];
  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig: (value) =>
      Queue.offer(applied, value).pipe(
        Effect.as(
          value
            ? {
                status: "running" as const,
                providerKind: "cloudflare_tunnel" as const,
                pid: 1,
                ...(value.tunnelId ? { tunnelId: value.tunnelId } : {}),
              }
            : { status: "disabled" as const },
        ),
      ),
    recoveryRequests: Stream.fromQueue(requests),
    requestRecovery: (value) => Queue.offer(requests, value).pipe(Effect.asVoid),
    withLinkStateLock: (effect) => effect,
  });
  return {
    runtime,
    requests,
    applied,
    released,
    release: (id: string) =>
      Effect.sync(() => {
        released.push(id);
      }),
  };
});

describe("private VM managed tunnel lifetime", () => {
  it.effect("does not recover a VM endpoint when managed tunnels are disabled", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* runThreadVmManagedEndpointWith({
        recover: Effect.die("disabled VM endpoint recovered"),
        release: f.release,
      }).pipe(Effect.provideService(CloudManagedEndpointRuntime, f.runtime), Effect.scoped);
      expect(f.released).toEqual([]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_DISABLE_MANAGED_TUNNELS: "1" } }),
        ),
      ),
    ),
  );

  it.effect(
    "reconnects with the recovered token and releases only its last tunnel on shutdown",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let count = 0;
        const worker = yield* runThreadVmManagedEndpointWith({
          recover: Effect.sync(() => ({
            endpoint,
            runtime: { ...config, tunnelId: `tunnel-${++count}` },
          })),
          release: f.release,
        }).pipe(
          Effect.provideService(CloudManagedEndpointRuntime, f.runtime),
          Effect.scoped,
          Effect.forkChild,
        );
        expect((yield* Queue.take(f.applied))?.tunnelId).toBe("tunnel-1");
        yield* Queue.offer(f.requests, config);
        expect((yield* Queue.take(f.applied))?.tunnelId).toBe("tunnel-2");
        yield* Fiber.interrupt(worker);
        expect(yield* Queue.take(f.applied)).toBeNull();
        expect(f.released).toEqual(["tunnel-2"]);
      }),
  );
  it.effect("stops the connector after a denied recovery, then waits before retrying", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let attempts = 0;
      const failed = yield* Deferred.make<void>();
      const worker = yield* runThreadVmManagedEndpointWith({
        recover: Effect.gen(function* () {
          attempts++;
          if (attempts === 2) {
            yield* Deferred.succeed(failed, undefined);
            return yield* new ThreadVmManagedEndpointError();
          }
          return { endpoint, runtime: config };
        }),
        release: f.release,
      }).pipe(
        Effect.provideService(CloudManagedEndpointRuntime, f.runtime),
        Effect.scoped,
        Effect.forkChild,
      );
      yield* Queue.take(f.applied);
      yield* Queue.offer(f.requests, config);
      yield* Deferred.await(failed);
      expect(yield* Queue.take(f.applied)).toBeNull();
      expect(attempts).toBe(2);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(f.applied)).toEqual(config);
      expect(attempts).toBe(3);
      yield* Fiber.interrupt(worker);
    }),
  );
  it.effect("never starts a non-managed endpoint received from the relay", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const worker = yield* runThreadVmManagedEndpointWith({
        recover: Effect.succeed({
          endpoint: { ...endpoint, providerKind: "manual" as const },
          runtime: config,
        }),
        release: f.release,
      }).pipe(
        Effect.provideService(CloudManagedEndpointRuntime, f.runtime),
        Effect.scoped,
        Effect.forkChild,
      );
      expect(yield* Queue.take(f.applied)).toBeNull();
      yield* Fiber.interrupt(worker);
      expect(f.released).toEqual([]);
    }),
  );
});
