import {
  WorkflowActions,
  WorkflowActionError,
  workflowPublishingRemote,
  changeWorkflowAction,
  readWorkflowHead,
  readWorkflowTree,
  type WorkflowActionIO,
} from "./WorkflowActions.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import {
  WorkflowOrigin,
  sameWorkflowOrigin,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type TurnId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  WORKFLOW_PROTOCOL,
  isTerminalWorkflowJob,
  WorkflowVmDispatchBinding,
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
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { WORKFLOW_CHECKPOINT_READ_TIMEOUT_MS } from "../vcs/WorkflowCheckpointReader.ts";
import { SetupProcessJournal } from "../terminal/SetupProcessJournal.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { canContinueWorkflowVmInference } from "../relay/WorkflowVmAttempts.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { forkParked } from "../serverActivation.ts";
import {
  activeWorkflowStep,
  admittedWorkflowTurnId,
  advanceWorkflow,
  canRecoverPausedWorkflowTurn,
  workflowProgress,
  workflowPromptId,
  workflowAllowsPrompt,
  workflowTurnPauseDetails,
} from "./workflowSequence.ts";
import { workflowTask } from "./workflowTask.ts";
import { attachApprovalSupervisor, type SupervisorVerdict } from "./supervisor.ts";
import {
  WorkflowRunStore,
  WorkflowRun,
  workflowRunOrigin,
  type LegacyWorkflowTurnOutcome,
} from "./WorkflowRunStore.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { jobBranchName } from "./Layers/JobRunner.ts";

export interface WorkflowRequest {
  readonly jobId: string;
  readonly userId?: string;
  readonly origin?: WorkflowOrigin;
  readonly requestedBy?: string;
  readonly repositoryCanonicalKey: string;
  readonly instruction: string;
  readonly control: WorkflowControl;
  readonly workflowVm?: {
    readonly binding: WorkflowVmDispatchBinding;
    readonly workspaceRoot: string;
    readonly baseBranch: string;
    readonly baseSha: string;
  };
}
const sameVmBinding = Schema.toEquivalence(WorkflowVmDispatchBinding);
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
          protocol: WORKFLOW_PROTOCOL,
          outcome: "unavailable",
          detail: "Workflow execution is unavailable on this environment.",
          progress: null,
        }),
    }),
  },
) {}

function currentWorkflowTurnId(thread: OrchestrationThread | null, promptId: string) {
  const admittedTurnId = admittedWorkflowTurnId(thread?.promptQueue, promptId);
  if (admittedTurnId) return admittedTurnId;
  const turnId = thread?.promptQueue?.finalizedTurnId;
  if (!thread || !turnId) return null;
  // Admission records are transient. The admitted user message retains the exact turn.
  return thread.messages.some(
    (message) => message.id === promptId && message.role === "user" && message.turnId === turnId,
  )
    ? turnId
    : null;
}

function resolvedWorkflowTurnId(thread: OrchestrationThread | null, promptId: string) {
  const turnId = currentWorkflowTurnId(thread, promptId);
  return thread?.promptQueue?.finalizedTurnId === turnId ? turnId : null;
}

const { unknownResult, incompleteResult, stoppedTurn, missingCheckpoint, unconfirmedDelivery } =
  workflowTurnPauseDetails;

function canReconcileWorkflowTurn(run: WorkflowRun) {
  const status = run.progress.status;
  return status === "preparing" || status === "running" || canRecoverPausedWorkflowTurn(run);
}

function canSuperviseWorkflowTurn(run: WorkflowRun, thread: OrchestrationThread | null) {
  if (run.progress.status === "preparing" || run.progress.status === "running") return true;
  if (run.runtime.kind !== "vm" || !canRecoverPausedWorkflowTurn(run)) return false;
  const queue = thread?.promptQueue;
  const pause = queue?.pauseReason;
  if (pause?.code !== "delivery-unknown" || !pause.resumeOnConfirmedAttemptId) return false;
  const attemptId = pause.resumeOnConfirmedAttemptId;
  const handoff =
    queue?.handoff?.attemptId === attemptId
      ? queue.handoff
      : queue?.admissions.find((admission) => admission.attemptId === attemptId)?.handoff;
  // The native turn can still request tools while delivery acknowledgement is uncertain.
  return (
    handoff?.messageId === workflowPromptId(run) && canContinueWorkflowVmInference(queue, handoff)
  );
}

