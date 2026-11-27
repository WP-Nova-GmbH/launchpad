import {
  workflowIsFinishing,
  type RepositoryWorkflowJobSummary,
  type WorkflowJobProgress,
  type WorkflowQueueReason,
} from "@t3tools/contracts/workflows";
import { sql } from "drizzle-orm";
import { relayWorkflowJobs as jobs } from "../persistence/schema.ts";

export interface WorkflowFinalChecks {
  stepIds: readonly string[];
  steps: WorkflowJobProgress["steps"] | null;
  detail: string | null;
  retryableApproval: boolean | null;
  approvalPending: boolean;
}

const pendingOperation = sql`${jobs.pendingControl}#>>'{response,operation}'`;
export const cancellationState = sql<NonNullable<
  RepositoryWorkflowJobSummary["cancellationState"]
> | null>`
  CASE WHEN ${jobs.status} = 'cancelling' THEN
    CASE WHEN ${pendingOperation} IS NOT NULL THEN 'pending'
      WHEN ${jobs.record}#>>'{progress,retryableCancellation}' = 'true' THEN 'retry_needed'
    END
  END`;
export const queueReasonCode = sql<
  WorkflowQueueReason["code"] | null
>`${jobs.summary}#>>'{queueReason,code}'`;
export const summaryNeedsAttention = sql<boolean>`(
  (${jobs.summary}->>'needsAttention' = 'true' AND ${queueReasonCode} IS DISTINCT FROM 'vm_waiting_capacity')
  OR (${jobs.status} = 'preparing' AND ${queueReasonCode} NOT IN (
    'environment_offline', 'environment_busy', 'source_unavailable', 'source_rate_limited', 'workflow_changed', 'vm_waiting_capacity'
  ))
) IS TRUE`;
export const manualPauseState = sql<NonNullable<
  RepositoryWorkflowJobSummary["manualPauseState"]
> | null>`
  CASE WHEN ${jobs.status} IN ('preparing','running','awaiting_input','awaiting_review','waiting_capacity','paused') THEN
    CASE coalesce(${pendingOperation}, ${jobs.record}#>>'{pendingManualControl,operation}')
      WHEN 'pause' THEN 'pause_requested'
      WHEN 'resume' THEN 'resume_requested'
      ELSE CASE ${jobs.record}#>>'{progress,manualPause,state}'
        WHEN 'requested' THEN 'pause_requested'
        WHEN 'paused' THEN 'paused'
      END
    END
  END`;
// Match canReplaceBlockedCheckpoint in WorkflowsApi. Retry saving stays available
// when the VM checkpoint response has never reached the executor.
const blockedByRetryableSave = sql<boolean>`(
  ${jobs.record}#>>'{runtime,kind}' = 'vm'
  AND ${jobs.pendingControl}->>'responseId' IS NOT NULL
  AND ${jobs.pendingControl}->>'checkpointDispatch' IS NULL
  AND ${jobs.record}#>>'{progress,resultSaving,state}' = 'failed'
  AND ${jobs.record}#>>'{progress,resultSaving,retryable}' = 'true'
)`;
export const checkpointResponsePending = sql<boolean>`(
  (${jobs.status} = 'awaiting_review'
    AND ${jobs.record}#>>'{progress,approvalPending}' = 'true')
  OR (
    ((${jobs.status} = 'awaiting_input' AND ${pendingOperation} = 'input')
      OR (${jobs.status} = 'awaiting_review' AND ${pendingOperation} IN ('request_changes', 'approve')))
      AND ${blockedByRetryableSave} IS NOT TRUE
  )
) IS TRUE`;
const approvalPending = sql<boolean>`(
  ${pendingOperation} = 'approve'
  OR ${jobs.record}#>>'{progress,approvalPending}' = 'true'
) IS TRUE`;
export const resultSave = sql`${jobs.record}#>'{progress,resultSaving}'`;
export const resultSaveState = sql<RepositoryWorkflowJobSummary["completionState"] | null>`
  CASE WHEN ${jobs.status} IN ('awaiting_input', 'awaiting_review', 'finishing') THEN
    CASE ${resultSave}->>'state'
      WHEN 'saving' THEN 'saving_result'
      WHEN 'failed' THEN
        CASE WHEN ${pendingOperation} = 'retry_saving'
          AND ${jobs.pendingControl}#>>'{response,publicationId}' = ${resultSave}->>'publicationId'
          THEN 'retrying_save' ELSE 'save_failed' END
    END
  END`;
export const finalChecks = sql<WorkflowFinalChecks | null>`
  CASE WHEN ${jobs.status} IN ('awaiting_review', 'finishing') THEN jsonb_build_object(
    'stepIds', jsonb_path_query_array(${jobs.record}, '$.workflow.definition.steps[*].id'),
    'steps', ${jobs.record}#>'{progress,steps}',
    'detail', ${jobs.record}#>>'{progress,detail}',
    'retryableApproval', ${jobs.record}#>'{progress,retryableApproval}',
    'approvalPending', ${approvalPending}
  ) END`;

export function workflowRunCompletionState(
  status: RepositoryWorkflowJobSummary["status"],
  resultSaveState: RepositoryWorkflowJobSummary["completionState"] | null,
  finalChecks: WorkflowFinalChecks | null,
) {
  let completionState = resultSaveState;
  if (
    !completionState &&
    finalChecks &&
    workflowIsFinishing({
      status,
      workflow: { definition: { steps: finalChecks.stepIds.map((id) => ({ id })) } },
      progress: { steps: finalChecks.steps ?? undefined },
    })
  ) {
    // The detail client clears retryableApproval for cancel-only messages. Those
    // messages still indicate a blocked completion even when retry is unavailable.
    const blocked =
      !finalChecks.approvalPending &&
      (finalChecks.retryableApproval === true || !!finalChecks.detail?.trim());
    completionState = blocked ? "completion_blocked" : "finishing";
  }
  return completionState;
}
