import type { WorkflowRun } from "./WorkflowRunStore.ts";

/** Terminal status alone does not release a saved execution or cleanup intent. */
export const ownershipReleased = (
  run: Pick<
    WorkflowRun,
    | "progress"
    | "executionReserved"
    | "manualPause"
    | "approvalAttempt"
    | "cancellationAttempt"
    | "pendingQueueDismissal"
    | "pendingPreparationRetry"
    | "actions"
  >,
) =>
  ["done", "cancelled", "failed"].includes(run.progress.status) &&
  !run.executionReserved &&
  !run.manualPause &&
  !run.approvalAttempt &&
  !run.cancellationAttempt &&
  !run.pendingQueueDismissal &&
  !run.pendingPreparationRetry &&
  !run.actions?.some((action) => action.commands.some((command) => !command.stopped));
