import type { PgClient } from "@effect/sql-pg/PgClient";
import type {
  RepositoryWorkflowJob,
  WorkflowVmDispatchBinding,
  WorkflowVmPublishingOutcome,
} from "@t3tools/contracts/workflows";
import type { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { authorizeWorkflowVmPublishingRetry } from "../jobs/WorkflowVmCheckpoint.ts";
import {
  normalizeWorkflowVmPullRequestUrl,
  readWorkflowVmPublishing,
  type WorkflowVmPublication,
} from "../jobs/WorkflowVmPublishing.ts";
import type { WorkflowJobRecord } from "../jobs/Workflows.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import {
  makeThreadNativeCheckpointStore,
  releaseThreadNativeCheckpointOperation,
} from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";

export interface WorkflowPublishingRecoverySource {
  readonly backupOperationId: string;
  readonly retentionOperationId: string;
}

/** Publishing may retain a verified P06 source. The result's patch alone cannot restore a VM. */
export const retainWorkflowPublishingRecovery = Effect.fnUntraced(function* (
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  binding: WorkflowVmDispatchBinding,
  result: { readonly resultTurnId: string; readonly resultTreeId: string },
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${binding.threadId} FOR UPDATE`;
        const [source] = yield* sql<{
          backupOperationId: string;
          nativeCheckpointOperationId: string;
        }>`SELECT b.operation_id AS "backupOperationId", n.operation_id AS "nativeCheckpointOperationId"
        FROM relay_thread_vm_backups b
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_workflow_recovery_records w
          ON w.publication_id=b.source_receipt#>>'{workflowCheckpoint,publicationId}'
          AND w.revision=(b.source_receipt#>>'{workflowCheckpoint,publicationRevision}')::int
        JOIN relay_thread_native_checkpoints n
          ON n.operation_id=b.source_receipt->>'nativeCheckpointOperationId'
        JOIN relay_thread_native_checkpoints agent
          ON agent.operation_id=w.manifest->>'nativeCheckpointOperationId'
        JOIN relay_workflow_saved_results result
          ON result.job_id=w.job_id AND result.thread_id=w.thread_id AND result.turn_id=agent.turn_id
        WHERE a.thread_id=${binding.threadId} AND a.organization_id=${binding.organizationId}
          AND a.resource_kind='organization_workflow' AND a.runtime_protocol='native-v1'
          AND b.phase='verified' AND b.snapshot_id IS NOT NULL AND b.native_capture_receipt IS NOT NULL
          AND b.generation<=${binding.generation} AND w.job_id=${binding.jobId} AND w.thread_id=a.thread_id
          AND w.manifest#>>'{binding,allocationId}'=a.allocation_id
          AND (w.manifest#>>'{binding,generation}')::int=b.generation
          AND w.manifest#>>'{binding,environmentId}'=n.source_environment_id
          AND n.thread_id=a.thread_id AND n.generation=b.generation AND n.retained
          AND agent.thread_id=n.thread_id AND agent.generation=n.generation AND agent.turn_id=${result.resultTurnId}
          AND result.result->>'outcome'='completed' AND result.result->>'treeId'=${result.resultTreeId}
        ORDER BY b.generation DESC,b.verified_at DESC,b.operation_id DESC LIMIT 1 FOR UPDATE OF b`;
        if (!source) return null;
        const native = makeThreadNativeCheckpointStore(sql, objects);
        const point = yield* native.get(source.nativeCheckpointOperationId);
        if (!point?.recoveryHistory) return null;
        const retentionOperationId = NodeCrypto.randomUUID();
        yield* makeThreadVmBackupRetentionStore(sql).pin({
          threadId: binding.threadId,
          backupOperationId: source.backupOperationId,
          operationId: retentionOperationId,
        });
        yield* native.pinCompleteForOperation({
          threadId: binding.threadId,
          operationId: retentionOperationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        return {
          backupOperationId: source.backupOperationId,
          retentionOperationId,
        } satisfies WorkflowPublishingRecoverySource;
      }),
    )
    .pipe(
      Effect.catchTags({
        ThreadVmBackupConflict: () => Effect.succeed(null),
        ThreadNativeCheckpointConflict: () => Effect.succeed(null),
      }),
    );
});

/** The publishing pin can outlive the ordinary saved-disk row and its restore. */
export const readHeldPublishingBackup = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
  source: WorkflowPublishingRecoverySource,
) {
  const [row] = yield* sql<{
    generation: number;
    checkpoint: RelayThreadVmWorkflowCheckpoint;
    savedDiskOperationId: string | null;
  }>`SELECT b.generation,b.source_receipt->'workflowCheckpoint' AS checkpoint,
      d.operation_id AS "savedDiskOperationId"
    FROM relay_thread_vm_backups b
    JOIN relay_thread_vm_allocations a USING(allocation_id)
    JOIN relay_thread_vm_backup_pins pin ON pin.backup_operation_id=b.operation_id
    JOIN relay_thread_native_checkpoint_operations n ON n.operation_id=pin.operation_id
    LEFT JOIN relay_thread_vm_saved_disks d ON d.backup_operation_id=b.operation_id
    WHERE a.thread_id=${threadId} AND a.resource_kind='organization_workflow'
      AND b.operation_id=${source.backupOperationId} AND b.phase='verified'
      AND b.snapshot_id IS NOT NULL
      AND b.native_capture_receipt->>'allocationId'=a.allocation_id
      AND b.native_capture_receipt->>'computeRef'=b.compute_ref
      AND b.native_capture_receipt->>'threadId'=a.thread_id
      AND b.native_capture_receipt->>'generation'=b.generation::text
      AND b.native_capture_receipt->'source'=(b.source_receipt - 'allocationId' - 'computeRef' - 'threadId' - 'generation')
      AND b.source_receipt->'workflowCheckpoint' IS NOT NULL
      AND n.checkpoint_operation_id=b.source_receipt->>'nativeCheckpointOperationId'
      AND n.phase='active' AND pin.operation_id=${source.retentionOperationId}
      AND (d.phase IS NULL OR d.phase IN ('available','restored','restoring'))`;
  return row ?? null;
});

/** Catalog an independently retained snapshot after its original VM has stopped. */
export const ensureWorkflowPublishingSavedDisk = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
  source: WorkflowPublishingRecoverySource,
) {
  const held = yield* readHeldPublishingBackup(sql, threadId, source);
  if (!held || held.savedDiskOperationId) return held?.savedDiskOperationId ?? null;
  const operationId = NodeCrypto.randomUUID();
  const [save] = yield* sql<{ hostId: string }>`INSERT INTO relay_thread_vm_final_saves
    (operation_id,thread_id,allocation_id,environment_id,generation,host_id,compute_ref,
     original_state,reason,activity_revision,idle_since,phase,source_receipt,source_sequence,
     native_checkpoint_operation_id,backup_operation_id,frozen_at,completed_at)
    SELECT ${operationId},a.thread_id,a.allocation_id,b.source_receipt->>'environmentId',
      b.generation,c.host_id,b.compute_ref,'running','source_loss',0,NULL,'completed',
      b.source_receipt,(b.source_receipt->>'sourceSequence')::int,
      b.source_receipt->>'nativeCheckpointOperationId',b.operation_id,b.verified_at,a.deleted_at
    FROM relay_thread_vm_backups b JOIN relay_thread_vm_allocations a USING(allocation_id)
    JOIN LATERAL (SELECT host_id FROM relay_thread_vm_capacity c
      WHERE c.allocation_id=a.allocation_id AND c.compute_ref=b.compute_ref
      ORDER BY c.position DESC LIMIT 1) c ON true
    WHERE b.operation_id=${source.backupOperationId} AND a.thread_id=${threadId}
      AND a.state='deleted' AND a.deleted_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_saved_disks d WHERE d.thread_id=a.thread_id
        AND d.phase IN ('available','restoring','expiring'))
    RETURNING host_id AS "hostId"`;
  if (!save) return null;
  yield* makeThreadVmBackupRetentionStore(sql).pin({
    threadId,
    backupOperationId: source.backupOperationId,
    operationId: `saved-${operationId}`,
  });
  yield* sql`INSERT INTO relay_thread_vm_saved_disks
    (operation_id,thread_id,backup_operation_id,generation,host_id,phase)
    VALUES (${operationId},${threadId},${source.backupOperationId},${held.generation},${save.hostId},'available')`;
  return operationId;
});

/** Recheck the same Retry and retained source immediately before restore boot and enrollment. */
export const authorizeWorkflowPublishingRestore = Effect.fnUntraced(function* (
  sql: PgClient,
  job: WorkflowJobRecord,
  restore: {
    operationId: string;
    actorUserId: string;
    threadId: string;
    savedDiskOperationId: string | null;
    workflowCheckpoint: RelayThreadVmWorkflowCheckpoint;
  },
) {
  const retry = yield* authorizeWorkflowVmPublishingRetry(sql, job);
  if (
    retry?.responseId !== restore.operationId ||
    retry.userId !== restore.actorUserId ||
    !restore.savedDiskOperationId
  )
    return null;
  const publishing = yield* readWorkflowVmPublishing(sql, job.jobId, retry.response.actionId);
  if (!publishing?.recoverySource) return null;
  const held = yield* readHeldPublishingBackup(sql, restore.threadId, publishing.recoverySource);
  const actual = held?.checkpoint;
  const expected = restore.workflowCheckpoint;
  return held?.savedDiskOperationId === restore.savedDiskOperationId &&
    actual?.jobId === expected.jobId &&
    actual.checkpointId === expected.checkpointId &&
    actual.checkpointGeneration === expected.checkpointGeneration &&
    actual.publicationId === expected.publicationId &&
    actual.publicationRevision === expected.publicationRevision
    ? publishing
    : null;
});

/** Drop superseded or terminal workflow holds after the caller has fenced new work. */
export const releaseWorkflowPublishingRecovery = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
  exceptRetentionOperationId?: string,
) {
  const sources = yield* sql<WorkflowPublishingRecoverySource & { threadId: string }>`
    SELECT DISTINCT record#>>'{recoverySource,backupOperationId}' AS "backupOperationId",
      record#>>'{recoverySource,retentionOperationId}' AS "retentionOperationId",
      record#>>'{binding,threadId}' AS "threadId"
    FROM relay_workflow_vm_publications WHERE job_id=${jobId}
      AND record#>>'{recoverySource,retentionOperationId}' IS NOT NULL
      AND record#>>'{recoverySource,retentionOperationId}' IS DISTINCT FROM ${exceptRetentionOperationId ?? null}`;
  for (const source of sources) {
    yield* makeThreadVmBackupRetentionStore(sql).releasePin({
      backupOperationId: source.backupOperationId,
      operationId: source.retentionOperationId,
    });
    yield* releaseThreadNativeCheckpointOperation(sql, {
      threadId: source.threadId,
      operationId: source.retentionOperationId,
    });
  }
});

export const workflowPublishingCancellationOutcome = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
  current: WorkflowVmPublication,
  observed: WorkflowVmPublishingOutcome | null,
  possiblyDelivered: boolean,
) {
  const confirmed = yield* sql<{ record: WorkflowVmPublication }>`SELECT record
    FROM relay_workflow_vm_publications WHERE job_id=${jobId}
      AND record#>>'{outcome,commitSha}' IS NOT NULL ORDER BY ordinal DESC`;
  const branch =
    (observed && current.operation === "push") ||
    confirmed.some(({ record }) => record.operation === "push");
  const pullRequestUrl =
    observed?.pullRequestUrl ??
    normalizeWorkflowVmPullRequestUrl(current.canonicalKey, current.pullRequestUrl) ??
    confirmed.find(({ record }) => record.outcome?.pullRequestUrl)?.record.outcome
      ?.pullRequestUrl ??
    null;
  const unknown =
    !observed &&
    possiblyDelivered &&
    (current.operation !== "open_pull_request" || !pullRequestUrl);
  if (!branch && !pullRequestUrl && !unknown) return undefined;
  return {
    state: unknown ? "unknown" : "confirmed",
    branchUrl: branch
      ? `https://${current.canonicalKey}/tree/${encodeURIComponent(current.branch)}`
      : null,
    pullRequestUrl,
  } satisfies NonNullable<RepositoryWorkflowJob["publicationOutcome"]>;
});
