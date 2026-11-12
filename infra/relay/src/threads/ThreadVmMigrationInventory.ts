import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MigrationPinId = Schema.String.check(
  Schema.isPattern(/^e2b-migration-[a-z0-9][a-z0-9-]{0,48}$/u),
);
const decodePinId = Schema.decodeEffect(MigrationPinId);

export class ThreadVmMigrationConflict extends Schema.TaggedError<ThreadVmMigrationConflict>()(
  "ThreadVmMigrationConflict",
  { message: Schema.String },
) {}

interface Allocation {
  readonly allocationId: string;
  readonly threadId: string;
  readonly generation: number | null;
  readonly placementGeneration: number;
  readonly state: string;
  readonly computeRef: string | null;
  readonly templateId: string;
  readonly nativePausedGeneration: number | null;
  readonly runtimeProtocol: "legacy" | "native-v1";
}

interface Backup {
  readonly operationId: string;
  readonly allocationId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly phase: string;
  readonly snapshotId: string | null;
  readonly sourceTemplateId: string | null;
  readonly sourceBuildId: string | null;
  readonly hasLegacyColdProof: boolean;
  readonly hasNativeCaptureReceipt: boolean;
  readonly pinOperationIds: ReadonlyArray<string>;
}

interface SavedDisk {
  readonly operationId: string;
  readonly threadId: string;
  readonly backupOperationId: string;
  readonly generation: number;
  readonly phase: string;
  readonly savedAt: string;
  readonly expiresAt: string | null;
}

interface Operation {
  readonly kind: string;
  readonly operationId: string;
  readonly threadId: string;
  readonly phase: string;
}

export interface ThreadVmMigrationCatalogue {
  readonly hostId: string;
  readonly hostConfigured: boolean;
  readonly collectedAt: string;
  readonly allocations: ReadonlyArray<Allocation>;
  readonly backups: ReadonlyArray<Backup>;
  readonly savedDisks: ReadonlyArray<SavedDisk>;
  readonly pendingOperations: ReadonlyArray<Operation>;
}

/** These blockers cover relay catalogue mutations, not guest or host quiescence. */
export function threadVmMigrationBlockers(catalogue: ThreadVmMigrationCatalogue) {
  return [
    ...(!catalogue.hostConfigured
      ? [{ kind: "host", id: catalogue.hostId, state: "unknown" }]
      : []),
    ...catalogue.allocations
      .filter(
        (allocation) =>
          (allocation.generation === null && allocation.state !== "deleted") ||
          ["creating", "deleting"].includes(allocation.state),
      )
      .map((allocation) => ({
        kind: "allocation",
        id: allocation.allocationId,
        state: allocation.generation === null ? "missing-provision-generation" : allocation.state,
      })),
    ...catalogue.backups
      .filter(
        (backup) =>
          backup.phase !== "retired" &&
          (backup.phase !== "verified" ||
            !backup.snapshotId ||
            !backup.sourceTemplateId ||
            !backup.sourceBuildId ||
            (!backup.hasLegacyColdProof && !backup.hasNativeCaptureReceipt)),
      )
      .map((backup) => ({ kind: "backup", id: backup.operationId, state: backup.phase })),
    ...catalogue.savedDisks
      .filter(
        (disk) =>
          ["restoring", "expiring"].includes(disk.phase) ||
          (disk.phase === "available" && disk.expiresAt === null),
      )
      .map((disk) => ({ kind: "saved-disk", id: disk.operationId, state: disk.phase })),
    ...catalogue.pendingOperations.map((operation) => ({
      kind: operation.kind,
      id: operation.operationId,
      state: operation.phase,
    })),
  ];
}

