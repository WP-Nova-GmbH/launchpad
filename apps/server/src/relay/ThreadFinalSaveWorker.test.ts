import * as NodeCrypto from "node:crypto";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmFinalSave } from "@t3tools/contracts/relay";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeThreadFinalSaveWorker } from "./ThreadFinalSaveWorker.ts";
import { ThreadFinalSaveError } from "./ThreadFinalSaveTransport.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encodeQueueFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

for (const problem of [
  "source-changed-during-read",
  "queued-work",
  "late-queued-work",
  "archived-queue",
  "paused-queue",
  "lost-reply",
  "missing-publication",
  "unacknowledged-work",
  "stopped-provider",
  "wrong-generation",
  "aborted",
] as const) {
  it.effect(`retains one executing owner during final saving with ${problem}`, () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* attachmentCheckpointFixture,
          operationId = NodeCrypto.randomUUID(),
          advancedOperationId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at) VALUES(${f.owner.threadId},'codex','codex','stopped','2026-10-07T00:00:00Z')`;
        yield* f.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json) VALUES(${f.owner.threadId},${f.nativeInput.turnId},'completed','2026-10-07T00:00:00Z','2026-10-07T00:01:00Z','[]')`;
        let operation: RelayThreadVmFinalSave = {
          threadId: ThreadId.make(f.owner.threadId),
          environmentId: EnvironmentId.make(f.owner.environmentId),
          generation: problem === "wrong-generation" ? 2 : 1,
          operationId,
          phase: "draining",
          nativeCheckpointOperationId: null,
        };
        const queued = {
          ...emptyThreadPromptQueue(),
          entries: [
            {
              kind: "move",
              messageId: "move",
              destination: { kind: "vm" },
              state: "pending",
              revision: 0,
              acceptedSequence: 1,
              createdAt: "2026-10-07T00:00:00Z",
            },
          ],
        };
        const queueJson = yield* encodeQueueFixture({
          ...queued,
          enabled: problem !== "paused-queue",
        });
        const enqueue = f.sql`INSERT INTO projection_thread_prompt_queues(thread_id,state_json) VALUES(${f.owner.threadId},${queueJson})`;
        if (["queued-work", "archived-queue", "paused-queue"].includes(problem)) yield* enqueue;
        if (problem === "archived-queue")
          yield* f.sql`UPDATE projection_threads SET archived_at='2026-10-07T00:00:00Z' WHERE thread_id=${f.owner.threadId}`;
        let acknowledgements = 0,
          captures = 0,
          closed = 0,
          flushed = 0,
          stopped = 0;
        if (problem === "unacknowledged-work")
          yield* f.sql`INSERT INTO thread_execution_work(thread_id,work_id,generation,kind,started,completed,relay_completed) VALUES(${f.owner.threadId},'workspace:still-running',1,'workspace',1,0,0)`;
        if (problem === "stopped-provider")
          yield* f.sql`INSERT INTO thread_execution_work(thread_id,work_id,generation,kind,started,completed,relay_completed) VALUES(${f.owner.threadId},'provider:idle',1,'provider',1,0,0)`;
        const services = Layer.mergeAll(
          Layer.mock(ProviderService)({
            listSessions: () => Effect.succeed([]),
            stopSession: () =>
              Effect.sync(() => {
                stopped++;
              }),
            flushRuntimeEvents: () =>
              Effect.sync(() => {
                flushed++;
              }),
            checkpointConversation: () =>
              Effect.gen(function* () {
                yield* f.native.captureFrozen({ ...f.nativeInput, operationId }, (stage) =>
                  Effect.gen(function* () {
                    captures++;
                    const directory = f.path.join(stage, "conversation");
                    yield* f.fs.copy(f.point.directory, directory);
                    return { directory, nativeThreadId: f.point.nativeThreadId };
                  }),
                );
                yield* f.store.capture({ ...f.input, captureOperationId: operationId });
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, f.fs),
                Effect.provideService(Path.Path, f.path),
                Effect.orDie,
              ),
          }),
          Layer.mock(TerminalManager)({
            close: () =>
              Effect.gen(function* () {
                closed++;
                if (problem === "late-queued-work") yield* enqueue;
              }).pipe(Effect.orDie),
          }),
          Layer.mock(OrchestrationEngineService)({}),
        );
        const worker = yield* makeThreadFinalSaveWorker(
          {
            get: () =>
              Effect.gen(function* () {
                if (problem === "source-changed-during-read") {
                  const before = (yield* f.fences.get(f.owner.threadId))!;
                  yield* f.fences.beginDrain({
                    ...f.owner,
                    operationId: advancedOperationId,
                    previousOperationId: before.operationId,
                  });
                  yield* f.fences.activate({ ...f.owner, operationId: advancedOperationId });
                }
                return operation;
              }).pipe(Effect.orDie),
            cancel: () =>
              Effect.gen(function* () {
                operation = { ...operation, phase: "aborting" };
                return yield* new ThreadFinalSaveError({
                  threadId: f.owner.threadId,
                  detail: "Lost cancellation reply",
                });
              }),
            freeze: (_owner, input) =>
              Effect.gen(function* () {
                acknowledgements++;
                operation = {
                  ...operation,
                  phase: "frozen",
                  nativeCheckpointOperationId: input.nativeCheckpointOperationId,
                };
                return yield* new ThreadFinalSaveError({
                  threadId: f.owner.threadId,
                  detail: "Lost acknowledged freeze reply",
                });
              }),
          },
          { synchronize: () => Effect.succeed(undefined) },
          {
            synchronize: () =>
              Effect.gen(function* () {
                if (problem === "missing-publication") return;
                const key = threadCheckpointId(f.nativeInput.turnId, operationId);
                yield* f.sql`UPDATE thread_native_checkpoints SET published_artifact_id='native-receipt' WHERE thread_id=${f.owner.threadId} AND checkpoint_id=${key}`;
                yield* f.sql`UPDATE thread_attachment_checkpoints SET published_artifact_id='chat-receipt' WHERE thread_id=${f.owner.threadId} AND checkpoint_id=${key}`;
              }).pipe(Effect.orDie),
          },
        ).pipe(Effect.provide(services));
        const first = yield* Effect.result(worker.synchronize(f.owner.threadId));
        if (problem === "source-changed-during-read") {
          expect(first._tag).toBe("Failure");
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "active",
            operationId: advancedOperationId,
          });
          expect(captures).toBe(0);
          expect(closed).toBe(0);
          expect(flushed).toBe(0);
          return;
        }
        if (problem === "wrong-generation") {
          expect(first._tag).toBe("Failure");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(captures).toBe(0);
          expect(closed).toBe(0);
          return;
        }
        if (problem === "queued-work" || problem === "late-queued-work") {
          expect(first._tag).toBe("Failure");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          expect(operation.phase).toBe("aborting");
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          yield* worker.synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          operation = { ...operation, phase: "aborted" };
          yield* worker.synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          return;
        }
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe(
          problem === "unacknowledged-work" ? "draining" : "frozen",
        );
        if (problem === "unacknowledged-work") {
          expect(flushed).toBe(0);
          expect(captures).toBe(0);
          expect(closed).toBe(0);
        }
        if (problem === "stopped-provider") {
          expect(stopped).toBe(1);
          expect(captures).toBe(1);
          expect(
            yield* f.sql`SELECT completed,relay_completed AS acknowledged FROM thread_execution_work
            WHERE thread_id=${f.owner.threadId} AND work_id='provider:idle'`,
          ).toEqual([{ completed: 1, acknowledged: 1 }]);
        }
        if (problem === "missing-publication") {
          expect(acknowledgements).toBe(0);
          expect(captures).toBe(1);
        }
        if (problem === "lost-reply") {
          expect(first._tag).toBe("Failure");
          yield* worker.synchronize(f.owner.threadId);
          expect(acknowledgements).toBe(1);
          expect(captures).toBe(1);
          operation = { ...operation, phase: "deleting" };
          yield* worker.synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("retired");
        } else if (problem === "aborted") {
          operation = { ...operation, phase: "aborting" };
          yield* worker.synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
          operation = { ...operation, phase: "aborted" };
          yield* worker.synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect((yield* f.native.get(f.owner.threadId, 1, f.nativeInput.turnId))?.directory).toBe(
            f.point.directory,
          );
        }
      }),
    ),
  );
}
