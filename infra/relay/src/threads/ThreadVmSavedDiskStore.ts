import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";

export class ThreadVmSavedDiskConflict extends Schema.TaggedError<ThreadVmSavedDiskConflict>()(
  "ThreadVmSavedDiskConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmSavedDiskConflict({ message });
const savePin = (operationId: string) => `saved-${operationId}`;

export interface SavedDisk {
  readonly operationId: string;
  readonly threadId: string;
  readonly backupOperationId: string;
  readonly generation: number;
  readonly hostId: string;
  readonly savedAt: string;
  readonly expiresAt: string;
  readonly phase: "available" | "restoring" | "restored" | "expiring" | "expired";
  readonly restoreOperationId: string | null;
  readonly restoreAllocationId: string | null;
}
export interface SavedDiskExpiryClaim {
  readonly operationId: string;
  readonly backupOperationId: string;
  readonly snapshotId: string;
  readonly claimId: string;
}

/** Internal catalog. Final-save callers pin before compute deletion, then retain
 * after confirmed absence. This store does not certify native/history export. */
export function makeThreadVmSavedDiskStore(sql: PgClient) {
  const backups = makeThreadVmBackupRetentionStore(sql);
  const get = Effect.fn("relay.thread_vm.saved_disk.get")(function* (operationId: string) {
    const [row] = yield* sql<SavedDisk>`SELECT s.operation_id AS "operationId",
      s.thread_id AS "threadId", s.backup_operation_id AS "backupOperationId",
      s.generation, s.host_id AS "hostId", s.phase,
      to_char(s.saved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt",
      to_char(((s.saved_at AT TIME ZONE p.calendar_time_zone
        + make_interval(days => p.saved_disk_retention_days)) AT TIME ZONE p.calendar_time_zone)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
      s.restore_operation_id AS "restoreOperationId",
      s.restore_allocation_id AS "restoreAllocationId"
      FROM relay_thread_vm_saved_disks s
      JOIN relay_thread_placements t ON t.thread_id=s.thread_id
      JOIN relay_thread_vm_policies p ON p.organization_id=t.organization_id
      WHERE s.operation_id=${operationId}`;
    return row ?? null;
  });

  const retain = Effect.fn("relay.thread_vm.saved_disk.retain")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly backupOperationId: string;
    readonly generation: number;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{ generation: number; operationId: string | null }>`
        SELECT generation, operation_id AS "operationId" FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
        const prior = yield* get(input.operationId);
        if (prior) {
          if (
            prior.threadId !== input.threadId ||
            prior.backupOperationId !== input.backupOperationId ||
            prior.generation !== input.generation
          )
            return yield* conflict("Saved disk operation identity changed");
          return prior; // Reading/retrying never starts another retention period.
        }
        if (
          !/^[0-9a-f-]{36}$/u.test(input.operationId) ||
          placement?.generation !== input.generation ||
          placement.operationId !== null
        )
          return yield* conflict("Thread placement changed before retaining its disk");
        const [source] = yield* sql<{
          hostId: string;
          deletedAt: string;
        }>`SELECT c.host_id AS "hostId",
        a.deleted_at AS "deletedAt"
        FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id=x.allocation_id
        JOIN relay_thread_vm_capacity c ON c.allocation_id=a.allocation_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        WHERE x.operation_id=${input.backupOperationId} AND a.thread_id=${input.threadId}
          AND x.generation=${input.generation} AND x.phase='verified' AND x.probe_receipt IS NOT NULL
          AND a.state='deleted' AND a.deleted_at IS NOT NULL
          AND b.thread_id=t.thread_id AND b.environment_id=t.environment_id AND b.generation=t.generation
          AND EXISTS (SELECT 1 FROM relay_thread_vm_backup_pins p
            WHERE p.backup_operation_id=x.operation_id AND p.operation_id=${input.operationId})
        ORDER BY c.position DESC LIMIT 1 FOR UPDATE OF x`;
        if (!source) return yield* conflict("Final disk save or confirmed VM deletion is missing");
        const active = yield* sql`SELECT 1 FROM relay_thread_vm_allocations
        WHERE thread_id=${input.threadId} AND deleted_at IS NULL`;
        const existing = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
        WHERE thread_id=${input.threadId} AND generation=${input.generation}`;
        if (active.length || existing.length)
          return yield* conflict("Thread already has a VM or saved disk for this generation");
        yield* backups.pin({ ...input, operationId: savePin(input.operationId) });
        yield* sql`INSERT INTO relay_thread_vm_saved_disks
        (operation_id,thread_id,backup_operation_id,generation,host_id,saved_at,phase)
        VALUES (${input.operationId},${input.threadId},${input.backupOperationId},
          ${input.generation},${source.hostId},${source.deletedAt}::timestamptz,'available')`;
        yield* backups.releasePin(input);
        return (yield* get(input.operationId))!;
      }),
    );
  });

  /** Snapshot pin, user quota and physical capacity wait are one transaction.
   * Authorization belongs to the API caller; private v1 also checks ownership here. */
  const beginRestore = Effect.fn("relay.thread_vm.saved_disk.begin_restore")(function* (input: {
    readonly threadId: string;
    readonly savedDiskOperationId: string;
    readonly operationId: string;
    readonly allocationId: string;
    readonly actorUserId: string;
    readonly expectedGeneration: number;
    readonly replacementRequestId?: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Allocation reserve takes this lock before placement. Keep that order.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
        const [placement] = yield* sql<{
          generation: number;
          operationId: string | null;
          ownerUserId: string;
          organizationId: string;
        }>`SELECT generation,
        operation_id AS "operationId", owner_user_id AS "ownerUserId",
        organization_id AS "organizationId" FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
        if (!placement || placement.ownerUserId !== input.actorUserId)
          return yield* conflict("Only the private thread owner can restore its VM");
        yield* sql`SELECT operation_id FROM relay_thread_vm_saved_disks
        WHERE operation_id=${input.savedDiskOperationId} FOR UPDATE`;
        const save = yield* get(input.savedDiskOperationId);
        if (
          !save ||
          save.threadId !== input.threadId ||
          save.generation !== input.expectedGeneration
        )
          return yield* conflict("Saved disk does not belong to this thread generation");
        const verified = yield* sql`SELECT 1 FROM relay_thread_vm_backups
          WHERE operation_id = ${save.backupOperationId} AND phase='verified' AND probe_receipt IS NOT NULL`;
        if (!verified.length)
          return yield* conflict("Saved disk lacks a verified cold recovery receipt");
        if (save.phase === "restoring" && save.restoreOperationId === input.operationId) {
          if (
            save.restoreAllocationId !== input.allocationId ||
            placement.operationId !== input.operationId ||
            placement.generation !== input.expectedGeneration
          )
            return yield* conflict("Restore operation identity changed");
          return save;
        }
        if (save.restoreOperationId === input.operationId)
          return yield* conflict("Restore already ended; use a new operation identity");
        const [valid] = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s
        JOIN relay_thread_vm_policies p ON p.organization_id=${placement.organizationId}
        WHERE s.operation_id=${save.operationId} AND s.phase='available'
          AND ((s.saved_at AT TIME ZONE p.calendar_time_zone
            + make_interval(days => p.saved_disk_retention_days)) AT TIME ZONE p.calendar_time_zone)
            > clock_timestamp() FOR SHARE OF p`;
        if (
          !valid ||
          placement.operationId !== null ||
          placement.generation !== input.expectedGeneration
        )
          return yield* conflict("Saved disk expired or another operation won the restore");
        const [source] = yield* sql<{ templateId: string }>`SELECT a.template_id AS "templateId"
        FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE x.operation_id=${save.backupOperationId} AND x.phase='verified'
          AND a.state='deleted' AND a.deleted_at IS NOT NULL`;
        if (!source) return yield* conflict("Saved disk is no longer recoverable");
        yield* backups.pin({
          threadId: input.threadId,
          backupOperationId: save.backupOperationId,
          operationId: input.operationId,
        });
        yield* sql`UPDATE relay_thread_vm_saved_disks SET
        restore_operation_id=${input.operationId} WHERE operation_id=${save.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId}
        WHERE thread_id=${input.threadId}`;
        yield* makeThreadVmAllocationStore(sql).reserve({
          allocationId: input.allocationId,
          threadId: input.threadId,
          organizationId: placement.organizationId,
          ownerUserId: input.actorUserId,
          templateId: source.templateId,
          savedDiskRestoreOperationId: input.operationId,
          ...(input.replacementRequestId
            ? { replacementRequestId: input.replacementRequestId }
            : {}),
        });
        yield* makeThreadVmCapacityStore(sql).request({
          operationId: input.operationId,
          allocationId: input.allocationId,
          hostId: save.hostId,
          kind: "create",
        });
        yield* sql`UPDATE relay_thread_vm_saved_disks SET phase='restoring',
        restore_operation_id=${input.operationId},restore_allocation_id=${input.allocationId}
        WHERE operation_id=${save.operationId}`;
        return (yield* get(save.operationId))!;
      }),
    );
  });

  /** Caller must first reconcile and confirm absence of its quarantined allocation. */
  const cancelRestore = Effect.fn("relay.thread_vm.saved_disk.cancel_restore")(function* (input: {
    readonly threadId: string;
    readonly savedDiskOperationId: string;
    readonly operationId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{ operationId: string | null; generation: number }>`
        SELECT operation_id AS "operationId",generation FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
        yield* sql`SELECT operation_id FROM relay_thread_vm_saved_disks
        WHERE operation_id=${input.savedDiskOperationId} FOR UPDATE`;
        const save = yield* get(input.savedDiskOperationId);
        if (!save || save.threadId !== input.threadId)
          return yield* conflict("Saved disk belongs to another thread");
        if (
          save.phase === "available" &&
          save.restoreOperationId === input.operationId &&
          placement?.operationId === null &&
          placement.generation === save.generation
        )
          return save;
        if (
          save.phase !== "restoring" ||
          save.restoreOperationId !== input.operationId ||
          placement?.operationId !== input.operationId ||
          placement.generation !== save.generation
        )
          return yield* conflict("Restore no longer owns this placement");
        const [absent] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations
        WHERE allocation_id=${save.restoreAllocationId} AND state='deleted' AND deleted_at IS NOT NULL`;
        if (!absent) return yield* conflict("Restore allocation absence has not been confirmed");
        yield* backups.releasePin({
          backupOperationId: save.backupOperationId,
          operationId: input.operationId,
        });
        yield* sql`UPDATE relay_thread_vm_saved_disks SET phase='available'
        WHERE operation_id=${save.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${input.threadId}`;
        return (yield* get(save.operationId))!;
      }),
    );
  });

  const completeRestore = Effect.fn("relay.thread_vm.saved_disk.complete_restore")(
    function* (input: {
      readonly threadId: string;
      readonly savedDiskOperationId: string;
      readonly operationId: string;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
          yield* sql`SELECT operation_id FROM relay_thread_vm_saved_disks
        WHERE operation_id=${input.savedDiskOperationId} FOR UPDATE`;
          const save = yield* get(input.savedDiskOperationId);
          if (
            !save ||
            save.threadId !== input.threadId ||
            save.restoreOperationId !== input.operationId
          )
            return yield* conflict("Restore operation does not own this saved disk");
          if (save.phase === "restored") return;
          const [active] = yield* sql`SELECT 1 FROM relay_thread_placements t
        JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
        JOIN relay_thread_vm_setups s ON s.allocation_id=a.allocation_id
        JOIN relay_thread_vm_capacity c ON c.allocation_id=a.allocation_id
        WHERE t.thread_id=${input.threadId} AND t.generation=${save.generation + 1}
          AND t.operation_id IS NULL AND a.allocation_id=${save.restoreAllocationId}
          AND a.state='running' AND a.deleted_at IS NULL AND s.phase='ready'
          AND s.environment_id=b.environment_id
          AND c.operation_id=${input.operationId} AND c.state='started' AND c.compute_ref=a.compute_ref
          AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.revoked_at IS NULL`;
          if (save.phase !== "restoring" || !active)
            return yield* conflict("Restored VM activation has not been confirmed");
          yield* backups.releasePin({
            backupOperationId: save.backupOperationId,
            operationId: input.operationId,
          });
          yield* backups.releasePin({
            backupOperationId: save.backupOperationId,
            operationId: savePin(save.operationId),
          });
          yield* sql`UPDATE relay_thread_vm_saved_disks SET phase='restored'
        WHERE operation_id=${save.operationId}`;
        }),
      );
    },
  );

  const claimExpired = Effect.fn("relay.thread_vm.saved_disk.claim_expired")(function* (
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{ operationId: string; threadId: string }>`
        SELECT s.operation_id AS "operationId",s.thread_id AS "threadId"
        FROM relay_thread_vm_saved_disks s
        JOIN relay_thread_placements t ON t.thread_id=s.thread_id
        JOIN relay_thread_vm_policies p ON p.organization_id=t.organization_id
        WHERE s.host_id=${hostId} AND s.phase IN ('available','expiring')
          AND s.retry_at <= clock_timestamp()
          AND (s.claim_until IS NULL OR s.claim_until <= clock_timestamp())
          AND (s.phase='expiring' OR (t.operation_id IS NULL AND
            ((s.saved_at AT TIME ZONE p.calendar_time_zone
              + make_interval(days => p.saved_disk_retention_days)) AT TIME ZONE p.calendar_time_zone)
              <= clock_timestamp()))
        ORDER BY s.saved_at,s.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        yield* sql`SELECT operation_id FROM relay_thread_vm_saved_disks
        WHERE operation_id=${candidate.operationId} FOR UPDATE`;
        const save = yield* get(candidate.operationId);
        if (!save || !["available", "expiring"].includes(save.phase)) return null;
        const [backup] = yield* sql<{ snapshotId: string; phase: string }>`
        SELECT snapshot_id AS "snapshotId",phase FROM relay_thread_vm_backups
        WHERE operation_id=${save.backupOperationId} FOR UPDATE`;
        if (!backup?.snapshotId) return yield* conflict("Saved disk snapshot identity is missing");
        if (save.phase === "available") {
          const [due] = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s
          JOIN relay_thread_placements t ON t.thread_id=s.thread_id
          JOIN relay_thread_vm_policies p ON p.organization_id=t.organization_id
          WHERE s.operation_id=${save.operationId} AND s.phase='available' AND t.operation_id IS NULL
            AND ((s.saved_at AT TIME ZONE p.calendar_time_zone
              + make_interval(days => p.saved_disk_retention_days)) AT TIME ZONE p.calendar_time_zone)
              <= clock_timestamp() FOR SHARE OF p`;
          const pins = yield* sql`SELECT 1 FROM relay_thread_vm_backup_pins
          WHERE backup_operation_id=${save.backupOperationId}
            AND operation_id != ${savePin(save.operationId)}`;
          if (!due || pins.length || backup.phase !== "verified") return null;
          // This is the expiry/restore winner. New pins cannot revive a retiring root.
          yield* sql`UPDATE relay_thread_vm_saved_disks SET phase='expiring'
          WHERE operation_id=${save.operationId}`;
          yield* backups.releasePin({
            backupOperationId: save.backupOperationId,
            operationId: savePin(save.operationId),
          });
          yield* sql`UPDATE relay_thread_vm_backups SET phase='retiring'
          WHERE operation_id=${save.backupOperationId}`;
        }
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const claimed = yield* sql`UPDATE relay_thread_vm_saved_disks SET claim_id=${claimId},
        claim_until=clock_timestamp()+interval '2 minutes'
        WHERE operation_id=${save.operationId}
          AND (claim_until IS NULL OR claim_until <= clock_timestamp()) RETURNING operation_id`;
        if (!claimed.length) return null;
        return {
          operationId: save.operationId,
          backupOperationId: save.backupOperationId,
          snapshotId: backup.snapshotId,
          claimId,
        } satisfies SavedDiskExpiryClaim;
      }),
    );
  });
  const completeExpiry = Effect.fn("relay.thread_vm.saved_disk.complete_expiry")(function* (
    claim: SavedDiskExpiryClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE relay_thread_vm_saved_disks s SET phase='expired',
        claim_id=NULL,claim_until=NULL FROM relay_thread_vm_backups x
        WHERE s.operation_id=${claim.operationId}
        AND s.backup_operation_id=${claim.backupOperationId} AND s.phase='expiring'
        AND s.claim_id=${claim.claimId} AND s.claim_until>clock_timestamp()
        AND x.operation_id=s.backup_operation_id AND x.snapshot_id=${claim.snapshotId}
        AND x.phase IN ('retiring','retired') RETURNING s.operation_id`;
        if (!rows.length) return false;
        yield* sql`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL
        WHERE operation_id=${claim.backupOperationId} AND snapshot_id=${claim.snapshotId}
          AND phase='retiring'`;
        return true;
      }),
    );
  });
  const deferExpiry = Effect.fn("relay.thread_vm.saved_disk.defer_expiry")(function* (
    claim: SavedDiskExpiryClaim,
  ) {
    yield* sql`UPDATE relay_thread_vm_saved_disks SET claim_id=NULL,claim_until=NULL,
      retry_at=clock_timestamp()+interval '1 minute'
      WHERE operation_id=${claim.operationId} AND phase='expiring' AND claim_id=${claim.claimId}`;
  });
  return {
    get,
    retain,
    beginRestore,
    cancelRestore,
    completeRestore,
    claimExpired,
    completeExpiry,
    deferExpiry,
  };
}
