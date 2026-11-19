import {
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  isTerminalWorkflowJob,
  type WorkflowControl,
  type WorkflowJobProgress,
  type RepositoryWorkflowJob,
  type WorkflowManualControl,
  type WorkflowVmRecovery,
} from "@t3tools/contracts/workflows";

export interface WorkflowDraftSubmission {
  readonly checkpointId: string | null;
  readonly operation: WorkflowControl["operation"];
  readonly userId: string | null | undefined;
  readonly text: string | null;
}

export function workflowViewerControls(job: RepositoryWorkflowJob | null, canConfigure: boolean) {
  if (job?.progress?.resultSaving && job.progress.resultSaving.state !== "saved") {
    const controls = job.viewerControls;
    return { canCancel: controls?.canCancel ?? canConfigure, canApprove: false, canRespond: false };
  }
  if (job?.viewerControls) return job.viewerControls;
  if (!job || job.vmAdmission || job.runtime?.kind === "vm")
    return { canCancel: false, canApprove: false, canRespond: false };
  const checkpointAllowed = canConfigure || job.progress?.checkpoint?.role === "member";
  return { canCancel: canConfigure, canApprove: checkpointAllowed, canRespond: checkpointAllowed };
}

export function workflowApprovalPending(job: RepositoryWorkflowJob | null): boolean {
  return job?.pendingResponseOperation === "approve" || job?.progress?.approvalPending === true;
}

const workflowVmRecoveryCopy = {
  paused: {
    title: "Workflow VM paused",
    message: "The VM resumes when an authorized response is submitted.",
  },
  saved: {
    title: "Workflow VM saved",
    message: "The VM restores its saved workspace when an authorized response is submitted.",
  },
  waiting_capacity: {
    title: "Waiting for a VM slot",
    message: "The response is queued. The workflow continues when a slot is available.",
  },
  waiting_codex: {
    title: "Waiting for a Codex connection",
    message: "Reconnect this run’s original Codex account to continue.",
  },
  resuming: {
    title: "Resuming workflow VM",
    message: "The response will be applied when the VM is ready.",
  },
  restoring: {
    title: "Restoring workflow VM",
    message: "The response will be applied when the workspace is ready.",
  },
  recovery_error: {
    title: "Workflow VM recovery needs attention",
    message: "The run needs a recoverable workspace before it can continue.",
  },
} satisfies Record<WorkflowVmRecovery["state"], { title: string; message: string }>;

export function workflowVmRecoveryDisplay(
  recovery: WorkflowVmRecovery | undefined,
  responsePending = false,
) {
  if (!recovery) return null;
  const copy = workflowVmRecoveryCopy[recovery.state];
  const sleeping = recovery.state === "paused" || recovery.state === "saved";
  return {
    title: copy.title,
    message:
      sleeping && responsePending
        ? "The response is queued. It will be applied when the VM is ready."
        : (recovery.detail ?? copy.message),
    pending:
      recovery.state === "waiting_capacity" ||
      recovery.state === "waiting_codex" ||
      recovery.state === "resuming" ||
      recovery.state === "restoring",
    warning: recovery.state === "recovery_error",
  };
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
  const recovery = workflowVmRecoveryDisplay(job?.vmRecovery, responsePending);
  const approvalPending =
    !!job && !isTerminalWorkflowJob(job.status) && workflowApprovalPending(job);
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
      !recovery &&
      !pending &&
      !responsePending &&
      !hold &&
      !progress.approvalPending &&
      ["preparing", "running", "awaiting_review", "awaiting_input", "waiting_capacity"].includes(
        status!,
      ),
    canResume: eligible && !recovery && !pending && !responsePending && Boolean(hold),
    checkpointBlocked: Boolean(
      pending || hold || responsePending || recovery?.pending || recovery?.warning,
    ),
    responsePending,
    recovery,
    status,
    message: pending
      ? `${pending.operation === "pause" ? "Pause" : "Resume"} requested; waiting for the environment.`
      : approvalPending
        ? "Approval pending; waiting for the environment."
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
