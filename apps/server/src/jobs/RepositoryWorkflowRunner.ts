import { TerminalManager } from "../terminal/Manager.ts";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  isTerminalWorkflowJob,
  type WorkflowControl,
  type WorkflowControlResult,
} from "@t3tools/contracts/workflows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SetupProcessJournal } from "../terminal/SetupProcessJournal.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { forkParked } from "../serverActivation.ts";
import { workflowTask } from "./workflowTask.ts";
import { attachApprovalSupervisor, type SupervisorVerdict } from "./supervisor.ts";
import { WorkflowRunStore, WorkflowRun } from "./WorkflowRunStore.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { jobBranchName } from "./Layers/JobRunner.ts";

export interface WorkflowRequest {
  readonly jobId: string;
  readonly userId: string;
  readonly repositoryCanonicalKey: string;
  readonly instruction: string;
  readonly control: WorkflowControl;
}
export class WorkflowRunnerError extends Schema.TaggedError<WorkflowRunnerError>()(
  "WorkflowRunnerError",
  { message: Schema.String },
) {}
export interface RepositoryWorkflowRunnerShape {
  readonly handle: (
    request: WorkflowRequest,
  ) => Effect.Effect<WorkflowControlResult, WorkflowRunnerError>;
}
export class RepositoryWorkflowRunner extends Context.Reference<RepositoryWorkflowRunnerShape>(
  "t3/jobs/RepositoryWorkflowRunner",
  {
    defaultValue: () => ({
      handle: () =>
        Effect.succeed({
          protocol: 4,
          outcome: "unavailable",
          detail: "Workflow execution is unavailable on this environment.",
          progress: null,
        }),
    }),
  },
) {}

/** Read durable admission, completion and checkpoint evidence; session idle alone is insufficient. */
export function reconcileWorkflowRun(
  run: WorkflowRun,
  thread: OrchestrationThread | null,
  cleanupConfirmed = false,
): WorkflowRun {
  if (isTerminalWorkflowJob(run.progress.status) || thread === null) return run;
  const preparation = thread.promptQueue?.preparation;
  const worktreePath = thread.worktreePath ?? run.worktreePath;
  const withProgress = (
    status: WorkflowRun["progress"]["status"],
    detail: string | null,
    checkpoint = run.progress.checkpoint,
  ): WorkflowRun => ({
    ...run,
    worktreePath,
    executionReserved:
      status === "awaiting_review" || isTerminalWorkflowJob(status) ? false : run.executionReserved,
    ...(status === "cancelled" ? { cancellationAttempt: null, pendingQueueDismissal: null } : {}),
    progress: {
      ...run.progress,
      revision: run.progress.revision + 1,
      status,
      detail,
      checkpoint,
      ...(status === "cancelled" ? { retryableCancellation: false } : {}),
    },
  });
  if (run.progress.status === "cancelling") {
    // 'stopped' is emitted only after the provider stop returns. Preparation
    // also has to acknowledge that its script/process has actually exited.
    if (
      (thread.session === null || thread.session.status === "stopped") &&
      (!preparation ||
        (preparation.settled &&
          preparation.state !== "pending" &&
          preparation.state !== "running")) &&
      (!preparation?.script || cleanupConfirmed) &&
      thread.promptQueue?.handoff == null &&
      thread.promptQueue?.awaitingTurnId == null
    )
      return withProgress("cancelled", "Cancelled; prepared files and history have been retained.");
    return run;
  }
  if (run.progress.status === "awaiting_review") return { ...run, worktreePath };
  const admission = thread.promptQueue?.admissions.find(
    (entry) => entry.messageId === `workflow:${run.jobId}:prompt`,
  );
  const unknown = thread.promptQueue?.pauseReason?.code === "delivery-unknown";
  if (
    !admission &&
    unknown &&
    (thread.promptQueue?.handoff?.messageId === `workflow:${run.jobId}:prompt` ||
      thread.promptQueue.entries.some(
        (entry) => entry.messageId === `workflow:${run.jobId}:prompt` && entry.state === "unknown",
      ))
  ) {
    const detail = "Prompt delivery could not be confirmed. Cancel this job before starting again.";
    return run.progress.status === "paused" &&
      run.progress.detail === detail &&
      !run.progress.retryablePreparation
      ? { ...run, worktreePath }
      : {
          ...withProgress("paused", detail),
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            status: "paused",
            detail,
            retryablePreparation: false,
          },
        };
  }
  if (run.progress.status === "paused") {
    const retryablePreparation = !unknown && preparation?.state === "failed" && preparation.settled;
    return retryablePreparation === (run.progress.retryablePreparation ?? false)
      ? { ...run, worktreePath }
      : {
          ...run,
          worktreePath,
          progress: { ...run.progress, revision: run.progress.revision + 1, retryablePreparation },
        };
  }
  if (preparation?.state === "failed") {
    const paused = withProgress(
      "paused",
      preparation.failure?.detail ?? "Preparation failed. Retry preparation to continue.",
    );
    return {
      ...paused,
      progress: { ...paused.progress, retryablePreparation: !unknown && preparation.settled },
    };
  }
  if (!admission) return worktreePath === run.worktreePath ? run : { ...run, worktreePath };
  const turn = thread.latestTurn;
  if (turn?.turnId !== admission.turnId)
    return withProgress(
      "paused",
      "The admitted turn could not be reconciled. Cancel this job before starting again.",
    );
  if (turn.state === "interrupted" || turn.state === "error")
    return withProgress(
      "paused",
      "The agent turn stopped without a complete result. Cancel this job before starting again.",
    );
  if (
    turn.state === "running" &&
    thread.session &&
    ["stopped", "error", "interrupted"].includes(thread.session.status)
  )
    return withProgress(
      "paused",
      "The admitted turn could not be reattached after stopping. Cancel this job before starting again.",
    );
  const checkpoint = thread.checkpoints.find((entry) => entry.turnId === admission.turnId);
  if (
    turn.state === "completed" &&
    thread.promptQueue?.finalizedTurnId === admission.turnId &&
    checkpoint
  ) {
    if (checkpoint.status !== "ready")
      return withProgress(
        "paused",
        "The result checkpoint could not be saved. Cancel this job before starting again.",
      );
    return withProgress("awaiting_review", null, {
      checkpointId: `${run.jobId}:${admission.turnId}:${checkpoint.checkpointRef}`,
      turnId: admission.turnId,
      checkpointRef: checkpoint.checkpointRef,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
    });
  }
  return run.progress.status === "running"
    ? { ...run, worktreePath }
    : withProgress("running", null);
}

