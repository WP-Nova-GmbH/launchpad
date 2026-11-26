import type { PgClient } from "@effect/sql-pg/PgClient";
import type { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import { readWorkflowVmBinding } from "../jobs/WorkflowVmBinding.ts";
import { lockWorkflowVmCheckpoint } from "../jobs/WorkflowVmCheckpoint.ts";
import { requireWorkflowVmFollowUpActor } from "../jobs/WorkflowVmFollowUpAccess.ts";
import { makeE2BThreadVmCompute } from "../machines/E2BThreadVmCompute.ts";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { workflowVmCodexConnectionReady } from "./ThreadVmCapacityStore.ts";
import {
  ThreadArtifactObjectStorage,
  type makeThreadArtifactObjects,
} from "./ThreadArtifactObjects.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntimeConfiguration.ts";
import { hasReboundWorkflowCheckpoint } from "./WorkflowVmWorkspace.ts";
import {
  authorizeWorkflowVmFollowUpRequest,
  latestWorkflowVmSavedDiskRestore,
  workflowVmExecutionReleased,
} from "./WorkflowVmFollowUpState.ts";

export type WorkflowVmFollowUpRequest = {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly jobId: string;
  readonly userId: string;
};

export type WorkflowVmFollowUpView =
  | { readonly state: "running"; readonly binding: WorkflowVmDispatchBinding }
  | {
      readonly state:
        | "waiting_capacity"
        | "waiting_codex"
        | "resuming"
        | "restoring"
        | "expired"
        | "unavailable";
      readonly detail: string;
      readonly canRetry?: false;
    };

const waiting = { state: "waiting_capacity", detail: "Waiting for a workflow VM slot." } as const;
const waitingForCodex = {
  state: "waiting_codex",
  detail: "Reconnect the run’s original Codex account in Organization settings to continue.",
} as const;
const codexReplaced = {
  state: "unavailable",
  detail:
    "The run’s original Codex connection is no longer available. Saved results are still available.",
} as const;
const resuming = { state: "resuming", detail: "Waiting for the existing VM to resume." } as const;
const restoring = {
  state: "restoring",
  detail: "Restoring the saved workflow workspace.",
} as const;
const retryingSnapshot = {
  state: "restoring",
  detail: "Waiting to retry the saved workflow snapshot lookup.",
} as const;
const expired = {
  state: "expired",
  detail: "This workspace expired. The original saved results are still available.",
  canRetry: false,
} as const;
const snapshotUnconfirmed = {
  state: "unavailable",
  detail:
    "Launchpad could not confirm the workflow VM snapshot. Saved results are still available.",
} as const;
const resumeUnconfirmed = {
  state: "unavailable",
  detail:
    "Launchpad could not confirm that the workflow VM resumed. Saved results are still available.",
} as const;
const pauseUnconfirmed = {
  state: "unavailable",
  detail:
    "Launchpad could not confirm the VM provider’s pause response. Saved results are still available. Try Continue in VM again after the pause is confirmed.",
} as const;
const restoreUnconfirmed = {
  state: "unavailable",
  detail: "Launchpad could not confirm the workflow VM restore. Saved results are still available.",
} as const;
const restoreDeletionUnconfirmed = {
  state: "unavailable",
  detail:
    "Launchpad could not confirm deletion of the previous workflow VM. Cleanup will retry automatically. Saved results are still available.",
} as const;
const restoreFailures = {
  snapshot_unavailable: {
    state: "unavailable",
    detail:
      "The saved workflow VM snapshot is no longer available. Saved results are still available.",
    canRetry: false,
  },
  snapshot_lookup_failed: {
    state: "unavailable",
    detail:
      "Launchpad could not look up the saved workflow VM snapshot. Saved results are still available.",
  },
  create_rejected: {
    state: "unavailable",
    detail: "The VM provider rejected the restore. Saved results are still available.",
  },
} as const;
type RestoreFailure = keyof typeof restoreFailures;
const unavailable = {
  state: "unavailable",
  detail: "The current workspace is unavailable. The original saved results are still available.",
} as const;

interface Source {
  readonly threadId: string;
  readonly generation: number;
  readonly placementOperationId: string | null;
  readonly allocationId: string | null;
  readonly allocationState: string | null;
  readonly resumePhase: string | null;
  readonly resumeUnconfirmed: boolean;
  readonly pauseUnconfirmed: boolean;
  readonly awaitingReopen: boolean;
  readonly capacityState: string | null;
  readonly codexState: "ready" | "reconnect" | "replaced";
  readonly restorePhase: string | null;
  readonly restoreIssue: "restore" | "deletion" | "catalog_retry" | RestoreFailure | null;
  readonly reclaimOperationId: string | null;
  readonly snapshotUnconfirmed: boolean;
  readonly savedDiskOperationId: string | null;
  readonly savedDiskPhase: string | null;
  readonly savedDiskIssue: RestoreFailure | null;
}

const lockSource = Effect.fnUntraced(function* (sql: PgClient, input: WorkflowVmFollowUpRequest) {
  const job = yield* lockWorkflowVmCheckpoint(sql, input.jobId);
  if (
    !job ||
    job.organizationId !== input.organizationId ||
    job.repositoryId !== input.repositoryId
  )
    return yield* tenancyNotFound("thread_not_found");
  yield* requireWorkflowVmFollowUpActor(sql, input, input.userId);
  const [source] = yield* sql<Source>`SELECT t.thread_id AS "threadId",t.generation,
      t.operation_id AS "placementOperationId",a.allocation_id AS "allocationId",
      a.state AS "allocationState",r.phase AS "resumePhase",c.state AS "capacityState",
      COALESCE(r.phase='resuming' AND r.connect_claim_id IS NOT NULL
        AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp()),false) AS "resumeUnconfirmed",
      EXISTS(SELECT 1 FROM relay_thread_vm_pauses pause WHERE pause.allocation_id=a.allocation_id
        AND pause.generation=t.generation AND pause.workflow_checkpoint->>'jobId'=j.job_id
        AND pause.workflow_checkpoint ? 'finishedWorkspaceRevision' AND j.status='cancelled'
        AND pause.pause_dispatch_claim_id IS NOT NULL
        AND (pause.claim_id IS DISTINCT FROM pause.pause_dispatch_claim_id
          OR pause.pause_dispatched_at<=clock_timestamp()-interval '2 minutes')) AS "pauseUnconfirmed",
      EXISTS(SELECT 1 FROM relay_thread_vm_pauses pause WHERE pause.allocation_id=a.allocation_id
        AND pause.generation=t.generation AND pause.workflow_checkpoint->>'jobId'=j.job_id
        AND pause.phase IN ('cancelled','completed') AND pause.source_reopened_at IS NULL
        AND a.state='running') AS "awaitingReopen",
      CASE WHEN x.connection_id IS NULL THEN 'replaced'
        WHEN ${workflowVmCodexConnectionReady(sql)} THEN 'ready' ELSE 'reconnect' END AS "codexState",
      restore.phase AS "restorePhase",f.reclaim_operation_id AS "reclaimOperationId",
      CASE WHEN restore.error_code='boot_deletion_unconfirmed' THEN 'deletion'
        WHEN restore.error_code='snapshot_unconfirmed' THEN 'catalog_retry'
        WHEN restore.error_code IN ('snapshot_unavailable','snapshot_lookup_failed','create_rejected')
          THEN restore.error_code
        WHEN restore.error_code IN ('create_uncertain','identity_conflict') OR
          (restore.boot_ingress_recovery_claim_id IS NOT NULL
            AND (restore.claim_until IS NULL OR restore.claim_until<=clock_timestamp())) THEN 'restore'
      END AS "restoreIssue",
      EXISTS(SELECT 1 FROM relay_thread_vm_pauses pause JOIN relay_thread_vm_backups b
        ON b.operation_id=pause.backup_operation_id AND b.source_receipt=pause.source_receipt
        WHERE pause.operation_id=f.reclaim_operation_id AND pause.allocation_id=a.allocation_id
          AND pause.generation=t.generation AND pause.phase IN ('pending','sealed')
          AND b.phase='creating' AND b.capture_started_at IS NOT NULL
          AND (b.retry_at>=b.capture_started_at+interval '1 minute' OR b.claim_until<=clock_timestamp()))
        AS "snapshotUnconfirmed",
      disk.operation_id AS "savedDiskOperationId",disk.phase AS "savedDiskPhase",
      disk.restore_issue AS "savedDiskIssue"
    FROM relay_thread_placements t
    JOIN relay_workflow_jobs j ON j.job_id=t.workflow_job_id AND j.organization_id=t.organization_id
      AND j.repository_id=t.repository_id
    LEFT JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id
      AND a.deleted_at IS NULL AND a.resource_kind='organization_workflow' AND a.runtime_protocol='native-v1'
    LEFT JOIN relay_thread_vm_resumes r ON r.allocation_id=a.allocation_id AND r.generation=t.generation
      AND r.phase IN ('waiting','resuming')
    LEFT JOIN relay_workflow_vm_follow_ups f ON f.job_id=j.job_id
    LEFT JOIN relay_thread_vm_restores restore ON restore.operation_id=f.operation_id
      AND restore.phase NOT IN ('completed','aborted')
    LEFT JOIN relay_thread_vm_capacity c ON c.operation_id=COALESCE(r.operation_id,restore.operation_id)
    LEFT JOIN relay_codex_vm_connections x ON x.organization_id=j.organization_id
      AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
    LEFT JOIN LATERAL (
      SELECT d.operation_id,CASE WHEN d.phase='available'
        AND ((d.saved_at AT TIME ZONE policy.calendar_time_zone
          + make_interval(days=>policy.saved_disk_retention_days)) AT TIME ZONE policy.calendar_time_zone)
          <= clock_timestamp() THEN 'expired' ELSE d.phase END AS phase,
        CASE WHEN last_restore.phase='aborted' AND last_restore.error_code IN
          ('snapshot_unavailable','snapshot_lookup_failed','create_rejected')
          THEN last_restore.error_code END AS restore_issue
      FROM relay_thread_vm_saved_disks d JOIN relay_thread_vm_backups b ON b.operation_id=d.backup_operation_id
      JOIN relay_thread_vm_policies policy ON policy.organization_id=t.organization_id
      LEFT JOIN LATERAL (${latestWorkflowVmSavedDiskRestore(sql)}) last_restore ON true
      WHERE d.thread_id=t.thread_id AND d.phase IN ('available','expiring','expired')
        AND (d.generation=t.generation OR EXISTS(SELECT 1 FROM relay_thread_vm_restores chain
          WHERE chain.saved_disk_operation_id=d.operation_id AND chain.phase IN ('completed','aborted')
            AND chain.target_generation=t.generation))
        AND b.source_receipt#>>'{workflowCheckpoint,jobId}'=j.job_id
        AND b.source_receipt#>>'{workflowCheckpoint,finishedWorkspaceRevision}'=COALESCE(f.workspace_revision,0)::text
      ORDER BY d.saved_at DESC,d.operation_id DESC LIMIT 1
    ) disk ON true
    WHERE j.job_id=${input.jobId} AND t.audience='repository' AND ${workflowVmExecutionReleased(sql)}
      AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)`;
  if (source?.allocationId)
    yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
      WHERE allocation_id=${source.allocationId} FOR UPDATE`;
  return source ?? null;
});

const readRunning = (sql: PgClient, input: WorkflowVmFollowUpRequest, generation: number) =>
  readWorkflowVmBinding(sql, { ...input, generation }, "active", true).pipe(
    Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
  );

const pendingState = (source: Source): Exclude<WorkflowVmFollowUpView, { state: "running" }> => {
  if (source.pauseUnconfirmed) return pauseUnconfirmed;
  if (source.snapshotUnconfirmed) return snapshotUnconfirmed;
  if (source.resumeUnconfirmed) return resumeUnconfirmed;
  if (source.restoreIssue === "deletion") return restoreDeletionUnconfirmed;
  if (source.restoreIssue === "restore") return restoreUnconfirmed;
  if (
    source.restoreIssue === "snapshot_unavailable" ||
    source.restoreIssue === "snapshot_lookup_failed" ||
    source.restoreIssue === "create_rejected"
  )
    return {
      state: "restoring",
      detail: restoreFailures[source.restoreIssue].detail + " Launchpad is finishing cleanup.",
    };
  if (
    source.capacityState === "waiting" ||
    source.capacityState === "reserved" ||
    source.restorePhase
  ) {
    if (source.codexState === "replaced") return codexReplaced;
    if (source.codexState === "reconnect") return waitingForCodex;
  }
  if (source.restoreIssue === "catalog_retry") return retryingSnapshot;
  if (source.capacityState === "waiting") return waiting;
  if (source.resumePhase || source.awaitingReopen) return resuming;
  if (source.restorePhase) return restoring;
  if (source.reclaimOperationId)
    return { state: "resuming", detail: "Waiting for the VM to finish pausing." };
  if (source.placementOperationId && source.allocationState === "deleting")
    return { state: "restoring", detail: "Waiting for the VM to finish saving." };
  if (source.savedDiskPhase === "available" && source.savedDiskIssue)
    return restoreFailures[source.savedDiskIssue];
  if (
    source.codexState === "replaced" &&
    (source.allocationState === "paused" || source.savedDiskPhase === "available")
  )
    return codexReplaced;
  if (source.allocationState === "paused")
    return {
      state: "unavailable",
      detail: "The VM is paused. Select Continue in VM to resume it.",
    };
  if (source.savedDiskPhase === "available")
    return {
      state: "unavailable",
      detail: "The workspace is saved. Select Continue in VM to restore it.",
    };
  if (source.savedDiskPhase === "expired" || source.savedDiskPhase === "expiring") return expired;
  return unavailable;
};

/** Read-only. Saved result navigation never starts or keeps a workspace awake. */
export const readWorkflowVmFollowUp = Effect.fn("relay.workflow_vm.follow_up.read")(function* (
  input: WorkflowVmFollowUpRequest,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const source = yield* lockSource(sql, input);
      if (!source) return unavailable;
      if (
        source.allocationState === "running" &&
        !source.reclaimOperationId &&
        !source.resumePhase &&
        !source.pauseUnconfirmed &&
        !source.awaitingReopen
      ) {
        const live = yield* readRunning(sql, input, source.generation);
        if (live) {
          if (source.codexState === "replaced") return codexReplaced;
          if (source.codexState === "reconnect") return waitingForCodex;
          return (yield* hasReboundWorkflowCheckpoint(sql, live.binding))
            ? ({ state: "running", binding: live.binding } as const)
            : restoring;
        }
      }
      return pendingState(source);
    }),
  );
});

export const openWorkflowVmFollowUp = Effect.fn("relay.workflow_vm.follow_up.open")(function* (
  input: WorkflowVmFollowUpRequest,
) {
  const { settings } = yield* ThreadVmRuntimeConfiguration;
  if (settings?.workflowExecutionEnabled !== true) return unavailable;
  const sql = (yield* RelayDb).$client;
  const objects = yield* ThreadArtifactObjectStorage;
  const crypto = yield* Crypto.Crypto;
  const operationId = yield* crypto.randomUUIDv4;
  const result = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const source = yield* lockSource(sql, input);
        if (!source) return unavailable;
        if (
          source.pauseUnconfirmed ||
          source.reclaimOperationId ||
          source.resumePhase ||
          source.awaitingReopen ||
          source.restorePhase ||
          source.placementOperationId
        )
          return pendingState(source);
        if (source.allocationState === "running" && source.allocationId) {
          if (source.codexState === "replaced") return codexReplaced;
          const live = yield* readRunning(sql, input, source.generation);
          if (!live || live.binding.allocationId !== source.allocationId) return unavailable;
          yield* sql`INSERT INTO relay_workflow_vm_follow_ups
            (job_id,allocation_id,generation,actor_user_id,open_until)
            VALUES (${input.jobId},${source.allocationId},${source.generation},${input.userId},clock_timestamp()+interval '1 minute')
            ON CONFLICT(job_id) DO UPDATE SET allocation_id=excluded.allocation_id,generation=excluded.generation,
              open_until=excluded.open_until,operation_id=NULL,actor_user_id=excluded.actor_user_id,requested_at=NULL`;
          yield* makeThreadVmActivityStore(sql).recordWork(source.allocationId);
          if (source.codexState === "reconnect") return waitingForCodex;
          return { state: "running", live } as const;
        }
        if (source.allocationState === "paused" && source.allocationId) {
          if (source.codexState === "replaced") return codexReplaced;
          yield* sql`INSERT INTO relay_workflow_vm_follow_ups
            (job_id,operation_id,actor_user_id,allocation_id,generation,requested_at)
            VALUES (${input.jobId},${operationId},${input.userId},${source.allocationId},${source.generation},clock_timestamp())
            ON CONFLICT(job_id) DO UPDATE SET operation_id=excluded.operation_id,actor_user_id=excluded.actor_user_id,
              allocation_id=excluded.allocation_id,generation=excluded.generation,requested_at=excluded.requested_at,open_until=NULL`;
          yield* makeThreadVmResumeStore(sql).requestWorkflowFollowUp(source.threadId, input.jobId);
          return source.codexState === "reconnect" ? waitingForCodex : waiting;
        }
        if (
          !source.allocationId &&
          source.savedDiskOperationId &&
          source.savedDiskPhase === "available"
        ) {
          if (source.savedDiskIssue === "snapshot_unavailable")
            return restoreFailures.snapshot_unavailable;
          if (!settings.restoreEnabled) return unavailable;
          if (source.codexState === "replaced") return codexReplaced;
          const allocationId = yield* crypto.randomUUIDv4;
          yield* makeThreadVmRestoreStore(sql, objects).begin({
            threadId: source.threadId,
            savedDiskOperationId: source.savedDiskOperationId,
            operationId,
            allocationId,
            actorUserId: input.userId,
            expectedGeneration: source.generation,
            workflowJobId: input.jobId,
            serving: true,
          });
          yield* sql`INSERT INTO relay_workflow_vm_follow_ups
            (job_id,operation_id,actor_user_id,allocation_id,generation,requested_at)
            VALUES (${input.jobId},${operationId},${input.userId},${allocationId},${source.generation},clock_timestamp())
            ON CONFLICT(job_id) DO UPDATE SET operation_id=excluded.operation_id,actor_user_id=excluded.actor_user_id,
              allocation_id=excluded.allocation_id,generation=excluded.generation,requested_at=excluded.requested_at,open_until=NULL`;
          return source.codexState === "reconnect" ? waitingForCodex : waiting;
        }
        return pendingState(source);
      }),
    )
    .pipe(
      Effect.catchTags({
        PlatformError: () => Effect.succeed(unavailable),
        SchemaError: () => Effect.succeed(unavailable),
        ThreadNativeCheckpointConflict: () => Effect.succeed(unavailable),
        ThreadVmActivityConflict: () => Effect.succeed(unavailable),
        ThreadVmAllocationConflict: () => Effect.succeed(unavailable),
        ThreadVmBackupConflict: () => Effect.succeed(unavailable),
        ThreadVmCapacityConflict: () => Effect.succeed(unavailable),
        ThreadVmQuotaExceeded: () => Effect.succeed(unavailable),
        ThreadVmRestoreConflict: () => Effect.succeed(unavailable),
        ThreadVmResumeConflict: () => Effect.succeed(unavailable),
        ThreadVmSavedDiskConflict: () => Effect.succeed(unavailable),
      }),
    );
  if (result.state !== "running") return result;
  const { live } = result;
  const info = yield* makeE2BThreadVmCompute(settings.compute)
    .inspect(live.sandboxId)
    .pipe(Effect.catchTag("ThreadVmComputeError", () => Effect.succeed(null)));
  if (
    info?.state !== "running" ||
    info.sandboxId !== live.sandboxId ||
    info.templateId !== live.templateId.split(":")[0] ||
    info.lifecycle?.autoResume !== false ||
    info.network?.allowPublicTraffic !== false ||
    info.metadata["launchpad.managed"] !== "thread-vm-v1" ||
    info.metadata["launchpad.allocation_id"] !== live.binding.allocationId ||
    info.metadata["launchpad.thread_id"] !== live.binding.threadId ||
    info.metadata["launchpad.generation"] !== String(live.binding.generation) ||
    !threadVmOperationMatches(info.metadata, live.binding.operationId)
  )
    return unavailable;
  const current = yield* readWorkflowVmFollowUp(input);
  return current.state === "running" &&
    (current.binding.environmentId !== live.binding.environmentId ||
      current.binding.generation !== live.binding.generation)
    ? unavailable
    : current;
});

/** Withdraw revoked admission, retiring any issued cold boot through its exact stop receipt. */
export const discardRevokedWorkflowVmFollowUp = Effect.fn(
  "relay.workflow_vm.follow_up.discard_revoked",
)(function* (sql: PgClient, objects: ReturnType<typeof makeThreadArtifactObjects>, hostId: string) {
  const candidates = yield* sql<{
    jobId: string;
    threadId: string;
    operationId: string;
    kind: "create" | "resume";
  }>`
      SELECT f.job_id AS "jobId",a.thread_id AS "threadId",c.operation_id AS "operationId",c.kind
      FROM relay_workflow_vm_follow_ups f JOIN relay_workflow_jobs j USING(job_id)
      JOIN relay_thread_vm_capacity c ON c.operation_id=f.operation_id AND c.allocation_id=f.allocation_id
      JOIN relay_thread_vm_allocations a ON a.allocation_id=c.allocation_id
      LEFT JOIN relay_thread_vm_restores r ON r.operation_id=f.operation_id AND r.allocation_id=f.allocation_id
      LEFT JOIN relay_codex_vm_connections x ON x.organization_id=j.organization_id
        AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
      WHERE c.host_id=${hostId} AND (
        (c.kind='resume' AND c.state IN ('waiting','reserved')) OR
        (c.kind='create' AND c.state IN ('waiting','reserved','started')
          AND r.phase IN ('pending','preparing','prepared','committed','creating','bootstrapping','booted','importing')))
        AND (x.connection_id IS NULL OR NOT EXISTS(SELECT 1 FROM relay_organization_members m
          LEFT JOIN relay_workflow_run_configurations cfg ON cfg.job_id=j.job_id
          WHERE m.user_id=f.actor_user_id AND m.organization_id=j.organization_id
            AND (m.role='admin' OR EXISTS(SELECT 1 FROM relay_repository_access g
              WHERE g.user_id=m.user_id AND g.organization_id=j.organization_id AND g.repository_id=j.repository_id
                AND (g.role='maintainer' OR (g.role='developer' AND cfg.has_secrets=false))))))
      ORDER BY f.requested_at LIMIT 8`;
  for (const row of candidates)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const job = yield* lockWorkflowVmCheckpoint(sql, row.jobId);
        if (!job || (yield* authorizeWorkflowVmFollowUpRequest(sql, job, row.operationId))) return;
        if (row.kind === "resume") {
          yield* makeThreadVmResumeStore(sql).cancelWorkflow(row.threadId, row.jobId);
          return;
        }
        yield* makeThreadVmRestoreStore(sql, objects)
          .requestAbort(row.operationId)
          .pipe(Effect.catchTag("ThreadVmRestoreConflict", () => Effect.void));
      }),
    );
});