/** Read durable admission, completion and checkpoint evidence; session idle alone is insufficient. */
export function reconcileWorkflowRun(
  run: WorkflowRun,
  thread: OrchestrationThread | null,
  cleanupConfirmed = false,
  providerShutdownConfirmed = false,
  legacyFinalization: { turnId: TurnId; outcome: LegacyWorkflowTurnOutcome } | null = null,
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
    // Runtime exit projection can precede owned cleanup; only durable proof releases capacity.
    if (
      providerShutdownConfirmed &&
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
  if (
    ["awaiting_review", "awaiting_input", "waiting_capacity", "finishing"].includes(
      run.progress.status,
    )
  )
    return { ...run, worktreePath };
  const promptId = workflowPromptId(run);
  const turnId = currentWorkflowTurnId(thread, promptId);
  const queueResolved = turnId !== null && thread.promptQueue?.finalizedTurnId === turnId;
  const finalization =
    queueResolved && thread.promptQueue?.finalization?.turnId === turnId
      ? thread.promptQueue.finalization
      : null;
  const legacyOutcome =
    queueResolved && !finalization && legacyFinalization?.turnId === turnId
      ? legacyFinalization.outcome
      : null;
  const turn = thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
  const checkpoint = queueResolved
    ? thread.checkpoints.find((entry) => entry.turnId === turnId)
    : undefined;
  const completed = finalization
    ? finalization.outcome === "completed" && finalization.checkpoint !== "error"
    : legacyOutcome === "completed" && turn?.state === "completed";
  if (completed && checkpoint?.status === "ready" && canReconcileWorkflowTurn(run))
    return withProgress("awaiting_review", null, {
      checkpointId: `${run.jobId}:${checkpoint.turnId}:${checkpoint.checkpointRef}`,
      turnId: checkpoint.turnId,
      checkpointRef: checkpoint.checkpointRef,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
    });
  const unknown = thread.promptQueue?.pauseReason?.code === "delivery-unknown";
  if (
    !queueResolved &&
    unknown &&
    (thread.promptQueue?.handoff?.messageId === promptId ||
      thread.promptQueue.entries.some(
        (entry) => entry.messageId === promptId && entry.state === "unknown",
      ))
  ) {
    const detail = unconfirmedDelivery;
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
  const rejection = thread.promptQueue?.pauseReason;
  if (!turnId && rejection?.code === "failed" && rejection.messageId === promptId) {
    const detail = `${rejection.detail} Cancel this job before starting again.`;
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
  if (!turnId) return worktreePath === run.worktreePath ? run : { ...run, worktreePath };
  if (queueResolved) {
    if ((finalization && finalization.outcome !== "completed") || legacyOutcome === "failed")
      return withProgress("paused", incompleteResult);
    if (finalization || legacyOutcome === "checkpoint-error" || completed)
      return withProgress("paused", missingCheckpoint);
    return withProgress("paused", unknownResult);
  }
  if (turn?.state === "interrupted" || turn?.state === "error")
    return withProgress("paused", incompleteResult);
  if (
    turn?.state === "running" &&
    thread.session &&
    ["stopped", "error", "interrupted"].includes(thread.session.status)
  )
    return withProgress("paused", stoppedTurn);
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
  const approvalWorkers = new Map<string, { fiber: Fiber.Fiber<void, never> | null }>();
  const engine = yield* OrchestrationEngineService;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const query = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const checkpoints = yield* CheckpointStore;
  const identities = yield* RepositoryIdentityResolver;
  const access = yield* RepositoryAccess;
  const registry = yield* ProviderRegistry;
  const providersService = yield* ProviderService;
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
  const actions = yield* WorkflowActions;
  const publishingSupported = yield* actions.available;
  const actionWorkers = new Map<
    string,
    { fiber: Fiber.Fiber<void, never> | null; stopping: boolean }
  >();
  const actionCleanupWorkers = new Set<string>();
  const store = {
    ...persistence,
    save: Effect.fn("RepositoryWorkflowRunner.save")(function* (run: WorkflowRun) {
      const previous = yield* persistence.get(run.jobId);
      yield* persistence.save(run);
      if (
        previous &&
        (previous.progress.status !== run.progress.status ||
          (!previous.promptDispatched && run.promptDispatched) ||
          previous.manualPause?.state !== run.manualPause?.state) &&
        (run.sequence?.started || run.promptDispatched) &&
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
            summary:
              run.manualPause?.state === "requested"
                ? "Workflow pausing after current step"
                : run.manualPause?.state === "paused"
                  ? "Workflow manually paused"
                  : `Workflow ${run.progress.status.replaceAll("_", " ")}`,
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
  const readThread = (run: WorkflowRun) =>
    query
      .getThreadDetailById(run.progress.threadId)
      .pipe(Effect.orDie, Effect.map(Option.getOrNull));
  const readReconciliationThread = Effect.fnUntraced(function* (run: WorkflowRun) {
    const thread = yield* readThread(run);
    if (!canReconcileWorkflowTurn(run)) return thread;
    const promptId = workflowPromptId(run);
    const turnId = resolvedWorkflowTurnId(thread, promptId);
    if (!thread || !turnId) return thread;
    if (
      (thread.promptQueue?.finalization !== undefined ||
        (thread.latestTurn?.turnId === turnId && thread.latestTurn.state === "completed")) &&
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "ready",
      )
    )
      return thread;
    // Thread detail reads checkpoints before the queue. Confirm missing evidence
    // after observing finalization, which is written after the checkpoint.
    const confirmed = yield* readThread(run);
    return resolvedWorkflowTurnId(confirmed, promptId) === turnId ? confirmed : null;
  });
  const readLegacyFinalization = Effect.fnUntraced(function* (
    run: WorkflowRun,
    thread: OrchestrationThread | null,
  ) {
    if (!canReconcileWorkflowTurn(run)) return null;
    if (thread?.promptQueue?.finalization !== undefined) return null;
    const turnId = resolvedWorkflowTurnId(thread, workflowPromptId(run));
    if (!turnId) return null;
    const outcome = yield* store.getLegacyTurnOutcome(run.progress.threadId, turnId);
    return outcome === null ? null : { turnId, outcome };
  });
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
      const resolvedUserInputIds = new Set<string>();
      const recordedVerdicts = new Map<string, SupervisorVerdict>();
      for (const activity of thread?.activities ?? []) {
        if (activity.kind === "approval.resolved" && isApprovalRequestId(activity.payload))
          resolvedRequestIds.add(activity.payload.requestId);
        if (activity.kind === "user-input.resolved" && isApprovalRequestId(activity.payload))
          resolvedUserInputIds.add(activity.payload.requestId);
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
            current?.projectId === run.runtime.projectId
              ? (current.worktreePath ?? (run.runtime.kind === "vm" ? run.worktreePath : null))
              : null,
          ),
        ),
        modelSelection: run.modelSelection,
        workflowVm: run.runtime.kind === "vm",
        resolvedRequestIds,
        resolvedUserInputIds,
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
  const detachSupervisor = (jobId: string) => {
    const scope = supervised.get(jobId);
    supervised.delete(jobId);
    return scope;
  };
  const requireExecution = (run: WorkflowRun) =>
    workflowRunOrigin(run).kind === "automation"
      ? access.requireWorkflowProject({
          organizationId: run.workflow.organizationId,
          repositoryId: run.workflow.repositoryId,
          projectId: run.runtime.projectId,
          repositoryCanonicalKey: run.repositoryCanonicalKey,
        })
      : access.requireProject(
          { user: { userId: run.userId!, displayName: null, imageUrl: null } },
          run.runtime.projectId,
        );
  const blockedExecutionDetail =
    "Repository access is unavailable. Cancel this run or restore its repository binding.";
  // Fence new work against policy changes; completion evidence and owned cleanup stay outside.
  const withExecutionAccess = <E, R>(
    run: WorkflowRun,
    work: (run: WorkflowRun) => Effect.Effect<WorkflowRun, E, R>,
  ) =>
    access.withFence(
      run.runtime.kind === "vm"
        ? Effect.flatMap(store.isVmFenceActive(run.runtime), (active) =>
            active ? work(run) : Effect.succeed(run),
          )
        : workflowRunOrigin(run).kind !== "automation"
          ? work(run)
          : requireExecution(run).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  run.progress.detail && run.progress.detail !== "Waiting for executor capacity."
                    ? Effect.succeed(run)
                    : store.save({
                        ...run,
                        progress: {
                          ...run.progress,
                          revision: run.progress.revision + 1,
                          detail: blockedExecutionDetail,
                        },
                      }),
                onSuccess: () =>
                  Effect.gen(function* () {
                    if (run.progress.detail === blockedExecutionDetail)
                      run = yield* store.save({
                        ...run,
                        progress: {
                          ...run.progress,
                          revision: run.progress.revision + 1,
                          detail: null,
                        },
                      });
                    return yield* work(run);
                  }),
              }),
            ),
    );
  const dispatchPrompt = Effect.fn("RepositoryWorkflowRunner.dispatchPrompt")(function* (
    run: WorkflowRun,
  ) {
    if (!workflowAllowsPrompt(run, workflowPromptId(run))) return run;
    if (run.progress.status === "waiting_capacity") {
      const step = activeWorkflowStep(run);
      if (step?.kind !== "agent") return run;
      run = { ...run, modelSelection: step.modelSelection ?? run.modelSelection };
    }
    const project = yield* query.getProjectShellById(run.runtime.projectId).pipe(Effect.orDie);
    if (Option.isNone(project))
      return yield* new WorkflowRunnerError({ message: "The selected project no longer exists." });
    const existing = yield* readThread(run);
    const promptId = workflowPromptId(run);
    const alreadyQueued =
      existing?.promptQueue?.entries.some((entry) => entry.messageId === promptId) ||
      existing?.promptQueue?.admissions.some((entry) => entry.messageId === promptId);
    let detail: string | null = null;
    if (!alreadyQueued) {
      const selection = run.modelSelection;
      const info = yield* providersService
        .getInstanceInfo(selection.instanceId)
        .pipe(Effect.option);
      const snapshots = yield* registry.getProviders;
      const selected = snapshots.find((entry) => entry.instanceId === selection.instanceId);
      const current = existing?.modelSelection;
      if (!run.providerContinuation)
        detail = "This job's original provider compatibility is unavailable.";
      else if (
        Option.isNone(info) ||
        !info.value.enabled ||
        !selected?.enabled ||
        !selected.installed ||
        selected.availability === "unavailable"
      )
        detail = "The selected Agent provider is unavailable.";
      else if (
        info.value.driverKind !== run.providerContinuation.driver ||
        info.value.continuationIdentity.continuationKey !== run.providerContinuation.continuationKey
      )
        detail = "The Agent provider's continuation identity changed.";
      else if (
        existing?.session &&
        current &&
        (current.instanceId !== selection.instanceId || current.model !== selection.model) &&
        (selected.requiresNewThreadForModelChange ||
          snapshots.find((entry) => entry.instanceId === current.instanceId)
            ?.requiresNewThreadForModelChange)
      )
        detail = "The Agent provider cannot change models within this conversation.";
    }
    const task = workflowTask(run);
    return yield* withExecutionAccess(run, (run) =>
      Effect.gen(function* () {
        if (!workflowAllowsPrompt(run, workflowPromptId(run))) return run;
        if (detail)
          return yield* store.save({
            ...run,
            progress: {
              ...run.progress,
              revision: run.progress.revision + 1,
              status: "paused",
              retryablePreparation: false,
              detail: `${detail} Cancel this job before starting again.`,
            },
          });
        if (run.progress.status === "waiting_capacity") {
          if (run.manualPause || (yield* store.isExecuting(run.jobId))) return run;
          // Keep the durable reservation and local enqueue in the same policy fence.
          run = yield* store.save({
            ...run,
            executionReserved: true,
            progress: {
              ...run.progress,
              revision: run.progress.revision + 1,
              status: "preparing",
              detail: null,
            },
          });
        }
        yield* supervise(run);
        const acknowledgement = yield* engine
          .dispatch({
            type: "thread.prompt.enqueue",
            commandId: CommandId.make(workflowPromptId(run).replace(/:prompt$/, ":start")),
            threadId: run.progress.threadId,
            message: {
              messageId: MessageId.make(workflowPromptId(run)),
              text: `${task.stepInstruction}\n\nJob context:\n${task.jobContext}\n\n${task.reviewConstraint}`,
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            modelSelection: run.modelSelection,
            createdAt: run.sequence?.stepStartedAt ?? run.createdAt,
            ...(workflowRunOrigin(run).kind === "automation"
              ? {
                  workflowOrigin: {
                    kind: "automation" as const,
                    jobId: run.jobId,
                    workflowId: run.workflow.workflowId,
                    workflowName: run.workflow.definition.name,
                  },
                }
              : { author: { userId: run.userId!, displayName: null, imageUrl: null } }),
            ...(!run.sequence?.started && run.runtime.kind === "vm"
              ? { bootstrap: { runSetupScript: true } }
              : !run.sequence?.started
                ? {
                    bootstrap: {
                      createThread: {
                        projectId: project.value.id,
                        title: run.workflow.definition.name,
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
                  }
                : {}),
          })
          .pipe(Effect.result);
        if (acknowledgement._tag === "Failure") {
          const error = acknowledgement.failure;
          if (!isOrchestrationCommandRejection(error) && !isPreviouslyRejected(error))
            return yield* new WorkflowRunnerError({ message: error.message });
          return yield* store.save({
            ...run,
            progress: {
              ...run.progress,
              revision: run.progress.revision + 1,
              status: "paused",
              retryablePreparation: false,
              detail: `${error.message} Cancel this job before starting again.`,
            },
          });
        }
        return yield* store.save({
          ...run,
          promptDispatched: true,
          ...(run.sequence ? { sequence: { ...run.sequence, started: true } } : {}),
        });
      }),
    );
  });
  const verifyResult = Effect.fn("RepositoryWorkflowRunner.verifyResult")(function* (
    run: WorkflowRun,
  ) {
    if (!run.worktreePath || !run.progress.checkpoint || run.progress.checkpoint.kind === "input")
      return "The saved result is unavailable. Cancel the job and run it again.";
    if (
      (yield* readWorkflowHead(git, run.worktreePath, jobBranchName(run.jobId))) !==
      run.preparedHead
    )
      return "The prepared branch changed after this review was created. Cancel the job and run it again.";
    const cwd = run.worktreePath;
    const reviewedRef = CheckpointRef.make(run.progress.checkpoint.checkpointRef);
    let reviewedTree: string;
    let workflowIgnoreRules: Uint8Array | undefined;
    if (run.runtime.kind === "vm") {
      const pin = yield* persistence.getCheckpointPinForRun(
        run.runtime,
        run.progress.checkpoint.turnId,
        reviewedRef,
      );
      if (
        !pin ||
        (yield* checkpoints
          .resolvePinnedTree({ cwd, checkpointRef: CheckpointRef.make(pin.commitId) })
          .pipe(Effect.orElseSucceed(() => null))) !== pin.treeId ||
        (yield* checkpoints
          .resolvePinnedTree({ cwd, checkpointRef: CheckpointRef.make(pin.baselineCommitId) })
          .pipe(Effect.orElseSucceed(() => null))) === null
      )
        return "The saved workflow checkpoint is unavailable. Cancel the run and start again.";
      const ignoreRules = yield* persistence.getWorkflowIgnoreRules(run.runtime);
      if (ignoreRules === null)
        return "The saved workflow Git ignore rules are unavailable. Cancel the run and start again.";
      workflowIgnoreRules = ignoreRules;
      reviewedTree = pin.treeId;
    } else {
      reviewedTree = yield* readWorkflowTree(git, cwd, reviewedRef);
    }
    const verificationRef = CheckpointRef.make(`refs/t3/workflow-verification/${run.jobId}`);
    const current = yield* checkpoints
      .captureCheckpoint({
        cwd,
        checkpointRef: verificationRef,
        strictWorkflowCapture: run.runtime.kind === "vm",
        ...(workflowIgnoreRules === undefined ? {} : { workflowIgnoreRules }),
      })
      .pipe(
        Effect.ensuring(
          checkpoints
            .deleteCheckpointRefs({
              cwd,
              checkpointRefs: [verificationRef],
              pinned: run.runtime.kind === "vm",
            })
            .pipe(Effect.ignoreCause({ log: true })),
        ),
      );
    if ((yield* readWorkflowHead(git, cwd, jobBranchName(run.jobId))) !== run.preparedHead)
      return "The prepared branch changed after this review was created. Cancel the job and run it again.";
    return current.treeId !== reviewedTree
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
                    ? !["awaiting_review", "finishing"].includes(current.progress.status)
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
                yield* pumpWaiting();
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
      const preparationPath = run.runtime.kind === "vm" ? null : run.worktreePath;
      for (let retry = 0; retry < 8; retry++) {
        const thread = yield* readThread(run);
        const preparation = thread?.promptQueue?.preparation;
        if (
          !thread ||
          thread.projectId !== run.runtime.projectId ||
          thread.worktreePath !== preparationPath ||
          !preparation ||
          preparation.attemptId !== cleanup.attemptId ||
          preparation.target?.worktreePath !== preparationPath ||
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
          projected?.projectId !== run.runtime.projectId ||
          projected.worktreePath !== preparationPath ||
          current?.attemptId !== cleanup.attemptId ||
          current.target?.worktreePath !== preparationPath
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
      if (
        !["awaiting_review", "finishing"].includes(run.progress.status) ||
        !attempt ||
        run.progress.retryableApproval
      )
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
      if (approvalWorkers.has(run.jobId)) return run;
      const worker = { fiber: null as Fiber.Fiber<void, never> | null };
      approvalWorkers.set(run.jobId, worker);
      // The HTTP request acknowledges the durable intent. Filesystem I/O must
      // outlive its transport deadline and must not hold the runner's control lock.
      worker.fiber = yield* Effect.gen(function* () {
        const settlement = yield* settleApprovedPreparation(run);
        return (
          settlement ??
          (attempt.checkpointId !== run.progress.checkpoint?.checkpointId ||
          attempt.preparedHead !== run.preparedHead
            ? "The saved review changed. Cancel the job and run it again."
            : yield* verifyResult(run))
        );
      }).pipe(
        // Allow the VM reader its full transfer budget in addition to preparation
        // settlement and Git verification. Machine verification keeps its usual limit.
        Effect.timeout(
          3 * 60_000 + (run.runtime.kind === "vm" ? WORKFLOW_CHECKPOINT_READ_TIMEOUT_MS : 0),
        ),
        Effect.exit,
        Effect.flatMap((outcome) =>
          Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)
            ? Effect.void
            : lock.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* store.get(run.jobId);
                  if (
                    !current ||
                    current.approvalAttempt?.commandId !== attempt.commandId ||
                    !["awaiting_review", "finishing"].includes(current.progress.status) ||
                    current.progress.retryableApproval
                  )
                    return;
                  const response = attempt.response;
                  const sequence = current.sequence;
                  const step = activeWorkflowStep(current);
                  const failed = Exit.isFailure(outcome);
                  let detail = failed
                    ? "Result verification could not finish. Retry approval."
                    : outcome.value;
                  if (
                    current.progress.checkpoint?.checkpointId !== attempt.checkpointId ||
                    current.preparedHead !== attempt.preparedHead ||
                    (response &&
                      (!sequence ||
                        step?.kind !== "review" ||
                        step.id !== response.stepId ||
                        sequence.generation !== response.generation))
                  )
                    detail = "The saved review changed. Cancel the job and run it again.";
                  if (
                    current.runtime.kind === "vm" &&
                    !(yield* store.isVmFenceActive(current.runtime))
                  )
                    detail = "The VM no longer owns this workflow. Cancel the run.";
                  let next: WorkflowRun;
                  if (!detail && response && sequence) {
                    next = advanceWorkflow({
                      ...current,
                      approvalAttempt: null,
                      sequence: {
                        ...sequence,
                        cursor: sequence.cursor + 1,
                        stepStartedAt: response.createdAt,
                        responses: [...sequence.responses, response],
                        completed: [
                          ...sequence.completed,
                          {
                            stepId: response.stepId,
                            generation: response.generation,
                            checkpoint: null,
                            head: null,
                          },
                        ],
                      },
                    });
                    if (next.progress.status === "finishing")
                      next = {
                        ...next,
                        progress: {
                          ...next.progress,
                          status: "awaiting_review",
                          checkpoint: current.progress.checkpoint,
                        },
                      };
                  } else {
                    next = {
                      ...current,
                      approvalAttempt: failed ? current.approvalAttempt : null,
                      approvedBy: detail ? current.approvedBy : attempt.approvedBy,
                      executionReserved: false,
                      progress: {
                        ...current.progress,
                        revision: current.progress.revision + 1,
                        status: detail ? current.progress.status : "done",
                        approvalPending: false,
                        retryableApproval:
                          failed || (!!detail && current.progress.status === "finishing"),
                        detail:
                          detail ?? "Workflow completed; setup cleanup and final result verified.",
                      },
                    };
                  }
                  yield* store.save(next);
                  approvalWorkers.delete(run.jobId);
                  yield* reconcile(next);
                  yield* pumpWaiting();
                }),
              ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : lock.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* store.get(run.jobId);
                  if (current?.approvalAttempt?.commandId !== attempt.commandId) return;
                  if (approvalWorkers.get(run.jobId) === worker) approvalWorkers.delete(run.jobId);
                  yield* store.save({
                    ...current,
                    progress: {
                      ...current.progress,
                      revision: current.progress.revision + 1,
                      approvalPending: false,
                      retryableApproval: true,
                      detail:
                        "Approval could not finish. Retry approval; the saved request and cleanup are retained.",
                    },
                  });
                }),
              ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (approvalWorkers.get(run.jobId) === worker) approvalWorkers.delete(run.jobId);
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(runnerScope),
      );
      return run;
    },
    (effect, run) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* store.get(run.jobId);
            if (
              !current ||
              !["awaiting_review", "finishing"].includes(current.progress.status) ||
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
      const providerProof = yield* providersService.isWorkflowSessionStopConfirmed({
        jobId: run.jobId,
        threadId: run.progress.threadId,
      });
      const stopped =
        providerProof &&
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
      const providerStopped =
        (thread.session === null || thread.session.status === "stopped") &&
        (yield* providersService.isWorkflowSessionStopConfirmed({
          jobId: run.jobId,
          threadId: run.progress.threadId,
        }));
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
  const actionIO = (jobId: string): WorkflowActionIO => ({
    read: persistence
      .get(jobId)
      .pipe(
        Effect.flatMap((run) =>
          run
            ? Effect.succeed(run)
            : Effect.fail(new WorkflowActionError({ message: "The workflow job is unavailable." })),
        ),
      ),
    update: (change) => {
      const effect = Effect.gen(function* () {
        const current = yield* persistence.get(jobId);
        if (!current)
          return yield* new WorkflowActionError({ message: "The workflow job is unavailable." });
        const next = change(current);
        return yield* store.save({
          ...next,
          progress: { ...next.progress, revision: current.progress.revision + 1 },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(new WorkflowActionError({ message: Cause.pretty(cause) })),
        ),
      );
      return lock.withPermits(1)(effect);
    },
  });
  const actionSettled = (jobId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* persistence.get(jobId);
        if (latest) yield* reconcile(latest);
        yield* pumpWaiting();
      }),
    );
  const recoverCancelledAction = Effect.fn("RepositoryWorkflowRunner.recoverCancelledAction")(
    function* (run: WorkflowRun) {
      if (actionCleanupWorkers.has(run.jobId) || run.progress.retryableCancellation) return;
      actionCleanupWorkers.add(run.jobId);
      const io = actionIO(run.jobId);
      yield* actions.recover(io).pipe(
        Effect.flatMap((stopped) =>
          stopped
            ? Effect.void
            : Effect.fail(
                new WorkflowActionError({
                  message:
                    "Publishing process ownership could not be confirmed. The job remains owned until stopping is proven.",
                }),
              ),
        ),
        Effect.catchCause((cause) =>
          io
            .update((current) => ({
              ...current,
              executionReserved: true,
              progress: {
                ...current.progress,
                retryableCancellation: true,
                detail: Cause.pretty(cause),
              },
            }))
            .pipe(Effect.asVoid),
        ),
        Effect.onExit(() => Effect.sync(() => actionCleanupWorkers.delete(run.jobId))),
        Effect.andThen(actionSettled(run.jobId)),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(runnerScope),
      );
    },
  );
  const startAction = Effect.fn("RepositoryWorkflowRunner.startAction")(function* (
    run: WorkflowRun,
  ): Effect.fn.Return<WorkflowRun, Error> {
    const step = activeWorkflowStep(run);
    if (step?.kind !== "action" || !run.sequence || actionWorkers.has(run.jobId)) return run;
    const id = `workflow:${run.jobId}:action:${step.id}:${run.sequence.generation}`;
    let action = run.actions?.find((entry) => entry.actionId === id);
    if (!action) {
      const result = run.sequence.completed.findLast((entry) => entry.checkpoint);
      if (!result?.checkpoint || !run.worktreePath || !run.preparedHead || !run.publication)
        return yield* new WorkflowRunnerError({
          message: "The publishing step has no prepared result.",
        });
      const pin =
        run.runtime.kind === "vm"
          ? yield* persistence.getCheckpointPinForRun(
              run.runtime,
              result.checkpoint.turnId,
              result.checkpoint.checkpointRef,
            )
          : null;
      if (run.runtime.kind === "vm" && !pin)
        return yield* new WorkflowRunnerError({
          message: "The saved workflow checkpoint is unavailable. Cancel the run and start again.",
        });
      const tree =
        pin?.treeId ??
        (yield* readWorkflowTree(git, run.worktreePath, result.checkpoint.checkpointRef));
      action = {
        actionId: id,
        stepId: step.id,
        generation: run.sequence.generation,
        operation: step.action,
        state: "running",
        phase: "prepare",
        parent: run.preparedHead,
        tree,
        checkpointRef: result.checkpoint.checkpointRef,
        ...(pin ? { checkpointTurnId: result.checkpoint.turnId } : {}),
        commitMessage: null,
        commitSha: null,
        oldRemoteSha: run.publication.publishedHead,
        prTitle: null,
        prBody: null,
        pullRequestUrl: null,
        detail: null,
        commands: [],
      };
      run = { ...run, actions: [...(run.actions ?? []), action] };
    }
    if (action.state !== "running") return run;
    run = yield* store.save({
      ...run,
      executionReserved: true,
      progress: {
        ...run.progress,
        revision: run.progress.revision + 1,
        status: "running",
        detail: null,
      },
    });
    const worker = { fiber: null as Fiber.Fiber<void, never> | null, stopping: false };
    actionWorkers.set(run.jobId, worker);
    const io = actionIO(run.jobId);
    worker.fiber = yield* actions.execute(id, io).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) {
            const failure = Cause.squash(exit.cause);
            const detail = (
              failure instanceof Error
                ? failure.message
                : "Publishing was interrupted; its outcome needs reconciliation."
            ).slice(0, 500);
            yield* io.update((current) => ({
              ...changeWorkflowAction(current, id, (entry) =>
                entry.state === "completed" ? entry : { ...entry, state: "uncertain", detail },
              ),
              executionReserved:
                current.actions?.some((entry) =>
                  entry.commands.some((command) => !command.stopped),
                ) ?? false,
              progress:
                current.progress.status === "cancelling"
                  ? current.progress
                  : { ...current.progress, status: "paused", detail },
            }));
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              actionWorkers.delete(run.jobId);
              yield* actionSettled(run.jobId).pipe(Effect.ignoreCause({ log: true }));
            }),
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(runnerScope),
    );
    return run;
  });
  const reconcile = Effect.fn("RepositoryWorkflowRunner.reconcile")(function* (
    run: WorkflowRun,
    recovering = false,
  ): Effect.fn.Return<WorkflowRun, Error> {
    if (isTerminalWorkflowJob(run.progress.status)) {
      const scope = detachSupervisor(run.jobId);
      if (scope) yield* Scope.close(scope, Exit.void);
      return run;
    }
    let retry = run.pendingPreparationRetry;
    if (retry && workflowRunOrigin(run).kind === "automation") {
      const receipt = yield* commandReceipts
        .getByCommandId({ commandId: CommandId.make(retry.commandId) })
        .pipe(Effect.orDie);
      if (Option.isSome(receipt)) {
        if (
          receipt.value.aggregateKind !== "thread" ||
          receipt.value.aggregateId !== run.progress.threadId
        )
          return yield* new WorkflowRunnerError({
            message: "The saved preparation retry receipt belongs to another target.",
          });
        const preparation = (yield* readThread(run))?.promptQueue?.preparation;
        run = yield* store.save({
          ...run,
          pendingPreparationRetry: null,
          ...(receipt.value.status === "rejected"
            ? {
                progress: {
                  ...run.progress,
                  revision: run.progress.revision + 1,
                  status: "paused",
                  detail: receipt.value.error,
                  retryablePreparation: preparation?.state === "failed" && preparation.settled,
                },
              }
            : {}),
        });
        retry = null;
      }
    }
    if (retry && (yield* readThread(run))?.promptQueue?.pauseReason?.code === "delivery-unknown") {
      run = yield* store.save({ ...run, pendingPreparationRetry: null });
      retry = null;
    }
    if (
      retry &&
      !isTerminalWorkflowJob(run.progress.status) &&
      run.progress.status !== "cancelling" &&
      workflowAllowsPrompt(run, workflowPromptId(run))
    ) {
      run = yield* withExecutionAccess(run, (run) =>
        Effect.gen(function* () {
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
          return run;
        }),
      );
    }
    const activeStep = activeWorkflowStep(run);
    if (activeStep?.kind === "action" && run.sequence) {
      const currentAction = run.actions?.findLast(
        (entry) => entry.stepId === activeStep.id && entry.generation === run.sequence!.generation,
      );
      if (run.progress.status === "cancelling") {
        const worker = actionWorkers.get(run.jobId);
        if (worker) {
          if (!worker.stopping && worker.fiber) {
            worker.stopping = true;
            yield* Fiber.interrupt(worker.fiber).pipe(Effect.forkIn(runnerScope));
          }
          return run;
        }
        if (actionCleanupWorkers.has(run.jobId)) return run;
        if (run.actions?.some((action) => action.commands.some((command) => !command.stopped))) {
          yield* recoverCancelledAction(run);
          return run;
        }
      } else if (currentAction?.state === "completed") {
        run = yield* store.save(
          advanceWorkflow({
            ...run,
            sequence: {
              ...run.sequence,
              cursor: run.sequence.cursor + 1,
              completed: [
                ...run.sequence.completed,
                {
                  stepId: activeStep.id,
                  generation: run.sequence.generation,
                  checkpoint: null,
                  head: currentAction.commitSha,
                },
              ],
            },
          }),
        );
      } else {
        if (run.manualPause?.state === "requested" && !run.executionReserved) {
          run = yield* store.save({ ...run, manualPause: { ...run.manualPause, state: "paused" } });
        }
        if (
          (!run.manualPause ||
            (run.manualPause.state === "requested" &&
              run.executionReserved &&
              currentAction?.state === "running")) &&
          !actionWorkers.has(run.jobId) &&
          (!currentAction || currentAction.state === "running") &&
          !(yield* store.isExecuting(run.jobId))
        )
          return yield* withExecutionAccess(run, startAction);
        return yield* withExecutionAccess(run, Effect.succeed);
      }
    }
    if (run.progress.status === "cancelling") {
      if (run.runtime.kind === "vm") {
        const scope = detachSupervisor(run.jobId);
        if (scope) yield* Scope.close(scope, Exit.void);
      }
      run = yield* reconcileCancellation(run, recovering);
    }
    const thread = yield* readReconciliationThread(run);
    if (
      run.progress.status === "cancelling" &&
      thread === null &&
      !run.cancellationAttempt?.setupCleanup &&
      (yield* providersService.isWorkflowSessionStopConfirmed({
        jobId: run.jobId,
        threadId: run.progress.threadId,
      }))
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
    if (["awaiting_review", "finishing"].includes(run.progress.status) && run.approvalAttempt)
      run = yield* reconcileApproval(run);
    const cleanupConfirmed =
      run.cancellationAttempt?.setupCleanup?.state === "done"
        ? yield* journal.confirmed({
            threadId: run.progress.threadId,
            attemptId: run.cancellationAttempt.setupCleanup.attemptId,
          })
        : false;
    const providerShutdownConfirmed =
      run.progress.status === "cancelling" &&
      (yield* providersService.isWorkflowSessionStopConfirmed({
        jobId: run.jobId,
        threadId: run.progress.threadId,
      }));
    const legacyFinalization = yield* readLegacyFinalization(run, thread);
    let next = reconcileWorkflowRun(
      run,
      thread,
      cleanupConfirmed,
      providerShutdownConfirmed,
      legacyFinalization,
    );
    if (
      run.runtime.kind === "vm" &&
      run.progress.status !== "awaiting_review" &&
      next.progress.status === "awaiting_review" &&
      next.progress.checkpoint &&
      next.progress.checkpoint.kind !== "input" &&
      !(yield* store.getCheckpointPinForRun(
        run.runtime,
        next.progress.checkpoint.turnId,
        CheckpointRef.make(next.progress.checkpoint.checkpointRef),
      ))
    ) {
      next =
        run.progress.status === "paused" && run.progress.detail === missingCheckpoint
          ? run
          : {
              ...run,
              progress: {
                ...run.progress,
                revision: run.progress.revision + 1,
                status: "paused",
                detail: missingCheckpoint,
              },
            };
    }
    if (run.progress.status !== "awaiting_review" && next.progress.status === "awaiting_review") {
      const head = next.worktreePath
        ? yield* readWorkflowHead(git, next.worktreePath, jobBranchName(next.jobId))
        : null;
      next =
        head !== null
          ? { ...next, preparedHead: head }
          : {
              ...next,
              executionReserved: run.executionReserved,
              progress: {
                ...next.progress,
                status: "paused",
                detail: "The prepared job branch changed. Cancel this job before running it again.",
              },
            };
    }
    if (
      next.sequence &&
      run.progress.status !== "awaiting_review" &&
      next.progress.status === "awaiting_review" &&
      next.progress.checkpoint?.kind !== "input"
    ) {
      const step = activeWorkflowStep(next);
      if (step?.kind === "agent")
        next = advanceWorkflow({
          ...next,
          sequence: {
            ...next.sequence,
            cursor: next.sequence.cursor + 1,
            feedback: null,
            stepStartedAt: yield* timestamp,
            completed: [
              ...next.sequence.completed,
              {
                stepId: step.id,
                generation: next.sequence.generation,
                checkpoint: next.progress.checkpoint,
                head: next.preparedHead,
              },
            ],
          },
        });
    }
    if (
      next.sequence?.cursor !== run.sequence?.cursor ||
      next.sequence?.generation !== run.sequence?.generation
    ) {
      const scope = detachSupervisor(run.jobId);
      if (scope) yield* Scope.close(scope, Exit.void);
    }
    if (!equivalentRuns(next, run)) yield* store.save(next);
    if (
      next.manualPause?.state === "requested" &&
      !next.executionReserved &&
      ["awaiting_review", "awaiting_input", "waiting_capacity", "finishing"].includes(
        next.progress.status,
      )
    ) {
      next = {
        ...next,
        manualPause: { ...next.manualPause, state: "paused" },
        progress: { ...next.progress, revision: next.progress.revision + 1 },
      };
      yield* store.save(next);
    }
    if (
      (next.progress.status === "finishing" ||
        (next.sequence &&
          next.sequence.cursor === next.workflow.definition.steps.length &&
          next.progress.status === "awaiting_review")) &&
      !next.manualPause &&
      !next.approvalAttempt &&
      !next.progress.retryableApproval &&
      (!next.progress.detail || next.progress.detail === blockedExecutionDetail)
    ) {
      const preparation = thread?.promptQueue?.preparation;
      next = yield* store.save({
        ...next,
        approvalAttempt: {
          approvedBy:
            (next.workflow.definition.steps.at(-1)?.kind === "review"
              ? next.sequence?.responses.findLast((response) => response.operation === "approve")
                  ?.userId
              : null) ?? null,
          checkpointId: next.progress.checkpoint!.checkpointId,
          preparedHead: next.preparedHead!,
          acceptedRevision: next.progress.revision,
          commandId: `workflow:${next.jobId}:finish:${next.sequence!.generation}`,
          createdAt: yield* timestamp,
          ...(preparation?.script
            ? {
                setupCleanup: {
                  attemptId: preparation.attemptId,
                  state: "pending" as const,
                  detail: null,
                },
              }
            : {}),
        },
        progress: { ...next.progress, revision: next.progress.revision + 1, approvalPending: true },
      });
      next = yield* reconcileApproval(next);
    }
    const superviseTurn = canSuperviseWorkflowTurn(next, thread);
    if (!superviseTurn) {
      const scope = detachSupervisor(next.jobId);
      if (scope) yield* Scope.close(scope, Exit.void);
    }
    if (
      !next.promptDispatched &&
      (next.progress.status === "preparing" ||
        (next.progress.status === "waiting_capacity" &&
          !next.manualPause &&
          activeWorkflowStep(next)?.kind === "agent" &&
          !(yield* store.isExecuting(next.jobId))))
    )
      return (yield* dispatchPrompt(next)) ?? next;
    if (thread && superviseTurn) yield* supervise(next);
    return isTerminalWorkflowJob(next.progress.status) || next.progress.status === "cancelling"
      ? next
      : yield* withExecutionAccess(next, Effect.succeed);
  });
  const pumpWaiting = Effect.fn("RepositoryWorkflowRunner.pumpWaiting")(function* () {
    if (yield* store.isExecuting()) return;
    for (const waiting of yield* store.active("waiting_capacity")) {
      if (waiting.manualPause) continue;
      const resumed = yield* reconcile(waiting);
      if (resumed.executionReserved) break;
    }
  });
  const handle = Effect.fn("RepositoryWorkflowRunner.handle")(
    function* (request: WorkflowRequest) {
      const vm = request.workflowVm;
      const result = (
        run: WorkflowRun | null,
        outcome: WorkflowControlResult["outcome"] = run ? "accepted" : "missing",
        detail: string | null = null,
      ): WorkflowControlResult => ({
        protocol: WORKFLOW_PROTOCOL,
        actions:
          !vm && publishingSupported
            ? actions.canOpenPullRequest
              ? ["push", "open_pull_request"]
              : ["push"]
            : [],
        outcome,
        detail,
        progress: run ? workflowProgress(run) : null,
      });
      if (
        vm &&
        (vm.binding.jobId !== request.jobId ||
          vm.binding.organizationId !== request.control.organizationId ||
          vm.binding.repositoryId !== request.control.repositoryId ||
          vm.binding.projectId !== request.control.projectId ||
          !(yield* store.isVmFenceActive(vm.binding)))
      )
        return result(null, "unavailable", "The VM does not own the workflow thread.");
      if (
        request.control.operation === "start" &&
        (request.control.workflow.definition.target.kind !== (vm ? "vm" : "machine") ||
          request.control.runtime.kind !== (vm ? "vm" : "machine"))
      )
        return result(null, "unavailable", "Invalid workflow execution binding.");
      let run = yield* store.get(request.jobId);
      const savedCancellation = yield* store.getCancellation(request.jobId);
      const requestedBy = request.requestedBy ?? request.userId;
      let origin =
        request.origin ??
        (run && workflowRunOrigin(run).kind === "manual"
          ? workflowRunOrigin(run)
          : savedCancellation?.origin?.kind === "manual"
            ? savedCancellation.origin
            : request.userId
              ? { kind: "manual" as const, userId: request.userId }
              : undefined);
      if (
        !origin ||
        (run && !sameWorkflowOrigin(workflowRunOrigin(run), origin)) ||
        (run && run.repositoryCanonicalKey !== request.repositoryCanonicalKey) ||
        (origin.kind === "automation" &&
          (origin.organizationId !== request.control.organizationId ||
            origin.repositoryId !== request.control.repositoryId ||
            (request.control.operation === "start" &&
              origin.workflowId !== request.control.workflow.workflowId)))
      )
        return result(null, "conflict", "The workflow origin or target does not match this job.");
      if (!["start", "status"].includes(request.control.operation) && !requestedBy)
        return result(null, "conflict", "A human requester is required for this control.");
      // Keep legacy requesters separate from the original execution identity.
      if (
        !vm &&
        requestedBy &&
        !["start", "status", "cancel", "retry_cancellation"].includes(request.control.operation)
      )
        yield* access
          .requireProject(
            { user: { userId: requestedBy, displayName: null, imageUrl: null } },
            request.control.projectId,
          )
          .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
      if (
        !vm &&
        !run &&
        !savedCancellation &&
        origin.kind === "automation" &&
        request.control.operation !== "cancel"
      )
        yield* access
          .requireWorkflowProject({
            ...request.control,
            repositoryCanonicalKey: request.repositoryCanonicalKey,
          })
          .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
      const cancellation =
        request.control.operation === "cancel" && !run
          ? yield* store.cancelBeforeAcceptance({
              jobId: request.jobId,
              ...(request.origin ? { origin } : {}),
              ...request.control,
              repositoryCanonicalKey: request.repositoryCanonicalKey,
              createdAt: yield* timestamp,
            })
          : { run, cancellation: yield* store.getCancellation(request.jobId) };
      run = cancellation.run;
      if (!request.origin) {
        const savedOrigin = run ? workflowRunOrigin(run) : cancellation.cancellation?.origin;
        if (savedOrigin?.kind === "manual") origin = savedOrigin;
      }
      if (
        run &&
        (!sameWorkflowOrigin(workflowRunOrigin(run), origin) ||
          run.repositoryCanonicalKey !== request.repositoryCanonicalKey)
      )
        return result(null, "conflict", "The workflow origin or target does not match this job.");
      if (cancellation.cancellation) {
        const saved = cancellation.cancellation;
        return (saved.origin
          ? sameWorkflowOrigin(saved.origin, origin)
          : origin.kind === "manual") &&
          saved.organizationId === request.control.organizationId &&
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
          run.runtime.projectId !== request.control.projectId ||
          (run.runtime.kind === "vm"
            ? !vm || !sameVmBinding(run.runtime, vm.binding)
            : vm !== undefined))
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
          run.manualPause ||
          run.approvalAttempt
        )
          run = yield* store.save({
            ...run,
            pendingPreparationRetry: null,
            manualPause: null,
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
        const verification = approvalWorkers.get(run.jobId)?.fiber;
        if (verification) yield* Fiber.interrupt(verification).pipe(Effect.forkIn(runnerScope));
        return result(yield* reconcile(run));
      }
      if (request.control.operation === "pause" || request.control.operation === "resume") {
        if (!run) return result(null, "conflict", "Wait for the environment to accept this job.");
        if (!vm)
          yield* access
            .requireProject(
              { user: { userId: requestedBy!, displayName: null, imageUrl: null } },
              run.runtime.projectId,
            )
            .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
        if (isTerminalWorkflowJob(run.progress.status) || run.progress.status === "cancelling")
          return result(run, "conflict", "This job is cancelling or has finished.");
        if (run.progress.approvalPending)
          return result(
            run,
            "conflict",
            "Wait for approval verification to finish, or cancel the run.",
          );
        if (!run.sequence || !run.providerContinuation)
          return result(
            run,
            "unavailable",
            "This legacy job does not support manual Pause/Resume.",
          );
        const control = request.control;
        if (run.lastManualControl?.controlId === control.controlId) {
          if (
            run.lastManualControl.operation !== control.operation ||
            run.lastManualControl.expectedRevision !== control.expectedRevision
          )
            return result(
              run,
              "conflict",
              "This control identity was already used for another request.",
            );
          return result(yield* reconcile(run));
        }
        if (run.progress.revision !== control.expectedRevision)
          return result(
            run,
            "conflict",
            "This job changed. Refresh before changing its pause state.",
          );
        if (
          control.operation === "pause" &&
          (run.manualPause ||
            ![
              "preparing",
              "running",
              "awaiting_review",
              "awaiting_input",
              "waiting_capacity",
            ].includes(run.progress.status))
        )
          return result(run, "conflict", "This job cannot be paused in its current state.");
        if (control.operation === "resume" && !run.manualPause)
          return result(run, "conflict", "This job has no manual pause to resume.");
        const active =
          run.executionReserved && ["preparing", "running"].includes(run.progress.status);
        run = yield* store.save({
          ...run,
          manualPause:
            control.operation === "resume"
              ? null
              : {
                  state: active ? "requested" : "paused",
                  promptId: active ? workflowPromptId(run) : null,
                },
          lastManualControl: {
            operation: control.operation,
            controlId: control.controlId,
            expectedRevision: control.expectedRevision,
          },
          progress: { ...run.progress, revision: run.progress.revision + 1 },
        });
        return result(yield* reconcile(run));
      }
      if (run) run = yield* reconcile(run);
      if (request.control.operation === "status") return result(run);
      if (
        !vm &&
        run &&
        request.control.operation !== "cancel" &&
        request.control.operation !== "start" &&
        !(origin.kind === "automation" && request.control.operation === "retry_cancellation")
      )
        yield* access
          .requireProject(
            { user: { userId: requestedBy!, displayName: null, imageUrl: null } },
            run.runtime.projectId,
          )
          .pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
      if (request.control.operation === "start") {
        if (run) return result(run);
        const workflow = request.control.workflow;
        const target = workflow.definition.target;
        const offered = request.control.runtime;
        const runtime = vm ? { kind: "vm" as const, ...vm.binding } : offered;
        if (
          !(vm
            ? offered.kind === "vm" &&
              offered.threadId === vm.binding.threadId &&
              target.kind === "vm" &&
              (target.baseBranch === null || target.baseBranch === vm.baseBranch)
            : offered.kind === "machine" &&
              target.kind === "machine" &&
              offered.environmentId === target.environmentId &&
              offered.projectId === target.projectId) ||
          !("projectId" in runtime)
        )
          return result(null, "unavailable", "Invalid workflow execution binding.");
        const publishing = workflow.definition.steps.filter((step) => step.kind === "action");
        if (publishing.length && (vm || !publishingSupported))
          return result(
            null,
            "unavailable",
            "This environment does not support the selected publishing steps.",
          );
        if (
          workflow.organizationId !== request.control.organizationId ||
          workflow.repositoryId !== request.control.repositoryId ||
          runtime.projectId !== request.control.projectId
        )
          return result(null, "unavailable", "Invalid workflow target binding.");
        if (yield* store.isExecuting())
          return result(null, "busy", "Another workflow is executing on this environment.");
        if (!vm)
          yield* (
            origin.kind === "automation"
              ? access.requireWorkflowProject({
                  ...request.control,
                  repositoryCanonicalKey: request.repositoryCanonicalKey,
                })
              : access.requireProject(
                  { user: { userId: origin.userId, displayName: null, imageUrl: null } },
                  request.control.projectId,
                )
          ).pipe(Effect.mapError((error) => new WorkflowRunnerError({ message: error.message })));
        const project = yield* query
          .getProjectShellById(request.control.projectId)
          .pipe(Effect.orDie);
        if (Option.isNone(project) || (vm && project.value.workspaceRoot !== vm.workspaceRoot))
          return result(null, "unavailable", "The selected project no longer exists.");
        const identity = yield* identities.resolve(project.value.workspaceRoot);
        if (identity?.canonicalKey !== request.repositoryCanonicalKey)
          return result(
            null,
            "unavailable",
            "The project's repository changed; select its current checkout.",
          );
        if (publishing.length && !workflowPublishingRemote(identity.locator.remoteUrl))
          return result(
            null,
            "unavailable",
            "Publishing requires a remote URL without embedded credentials. Configure runner-held source-control credentials instead.",
          );
        if (
          publishing.some((step) => step.action === "open_pull_request") &&
          (!actions.canOpenPullRequest ||
            !identity ||
            !(yield* actions.canOpenPullRequest({
              cwd: project.value.workspaceRoot,
              remoteName: identity.locator.remoteName,
              remoteUrl: identity.locator.remoteUrl,
            })))
        )
          return result(
            null,
            "unavailable",
            "This repository does not support workflow PR publishing.",
          );
        const steps = workflow.definition.steps.map((step) =>
          step.kind === "agent"
            ? {
                ...step,
                runtimeMode: "approval-required" as const,
                modelSelection: step.modelSelection ?? project.value.defaultModelSelection,
              }
            : step,
        );
        const agents = steps.filter((step) => step.kind === "agent");
        const modelSelection = agents[0]?.modelSelection;
        const providers = yield* registry.getProviders;
        const firstProvider = providers.find(
          (entry) => entry.instanceId === modelSelection?.instanceId,
        );
        let providerContinuation: WorkflowRun["providerContinuation"];
        for (const step of agents) {
          const selection = step.modelSelection;
          const selected = providers.find((entry) => entry.instanceId === selection?.instanceId);
          if (
            !selection ||
            !selected?.enabled ||
            !selected.installed ||
            selected.availability === "unavailable" ||
            !(vm
              ? selected.driver === "codex" && selection.instanceId === "codex"
              : ["codex", "claudeAgent"].includes(selected.driver))
          )
            return result(
              null,
              "unavailable",
              `Select an installed, enabled Codex or Claude provider for ${step.title}.`,
            );
          const info = yield* providersService
            .getInstanceInfo(selection.instanceId)
            .pipe(Effect.option);
          if (
            Option.isNone(info) ||
            !info.value.enabled ||
            info.value.driverKind !== selected.driver
          )
            return result(
              null,
              "unavailable",
              `Provider compatibility could not be verified for ${step.title}.`,
            );
          const identity = {
            driver: info.value.driverKind,
            continuationKey: info.value.continuationIdentity.continuationKey,
          };
          if (
            providerContinuation &&
            (identity.driver !== providerContinuation.driver ||
              identity.continuationKey !== providerContinuation.continuationKey)
          )
            return result(
              null,
              "unavailable",
              `${step.title} must use a compatible ${providerContinuation.driver} provider to continue this job's conversation.`,
            );
          if (
            modelSelection &&
            (selection.instanceId !== modelSelection.instanceId ||
              selection.model !== modelSelection.model) &&
            (firstProvider?.requiresNewThreadForModelChange ||
              selected.requiresNewThreadForModelChange)
          )
            return result(
              null,
              "unavailable",
              `${step.title} cannot change models or provider instances within this job's conversation.`,
            );
          providerContinuation ??= identity;
        }
        if (!modelSelection || !providerContinuation)
          return result(null, "unavailable", "Select a provider for an Agent step.");
        const remote = identity.locator.remoteName;
        let baseBranch: string;
        let baseSha: string;
        if (vm) {
          const thread = yield* query.getThreadDetailById(vm.binding.threadId).pipe(Effect.orDie);
          if (
            Option.isNone(thread) ||
            thread.value.projectId !== vm.binding.projectId ||
            thread.value.worktreePath !== null ||
            thread.value.branch !== jobBranchName(request.jobId) ||
            (yield* readWorkflowHead(git, vm.workspaceRoot, thread.value.branch)) !== vm.baseSha
          )
            return result(
              null,
              "unavailable",
              "The VM checkout no longer matches its starting commit.",
            );
          baseBranch = vm.baseBranch;
          baseSha = vm.baseSha;
        } else {
          yield* git.fetchRemote({ cwd: project.value.workspaceRoot, remoteName: remote });
          const branch = yield* git.resolveDefaultBranchName(project.value.workspaceRoot, remote);
          if (branch === null)
            return result(null, "unavailable", "The remote default branch could not be resolved.");
          baseBranch = branch;
          baseSha = (yield* git.resolveRemoteTrackingCommit({
            cwd: project.value.workspaceRoot,
            refName: baseBranch,
            fallbackRemoteName: remote,
          })).commitSha;
        }
        run = {
          jobId: request.jobId,
          origin,
          userId: origin.kind === "manual" ? origin.userId : null,
          repositoryCanonicalKey: request.repositoryCanonicalKey,
          instruction: request.instruction,
          runtime,
          workflow: {
            ...workflow,
            definition: {
              ...workflow.definition,
              steps,
            },
          },
          providerContinuation,
          ...(publishing.length
            ? {
                actions: [],
                publication: {
                  remoteName: remote,
                  remoteUrl: identity.locator.remoteUrl,
                  publishedHead: null,
                  pullRequestUrl: null,
                },
              }
            : {}),
          sequence: {
            cursor: 0,
            generation: 0,
            started: false,
            stepStartedAt: yield* timestamp,
            completed: [],
            responses: [],
            feedback: null,
          },
          modelSelection,
          baseBranch,
          baseSha,
          createdAt: yield* timestamp,
          promptDispatched: false,
          executionReserved: true,
          worktreePath: vm?.workspaceRoot ?? null,
          preparedHead: null,
          approvedBy: null,
          progress: {
            revision: 0,
            status: "preparing",
            threadId: vm?.binding.threadId ?? ThreadId.make(`workflow:${request.jobId}:agent`),
            detail: null,
            checkpoint: null,
          },
        };
        run = advanceWorkflow(run);
        if (
          !(yield* access.withFence(
            Effect.gen(function* () {
              if (!vm && origin.kind === "automation") yield* requireExecution(run!);
              return yield* store.tryAccept(run!);
            }),
          ))
        ) {
          if (yield* store.getCancellation(request.jobId))
            return result(null, "cancelled", "Cancelled before acceptance.");
          const existing = yield* store.get(request.jobId);
          return result(
            existing,
            existing ? "accepted" : "busy",
            existing ? null : "Another workflow is executing on this environment.",
          );
        }
        run = yield* reconcile(run);
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
            ...(run.runtime.kind === "vm"
              ? {
                  workloadCancellationId:
                    run.cancellationAttempt?.workloadCancellationId ??
                    run.cancellationAttempt?.commandId ??
                    `workflow:${run.jobId}:cancel`,
                }
              : {}),
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
      if (run.manualPause && request.control.operation !== "cancel")
        return result(run, "conflict", "Resume the manual pause before responding or retrying.");
      if (run.approvalAttempt?.response && request.control.operation === "approve") {
        const attempt = run.approvalAttempt;
        const control = request.control;
        if (
          control.checkpointId === attempt.checkpointId &&
          control.expectedRevision === attempt.acceptedRevision &&
          requestedBy === attempt.response!.userId
        )
          return result(run);
        if (
          !run.progress.retryableApproval ||
          control.checkpointId !== attempt.checkpointId ||
          control.expectedRevision !== run.progress.revision
        )
          return result(run, "conflict", "This approval is already being verified or has changed.");
        run = yield* store.save({
          ...run,
          approvalAttempt: {
            ...attempt,
            acceptedRevision: control.expectedRevision,
            commandId: `workflow:${run.jobId}:approve:${control.expectedRevision}`,
          },
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            approvalPending: true,
            retryableApproval: false,
            detail: "Approval accepted; verifying the approved result.",
          },
        });
        return result(yield* reconcileApproval(run));
      }
      if (request.control.operation === "retry_action") {
        const response = request.control;
        const action = run.actions?.find((entry) => entry.actionId === response.actionId);
        const step = activeWorkflowStep(run);
        if (action?.retryRevision === response.expectedRevision) return result(run);
        if (
          !action ||
          step?.kind !== "action" ||
          action.stepId !== step.id ||
          action.generation !== run.sequence?.generation ||
          response.expectedRevision !== run.progress.revision ||
          !["uncertain", "failed"].includes(action.state)
        )
          return result(run, "conflict", "The publishing action changed. Refresh before retrying.");
        if (yield* store.isExecuting(run.jobId))
          return result(run, "busy", "Another workflow is executing.");
        run = yield* store.save({
          ...changeWorkflowAction(run, action.actionId, (entry) => ({
            ...entry,
            state: "running",
            retryRevision: response.expectedRevision,
            detail: null,
          })),
          progress: {
            ...run.progress,
            revision: run.progress.revision + 1,
            status: "waiting_capacity",
            detail: null,
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
      if (
        !run.sequence &&
        request.control.operation === "request_changes" &&
        run.progress.status === "awaiting_review" &&
        !run.approvalAttempt &&
        run.progress.checkpoint?.kind !== "input" &&
        run.progress.checkpoint
      ) {
        run = {
          ...run,
          sequence: {
            cursor: 1,
            generation: 0,
            started: true,
            stepStartedAt: run.createdAt,
            feedback: null,
            responses: [],
            completed: [
              {
                stepId: run.workflow.definition.steps[0]!.id,
                generation: 0,
                checkpoint: run.progress.checkpoint,
                head: run.preparedHead,
              },
            ],
          },
        };
      }
      if (
        run.sequence &&
        ["approve", "input", "request_changes"].includes(request.control.operation)
      ) {
        const control = request.control;
        if (
          control.operation !== "approve" &&
          control.operation !== "input" &&
          control.operation !== "request_changes"
        )
          return result(run, "conflict");
        const previous = run.sequence.responses.find(
          (response) => response.checkpointId === control.checkpointId,
        );
        if (previous && !run.progress.retryableApproval)
          return result(
            run,
            previous.operation === control.operation &&
              previous.userId === requestedBy &&
              previous.text === (control.operation === "approve" ? null : control.text)
              ? "accepted"
              : "conflict",
          );
        // Final completion retries use the existing cleanup attempt; no new response is recorded.
        if (!(control.operation === "approve" && run.progress.retryableApproval)) {
          const checkpoint = run.progress.checkpoint;
          const step = activeWorkflowStep(run);
          if (
            !checkpoint ||
            checkpoint.checkpointId !== control.checkpointId ||
            run.progress.revision !== control.expectedRevision ||
            run.approvalAttempt ||
            (control.operation === "input"
              ? step?.kind !== "input" || run.progress.status !== "awaiting_input"
              : step?.kind !== "review" || run.progress.status !== "awaiting_review")
          )
            return result(run, "conflict", "This checkpoint changed. Refresh before responding.");
          if (control.operation === "approve") {
            if (!run.worktreePath || !run.preparedHead)
              return result(run, "conflict", "The saved result is unavailable. Cancel the run.");
            run = yield* store.save({
              ...run,
              approvalAttempt: {
                approvedBy: requestedBy!,
                checkpointId: control.checkpointId,
                preparedHead: run.preparedHead,
                acceptedRevision: control.expectedRevision,
                commandId: `workflow:${run.jobId}:approve:${control.expectedRevision}`,
                createdAt: yield* timestamp,
                response: {
                  checkpointId: control.checkpointId,
                  stepId: step!.id,
                  generation: run.sequence.generation,
                  operation: "approve",
                  userId: requestedBy!,
                  text: null,
                  createdAt: yield* timestamp,
                },
              },
              progress: {
                ...run.progress,
                revision: run.progress.revision + 1,
                approvalPending: true,
                retryableApproval: false,
                detail: "Approval accepted; verifying the approved result.",
              },
            });
            return result(yield* reconcileApproval(run));
          }
          const sequence = run.sequence;
          const response = {
            checkpointId: control.checkpointId,
            stepId: step!.id,
            generation: sequence.generation,
            operation: control.operation,
            userId: requestedBy!,
            text: control.text,
            createdAt: yield* timestamp,
          };
          if (control.operation === "request_changes" && step?.kind === "review") {
            if (
              !run.worktreePath ||
              !run.preparedHead ||
              (yield* readWorkflowHead(git, run.worktreePath, jobBranchName(run.jobId))) !==
                run.preparedHead
            )
              return result(
                run,
                "conflict",
                "The prepared branch changed. Cancel the job before starting again.",
              );
            const earlier = run.workflow.definition.steps.slice(0, sequence.cursor);
            const target = step.reworkStepId
              ? earlier.findIndex((candidate) => candidate.id === step.reworkStepId)
              : earlier.findLastIndex((candidate) => candidate.kind === "agent");
            if (target < 0) return result(run, "conflict", "The rework target is unavailable.");
            run = advanceWorkflow({
              ...run,
              sequence: {
                ...sequence,
                cursor: target,
                generation: sequence.generation + 1,
                feedback: control.text,
                stepStartedAt: response.createdAt,
                responses: [...sequence.responses, response],
                completed: sequence.completed.filter((entry) =>
                  earlier.slice(0, target).some((candidate) => candidate.id === entry.stepId),
                ),
              },
            });
          } else {
            run = advanceWorkflow({
              ...run,
              sequence: {
                ...sequence,
                cursor: sequence.cursor + 1,
                stepStartedAt: response.createdAt,
                responses: [...sequence.responses, response],
                completed: [
                  ...sequence.completed,
                  {
                    stepId: step!.id,
                    generation: sequence.generation,
                    checkpoint: null,
                    head: null,
                  },
                ],
              },
            });
          }
          yield* store.save(run);
          return result(yield* reconcile(run));
        }
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
        !["awaiting_review", "finishing"].includes(run.progress.status) ||
        run.progress.revision !== request.control.expectedRevision ||
        !checkpoint ||
        checkpoint.checkpointId !== request.control.checkpointId ||
        run.worktreePath === null ||
        run.preparedHead === null ||
        (accepted && !run.progress.retryableApproval)
      )
        return result(run, "conflict", "This review changed. Refresh before approving.");
      const preparation = (yield* readThread(run))?.promptQueue?.preparation;
      const commandId = `workflow:${run.jobId}:approve:${request.control.expectedRevision}`;
      run = yield* store.save({
        ...run,
        approvalAttempt: {
          approvedBy: accepted
            ? accepted.approvedBy
            : run.progress.status === "finishing"
              ? null
              : requestedBy!,
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
    (effect) =>
      Deferred.await(recovered).pipe(
        Effect.andThen(lock.withPermits(1)(effect.pipe(Effect.tap(() => pumpWaiting())))),
      ),
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
                    if (run) {
                      yield* reconcile(run);
                      yield* pumpWaiting();
                    }
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
          yield* pumpWaiting();
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
