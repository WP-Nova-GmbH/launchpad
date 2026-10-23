import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { layer as wakeupsLayer, type ConnectionWakeup } from "../connection/wakeups.ts";
import { layer as connectivityLayer } from "../connection/connectivity.ts";
import * as Option from "effect/Option";
import { RelayConnectionTarget, type SupervisorConnectionState } from "../connection/model.ts";
import type { NetworkStatus } from "../connection/model.ts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  createPortableThreadLibraryAtoms,
  portableThreadOverviewLabel,
  portableThreadOverviewAction,
} from "./portableThreadLibrary.ts";
import {
  applyPortableThreadHistoryPage,
  emptyPortableThreadHistory,
} from "./portableThreadHistory.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import {
  createPortableThreadNavigationRefreshAtom,
  createPortableThreadPresentationAtom,
  portableThreadPlacementsAtom,
  rememberPortableThreadPlacement,
} from "./portableThreadPresentation.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";

const threadId = ThreadId.make("saved-thread"),
  at = "2026-10-07T12:00:00.000Z";
const summary = {
  title: "Saved conversation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  createdAt: at,
  updatedAt: at,
  placement: {
    threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "owner",
    environmentId: "offline",
    projectId: "project",
    generation: 1,
    operationId: null,
  },
};
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
const event = (type: string, payload: unknown, sequence: number) =>
  decode({
    type,
    payload,
    sequence,
    eventId: `event-${sequence}-${type}`,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  });
const created = event(
  "thread.created",
  {
    threadId,
    projectId: "project",
    title: summary.title,
    modelSelection: summary.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdAt: at,
    updatedAt: at,
  },
  99,
);
const message = event(
  "thread.message-sent",
  {
    threadId,
    messageId: "message",
    role: "user",
    text: "Remember my test fact",
    streaming: false,
    turnId: null,
    author: { userId: "owner", displayName: "Stefan", imageUrl: null },
    attachments: [
      { id: "note", name: "notes.txt", type: "file", mimeType: "text/plain", sizeBytes: 5 },
    ],
    createdAt: at,
    updatedAt: at,
  },
  100,
);
const imported = event(
  "thread.placement-imported",
  {
    threadId,
    projectId: "destination",
    branch: "moved",
    worktreePath: "/linux/repo",
    updatedAt: at,
  },
  1,
);
const entries = [
  { cursor: 1, environmentId: "mac", event: created },
  { cursor: 2, environmentId: "mac", event: message },
  { cursor: 3, environmentId: "linux", event: imported },
];
const harness = Effect.fnUntraced(function* (
  fetchFn: typeof fetch,
  relayUrl = "https://relay.example.test",
) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const session = { accountId: "owner", readClerkToken: () => Effect.succeed("test-token") };
  registry.set(managedRelaySessionAtom, session);
  const wakeups = yield* Queue.unbounded<ConnectionWakeup>();
  const network = yield* Queue.unbounded<NetworkStatus>();
  const runtime = Atom.runtime(
    Layer.mergeAll(
      tenancyLayer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn))),
      wakeupsLayer({ changes: Stream.fromQueue(wakeups) }),
      connectivityLayer({ status: Effect.succeed("online"), changes: Stream.fromQueue(network) }),
    ),
  );
  const library = createPortableThreadLibraryAtoms(runtime);
  return { registry, session, library, runtime, wakeups, network };
});

