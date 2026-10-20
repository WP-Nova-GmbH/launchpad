import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";
import { type ConnectionCatalogEntry, type ConnectionRegistration } from "../connection/catalog.ts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { openPortableThreadChat, portableThreadClientRouteAtom } from "./portableThreadLibrary.ts";

const threadId = ThreadId.make("thread"),
  environmentId = EnvironmentId.make("current-vm");
const placement = {
  threadId,
  organizationId: "org",
  repositoryId: "repo",
  ownerUserId: "owner",
  environmentId,
  projectId: "project",
  generation: 2,
  operationId: null,
};
const ready = {
  threadId,
  generation: 2,
  allocation: { allocationId: "vm", ownerUserId: "owner", state: "running" },
  setupPhase: "ready",
  capacityState: "started",
  activity: "idle",
  pausePhase: null,
  resumePhase: null,
  backupPhase: null,
  lastVerifiedBackupAt: null,
};
const harness = Effect.fnUntraced(function* (
  fetchFn: typeof fetch,
  initial: ReadonlyArray<ConnectionCatalogEntry> = [],
  expectedPlacement?: { environmentId: EnvironmentId; generation: number },
) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(managedRelaySessionAtom, {
    accountId: "owner",
    readClerkToken: () => Effect.succeed("owner-token"),
  });
  const registered: ConnectionRegistration[] = [],
    enabled: EnvironmentId[] = [];
  const connections = {
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(initial.map((entry) => [entry.target.environmentId, entry])),
    ),
    register: (input: ConnectionRegistration) =>
      Effect.sync(() => {
        registered.push(input);
      }),
    setEnabled: (id: EnvironmentId, value: boolean) =>
      Effect.sync(() => {
        expect(value).toBe(true);
        enabled.push(id);
      }),
  };
  const open = openPortableThreadChat(
    { threadId, title: "Private work", ...(expectedPlacement ? { expectedPlacement } : {}) },
    registry,
    connections,
  ).pipe(
    Effect.provide(
      tenancyLayer({ relayUrl: "https://relay.test" }).pipe(
        Layer.provide(remoteHttpClientLayer(fetchFn)),
      ),
    ),
  );
  return { registry, connections, registered, enabled, open };
});
const respond: typeof fetch = async (url, init) => {
  const request = new Request(url, init);
  expect(request.headers.get("authorization")).toBe("Bearer owner-token");
  expect(request.method).toBe("GET");
  return Response.json(request.url.endsWith("vm-status") ? ready : placement);
};

describe("explicit saved-thread chat connection", () => {
  it.effect("does not follow a cutover notice after ownership advances to another generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(
          async (url, init) => {
            calls.push(String(url));
            return respond(url, init);
          },
          [],
          { environmentId, generation: 1 },
        );
        expect((yield* Effect.result(h.open))._tag).toBe("Failure");
        expect(h.registry.get(portableThreadClientRouteAtom(environmentId, threadId))).toBeNull();
        expect(h.registered).toEqual([]);
        expect(h.enabled).toEqual([]);
        expect(calls).toEqual(["https://relay.test/v1/threads/thread/placement"]);
      }),
    ),
  );
  it.effect(
    "resolves the current placement and registers its private relay target without waking it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            calls.push(String(url));
            return respond(url, init);
          });
          expect(yield* h.open).toEqual({ environmentId, threadId });
          expect(h.registry.get(portableThreadClientRouteAtom(environmentId, threadId))).toEqual({
            relayUrl: "https://relay.test",
            generation: 2,
            phase: "retired",
          });
          expect(
            h.registry.get(portableThreadClientRouteAtom(EnvironmentId.make("other"), threadId)),
          ).toBeNull();
          expect(
            h.registry.get(portableThreadClientRouteAtom(environmentId, ThreadId.make("other"))),
          ).toBeNull();
          expect(h.registered).toHaveLength(1);
          expect(h.registered[0]).toMatchObject({
            _tag: "RelayConnectionRegistration",
            target: { environmentId, label: "Private work" },
          });
          expect(calls.map((url) => new URL(url).pathname)).toEqual([
            "/v1/threads/thread/placement",
            "/v1/threads/thread/vm-status",
            "/v1/threads/thread/placement",
          ]);
        }),
      ),
  );
  it.effect(
    "preserves a known local transport and enables it only after the explicit open action",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = new PrimaryConnectionTarget({
            environmentId,
            label: "Local",
            httpBaseUrl: "http://localhost",
            wsBaseUrl: "ws://localhost",
          });
          const h = yield* harness(
            async (url, init) => {
              const request = new Request(url, init);
              return request.url.endsWith("vm-status")
                ? Response.json({ ...ready, allocation: null, setupPhase: null })
                : respond(url, init);
            },
            [{ target, enabled: false, profile: Option.none() }],
          );
          expect(yield* h.open).toEqual({ environmentId, threadId });
          expect(h.registered).toEqual([]);
          expect(h.enabled).toEqual([environmentId]);
          expect(
            (yield* SubscriptionRef.get(h.connections.entries)).get(environmentId)?.target,
          ).toBe(target);
        }),
      ),
  );
  it.effect("blocks paused, saved-only and incomplete VMs without any connection or resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const status of [
          { ...ready, allocation: { ...ready.allocation, state: "paused" } },
          { ...ready, setupPhase: "running" },
          {
            ...ready,
            allocation: null,
            setupPhase: null,
            savedDisk: {
              operationId: "saved",
              phase: "available",
              savedAt: "2026-10-07T00:00:00Z",
              expiresAt: "2026-11-07T00:00:00Z",
            },
          },
        ]) {
          const h = yield* harness(async (url) =>
            Response.json(String(url).endsWith("vm-status") ? status : placement),
          );
          expect((yield* Effect.result(h.open))._tag).toBe("Failure");
          expect(h.registered).toEqual([]);
          expect(h.enabled).toEqual([]);
        }
      }),
    ),
  );
  it.effect("does not trust a changed location or another thread on the final placement read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const latest of [
          { ...placement, environmentId: "new-owner", generation: 3 },
          { ...placement, threadId: "another-thread" },
        ]) {
          let reads = 0;
          const h = yield* harness(async (url) =>
            Response.json(
              String(url).endsWith("vm-status") ? ready : ++reads === 1 ? placement : latest,
            ),
          );
          expect((yield* Effect.result(h.open))._tag).toBe("Failure");
          expect(h.registered).toEqual([]);
          expect(h.registry.get(portableThreadClientRouteAtom(environmentId, threadId))).toBeNull();
        }
      }),
    ),
  );
  it.effect("discards a delayed placement after switching accounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const h = yield* harness(async () => {
          requested.resolve();
          await release.promise;
          return Response.json(placement);
        });
        const pending = yield* h.open.pipe(Effect.result, Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, null);
        release.resolve();
        expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        expect(h.registered).toEqual([]);
      }),
    ),
  );
});
