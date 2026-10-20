import * as NodeCrypto from "node:crypto";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmPause } from "@t3tools/contracts/relay";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VmControlSpawner, VmWorkloadTracking } from "../vmWorkloadCommand.ts";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeThreadPauseWorker } from "./ThreadPauseWorker.ts";
import { ThreadPauseError } from "./ThreadPauseTransport.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encodeQueueFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

for (const problem of [
  "historical-cancelled",
  "completed-reopened-before-final-save",
  "cancelled-before-drain",
  "cancelled-before-drain-lost-ack",
  "native-timeout-cancelled-draining",
  "native-timeout-cancelled-frozen",
  "source-changed-during-read",
  "queued-work",
  "late-queued-work",
  "archived-queue",
  "paused-queue",
  "lost-reply",
  "missing-publication",
  "unacknowledged-work",
  "stopped-provider",
  "idle-owned-provider",
  "provider-with-descendant",
  "unconfirmed-provider-stop",
  "stopped-terminal",
  "stopped-setup",
  "live-terminal",
  "wrong-generation",
  "cancelled",
] as const) {
  it.effect(`retains one executing owner during VM pause with ${problem}`, () =>
    runAttachmentCheckpointTest(
      Effect.gen(function* () {
        const f = yield* attachmentCheckpointFixture,
          operationId = NodeCrypto.randomUUID(),
          advancedOperationId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at) VALUES(${f.owner.threadId},'codex','codex','stopped','2026-10-07T00:00:00Z')`;
        yield* f.sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,completed_at,checkpoint_files_json) VALUES(${f.owner.threadId},${f.nativeInput.turnId},'completed','2026-10-07T00:00:00Z','2026-10-07T00:01:00Z','[]')`;
        let operation: RelayThreadVmPause = {
          threadId: ThreadId.make(f.owner.threadId),
          environmentId: EnvironmentId.make(f.owner.environmentId),
          generation: problem === "wrong-generation" ? 2 : 1,
          operationId,
          phase:
            problem === "completed-reopened-before-final-save"
              ? "completed"
              : problem.startsWith("cancelled-before-drain") ||
                  problem.startsWith("native-timeout-cancelled") ||
                  problem === "historical-cancelled"
                ? "cancelled"
                : "pending",
          canActivate:
            problem.startsWith("cancelled-before-drain") || problem === "historical-cancelled",
          sourceReopened:
            problem === "historical-cancelled" ||
            problem === "completed-reopened-before-final-save",
          bootId: null,
          sourceSequence: null,
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
        if (
          problem === "stopped-terminal" ||
          problem === "stopped-setup" ||
          problem === "live-terminal"
        ) {
          const kind = problem === "stopped-setup" ? "setup" : "terminal";
          yield* f.sql`INSERT INTO thread_execution_work(thread_id,work_id,generation,kind,started,completed,relay_completed)
            VALUES(${f.owner.threadId},${`${kind}:idle`},1,${kind},1,0,0)`;
        }
        let liveProvider = [
          "idle-owned-provider",
          "provider-with-descendant",
          "unconfirmed-provider-stop",
        ].includes(problem);
        let idleStops = 0;
        const services = Layer.mergeAll(
          Layer.mock(ProviderService)({
            listSessions: () => Effect.succeed([]),
            stopIdleVmSession: (input) =>
              Effect.gen(function* () {
                if (!liveProvider) return false;
                expect(input).toEqual({
                  threadId: f.owner.threadId,
                  environmentId: f.owner.environmentId,
                  generation: 1,
                  operationId,
                });
                expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
                idleStops++;
                if (problem === "provider-with-descendant") return false;
                if (problem === "idle-owned-provider") liveProvider = false;
                return true;
              }).pipe(Effect.orDie),
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
        const bootId = NodeCrypto.randomUUID();
        let sealedBy: string | null = null;
        let reopenedOperationId: string | undefined;
        const control = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand")
            return Effect.die("Unexpected piped control command");
          if (command.args[0] === "seal") sealedBy = command.args[2]!;
          if (command.args[0] === "reopen") {
            reopenedOperationId = command.args[2];
            sealedBy = null;
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stderr: Stream.empty,
              all: Stream.empty,
              stdout: Stream.encodeText(
                Stream.make(
                  JSON.stringify({
                    bootId,
                    epoch: 1,
                    sealedBy,
                    groups: liveProvider
                      ? [{ id: "a".repeat(32), bootId, kind: "provider", leaderPid: 2 }]
                      : problem === "live-terminal"
                        ? [{ id: "a".repeat(32), bootId, kind: "terminal", leaderPid: 2 }]
                        : [],
                    stopped: !liveProvider && problem !== "live-terminal",
                  }),
                ),
              ),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const worker = yield* makeThreadPauseWorker(
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
                operation = { ...operation, phase: "cancelled", canActivate: true };
                return yield* new ThreadPauseError({
                  threadId: f.owner.threadId,
                  detail: "Lost cancellation reply",
                });
              }),
            activate: () =>
              Effect.gen(function* () {
                operation = { ...operation, sourceReopened: true };
                if (problem === "lost-reply" || problem === "cancelled-before-drain-lost-ack")
                  return yield* new ThreadPauseError({
                    threadId: f.owner.threadId,
                    detail: "Lost activation receipt",
                  });
                return operation;
              }),
            freeze: (_owner, input) =>
              Effect.gen(function* () {
                acknowledgements++;
                operation = {
                  ...operation,
                  phase: "pending",
                  bootId: input.bootId,
                  nativeCheckpointOperationId: input.nativeCheckpointOperationId,
                };
                return yield* new ThreadPauseError({
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
        ).pipe(
          Effect.provide(services),
          Effect.provideService(VmWorkloadTracking, true),
          Effect.provideService(VmControlSpawner, control),
        );
        const synchronize = (threadId: string) =>
          worker.synchronize(threadId).pipe(Effect.provideService(VmControlSpawner, control));
        if (problem === "completed-reopened-before-final-save") {
          const before = (yield* f.fences.get(f.owner.threadId))!;
          yield* f.fences.beginDrain({
            ...f.owner,
            operationId,
            previousOperationId: before.operationId,
          });
          yield* f.fences.activate({ ...f.owner, operationId });
        }
        if (problem.startsWith("native-timeout-cancelled")) {
          const before = (yield* f.fences.get(f.owner.threadId))!;
          yield* f.fences.beginDrain({
            ...f.owner,
            operationId,
            previousOperationId: before.operationId,
          });
          if (problem === "native-timeout-cancelled-frozen")
            yield* f.fences.freeze({ ...f.owner, operationId });
          sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
        }
        const first = yield* Effect.result(synchronize(f.owner.threadId));
        if (problem.startsWith("native-timeout-cancelled")) {
          expect(first._tag).toBe("Success");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe(
            problem === "native-timeout-cancelled-frozen" ? "frozen" : "draining",
          );
          expect(operation.sourceReopened).toBe(false);
          expect(sealedBy).not.toBeNull();
          // Only positive power/resume readiness permits the existing cancelled
          // pause protocol to reopen its exact local drain and acknowledge it.
          operation = { ...operation, canActivate: true };
          yield* synchronize(f.owner.threadId);
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "active",
            operationId,
          });
          expect(operation.sourceReopened).toBe(true);
          expect(reopenedOperationId).toBe(
            NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32),
          );
          expect(sealedBy).toBeNull();
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          return;
        }
        if (problem === "completed-reopened-before-final-save") {
          expect(first._tag).toBe("Success");
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "active",
            operationId,
          });
          expect(captures).toBe(0);
          expect(closed).toBe(0);
          expect(acknowledgements).toBe(0);
          const later = { ...f.owner, operationId: advancedOperationId };
          yield* f.fences.beginDrain({ ...later, previousOperationId: operationId });
          yield* synchronize(f.owner.threadId);
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "draining",
            operationId: advancedOperationId,
          });
          return;
        }
        if (problem === "historical-cancelled") {
          expect(first._tag).toBe("Success");
          const owner = (yield* f.fences.get(f.owner.threadId))!;
          expect(owner.phase).toBe("active");
          expect(owner.operationId).not.toBe(operationId);
          expect(captures).toBe(0);
          expect(closed).toBe(0);
          return;
        }
        if (problem.startsWith("cancelled-before-drain")) {
          expect(first._tag).toBe(problem === "cancelled-before-drain" ? "Success" : "Failure");
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "active",
            operationId,
          });
          expect(operation.sourceReopened).toBe(true);
          expect(captures).toBe(0);
          expect(closed).toBe(0);
          // Even a delayed pre-cancellation relay read cannot reinstall this drain.
          operation = { ...operation, phase: "pending", canActivate: false, sourceReopened: false };
          expect((yield* Effect.result(synchronize(f.owner.threadId)))._tag).toBe("Failure");
          expect(yield* f.fences.get(f.owner.threadId)).toMatchObject({
            phase: "active",
            operationId,
          });
          expect(captures).toBe(0);
          return;
        }
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
          expect(operation.phase).toBe("cancelled");
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(operation.sourceReopened).toBe(true);
          expect(sealedBy).toBeNull();
          return;
        }
        if (["provider-with-descendant", "unconfirmed-provider-stop"].includes(problem)) {
          expect(idleStops).toBe(1);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          expect(captures).toBe(0);
          expect(flushed).toBe(0);
          expect(acknowledgements).toBe(0);
          return;
        }
        if (problem === "idle-owned-provider") {
          expect(idleStops).toBe(1);
          expect(captures).toBe(1);
          expect(flushed).toBe(1);
          expect(acknowledgements).toBe(1);
        }
        expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe(
          ["unacknowledged-work", "live-terminal"].includes(problem) ? "draining" : "frozen",
        );
        if (problem === "unacknowledged-work" || problem === "live-terminal") {
          expect(flushed).toBe(0);
          expect(captures).toBe(0);
          expect(closed).toBe(0);
        }
        if (problem === "stopped-terminal" || problem === "stopped-setup") {
          expect(captures).toBe(1);
          expect(
            yield* f.sql`SELECT completed,relay_completed AS acknowledged FROM thread_execution_work
            WHERE thread_id=${f.owner.threadId}`,
          ).toEqual([{ completed: 1, acknowledged: 1 }]);
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
          yield* synchronize(f.owner.threadId);
          expect(acknowledgements).toBe(1);
          expect(captures).toBe(1);
          operation = { ...operation, phase: "completed" };
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
          operation = { ...operation, canActivate: true };
          expect((yield* Effect.result(synchronize(f.owner.threadId)))._tag).toBe("Failure");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(sealedBy).toBeNull();
          yield* synchronize(f.owner.threadId);
          const later = { ...f.owner, operationId: NodeCrypto.randomUUID() };
          yield* f.fences.beginDrain({ ...later, previousOperationId: operationId });
          yield* f.fences.freeze(later);
          operation = { ...operation, canActivate: false };
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.operationId).toBe(later.operationId);
        } else if (problem === "cancelled") {
          operation = { ...operation, phase: "cancelled" };
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
          operation = { ...operation, phase: "cancelled", canActivate: true };
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect((yield* f.native.get(f.owner.threadId, 1, f.nativeInput.turnId))?.directory).toBe(
            f.point.directory,
          );
        }
      }),
    ),
  );
}
