import type { PgClient } from "@effect/sql-pg/PgClient";
import type {
  RepositoryWorkflowJob,
  WorkflowVmPublishingOutcome,
  WorkflowVmRecovery,
} from "@t3tools/contracts/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  authorizeWorkflowVmCheckpoint,
  authorizeWorkflowVmPublishingRetry,
  lockWorkflowVmCheckpoint,
  pendingWorkflowVmCheckpoint,
  restoreSupersededWorkflowCheckpoint,
} from "../jobs/WorkflowVmCheckpoint.ts";
import {
  knownWorkflowVmPublishingCancellation,
  readWorkflowVmPublishCommands,
  readWorkflowVmPublishing,
  type WorkflowVmPublication,
} from "../jobs/WorkflowVmPublishing.ts";
import { WorkflowPersistenceError, Workflows, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { workflowVmCodexConnectionReady } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { savedDiskHasCancelledRestorePlacement } from "./ThreadVmSavedDiskPlacement.ts";
import { supersedeUnissuedWorkflowPause } from "./ThreadVmPauseStore.ts";
import {
  ensureWorkflowPublishingSavedDisk,
  releaseWorkflowPublishingRecovery,
  workflowPublishingCancellationOutcome,
} from "./WorkflowVmPublishingRecovery.ts";
import {
  makeThreadVmResumeStore,
  workflowVmHasResumableNativePause,
} from "./ThreadVmResumeStore.ts";

const recoveryUnavailable =
  "There is no verified VM backup for this workflow checkpoint. Saved results are still available.";
const publishingRecoveryUnavailable =
  "There is no verified VM backup for the result this action was publishing. Saved results are still available.";
const publishingStopUnconfirmed =
  "The VM paused before Launchpad could confirm that publishing stopped. Saved results are still available.";
const unconfirmedResume =
  "Launchpad could not confirm that the workflow VM resumed. Saved results are still available.";
const unconfirmedSnapshot =
  "Launchpad could not confirm the workflow VM snapshot. Saved results are still available.";
const unconfirmedBootDeletion =
  "Launchpad could not confirm deletion of the previous workflow VM. Cleanup will retry automatically. Saved results are still available.";
const lostSourceReconciliation =
  "The workflow VM is missing. Launchpad is confirming its removal before recovery.";

const publishingSourceStopped = (sql: PgClient, jobId: string) => sql`(
  a.state='deleted' AND a.deleted_at IS NOT NULL AND (
    (a.deletion_stop_receipt->>'kind'='native-workflow-source-lost'
      AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id
      AND a.deletion_stop_receipt->>'sourceOperationId'=p.operation_id
      AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref
      AND a.deletion_stop_receipt->>'generation'=p.generation::text
      AND a.deletion_stop_receipt->>'jobId'=${jobId}
      AND a.deletion_stop_receipt->>'confirmedAbsent'='true')
    OR EXISTS (SELECT 1 FROM relay_thread_vm_final_saves f
      WHERE f.allocation_id=a.allocation_id AND f.thread_id=a.thread_id
        AND f.generation=p.generation AND f.compute_ref=a.compute_ref
        AND f.reason='source_loss' AND f.phase='completed' AND f.physical_delete_started_at IS NOT NULL)))`;

export function workflowPublishingCancellationDetail(
  operation: WorkflowVmPublication["operation"],
  outcome: WorkflowVmPublishingOutcome | null,
  possiblyDelivered: boolean,
) {
  if (operation === "push")
    return outcome
      ? "The branch was pushed before cancellation."
      : possiblyDelivered
        ? "Could not verify whether the branch was pushed before cancellation."
        : null;
  return outcome
    ? "The pull request was opened before cancellation."
    : possiblyDelivered
      ? "Could not verify whether the pull request was opened before cancellation."
      : null;
}

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
      | "boot_deletion_unconfirmed"
      | "source_loss_reconciling"
      | null;
  }>`
    SELECT j.job_id AS "jobId",
      CASE WHEN j.record#>>'{vmRecovery,state}'='recovery_error'
        THEN COALESCE(j.record#>>'{vmRecovery,detail}',${recoveryUnavailable})
      END AS "storedRecoveryError",
      CASE
      WHEN r.error_code='boot_deletion_unconfirmed' AND r.boot_recovery_started_at IS NOT NULL
        AND r.boot_receipt IS NOT NULL THEN 'boot_deletion_unconfirmed'
      WHEN r.phase='aborted' OR (r.error_code IS NOT NULL AND r.phase IN ('pending','preparing','prepared'))
        THEN 'recovery_error'
      WHEN c.state='waiting' AND (r.phase IN ('pending','preparing','prepared','committed') OR x.phase='waiting')
        AND NOT EXISTS (
          SELECT 1 FROM relay_codex_vm_connections x WHERE x.organization_id=j.organization_id
            AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
            AND ${workflowVmCodexConnectionReady(sql)}) THEN 'waiting_codex'
      WHEN r.phase IN ('pending','preparing','prepared','committed') AND c.state IN ('waiting','reserved')
        THEN 'waiting_capacity'
      WHEN r.phase IS NOT NULL OR (ready.phase='completed'
        AND (publication.manifest#>>'{binding,allocationId}' IS DISTINCT FROM a.allocation_id
          OR (publication.manifest#>>'{binding,generation}')::int IS DISTINCT FROM t.generation)) THEN 'restoring'
      WHEN x.phase='resuming' AND x.connect_claim_id IS NOT NULL
        AND (x.claim_until IS NULL OR x.claim_until<=clock_timestamp()) THEN 'resume_unconfirmed'
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
        AND f.source_receipt#>>'{workflowCheckpoint,jobId}'=j.job_id
        AND f.source_receipt#>>'{workflowCheckpoint,checkpointId}'=j.record#>>'{progress,checkpoint,checkpointId}'
        AND f.source_receipt#>>'{workflowCheckpoint,publicationId}'=h.publication_id
        AND f.source_receipt#>>'{workflowCheckpoint,publicationRevision}'=h.revision::text
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
    LEFT JOIN LATERAL (
      SELECT s.operation_id,s.phase FROM relay_thread_vm_saved_disks s
      WHERE s.thread_id=t.thread_id AND s.phase='available'
        AND (s.generation=t.generation OR ${savedDiskHasCancelledRestorePlacement(sql)})
      ORDER BY s.generation DESC,s.saved_at DESC,s.operation_id DESC LIMIT 1
    ) d ON true
    LEFT JOIN relay_thread_vm_final_saves f ON f.thread_id=t.thread_id
      AND f.operation_id=COALESCE(t.operation_id,d.operation_id)
    LEFT JOIN relay_workflow_recovery_heads h ON h.job_id=j.job_id
    LEFT JOIN relay_workflow_recovery_records publication ON publication.publication_id=h.publication_id AND publication.job_id=j.job_id
    WHERE j.job_id IN ${sql.in(jobIds)} AND (j.status IN ('awaiting_review','awaiting_input') OR
      (j.status='paused' AND j.pending_control#>>'{response,operation}'='retry_action') OR
      (j.status IN ('running','paused','cancelling') AND j.record#>>'{vmRecovery,state}'='recovery_error') OR
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
        if (state === "boot_deletion_unconfirmed")
          return [[jobId, { state: "recovery_error", detail: unconfirmedBootDeletion }]];
        if (state === "source_loss_reconciling")
          return [[jobId, { state: "recovery_error", detail: lostSourceReconciliation }]];
        if (state === "saved" && storedRecoveryError)
          return [[jobId, { state: "recovery_error", detail: storedRecoveryError }]];
        if (state === "recovery_error")
          return [[jobId, { state, detail: storedRecoveryError ?? recoveryUnavailable }]];
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

  const publishingPlacement = Effect.fnUntraced(function* (jobId: string, threadId: string) {
    const [row] = yield* sql<{
      operationId: string | null;
      generation: number;
      live: boolean;
      publishingPaused: boolean;
      sourceStopped: boolean;
    }>`SELECT t.operation_id AS "operationId",t.generation,
          EXISTS (SELECT 1 FROM relay_thread_vm_allocations a WHERE a.thread_id=t.thread_id
            AND a.deleted_at IS NULL) AS live,
          EXISTS (SELECT 1 FROM relay_thread_vm_allocations a
            JOIN relay_workflow_vm_publish_commands command ON command.allocation_id=a.allocation_id
            WHERE a.thread_id=t.thread_id AND a.organization_id=t.organization_id
              AND a.resource_kind='organization_workflow' AND a.state='paused' AND a.deleted_at IS NULL
              AND a.native_paused_generation=t.generation AND command.generation=t.generation
              AND command.job_id=${jobId} AND command.stopped_at IS NULL) AS "publishingPaused",
          (EXISTS (SELECT 1 FROM relay_thread_vm_allocations a
            JOIN relay_thread_vm_provisions p USING(allocation_id)
            WHERE a.thread_id=t.thread_id AND a.organization_id=t.organization_id
              AND a.resource_kind='organization_workflow' AND p.generation=t.generation
              AND ${publishingSourceStopped(sql, jobId)})
            OR EXISTS(SELECT 1 FROM relay_thread_vm_restores r
              JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
              WHERE r.thread_id=t.thread_id AND r.target_generation=t.generation
                AND r.publishing_action_id IS NOT NULL AND r.phase='aborted'
                AND a.state='deleted' AND a.deleted_at IS NOT NULL)) AS "sourceStopped"
        FROM relay_thread_placements t WHERE t.thread_id=${threadId} AND t.workflow_job_id=${jobId}
          AND t.audience='repository'`;
    return row ?? null;
  });

  const advancePublishing = Effect.fnUntraced(function* (
    row: WorkflowJobRecord,
    leaseUntil: string,
    observed: {
      publication: WorkflowVmPublication;
      outcome: WorkflowVmPublishingOutcome | null;
    } | null,
  ) {
    const job = row.record;
    const progress = job.progress;
    if (job.runtime?.kind !== "vm" || !progress || !job.workflow || !job.vmAdmission) return null;
    const threadId = job.runtime.threadId;
    const step = job.workflow.definition.steps.find((entry) => entry.id === progress.stepId);
    if (step?.kind !== "action") return null;
    const actionId = `workflow:${row.jobId}:action:${step.id}:${progress.generation ?? 0}`;
    const publication = yield* readWorkflowVmPublishing(sql, row.jobId, actionId);
    if (!publication || publication.binding.threadId !== threadId) return null;
    const placement = yield* publishingPlacement(row.jobId, threadId);
    if (!placement) return null;
    const operation = row.pendingControl?.response.operation;
    const cancelling = operation === "cancel" || operation === "retry_cancellation";
    if (placement.operationId) {
      if (cancelling) {
        const restoring = yield* restores.get(placement.operationId);
        if (restoring && restoring.phase !== "completed" && restoring.phase !== "aborted")
          yield* restores
            .requestAbort(placement.operationId)
            .pipe(Effect.catchTag("ThreadVmRestoreConflict", () => Effect.void));
      }
      return job;
    }
    const store = yield* Workflows;
    const change = (record: RepositoryWorkflowJob, pending = row.pendingControl) =>
      store
        .updateJob(row, record, pending, false, leaseUntil)
        .pipe(Effect.map(({ record }) => record));
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    if (placement.publishingPaused) {
      const retry = operation === "retry_action";
      if (!retry && job.vmRecovery?.detail === publishingStopUnconfirmed) return job;
      return yield* change(
        {
          ...job,
          updatedAt,
          detail: publishingStopUnconfirmed,
          vmRecovery: { state: "recovery_error", detail: publishingStopUnconfirmed },
        },
        retry ? null : row.pendingControl,
      );
    }
    if (placement.live || !placement.sourceStopped) return null;
    // Deletion proves old command processes stopped. It says nothing about GitHub.
    yield* sql`UPDATE relay_workflow_vm_publish_commands command SET stopped_at=clock_timestamp()
      FROM relay_thread_vm_allocations a, relay_thread_vm_provisions p
      WHERE command.job_id=${row.jobId} AND command.stopped_at IS NULL
        AND command.allocation_id=a.allocation_id AND a.thread_id=${threadId}
        AND p.allocation_id=a.allocation_id AND p.generation=command.generation
        AND ${publishingSourceStopped(sql, row.jobId)}`;
    if (cancelling) {
      if (!(yield* store.canSettleVmCancellation(row)))
        return yield* change({ ...job, status: progress.status, updatedAt }, null);
      const [running] = yield* sql`SELECT 1 FROM relay_workflow_vm_publish_commands
        WHERE job_id=${row.jobId} AND stopped_at IS NULL`;
      if (running) return job;
      const outcome =
        knownWorkflowVmPublishingCancellation(publication) ??
        (observed?.publication.actionId === actionId ? observed.outcome : null);
      const commands = yield* readWorkflowVmPublishCommands(sql, row.jobId, actionId);
      const possiblyDelivered = commands.some((command) => !command.rejected);
      const detail = workflowPublishingCancellationDetail(
        publication.operation,
        outcome,
        possiblyDelivered,
      );
      if (outcome && !publication.outcome && publication.operation === "push")
        yield* sql`UPDATE relay_workflow_vm_publications SET record=record || ${sql.json({ outcome })}
          WHERE job_id=${row.jobId} AND action_id=${actionId}`;
      const publicationOutcome = yield* workflowPublishingCancellationOutcome(
        sql,
        row.jobId,
        publication,
        outcome,
        possiblyDelivered,
      );
      yield* releaseWorkflowPublishingRecovery(sql, row.jobId);
      return yield* change(
        {
          ...job,
          updatedAt,
          status: "cancelled",
          detail,
          queueReason: null,
          pendingManualControl: null,
          ...(publicationOutcome ? { publicationOutcome } : {}),
          progress: {
            ...progress,
            revision: progress.revision + 1,
            status: "cancelled",
            underlyingStatus: "cancelled",
            executionReleased: true,
            manualPause: null,
            retryableCancellation: false,
            detail,
            pullRequestUrl: outcome?.pullRequestUrl ?? progress.pullRequestUrl ?? null,
          },
        },
        null,
      );
    }
    const priorRestore =
      operation === "retry_action" && row.pendingControl?.responseId
        ? yield* restores.get(row.pendingControl.responseId)
        : null;
    const interruptedRetry =
      operation === "retry_action" &&
      (!!row.pendingControl?.checkpointDispatch ||
        priorRestore?.phase === "completed" ||
        priorRestore?.phase === "aborted");
    if (operation === "retry_action" && !interruptedRetry) {
      const retry = yield* authorizeWorkflowVmPublishingRetry(sql, row);
      if (!retry)
        return yield* change(
          { ...job, updatedAt, detail: "The publishing retry is no longer authorized." },
          null,
        );
      const disk = publication.recoverySource
        ? yield* ensureWorkflowPublishingSavedDisk(sql, threadId, publication.recoverySource)
        : null;
      if (disk && publication.recoverySource) {
        const restored = yield* restores
          .begin({
            operationId: retry.responseId,
            allocationId: retry.responseId,
            threadId,
            savedDiskOperationId: disk,
            actorUserId: retry.userId,
            expectedGeneration: placement.generation,
            workflowJobId: row.jobId,
            publishingRecovery: publication.recoverySource,
            publishingAction: { actionId, expectedRevision: retry.response.expectedRevision },
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
        if (restored) {
          const { vmRecovery: _previous, ...record } = job;
          return yield* change({ ...record, updatedAt });
        }
      }
      return yield* change(
        {
          ...job,
          updatedAt,
          detail: publishingRecoveryUnavailable,
          vmRecovery: { state: "recovery_error", detail: publishingRecoveryUnavailable },
        },
        null,
      );
    }
    const current = progress.actions?.find((entry) => entry.actionId === actionId);
    if (
      !interruptedRetry &&
      progress.status === "paused" &&
      current?.retryable &&
      job.vmRecovery?.detail !== publishingStopUnconfirmed
    )
      return job;
    const detail = "The workflow VM stopped during publishing. Retry to recover the saved result.";
    const { vmRecovery: _previousRecovery, ...record } = job;
    return yield* change(
      {
        ...record,
        updatedAt,
        status: "paused",
        detail,
        progress: {
          ...progress,
          revision: progress.revision + 1,
          status: "paused",
          underlyingStatus: "paused",
          detail,
          actions: [
            ...(progress.actions ?? []).filter((entry) => entry.actionId !== actionId),
            {
              actionId,
              stepId: step.id,
              generation: publication.stepGeneration,
              operation: publication.operation,
              state: "uncertain",
              detail,
              commitSha: publication.commitSha,
              pullRequestUrl: publication.outcome?.pullRequestUrl ?? null,
              retryable: true,
            },
          ],
        },
      },
      interruptedRetry ? null : row.pendingControl,
    );
  });

  const advance = Effect.fn("relay.workflow_vm.recovery.advance")(function* (
    prior: WorkflowJobRecord,
    leaseUntil: string,
    observe: (
      publication: WorkflowVmPublication,
    ) => Effect.Effect<WorkflowVmPublishingOutcome | null> = () => Effect.succeed(null),
  ) {
    const store = yield* Workflows;
    let observed: {
      publication: WorkflowVmPublication;
      outcome: WorkflowVmPublishingOutcome | null;
    } | null = null;
    const pending = prior.pendingControl?.response.operation;
    const jobProgress = prior.record.progress;
    if (
      (pending === "cancel" || pending === "retry_cancellation") &&
      prior.record.runtime?.kind === "vm" &&
      jobProgress?.stepId &&
      prior.record.workflow?.definition.steps.some(
        (step) => step.id === jobProgress.stepId && step.kind === "action",
      )
    ) {
      const publication = yield* readWorkflowVmPublishing(
        sql,
        prior.jobId,
        `workflow:${prior.jobId}:action:${jobProgress.stepId}:${jobProgress.generation ?? 0}`,
      ).pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));
      const placement = yield* publishingPlacement(prior.jobId, prior.record.runtime.threadId).pipe(
        Effect.mapError((cause) => new WorkflowPersistenceError({ cause })),
      );
      if (publication && !placement?.live && placement?.sourceStopped) {
        const commands = yield* readWorkflowVmPublishCommands(
          sql,
          prior.jobId,
          publication.actionId,
        ).pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));
        const known = knownWorkflowVmPublishingCancellation(publication);
        const shouldRead = !known && commands.some((command) => !command.rejected);
        observed = {
          publication,
          outcome: known ?? (shouldRead ? yield* observe(publication) : null),
        };
      }
    }
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* lockWorkflowVmCheckpoint(sql, prior.jobId);
          if (!row || row.leaseUntil !== leaseUntil || row.revision !== prior.revision)
            return prior.record;
          const publishing = yield* advancePublishing(row, leaseUntil, observed);
          if (publishing) return publishing;
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
          SELECT s.operation_id FROM relay_thread_vm_saved_disks s JOIN relay_thread_vm_final_saves f USING(operation_id)
          WHERE s.thread_id=t.thread_id AND s.phase='available' AND f.phase='completed'
            AND (s.generation=t.generation OR ${savedDiskHasCancelledRestorePlacement(sql)})
            AND f.source_receipt#>>'{workflowCheckpoint,jobId}'=${row.jobId}
            AND f.source_receipt#>>'{workflowCheckpoint,checkpointId}'=${progress.checkpoint.checkpointId}
            AND f.source_receipt#>>'{workflowCheckpoint,checkpointGeneration}'=${String(progress.checkpoint.generation ?? 0)}
            AND EXISTS (SELECT 1 FROM relay_workflow_recovery_heads h WHERE h.job_id=${row.jobId}
              AND f.source_receipt#>>'{workflowCheckpoint,publicationId}'=h.publication_id
              AND f.source_receipt#>>'{workflowCheckpoint,publicationRevision}'=h.revision::text)
          ORDER BY s.generation DESC,s.saved_at DESC,s.operation_id DESC LIMIT 1
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
          ThreadVmBackupConflict: () => Effect.succeed(prior.record),
          ThreadNativeCheckpointConflict: () => Effect.succeed(prior.record),
        }),
      );
  });
  return { advance };
}
