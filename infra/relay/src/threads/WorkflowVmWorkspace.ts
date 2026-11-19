import type {
  WorkflowRecoveryManifest,
  WorkflowVmDispatchBinding,
} from "@t3tools/contracts/workflows";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

/** The placement's run keeps its workspace until execution and cleanup are released. */
export const workflowOwnsWorkspace = (sql: PgClient) => sql`EXISTS(
  SELECT 1 FROM relay_workflow_jobs j WHERE j.job_id=t.workflow_job_id
    AND (j.status NOT IN ('done','failed','cancelled')
      OR j.record#>>'{progress,executionReleased}' IS DISTINCT FROM 'true'))`;

/** Call with placement locked. A queued response doesn't change the checkpoint. */
export const readCurrentWorkflowCheckpoint = Effect.fnUntraced(function* (
  sql: PgClient,
  checkpoint: RelayThreadVmWorkflowCheckpoint,
  sourceLost = false,
) {
  const [row] = yield* sql<{ pending: boolean }>`
    SELECT j.pending_control IS NOT NULL AS pending
    FROM relay_workflow_jobs j JOIN relay_workflow_recovery_heads h USING(job_id)
    WHERE j.job_id=${checkpoint.jobId} AND (j.status IN ('awaiting_input','awaiting_review')
      OR (${sourceLost} AND j.status='cancelling' AND j.pending_control#>>'{response,operation}'='cancel'))
      AND j.record#>>'{progress,checkpoint,checkpointId}'=${checkpoint.checkpointId}
      AND COALESCE((j.record#>>'{progress,checkpoint,generation}')::int,0)=${checkpoint.checkpointGeneration}
      AND h.publication_id=${checkpoint.publicationId} AND h.revision=${checkpoint.publicationRevision}`;
  return row ?? null;
});

export const readWorkflowRestorePublication = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
  checkpoint: RelayThreadVmWorkflowCheckpoint,
) {
  const [row] = yield* sql<{ manifest: WorkflowRecoveryManifest; manifestArtifactId: string }>`
    SELECT manifest,manifest_artifact_id AS "manifestArtifactId"
    FROM relay_workflow_recovery_records WHERE thread_id=${threadId}
      AND job_id=${checkpoint.jobId} AND publication_id=${checkpoint.publicationId}
      AND revision=${checkpoint.publicationRevision}`;
  return row ?? null;
});

/** After replacement, wait for the fresh guest to publish the rebound run. */
export const hasReboundWorkflowCheckpoint = Effect.fnUntraced(function* (
  sql: PgClient,
  binding: WorkflowVmDispatchBinding,
) {
  if (binding.generation === 1) return true;
  const [row] = yield* sql`SELECT 1 FROM relay_workflow_recovery_heads h
    JOIN relay_workflow_recovery_records r ON r.publication_id=h.publication_id
      AND r.job_id=h.job_id AND r.revision=h.revision
    WHERE h.job_id=${binding.jobId} AND r.thread_id=${binding.threadId}
      AND r.manifest#>>'{binding,environmentId}'=${binding.environmentId}
      AND r.manifest#>>'{binding,allocationId}'=${binding.allocationId}
      AND r.manifest#>>'{binding,operationId}'=${binding.operationId}
      AND (r.manifest#>>'{binding,generation}')::int=${binding.generation}`;
  return row !== undefined;
});