export function makeThreadVmMigrationInventory(sql: PgClient) {
  // Include released capacity: paused VMs and saved disks still belong to their host.
  const allocationIds = (
    hostId: string,
  ) => sql`SELECT allocation_id FROM relay_thread_vm_capacity WHERE host_id=${hostId}
    UNION SELECT b.allocation_id FROM relay_thread_vm_backups b
      JOIN relay_thread_vm_saved_disks s ON s.backup_operation_id=b.operation_id WHERE s.host_id=${hostId}`;
  const threadIds = (
    hostId: string,
  ) => sql`SELECT thread_id FROM relay_thread_vm_allocations WHERE allocation_id IN (${allocationIds(hostId)})
    UNION SELECT thread_id FROM relay_thread_vm_restores WHERE host_id=${hostId}
    UNION SELECT thread_id FROM relay_thread_vm_resets WHERE host_id=${hostId}
    UNION SELECT thread_id FROM relay_thread_vm_replacements WHERE host_id=${hostId}
    UNION SELECT thread_id FROM relay_thread_vm_backup_recoveries WHERE host_id=${hostId}
    UNION SELECT thread_id FROM relay_thread_vm_final_saves WHERE host_id=${hostId}
    UNION SELECT thread_id FROM relay_thread_deletions WHERE host_id=${hostId}`;

  const readCatalogue = Effect.fn("relay.thread_vm.migration.read_catalogue")(function* (
    hostId: string,
  ) {
    const [host] = yield* sql`SELECT host_id FROM relay_thread_vm_hosts WHERE host_id=${hostId}`;
    const [clock] = yield* sql<{
      at: string;
    }>`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
    const allocations =
      yield* sql<Allocation>`SELECT a.allocation_id AS "allocationId",a.thread_id AS "threadId",
      p.generation,t.generation AS "placementGeneration",a.state,a.compute_ref AS "computeRef",a.template_id AS "templateId",
      a.native_paused_generation AS "nativePausedGeneration",a.runtime_protocol AS "runtimeProtocol"
      FROM relay_thread_vm_allocations a JOIN relay_thread_placements t USING(thread_id)
      LEFT JOIN relay_thread_vm_provisions p USING(allocation_id)
      WHERE a.allocation_id IN (${allocationIds(hostId)}) ORDER BY a.allocation_id`;
    const backups =
      yield* sql<Backup>`SELECT b.operation_id AS "operationId",b.allocation_id AS "allocationId",
      a.thread_id AS "threadId",b.generation,b.phase,b.snapshot_id AS "snapshotId",
      b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",
      b.probe_receipt IS NOT NULL AS "hasLegacyColdProof",
      b.native_capture_receipt IS NOT NULL AS "hasNativeCaptureReceipt",
      ARRAY(SELECT operation_id FROM relay_thread_vm_backup_pins p
        WHERE p.backup_operation_id=b.operation_id ORDER BY operation_id) AS "pinOperationIds"
      FROM relay_thread_vm_backups b JOIN relay_thread_vm_allocations a USING(allocation_id)
      WHERE b.allocation_id IN (${allocationIds(hostId)}) ORDER BY b.operation_id`;
    const savedDisks =
      yield* sql<SavedDisk>`SELECT s.operation_id AS "operationId",s.thread_id AS "threadId",
      s.backup_operation_id AS "backupOperationId",s.generation,s.phase,
      to_char(s.saved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt",
      to_char(((s.saved_at AT TIME ZONE p.calendar_time_zone + make_interval(days => p.saved_disk_retention_days))
        AT TIME ZONE p.calendar_time_zone) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
      FROM relay_thread_vm_saved_disks s JOIN relay_thread_placements t USING(thread_id)
      LEFT JOIN relay_thread_vm_policies p USING(organization_id)
      WHERE s.host_id=${hostId} ORDER BY s.operation_id`;
    // Select IDs and phases only. Receipts, credentials, commands and conversation payloads stay in the DB.
    const pendingOperations = yield* sql<Operation>`WITH threads AS (${threadIds(hostId)}),
      allocations AS (${allocationIds(hostId)})
      SELECT 'placement' AS kind,t.operation_id AS "operationId",t.thread_id AS "threadId",'locked' AS phase
        FROM relay_thread_placements t WHERE t.thread_id IN (SELECT * FROM threads) AND t.operation_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id
            AND d.operation_id=t.operation_id AND d.generation=t.generation AND d.phase='completed')
      UNION ALL SELECT 'move',operation_id,thread_id,phase FROM relay_thread_moves
        WHERE thread_id IN (SELECT * FROM threads) AND phase NOT IN ('completed','aborted')
      UNION ALL SELECT 'provision',p.operation_id,a.thread_id,p.phase FROM relay_thread_vm_provisions p
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE p.allocation_id IN (SELECT * FROM allocations) AND (p.phase NOT IN ('created','cancelled') OR p.ingress_recovery_claim_id IS NOT NULL)
      UNION ALL SELECT 'setup',s.allocation_id,a.thread_id,s.phase FROM relay_thread_vm_setups s
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE s.allocation_id IN (SELECT * FROM allocations) AND s.phase<>'ready' AND a.state<>'deleted'
      UNION ALL SELECT 'pause',p.operation_id,a.thread_id,p.phase FROM relay_thread_vm_pauses p
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE p.allocation_id IN (SELECT * FROM allocations)
          AND (p.pause_dispatch_claim_id IS NOT NULL OR p.phase IN ('pending','sealed') OR
            (p.phase='cancelled' AND p.source_reopened_at IS NULL AND a.state<>'deleted'))
      UNION ALL SELECT 'resume',r.operation_id,a.thread_id,r.phase FROM relay_thread_vm_resumes r
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE r.allocation_id IN (SELECT * FROM allocations) AND (r.phase<>'completed' OR r.connect_claim_id IS NOT NULL)
      UNION ALL SELECT 'final-save',operation_id,thread_id,phase FROM relay_thread_vm_final_saves
        WHERE host_id=${hostId} AND phase NOT IN ('completed','aborted')
      UNION ALL SELECT 'backup-recovery',operation_id,thread_id,phase FROM relay_thread_vm_backup_recoveries
        WHERE host_id=${hostId} AND (phase NOT IN ('completed','cancelled') OR
          (retention_receipt IS NOT NULL AND retention_retired_at IS NULL))
      UNION ALL SELECT 'restore',operation_id,thread_id,phase FROM relay_thread_vm_restores
        WHERE host_id=${hostId} AND (phase NOT IN ('completed','aborted') OR boot_ingress_recovery_claim_id IS NOT NULL)
      UNION ALL SELECT 'replacement',request_id,thread_id,phase FROM relay_thread_vm_replacements
        WHERE host_id=${hostId} AND phase IN ('awaiting_choice','waiting')
      UNION ALL SELECT 'reset',operation_id,thread_id,phase FROM relay_thread_vm_resets
        WHERE host_id=${hostId} AND phase NOT IN ('completed','cancelled')
      UNION ALL SELECT 'deletion',operation_id,thread_id,phase FROM relay_thread_deletions
        WHERE host_id=${hostId} AND phase<>'completed'
      UNION ALL SELECT 'execution',work_id,thread_id,'incomplete' FROM relay_thread_execution_admissions
        WHERE thread_id IN (SELECT * FROM threads) AND NOT completed
      ORDER BY kind,"operationId","threadId"`;
    return {
      hostId,
      hostConfigured: host !== undefined,
      collectedAt: clock!.at,
      allocations,
      backups,
      savedDisks,
      pendingOperations,
    } satisfies ThreadVmMigrationCatalogue;
  });

  const report = (catalogue: ThreadVmMigrationCatalogue) => ({
    schemaVersion: 1,
    scope: "relay-catalogue-only",
    hostQuiescenceVerified: false,
    stockCompatibilityVerified: false,
    automaticCutoverSupported: false,
    legacyAllocationIds: catalogue.allocations
      .filter(
        (allocation) => allocation.state !== "deleted" && allocation.runtimeProtocol === "legacy",
      )
      .map((allocation) => allocation.allocationId),
    legacyBackupOperationIds: catalogue.backups
      .filter((backup) => backup.phase !== "retired" && !backup.hasNativeCaptureReceipt)
      .map((backup) => backup.operationId),
    hostDrainRequired: catalogue.allocations.some((allocation) => allocation.state !== "deleted"),
    ...catalogue,
    blockers: threadVmMigrationBlockers(catalogue),
  });

  const inventory = Effect.fn("relay.thread_vm.migration.inventory")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        return report(yield* readCatalogue(hostId));
      }),
    );
  });

  const protect = Effect.fn("relay.thread_vm.migration.protect")(function* (input: {
    readonly hostId: string;
    readonly pinId: string;
  }) {
    const pinId = yield* decodePinId(input.pinId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // A concurrent lifecycle operation either completes before these locks, or waits for all pins.
        yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id IN (${threadIds(input.hostId)}) ORDER BY thread_id FOR UPDATE`;
        const catalogue = yield* readCatalogue(input.hostId);
        if (threadVmMigrationBlockers(catalogue).length)
          return yield* new ThreadVmMigrationConflict({
            message:
              "Unresolved relay operations or unverified assets remain; run inventory and reconcile them using the existing runtime first.",
          });
        for (const backup of catalogue.backups) {
          if (backup.phase !== "verified") continue;
          // Preservation accepts historical roots without admitting them as a
          // native restore source. Normal backup consumers require native proof.
          const [stable] = yield* sql`SELECT operation_id FROM relay_thread_vm_backups
            WHERE operation_id=${backup.operationId} AND allocation_id=${backup.allocationId}
              AND phase='verified' AND snapshot_id=${backup.snapshotId}
              AND source_template_id=${backup.sourceTemplateId} AND source_build_id=${backup.sourceBuildId}
            FOR UPDATE`;
          if (!stable)
            return yield* new ThreadVmMigrationConflict({
              message: "A backup changed before its preservation pin was installed.",
            });
          yield* sql`INSERT INTO relay_thread_vm_backup_pins(backup_operation_id,operation_id)
            VALUES(${backup.operationId},${pinId}) ON CONFLICT DO NOTHING`;
        }
        return {
          ...report(yield* readCatalogue(input.hostId)),
          protectionPinId: pinId,
          protectionScope: "verified-backup-catalogue-roots",
        };
      }),
    );
  });

  const release = Effect.fn("relay.thread_vm.migration.release")(function* (input: {
    readonly hostId: string;
    readonly pinId: string;
  }) {
    const pinId = yield* decodePinId(input.pinId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id IN (${threadIds(input.hostId)}) ORDER BY thread_id FOR UPDATE`;
        const catalogue = yield* readCatalogue(input.hostId);
        for (const backup of catalogue.backups) {
          yield* sql`DELETE FROM relay_thread_vm_backup_pins
            WHERE backup_operation_id=${backup.operationId} AND operation_id=${pinId}`;
        }
        return { ...report(yield* readCatalogue(input.hostId)), releasedPinId: pinId };
      }),
    );
  });
  return { inventory, protect, release };
}
