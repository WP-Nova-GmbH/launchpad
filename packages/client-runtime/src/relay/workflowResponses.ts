import {
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  isTerminalWorkflowJob,
  type WorkflowControl,
  type WorkflowJobProgress,
  type RepositoryWorkflowJob,
  type WorkflowManualControl,
} from "@t3tools/contracts/workflows";

export interface WorkflowDraftSubmission {
  readonly checkpointId: string | null;
  readonly operation: WorkflowControl["operation"];
  readonly userId: string | null | undefined;
  readonly text: string | null;
}

/** Clear only the submitted draft, after exact durable evidence; edits made during delivery survive. */
export function clearAcknowledgedWorkflowDraft(
  drafts: Record<string, string>,
  submitted: WorkflowDraftSubmission,
  progress: WorkflowJobProgress | null | undefined,
): Record<string, string> {
  const { checkpointId, operation, userId, text } = submitted;
  if (
    !checkpointId ||
    !userId ||
    text === null ||
    !["input", "request_changes"].includes(operation) ||
    text.length >= WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT ||
    drafts[checkpointId] !== text
  )
    return drafts;
  // Ceiling-length summaries carry no truncation marker and cannot establish an exact match.
  const acknowledged = progress?.responses?.some(
    (response) =>
      response.checkpointId === checkpointId &&
      response.operation === operation &&
      response.userId === userId &&
      response.text === text &&
      response.text.length < WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  );
  if (!acknowledged) return drafts;
  const next = { ...drafts };
  delete next[checkpointId];
  return next;
}

/** Derive shared actions from durable executor/relay state, including older environments. */
export function workflowManualControlState(job: RepositoryWorkflowJob | null) {
  const progress = job?.progress;
  const hold = progress?.manualPause;
  const pending = job?.pendingManualControl;
  const responsePending = job?.responsePending === true && !isTerminalWorkflowJob(job.status);
  const status = progress?.underlyingStatus ?? progress?.status;
  const eligible =
    progress?.manualPauseSupported === true &&
    job?.status !== "cancelling" &&
    job?.status !== "done" &&
    job?.status !== "cancelled" &&
    job?.status !== "failed";
  return {
    canPause:
      eligible &&
      !pending &&
      !responsePending &&
      !hold &&
      !progress.approvalPending &&
      ["preparing", "running", "awaiting_review", "awaiting_input", "waiting_capacity"].includes(
        status!,
      ),
    canResume: eligible && !pending && !responsePending && Boolean(hold),
    checkpointBlocked: Boolean(pending || hold || responsePending),
    responsePending,
    status,
    message: pending
      ? `${pending.operation === "pause" ? "Pause" : "Resume"} requested; waiting for the environment.`
      : responsePending
        ? "Response pending; waiting for the environment."
        : hold?.state === "paused"
          ? "Paused. Setup and previews remain running."
          : hold?.state === "requested"
            ? status === "paused"
              ? "Pause is waiting for recovery. Resume preserves the existing failure."
              : "Pausing after the current automatic step, including its preparation."
            : null,
  };
}

export interface WorkflowManualSubmission {
  readonly jobId: string;
  readonly control: WorkflowManualControl;
}

/** Keep a lost-reply identity until refreshed durable state proves acceptance or a stale revision. */
export function workflowManualSubmission(
  previous: WorkflowManualSubmission | null,
  job: RepositoryWorkflowJob,
  operation: WorkflowManualControl["operation"],
  createId: () => string,
): WorkflowManualSubmission {
  const revision = job.progress!.revision;
  if (
    previous?.jobId === job.jobId &&
    previous.control.operation === operation &&
    job.progress?.lastManualControl?.controlId !== previous.control.controlId &&
    (job.pendingManualControl?.controlId === previous.control.controlId ||
      previous.control.expectedRevision === revision)
  )
    return previous;
  return {
    jobId: job.jobId,
    control: { operation, controlId: createId(), expectedRevision: revision },
  };
}

export function workflowActionState(job: RepositoryWorkflowJob | null) {
  const progress = job?.progress;
  const action = progress?.actions?.findLast(
    (entry) => entry.stepId === progress.stepId && entry.generation === progress.generation,
  );
  return {
    action,
    canRetry: Boolean(
      action?.retryable &&
      job?.status === "paused" &&
      !progress?.manualPause &&
      !job.pendingManualControl &&
      !job.responsePending,
    ),
  };
}
