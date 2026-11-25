import * as NodeCrypto from "node:crypto";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmPause } from "@t3tools/contracts/relay";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  VmControlSpawner,
  VmWorkloadMaintenance,
  VmWorkloadTracking,
} from "../vmWorkloadCommand.ts";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderValidationError } from "../provider/Errors.ts";
import { initial } from "../jobs/WorkflowActions.test-fixture.ts";
import { WorkflowRun, WorkflowRunRecovery } from "../jobs/WorkflowRunStore.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import { makeThreadPauseWorker } from "./ThreadPauseWorker.ts";
import { ThreadPauseError } from "./ThreadPauseTransport.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encodeQueueFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(WorkflowRun));
const encodeRunBinding = Schema.encodeSync(Schema.fromJsonString(WorkflowRun.fields.runtime));
const encodeRecovery = Schema.encodeSync(Schema.fromJsonString(WorkflowRunRecovery));

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
  "finished-background-work",
  "finished-background-revision-unavailable",
  "finished-background-revision-changed-after-exit",
  "finished-background-revision-same-stop",
  "finished-refused-provider-stop",
  "finished-uncertain-provider-stop",
  "finished-provider-stop-rollback",
  "finished-provider-stop-rollback-wrong-seal",
  "finished-provider-stop-rollback-wrong-boot",
  "finished-provider-stop-rollback-wrong-epoch",
  "finished-restarted-provider-preparation",
  "finished-restarted-provider-rejection",
  "finished-restarted-provider-reservation",
  "finished-restarted-provider-absent",
  "finished-restarted-provider-ordinary-seal",
  "finished-warm-activation-live-rejection",
  "finished-warm-activation-live-reservation",
  "finished-warm-activation-orphan-reservation",
  "finished-warm-activation-hidden-runtime",
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
        const maintenance = yield* Semaphore.make(1);
        const finishedWorkflow = problem.startsWith("finished-");
        const providerStopRollback = problem.startsWith("finished-provider-stop-rollback");
        const restarted = problem.startsWith("finished-restarted-provider-");
        const warmActivation = problem.startsWith("finished-warm-activation-");
        const warmLive = problem.startsWith("finished-warm-activation-live-");
        const warmRejection = problem === "finished-warm-activation-live-rejection";
        const orphanedWriter = problem === "finished-warm-activation-orphan-reservation";
        const hiddenWriter = problem === "finished-warm-activation-hidden-runtime";
        const reserved =
          problem === "finished-restarted-provider-reservation" ||
          (warmActivation && !warmRejection);
        const refusable =
          problem === "finished-restarted-provider-preparation" ||
          problem === "finished-restarted-provider-rejection" ||
          warmRejection;
        const operationSeal = NodeCrypto.createHash("sha256")
          .update(operationId)
          .digest("hex")
          .slice(0, 32);
        let bootId = NodeCrypto.randomUUID();
        let epoch = 1;
        const workflowCheckpoint = {
          jobId: "job",
          checkpointId: operationId,
          checkpointGeneration: 0,
          publicationId: operationId,
          publicationRevision: 1,
          finishedWorkspaceRevision: 1,
          ...(problem.startsWith("finished-background-revision-")
            ? { backgroundRevision: "a".repeat(32) }
            : {}),
        };
        if (finishedWorkflow) {
          const base = initial();
          const capsule: WorkflowRunRecovery = {
            format: "workflow-run-recovery-v1",
            frozenConfiguration: { jobId: workflowCheckpoint.jobId, repositoryId: "repo" },
            checkpointPins: [],
            workflowIgnoreRulesBase64: null,
            run: {
              ...base,
              executionReserved: false,
              actions: [],
              runtime: {
                kind: "vm",
                jobId: workflowCheckpoint.jobId,
                organizationId: "org",
                repositoryId: "repo",
                allocationId: "allocation",
                generation: f.owner.generation,
                operationId: f.owner.operationId,
                environmentId: EnvironmentId.make(f.owner.environmentId),
                projectId: ProjectId.make(f.owner.projectId),
                threadId: ThreadId.make(f.owner.threadId),
              },
              progress: {
                ...base.progress,
                status: "done",
                threadId: ThreadId.make(f.owner.threadId),
              },
            },
          };
          yield* f.sql`INSERT INTO repository_workflow_jobs VALUES(${capsule.run.jobId},${f.owner.threadId},'done',0,${encodeRun(capsule.run)})`;
          yield* f.sql`INSERT INTO workflow_result_outbox(publication_id,job_id,thread_id,revision,binding_json,record_json,
            source_sequence,state_artifact_id,patch_artifact_id,manifest_artifact_id,status,started_at,deadline,retry_at)
            VALUES(${operationId},${capsule.run.jobId},${f.owner.threadId},1,${encodeRunBinding(capsule.run.runtime)},
            ${encodeRecovery(capsule)},0,'state','patch','manifest','acknowledged',0,1,0)`;
        }
        yield* f.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at) VALUES(${f.owner.threadId},'codex','codex','stopped','2026-10-07T00:00:00Z')`;
        const runtimeEpisode = NodeCrypto.randomUUID();
        const recordWriterDrain = (drained: boolean) =>
          encodeQueueFixture({
            providerContinuation: { runtimeEpisode, continuationKey: "provider-key" },
            stoppedRuntimeEventsDrained: drained,
          }).pipe(
            Effect.flatMap(
              (payload) => f.sql`UPDATE provider_session_runtime
              SET provider_instance_id='codex',status=${drained ? "stopped" : "running"},runtime_payload_json=${payload}
              WHERE thread_id=${f.owner.threadId}`,
            ),
            Effect.orDie,
          );
        if (orphanedWriter || hiddenWriter) yield* recordWriterDrain(false);
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
                  warmActivation ||
                  problem === "historical-cancelled"
                ? "cancelled"
                : "pending",
          canActivate:
            problem.startsWith("cancelled-before-drain") ||
            warmActivation ||
            problem === "historical-cancelled",
          sourceReopened:
            problem === "historical-cancelled" ||
            problem === "completed-reopened-before-final-save",
          ...(finishedWorkflow ? { workflowCheckpoint } : {}),
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
        let liveProvider =
          finishedWorkflow ||
          ["idle-owned-provider", "provider-with-descendant", "unconfirmed-provider-stop"].includes(
            problem,
          );
        let idleStops = 0;
        let sealedBy: string | null = null;
        let recoveryAttempts = 0;
        let runtimeReconciliations = 0;
        let cancelAttempts = 0;
        let activationAttempts = 0;
        let flushBackground = Effect.void;
        const background = ThreadBackgroundLiveness.make();
        if (problem === "finished-background-work")
          background.recordTaskLiveness({
            threadId: f.owner.threadId,
            kind: "started",
            taskId: "monitor",
            taskType: "monitor",
            status: "running",
          });
        const services = Layer.mergeAll(
          Layer.mock(ProviderService)({
            listSessions: () =>
              Effect.succeed(
                !stopped &&
                  (providerStopRollback ||
                    (warmLive && liveProvider) ||
                    problem === "finished-refused-provider-stop" ||
                    problem === "finished-uncertain-provider-stop" ||
                    problem === "finished-background-revision-same-stop")
                  ? [
                      {
                        threadId: ThreadId.make(f.owner.threadId),
                        provider: ProviderDriverKind.make("codex"),
                        runtimeMode: "approval-required",
                        status: "ready",
                        createdAt: "2026-10-07T00:00:00Z",
                        updatedAt: "2026-10-07T00:00:00Z",
                      },
                    ]
                  : [],
              ),
            stopIdleVmSession: (input) =>
              Effect.gen(function* () {
                if (!liveProvider) return false;
                if (input.recoverOnly) {
                  expect(input).toEqual({
                    threadId: f.owner.threadId,
                    environmentId: f.owner.environmentId,
                    generation: 1,
                    operationId,
                    recoverOnly: true,
                  });
                  expect((yield* f.fences.get(f.owner.threadId).pipe(Effect.orDie))?.phase).toBe(
                    "draining",
                  );
                  if (!warmLive) return false;
                  runtimeReconciliations++;
                  if (warmRejection) {
                    sealedBy = null;
                    epoch--;
                    return false;
                  }
                  if (runtimeReconciliations === 1)
                    return yield* new ProviderValidationError({
                      operation: "stopIdleVmSession",
                      issue: "The reserved provider stop is still pending",
                    });
                  liveProvider = false;
                  return true;
                }
                expect(input).toEqual({
                  threadId: f.owner.threadId,
                  environmentId: f.owner.environmentId,
                  generation: 1,
                  operationId,
                });
                expect((yield* f.fences.get(f.owner.threadId).pipe(Effect.orDie))?.phase).toBe(
                  "draining",
                );
                idleStops++;
                if (
                  (problem === "finished-uncertain-provider-stop" || providerStopRollback) &&
                  idleStops === 1
                ) {
                  sealedBy =
                    problem === "finished-provider-stop-rollback-wrong-seal"
                      ? "f".repeat(32)
                      : operationSeal;
                  epoch++;
                  return yield* new ProviderValidationError({
                    operation: "stopIdleVmSession",
                    issue: "Lost stop acknowledgement",
                  });
                }
                if (providerStopRollback) {
                  sealedBy = null;
                  // Only the original epoch is valid, even if the gate is open.
                  epoch += problem === "finished-provider-stop-rollback-wrong-epoch" ? 1 : -1;
                  if (problem === "finished-provider-stop-rollback-wrong-boot")
                    bootId = NodeCrypto.randomUUID();
                  return false;
                }
                if (
                  [
                    "provider-with-descendant",
                    "finished-refused-provider-stop",
                    "finished-uncertain-provider-stop",
                  ].includes(problem)
                )
                  return false;
                if (problem === "idle-owned-provider") liveProvider = false;
                return true;
              }),
            stopSession: () =>
              Effect.gen(function* () {
                stopped++;
                if (hiddenWriter) yield* recordWriterDrain(true);
              }),
            flushRuntimeEvents: () =>
              Effect.gen(function* () {
                flushed++;
                yield* flushBackground;
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
        let reopenedOperationId: string | undefined;
        const control = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand")
            return Effect.die("Unexpected piped control command");
          const recover = command.args[0] === "recover-idle-provider-stop";
          if (recover) {
            expect(command.args).toEqual([
              "recover-idle-provider-stop",
              operationSeal,
              bootId,
              String(epoch),
            ]);
            recoveryAttempts++;
            if (refusable && sealedBy === operationSeal) {
              sealedBy = null;
              epoch--;
            }
          }
          if (command.args[0] === "seal") sealedBy = command.args[2]!;
          if (command.args[0] === "reopen") {
            if (warmActivation) {
              expect(liveProvider).toBe(false);
              expect(recoveryAttempts).toBe(warmLive ? 1 : orphanedWriter ? 3 : 2);
              expect(flushed).toBe(1);
            }
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
                  JSON.stringify(
                    recover
                      ? {
                          status: refusable ? "rejected" : reserved ? "reserved" : "absent",
                        }
                      : {
                          bootId,
                          epoch,
                          sealedBy,
                          groups: liveProvider
                            ? [{ id: "a".repeat(32), bootId, kind: "provider", leaderPid: 2 }]
                            : problem === "live-terminal"
                              ? [{ id: "a".repeat(32), bootId, kind: "terminal", leaderPid: 2 }]
                              : [],
                          stopped: !liveProvider && problem !== "live-terminal",
                        },
                  ),
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
            cancel: (_owner, request) =>
              Effect.gen(function* () {
                cancelAttempts++;
                if (problem === "finished-restarted-provider-preparation" && cancelAttempts === 1)
                  return yield* new ThreadPauseError({
                    threadId: f.owner.threadId,
                    detail: "Relay unavailable after native rollback",
                  });
                operation = { ...operation, phase: "cancelled", canActivate: true };
                if (finishedWorkflow) {
                  expect(request.nativePauseFallback).toBeUndefined();
                  return operation;
                }
                return yield* new ThreadPauseError({
                  threadId: f.owner.threadId,
                  detail: "Lost cancellation reply",
                });
              }),
            activate: () =>
              Effect.gen(function* () {
                activationAttempts++;
                if (orphanedWriter && activationAttempts === 1)
                  return yield* new ThreadPauseError({
                    threadId: f.owner.threadId,
                    detail: "Relay unavailable after the source reopened",
                  });
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
                expect(input.bootId).toBe(bootId);
                expect(input.sealEpoch).toBe(1);
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
          f.root,
        ).pipe(
          Effect.provide(services),
          Effect.provideService(
            ThreadBackgroundLiveness.ThreadBackgroundLivenessService,
            background,
          ),
          Effect.provideService(VmWorkloadTracking, true),
          Effect.provideService(VmWorkloadMaintenance, maintenance),
          Effect.provideService(VmControlSpawner, control),
        );
        const synchronize = (threadId: string) =>
          worker
            .synchronize(threadId)
            .pipe(
              Effect.provideService(VmWorkloadTracking, true),
              Effect.provideService(VmWorkloadMaintenance, maintenance),
              Effect.provideService(VmControlSpawner, control),
            );
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
        if (problem === "finished-background-revision-changed-after-exit") {
          const writeQuietRevision = (revision: string) =>
            encodeQueueFixture({
              bootId,
              groupId: "c".repeat(32),
              coordinatorPid: 42,
              coordinatorStartTicks: "1",
              busy: false,
              revision,
            }).pipe(
              Effect.flatMap((receipt) =>
                f.fs.writeFileString(f.path.join(f.root, "workflow-vm-background.json"), receipt),
              ),
            );
          liveProvider = false;
          yield* writeQuietRevision("a".repeat(32));
          yield* f.sql`INSERT INTO thread_execution_work(thread_id,work_id,generation,kind,started,completed,relay_completed)
            VALUES(${f.owner.threadId},'workspace:finishing',1,'workspace',1,0,0)`;
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          expect(captures).toBe(0);

          // The child's final output becomes visible while draining the exited provider.
          flushBackground = writeQuietRevision("b".repeat(32)).pipe(Effect.orDie);
          yield* f.sql`UPDATE thread_execution_work SET completed=1,relay_completed=1
            WHERE thread_id=${f.owner.threadId} AND work_id='workspace:finishing'`;
          yield* synchronize(f.owner.threadId);
          expect(operation.phase).toBe("cancelled");
          yield* synchronize(f.owner.threadId);
          expect(operation.sourceReopened).toBe(true);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          return;
        }
        if (problem === "finished-background-revision-same-stop") {
          yield* f.fences.beginDrain({
            ...f.owner,
            operationId,
            previousOperationId: f.owner.operationId,
            workflowCheckpoint,
          });
          liveProvider = false;
          sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
          // The provider exited under this operation's own native stop seal.
          yield* Effect.result(synchronize(f.owner.threadId));
          expect(operation.phase).toBe("pending");
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
          expect(recoveryAttempts).toBe(0);
          expect(stopped).toBe(1);
          expect(flushed).toBe(1);
          expect(captures).toBe(1);
          expect(acknowledgements).toBe(1);
          return;
        }
        if (warmActivation) {
          yield* f.fences.beginDrain({
            ...f.owner,
            operationId,
            previousOperationId: f.owner.operationId,
            workflowCheckpoint,
          });
          sealedBy = operationSeal;
          epoch++;
          const first = yield* Effect.result(synchronize(f.owner.threadId));
          expect(first._tag).toBe(warmLive && !warmRejection ? "Failure" : "Success");
          if (!warmRejection) {
            expect(operation.sourceReopened).toBe(false);
            expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
            expect(sealedBy).toBe(operationSeal);
            expect(reopenedOperationId).toBeUndefined();
            if (!warmLive) liveProvider = false;
            if (orphanedWriter) {
              expect((yield* Effect.result(synchronize(f.owner.threadId)))._tag).toBe("Failure");
              expect(operation.sourceReopened).toBe(false);
              expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
              expect(sealedBy).toBe(operationSeal);
              expect(reopenedOperationId).toBeUndefined();
              expect(flushed).toBe(0);
              expect(activationAttempts).toBe(0);
              yield* recordWriterDrain(true);
              expect((yield* Effect.result(synchronize(f.owner.threadId)))._tag).toBe("Failure");
              expect(operation.sourceReopened).toBe(false);
              expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
            }
            yield* synchronize(f.owner.threadId);
            expect(reopenedOperationId).toBe(operationSeal);
          } else {
            expect(liveProvider).toBe(true);
            expect(reopenedOperationId).toBeUndefined();
          }
          expect(idleStops).toBe(0);
          expect(runtimeReconciliations).toBe(warmRejection ? 1 : warmLive ? 2 : 0);
          expect(stopped).toBe(warmLive ? 0 : 1);
          expect(operation.sourceReopened).toBe(true);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          if (orphanedWriter) {
            expect(activationAttempts).toBe(2);
            expect(recoveryAttempts).toBe(3);
            expect(flushed).toBe(1);
          }
          return;
        }
        if (restarted) {
          yield* f.fences.beginDrain({
            ...f.owner,
            operationId,
            previousOperationId: f.owner.operationId,
            workflowCheckpoint,
          });
          if (problem === "finished-restarted-provider-rejection") {
            sealedBy = operationSeal;
            epoch++;
          }
          if (reserved) sealedBy = operationSeal;
          if (problem === "finished-restarted-provider-ordinary-seal") {
            sealedBy = operationSeal;
            liveProvider = false;
            yield* Effect.result(synchronize(f.owner.threadId));
            expect(recoveryAttempts).toBe(1);
            expect(idleStops).toBe(0);
            expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
            expect(captures).toBe(1);
            expect(acknowledgements).toBe(1);
            return;
          }
          const first = yield* Effect.result(synchronize(f.owner.threadId));
          expect(idleStops).toBe(0);
          expect(stopped).toBe(0);
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          expect(recoveryAttempts).toBe(1);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          if (refusable) {
            expect(sealedBy).toBeNull();
            expect(epoch).toBe(1);
            if (problem === "finished-restarted-provider-preparation") {
              expect(first._tag).toBe("Failure");
              expect(operation.phase).toBe("pending");
              yield* synchronize(f.owner.threadId);
              expect(recoveryAttempts).toBe(2);
            }
            expect(operation.phase).toBe("cancelled");
            yield* synchronize(f.owner.threadId);
            expect(operation.sourceReopened).toBe(true);
            expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          } else {
            expect(first._tag).toBe("Success");
            expect(operation.phase).toBe("pending");
            expect(cancelAttempts).toBe(0);
            if (reserved) {
              liveProvider = false;
              yield* Effect.result(synchronize(f.owner.threadId));
              expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
              expect(captures).toBe(1);
              expect(acknowledgements).toBe(1);
            }
          }
          return;
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
        if (problem === "finished-uncertain-provider-stop" || providerStopRollback) {
          expect(first._tag).toBe("Failure");
          expect(operation.phase).toBe("pending");
          yield* synchronize(f.owner.threadId);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("draining");
          if (problem === "finished-provider-stop-rollback") {
            expect(operation.phase).toBe("cancelled");
            yield* synchronize(f.owner.threadId);
            expect(operation.sourceReopened).toBe(true);
            expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          } else {
            expect(operation.phase).toBe("pending");
            expect(operation.sourceReopened).toBe(false);
          }
          expect(sealedBy).toBe(
            problem === "finished-uncertain-provider-stop" ? operationSeal : null,
          );
          expect(idleStops).toBe(2);
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
          return;
        }
        if (finishedWorkflow) {
          expect(first._tag).toBe("Success");
          expect(operation.phase).toBe("cancelled");
          yield* synchronize(f.owner.threadId);
          expect(operation.sourceReopened).toBe(true);
          expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("active");
          expect(idleStops).toBe(problem === "finished-refused-provider-stop" ? 1 : 0);
          expect(captures).toBe(0);
          expect(acknowledgements).toBe(0);
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