describe("retained conversation view", () => {
  it("uses effective capabilities for overview recovery actions", () => {
    const vm = {
      state: "saved" as const,
      projectName: null,
      activity: "unknown" as const,
      observedAt: null,
      lastWorkAt: null,
      lastVerifiedBackupAt: null,
      savedDiskExpiresAt: null,
      savedDiskOperationId: "saved",
    };
    const capabilities = {
      configured: true,
      autoPause: false,
      autoBackup: false,
      autoDelete: false,
      replacement: false,
      restore: false,
      reset: false,
      permanentDelete: false,
      privatePreview: false,
    };
    expect(portableThreadOverviewAction({ ...summary, vm }, null)).toBe("Manage VM");
    expect(portableThreadOverviewAction({ ...summary, vm }, capabilities)).toBe("Manage VM");
    expect(
      portableThreadOverviewAction({ ...summary, vm }, { ...capabilities, restore: true }),
    ).toBe("Restore VM");
    expect(
      portableThreadOverviewAction({ ...summary, vm: { ...vm, state: "paused" } }, capabilities),
    ).toBe("Resume VM");
    expect(
      portableThreadOverviewAction(
        { ...summary, placement: { ...summary.placement, operationId: "move" }, vm },
        { ...capabilities, restore: true },
      ),
    ).toBe("Manage VM");
  });

  it("does not invent a running VM when overview state is missing or returned to a machine", () => {
    expect(portableThreadOverviewLabel(summary)).toBe("Status unavailable");
    expect(
      portableThreadOverviewLabel({
        ...summary,
        vm: {
          state: "on_machine",
          projectName: null,
          activity: "unknown",
          observedAt: null,
          lastWorkAt: null,
          lastVerifiedBackupAt: null,
          savedDiskExpiresAt: null,
        },
      }),
    ).toBe("On machine");
  });
  it.effect("reads current queue without downloading or completing conversation history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const queue = {
          enabled: false,
          revision: 7,
          pauseReason: null,
          entries: [],
          handoff: null,
          awaitingTurnId: null,
          admissions: [],
          finalizedTurnId: null,
        };
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          calls.push(new URL(request.url).pathname);
          return Response.json({
            threadId,
            generation: 3,
            cursor: 25001,
            appliedCommandId: null,
            queue,
          });
        });
        expect(
          (yield* Effect.promise(() => h.library.loadQueue.run(h.registry, { threadId })))._tag,
        ).toBe("Success");
        expect(h.registry.get(h.library.queueAtom(threadId))).toMatchObject({
          cursor: 25001,
          queue: { revision: 7, enabled: false },
        });
        expect(h.registry.get(h.library.detailAtom(threadId))).toBeNull();
        expect(calls).toEqual(["/v1/threads/saved-thread/queue"]);
        h.registry.set(managedRelaySessionAtom, null);
        expect(h.registry.get(h.library.queueAtom(threadId))).toBeNull();
      }),
    ),
  );

  it("keeps messages, authors and attachments across a placement boundary with lower source numbers", () => {
    const history = applyPortableThreadHistoryPage(emptyPortableThreadHistory(), threadId, {
      entries,
    });
    expect(history.cursor).toBe(3);
    expect(history.thread).toMatchObject({
      projectId: "destination",
      branch: "moved",
      worktreePath: "/linux/repo",
      messages: [
        {
          text: "Remember my test fact",
          author: { displayName: "Stefan" },
          attachments: [{ name: "notes.txt" }],
        },
      ],
    });
    expect(applyPortableThreadHistoryPage(history, threadId, { entries })).toEqual(history);
    const repeated = applyPortableThreadHistoryPage(history, threadId, {
      entries: [{ ...entries[1]!, cursor: 4 }],
    });
    expect(repeated.thread?.messages).toHaveLength(1);
    expect(repeated.cursor).toBe(4);
  });
  it("rejects foreign history, missing initial state, unordered pages and another creation", () => {
    expect(() =>
      applyPortableThreadHistoryPage(emptyPortableThreadHistory(), ThreadId.make("other"), {
        entries,
      }),
    ).toThrow("another thread");
    expect(() =>
      applyPortableThreadHistoryPage(emptyPortableThreadHistory(), threadId, {
        entries: [entries[1]!],
      }),
    ).toThrow("initial thread");
    expect(() =>
      applyPortableThreadHistoryPage(emptyPortableThreadHistory(), threadId, {
        entries: [entries[0]!, entries[2]!, entries[1]!],
      }),
    ).toThrow("cursor order");
    const history = applyPortableThreadHistoryPage(emptyPortableThreadHistory(), threadId, {
      entries,
    });
    expect(() =>
      applyPortableThreadHistoryPage(history, threadId, {
        entries: [{ cursor: 4, environmentId: "fresh", event: created }],
      }),
    ).toThrow("another thread creation");
  });
  it.effect(
    "reads saved threads and conversation solely from the relay without connecting or waking an environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(request.method + " " + new URL(request.url).pathname);
            expect(request.headers.get("authorization")).toBe("Bearer test-token");
            return Response.json(
              request.url.includes("/history") ? { entries } : { entries: [summary], next: null },
            );
          });
          expect((yield* Effect.promise(() => h.library.loadIndex.run(h.registry, {})))._tag).toBe(
            "Success",
          );
          expect(
            (yield* Effect.promise(() => h.library.loadHistory.run(h.registry, { threadId })))._tag,
          ).toBe("Success");
          expect(
            h.registry.get(h.library.detailAtom(threadId))?.history.thread?.messages[0]?.author
              ?.displayName,
          ).toBe("Stefan");
          expect(calls).toEqual([
            "GET /v1/threads/portable",
            "GET /v1/threads/saved-thread/history",
          ]);
          h.registry.set(managedRelaySessionAtom, null);
          expect(h.registry.get(h.library.indexAtom)).toBeNull();
          expect(h.registry.get(h.library.detailAtom(threadId))).toBeNull();
        }),
      ),
  );
  it.effect("refreshes only new relay events and preserves earlier authors and attachments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let historyReads = 0;
        const changed = event(
          "thread.prompt-queue-changed",
          {
            threadId,
            control: {
              enabled: false,
              revision: 3,
              pauseReason: { code: "stopped", detail: "Reset queue is paused" },
            },
            updatedAt: at,
          },
          2,
        );
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (!request.url.includes("/history"))
            return Response.json({ entries: [summary], next: null });
          historyReads++;
          expect(new URL(request.url).searchParams.get("after")).toBe(
            historyReads === 1 ? "0" : "3",
          );
          return Response.json({
            entries:
              historyReads === 1
                ? entries
                : [{ cursor: 4, environmentId: "linux", event: changed }],
          });
        });
        yield* Effect.promise(() => h.library.loadIndex.run(h.registry, {}));
        yield* Effect.promise(() => h.library.loadHistory.run(h.registry, { threadId }));
        const result = yield* Effect.promise(() =>
          h.library.loadHistory.run(h.registry, { threadId, refresh: true }),
        );
        expect(result._tag).toBe("Success");
        expect(h.registry.get(h.library.detailAtom(threadId))?.history.thread).toMatchObject({
          messages: [{ author: { displayName: "Stefan" }, attachments: [{ name: "notes.txt" }] }],
          promptQueue: { enabled: false, revision: 3 },
        });
      }),
    ),
  );
  it.effect("does not expose a delayed list after switching accounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const h = yield* harness(async () => {
          requested.resolve();
          await release.promise;
          return Response.json({ entries: [summary], next: null });
        });
        const pending = yield* Effect.forkChild(
          Effect.promise(() => h.library.loadIndex.run(h.registry, {})),
        );
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, {
          accountId: "other",
          readClerkToken: () => Effect.succeed("other-token"),
        });
        release.resolve();
        yield* Fiber.join(pending);
        expect(h.registry.get(h.library.indexAtom)).toBeNull();
      }),
    ),
  );
  it.effect(
    "resumes a saved queue explicitly through the relay and retains the caller's command ID",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(request.method + " " + new URL(request.url).pathname);
            expect(await request.json()).toEqual({
              command: {
                type: "thread.queue.resume",
                threadId,
                commandId: "resume-original",
                createdAt: at,
                expectedRevision: 3,
              },
            });
            return Response.json({ commandId: "resume-original", position: 5, receipt: null });
          });
          const result = yield* Effect.promise(() =>
            h.library.queueControl.run(h.registry, {
              accountId: "owner",
              command: {
                type: "thread.queue.resume",
                threadId,
                commandId: CommandId.make("resume-original"),
                createdAt: at,
                expectedRevision: 3,
              },
            }),
          );
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.value).toEqual({
              commandId: "resume-original",
              position: 5,
              receipt: null,
            });
          expect(calls).toEqual(["POST /v1/threads/saved-thread/commands"]);
        }),
      ),
  );
  it.effect("checks relay configuration before token acquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const h = yield* harness(async () => {
          throw new Error("No request allowed");
        }, "http://untrusted.invalid");
        h.registry.set(managedRelaySessionAtom, {
          accountId: "owner",
          readClerkToken: () => {
            reads++;
            return Effect.succeed("private-token");
          },
        });
        expect((yield* Effect.promise(() => h.library.loadIndex.run(h.registry, {})))._tag).toBe(
          "Failure",
        );
        expect(reads).toBe(0);
      }),
    ),
  );
});

