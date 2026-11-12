import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { inspectThreadHistoryArchive, makeThreadHistoryArchive } from "./ThreadHistoryArchive.ts";
import { workspaceFileHash } from "./ThreadWorkspaceFiles.ts";

const at = "2026-10-05T10:00:00.000Z";
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
let serial = 0;
const fixture = (messageCount = 2) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const events = yield* OrchestrationEventStore;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-history-archive-" });
    const threadId = `history-${++serial}`;
    const owner = { threadId, environmentId: "source", generation: 1, operationId: "move" };
    const stored: OrchestrationEvent[] = [];
    for (let index = 0; index <= messageCount; index++) {
      const id = `${threadId}-${index}`;
      const event = decode({
        type: index === 0 ? "thread.created" : "thread.message-sent",
        sequence: 0,
        eventId: id,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: id,
        causationEventId: null,
        correlationId: null,
        metadata: { origin: { surface: "web" } },
        payload:
          index === 0
            ? {
                threadId,
                projectId: "project",
                title: "History",
                modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: at,
                updatedAt: at,
              }
            : {
                threadId,
                messageId: id,
                role: "user",
                text: `message ${index}`,
                author: { userId: "author", displayName: "Original author", imageUrl: null },
                turnId: null,
                streaming: false,
                createdAt: at,
                updatedAt: at,
              },
      });
      stored.push(yield* events.append(event));
    }
    const accepted = `${threadId}-accepted`,
      rejected = `${threadId}-rejected`;
    yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, project_id, accepted_at, result_sequence, status, error)
    VALUES (${accepted}, 'thread', ${threadId}, 'project', ${at}, ${stored.at(-1)!.sequence}, 'accepted', NULL),
      (${rejected}, 'thread', ${threadId}, 'project', ${at}, 0, 'rejected', 'Already handled')`;
    const fences = makeThreadExecutionFence(sql);
    const enrollment = {
      ...owner,
      operationId: "enroll",
      relayUrl: "https://relay.example",
      projectId: "project",
    };
    yield* fences.prepare(enrollment);
    yield* fences.activate(enrollment);
    yield* fences.beginDrain({ ...owner, previousOperationId: "enroll" });
    yield* fences.freeze(owner);
    const archive = makeThreadHistoryArchive(sql, events);
    const input = { ...owner, artifactRoot: path.join(root, "artifacts") };
    const request = (saved: Effect.Success<ReturnType<typeof archive.exportFrozen>>) => ({
      owner,
      directory: saved.directory,
      manifest: saved.manifest,
    });
    return {
      fs,
      path,
      sql,
      events,
      fences,
      root,
      owner,
      stored,
      input,
      archive,
      request,
      accepted,
      rejected,
    };
  });
const layer = OrchestrationEventStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("frozen thread history archive", (it) => {
  it.effect(
    "retains all pages, authors, source identities and accepted/rejected command receipts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(1100);
        const saved = yield* f.archive.exportFrozen(f.input);
        expect(saved.manifest.eventCount).toBe(1101);
        const inspected = yield* inspectThreadHistoryArchive(f.request(saved));
        expect(yield* Stream.runCollect(inspected.events)).toEqual(f.stored);
        expect(inspected.receipts.map((receipt) => [receipt.commandId, receipt.status])).toEqual([
          [f.accepted, "accepted"],
          [f.rejected, "rejected"],
        ]);
        expect(inspected.manifest.sourceSequence).toBe(f.stored.at(-1)!.sequence);
      }),
  );
  it.effect("rejects a truncated reader rather than accepting the UI's first page", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archive = makeThreadHistoryArchive(f.sql, {
        readAggregateRange: (input) => f.events.readAggregateRange({ ...input, limit: 1 }),
      });
      yield* Effect.flip(archive.exportFrozen(f.input));
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
    }),
  );
  it.effect("blocks export when work is active or the move identity changed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fences.activate(f.owner);
      yield* Effect.flip(f.archive.exportFrozen(f.input));
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
      yield* Effect.flip(f.archive.exportFrozen({ ...f.input, operationId: "other-move" }));
    }),
  );
  it.effect("rechecks the fence after exporting and removes an unpublishable archive", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archive = makeThreadHistoryArchive(f.sql, {
        readAggregateRange: (input) =>
          f.events
            .readAggregateRange(input)
            .pipe(Stream.tap(() => f.fences.activate(f.owner).pipe(Effect.orDie))),
      });
      yield* Effect.flip(archive.exportFrozen(f.input));
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
    }),
  );
  for (const kind of ["events", "receipts"] as const) {
    it.effect(`rejects altered ${kind} bytes before exposing an import stream`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const saved = yield* f.archive.exportFrozen(f.input);
        yield* f.fs.writeFileString(f.path.join(saved.directory, `${kind}.jsonl`), "changed");
        yield* Effect.flip(inspectThreadHistoryArchive(f.request(saved)));
      }),
    );
  }
  it.effect("rejects incomplete native JSON records even with a matching transport hash", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = yield* f.archive.exportFrozen(f.input);
      const file = f.path.join(saved.directory, "events.jsonl");
      const original = yield* f.fs.readFileString(file);
      yield* f.fs.writeFileString(file, original.trimEnd());
      const manifest = { ...saved.manifest, events: yield* workspaceFileHash(file) };
      yield* Effect.flip(inspectThreadHistoryArchive({ ...f.request(saved), manifest }));
    }),
  );
  it.effect("rejects archives addressed to another environment, generation or move", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = yield* f.archive.exportFrozen(f.input);
      for (const owner of [
        { ...f.owner, threadId: "other-thread" },
        { ...f.owner, environmentId: "other-env" },
        { ...f.owner, generation: 2 },
        { ...f.owner, operationId: "other-move" },
      ]) {
        yield* Effect.flip(inspectThreadHistoryArchive({ ...f.request(saved), owner }));
      }
    }),
  );
  it.effect("cleans an interrupted export and keeps a previous verified archive", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const previous = yield* f.archive.exportFrozen(f.input);
      const entered = yield* Deferred.make<void>();
      const archive = makeThreadHistoryArchive(f.sql, {
        readAggregateRange: () =>
          Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      });
      const fiber = yield* archive.exportFrozen(f.input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([
        f.path.basename(previous.directory),
      ]);
      const verified = yield* inspectThreadHistoryArchive(f.request(previous));
      expect(verified.manifest.eventCount).toBe(3);
    }),
  );
});
