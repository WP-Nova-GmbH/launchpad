import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { ThreadVmBackupConflict } from "./ThreadVmBackupStore.ts";

const decodeRestoreStatus = Schema.decodeUnknownEffect(E2BRestoreStatus);

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
        WHERE a.thread_id = ${input.threadId} AND x.operation_id = ${input.backupOperationId}
          AND x.phase = 'verified' AND x.snapshot_id IS NOT NULL
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
        WHERE x.phase IN ('verified','retiring') AND x.snapshot_id IS NOT NULL
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
              WHERE newer.allocation_id = x.allocation_id AND newer.phase = 'verified'
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
          WHERE x.operation_id = ${candidate.operationId} AND n.phase = 'verified'
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

  // Failed periodic candidates have no recovery value. A final-save candidate
  // belongs to its separate abort protocol and must never be collected here.
  const claimFailed = Effect.fn("relay.thread_vm.backup.failed_claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{ operationId: string; threadId: string }>`
        SELECT x.operation_id AS "operationId", t.thread_id AS "threadId"
        FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id=x.allocation_id
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        WHERE x.phase='failed' AND x.snapshot_id IS NOT NULL
          AND x.source_template_id IS NOT NULL AND x.source_build_id IS NOT NULL
          AND x.snapshot_name='launchpad-backup-' || x.operation_id::text
          AND t.operation_id IS NULL AND x.retry_at <= clock_timestamp()
          AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backup_pins pin WHERE pin.backup_operation_id=x.operation_id)
          AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id AND c.host_id=${hostId})
        ORDER BY x.created_at,x.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        yield* sql`SELECT operation_id FROM relay_thread_vm_backups WHERE operation_id=${candidate.operationId} FOR UPDATE`;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const [row] = yield* sql<{ snapshotId: string }>`
        UPDATE relay_thread_vm_backups x SET claim_id=${claimId}, claim_until=clock_timestamp()+interval '2 minutes'
        WHERE x.operation_id=${candidate.operationId} AND x.phase='failed'
          AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM relay_thread_placements t WHERE t.thread_id=${candidate.threadId} AND t.operation_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backup_pins pin WHERE pin.backup_operation_id=x.operation_id)
        RETURNING x.snapshot_id AS "snapshotId"`;
        return row
          ? ({
              operationId: candidate.operationId,
              claimId,
              snapshotId: row.snapshotId,
            } satisfies BackupRetirementClaim)
          : null;
      }),
    );
  });

  const retireFailed = Effect.fn("relay.thread_vm.backup.failed_probe_stopped")(function* (
    input: BackupRetirementClaim,
    receipt: unknown,
  ) {
    const stopped = yield* decodeRestoreStatus(receipt).pipe(
      Effect.mapError(
        () => new ThreadVmBackupConflict({ message: "Failed recovery probe stop is unconfirmed" }),
      ),
    );
    if (
      stopped.operationID !== input.operationId ||
      stopped.generation !== `backup-${input.operationId}` ||
      stopped.state !== "cancelled"
    )
      return yield* new ThreadVmBackupConflict({
        message: "Failed recovery probe stop belongs to a different preparation",
      });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{ threadId: string }>`SELECT t.thread_id AS "threadId"
        FROM relay_thread_placements t JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id
        JOIN relay_thread_vm_backups x ON x.allocation_id=a.allocation_id
        WHERE x.operation_id=${input.operationId} FOR UPDATE OF t`;
        if (!placement) return false;
        yield* sql`SELECT operation_id FROM relay_thread_vm_backups WHERE operation_id=${input.operationId} FOR UPDATE`;
        const rows =
          yield* sql`UPDATE relay_thread_vm_backups x SET phase='retiring', failed_probe_stopped_at=clock_timestamp()
        WHERE x.operation_id=${input.operationId} AND x.snapshot_id=${input.snapshotId}
          AND x.phase='failed' AND x.claim_id=${input.claimId} AND x.claim_until > clock_timestamp()
          AND (x.probe_receipt IS NULL OR x.probe_receipt->>'preparedBuildID'=${stopped.preparedBuildID})
          AND EXISTS (SELECT 1 FROM relay_thread_placements t WHERE t.thread_id=${placement.threadId} AND t.operation_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backup_pins pin WHERE pin.backup_operation_id=x.operation_id)
        RETURNING operation_id`;
        return rows.length === 1;
      }),
    );
  });

  const complete = Effect.fn("relay.thread_vm.backup.retirement_complete")(function* (
    input: BackupRetirementClaim,
  ) {
    const rows = yield* sql`UPDATE relay_thread_vm_backups SET phase = 'retired',
      claim_id = NULL, claim_until = NULL
      WHERE operation_id = ${input.operationId} AND snapshot_id = ${input.snapshotId}
        AND phase = 'retiring' AND claim_id = ${input.claimId}
        AND claim_until > clock_timestamp() RETURNING operation_id`;
    return rows.length === 1;
  });
  const defer = Effect.fn("relay.thread_vm.backup.retirement_defer")(function* (
    input: BackupRetirementClaim,
  ) {
    yield* sql`UPDATE relay_thread_vm_backups SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE operation_id = ${input.operationId} AND snapshot_id = ${input.snapshotId}
        AND phase IN ('failed','retiring') AND claim_id = ${input.claimId}`;
  });
  return { pin, releasePin, claim, claimFailed, retireFailed, complete, defer };
}
