import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import {
  runThreadVmManagedEndpoint,
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
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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

const ownershipFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const f = yield* fixture;
  const environmentId = EnvironmentId.make("guest");
  const owner = {
    threadId: "thread",
    generation: 2,
    operationId: "initial-move",
    projectId: "project",
    environmentId,
    relayUrl: "https://relay.test",
  };
  const vm = new TextEncoder().encode(
    yield* encode({
      operationId: owner.operationId,
      scope: {
        threadId: owner.threadId,
        generation: owner.generation,
        allocationId: "allocation",
        repositoryId: "repository",
      },
      environmentId,
      relayUrl: owner.relayUrl,
      relayIssuer: owner.relayUrl,
      environmentCredential: "guest-credential",
      cloudMintPublicKey: "public-key",
    }),
  );
  let recoveries = 0;
  const worker = runThreadVmManagedEndpoint.pipe(
    Effect.provideService(CloudManagedEndpointRuntime, f.runtime),
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Effect.provideService(ServerSecretStore, {
      get: (name) =>
        Effect.succeed(name === THREAD_VM_IDENTITY_SECRET ? Option.some(vm) : Option.none()),
      set: () => Effect.die("unexpected secret write"),
      create: () => Effect.die("unexpected secret write"),
      getOrCreateRandom: () => Effect.die("unexpected secret write"),
      remove: () => Effect.die("unexpected secret write"),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/endpoint/release"))
            return HttpClientResponse.fromWeb(request, Response.json({ released: true }));
          expect(request.url).toBe(
            `${owner.relayUrl}/v1/environments/guest/threads/thread/endpoint/recover`,
          );
          recoveries++;
          return HttpClientResponse.fromWeb(request, Response.json({ endpoint, runtime: config }));
        }),
      ),
    ),
    Effect.scoped,
  );
  return {
    sql,
    owner,
    worker,
    fence: makeThreadExecutionFence(sql),
    applied: f.applied,
    recoveries: () => recoveries,
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
    "waits for activation and any pending source reopen before recovering the endpoint",
    () =>
      Effect.gen(function* () {
        const f = yield* ownershipFixture;
        const worker = yield* Effect.forkChild(f.worker);
        yield* TestClock.adjust("500 millis");
        expect(f.recoveries()).toBe(0);

        yield* f.fence.prepare(f.owner);
        yield* TestClock.adjust("500 millis");
        expect(f.recoveries()).toBe(0);

        yield* f.sql.withTransaction(
          Effect.gen(function* () {
            yield* f.fence.activate(f.owner);
            yield* f.sql`INSERT INTO thread_move_source_reopens
            (operation_id,thread_id,relay_url,environment_id,generation,message_id)
            VALUES (${f.owner.operationId},${f.owner.threadId},${f.owner.relayUrl},
              ${f.owner.environmentId},${f.owner.generation},'move-message')`;
          }),
        );
        yield* TestClock.adjust("500 millis");
        expect(f.recoveries()).toBe(0);

        yield* f.sql`DELETE FROM thread_move_source_reopens WHERE operation_id=${f.owner.operationId}`;
        yield* TestClock.adjust("500 millis");
        expect(yield* Queue.take(f.applied)).toEqual(config);
        expect(f.recoveries()).toBe(1);
        yield* Fiber.interrupt(worker);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("recovers immediately when an already active guest restarts after cancellation", () =>
    Effect.gen(function* () {
      const f = yield* ownershipFixture;
      const owner = { ...f.owner, relayUrl: `${f.owner.relayUrl}/`, operationId: "cancelled-move" };
      yield* f.fence.prepare(owner);
      yield* f.fence.activate(owner);
      const worker = yield* Effect.forkChild(f.worker);
      expect(yield* Queue.take(f.applied)).toEqual(config);
      expect(f.recoveries()).toBe(1);
      yield* Fiber.interrupt(worker);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
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
