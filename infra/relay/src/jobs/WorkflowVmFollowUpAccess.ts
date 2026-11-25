import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import {
  requireWorkflowVmMaintainer,
  requireWorkflowVmViewer,
  workflowVmHasSecrets,
} from "./WorkflowVmBinding.ts";

type FollowUpRun = {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly jobId: string;
};

/** Caller holds a transaction through the corresponding placement or work admission. */
export const requireWorkflowVmFollowUpActor = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: FollowUpRun,
  userId: string,
) {
  const [run] = yield* sql`SELECT 1 FROM relay_workflow_jobs j
    WHERE j.job_id=${scope.jobId} AND j.organization_id=${scope.organizationId}
      AND j.repository_id=${scope.repositoryId} AND j.status IN ('done','failed','cancelled')
      AND j.record#>>'{runtime,kind}'='vm' AND j.record#>>'{progress,status}'=j.status
      AND j.record#>>'{progress,executionReleased}'='true' AND j.pending_control IS NULL
      AND COALESCE(j.record#>'{progress,resultSaving}','null'::jsonb)='null'::jsonb
    FOR SHARE`;
  if (!run) return yield* tenancyNotFound("thread_not_found");
  yield* (yield* workflowVmHasSecrets(sql, scope.jobId))
    ? requireWorkflowVmMaintainer(sql, scope, userId)
    : requireWorkflowVmViewer(sql, scope, userId);
});

export const requireWorkflowVmFollowUpWorkspace = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: FollowUpRun & { readonly allocationId: string; readonly generation: number },
  purpose: "prepare" | "work" = "work",
) {
  const [open] = yield* sql<{ ready: boolean }>`SELECT
    COALESCE(interactive_ready_generation=generation,false) AS ready
    FROM relay_workflow_vm_follow_ups
    WHERE job_id=${scope.jobId} AND allocation_id=${scope.allocationId} AND generation=${scope.generation}
      AND reclaim_operation_id IS NULL AND operation_id IS NULL AND actor_user_id IS NOT NULL
      ${purpose === "prepare" ? sql`` : sql`AND interactive_ready_generation=generation`} FOR SHARE`;
  if (!open) return yield* tenancyNotFound("thread_not_found");
  return open;
});

/** Released workflows serve their immutable saved result without a live viewer socket. */
export const requireWorkflowVmLiveViewer = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: FollowUpRun,
  userId: string,
) {
  const [released] = yield* sql`SELECT 1 FROM relay_workflow_jobs
    WHERE job_id=${scope.jobId} AND organization_id=${scope.organizationId}
      AND repository_id=${scope.repositoryId} AND status IN ('done','failed','cancelled')
      AND record#>>'{progress,executionReleased}'='true'`;
  if (released) return yield* tenancyNotFound("thread_not_found");
  yield* requireWorkflowVmViewer(sql, scope, userId);
});