const isApprovalRequestId = Schema.is(Schema.Struct({ requestId: Schema.String }));
const isRecordedVerdict = Schema.is(
  Schema.Struct({
    requestId: Schema.String,
    verdict: Schema.Literals(["approve", "deny", "escalate"]),
  }),
);
const equivalentRuns = Schema.toEquivalence(WorkflowRun);
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);

export const make = Effect.gen(function* () {
  const persistence = yield* WorkflowRunStore;
  const journal = yield* SetupProcessJournal;
  const terminal = yield* TerminalManager;
  const runnerScope = yield* Scope.Scope;
  const cleanupWorkers = new Set<string>();
  const engine = yield* OrchestrationEngineService;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const query = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const checkpoints = yield* CheckpointStore;
  const identities = yield* RepositoryIdentityResolver;
  const access = yield* RepositoryAccess;
  const registry = yield* ProviderRegistry;
  const textGeneration = yield* TextGeneration;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const recovered = yield* Deferred.make<void>();
  const supervised = new Map<string, Scope.Closeable>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(supervised.values(), (scope) => Scope.close(scope, Exit.void), {
      discard: true,
    }),
  );
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const store = {
    ...persistence,
    save: Effect.fn("RepositoryWorkflowRunner.save")(function* (run: WorkflowRun) {
      const previous = yield* persistence.get(run.jobId);
      yield* persistence.save(run);
      if (
        previous &&
        (previous.progress.status !== run.progress.status ||
          (!previous.promptDispatched && run.promptDispatched)) &&
        run.promptDispatched &&
        Option.isSome(yield* query.getThreadDetailById(run.progress.threadId).pipe(Effect.orDie))
      ) {
        const createdAt = yield* timestamp;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`workflow:${run.jobId}:progress:${run.progress.revision}`),
          threadId: run.progress.threadId,
          createdAt,
          activity: {
            id: EventId.make(`workflow:${run.jobId}:progress:${run.progress.revision}`),
            kind: "workflow.progress",
            tone: "info",
            summary: `Workflow ${run.progress.status.replaceAll("_", " ")}`,
            payload: {
              jobId: run.jobId,
              repositoryId: run.workflow.repositoryId,
              status: run.progress.status,
            },
            turnId: null,
            createdAt,
          },
        });
      }
      return run;
    }),
  };
  const result = (
    run: WorkflowRun | null,
    outcome: WorkflowControlResult["outcome"] = run ? "accepted" : "missing",
    detail: string | null = null,
  ): WorkflowControlResult => ({ protocol: 4, outcome, detail, progress: run?.progress ?? null });
  const readThread = (run: WorkflowRun) =>
    query
      .getThreadDetailById(run.progress.threadId)
      .pipe(Effect.orDie, Effect.map(Option.getOrNull));
  const supervise = Effect.fn("RepositoryWorkflowRunner.supervise")(function* (run: WorkflowRun) {
    if (supervised.has(run.jobId)) return;
    const scope = yield* Scope.make();
    yield* Effect.gen(function* () {
      // Acquire live events before the recovery watermark and snapshot. Events
      // arriving during replay are queued; settled requests are already seeded.
      const liveEvents = yield* engine.subscribeDomainEvents;
      const through = yield* engine.latestSequence;
      const thread = yield* query
        .getThreadDetailById(run.progress.threadId)
        .pipe(Effect.orDie, Effect.map(Option.getOrNull));
      const resolvedRequestIds = new Set<string>();
      const recordedVerdicts = new Map<string, SupervisorVerdict>();
      for (const activity of thread?.activities ?? []) {
        if (activity.kind === "approval.resolved" && isApprovalRequestId(activity.payload))
          resolvedRequestIds.add(activity.payload.requestId);
        if (activity.kind === "job.supervisor.verdict" && isRecordedVerdict(activity.payload))
          recordedVerdicts.set(activity.payload.requestId, activity.payload.verdict);
      }
      yield* attachApprovalSupervisor({
        engine,
        textGeneration,
        crypto,
        threadId: run.progress.threadId,
        ...workflowTask(run),
        cwd: "",
        resolveCwd: readThread(run).pipe(
          Effect.map((current) =>
            current?.projectId === run.workflow.definition.projectId ? current.worktreePath : null,
          ),
        ),
        modelSelection: run.modelSelection,
        resolvedRequestIds,
        recordedVerdicts,
        liveEvents,
        replayEvents: engine
          .readThreadEvents({
            threadId: run.progress.threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: through,
          })
          .pipe(Stream.orDie),
      });
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    supervised.set(run.jobId, scope);
  });
  const dispatchPrompt = Effect.fn("RepositoryWorkflowRunner.dispatchPrompt")(function* (
    run: WorkflowRun,
  ) {
    const project = yield* query
      .getProjectShellById(run.workflow.definition.projectId)
      .pipe(Effect.orDie);
    if (Option.isNone(project))
      return yield* new WorkflowRunnerError({ message: "The selected project no longer exists." });
    yield* supervise(run);
    const task = workflowTask(run);
    yield* engine
      .dispatch({
        type: "thread.prompt.enqueue",
        commandId: CommandId.make(`workflow:${run.jobId}:start`),
        threadId: run.progress.threadId,
        message: {
          messageId: MessageId.make(`workflow:${run.jobId}:prompt`),
          text: `${task.stepInstruction}\n\nJob context:\n${task.jobContext}\n\n${task.reviewConstraint}`,
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        modelSelection: run.modelSelection,
        createdAt: run.createdAt,
        author: { userId: run.userId, displayName: null, imageUrl: null },
        bootstrap: {
          createThread: {
            projectId: project.value.id,
            title: `${run.workflow.definition.name}: ${run.workflow.definition.steps[0].title}`,
            modelSelection: run.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: run.createdAt,
          },
          prepareWorktree: {
            projectCwd: project.value.workspaceRoot,
            baseBranch: run.baseSha,
            branch: jobBranchName(run.jobId),
            startFromOrigin: false,
            requireWorktree: true,
          },
          runSetupScript: true,
        },
      })
      .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
    return yield* store.save({ ...run, promptDispatched: true });
  });
  const verifyResult = Effect.fn("RepositoryWorkflowRunner.verifyResult")(function* (
    run: WorkflowRun,
  ) {
    if (!run.worktreePath || !run.progress.checkpoint)
      return "The saved result is unavailable. Cancel the job and run it again.";
    if (
      (yield* git.resolveCommit({ cwd: run.worktreePath, revision: "HEAD" })).commitSha !==
        run.preparedHead ||
      (yield* git.statusDetailsLocal(run.worktreePath)).branch !== jobBranchName(run.jobId)
    )
      return "The prepared branch changed after this review was created. Cancel the job and run it again.";
    const verificationRef = CheckpointRef.make(`refs/t3/workflow-verification/${run.jobId}`);
    yield* checkpoints.captureCheckpoint({ cwd: run.worktreePath, checkpointRef: verificationRef });
    const difference = yield* checkpoints
      .diffCheckpoints({
        cwd: run.worktreePath,
        fromCheckpointRef: CheckpointRef.make(run.progress.checkpoint.checkpointRef),
        toCheckpointRef: verificationRef,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.ensuring(
          checkpoints
            .deleteCheckpointRefs({
              cwd: run.worktreePath,
              checkpointRefs: [verificationRef],
            })
            .pipe(Effect.ignoreCause({ log: true })),
        ),
      );
    return difference.length > 0
      ? "Prepared files changed after this review was created. Cancel the job and run it again."
      : null;
  });
  const startCleanup = (
    run: WorkflowRun,
    kind: "approvalAttempt" | "cancellationAttempt",
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const attempt = run[kind];
      const cleanup = attempt?.setupCleanup;
      if (!attempt || cleanup?.state !== "pending" || cleanupWorkers.has(attempt.commandId)) return;
      cleanupWorkers.add(attempt.commandId);
      yield* journal
        .cleanup({
          threadId: run.progress.threadId,
          attemptId: cleanup.attemptId,
          commandId: attempt.commandId,
        })
        .pipe(
          Effect.flatMap((receipt) =>
            terminal.closeOwned({
              threadId: receipt.threadId,
              terminalId: receipt.terminalId,
              receipt,
            }),
          ),
          Effect.result,
          Effect.flatMap((outcome) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* store.get(run.jobId);
                const saved = current?.[kind];
                if (
                  !current ||
                  saved?.commandId !== attempt.commandId ||
                  (kind === "approvalAttempt"
                    ? current.progress.status !== "awaiting_review"
                    : current.progress.status !== "cancelling")
                )
                  return;
                const detail = outcome._tag === "Failure" ? outcome.failure.message : null;
                const next = yield* store.save({
                  ...current,
                  [kind]: {
                    ...saved,
                    setupCleanup: { ...cleanup, state: detail ? "failed" : "done", detail },
                  },
                  progress: {
                    ...current.progress,
                    revision: current.progress.revision + 1,
                    ...(kind === "approvalAttempt"
                      ? {
                          approvalPending: !detail,
                          retryableApproval: !!detail,
                          detail: detail
                            ? `Approval cleanup failed. ${detail} Retry approval to stop the remaining setup.`
                            : "Setup stopped; verifying the approved result.",
                        }
                      : {}),
                  },
                });
                yield* reconcile(next);
              }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => cleanupWorkers.delete(attempt.commandId))),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(runnerScope),
          Effect.asVoid,
        );
    });
  const settleApprovedPreparation = Effect.fn("RepositoryWorkflowRunner.settleApprovedPreparation")(
    function* (run: WorkflowRun) {
      const attempt = run.approvalAttempt!;
      const cleanup = attempt.setupCleanup;
      if (!cleanup) return null;
      for (let retry = 0; retry < 8; retry++) {
        const thread = yield* readThread(run);
        const preparation = thread?.promptQueue?.preparation;
        if (
          !thread ||
          thread.projectId !== run.workflow.definition.projectId ||
          thread.worktreePath !== run.worktreePath ||
          !preparation ||
          preparation.attemptId !== cleanup.attemptId ||
          preparation.target?.worktreePath !== run.worktreePath ||
          !["ready", "failed"].includes(preparation.state)
        )
          return "The original preparation changed or is unavailable. Cancel the job and run it again.";
        if (preparation.settled) return null;
        const updated = yield* engine
          .dispatch({
            type: "thread.preparation.update",
            threadId: run.progress.threadId,
            commandId: CommandId.make(
              `${attempt.commandId}:settle:${cleanup.attemptId}:${preparation.revision}`,
            ),
            expectedRevision: preparation.revision,
            createdAt: yield* timestamp,
            preparation: {
              ...preparation,
              revision: preparation.revision + 1,
              settled: true,
              ...(preparation.failure?.detail.includes("Setup could not be stopped")
                ? {
                    failure: {
                      ...preparation.failure,
                      detail: "Setup stopped; preparation did not complete.",
                    },
                  }
                : {}),
            },
          })
          .pipe(Effect.result);
        const projected = yield* readThread(run);
        const current = projected?.promptQueue?.preparation;
        if (updated._tag === "Failure") {
          if (
            isOrchestrationCommandRejection(updated.failure) &&
            current?.attemptId === cleanup.attemptId &&
            current.revision !== preparation.revision
          )
            continue;
          return yield* updated.failure;
        }
        if (
          projected?.projectId !== run.workflow.definition.projectId ||
          projected.worktreePath !== run.worktreePath ||
          current?.attemptId !== cleanup.attemptId ||
          current.target?.worktreePath !== run.worktreePath
        )
          return "The original preparation changed or is unavailable. Cancel the job and run it again.";
        if (current.settled && ["ready", "failed"].includes(current.state)) return null;
        return yield* new WorkflowRunnerError({
          message: "Preparation settlement could not be confirmed.",
        });
      }
      return yield* new WorkflowRunnerError({
        message: "Preparation changed repeatedly while approval was settling.",
      });
    },
  );
  const reconcileApproval = Effect.fn("RepositoryWorkflowRunner.reconcileApproval")(
    function* (run: WorkflowRun) {
      const attempt = run.approvalAttempt;
      if (run.progress.status !== "awaiting_review" || !attempt || run.progress.retryableApproval)
        return run;
      if (attempt.setupCleanup?.state === "failed") return run;
      if (
        attempt.setupCleanup &&
        !(yield* journal.confirmed({
          threadId: run.progress.threadId,
          attemptId: attempt.setupCleanup.attemptId,
        }))
      ) {
        if (attempt.setupCleanup.state !== "pending")
          run = yield* store.save({
            ...run,
            approvalAttempt: {
              ...attempt,
              setupCleanup: { ...attempt.setupCleanup, state: "pending", detail: null },
            },
          });
        yield* startCleanup(run, "approvalAttempt");
        return run;
      }
      const settlement = yield* settleApprovedPreparation(run);
      const detail =
        settlement ??
        (attempt.checkpointId !== run.progress.checkpoint?.checkpointId ||
        attempt.preparedHead !== run.preparedHead
          ? "The saved review changed. Cancel the job and run it again."
          : yield* verifyResult(run));
      return yield* store.save({
        ...run,
        approvalAttempt: null,
        approvedBy: detail ? run.approvedBy : attempt.approvedBy,
        executionReserved: false,
        progress: {
          ...run.progress,
          revision: run.progress.revision + 1,
          status: detail ? "awaiting_review" : "done",
          approvalPending: false,
          retryableApproval: false,
          detail: detail ?? "Approved by a repository maintainer.",
        },
      });
    },
    (effect, run) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* store.get(run.jobId);
            if (
              !current ||
              current.progress.status !== "awaiting_review" ||
              current.approvalAttempt?.commandId !== run.approvalAttempt?.commandId
            )
              return current ?? run;
            // A failed settlement/save is a durable Retry approval outcome. Proof and original approver survive.
            return yield* store.save({
              ...current,
              progress: {
                ...current.progress,
                revision: current.progress.revision + 1,
                approvalPending: false,
                retryableApproval: true,
                detail: `Setup cleanup is retained. Approval could not finish: ${Cause.pretty(cause)} Retry approval.`,
              },
            });
          }),
        ),
      ),
  );
  const stopFailure = Schema.decodeUnknownOption(
    Schema.Struct({ stopCommandId: Schema.String, detail: Schema.String }),
  );
  const cancellationProgress = (run: WorkflowRun, detail: string, retryable: boolean) =>
    run.progress.detail === detail && (run.progress.retryableCancellation ?? false) === retryable
      ? Effect.succeed(run)
      : store.save({
          ...run,
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            detail,
            retryableCancellation: retryable,
          },
        });
  const reconcileCancellation = Effect.fn("RepositoryWorkflowRunner.reconcileCancellation")(
    function* (run: WorkflowRun, recovering: boolean) {
      if (!run.cancellationAttempt)
        run = yield* store.save({
          ...run,
          cancellationAttempt: {
            commandId: `workflow:${run.jobId}:cancel`,
            createdAt: run.createdAt,
          },
        });
      const attempt = run.cancellationAttempt!;
      let thread = yield* readThread(run);
      if (!thread) return run;
      const receipt = recovering
        ? yield* commandReceipts
            .getByCommandId({ commandId: CommandId.make(attempt.commandId) })
            .pipe(Effect.orDie)
        : Option.none();
      const preparation = thread.promptQueue?.preparation;
      const stopped =
        (thread.session === null || thread.session.status === "stopped") &&
        (!preparation ||
          (preparation.settled && !["pending", "running"].includes(preparation.state)));
      if (recovering && Option.isSome(receipt) && !stopped)
        return yield* cancellationProgress(
          run,
          "Cancellation was interrupted by a restart. Retry cancellation to confirm agent and setup stopping.",
          true,
        );
      if (!run.progress.retryableCancellation) {
        const acknowledgement = yield* engine
          .dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(attempt.commandId),
            threadId: run.progress.threadId,
            createdAt: attempt.createdAt,
          })
          .pipe(Effect.result);
        if (acknowledgement._tag === "Failure") {
          if (
            !isOrchestrationCommandRejection(acknowledgement.failure) &&
            !isPreviouslyRejected(acknowledgement.failure)
          )
            return yield* acknowledgement.failure;
          return yield* cancellationProgress(run, acknowledgement.failure.message, true);
        }
      }
      thread = (yield* readThread(run))!;
      const failures = thread.activities.flatMap((activity) => {
        if (!["provider.session.stop.failed", "preparation.stop.failed"].includes(activity.kind))
          return [];
        const failure = stopFailure(activity.payload);
        return Option.isSome(failure) && failure.value.stopCommandId === attempt.commandId
          ? [{ kind: activity.kind, detail: failure.value.detail }]
          : [];
      });
      const providerStopped = thread.session === null || thread.session.status === "stopped";
      const currentPreparation = thread.promptQueue?.preparation;
      if (currentPreparation?.script && !run.cancellationAttempt?.setupCleanup)
        run = yield* store.save({
          ...run,
          cancellationAttempt: {
            ...attempt,
            setupCleanup: {
              attemptId: currentPreparation.attemptId,
              state: "pending",
              detail: null,
            },
          },
        });
      if (
        run.cancellationAttempt?.setupCleanup?.state === "done" &&
        !(yield* journal.confirmed({
          threadId: run.progress.threadId,
          attemptId: run.cancellationAttempt.setupCleanup.attemptId,
        }))
      ) {
        run = yield* store.save({
          ...run,
          cancellationAttempt: {
            ...run.cancellationAttempt,
            setupCleanup: {
              ...run.cancellationAttempt.setupCleanup,
              state: "pending",
              detail: null,
            },
          },
        });
      }
      yield* startCleanup(run, "cancellationAttempt");
      const cleanup = run.cancellationAttempt?.setupCleanup;
      const setupStopped =
        (!currentPreparation ||
          (currentPreparation.settled &&
            !["pending", "running"].includes(currentPreparation.state))) &&
        (!currentPreparation?.script ||
          (cleanup?.state === "done" &&
            (yield* journal.confirmed({
              threadId: run.progress.threadId,
              attemptId: cleanup.attemptId,
            }))));
      const providerFailed = failures.some(
        (failure) => failure.kind === "provider.session.stop.failed",
      );
      const setupFailed =
        cleanup?.state === "failed" ||
        failures.some((failure) => failure.kind === "preparation.stop.failed");
      if (
        !(providerStopped && setupStopped) &&
        (providerFailed || setupFailed) &&
        (providerStopped || providerFailed) &&
        (setupStopped || setupFailed)
      )
        return yield* cancellationProgress(
          run,
          `${[...failures.map((failure) => failure.detail), ...(cleanup?.detail ? [cleanup.detail] : [])].join(" ")} Retry cancellation to stop the remaining work.`,
          true,
        );
      if (providerStopped && setupStopped) {
        const queue = thread.promptQueue;
        if (
          !run.pendingQueueDismissal &&
          !run.progress.retryableCancellation &&
          queue?.pauseReason?.code === "delivery-unknown"
        )
          run = yield* store.save({
            ...run,
            pendingQueueDismissal: {
              commandId: `${attempt.commandId}:dismiss:${queue.revision}`,
              expectedRevision: queue.revision,
              createdAt: yield* timestamp,
            },
          });
        const dismissal = run.pendingQueueDismissal;
        if (dismissal) {
          const acknowledgement = yield* engine
            .dispatch({
              type: "thread.queue.resolve",
              commandId: CommandId.make(dismissal.commandId),
              threadId: run.progress.threadId,
              expectedRevision: dismissal.expectedRevision,
              resolution: "dismiss",
              createdAt: dismissal.createdAt,
            })
            .pipe(Effect.result);
          if (acknowledgement._tag === "Failure") {
            if (
              !isOrchestrationCommandRejection(acknowledgement.failure) &&
              !isPreviouslyRejected(acknowledgement.failure)
            )
              return yield* acknowledgement.failure;
            run = yield* store.save({ ...run, pendingQueueDismissal: null });
            const current = (yield* readThread(run))?.promptQueue;
            if (current?.handoff || current?.awaitingTurnId)
              return yield* cancellationProgress(
                run,
                current.revision === dismissal.expectedRevision
                  ? "Delivery recovery was rejected. Retry cancellation to dismiss the remaining delivery."
                  : "Delivery recovery changed. Rechecking the remaining delivery.",
                current.revision === dismissal.expectedRevision,
              );
          } else run = yield* store.save({ ...run, pendingQueueDismissal: null });
        }
      }
      return run;
    },
  );
  const reconcile = Effect.fn("RepositoryWorkflowRunner.reconcile")(function* (
    run: WorkflowRun,
    recovering = false,
  ) {
    let retry = run.pendingPreparationRetry;
    if (retry && (yield* readThread(run))?.promptQueue?.pauseReason?.code === "delivery-unknown") {
      run = yield* store.save({ ...run, pendingPreparationRetry: null });
      retry = null;
    }
    if (
      retry &&
      !isTerminalWorkflowJob(run.progress.status) &&
      run.progress.status !== "cancelling"
    ) {
      const acknowledgement = yield* engine
        .dispatch({
          type: "thread.preparation.retry",
          commandId: CommandId.make(retry.commandId),
          threadId: run.progress.threadId,
          expectedRevision: retry.expectedRevision,
          expectedControlRevision: retry.expectedControlRevision,
          createdAt: retry.createdAt,
        })
        .pipe(Effect.result);
      if (acknowledgement._tag === "Failure") {
        const error = acknowledgement.failure;
        if (!isOrchestrationCommandRejection(error) && !isPreviouslyRejected(error))
          return yield* error;
        const preparation = (yield* readThread(run))?.promptQueue?.preparation;
        run = yield* store.save({
          ...run,
          pendingPreparationRetry: null,
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            status: "paused",
            detail: error.message,
            retryablePreparation: preparation?.state === "failed" && preparation.settled,
          },
        });
      } else {
        // Receipt replay is safe even if setup finished before acknowledgement.
        // Clear only after acceptance, then read fresh preparation/turn evidence.
        run = yield* store.save({ ...run, pendingPreparationRetry: null });
      }
    }
    if (run.progress.status === "cancelling") run = yield* reconcileCancellation(run, recovering);
    const thread = yield* readThread(run);
    if (
      run.progress.status === "cancelling" &&
      thread === null &&
      !run.cancellationAttempt?.setupCleanup
    )
      return yield* store.save({
        ...run,
        executionReserved: false,
        pendingPreparationRetry: null,
        cancellationAttempt: null,
        pendingQueueDismissal: null,
        progress: {
          ...run.progress,
          revision: run.progress.revision + 1,
          status: "cancelled",
          detail: "Cancelled before the agent started.",
          retryableCancellation: false,
        },
      });
    if (run.progress.status === "awaiting_review" && run.approvalAttempt)
      run = yield* reconcileApproval(run);
    const cleanupConfirmed =
      run.cancellationAttempt?.setupCleanup?.state === "done"
        ? yield* journal.confirmed({
            threadId: run.progress.threadId,
            attemptId: run.cancellationAttempt.setupCleanup.attemptId,
          })
        : false;
    let next = reconcileWorkflowRun(run, thread, cleanupConfirmed);
    if (
      run.progress.status !== "awaiting_review" &&
      next.progress.status === "awaiting_review" &&
      next.worktreePath !== null
    ) {
      const head = yield* git.resolveCommit({ cwd: next.worktreePath, revision: "HEAD" });
      const status = yield* git.statusDetailsLocal(next.worktreePath);
      next =
        status.branch === jobBranchName(next.jobId)
          ? { ...next, preparedHead: head.commitSha }
          : {
              ...next,
              progress: {
                ...next.progress,
                status: "paused",
                detail: "The prepared job branch changed. Cancel this job before running it again.",
              },
            };
    }
    if (!equivalentRuns(next, run)) yield* store.save(next);
    if (!["preparing", "running"].includes(next.progress.status)) {
      const scope = supervised.get(next.jobId);
      if (scope) {
        supervised.delete(next.jobId);
        yield* Scope.close(scope, Exit.void);
      }
    }
    if (!next.promptDispatched && next.progress.status === "preparing")
      return (yield* dispatchPrompt(next)) ?? next;
    if (thread && ["preparing", "running"].includes(next.progress.status)) yield* supervise(next);
    return next;
  });
  const handle = Effect.fn("RepositoryWorkflowRunner.handle")(
    function* (request: WorkflowRequest) {
      let run = yield* store.get(request.jobId);
      const cancellation =
        request.control.operation === "cancel" && !run
          ? yield* store.cancelBeforeAcceptance({
              jobId: request.jobId,
              ...request.control,
              repositoryCanonicalKey: request.repositoryCanonicalKey,
              createdAt: yield* timestamp,
            })
          : { run, cancellation: yield* store.getCancellation(request.jobId) };
      run = cancellation.run;
      if (cancellation.cancellation) {
        const saved = cancellation.cancellation;
        return saved.organizationId === request.control.organizationId &&
          saved.repositoryId === request.control.repositoryId &&
          saved.projectId === request.control.projectId &&
          saved.repositoryCanonicalKey === request.repositoryCanonicalKey
          ? result(null, "cancelled", "Cancelled before acceptance.")
          : result(null, "conflict", "The cancellation binding does not match this request.");
      }
      if (
        run &&
        (run.workflow.organizationId !== request.control.organizationId ||
          run.workflow.repositoryId !== request.control.repositoryId ||
          run.workflow.definition.projectId !== request.control.projectId)
      )
        return result(null, "unavailable", "The job binding does not match this request.");
      // Cancellation wins over an undispatched retry intent, including after restart.
      if (
        run &&
        request.control.operation === "cancel" &&
        !isTerminalWorkflowJob(run.progress.status)
      ) {
        if (
          run.progress.status !== "cancelling" ||
          run.pendingPreparationRetry ||
          run.approvalAttempt
        )
          run = yield* store.save({
            ...run,
            pendingPreparationRetry: null,
            approvalAttempt: null,
            cancellationAttempt: run.cancellationAttempt ?? {
              commandId: `workflow:${run.jobId}:cancel`,
              createdAt: yield* timestamp,
            },
            progress: {
              ...run.progress,
              revision: run.progress.revision + 1,
              status: "cancelling",
              approvalPending: false,
              retryableApproval: false,
              detail: "Waiting for the environment to stop the agent and setup.",
            },
          });
        return result(yield* reconcile(run));
      }
      if (run) run = yield* reconcile(run);
      if (request.control.operation === "status") return result(run);
      if (request.control.operation === "start") {
        if (run) return result(run);
        const workflow = request.control.workflow;
        if (
          workflow.organizationId !== request.control.organizationId ||
          workflow.repositoryId !== request.control.repositoryId ||
          workflow.definition.projectId !== request.control.projectId
        )
          return result(null, "unavailable", "Invalid workflow target binding.");
        if (yield* store.isExecuting())
          return result(null, "busy", "Another workflow is executing on this environment.");
        yield* access
          .requireProject(
            { user: { userId: request.userId, displayName: null, imageUrl: null } },
            request.control.projectId,
          )
          .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
        const project = yield* query
          .getProjectShellById(request.control.projectId)
          .pipe(Effect.orDie);
        if (Option.isNone(project))
          return result(null, "unavailable", "The selected project no longer exists.");
        const identity = yield* identities.resolve(project.value.workspaceRoot);
        if (identity?.canonicalKey !== request.repositoryCanonicalKey)
          return result(
            null,
            "unavailable",
            "The project's repository changed; select its current checkout.",
          );
        const modelSelection =
          workflow.definition.steps[0].modelSelection ?? project.value.defaultModelSelection;
        const provider = (yield* registry.getProviders).find(
          (entry) => entry.instanceId === modelSelection?.instanceId,
        );
        // These drivers provide the approval boundary needed by unattended jobs.
        if (
          !modelSelection ||
          !provider?.enabled ||
          !provider.installed ||
          provider.availability === "unavailable" ||
          !["codex", "claudeAgent"].includes(provider.driver)
        )
          return result(
            null,
            "unavailable",
            "Select an installed, enabled Codex or Claude provider with approval support.",
          );
        const remote = identity.locator.remoteName;
        yield* git.fetchRemote({ cwd: project.value.workspaceRoot, remoteName: remote });
        const baseBranch = yield* git.resolveDefaultBranchName(project.value.workspaceRoot, remote);
        if (baseBranch === null)
          return result(null, "unavailable", "The remote default branch could not be resolved.");
        const base = yield* git.resolveRemoteTrackingCommit({
          cwd: project.value.workspaceRoot,
          refName: baseBranch,
          fallbackRemoteName: remote,
        });
        run = {
          jobId: request.jobId,
          userId: request.userId,
          repositoryCanonicalKey: request.repositoryCanonicalKey,
          instruction: request.instruction,
          workflow,
          modelSelection,
          baseBranch,
          baseSha: base.commitSha,
          createdAt: yield* timestamp,
          promptDispatched: false,
          executionReserved: true,
          worktreePath: null,
          preparedHead: null,
          approvedBy: null,
          progress: {
            revision: 0,
            status: "preparing",
            threadId: ThreadId.make(`workflow:${request.jobId}:agent`),
            detail: null,
            checkpoint: null,
          },
        };
        if (!(yield* store.tryAccept(run))) {
          if (yield* store.getCancellation(request.jobId))
            return result(null, "cancelled", "Cancelled before acceptance.");
          const existing = yield* store.get(request.jobId);
          return result(
            existing,
            existing ? "accepted" : "busy",
            existing ? null : "Another workflow is executing on this environment.",
          );
        }
        run = (yield* dispatchPrompt(run)) ?? run;
        return result(run);
      }
      if (!run) return result(null);
      if (isTerminalWorkflowJob(run.progress.status)) {
        const sameApproval =
          request.control.operation === "approve" &&
          run.progress.status === "done" &&
          request.control.checkpointId === run.progress.checkpoint?.checkpointId;
        return result(
          run,
          request.control.operation === "cancel" || sameApproval ? "accepted" : "conflict",
          "This job has finished.",
        );
      }
      if (request.control.operation === "retry_cancellation") {
        if (
          run.progress.status !== "cancelling" ||
          !run.progress.retryableCancellation ||
          run.progress.revision !== request.control.expectedRevision
        )
          return result(run, "conflict", "This cancellation changed. Refresh before retrying.");
        run = yield* store.save({
          ...run,
          pendingPreparationRetry: null,
          cancellationAttempt: {
            commandId: `workflow:${run.jobId}:cancel:${request.control.expectedRevision}`,
            createdAt: yield* timestamp,
          },
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            retryableCancellation: false,
            detail: "Retrying agent and setup cancellation.",
          },
        });
        return result(yield* reconcile(run));
      }
      if (request.control.operation === "retry_preparation") {
        if (run.progress.revision !== request.control.expectedRevision)
          return result(run, "conflict", "This preparation changed. Refresh before retrying.");
        if (yield* store.isExecuting(run.jobId))
          return result(run, "busy", "Another workflow is executing on this environment.");
        const thread = yield* readThread(run);
        const preparation = thread?.promptQueue?.preparation;
        if (
          run.progress.status !== "paused" ||
          preparation?.state !== "failed" ||
          thread?.promptQueue?.pauseReason?.code === "delivery-unknown" ||
          !preparation.settled
        )
          return result(run, "conflict", "Only a stopped, failed preparation can be retried.");
        run = yield* store.save({
          ...run,
          pendingPreparationRetry: {
            commandId: `workflow:${run.jobId}:retry:${request.control.expectedRevision}`,
            expectedRevision: preparation.revision,
            expectedControlRevision: thread!.promptQueue!.revision,
            createdAt: yield* timestamp,
          },
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            status: "preparing",
            detail: null,
            retryablePreparation: false,
          },
        });
        return result(yield* reconcile(run));
      }
      if (request.control.operation !== "approve")
        return result(run, "conflict", "Unsupported workflow control.");
      const checkpoint = run.progress.checkpoint;
      const accepted = run.approvalAttempt;
      if (
        accepted?.checkpointId === request.control.checkpointId &&
        accepted.acceptedRevision === request.control.expectedRevision
      )
        return result(run);
      if (
        run.progress.status !== "awaiting_review" ||
        run.progress.revision !== request.control.expectedRevision ||
        !checkpoint ||
        checkpoint.checkpointId !== request.control.checkpointId ||
        run.worktreePath === null ||
        run.preparedHead === null ||
        (accepted && !run.progress.retryableApproval)
      )
        return result(run, "conflict", "This review changed. Refresh before approving.");
      const detail = yield* verifyResult(run);
      if (detail) return result(run, "conflict", detail);
      const preparation = (yield* readThread(run))?.promptQueue?.preparation;
      const commandId = `workflow:${run.jobId}:approve:${request.control.expectedRevision}`;
      run = yield* store.save({
        ...run,
        approvalAttempt: {
          approvedBy: accepted?.approvedBy ?? request.userId,
          checkpointId: checkpoint.checkpointId,
          preparedHead: run.preparedHead,
          acceptedRevision: request.control.expectedRevision,
          commandId,
          createdAt: yield* timestamp,
          ...(accepted?.setupCleanup
            ? { setupCleanup: { ...accepted.setupCleanup, state: "pending", detail: null } }
            : preparation?.script
              ? {
                  setupCleanup: {
                    attemptId: preparation.attemptId,
                    state: "pending",
                    detail: null,
                  },
                }
              : {}),
        },
        progress: {
          ...run.progress,
          revision: run.progress.revision + 1,
          approvalPending: true,
          retryableApproval: false,
          detail: "Approval accepted; stopping setup before final verification.",
        },
      });
      // Cleanup workers wait for exit outside the control mutex.
      return result(yield* reconcileApproval(run));
    },
    (effect) => Deferred.await(recovered).pipe(Effect.andThen(lock.withPermits(1)(effect))),
    Effect.catchCause((cause) =>
      Effect.fail(new WorkflowRunnerError({ message: Cause.pretty(cause) })),
    ),
  );

  // Subscribe first, then reconcile saved runs. A lost watcher never requires
  // another provider turn: admissions and finalized checkpoint refs are durable.
  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(
    Deferred.await(recovered).pipe(
      Effect.andThen(
        Stream.runForEach(events, (event) => {
          const threadId = "threadId" in event.payload ? event.payload.threadId : null;
          return threadId === null
            ? Effect.void
            : lock
                .withPermits(1)(
                  Effect.gen(function* () {
                    const run = threadId.startsWith("workflow:")
                      ? yield* store.getByThread(threadId)
                      : null;
                    if (run) yield* reconcile(run);
                  }),
                )
                .pipe(Effect.ignoreCause({ log: true }));
        }),
      ),
    ),
  );
  yield* forkParked(
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          for (const run of yield* store.active()) yield* reconcile(run, true);
        }),
      )
      .pipe(
        Effect.ensuring(Deferred.succeed(recovered, undefined)),
        Effect.ignoreCause({ log: true }),
      ),
  );
  return RepositoryWorkflowRunner.of({ handle });
});
export const layer = Layer.effect(RepositoryWorkflowRunner, make).pipe(
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);
