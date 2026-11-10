import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId, VcsProcessOutputLimitError } from "@t3tools/contracts";
import { WorkflowRecoveryManifest, type WorkflowSaveReceipt } from "@t3tools/contracts/workflows";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeWorkflowResultOutbox, WORKFLOW_SAVE_CYCLE_MS } from "../jobs/WorkflowResultOutbox.ts";
import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import {
  makeWorkflowResultPublisher,
  WorkflowResultSaveError,
  type WorkflowResultTransport,
} from "./WorkflowResultPublisher.ts";
import type { ThreadCheckpointTransport } from "./ThreadCheckpointPublisher.ts";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRecoveryManifest));
const services = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const binding = {
  jobId: "job",
  threadId: ThreadId.make("workflow:job"),
  organizationId: "org",
  repositoryId: "repo",
  allocationId: "allocation",
  environmentId: EnvironmentId.make("guest"),
  generation: 1,
  operationId: "provision",
  projectId: ProjectId.make("project"),
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-result-publisher-" });
  const fence = makeThreadExecutionFence(sql);
  yield* fence.prepare({ ...binding, relayUrl: "https://relay.invalid" });
  yield* fence.activate(binding);
  const outbox = makeWorkflowResultOutbox(sql);
  let uploads = 0;
  let publishCalls = 0;
  let lostReply = false;
  let saved: WorkflowSaveReceipt | null = null;
  const bytes = new Map<string, Uint8Array>();
  const upload: ThreadCheckpointTransport["upload"] = (owner, input, body) =>
    Effect.gen(function* () {
      uploads++;
      const value = Buffer.concat(Array.from(yield* Stream.runCollect(body.pipe(Stream.orDie))));
      expect(NodeCrypto.createHash("sha256").update(value).digest("hex")).toBe(input.sha256);
      bytes.set(input.artifactId, value);
      return { ...input, threadId: ThreadId.make(owner.threadId), state: "complete" as const };
    });
  const transport: WorkflowResultTransport = {
    reserve: () => Effect.void,
    publish: (_owner, input) =>
      Effect.gen(function* () {
        publishCalls++;
        if (saved) return saved;
        const raw = bytes.get(input.manifestArtifactId);
        if (!raw)
          return yield* new WorkflowResultSaveError({ detail: "Not uploaded", permanent: false });
        const manifest = yield* decodeManifest(new TextDecoder().decode(raw));
        saved = {
          publicationId: manifest.publicationId,
          jobId: binding.jobId,
          threadId: binding.threadId,
          revision: manifest.revision,
          binding,
          manifest: {
            artifactId: input.manifestArtifactId,
            sha256: NodeCrypto.createHash("sha256").update(raw).digest("hex"),
            sizeBytes: raw.length,
          },
          resultId: manifest.result?.resultId ?? null,
        };
        if (lostReply)
          return yield* new WorkflowResultSaveError({ detail: "Reply lost", permanent: false });
        return saved;
      }).pipe(
        Effect.catchTag(
          "SchemaError",
          () => new WorkflowResultSaveError({ detail: "Invalid manifest", permanent: true }),
        ),
      ),
  };
  const publisher = (
    dependencies: Parameters<typeof makeWorkflowResultPublisher>[3] = {
      synchronize: () => Effect.void,
    },
  ) => makeWorkflowResultPublisher(sql, transport, { upload }, dependencies, root);
  const capture = {
    resultId: NodeCrypto.randomUUID(),
    stepId: "agent",
    turnId: "turn",
    turnCount: 1,
    outcome: "completed" as const,
    createdAt: "2026-11-10T10:00:00Z",
    checkpointRef: "checkpoint",
    baselineCommitId: "a".repeat(40),
    commitId: "b".repeat(40),
    treeId: "c".repeat(40),
  };
  return {
    sql,
    fs,
    root,
    outbox,
    publisher,
    capture,
    loseReply: () => {
      lostReply = true;
    },
    uploadCount: () => uploads,
    publishCount: () => publishCalls,
  };
});
const query = (getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"]) =>
  CheckpointDiffQuery.of({
    getTurnDiff,
    getSavedWorkflowCaptureDiff: () => Effect.die("No partial-capture read"),
    getFullThreadDiff: () => Effect.die("No full-thread read"),
  });

it.effect(
  "reconciles a lost save reply after restart without local files or another Agent/diff",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":0}' });
        f.loseReply();
        yield* f.publisher().synchronize(binding.threadId);
        const pending = (yield* f.outbox.next(binding.threadId))!;
        expect(pending.failures).toBe(1);
        expect(f.uploadCount()).toBe(2);
        yield* f.fs.remove(`${f.root}/${pending.publicationId}`, { recursive: true });
        yield* TestClock.adjust(5_000);
        yield* f.publisher().synchronize(binding.threadId);
        expect(yield* f.outbox.next(binding.threadId)).toBeNull();
        expect(f.uploadCount()).toBe(2);
        expect(f.publishCount()).toBe(2);
      }),
    ).pipe(
      Effect.provideService(
        CheckpointDiffQuery,
        query(() => Effect.die("Saving retries cannot run an Agent or regenerate its diff")),
      ),
      Effect.provide(services),
    ),
);

