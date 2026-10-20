import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { inspectThreadHistoryArchive } from "./ThreadHistoryArchive.ts";
import { exportThreadVmRestoreHistory } from "./ThreadVmRestoreHistory.ts";

const decode = Schema.decodeUnknownSync(OrchestrationEvent),
  at = "2026-10-07T00:00:00.000Z";
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "restore-history-" }),
  );
  const boot = {
    version: 1 as const,
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    threadId: ThreadId.make(NodeCrypto.randomUUID()),
    generation: 2,
  };
  const baseDir = path.join(root, "serving"),
    source = path.join(`${baseDir}-restores`, boot.allocationId, "source"),
    database = path.join(source, "userdata", "state.sqlite");
  const workspaceRoot = path.join(root, "workspace");
  const captureOperationId = NodeCrypto.randomUUID();
  const owner = {
    threadId: boot.threadId,
    environmentId: "old-environment",
    projectId: "old-project",
    relayUrl: "https://relay.test",
    generation: 1,
    operationId: captureOperationId,
  };
  const stored = yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        events = yield* OrchestrationEventStore;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES('old-project','Saved',${workspaceRoot},'[]',${at},${at})`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at,branch)
        VALUES(${boot.threadId},'old-project','Saved','{}',${at},${at},'main')`;
      const created = yield* events.append(
        decode({
          sequence: 0,
          eventId: "created",
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: boot.threadId,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: { origin: { surface: "web" } },
          payload: {
            threadId: boot.threadId,
            projectId: "old-project",
            title: "Saved",
            modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: at,
            updatedAt: at,
          },
        }),
      );
      const message = yield* events.append(
        decode({
          sequence: 0,
          eventId: "message",
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: boot.threadId,
          occurredAt: at,
          commandId: "old-command",
          causationEventId: null,
          correlationId: null,
          metadata: { origin: { surface: "web" } },
          payload: {
            threadId: boot.threadId,
            messageId: "message",
            role: "user",
            text: "Remember this",
            author: { userId: "author", displayName: "Original author", imageUrl: null },
            turnId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        }),
      );
      yield* sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,project_id,accepted_at,result_sequence,status,error)
      VALUES('old-command','thread',${boot.threadId},'old-project',${at},${message.sequence},'accepted',NULL)`;
      const fences = makeThreadExecutionFence(sql),
        initial = { ...owner, operationId: "initial" };
      yield* fences.prepare(initial);
      yield* fences.activate(initial);
      yield* fences.beginDrain({ ...owner, previousOperationId: "initial" });
      yield* fences.freeze(owner);
      return [created, message];
    }).pipe(
      Effect.provide(
        OrchestrationEventStoreLive.pipe(Layer.provideMerge(makeSqlitePersistenceLive(database))),
      ),
    ),
  );
  const native = {
    operationId: NodeCrypto.randomUUID(),
    threadId: boot.threadId,
    turnId: "settled",
    captureOperationId,
    sourceEnvironmentId: owner.environmentId,
    generation: 1,
    sourceSequence: stored.at(-1)!.sequence,
    nativeThreadId: NodeCrypto.randomUUID(),
    nativeManifestSha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    manifestArtifactId: NodeCrypto.randomUUID(),
    manifestSha256: "c".repeat(64),
  };
  const input = { boot, native, baseDir, workspaceRoot, artifactRoot: path.join(root, "staging") };
  const hash = Effect.gen(function* () {
    return NodeCrypto.createHash("sha256")
      .update(yield* fs.readFile(database))
      .digest("hex");
  });
  return { fs, path, root, source, database, input, stored, hash };
});

it.layer(NodeServices.layer)("saved VM read-only history", (it) => {
  it.effect(
    "exports all original identities, authors and receipts under the new restore without changing the old DB",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(),
          before = yield* f.hash;
        const saved = yield* exportThreadVmRestoreHistory(f.input);
        expect(saved.manifest).toMatchObject({
          operationId: f.input.boot.operationId,
          environmentId: "old-environment",
          generation: 1,
          eventCount: 2,
          receiptCount: 1,
        });
        const archive = yield* inspectThreadHistoryArchive({
          owner: saved.manifest,
          manifest: saved.manifest,
          directory: saved.directory,
        });
        expect(yield* Stream.runCollect(archive.events)).toEqual(f.stored);
        expect(archive.receipts).toMatchObject([{ commandId: "old-command", status: "accepted" }]);
        expect(yield* f.hash).toBe(before);
      }),
  );
  it.effect("blocks foreign capture, generation or frozen watermark before exporting", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const native of [
        { ...f.input.native, captureOperationId: NodeCrypto.randomUUID() },
        { ...f.input.native, sourceEnvironmentId: "other" },
        { ...f.input.native, generation: 2 },
        { ...f.input.native, sourceSequence: f.input.native.sourceSequence + 1 },
      ])
        yield* Effect.flip(exportThreadVmRestoreHistory({ ...f.input, native }));
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );
  it.effect("refuses redirected source files and scratch storage inside the source", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flip(
        exportThreadVmRestoreHistory({
          ...f.input,
          artifactRoot: f.path.join(f.source, "staging"),
        }),
      );
      const original = f.database + ".original";
      yield* f.fs.rename(f.database, original);
      yield* f.fs.symlink(original, f.database);
      yield* Effect.flip(exportThreadVmRestoreHistory(f.input));
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );
});
