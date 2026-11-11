import type { ThreadPromptQueue } from "@t3tools/contracts";
import {
  WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT,
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
} from "@t3tools/contracts/workflows";
import type { WorkflowRun } from "./WorkflowRunStore.ts";

export const activeWorkflowStep = (run: WorkflowRun) =>
  run.workflow.definition.steps[run.sequence?.cursor ?? 0];

export function workflowPromptId(run: WorkflowRun) {
  const sequence = run.sequence;
  return !sequence ||
    (sequence.generation === 0 && !sequence.completed.some((step) => step.checkpoint))
    ? `workflow:${run.jobId}:prompt`
    : `workflow:${run.jobId}:step:${activeWorkflowStep(run)?.id}:${sequence.generation}:prompt`;
}

/** A requested hold permits only the already-reserved Agent step to finish. */
export const workflowAllowsPrompt = (run: WorkflowRun, messageId: string) =>
  !run.manualPause ||
  (run.manualPause.state === "requested" && run.manualPause.promptId === messageId);

export const admittedWorkflowTurnId = (queue: ThreadPromptQueue | undefined, promptId: string) =>
  queue?.admissions.find((entry) => entry.messageId === promptId)?.turnId;

export const workflowTurnPauseDetails = {
  unknownResult:
    "The admitted turn was resolved without a confirmed result. Cancel this job before starting again.",
  incompleteResult:
    "The agent turn stopped without a complete result. Cancel this job before starting again.",
  stoppedTurn:
    "The admitted turn could not be reattached after stopping. Cancel this job before starting again.",
  missingCheckpoint:
    "The result checkpoint could not be saved. Cancel this job before starting again.",
  unconfirmedDelivery:
    "Prompt delivery could not be confirmed. Cancel this job before starting again.",
};
const recoverableTurnPauses = new Set([
  ...Object.values(workflowTurnPauseDetails),
  "The admitted turn could not be reconciled. Cancel this job before starting again.",
]);

export function canRecoverPausedWorkflowTurn(run: WorkflowRun) {
  return (
    run.progress.status === "paused" &&
    run.executionReserved &&
    run.progress.detail !== null &&
    recoverableTurnPauses.has(run.progress.detail) &&
    !run.progress.retryablePreparation &&
    !run.pendingPreparationRetry &&
    !run.cancellationAttempt &&
    !run.pendingQueueDismissal &&
    !run.approvalAttempt &&
    activeWorkflowStep(run)?.kind === "agent" &&
    workflowAllowsPrompt(run, workflowPromptId(run))
  );
}

/** Move only after saving the current step's result or human response. */
export function advanceWorkflow(run: WorkflowRun): WorkflowRun {
  const sequence = run.sequence!;
  const step = activeWorkflowStep(run);
  const latestResult = sequence.completed.findLast((entry) => entry.checkpoint !== null);
  const status = !step
    ? "finishing"
    : step.kind === "agent" || step.kind === "action"
      ? "waiting_capacity"
      : step.kind === "input"
        ? "awaiting_input"
        : "awaiting_review";
  const checkpointId = step
    ? `workflow:${run.jobId}:checkpoint:${step.id}:${sequence.generation}`
    : `workflow:${run.jobId}:completion:${sequence.generation}`;
  const checkpoint =
    step?.kind === "input"
      ? {
          checkpointId,
          kind: "input" as const,
          stepId: step.id,
          generation: sequence.generation,
          role: step.role,
          question: step.question,
        }
      : (step?.kind === "review" || !step) && latestResult?.checkpoint
        ? {
            ...latestResult.checkpoint,
            checkpointId,
            kind: "review" as const,
            stepId: step?.id ?? latestResult.stepId,
            generation: sequence.generation,
            role: step?.kind === "review" ? step.role : ("maintainer" as const),
          }
        : null;
  return {
    ...run,
    promptDispatched: false,
    executionReserved: false,
    preparedHead: run.preparedHead ?? latestResult?.head ?? null,
    progress: {
      ...run.progress,
      revision: run.progress.revision + 1,
      status,
      stepId: step?.id,
      generation: sequence.generation,
      checkpoint,
      approvalPending: false,
      retryableApproval: false,
      retryablePreparation: false,
      detail: status === "waiting_capacity" ? "Waiting for executor capacity." : null,
    },
  };
}

/** Summaries are bounded; full answers remain in the environment's durable record. */
export function workflowProgress(run: WorkflowRun): WorkflowRun["progress"] {
  const sequence = run.sequence;
  if (!sequence) return { ...run.progress, manualPauseSupported: false };
  const pause = run.manualPause;
  const progress = {
    ...run.progress,
    manualPauseSupported: Boolean(run.providerContinuation),
    manualPause: pause ? { state: pause.state } : null,
    underlyingStatus: run.progress.status,
    lastManualControl: run.lastManualControl ?? null,
    ...(pause?.state === "paused" ? { status: "paused" as const } : {}),
  };
  return {
    ...progress,
    hasThread: sequence.started,
    steps: run.workflow.definition.steps.map((step, index) => ({
      stepId: step.id,
      generation:
        sequence.completed.find((entry) => entry.stepId === step.id)?.generation ??
        sequence.generation,
      status: sequence.completed.some((entry) => entry.stepId === step.id)
        ? ("completed" as const)
        : index === sequence.cursor && !["cancelled", "failed"].includes(run.progress.status)
          ? ["running", "preparing"].includes(run.progress.status)
            ? ("running" as const)
            : ("waiting" as const)
          : ("pending" as const),
    })),
    pullRequestUrl: run.publication?.pullRequestUrl ?? null,
    actions: (run.actions ?? []).slice(-32).map((action) => ({
      ...(action.retryRevision !== undefined ? { retryRevision: action.retryRevision } : {}),
      actionId: action.actionId,
      stepId: action.stepId,
      generation: action.generation,
      operation: action.operation,
      state: action.state,
      detail: action.detail?.slice(0, 500) ?? null,
      commitSha: action.commitSha,
      pullRequestUrl: action.pullRequestUrl,
      retryable: ["uncertain", "failed"].includes(action.state),
    })),
    responses: sequence.responses.slice(-WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT).map((response) => ({
      ...response,
      text: response.text?.slice(0, WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT) ?? null,
    })),
  };
}
