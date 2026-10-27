import { ThreadId } from "@t3tools/contracts";
import type {
  RelayThreadVmReset,
  RelayThreadVmRestorePhase,
  RelayThreadVmReplacement,
} from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { readPendingThreadVmProviderAuth } from "./ThreadVmPendingProviderAuth.ts";

/** Database-only observation. The caller holds current thread read access;
 * querying this store never creates, inspects, resumes or renews compute. */
export function makeThreadVmStatusStore(sql: PgClient) {
  const read = Effect.fn("relay.thread_vm.status.read")(function* (
    threadId: string,
    generation: number,
  ) {
    const [row] = yield* sql<{
      allocationId: string | null;
      ownerUserId: string | null;
      allocationState: "creating" | "running" | "paused" | "deleting" | null;
      setupPhase: "pending" | "running" | "ready" | "failed" | null;
      capacityState: "waiting" | "reserved" | "started" | "released" | null;
      activity: "busy" | "idle" | "unknown";
      pausePhase: "pending" | "sealed" | "completed" | "cancelled" | null;
      resumePhase: "waiting" | "resuming" | "completed" | null;
      backupPhase:
        | "pending"
        | "creating"
        | "captured"
        | "verifying"
        | "cleanup"
        | "verified"
        | "failed"
        | "retiring"
        | "retired"
        | null;
      lastVerifiedBackupAt: string | null;
      finalSaveOperationId: string | null;
      finalSavePhase: "draining" | "frozen" | "saving" | "deleting" | "aborting" | null;
      finalSaveReason: "idle" | "replacement" | null;
      finalSaveErrorCode: string | null;
      restoreOperationId: string | null;
      restorePhase: RelayThreadVmRestorePhase | null;
      restoreErrorCode: string | null;
      restoreCanCancel: boolean;
      recoveryStage:
        | "saving_history"
        | "retaining_source"
        | "stopping_source"
        | "restoring_workspace"
        | null;
    }>`SELECT a.allocation_id AS "allocationId", a.owner_user_id AS "ownerUserId",
      a.state AS "allocationState", coalesce(ready.phase,s.phase) AS "setupPhase", c.state AS "capacityState",
      CASE WHEN v.observed_at >= clock_timestamp() - interval '2 minutes'
        THEN v.activity ELSE 'unknown' END AS activity,
      pause.phase AS "pausePhase", resume.phase AS "resumePhase",
      backup.phase AS "backupPhase", verified.at AS "lastVerifiedBackupAt",
      final.operation_id AS "finalSaveOperationId",final.phase AS "finalSavePhase",
      final.reason AS "finalSaveReason",final.error_code AS "finalSaveErrorCode",
      coalesce(restore.operation_id,recovery.operation_id) AS "restoreOperationId",
      CASE WHEN restore.operation_id IS NOT NULL THEN restore.phase WHEN recovery.operation_id IS NOT NULL THEN 'pending' END AS "restorePhase",
      coalesce(restore.error_code,recovery.error_code) AS "restoreErrorCode",
      ((restore.saved_disk_operation_id IS NOT NULL AND restore.phase IN ('pending','preparing','prepared','boot_preparing','boot_prepared'))
        OR (restore.operation_id IS NULL AND recovery.phase='pending')) AS "restoreCanCancel",
      CASE WHEN restore.operation_id IS NOT NULL THEN NULL WHEN recovery.phase='pending' THEN 'saving_history'
        WHEN recovery.phase='retaining' THEN 'retaining_source' WHEN recovery.phase='retained' THEN 'stopping_source'
        WHEN recovery.phase IN ('stopped','restoring') THEN 'restoring_workspace' END AS "recoveryStage"
      FROM relay_thread_placements t
      LEFT JOIN relay_thread_vm_allocations a ON a.thread_id = t.thread_id
        AND a.deleted_at IS NULL
      LEFT JOIN relay_thread_vm_setups s ON s.allocation_id = a.allocation_id
      LEFT JOIN relay_thread_vm_ready ready ON ready.allocation_id = a.allocation_id
      LEFT JOIN relay_thread_vm_activity v ON v.allocation_id = a.allocation_id
      LEFT JOIN LATERAL (SELECT state FROM relay_thread_vm_capacity
        WHERE allocation_id = a.allocation_id ORDER BY position DESC LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT phase FROM relay_thread_vm_pauses
        WHERE allocation_id = a.allocation_id LIMIT 1) pause ON true
      LEFT JOIN LATERAL (SELECT phase FROM relay_thread_vm_resumes
        WHERE allocation_id = a.allocation_id LIMIT 1) resume ON true
      LEFT JOIN LATERAL (SELECT phase FROM relay_thread_vm_backups
        WHERE allocation_id = a.allocation_id ORDER BY created_at DESC,operation_id DESC
        LIMIT 1) backup ON true
      LEFT JOIN LATERAL (SELECT to_char(verified_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM relay_thread_vm_backups
        WHERE allocation_id = a.allocation_id AND phase = 'verified'
        ORDER BY verified_at DESC LIMIT 1) verified ON true
      LEFT JOIN relay_thread_vm_final_saves final ON final.thread_id=t.thread_id
        AND final.generation=t.generation AND final.operation_id=t.operation_id
        AND final.phase NOT IN ('completed','aborted')
      LEFT JOIN relay_thread_vm_restores restore ON restore.thread_id=t.thread_id
        AND (restore.generation=t.generation OR restore.generation+1=t.generation)
        AND restore.operation_id=t.operation_id AND restore.phase NOT IN ('aborted','completed')
      LEFT JOIN relay_thread_vm_backup_recoveries recovery ON recovery.thread_id=t.thread_id AND recovery.generation=t.generation
        AND recovery.operation_id=t.operation_id AND recovery.phase NOT IN ('completed','cancelled')
      WHERE t.thread_id = ${threadId} AND t.generation=${generation}`;
    const [saved] = yield* sql<{ operationId: string }>`SELECT operation_id AS "operationId"
      FROM relay_thread_vm_saved_disks WHERE thread_id=${threadId}
        AND (generation=${generation} OR (phase='restoring' AND restore_operation_id=(SELECT operation_id FROM relay_thread_placements WHERE thread_id=${threadId} AND generation=${generation}))) AND phase != 'restored'
      ORDER BY saved_at DESC LIMIT 1`;
    const disk = saved ? yield* makeThreadVmSavedDiskStore(sql).get(saved.operationId) : null;
    const [reset] = yield* sql<
      Pick<RelayThreadVmReset, "operationId" | "phase" | "errorCode">
    >`SELECT r.operation_id AS "operationId",r.phase,r.error_code AS "errorCode" FROM relay_thread_vm_resets r JOIN relay_thread_placements t USING(thread_id) WHERE r.thread_id=${threadId} AND t.generation=${generation} AND r.operation_id=t.operation_id AND (r.expected_generation=t.generation OR r.expected_generation+1=t.generation) AND r.phase NOT IN('cancelled','completed')`;
    const [replacement] = yield* sql<
      Omit<RelayThreadVmReplacement, "threadId">
    >`SELECT request_id AS "requestId",phase,victim_allocation_id AS "victimAllocationId",error_code AS "errorCode" FROM relay_thread_vm_replacements WHERE thread_id=${threadId} AND phase IN('awaiting_choice','waiting') ORDER BY position DESC LIMIT 1`;
    const [repository] = yield* sql<{
      canonicalKey: string;
      branch: string;
      revision: string;
    }>`SELECT alias.canonical_key AS "canonicalKey",coalesce(c.workspace_branch,'main') AS branch,
        c.workspace_revision AS revision
      FROM relay_thread_move_checkpoints c JOIN relay_thread_moves m USING(operation_id)
      JOIN relay_thread_placements t ON t.thread_id=c.thread_id
      JOIN LATERAL (SELECT min(r.canonical_key) AS canonical_key FROM relay_repository_aliases r
        WHERE r.repository_id=t.repository_id AND r.organization_id=t.organization_id
          AND r.canonical_key LIKE 'github.com/%' HAVING count(*)=1) alias ON true
      WHERE c.thread_id=${threadId} AND m.phase='completed' AND c.repository_retained
        AND c.repository_upload IS NOT NULL AND c.workspace_revision IS NOT NULL
      ORDER BY m.expected_generation DESC,c.verified_at DESC,c.operation_id DESC LIMIT 1`;
    return {
      threadId: ThreadId.make(threadId),
      generation: generation,
      pendingProviderAuth: (yield* readPendingThreadVmProviderAuth(sql, threadId))?.binding ?? null,
      allocation:
        row?.allocationId && row.ownerUserId && row.allocationState
          ? {
              allocationId: row.allocationId,
              ownerUserId: row.ownerUserId,
              state: row.allocationState,
            }
          : null,
      setupPhase: row?.setupPhase ?? null,
      capacityState: row?.capacityState ?? null,
      activity: row?.activity ?? "unknown",
      pausePhase: row?.pausePhase ?? null,
      resumePhase: row?.resumePhase ?? null,
      backupPhase: row?.backupPhase ?? null,
      lastVerifiedBackupAt: row?.lastVerifiedBackupAt ?? null,
      finalSave:
        row?.finalSaveOperationId && row.finalSavePhase && row.finalSaveReason
          ? {
              operationId: row.finalSaveOperationId,
              phase: row.finalSavePhase,
              reason: row.finalSaveReason,
              errorCode: row.finalSaveErrorCode,
            }
          : null,
      restore:
        row?.restoreOperationId && row.restorePhase
          ? {
              operationId: row.restoreOperationId,
              phase: row.restorePhase,
              canCancel: row.restoreCanCancel,
              ...(row.recoveryStage ? { recoveryStage: row.recoveryStage } : {}),
              errorCode: row.restoreErrorCode,
            }
          : null,
      reset: reset ?? null,
      replacement: replacement ? { ...replacement, threadId: ThreadId.make(threadId) } : null,
      repository: repository ?? null,
      savedDisk:
        disk && disk.phase !== "restored"
          ? {
              operationId: disk.operationId,
              phase: disk.phase,
              savedAt: disk.savedAt,
              expiresAt: disk.expiresAt,
            }
          : null,
    };
  });
  return { read };
}
