import type { RelayThreadVmRestorePhase } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { E2BNativeSnapshotReceipt } from "../machines/E2BNativeSnapshotReceipt.ts";
import {
  NativeThreadVmRestoreCatalogReceipt,
  type NativeThreadVmRestoreBootReceipt,
} from "./NativeThreadVmRestoreReceipt.ts";
import type { ThreadVmWarmRestoreBootstrapReceipt } from "@t3tools/contracts/relay";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";
import type { RelayThreadVmIndependentHistory } from "@t3tools/contracts/relay";
import {
  makeThreadVmBackupRecoveryStore,
  type ThreadVmBackupRecoveryClaim,
} from "./ThreadVmBackupRecoveryStore.ts";

export class ThreadVmRestoreConflict extends Schema.TaggedError<ThreadVmRestoreConflict>()(
  "ThreadVmRestoreConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmRestoreConflict({ message });
const decodeProof = Schema.decodeUnknownEffect(E2BNativeSnapshotReceipt);
const decodeCatalog = Schema.decodeUnknownEffect(NativeThreadVmRestoreCatalogReceipt);
const decodeId = Schema.decodeEffect(Schema.String.check(Schema.isUUID()));

export interface ThreadVmRestore {
  readonly operationId: string;
  readonly savedDiskOperationId: string | null;
  readonly backupRecoveryOperationId: string | null;
  readonly independentHistory: RelayThreadVmIndependentHistory | null;
  readonly probeAttempt: number;
  readonly threadId: string;
  readonly allocationId: string;
  readonly actorUserId: string;
  readonly generation: number;
  readonly sourceGeneration: number | null;
  readonly targetGeneration: number | null;
  readonly bootCreateStarted: boolean;
  readonly enrollmentIssued: boolean;
  readonly bootIngressRecoveryClaimId: string | null;
  readonly bootstrapReceipt: ThreadVmWarmRestoreBootstrapReceipt | null;
  readonly hostId: string;
  readonly nativeCheckpointOperationId: string;
  readonly sourceTemplateId: string;
  readonly sourceBuildId: string;
  readonly phase: RelayThreadVmRestorePhase;
  readonly servingRequested: boolean;
  readonly probeRemoved: boolean;
  readonly bootPrepareStarted: boolean;
  readonly bootReceipt: NativeThreadVmRestoreBootReceipt | null;
  readonly bootAttempt: number;
  readonly bootRecoveryStarted: boolean;
  readonly servingCommitted: boolean;
  readonly prepareStarted: boolean;
  readonly preparedReceipt: NativeThreadVmRestoreCatalogReceipt | null;
  readonly claimId: string | null;
  readonly errorCode: string | null;
}
export type ThreadVmRestoreClaim = Pick<ThreadVmRestore, "operationId"> & {
  readonly claimId: string;
};

/** Pins native snapshot completion and independent history. Worker claims grant no execution ownership. */
export function makeThreadVmRestoreStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const saved = makeThreadVmSavedDiskStore(sql),
    natives = makeThreadNativeCheckpointStore(sql, objects),
    allocations = makeThreadVmAllocationStore(sql),
    capacity = makeThreadVmCapacityStore(sql);
  const get = Effect.fn("relay.thread_vm.restore.get")(function* (operationId: string) {
    const [row] = yield* sql<ThreadVmRestore>`SELECT operation_id AS "operationId",
      saved_disk_operation_id AS "savedDiskOperationId",thread_id AS "threadId",
      backup_recovery_operation_id AS "backupRecoveryOperationId",probe_attempt AS "probeAttempt",
      (SELECT independent_history FROM relay_thread_vm_backup_recoveries r WHERE r.operation_id=backup_recovery_operation_id) AS "independentHistory",
      allocation_id AS "allocationId",actor_user_id AS "actorUserId",generation,
      source_generation AS "sourceGeneration",target_generation AS "targetGeneration",
      boot_create_started_at IS NOT NULL AS "bootCreateStarted",boot_ingress_recovery_claim_id AS "bootIngressRecoveryClaimId",
      bootstrap_receipt AS "bootstrapReceipt",
      (EXISTS(SELECT 1 FROM relay_thread_vm_enrollments e WHERE e.allocation_id=relay_thread_vm_restores.allocation_id AND e.environment_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM relay_thread_vm_bindings binding WHERE binding.allocation_id=relay_thread_vm_restores.allocation_id)) AS "enrollmentIssued",
      host_id AS "hostId",native_checkpoint_operation_id AS "nativeCheckpointOperationId",
      source_template_id AS "sourceTemplateId",source_build_id AS "sourceBuildId",phase,
      prepare_started_at IS NOT NULL AS "prepareStarted",prepared_receipt AS "preparedReceipt",
      serving_requested AS "servingRequested",probe_removed_at IS NOT NULL AS "probeRemoved",
      boot_prepare_started_at IS NOT NULL AS "bootPrepareStarted",boot_receipt AS "bootReceipt",
      boot_attempt AS "bootAttempt",boot_recovery_started_at IS NOT NULL AS "bootRecoveryStarted",committed_at IS NOT NULL AS "servingCommitted",
      claim_id AS "claimId",error_code AS "errorCode" FROM relay_thread_vm_restores
      WHERE operation_id=${operationId}`;
    return row ?? null;
  });
  const lock = Effect.fnUntraced(function* (operationId: string) {
    const prior = yield* get(operationId);
    if (!prior) return yield* conflict("VM restore does not exist.");
    const [placement] = yield* sql<{ operationId: string | null; generation: number }>`
      SELECT operation_id AS "operationId",generation FROM relay_thread_placements
      WHERE thread_id=${prior.threadId} FOR UPDATE`;
    yield* sql`SELECT operation_id FROM relay_thread_vm_restores
      WHERE operation_id=${operationId} FOR UPDATE`;
    const row = (yield* get(operationId))!;
    if (row.phase === "aborted" || row.phase === "completed") return row;
    const committed = row.servingCommitted;
    const [current] = row.backupRecoveryOperationId
      ? yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries r JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE r.operation_id=${operationId} AND r.thread_id=${row.threadId} AND r.phase='restoring'
          AND r.stop_receipt IS NOT NULL AND r.independent_history IS NOT NULL
          AND a.allocation_id=${row.allocationId} AND a.owner_user_id=${row.actorUserId} AND a.deleted_at IS NULL AND a.runtime_protocol='native-v1'
        FOR UPDATE OF r,a`
      : yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s JOIN relay_thread_vm_allocations a ON a.allocation_id=s.restore_allocation_id
        WHERE s.operation_id=${row.savedDiskOperationId} AND s.thread_id=${row.threadId} AND s.phase='restoring'
          AND s.restore_operation_id=${operationId} AND s.restore_allocation_id=${row.allocationId}
          AND a.owner_user_id=${row.actorUserId} AND a.deleted_at IS NULL AND a.runtime_protocol='native-v1' FOR UPDATE OF s,a`;
    if (
      !current ||
      placement?.operationId !== operationId ||
      placement.generation !== (committed ? row.targetGeneration : row.generation)
    )
      return yield* conflict("Restore no longer owns this allocation and placement generation.");
    return row;
  });
  const requireRecovery = Effect.fnUntraced(function* (row: ThreadVmRestore) {
    const point = yield* natives.getForOperation({
      threadId: row.threadId,
      operationId: row.operationId,
    });
    const [backup] = yield* sql<{
      receipt: unknown;
      backupOperationId: string;
      sourceAllocationId: string;
      sourceGeneration: number;
    }>`
      SELECT b.native_capture_receipt AS receipt,b.operation_id AS "backupOperationId",
        b.allocation_id AS "sourceAllocationId",b.generation AS "sourceGeneration"
      FROM relay_thread_vm_backups b JOIN relay_thread_vm_backup_pins pin ON pin.backup_operation_id=b.operation_id
      WHERE pin.operation_id=${row.operationId} AND b.operation_id=COALESCE(
        (SELECT backup_operation_id FROM relay_thread_vm_saved_disks WHERE operation_id=${row.savedDiskOperationId}),
        (SELECT backup_operation_id FROM relay_thread_vm_backup_recoveries WHERE operation_id=${row.backupRecoveryOperationId}))
        AND b.phase='verified' AND b.native_capture_receipt IS NOT NULL
        AND b.source_template_id=${row.sourceTemplateId} AND b.source_build_id=${row.sourceBuildId}`;
    if (!backup || !point || point.operationId !== row.nativeCheckpointOperationId)
      return yield* conflict(
        "The independently retained snapshot and conversation are incomplete.",
      );
    const receipt = yield* decodeProof(backup.receipt).pipe(
      Effect.mapError(() => conflict("Native snapshot completion is invalid.")),
    );
    if (
      receipt.operationId !== backup.backupOperationId ||
      receipt.threadId !== row.threadId ||
      receipt.allocationId !== backup.sourceAllocationId ||
      receipt.generation !== backup.sourceGeneration ||
      receipt.generation !== row.sourceGeneration ||
      receipt.sourceTemplateId !== row.sourceTemplateId ||
      receipt.sourceBuildId !== row.sourceBuildId
    )
      return yield* conflict("Native snapshot completion belongs to a different source.");
    yield* natives.pinCompleteForOperation({
      threadId: row.threadId,
      operationId: row.operationId,
      checkpointOperationId: point.operationId,
      expected: point,
    });
    if (row.backupRecoveryOperationId) {
      const [source] = yield* sql<{
        environmentId: string;
        nativeRelayCursor: number;
        throughRelayCursor: number;
        throughCommandPosition: number;
      }>`
        SELECT environment_id AS "environmentId",native_relay_cursor AS "nativeRelayCursor",through_relay_cursor AS "throughRelayCursor",through_command_position AS "throughCommandPosition"
        FROM relay_thread_vm_backup_recoveries WHERE operation_id=${row.backupRecoveryOperationId} AND phase='restoring' AND stop_receipt IS NOT NULL`;
      if (!source || !row.independentHistory)
        return yield* conflict("Independent recovery history is unavailable.");
      yield* makeThreadVmRecoveryHistory(sql, objects)
        .verify({
          ...row,
          ...source,
          sourceEnvironmentId: source.environmentId,
          independentHistory: row.independentHistory,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? error
              : conflict("Independent recovery history is unconfirmed."),
          ),
        );
    } else if (
      point.generation !== receipt.generation ||
      point.sourceEnvironmentId !== receipt.source.environmentId ||
      point.captureOperationId !== receipt.source.captureOperationId ||
      point.operationId !== receipt.source.nativeCheckpointOperationId ||
      point.sourceSequence !== receipt.source.sourceSequence
    )
      return yield* conflict(
        "Saved snapshot and independently published source checkpoint differ.",
      );
    return receipt;
  });
  const begin = Effect.fn("relay.thread_vm.restore.begin")(function* (
    input: Parameters<typeof saved.beginRestore>[0] & { readonly serving?: boolean },
  ) {
    yield* decodeId(input.operationId);
    yield* decodeId(input.allocationId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Reserve serializes the user's quota before taking placement; preserve its lock order.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const prior = yield* get(input.operationId);
        if (prior) {
          if (
            prior.threadId !== input.threadId ||
            prior.savedDiskOperationId !== input.savedDiskOperationId ||
            prior.actorUserId !== input.actorUserId ||
            prior.allocationId !== input.allocationId ||
            prior.generation !== input.expectedGeneration ||
            prior.servingRequested !== (input.serving ?? false) ||
            prior.phase === "aborted"
          )
            return yield* conflict("Restore identity was reused with different or ended intent.");
          const row = yield* lock(input.operationId);
          if (row.phase !== "completed") yield* requireRecovery(row);
          return row;
        }
        const disk = yield* saved.beginRestore(input);
        const [source] = yield* sql<{
          nativeCheckpointOperationId: string;
          sourceTemplateId: string;
          sourceBuildId: string;
          sourceEnvironmentId: string;
          sourceSequence: number;
          captureOperationId: string | null;
          sourceGeneration: number;
        }>`
        SELECT f.generation AS "sourceGeneration",f.native_checkpoint_operation_id AS "nativeCheckpointOperationId",
          b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",
          f.environment_id AS "sourceEnvironmentId",f.source_sequence AS "sourceSequence",
          CASE WHEN f.original_state='paused' THEN pause.operation_id ELSE f.operation_id END AS "captureOperationId"
        FROM relay_thread_vm_final_saves f JOIN relay_thread_vm_backups b ON b.operation_id=f.backup_operation_id
        LEFT JOIN relay_thread_vm_pauses pause ON f.original_state='paused' AND pause.allocation_id=f.allocation_id
          AND pause.generation=f.generation AND pause.phase='completed' AND pause.boot_id IS NOT NULL
          AND pause.native_checkpoint_operation_id=f.native_checkpoint_operation_id AND pause.source_sequence=f.source_sequence
          AND pause.source_frozen_at IS NOT NULL AND pause.source_reopened_at IS NULL
        WHERE f.operation_id=${disk.operationId} AND f.thread_id=${input.threadId}
          AND f.phase='completed'
          AND b.operation_id=${disk.backupOperationId} AND b.phase='verified'
          AND b.source_template_id IS NOT NULL AND b.source_build_id IS NOT NULL`;
        const point = source ? yield* natives.get(source.nativeCheckpointOperationId) : null;
        if (
          !source ||
          !point ||
          !source.captureOperationId ||
          point.captureOperationId !== source.captureOperationId ||
          point.threadId !== input.threadId ||
          point.generation !== source.sourceGeneration ||
          point.sourceEnvironmentId !== source.sourceEnvironmentId ||
          point.sourceSequence !== source.sourceSequence
        )
          return yield* conflict(
            "Restore requires the exact independently saved conversation and disk.",
          );
        yield* decodeId(source.sourceBuildId).pipe(
          Effect.mapError(() => conflict("Saved disk build identity is invalid.")),
        );
        yield* natives.pinCompleteForOperation({
          threadId: input.threadId,
          operationId: input.operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        yield* sql`INSERT INTO relay_thread_vm_restores
        (operation_id,saved_disk_operation_id,thread_id,allocation_id,actor_user_id,generation,source_generation,host_id,
          native_checkpoint_operation_id,source_template_id,source_build_id,phase,serving_requested)
        VALUES (${input.operationId},${disk.operationId},${input.threadId},${input.allocationId},
          ${input.actorUserId},${input.expectedGeneration},${source.sourceGeneration},${disk.hostId},${point.operationId},
          ${source.sourceTemplateId},${source.sourceBuildId},'pending',${input.serving ?? false})`;
        const row = (yield* get(input.operationId))!;
        yield* requireRecovery(row);
        return row;
      }),
    );
  });
  const beginBackupRecovery = Effect.fn("relay.thread_vm.restore.begin_backup_recovery")(function* (
    claim: ThreadVmBackupRecoveryClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.actorUserId},721864))`;
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${claim.allocationId},721865))`;
        const source = yield* makeThreadVmBackupRecoveryStore(sql, objects).authorize(claim);
        if (source.phase !== "stopped" || !source.stopReceipt || !source.independentHistory)
          return yield* conflict(
            "Recovery requires independent state and the exact native source deletion acknowledgement.",
          );
        yield* makeThreadVmRecoveryHistory(sql, objects)
          .verify({
            ...source,
            sourceEnvironmentId: source.environmentId,
            independentHistory: source.independentHistory,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SqlError"
                ? error
                : conflict("Independent recovery history is unconfirmed."),
            ),
          );
        const [current] = yield* sql<{
          organizationId: string;
          templateId: string;
        }>`SELECT a.organization_id AS "organizationId",a.template_id AS "templateId"
        FROM relay_thread_vm_allocations a JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
        WHERE a.allocation_id=${source.sourceAllocationId} AND a.thread_id=${source.threadId} AND a.owner_user_id=${source.actorUserId}
          AND a.compute_ref=${source.computeRef} AND a.state IN ('running','paused') AND a.deleted_at IS NULL
          AND t.operation_id=${source.operationId} AND t.generation=${source.generation} AND t.environment_id=${source.environmentId}
          AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.revoked_at IS NULL
          AND p.operation_id=${source.sourceOperationId} AND p.generation=t.generation AND p.phase='created' FOR UPDATE OF a,b,p`;
        if (!current)
          return yield* conflict("Damaged source ownership changed before replacement admission.");
        // Only the persisted exact stop permits releasing the old quota/capacity.
        yield* sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE allocation_id=${source.sourceAllocationId}`;
        yield* sql`UPDATE relay_thread_vm_allocations SET state='deleted',sealed_traffic_access_token=NULL,deleted_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE allocation_id=${source.sourceAllocationId}`;
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE credential_id IN(SELECT credential_id FROM relay_thread_vm_bindings WHERE allocation_id=${source.sourceAllocationId})`;
        yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE allocation_id=${source.sourceAllocationId}`;
        yield* allocations.reserve({
          allocationId: source.allocationId,
          threadId: source.threadId,
          organizationId: current.organizationId,
          ownerUserId: source.actorUserId,
          templateId: current.templateId,
          backupRecoveryOperationId: source.operationId,
        });
        yield* capacity.request({
          operationId: source.operationId,
          allocationId: source.allocationId,
          hostId: source.hostId,
          kind: "create",
        });
        yield* sql`INSERT INTO relay_thread_vm_restores(operation_id,backup_recovery_operation_id,thread_id,allocation_id,actor_user_id,generation,host_id,native_checkpoint_operation_id,source_template_id,source_build_id,source_generation,phase,serving_requested)
        VALUES(${source.operationId},${source.operationId},${source.threadId},${source.allocationId},${source.actorUserId},${source.generation},${source.hostId},${source.nativeCheckpointOperationId},${source.sourceTemplateId},${source.sourceBuildId},${(yield* makeThreadVmBackupRecoveryStore(sql, objects).selectedReceipt(source)).generation},'pending',true)`;
        yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='restoring',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${source.operationId}`;
        const row = (yield* get(source.operationId))!;
        yield* requireRecovery(row);
        return row;
      }),
    );
  });
  const requireSourceAbsent = Effect.fnUntraced(function* (row: ThreadVmRestore) {
    const [absent] = row.backupRecoveryOperationId
      ? yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries r
      JOIN relay_thread_vm_allocations a ON a.allocation_id=r.source_allocation_id
      WHERE r.operation_id=${row.backupRecoveryOperationId} AND r.phase='restoring' AND r.stop_receipt->>'kind'='native-recovery-source-deleted-v1'
        AND a.state='deleted' AND a.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials c USING(credential_id) WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR c.revoked_at IS NULL))`
      : yield* sql`SELECT 1 FROM relay_thread_vm_final_saves f JOIN relay_thread_vm_allocations a ON a.allocation_id=f.allocation_id
        WHERE f.operation_id=${row.savedDiskOperationId} AND f.phase='completed' AND a.state='deleted' AND a.deleted_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
            WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR c.revoked_at IS NULL))`;
    if (!absent)
      return yield* conflict(
        "The recovery source has no native deletion acknowledgement and revoked identity.",
      );
  });
  const claim = Effect.fn("relay.thread_vm.restore.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId"
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id=r.operation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE r.host_id=${hostId} AND r.phase IN ('pending','preparing','prepared','aborting') AND r.committed_at IS NULL
          AND a.runtime_protocol='native-v1'
          AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp())
          AND (r.phase='aborting' OR c.state='reserved')
          AND (r.phase!='prepared' OR NOT r.serving_requested)
        ORDER BY r.created_at,r.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const row = yield* lock(candidate.operationId);
        const id = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_restores SET claim_id=${id},claim_until=clock_timestamp()+interval '3 minutes'
        WHERE operation_id=${row.operationId}`;
        return { ...row, claimId: id };
      }),
    );
  });
  const requireClaim = Effect.fnUntraced(function* (input: ThreadVmRestoreClaim) {
    const row = yield* lock(input.operationId);
    const [valid] = yield* sql`SELECT 1 FROM relay_thread_vm_restores
      WHERE operation_id=${input.operationId} AND claim_id=${input.claimId} AND claim_until>clock_timestamp()`;
    if (!valid) return yield* conflict("Restore worker claim expired or changed.");
    return row;
  });
  const beginPrepare = Effect.fn("relay.thread_vm.restore.begin_prepare")(function* (
    input: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireClaim(input);
        if (
          !["pending", "preparing", "prepared"].includes(row.phase) ||
          row.servingCommitted ||
          (yield* capacity.get(row.operationId))?.state !== "reserved"
        )
          return yield* conflict("Restore catalog validation requires reserved capacity.");
        yield* requireRecovery(row);
        yield* sql`UPDATE relay_thread_vm_restores SET phase='preparing',prepare_started_at=COALESCE(prepare_started_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const recordPrepared = Effect.fn("relay.thread_vm.restore.record_prepared")(function* (
    input: ThreadVmRestoreClaim,
    receipt: NativeThreadVmRestoreCatalogReceipt,
  ) {
    const decoded = yield* decodeCatalog(receipt).pipe(
      Effect.mapError(() => conflict("Native snapshot catalog receipt is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireClaim(input);
        yield* requireRecovery(row);
        if (
          !["preparing", "prepared"].includes(row.phase) ||
          decoded.sourceTemplateId !== row.sourceTemplateId ||
          decoded.sourceBuildId !== row.sourceBuildId
        )
          return yield* conflict(
            "Native catalog does not identify the selected immutable snapshot.",
          );
        yield* sql`UPDATE relay_thread_vm_restores SET phase='prepared',prepared_receipt=${sql.json(decoded)},claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const requestAbort = Effect.fn("relay.thread_vm.restore.request_abort")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* lock(operationId);
        if (["aborted", "aborting"].includes(row.phase)) return row;
        if (["importing", "completed"].includes(row.phase))
          return yield* conflict("An enrolled restore must finish its chosen destination.");
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
        const issued =
          yield* sql`SELECT 1 FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId} AND environment_id IS NOT NULL
          UNION ALL SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId}`;
        if (issued.length)
          return yield* conflict("An issued restore identity must finish its chosen destination.");
        if (row.backupRecoveryOperationId)
          return yield* conflict(
            "The stopped recovery source cannot be reactivated; retry this destination.",
          );
        yield* sql`UPDATE relay_thread_vm_restores SET phase='aborting',claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const completeAbort = Effect.fn("relay.thread_vm.restore.complete_abort")(function* (
    input: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireClaim(input);
        if (
          row.phase !== "aborting" ||
          row.servingCommitted ||
          row.bootCreateStarted ||
          row.bootReceipt ||
          row.bootIngressRecoveryClaimId
        )
          return yield* conflict("An unstarted cancellation cannot release a native boot attempt.");
        if (!row.savedDiskOperationId)
          return yield* conflict("The stopped recovery source remains pinned.");
        yield* allocations.requestDeletion(row.allocationId);
        yield* capacity.cancelUnstarted(row.operationId);
        yield* allocations.confirmDeleted({ allocationId: row.allocationId, computeRef: null });
        yield* saved.cancelRestore({
          threadId: row.threadId,
          savedDiskOperationId: row.savedDiskOperationId,
          operationId: row.operationId,
        });
        yield* natives.releaseOperation({ threadId: row.threadId, operationId: row.operationId });
        yield* sql`UPDATE relay_thread_vm_restores SET phase='aborted',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.restore.defer")(function* (
    input: ThreadVmRestoreClaim,
    errorCode: string,
  ) {
    yield* sql`UPDATE relay_thread_vm_restores SET claim_id=NULL,claim_until=NULL,
      retry_at=clock_timestamp()+interval '1 minute',error_code=${errorCode}
      WHERE operation_id=${input.operationId} AND claim_id=${input.claimId}
        AND claim_until>clock_timestamp() AND phase NOT IN ('aborted','completed')`;
  });
  return {
    get,
    begin,
    beginBackupRecovery,
    requireSourceAbsent,
    claim,
    beginPrepare,
    recordPrepared,
    requestAbort,
    completeAbort,
    defer,
    // Shared by the serving coordinator; each mutation remains in its caller's transaction.
    lock,
    requireClaim,
    requireRecovery,
  };
}
