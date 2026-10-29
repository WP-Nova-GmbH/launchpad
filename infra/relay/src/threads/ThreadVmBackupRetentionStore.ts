import { releaseThreadNativeCheckpointOperation } from "./ThreadNativeCheckpointStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ThreadVmBackupConflict } from "./ThreadVmBackupStore.ts";

export interface BackupRetirementClaim {
  readonly operationId: string;
  readonly claimId: string;
  readonly snapshotId: string;
}

/** Retire catalog roots only. The compute-host collector owns physical layers. */
export function makeThreadVmBackupRetentionStore(sql: PgClient) {
  const pin = Effect.fn("relay.thread_vm.backup.pin")(function* (input: {
    readonly threadId: string;
    readonly backupOperationId: string;
    readonly operationId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id = ${input.threadId} FOR UPDATE`;
        const [backup] = yield* sql`SELECT x.operation_id FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
        WHERE a.runtime_protocol='native-v1' AND a.thread_id = ${input.threadId} AND x.operation_id = ${input.backupOperationId}
          AND x.phase = 'verified' AND x.snapshot_id IS NOT NULL AND x.native_capture_receipt IS NOT NULL
        FOR UPDATE OF x`;
        if (!backup)
          return yield* new ThreadVmBackupConflict({
            message: "Recovery save is unavailable or already retiring",
          });
        yield* sql`INSERT INTO relay_thread_vm_backup_pins (backup_operation_id,operation_id)
        VALUES (${input.backupOperationId},${input.operationId}) ON CONFLICT DO NOTHING`;
      }),
    );
  });

  const releasePin = Effect.fn("relay.thread_vm.backup.release_pin")(function* (input: {
    readonly backupOperationId: string;
    readonly operationId: string;
  }) {
    yield* sql`DELETE FROM relay_thread_vm_backup_pins
      WHERE backup_operation_id = ${input.backupOperationId} AND operation_id = ${input.operationId}`;
  });

  const claim = Effect.fn("relay.thread_vm.backup.retirement_claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Lock order matches moves and snapshot consumers: placement, then save.
        // A lost delete reply has already won the pin race and must be reconciled.
        const [candidate] = yield* sql<{ operationId: string; threadId: string }>`
        SELECT x.operation_id AS "operationId", t.thread_id AS "threadId"
        FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE a.runtime_protocol='native-v1' AND x.phase IN ('verified','retiring') AND x.snapshot_id IS NOT NULL AND x.native_capture_receipt IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_saved_disks s
            WHERE s.backup_operation_id=x.operation_id AND s.phase='expiring')
          AND x.retry_at <= clock_timestamp()
          AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c
            WHERE c.allocation_id = a.allocation_id AND c.host_id = ${hostId})
          AND (x.phase = 'retiring' OR (t.operation_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backup_pins p
              WHERE p.backup_operation_id = x.operation_id)
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups active
              WHERE active.allocation_id = a.allocation_id
                AND active.phase IN ('pending','creating','captured','verifying','cleanup'))
            AND EXISTS (SELECT 1 FROM relay_thread_vm_backups newer
              WHERE newer.allocation_id = x.allocation_id AND newer.phase = 'verified' AND newer.native_capture_receipt IS NOT NULL
                AND (newer.verified_at,newer.operation_id) > (x.verified_at,x.operation_id))))
        ORDER BY x.verified_at,x.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const [current] = yield* sql<{ snapshotId: string; phase: string }>`
        SELECT snapshot_id AS "snapshotId", phase FROM relay_thread_vm_backups
        WHERE operation_id = ${candidate.operationId} FOR UPDATE`;
        if (!current || !["verified", "retiring"].includes(current.phase)) return null;
        const expiry = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
          WHERE backup_operation_id=${candidate.operationId} AND phase='expiring'`;
        if (expiry.length) return null;
        // Pin and retirement both own the placement lock. Recheck after waiting
        // for it, rather than authorizing deletion from the earlier SELECT view.
        if (current.phase === "verified") {
          const [placement] = yield* sql`SELECT 1 FROM relay_thread_placements
          WHERE thread_id = ${candidate.threadId} AND operation_id IS NULL`;
          const active = yield* sql`SELECT 1 FROM relay_thread_vm_backups work
          JOIN relay_thread_vm_backups old ON old.allocation_id = work.allocation_id
          WHERE old.operation_id = ${candidate.operationId}
            AND work.phase IN ('pending','creating','captured','verifying','cleanup')`;
          const pins = yield* sql`SELECT 1 FROM relay_thread_vm_backup_pins
          WHERE backup_operation_id = ${candidate.operationId}`;
          const [newer] = yield* sql`SELECT 1 FROM relay_thread_vm_backups n
          JOIN relay_thread_vm_backups x ON x.allocation_id = n.allocation_id
          WHERE x.operation_id = ${candidate.operationId} AND n.phase = 'verified' AND n.native_capture_receipt IS NOT NULL
            AND (n.verified_at,n.operation_id) > (x.verified_at,x.operation_id) LIMIT 1`;
          if (!placement || active.length || pins.length || !newer) return null;
        }
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const rows = yield* sql`UPDATE relay_thread_vm_backups SET phase = 'retiring',
        claim_id = ${claimId}, claim_until = clock_timestamp() + interval '2 minutes'
        WHERE operation_id = ${candidate.operationId}
          AND (claim_until IS NULL OR claim_until <= clock_timestamp()) RETURNING operation_id`;
        return rows.length
          ? ({
              operationId: candidate.operationId,
              claimId,
              snapshotId: current.snapshotId,
            } satisfies BackupRetirementClaim)
          : null;
      }),
    );
  });

  /** Only a positive native terminal-error identity permits failed-root cleanup. */
  const claimFailed = Effect.fn("relay.thread_vm.backup.failed_retirement_claim")(function* (
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
          threadId: string;
        }>`SELECT x.operation_id AS "operationId",a.thread_id AS "threadId"
        FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        WHERE a.runtime_protocol='native-v1' AND x.phase IN ('failed','retiring') AND x.source_receipt IS NOT NULL AND x.native_capture_receipt IS NULL AND x.capture_started_at IS NOT NULL
          AND x.snapshot_id IS NOT NULL AND x.source_template_id IS NOT NULL AND x.source_build_id IS NOT NULL
          AND x.retry_at<=clock_timestamp() AND (x.claim_until IS NULL OR x.claim_until<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_backup_pins p WHERE p.backup_operation_id=x.operation_id)
          AND EXISTS(SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id AND c.host_id=${hostId})
        ORDER BY x.created_at,x.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const [row] = yield* sql<{
          snapshotId: string;
        }>`UPDATE relay_thread_vm_backups x SET phase='retiring',claim_id=${claimId},claim_until=clock_timestamp()+interval '2 minutes'
        WHERE x.operation_id=${candidate.operationId} AND x.phase IN ('failed','retiring') AND x.native_capture_receipt IS NULL
          AND (x.claim_until IS NULL OR x.claim_until<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_backup_pins p WHERE p.backup_operation_id=x.operation_id)
        RETURNING x.snapshot_id AS "snapshotId"`;
        return row
          ? { operationId: candidate.operationId, claimId, snapshotId: row.snapshotId }
          : null;
      }),
    );
  });
  const complete = Effect.fn("relay.thread_vm.backup.retirement_complete")(function* (
    input: BackupRetirementClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [owner] = yield* sql<{
          threadId: string;
        }>`SELECT a.thread_id AS "threadId" FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.runtime_protocol='native-v1' AND x.operation_id=${input.operationId}`;
        if (!owner) return false;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${owner.threadId} FOR UPDATE`;
        const [row] = yield* sql<{
          operationId: string;
          allocationId: string;
          sourceReceipt: unknown;
        }>`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL
        WHERE operation_id=${input.operationId} AND snapshot_id=${input.snapshotId} AND phase='retiring'
          AND claim_id=${input.claimId} AND claim_until>clock_timestamp()
        RETURNING operation_id AS "operationId",allocation_id AS "allocationId",source_receipt AS "sourceReceipt"`;
        if (!row) return false;
        if (row.sourceReceipt)
          yield* releaseThreadNativeCheckpointOperation(sql, {
            threadId: owner.threadId,
            operationId: row.operationId,
          });
        return true;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.backup.retirement_defer")(function* (
    input: BackupRetirementClaim,
  ) {
    yield* sql`UPDATE relay_thread_vm_backups SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE operation_id = ${input.operationId} AND snapshot_id = ${input.snapshotId}
        AND phase IN ('failed','retiring') AND claim_id = ${input.claimId}`;
  });
  return { pin, releasePin, claim, claimFailed, complete, defer };
}
