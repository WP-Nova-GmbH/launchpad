import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { requireWorkflowVmFollowUpActor } from "../jobs/WorkflowVmFollowUpAccess.ts";
import { tenancyConflict } from "../http/tenancyErrors.ts";

/** Use with placement t and workflow job j in scope. */
export const workflowVmExecutionReleased = (
  sql: PgClient,
) => sql`j.status IN ('done','failed','cancelled')
  AND j.pending_control IS NULL AND j.record#>>'{progress,executionReleased}'='true'
  AND COALESCE(j.record#>'{progress,resultSaving}','null'::jsonb)='null'::jsonb
  AND j.record#>>'{runtime,threadId}'=t.thread_id`;

/** Use with saved disk d and its exact backup b in scope. */
export const latestWorkflowVmSavedDiskRestore = (sql: PgClient) => sql`
  SELECT attempt.phase,attempt.error_code FROM relay_thread_vm_restores attempt
  WHERE attempt.thread_id=d.thread_id AND attempt.saved_disk_operation_id=d.operation_id
    AND attempt.source_template_id=b.source_template_id AND attempt.source_build_id=b.source_build_id
    AND attempt.phase IN ('aborted','completed')
  ORDER BY attempt.created_at DESC,attempt.operation_id DESC LIMIT 1`;

/** Capacity selection and admission share this test. The resume/restore workers recheck role. */
export const hasWorkflowVmFollowUpRequest = (sql: PgClient) => sql`EXISTS (
  SELECT 1 FROM relay_workflow_vm_follow_ups f
  JOIN relay_organization_members m ON m.user_id=f.actor_user_id AND m.organization_id=t.organization_id
  LEFT JOIN relay_workflow_run_configurations cfg ON cfg.job_id=j.job_id
  WHERE f.job_id=j.job_id AND f.operation_id=c.operation_id AND f.allocation_id=a.allocation_id
    AND f.generation=t.generation AND f.reclaim_operation_id IS NULL
    AND ${workflowVmExecutionReleased(sql)}
    AND ((c.kind='resume' AND t.operation_id IS NULL AND EXISTS(
      SELECT 1 FROM relay_thread_vm_resumes r WHERE r.operation_id=c.operation_id
        AND r.allocation_id=a.allocation_id AND r.generation=t.generation AND r.phase='waiting'
        AND r.retry_at<=clock_timestamp() AND r.connect_claim_id IS NULL))
      OR (c.kind='create' AND t.operation_id=c.operation_id AND EXISTS(
        SELECT 1 FROM relay_thread_vm_restores r WHERE r.operation_id=c.operation_id
          AND r.allocation_id=a.allocation_id AND r.host_id=c.host_id AND r.serving_requested
          AND r.retry_at<=clock_timestamp() AND
            ((r.generation=t.generation AND r.phase IN ('pending','preparing','prepared'))
              OR (r.phase='committed' AND r.target_generation=t.generation AND r.committed_at IS NOT NULL
                AND a.compute_ref IS NULL AND c.compute_ref IS NULL AND r.boot_create_started_at IS NULL
                AND r.boot_receipt IS NULL AND r.boot_recovery_started_at IS NULL
                AND r.boot_ingress_recovery_claim_id IS NULL)))))
    AND (m.role='admin' OR EXISTS(SELECT 1 FROM relay_repository_access grant_access
      WHERE grant_access.user_id=m.user_id AND grant_access.organization_id=t.organization_id
        AND grant_access.repository_id=t.repository_id
        AND (grant_access.role='maintainer' OR (grant_access.role='developer' AND cfg.has_secrets=false))))
)`;

const readWorkflowVmFollowUpRequest = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { jobId: string; organizationId: string; repositoryId: string },
  operationId?: string,
) {
  const [request] = yield* sql<{ operationId: string; userId: string }>`SELECT
    f.operation_id AS "operationId",f.actor_user_id AS "userId"
    FROM relay_workflow_vm_follow_ups f
    JOIN relay_workflow_jobs j ON j.job_id=f.job_id
    JOIN relay_codex_vm_connections x ON x.organization_id=j.organization_id
      AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
    JOIN relay_thread_placements t ON t.workflow_job_id=j.job_id AND t.organization_id=j.organization_id
      AND t.repository_id=j.repository_id AND t.audience='repository'
    WHERE f.job_id=${scope.jobId} AND j.organization_id=${scope.organizationId} AND j.repository_id=${scope.repositoryId}
      AND f.generation=t.generation AND f.operation_id IS NOT NULL AND f.actor_user_id IS NOT NULL
      AND f.reclaim_operation_id IS NULL AND ${workflowVmExecutionReleased(sql)}
      AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
      ${operationId === undefined ? sql`` : sql`AND f.operation_id=${operationId}`}
    FOR SHARE OF x`;
  return request ?? null;
});

export const authorizeWorkflowVmFollowUpRequest = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { jobId: string; organizationId: string; repositoryId: string },
  operationId?: string,
) {
  const request = yield* readWorkflowVmFollowUpRequest(sql, scope, operationId);
  if (!request) return null;
  return yield* requireWorkflowVmFollowUpActor(sql, scope, request.userId).pipe(
    Effect.as(request),
    Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
  );
});

/**
 * Call in the placement/guest admission transaction, only for a newly accepted mutable action.
 * A later workspace snapshot can no longer use a backup from before this admission.
 */
export const recordWorkflowVmFollowUpWork = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { jobId: string; allocationId: string; generation: number },
) {
  const [row] = yield* sql`UPDATE relay_workflow_vm_follow_ups
    SET workspace_revision=workspace_revision+1
    WHERE job_id=${scope.jobId} AND allocation_id=${scope.allocationId} AND generation=${scope.generation}
      AND reclaim_operation_id IS NULL RETURNING job_id`;
  if (!row) return yield* tenancyConflict("thread_placement_changed");
});