const navigationShell = (environment: string, generation = 1): EnvironmentThreadShell => ({
  id: threadId,
  environmentId: EnvironmentId.make(environment),
  projectId: ProjectId.make("project"),
  title: "Saved conversation",
  modelSelection: summary.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  relayRouting: { relayUrl: "https://relay.example.test", generation, phase: "active" },
});

describe("portable location freshness", () => {
  it.effect("coalesces a complete paginated scan and one trailing refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const arrived = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const calls: Array<string | null> = [];
        const second = { ...summary, placement: { ...summary.placement, threadId: "other" } };
        const h = yield* harness(async (url, init) => {
          const after = new URL(new Request(url, init).url).searchParams.get("after");
          calls.push(after);
          if (calls.length === 2) {
            arrived.resolve();
            await release.promise;
          }
          return Response.json({
            entries: [after ? second : summary],
            next: after ? null : "next-page",
          });
        });
        const first = h.library.refreshIndex.run(h.registry, undefined);
        yield* Effect.promise(() => arrived.promise);
        expect(h.registry.get(h.library.indexAtom)).toBeNull();
        const again = h.library.refreshIndex.run(h.registry, undefined);
        expect(h.library.refreshIndex.run(h.registry, undefined)).toBe(again);
        release.resolve();
        expect((yield* Effect.promise(() => first))._tag).toBe("Success");
        expect(calls).toEqual([null, "next-page", null, "next-page"]);
        expect(h.registry.get(h.library.indexAtom)?.entries).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "retains the last authenticated list after a failed refresh and retries explicitly",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let fail = false;
          const h = yield* harness(async () =>
            fail
              ? new Response("offline", { status: 503 })
              : Response.json({ entries: [summary], next: null }),
          );
          yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
          const previous = h.registry.get(h.library.indexAtom);
          fail = true;
          expect(
            (yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined)))._tag,
          ).toBe("Failure");
          expect(h.registry.get(h.library.indexAtom)).toBe(previous);
          expect(h.registry.get(portableThreadPlacementsAtom)?.placements.get(threadId)).toEqual(
            summary.placement,
          );
          fail = false;
          expect(
            (yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined)))._tag,
          ).toBe("Success");
        }),
      ),
  );

  it.effect(
    "rejects a late index move state after a newer direct read at the same generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const arrived = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const moving = { ...summary, placement: { ...summary.placement, operationId: "moving" } };
          const h = yield* harness(async (url, init) => {
            if (new Request(url, init).url.includes("/portable")) {
              arrived.resolve();
              await release.promise;
              return Response.json({ entries: [moving], next: null });
            }
            return Response.json(summary.placement);
          });
          const index = h.library.loadIndex.run(h.registry, {});
          yield* Effect.promise(() => arrived.promise);
          yield* Effect.promise(() => h.library.refreshPlacement.run(h.registry, { threadId }));
          release.resolve();
          yield* Effect.promise(() => index);
          expect(
            h.registry.get(portableThreadPlacementsAtom)?.placements.get(threadId)?.operationId,
          ).toBeNull();
          expect(h.registry.get(h.library.indexAtom)?.entries[0]?.placement.operationId).toBeNull();
        }),
      ),
  );

  it.effect(
    "refreshes a closed chat on queue/routing changes while ignoring titles and timestamps",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const h = yield* harness(async () => {
            calls++;
            return Response.json({
              entries: [
                {
                  ...summary,
                  placement: {
                    ...summary.placement,
                    environmentId: calls > 1 ? "vm" : "offline",
                    generation: calls > 1 ? 2 : 1,
                    previousLocations:
                      calls > 1 ? [{ environmentId: "offline", generation: 1 }] : [],
                  },
                },
              ],
              next: null,
            });
          });
          const shells = Atom.make([navigationShell("offline")]);
          const catalog = Atom.make<EnvironmentCatalogState>({ isReady: true, entries: new Map() });
          const refresh = createPortableThreadNavigationRefreshAtom(h.runtime, h.library, {
            shellsAtom: shells,
            catalogAtom: catalog,
            connectionStateAtom: () => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
            relayUrl: () => "https://relay.example.test",
          });
          const navigation = createPortableThreadPresentationAtom({
            shellsAtom: shells,
            relayUrl: () => "https://relay.example.test",
            indexLoadedAtom: refresh,
          });
          h.registry.mount(navigation);
          yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
          // Settle the deliberate shared refresh above before measuring incremental changes.
          const reads = calls;
          h.registry.set(shells, [
            {
              ...navigationShell("offline"),
              title: "Streaming title",
              updatedAt: "2026-10-22T19:00:00Z",
            },
          ]);
          yield* Effect.yieldNow;
          expect(calls).toBe(reads);
          h.registry.set(shells, [
            {
              ...navigationShell("offline"),
              promptQueueSummary: { count: 1, enabled: true, pauseReason: null },
            },
            navigationShell("vm", 2),
          ]);
          yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
          expect(calls).toBeGreaterThan(reads);
          expect(h.registry.get(navigation)).toHaveLength(1);
          expect(h.registry.get(navigation)[0]?.environmentId).toBe("vm");
        }),
      ),
  );
  it.effect("retries a failed navigation read on foreground and network recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let fail = true;
        let calls = 0;
        let arrived = Promise.withResolvers<void>();
        const h = yield* harness(async () => {
          calls++;
          arrived.resolve();
          return fail
            ? new Response("offline", { status: 503 })
            : Response.json({ entries: [summary], next: null });
        });
        const refresh = createPortableThreadNavigationRefreshAtom(h.runtime, h.library, {
          shellsAtom: Atom.make([]),
          catalogAtom: Atom.make<EnvironmentCatalogState>({ isReady: true, entries: new Map() }),
          connectionStateAtom: () => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
          relayUrl: () => "https://relay.example.test",
        });
        h.registry.mount(refresh);
        yield* Effect.promise(() => arrived.promise);
        yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
        expect(h.registry.get(h.library.indexAtom)).toBeNull();
        fail = false;
        const previousCalls = calls;
        arrived = Promise.withResolvers<void>();
        yield* Queue.offer(h.wakeups, "application-active");
        yield* Effect.promise(() => arrived.promise);
        yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
        expect(calls).toBeGreaterThan(previousCalls);
        expect(h.registry.get(h.library.indexAtom)?.entries).toHaveLength(1);
        arrived = Promise.withResolvers<void>();
        yield* Queue.offer(h.network, "offline");
        yield* Queue.offer(h.network, "online");
        yield* Effect.promise(() => arrived.promise);
        yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
        expect(h.registry.get(h.library.indexAtom)?.entries).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "follows a known move after the source disconnects, refreshes its VM summary once, then stops targeted reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          let locationReads = 0;
          const firstRead = Promise.withResolvers<void>();
          const completed = Promise.withResolvers<void>();
          const h = yield* harness(async (url, init) => {
            const path = new URL(new Request(url, init).url).pathname;
            if (path.endsWith("/placement")) {
              locationReads++;
              firstRead.resolve();
              return Response.json({
                ...summary.placement,
                environmentId: locationReads > 1 ? "vm" : "offline",
                generation: locationReads > 1 ? 2 : 1,
                operationId: locationReads > 1 ? null : "move",
                previousLocations: [{ environmentId: "offline", generation: 1 }],
              });
            }
            return Response.json({
              entries: [
                {
                  ...summary,
                  placement: {
                    ...summary.placement,
                    environmentId: locationReads > 1 ? "vm" : "offline",
                    generation: locationReads > 1 ? 2 : 1,
                    operationId: locationReads > 1 ? null : "move",
                    previousLocations: [{ environmentId: "offline", generation: 1 }],
                  },
                  vm: {
                    state: locationReads > 1 ? "running" : "moving",
                    projectName: "Project",
                    activity: "idle",
                    observedAt: null,
                    lastWorkAt: null,
                    lastVerifiedBackupAt: null,
                    savedDiskExpiresAt: null,
                  },
                },
              ],
              next: null,
            });
          });
          const shells = Atom.make([navigationShell("offline")]);
          const connection = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState, never>>(
            AsyncResult.success<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
          );
          const catalog = Atom.make<EnvironmentCatalogState>({
            isReady: true,
            entries: new Map([
              [
                EnvironmentId.make("offline"),
                {
                  target: new RelayConnectionTarget({
                    environmentId: EnvironmentId.make("offline"),
                    label: "Source",
                  }),
                  profile: Option.none(),
                  enabled: true,
                },
              ],
            ]),
          });
          const refresh = createPortableThreadNavigationRefreshAtom(h.runtime, h.library, {
            shellsAtom: shells,
            catalogAtom: catalog,
            connectionStateAtom: () => connection,
            relayUrl: () => "https://relay.example.test",
          });
          const navigation = createPortableThreadPresentationAtom({
            shellsAtom: shells,
            relayUrl: () => "https://relay.example.test",
            indexLoadedAtom: refresh,
          });
          h.registry.subscribe(portableThreadPlacementsAtom, (proofs) => {
            if (
              proofs?.placements.get(threadId)?.generation === 2 &&
              proofs.summaries.get(threadId)?.state === "running"
            )
              completed.resolve();
          });
          h.registry.mount(refresh);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          yield* Effect.promise(() => firstRead.promise);
          h.registry.set(
            connection,
            AsyncResult.success<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "offline",
              network: "offline",
            }),
          );
          yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1500));
          yield* Effect.promise(() => completed.promise);
          const readsAtCompletion = locationReads;
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6000));
          expect(locationReads).toBe(readsAtCompletion);
          expect(h.registry.get(navigation)[0]?.portableLocation).toMatchObject({
            environmentId: "vm",
            label: "Private VM · unavailable",
            machine: "cloud",
          });
          expect(
            h.registry.get(portableThreadPlacementsAtom)?.placements.get(threadId),
          ).toMatchObject({
            environmentId: "vm",
            generation: 2,
            operationId: null,
          });
        }),
      ),
  );
  it.effect("refreshes the VM summary when a direct check discovers a fast completed move", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let moved = false;
        const completed = Promise.withResolvers<void>();
        const currentPlacement = () => ({
          ...summary.placement,
          environmentId: moved ? "vm" : "offline",
          generation: moved ? 2 : 1,
          previousLocations: moved ? [{ environmentId: "offline", generation: 1 }] : [],
        });
        const h = yield* harness(async () =>
          Response.json({
            entries: [
              {
                ...summary,
                placement: currentPlacement(),
                vm: {
                  state: moved ? "running" : "on_machine",
                  projectName: "Project",
                  activity: "idle",
                  observedAt: null,
                  lastWorkAt: null,
                  lastVerifiedBackupAt: null,
                  savedDiskExpiresAt: null,
                },
              },
            ],
            next: null,
          }),
        );
        const shells = Atom.make([navigationShell("offline")]);
        const refresh = createPortableThreadNavigationRefreshAtom(h.runtime, h.library, {
          shellsAtom: shells,
          catalogAtom: Atom.make<EnvironmentCatalogState>({ isReady: true, entries: new Map() }),
          connectionStateAtom: () => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
          relayUrl: () => "https://relay.example.test",
        });
        const navigation = createPortableThreadPresentationAtom({
          shellsAtom: shells,
          relayUrl: () => "https://relay.example.test",
          indexLoadedAtom: refresh,
        });
        h.registry.mount(navigation);
        yield* Effect.promise(() => h.library.refreshIndex.run(h.registry, undefined));
        h.registry.subscribe(portableThreadPlacementsAtom, (proofs) => {
          if (proofs?.summaries.get(threadId)?.state === "running") completed.resolve();
        });
        moved = true;
        expect(
          rememberPortableThreadPlacement(
            h.registry,
            h.session,
            "https://relay.example.test",
            currentPlacement(),
          ),
        ).toBe(true);
        yield* Effect.promise(() => completed.promise);
        expect(h.registry.get(navigation)[0]?.portableLocation).toMatchObject({
          environmentId: "vm",
          label: "Private VM · unavailable",
          machine: "cloud",
        });
      }),
    ),
  );
});