it.effect("bounds a stalled prerequisite by the persisted whole-cycle deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":0}' });
      const started = yield* Deferred.make<void>();
      const publisher = f.publisher({
        synchronize: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const running = yield* Effect.forkChild(publisher.synchronize(binding.threadId));
      yield* Deferred.await(started);
      yield* TestClock.adjust(WORKFLOW_SAVE_CYCLE_MS);
      yield* Fiber.join(running);
      expect(yield* f.outbox.saving(binding.jobId)).toMatchObject({
        state: "failed",
        retryable: true,
      });
      expect((yield* f.outbox.next(binding.threadId))?.detail).toContain(
        "publishing the conversation",
      );
      expect(f.uploadCount()).toBe(0);
      yield* publisher.synchronize(binding.threadId);
      expect(f.uploadCount()).toBe(0);
    }),
  ).pipe(
    Effect.provideService(
      CheckpointDiffQuery,
      query(() => Effect.die("No diff while prerequisites stall")),
    ),
    Effect.provide(services),
  ),
);

it.effect(
  "missing native receipts wait and eventually fail without publishing incomplete Agent evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":0}', result: f.capture });
        yield* f.publisher().synchronize(binding.threadId);
        expect((yield* f.outbox.next(binding.threadId))?.failures).toBe(0);
        expect(f.publishCount()).toBe(0);
        yield* TestClock.adjust(WORKFLOW_SAVE_CYCLE_MS);
        yield* f.publisher().synchronize(binding.threadId);
        expect(yield* f.outbox.saving(binding.jobId)).toMatchObject({
          state: "failed",
          retryable: true,
        });
        expect(f.uploadCount()).toBe(0);
      }),
    ).pipe(
      Effect.provideService(
        CheckpointDiffQuery,
        query(() => Effect.die("No diff without its native point")),
      ),
      Effect.provide(services),
    ),
);

it.effect(
  "a rejected oversized diff stops saving permanently instead of offering an ineffective retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":1}', result: f.capture });
        yield* f.sql`INSERT INTO thread_native_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id) VALUES(${binding.threadId},1,'turn','turn','guest',0,'native','/unused',${"a".repeat(64)},${"b".repeat(64)},${NodeCrypto.randomUUID()})`;
        yield* f.sql`INSERT INTO thread_attachment_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id) VALUES(${binding.threadId},1,'turn','turn','guest',0,'/unused',${"c".repeat(64)},${NodeCrypto.randomUUID()})`;
        yield* f.publisher().synchronize(binding.threadId);
        const failed = (yield* f.outbox.next(binding.threadId))!;
        expect(failed.status).toBe("failed");
        expect(failed.permanent).toBe(1);
        expect(failed.detail).toContain("10 MB");
        expect(yield* f.outbox.retry(binding.jobId, failed.publicationId)).toBe(false);
        expect(f.uploadCount()).toBe(0);
      }),
    ).pipe(
      Effect.provideService(
        CheckpointDiffQuery,
        query(
          () =>
            new VcsProcessOutputLimitError({
              operation: "diff",
              command: "git diff",
              cwd: "/repo",
              stream: "stdout",
              maxBytes: 10_000_000,
              observedBytes: 10_000_001,
            }),
        ),
      ),
      Effect.provide(services),
    ),
);

