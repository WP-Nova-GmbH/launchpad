import type { PgClient } from "@effect/sql-pg/PgClient";
import type { RepositoryWorkflowJob, WorkflowVmRecovery } from "@t3tools/contracts/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  authorizeWorkflowVmCheckpoint,
  lockWorkflowVmCheckpoint,
  pendingWorkflowVmCheckpoint,
  restoreSupersededWorkflowCheckpoint,
} from "../jobs/WorkflowVmCheckpoint.ts";
import { WorkflowPersistenceError, Workflows, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { workflowVmCodexConnectionReady } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { supersedeUnissuedWorkflowPause } from "./ThreadVmPauseStore.ts";
import {
  makeThreadVmResumeStore,
  workflowVmHasResumableNativePause,
} from "./ThreadVmResumeStore.ts";

const recoveryUnavailable =
  "There is no verified VM backup for this workflow checkpoint. Saved results are still available.";
const unconfirmedResume =
  "Launchpad could not confirm that the workflow VM resumed. Saved results are still available.";
const unconfirmedSnapshot =
  "Launchpad could not confirm the workflow VM snapshot. Saved results are still available.";
const lostSourceReconciliation =
  "The workflow VM is missing. Launchpad is confirming its removal before recovery.";

/** Project physical lifecycle for workflow lists without waking or reading the guest. */
export const readWorkflowVmRecoveries = Effect.fnUntraced(function* (
  sql: PgClient,
  jobIds: ReadonlyArray<string>,
) {
  if (jobIds.length === 0) return new Map<string, WorkflowVmRecovery>();
  const rows = yield* sql<{
    jobId: string;
    storedRecoveryError: string | null;
    state:
      | WorkflowVmRecovery["state"]
      | "resume_unconfirmed"
      | "snapshot_unconfirmed"
      | "source_loss_reconciling"
      | null;
  }>`
    SELECT j.job_id AS "jobId",
      CASE WHEN j.record#>>'{vmRecovery,state}'='recovery_error'
        THEN COALESCE(j.record#>>'{vmRecovery,detail}',${recoveryUnavailable})
      END AS "storedRecoveryError",
      CASE
      WHEN r.phase='aborted' OR (r.error_code IS NOT NULL AND r.phase IN ('pending','preparing','prepared'))
        THEN 'recovery_error'
      WHEN r.phase IN ('pending','preparing','prepared') AND c.state IN ('waiting','reserved')
        THEN 'waiting_capacity'
      WHEN r.phase IS NOT NULL OR (ready.phase='completed'
        AND (publication.manifest#>>'{binding,allocationId}' IS DISTINCT FROM a.allocation_id
          OR (publication.manifest#>>'{binding,generation}')::int IS DISTINCT FROM t.generation)) THEN 'restoring'
      WHEN x.phase='resuming' AND x.connect_claim_id IS NOT NULL
        AND (x.claim_until IS NULL OR x.claim_until<=clock_timestamp()) THEN 'resume_unconfirmed'
      WHEN x.phase='waiting' AND c.state='waiting' AND NOT EXISTS (
        SELECT 1 FROM relay_codex_vm_connections x WHERE x.organization_id=j.organization_id
          AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
          AND ${workflowVmCodexConnectionReady(sql)}) THEN 'waiting_codex'
      WHEN x.phase='waiting' AND c.state IN ('waiting','reserved') THEN 'waiting_capacity'
      WHEN x.phase IN ('waiting','resuming') OR
        (x.phase='completed' AND p.phase IN ('cancelled','completed') AND p.source_reopened_at IS NULL AND a.state='running')
        THEN 'resuming'
      WHEN p.phase IN ('pending','sealed') AND b.phase='creating' AND b.capture_started_at IS NOT NULL
        AND p.workflow_checkpoint->>'jobId'=j.job_id
        AND p.workflow_checkpoint->>'checkpointId'=j.record#>>'{progress,checkpoint,checkpointId}'
        AND (p.workflow_checkpoint->>'checkpointGeneration')::int=COALESCE((j.record#>>'{progress,checkpoint,generation}')::int,0)
        AND p.workflow_checkpoint->>'publicationId'=h.publication_id
        AND (b.retry_at>=b.capture_started_at+interval '1 minute' OR b.claim_until<=clock_timestamp())
        THEN 'snapshot_unconfirmed'
      WHEN a.state='paused' AND p.phase='completed' AND p.source_reopened_at IS NULL
        AND p.workflow_checkpoint->>'checkpointId'=j.record#>>'{progress,checkpoint,checkpointId}'
        AND (p.workflow_checkpoint->>'checkpointGeneration')::int=COALESCE((j.record#>>'{progress,checkpoint,generation}')::int,0)
        AND p.workflow_checkpoint->>'publicationId'=h.publication_id
        THEN 'paused'
      WHEN a.state='paused' AND ${workflowVmHasResumableNativePause(sql)} THEN 'paused'
      WHEN t.operation_id=f.operation_id AND f.reason='source_loss' AND f.phase='deleting'
        THEN 'source_loss_reconciling'
      WHEN t.operation_id=f.operation_id AND f.phase IN ('frozen','saving','deleting') THEN 'paused'
      WHEN a.state IS NULL AND d.phase='available' AND f.phase='completed'
        AND f.source_receipt#>>'{workflowCheckpoint,checkpointId}'=j.record#>>'{progress,checkpoint,checkpointId}'
        AND f.source_receipt#>>'{workflowCheckpoint,publicationId}'=h.publication_id
        AND (f.source_receipt#>>'{workflowCheckpoint,checkpointGeneration}')::int=COALESCE((j.record#>>'{progress,checkpoint,generation}')::int,0)
        THEN 'saved'
      WHEN a.state IS NULL OR a.state='paused' THEN 'recovery_error'
      ELSE NULL END AS state
    FROM relay_workflow_jobs j
    JOIN relay_thread_placements t ON t.workflow_job_id=j.job_id AND t.audience='repository'
    LEFT JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id AND a.deleted_at IS NULL
    LEFT JOIN relay_thread_vm_pauses p ON p.allocation_id=a.allocation_id AND p.generation=t.generation
    LEFT JOIN relay_thread_vm_backups b ON b.operation_id=p.backup_operation_id
      AND b.allocation_id=a.allocation_id AND b.generation=t.generation AND b.source_receipt=p.source_receipt
    LEFT JOIN relay_thread_vm_resumes x ON x.allocation_id=a.allocation_id AND x.generation=t.generation
    LEFT JOIN relay_thread_vm_restores r ON r.thread_id=t.thread_id
      AND r.operation_id=COALESCE(t.operation_id,j.pending_control->>'responseId') AND r.phase<>'completed'
    LEFT JOIN relay_thread_vm_restores ready ON ready.allocation_id=a.allocation_id AND ready.phase='completed'
    LEFT JOIN relay_thread_vm_capacity c ON c.operation_id=COALESCE(r.operation_id,x.operation_id)
    LEFT JOIN relay_thread_vm_saved_disks d ON d.thread_id=t.thread_id AND d.phase='available'
      AND d.generation=(SELECT MAX(d2.generation) FROM relay_thread_vm_saved_disks d2
        WHERE d2.thread_id=t.thread_id AND d2.phase='available')
    LEFT JOIN relay_thread_vm_final_saves f ON f.thread_id=t.thread_id
      AND f.operation_id=COALESCE(t.operation_id,d.operation_id)
    LEFT JOIN relay_workflow_recovery_heads h ON h.job_id=j.job_id
    LEFT JOIN relay_workflow_recovery_records publication ON publication.publication_id=h.publication_id AND publication.job_id=j.job_id
    WHERE j.job_id IN ${sql.in(jobIds)} AND (j.status IN ('awaiting_review','awaiting_input') OR
      (j.status='cancelling' AND j.record#>>'{progress,status}' IN ('awaiting_review','awaiting_input')))`;
  return new Map(
    rows.flatMap(
      ({
        jobId,
        state,
        storedRecoveryError,
      }): ReadonlyArray<readonly [string, WorkflowVmRecovery]> => {
        if (state === null) return [];
        if (state === "resume_unconfirmed")
          return [[jobId, { state: "recovery_error", detail: unconfirmedResume }]];
        if (state === "snapshot_unconfirmed")
          return [[jobId, { state: "recovery_error", detail: unconfirmedSnapshot }]];
        if (state === "source_loss_reconciling")
          return [[jobId, { state: "recovery_error", detail: lostSourceReconciliation }]];
        if (state === "saved" && storedRecoveryError)
          return [[jobId, { state: "recovery_error", detail: storedRecoveryError }]];
        if (state === "recovery_error") return [[jobId, { state, detail: recoveryUnavailable }]];
        return [[jobId, { state }]];
      },
    ),
  );
});

export function makeWorkflowVmRecovery(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const resumes = makeThreadVmResumeStore(sql);
  const restores = makeThreadVmRestoreStore(sql, objects);
  const saves = makeThreadVmFinalSaveStore(sql, objects);

  const advance = Effect.fn("relay.workflow_vm.recovery.advance")(function* (
    prior: WorkflowJobRecord,
    leaseUntil: string,
  ) {
    const store = yield* Workflows;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* lockWorkflowVmCheckpoint(sql, prior.jobId);
          if (!row || row.leaseUntil !== leaseUntil || row.revision !== prior.revision)
            return prior.record;
          const job = row.record;
          const progress = job.progress;
          const threadId = job.runtime?.kind === "vm" ? job.runtime.threadId : null;
          if (
            !threadId ||
            !progress?.checkpoint ||
            (progress.status !== "awaiting_review" && progress.status !== "awaiting_input")
          )
            return null;
          const [placement] = yield* sql<{
            operationId: string | null;
            generation: number;
            allocationState: string | null;
            pausePhase: string | null;
            pauseCertified: boolean;
            nativePauseResumable: boolean;
            waitingForReopen: boolean;
            sourceLossConfirmed: boolean;
            savedDiskOperationId: string | null;
            restoreOperationId: string | null;
            saveOperationId: string | null;
          }>`SELECT t.operation_id AS "operationId",t.generation,a.state AS "allocationState",
        p.phase AS "pausePhase",
        COALESCE(p.phase='completed' AND p.workflow_checkpoint->>'jobId'=${row.jobId}
          AND p.workflow_checkpoint->>'checkpointId'=${progress.checkpoint.checkpointId}
          AND (p.workflow_checkpoint->>'checkpointGeneration')::int=${progress.checkpoint.generation ?? 0}
          AND p.workflow_checkpoint->>'publicationId'=(SELECT publication_id FROM relay_workflow_recovery_heads WHERE job_id=${row.jobId})
          AND p.source_frozen_at IS NOT NULL
          AND p.source_reopened_at IS NULL AND b.phase='verified' AND b.native_capture_receipt IS NOT NULL,false) AS "pauseCertified",
        COALESCE(${workflowVmHasResumableNativePause(sql)},false) AS "nativePauseResumable",
        COALESCE(p.phase IN ('cancelled','completed') AND p.source_reopened_at IS NULL AND a.state='running',false) AS "waitingForReopen",
        EXISTS(SELECT 1 FROM relay_thread_vm_allocations lost
          JOIN relay_thread_vm_provisions provision ON provision.allocation_id=lost.allocation_id
          WHERE lost.thread_id=t.thread_id AND lost.organization_id=t.organization_id
            AND lost.resource_kind='organization_workflow' AND lost.state='deleted' AND lost.deleted_at IS NOT NULL
            AND provision.generation=t.generation
            AND lost.deletion_stop_receipt->>'kind'='native-workflow-source-lost'
            AND lost.deletion_stop_receipt->>'allocationId'=lost.allocation_id
            AND lost.deletion_stop_receipt->>'computeRef'=lost.compute_ref
            AND lost.deletion_stop_receipt->>'sourceOperationId'=provision.operation_id
            AND lost.deletion_stop_receipt->>'generation'=t.generation::text
            AND lost.deletion_stop_receipt->>'jobId'=${row.jobId}
            AND lost.deletion_stop_receipt->>'checkpointId'=${progress.checkpoint.checkpointId}
            AND lost.deletion_stop_receipt->>'checkpointGeneration'=${String(progress.checkpoint.generation ?? 0)}
            AND lost.deletion_stop_receipt->>'confirmedAbsent'='true') AS "sourceLossConfirmed",
        d.operation_id AS "savedDiskOperationId",r.operation_id AS "restoreOperationId",f.operation_id AS "saveOperationId"
        FROM relay_thread_placements t
        LEFT JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id AND a.deleted_at IS NULL
        LEFT JOIN relay_thread_vm_pauses p ON p.allocation_id=a.allocation_id AND p.generation=t.generation
        LEFT JOIN relay_thread_vm_backups b ON b.operation_id=p.backup_operation_id AND b.source_receipt=p.source_receipt
        LEFT JOIN relay_thread_vm_restores r ON r.thread_id=t.thread_id AND r.operation_id=t.operation_id
        LEFT JOIN relay_thread_vm_final_saves f ON f.thread_id=t.thread_id AND f.operation_id=t.operation_id
        LEFT JOIN LATERAL (
          SELECT d.operation_id FROM relay_thread_vm_saved_disks d JOIN relay_thread_vm_final_saves f USING(operation_id)
          WHERE d.thread_id=t.thread_id AND d.generation=t.generation AND d.phase='available' AND f.phase='completed'
            AND f.source_receipt#>>'{workflowCheckpoint,checkpointId}'=${progress.checkpoint.checkpointId}
            AND f.source_receipt#>>'{workflowCheckpoint,checkpointGeneration}'=${String(progress.checkpoint.generation ?? 0)}
            AND EXISTS (SELECT 1 FROM relay_workflow_recovery_heads h WHERE h.job_id=${row.jobId}
              AND f.source_receipt#>>'{workflowCheckpoint,publicationId}'=h.publication_id
              AND f.source_receipt#>>'{workflowCheckpoint,publicationRevision}'=h.revision::text)
          ORDER BY d.generation DESC LIMIT 1
        ) d ON true
        WHERE t.thread_id=${threadId} AND t.workflow_job_id=${row.jobId} AND t.audience='repository'`;
          if (!placement) return null;
          const pending = row.pendingControl;
          const cancel = pending?.response.operation === "cancel";
          const checkpoint = pendingWorkflowVmCheckpoint(row);
          const authorized = checkpoint ? yield* authorizeWorkflowVmCheckpoint(sql, row) : null;
          const authorizedCancel = cancel && (yield* store.canSettleVmCancellation(row));
          const change = (
            record: RepositoryWorkflowJob,
            control: WorkflowJobRecord["pendingControl"],
          ) =>
            store
              .updateJob(row, record, control, false, leaseUntil)
              .pipe(Effect.map(({ record }) => record));
          if (
            (cancel && !authorizedCancel) ||
            (checkpoint && !authorized && !checkpoint.checkpointDispatch)
          ) {
            if (checkpoint) yield* resumes.cancelWorkflow(threadId, row.jobId);
            if (placement.restoreOperationId)
              yield* restores
                .requestAbort(placement.restoreOperationId)
                .pipe(Effect.catchTag("ThreadVmRestoreConflict", () => Effect.void));
            return yield* change(
              {
                ...job,
                status: progress.status,
                detail:
                  "The pending workflow response was withdrawn because its author no longer has access.",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
              cancel ? restoreSupersededWorkflowCheckpoint(pending) : null,
            );
          }
          if (authorizedCancel || authorized) {
            if (placement.pausePhase === "pending" && placement.allocationState === "running")
              yield* supersedeUnissuedWorkflowPause(sql, threadId, row.jobId);
            if (
              placement.saveOperationId &&
              !(yield* saves.abandonUnissuedWorkflowSave(placement.saveOperationId))
            )
              return job;
          }
          if (cancel) {
            if (pending?.supersededCheckpoint || placement.waitingForReopen) return job;
            if (placement.restoreOperationId) {
              yield* restores
                .requestAbort(placement.restoreOperationId)
                .pipe(Effect.catchTag("ThreadVmRestoreConflict", () => Effect.void));
              return job;
            }
            if ((yield* resumes.cancelWorkflow(threadId, row.jobId)) === "started") return job;
            // E2B may pause before Launchpad captures a backup. The current
            // checkpoint can still be cancelled without waking that workspace.
            const [nativePaused] =
              placement.allocationState === "paused" && placement.nativePauseResumable
                ? yield* sql`SELECT 1 FROM relay_thread_placements t
                    JOIN relay_thread_vm_allocations a USING(thread_id)
                    JOIN relay_thread_vm_provisions p USING(allocation_id)
                    JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
                      AND b.environment_id=t.environment_id AND b.generation=t.generation
                      AND b.repository_id=t.repository_id AND b.revoked_at IS NULL
                    JOIN relay_environment_credentials k ON k.credential_id=b.credential_id AND k.revoked_at IS NULL
                    WHERE t.thread_id=${threadId} AND t.workflow_job_id=${row.jobId}
                      AND a.organization_id=t.organization_id AND a.state='paused' AND a.deleted_at IS NULL
                      AND p.generation=t.generation AND p.phase='created' AND p.workflow_snapshot IS NOT NULL
                      AND p.ingress_recovery_claim_id IS NULL
                      AND ${workflowVmHasResumableNativePause(sql)}
                      AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id
                        AND c.compute_ref=a.compute_ref AND c.state='released')
                      AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id AND c.state<>'released')
                      AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r WHERE r.allocation_id=a.allocation_id
                        AND (r.phase IN ('waiting','resuming') OR r.connect_claim_id IS NOT NULL))
                      AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_restores r WHERE r.allocation_id=a.allocation_id
                        AND (r.phase NOT IN ('completed','aborted') OR r.boot_ingress_recovery_claim_id IS NOT NULL))
                      AND NOT EXISTS (SELECT 1 FROM relay_thread_execution_admissions e WHERE e.thread_id=t.thread_id AND NOT e.completed)
                      AND NOT EXISTS (SELECT 1 FROM relay_thread_commands c WHERE c.thread_id=t.thread_id AND c.receipt_json IS NULL)
                    FOR UPDATE OF a,p FOR SHARE OF b,k`
                : [];
            if (
              !placement.pauseCertified &&
              !nativePaused &&
              !(
                placement.allocationState === null &&
                (placement.savedDiskOperationId || placement.sourceLossConfirmed)
              )
            )
              return placement.pausePhase || placement.allocationState === "paused" ? job : null;
            return yield* change(
              {
                ...job,
                status: "cancelled",
                detail: null,
                queueReason: null,
                pendingManualControl: null,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
                progress: {
                  ...progress,
                  status: "cancelled",
                  underlyingStatus: "cancelled",
                  executionReleased: true,
                  approvalPending: false,
                  retryableApproval: false,
                  retryableCancellation: false,
                  manualPause: null,
                },
              },
              null,
            );
          }
          if (authorized && !authorized.checkpointDispatch && !placement.restoreOperationId) {
            if (placement.pauseCertified || placement.nativePauseResumable) {
              yield* resumes
                .requestWorkflow(threadId, row.jobId)
                .pipe(Effect.catchTag("ThreadVmResumeConflict", () => Effect.void));
            } else if (
              !placement.allocationState &&
              placement.savedDiskOperationId &&
              !placement.operationId
            ) {
              const restored = yield* restores
                .begin({
                  operationId: authorized.responseId,
                  allocationId: authorized.responseId,
                  threadId,
                  savedDiskOperationId: placement.savedDiskOperationId,
                  actorUserId: authorized.userId,
                  expectedGeneration: placement.generation,
                  workflowJobId: row.jobId,
                  serving: true,
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchTags({
                    ThreadVmRestoreConflict: () => Effect.succeed(false),
                    ThreadVmSavedDiskConflict: () => Effect.succeed(false),
                    ThreadNativeCheckpointConflict: () => Effect.succeed(false),
                    ThreadVmBackupConflict: () => Effect.succeed(false),
                    SchemaError: () => Effect.succeed(false),
                  }),
                );
              const { vmRecovery, ...current } = job;
              if (restored && vmRecovery?.state === "recovery_error")
                return yield* change(current, pending);
              if (!restored && vmRecovery?.state !== "recovery_error")
                return yield* change(
                  { ...job, vmRecovery: { state: "recovery_error", detail: recoveryUnavailable } },
                  pending,
                );
            }
          }
          if (
            placement.pausePhase ||
            placement.savedDiskOperationId ||
            placement.operationId ||
            placement.allocationState === null ||
            placement.allocationState === "paused"
          )
            return job;
          return null;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new WorkflowPersistenceError({ cause })),
          ThreadVmFinalSaveConflict: () => Effect.succeed(prior.record),
          ThreadNativeCheckpointConflict: () => Effect.succeed(prior.record),
        }),
      );
  });
  return { advance };
}
