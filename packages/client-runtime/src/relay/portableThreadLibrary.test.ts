import { describe, expect, it } from "@effect/vitest";
import { CommandId, ThreadId, OrchestrationEvent, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createPortableThreadLibraryAtoms } from "./portableThreadLibrary.ts";
import {
  applyPortableThreadHistoryPage,
  emptyPortableThreadHistory,
} from "./portableThreadHistory.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";

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
  const library = createPortableThreadLibraryAtoms(
    Atom.runtime(tenancyLayer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn)))),
  );
  return { registry, session, library };
});

describe("retained conversation view", () => {
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