it.effect("waits for the native point's newer history without consuming failed attempts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":1}', result: f.capture });
      yield* f.sql`INSERT INTO thread_native_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id)
      VALUES(${binding.threadId},1,'turn','turn','guest',5,'native','/unused',${"a".repeat(64)},${"b".repeat(64)},${NodeCrypto.randomUUID()})`;
      yield* f.sql`INSERT INTO thread_attachment_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id)
      VALUES(${binding.threadId},1,'turn','turn','guest',5,'/unused',${"c".repeat(64)},${NodeCrypto.randomUUID()})`;
      yield* f.publisher().synchronize(binding.threadId);
      expect((yield* f.outbox.next(binding.threadId))?.failures).toBe(0);
      expect((yield* f.outbox.next(binding.threadId))?.stage).toBe(
        "waiting for mirrored conversation history",
      );
      expect(f.publishCount()).toBe(0);
      expect(f.uploadCount()).toBe(0);
    }),
  ).pipe(
    Effect.provideService(
      CheckpointDiffQuery,
      query(() => Effect.die("No materialization before exact history")),
    ),
    Effect.provide(services),
  ),
);

for (const outcome of ["failed", "cancelled"] as const)
  it.effect(`publishes a labelled ${outcome} capture without requesting Review evidence`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const capture = { ...f.capture, outcome };
        yield* f.outbox.enqueue({ binding, recordJson: '{"cursor":1}', result: capture });
        yield* f.sql`INSERT INTO thread_native_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id) VALUES(${binding.threadId},1,'turn','turn','guest',0,'native','/unused',${"a".repeat(64)},${"b".repeat(64)},${NodeCrypto.randomUUID()})`;
        yield* f.sql`INSERT INTO thread_attachment_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id) VALUES(${binding.threadId},1,'turn','turn','guest',0,'/unused',${"c".repeat(64)},${NodeCrypto.randomUUID()})`;
        const intent = (yield* f.outbox.next(binding.threadId))!;
        f.loseReply();
        yield* f
          .publisher()
          .synchronize(binding.threadId)
          .pipe(
            Effect.provideService(CheckpointDiffQuery, {
              ...query(() =>
                Effect.die("A partial result cannot ask for complete Review evidence"),
              ),
              getSavedWorkflowCaptureDiff: (owner, point) =>
                Effect.sync(() => {
                  expect(owner).toEqual(binding);
                  expect(point).toEqual(capture);
                  return "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+partial  \n";
                }),
            }),
          );
        const [materialized] = yield* f.sql<{
          manifest: string;
        }>`SELECT manifest_json AS manifest FROM workflow_result_outbox WHERE publication_id=${intent.publicationId}`;
        expect((yield* decodeManifest(materialized!.manifest)).result?.outcome).toBe(outcome);
        // Reconcile the receipt without regenerating or rerunning the failed Agent.
        yield* TestClock.adjust(5_000);
        yield* f
          .publisher()
          .synchronize(binding.threadId)
          .pipe(
            Effect.provideService(
              CheckpointDiffQuery,
              query(() => Effect.die("Retry cannot read diffs again")),
            ),
          );
        expect(yield* f.outbox.next(binding.threadId)).toBeNull();
      }),
    ).pipe(Effect.provide(services)),
  );
