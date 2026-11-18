import type { PgClient } from "@effect/sql-pg/PgClient";
import { normalizeStoredWorkflowJob } from "@t3tools/shared/workflowStorage";
import * as Effect from "effect/Effect";
import {
  requireWorkflowVmMaintainer,
  requireWorkflowVmViewer,
  workflowVmHasSecrets,
} from "./WorkflowVmBinding.ts";
import type { WorkflowJobRecord } from "./Workflows.ts";

export function isWorkflowCheckpointResponse<T extends { operation: string }>(
  response: T,
): response is Extract<T, { operation: "approve" | "input" | "request_changes" }> {
  return (
    response.operation === "approve" ||
    response.operation === "input" ||
    response.operation === "request_changes"
  );
}

export function pendingWorkflowVmCheckpoint(row: WorkflowJobRecord) {
  const pending = row.pendingControl;
  if (
    !row.record.vmAdmission ||
    row.record.runtime?.kind !== "vm" ||
    !pending?.responseId ||
    !isWorkflowCheckpointResponse(pending.response)
  )
    return null;
  const progress = row.record.progress;
  const checkpoint = progress?.checkpoint;
  const status = pending.response.operation === "input" ? "awaiting_input" : "awaiting_review";
  if (
    row.status !== status ||
    progress?.status !== status ||
    !checkpoint ||
    checkpoint.checkpointId !== pending.response.checkpointId ||
    progress.revision !== pending.response.expectedRevision ||
    progress.approvalPending ||
    progress.manualPause ||
    progress.resultSaving
  )
    return null;
  return { ...pending, responseId: pending.responseId, response: pending.response, checkpoint };
}

export function pendingWorkflowVmPublishingRetry(row: WorkflowJobRecord) {
  const pending = row.pendingControl;
  const progress = row.record.progress;
  if (
    !row.record.vmAdmission ||
    row.record.runtime?.kind !== "vm" ||
    !pending?.responseId ||
    pending.response.operation !== "retry_action" ||
    row.status !== "paused" ||
    progress?.status !== "paused" ||
    progress.manualPause ||
    progress.revision !== pending.response.expectedRevision
  )
    return null;
  const actionId = pending.response.actionId;
  const action = progress.actions?.findLast((entry) => entry.actionId === actionId);
  if (
    !action?.retryable ||
    action.generation !== progress.generation ||
    action.stepId !== progress.stepId
  )
    return null;
  return { ...pending, responseId: pending.responseId, response: pending.response, action };
}

export function restoreSupersededWorkflowCheckpoint(pending: WorkflowJobRecord["pendingControl"]) {
  const superseded = pending?.supersededCheckpoint;
  if (!superseded) return null;
  const { dispatch, ...response } = superseded;
  return { ...response, checkpointDispatch: dispatch };
}

/** In a transaction, lock job before placement, as guest receipts do. */
export const lockWorkflowVmCheckpoint = Effect.fnUntraced(function* (sql: PgClient, jobId: string) {
  const [row] =
    yield* sql<WorkflowJobRecord>`SELECT job_id AS "jobId", organization_id AS "organizationId",
    repository_id AS "repositoryId", submitter_user_id AS "submitterUserId", status, record,
    repository_canonical_key AS "repositoryCanonicalKey", pending_control AS "pendingControl",
    revision, lease_until AS "leaseUntil", created_at AS "createdAt", checked_at AS "checkedAt"
    FROM relay_workflow_jobs WHERE job_id=${jobId} FOR NO KEY UPDATE`;
  if (!row) return null;
  yield* sql`SELECT thread_id FROM relay_thread_placements WHERE workflow_job_id=${jobId}
    AND organization_id=${row.organizationId} AND repository_id=${row.repositoryId}
    AND audience='repository' FOR UPDATE`;
  return { ...row, record: normalizeStoredWorkflowJob(row.record) };
});

export const authorizeWorkflowVmCheckpoint = Effect.fnUntraced(function* (
  sql: PgClient,
  row: WorkflowJobRecord,
) {
  const pending = pendingWorkflowVmCheckpoint(row);
  if (!pending) return null;
  const memberMayRespond =
    pending.checkpoint.role === "member" &&
    (pending.response.operation === "approve" || !(yield* workflowVmHasSecrets(sql, row.jobId)));
  return yield* (
    memberMayRespond
      ? requireWorkflowVmViewer(sql, row, pending.userId)
      : requireWorkflowVmMaintainer(sql, row, pending.userId)
  ).pipe(
    Effect.as(pending),
    Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
  );
});

export const authorizeWorkflowVmPublishingRetry = Effect.fnUntraced(function* (
  sql: PgClient,
  row: WorkflowJobRecord,
) {
  const pending = pendingWorkflowVmPublishingRetry(row);
  if (!pending) return null;
  return yield* requireWorkflowVmMaintainer(sql, row, pending.userId).pipe(
    Effect.as(pending),
    Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
  );
});
