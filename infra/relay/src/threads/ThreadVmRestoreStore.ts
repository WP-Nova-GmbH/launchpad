import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { RelayThreadVmRestorePhase } from "@t3tools/contracts/relay";
import { sha256 } from "@noble/hashes/sha2";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { E2BBackupColdProof, E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
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
const decodeProof = Schema.decodeUnknownEffect(E2BBackupColdProof);
const decodeStatus = Schema.decodeUnknownEffect(E2BRestoreStatus);
const decodeId = Schema.decodeEffect(Schema.String.check(Schema.isUUID()));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(E2BRestoreStatus));
export const restoreBootGeneration = (generation: number) => String(generation + 1);
export const restoreComputeGeneration = (operationId: string) => `restore-${operationId}`;
/** The offline probe has no bootstrap and cannot later become a boot operation.
 * Keep its immutable request distinct from the durable product restore intent. */
export function restoreProbeOperationId(operationId: string, attempt = 0) {
  const bytes = sha256(
    new TextEncoder().encode(
      `launchpad-thread-vm-restore-probe-v1:${operationId.toLowerCase()}${attempt > 0 ? `:attempt:${attempt}` : ""}`,
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
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
  readonly hostId: string;
  readonly nativeCheckpointOperationId: string;
  readonly sourceTemplateId: string;
  readonly sourceBuildId: string;
  readonly phase: RelayThreadVmRestorePhase;
  readonly servingRequested: boolean;
  readonly probeRemoved: boolean;
  readonly bootPrepareStarted: boolean;
  readonly bootReceipt: E2BRestoreStatus | null;
  readonly bootAttempt: number;
  readonly bootRecoveryStarted: boolean;
  readonly servingCommitted: boolean;
  readonly prepareStarted: boolean;
  readonly preparedReceipt: E2BRestoreStatus | null;
  readonly claimId: string | null;
  readonly errorCode: string | null;
}
export type ThreadVmRestoreClaim = Pick<ThreadVmRestore, "operationId"> & {
  readonly claimId: string;
};

/** Internal offline preparation. Authorization surrounds begin/cancel; neither
 * a worker lease nor an E2B cold-probe receipt grants execution ownership. */
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
    const committed = ["committed", "booted", "importing"].includes(row.phase);
    const booted = row.phase === "booted" || row.phase === "importing";
    const [current] = row.backupRecoveryOperationId
      ? yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries r
      JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
      WHERE r.operation_id=${row.backupRecoveryOperationId} AND r.operation_id=${operationId}
        AND r.thread_id=${row.threadId} AND r.generation=${row.generation} AND r.phase='restoring'
        AND r.stop_receipt IS NOT NULL AND r.retention_receipt IS NOT NULL AND r.independent_history IS NOT NULL
        AND r.allocation_id=${row.allocationId} AND a.thread_id=r.thread_id AND a.owner_user_id=${row.actorUserId}
        AND a.state=${booted ? "running" : "creating"} AND a.deleted_at IS NULL
        AND ((NOT ${booted} AND a.compute_ref IS NULL) OR (${booted} AND a.compute_ref=${row.bootReceipt?.sandboxID ?? ""}))
      FOR UPDATE OF r,a`
      : yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s
      JOIN relay_thread_vm_allocations a ON a.allocation_id=s.restore_allocation_id
      WHERE s.operation_id=${row.savedDiskOperationId} AND s.thread_id=${row.threadId}
        AND s.generation=${row.generation} AND s.phase='restoring'
        AND s.restore_operation_id=${operationId} AND s.restore_allocation_id=${row.allocationId}
        AND a.thread_id=s.thread_id AND a.owner_user_id=${row.actorUserId}
        AND a.state=${booted ? "running" : "creating"}
        AND ((NOT ${booted} AND a.compute_ref IS NULL) OR (${booted} AND a.compute_ref=${row.bootReceipt?.sandboxID ?? ""}))
        AND a.deleted_at IS NULL
      FOR UPDATE OF s,a`;
    if (
      !current ||
      placement?.operationId !== operationId ||
      placement.generation !== row.generation + (committed ? 1 : 0)
    )
      return yield* conflict("Restore no longer owns this quarantined allocation.");
    return row;
  });
  const requireRecovery = Effect.fnUntraced(function* (row: ThreadVmRestore) {
    const point = yield* natives.getForOperation({
      threadId: row.threadId,
      operationId: row.operationId,
    });
    if (row.backupRecoveryOperationId) {
      const [source] = yield* sql<{
        proof: unknown;
        backupOperationId: string;
        environmentId: string;
        nativeRelayCursor: number;
        throughRelayCursor: number;
        throughCommandPosition: number;
      }>`
        SELECT b.probe_receipt AS proof,b.operation_id AS "backupOperationId",r.environment_id AS "environmentId",
          r.native_relay_cursor AS "nativeRelayCursor",r.through_relay_cursor AS "throughRelayCursor",r.through_command_position AS "throughCommandPosition"
        FROM relay_thread_vm_backup_recoveries r JOIN relay_thread_vm_backups b ON b.operation_id=r.backup_operation_id
        JOIN relay_thread_vm_backup_pins p ON p.backup_operation_id=b.operation_id
        JOIN relay_thread_vm_allocations old ON old.allocation_id=r.source_allocation_id
        WHERE r.operation_id=${row.backupRecoveryOperationId} AND r.operation_id=${row.operationId}
          AND r.thread_id=${row.threadId} AND r.generation=${row.generation} AND r.phase='restoring'
          AND r.native_checkpoint_operation_id=${row.nativeCheckpointOperationId}
          AND r.retention_receipt IS NOT NULL AND r.stop_receipt IS NOT NULL AND old.state='deleted' AND old.deleted_at IS NOT NULL
          AND b.phase='verified' AND b.source_template_id=${row.sourceTemplateId} AND b.source_build_id=${row.sourceBuildId}
          AND b.capture_started_at=r.captured_at AND p.operation_id=r.operation_id
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings binding JOIN relay_environment_credentials k USING(credential_id)
            WHERE binding.allocation_id=old.allocation_id AND (binding.revoked_at IS NULL OR k.revoked_at IS NULL))`;
      if (
        !source ||
        !point ||
        point.operationId !== row.nativeCheckpointOperationId ||
        !row.independentHistory
      )
        return yield* conflict(
          "The stopped backup recovery source or independent conversation changed.",
        );
      yield* natives.pinCompleteForOperation({
        threadId: row.threadId,
        operationId: row.operationId,
        checkpointOperationId: point.operationId,
        expected: point,
      });
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
      const proof = yield* decodeProof(source.proof).pipe(
        Effect.mapError(() => conflict("Backup cold proof is invalid.")),
      );
      if (
        proof.operationID !== source.backupOperationId ||
        proof.generation !== `backup-${source.backupOperationId}`
      )
        return yield* conflict("Backup cold proof belongs to another capture.");
      return proof;
    }
    // Paused final saves retain the exact certified pause capture without waking the source.
    const [backup] = yield* sql<{
      operationId: string;
      proof: unknown;
      captureOperationId: string | null;
    }>`SELECT b.operation_id AS "operationId",b.probe_receipt AS proof,
      CASE WHEN f.original_state='paused' THEN pause.operation_id ELSE f.operation_id END AS "captureOperationId"
      FROM relay_thread_vm_backups b
      JOIN relay_thread_vm_saved_disks s ON s.backup_operation_id=b.operation_id
      JOIN relay_thread_vm_backup_pins p ON p.backup_operation_id=b.operation_id
      JOIN relay_thread_vm_final_saves f ON f.operation_id=s.operation_id
      LEFT JOIN relay_thread_vm_pauses pause ON f.original_state='paused' AND pause.allocation_id=f.allocation_id
        AND pause.generation=f.generation AND pause.phase='completed' AND pause.boot_id IS NOT NULL
        AND pause.native_checkpoint_operation_id=f.native_checkpoint_operation_id AND pause.source_sequence=f.source_sequence
        AND pause.source_frozen_at IS NOT NULL AND pause.source_reopened_at IS NULL
      WHERE s.operation_id=${row.savedDiskOperationId} AND s.phase='restoring'
        AND s.thread_id=${row.threadId} AND s.generation=${row.generation} AND f.thread_id=s.thread_id
        AND f.phase='completed' AND f.native_checkpoint_operation_id=${row.nativeCheckpointOperationId}
        AND f.source_sequence=${point?.sourceSequence ?? -1} AND f.generation=${row.generation}
        AND f.environment_id=${point?.sourceEnvironmentId ?? ""}
        AND b.phase='verified' AND b.source_template_id=${row.sourceTemplateId}
        AND b.source_build_id=${row.sourceBuildId} AND p.operation_id=${row.operationId}`;
    if (
      !backup ||
      !point ||
      point.operationId !== row.nativeCheckpointOperationId ||
      point.generation !== row.generation ||
      !backup.captureOperationId ||
      point.captureOperationId !== backup.captureOperationId
    )
      return yield* conflict("Restore recovery points changed or are incomplete.");
    // Idempotent pinning also checks the complete immutable native/chat pin set.
    yield* natives.pinCompleteForOperation({
      threadId: row.threadId,
      operationId: row.operationId,
      checkpointOperationId: point.operationId,
      expected: point,
    });
    const proof = yield* decodeProof(backup.proof).pipe(
      Effect.mapError(() => conflict("Saved disk has an invalid cold proof.")),
    );
    if (
      proof.operationID !== backup.operationId ||
      proof.generation !== `backup-${backup.operationId}`
    )
      return yield* conflict("Saved disk cold proof belongs to another capture.");
    return proof;
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
        }>`
        SELECT f.native_checkpoint_operation_id AS "nativeCheckpointOperationId",
          b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",
          f.environment_id AS "sourceEnvironmentId",f.source_sequence AS "sourceSequence",
          CASE WHEN f.original_state='paused' THEN pause.operation_id ELSE f.operation_id END AS "captureOperationId"
        FROM relay_thread_vm_final_saves f JOIN relay_thread_vm_backups b ON b.operation_id=f.backup_operation_id
        LEFT JOIN relay_thread_vm_pauses pause ON f.original_state='paused' AND pause.allocation_id=f.allocation_id
          AND pause.generation=f.generation AND pause.phase='completed' AND pause.boot_id IS NOT NULL
          AND pause.native_checkpoint_operation_id=f.native_checkpoint_operation_id AND pause.source_sequence=f.source_sequence
          AND pause.source_frozen_at IS NOT NULL AND pause.source_reopened_at IS NULL
        WHERE f.operation_id=${disk.operationId} AND f.thread_id=${input.threadId}
          AND f.generation=${input.expectedGeneration} AND f.phase='completed'
          AND b.operation_id=${disk.backupOperationId} AND b.phase='verified'
          AND b.source_template_id IS NOT NULL AND b.source_build_id IS NOT NULL`;
        const point = source ? yield* natives.get(source.nativeCheckpointOperationId) : null;
        if (
          !source ||
          !point ||
          !source.captureOperationId ||
          point.captureOperationId !== source.captureOperationId ||
          point.threadId !== input.threadId ||
          point.generation !== input.expectedGeneration ||
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
        (operation_id,saved_disk_operation_id,thread_id,allocation_id,actor_user_id,generation,host_id,
          native_checkpoint_operation_id,source_template_id,source_build_id,phase,serving_requested)
        VALUES (${input.operationId},${disk.operationId},${input.threadId},${input.allocationId},
          ${input.actorUserId},${input.expectedGeneration},${disk.hostId},${point.operationId},
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
        if (
          source.phase !== "stopped" ||
          !source.retentionReceipt ||
          !source.stopReceipt ||
          !source.independentHistory
        )
          return yield* conflict(
            "Recovery requires retained independent state and the exact physical source stop.",
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
        yield* sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE allocation_id=${source.sourceAllocationId}`;
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
        yield* sql`INSERT INTO relay_thread_vm_restores(operation_id,backup_recovery_operation_id,thread_id,allocation_id,actor_user_id,generation,host_id,native_checkpoint_operation_id,source_template_id,source_build_id,phase,serving_requested)
        VALUES(${source.operationId},${source.operationId},${source.threadId},${source.allocationId},${source.actorUserId},${source.generation},${source.hostId},${source.nativeCheckpointOperationId},${source.sourceTemplateId},${source.sourceBuildId},'pending',true)`;
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
      WHERE r.operation_id=${row.backupRecoveryOperationId} AND r.phase='restoring' AND r.stop_receipt IS NOT NULL AND r.retention_receipt IS NOT NULL
        AND a.state='deleted' AND a.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials c USING(credential_id) WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR c.revoked_at IS NULL))`
      : yield* sql`SELECT 1 FROM relay_thread_vm_final_saves f JOIN relay_thread_vm_allocations a ON a.allocation_id=f.allocation_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        WHERE f.operation_id=${row.savedDiskOperationId} AND f.phase='completed' AND a.state='deleted' AND a.deleted_at IS NOT NULL AND b.revoked_at IS NOT NULL AND c.revoked_at IS NOT NULL`;
    if (!absent)
      return yield* conflict("The recovery source is not physically stopped and revoked.");
  });
  const claim = Effect.fn("relay.thread_vm.restore.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId"
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id=r.operation_id
        WHERE r.host_id=${hostId} AND r.phase IN ('pending','preparing','prepared','aborting')
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
        const reservation = yield* capacity.get(row.operationId);
        if (!["pending", "preparing"].includes(row.phase) || reservation?.state !== "reserved")
          return yield* conflict("Restore cannot prepare before capacity or after cancellation.");
        yield* requireRecovery(row);
        yield* sql`UPDATE relay_thread_vm_restores SET phase='preparing',
        prepare_started_at=COALESCE(prepare_started_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const recordPrepared = Effect.fn("relay.thread_vm.restore.record_prepared")(function* (
    input: ThreadVmRestoreClaim,
    receipt: E2BRestoreStatus,
  ) {
    const decoded = yield* decodeStatus(receipt).pipe(
      Effect.mapError(() => conflict("Restore receipt is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireClaim(input);
        yield* requireRecovery(row);
        if (
          !["preparing", "prepared"].includes(row.phase) ||
          decoded.operationID !== restoreProbeOperationId(row.operationId, row.probeAttempt) ||
          decoded.generation !== restoreComputeGeneration(row.operationId) ||
          decoded.state !== "prepared" ||
          !decoded.coldProbe ||
          decoded.coldProbe.preparedBuildID !== decoded.preparedBuildID ||
          !decoded.manifestSHA256 ||
          !/^[0-9a-f]{64}$/u.test(decoded.manifestSHA256)
        )
          return yield* conflict(
            "Restore receipt does not prove this saved disk is cold and stopped.",
          );
        // Journal replay can change bytes in a fresh private copy before it is hashed.
        // Freeze this preparation's hash on reinspection, not another verifier's output.
        if (
          row.preparedReceipt &&
          (decoded.sandboxID !== row.preparedReceipt.sandboxID ||
            decoded.executionID !== row.preparedReceipt.executionID ||
            decoded.preparedBuildID !== row.preparedReceipt.preparedBuildID ||
            decoded.manifestSHA256 !== row.preparedReceipt.manifestSHA256 ||
            decoded.coldProbe.rootfsSHA256 !== row.preparedReceipt.coldProbe?.rootfsSHA256 ||
            decoded.coldProbe.initSHA256 !== row.preparedReceipt.coldProbe?.initSHA256)
        )
          return yield* conflict("The prepared restore identity changed during inspection.");
        yield* sql`UPDATE relay_thread_vm_restores SET phase='prepared',prepared_receipt=${encodeStatus(decoded)}::jsonb,
        claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${row.operationId}`;
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
        if (row.backupRecoveryOperationId)
          return yield* conflict(
            "The old VM is stopped; retry this held backup recovery instead of cancelling it.",
          );
        if (row.phase === "aborted" || row.phase === "aborting") return row;
        if (["committed", "booted", "importing", "completed"].includes(row.phase))
          return yield* conflict("A committed restore must recover its chosen destination.");
        yield* sql`UPDATE relay_thread_vm_restores SET phase='aborting',claim_id=NULL,claim_until=NULL,
        retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  /** A backup recovery cannot reopen its stopped source. Retire both exact
   * uncommitted preparations positively, then retry the same immutable selection. */
  const retryBackupPreparation = Effect.fn("relay.thread_vm.restore.retry_backup_preparation")(
    function* (
      input: ThreadVmRestoreClaim,
      probeCancellation: E2BRestoreStatus | null,
      bootCancellation: E2BRestoreStatus | null,
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* requireClaim(input);
          if (
            !row.backupRecoveryOperationId ||
            row.servingCommitted ||
            !["preparing", "prepared", "boot_preparing", "boot_prepared"].includes(row.phase)
          )
            return yield* conflict("Only an uncommitted backup preparation can retry this way.");
          const probe = probeCancellation ? yield* decodeStatus(probeCancellation) : null,
            boot = bootCancellation ? yield* decodeStatus(bootCancellation) : null;
          if (
            row.prepareStarted &&
            !row.probeRemoved &&
            (!probe ||
              probe.state !== "cancelled" ||
              probe.operationID !== restoreProbeOperationId(row.operationId, row.probeAttempt) ||
              probe.generation !== restoreComputeGeneration(row.operationId) ||
              (row.preparedReceipt &&
                (probe.sandboxID !== row.preparedReceipt.sandboxID ||
                  probe.executionID !== row.preparedReceipt.executionID ||
                  probe.preparedBuildID !== row.preparedReceipt.preparedBuildID)))
          )
            return yield* conflict("The exact offline probe is not positively cancelled.");
          if (
            row.bootPrepareStarted &&
            (!boot ||
              boot.state !== "cancelled" ||
              boot.operationID !== restoreBootOperationId(row.operationId, row.bootAttempt) ||
              boot.generation !== restoreBootGeneration(row.generation) ||
              (row.bootReceipt &&
                (boot.sandboxID !== row.bootReceipt.sandboxID ||
                  boot.executionID !== row.bootReceipt.executionID ||
                  boot.preparedBuildID !== row.bootReceipt.preparedBuildID)))
          )
            return yield* conflict(
              "The exact uncommitted boot preparation is not positively cancelled.",
            );
          yield* requireRecovery(row);
          yield* sql`UPDATE relay_thread_vm_restores SET phase='pending',probe_attempt=probe_attempt+1,boot_attempt=boot_attempt+1,
        preparation_cancellations=preparation_cancellations || ${sql.json([{ probeAttempt: row.probeAttempt, bootAttempt: row.bootAttempt, probe, boot }])},
        prepare_started_at=NULL,prepared_receipt=NULL,probe_removed_at=NULL,boot_prepare_started_at=NULL,boot_receipt=NULL,
        claim_id=NULL,claim_until=NULL,error_code='preparation_retry',retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${row.operationId}`;
          return (yield* get(row.operationId))!;
        }),
      );
    },
  );
  const completeAbort = Effect.fn("relay.thread_vm.restore.complete_abort")(function* (
    input: ThreadVmRestoreClaim,
    receipt?: E2BRestoreStatus,
    bootCancellation?: E2BRestoreStatus,
  ) {
    const boot =
      bootCancellation === undefined
        ? undefined
        : yield* decodeStatus(bootCancellation).pipe(
            Effect.mapError(() => conflict("Boot cancellation receipt is invalid.")),
          );
    const decoded =
      receipt === undefined
        ? undefined
        : yield* decodeStatus(receipt).pipe(
            Effect.mapError(() => conflict("Restore cancellation receipt is invalid.")),
          );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireClaim(input);
        if (row.phase !== "aborting") return yield* conflict("Restore is not cancelling.");
        if (
          row.prepareStarted &&
          !row.probeRemoved &&
          (!decoded ||
            decoded.operationID !== restoreProbeOperationId(row.operationId, row.probeAttempt) ||
            decoded.generation !== restoreComputeGeneration(row.operationId) ||
            decoded.state !== "cancelled" ||
            (row.preparedReceipt &&
              (decoded.sandboxID !== row.preparedReceipt.sandboxID ||
                decoded.executionID !== row.preparedReceipt.executionID ||
                decoded.preparedBuildID !== row.preparedReceipt.preparedBuildID)))
        )
          return yield* conflict("Restore preparation has not been positively removed.");
        if (
          row.bootPrepareStarted &&
          (!boot ||
            boot.operationID !== restoreBootOperationId(row.operationId, row.bootAttempt) ||
            boot.generation !== restoreBootGeneration(row.generation) ||
            boot.state !== "cancelled" ||
            (row.bootReceipt &&
              (boot.sandboxID !== row.bootReceipt.sandboxID ||
                boot.executionID !== row.bootReceipt.executionID ||
                boot.preparedBuildID !== row.bootReceipt.preparedBuildID)))
        )
          return yield* conflict("The boot preparation has not been positively removed.");
        // This path has never started a serving VM. The extension's cancellation
        // receipt certifies its private probe/disk cleanup, even after a lost reply.
        yield* allocations.requestDeletion(row.allocationId);
        yield* capacity.cancelUnstarted(row.operationId);
        yield* allocations.confirmDeleted({ allocationId: row.allocationId, computeRef: null });
        if (!row.savedDiskOperationId)
          return yield* conflict("Backup recovery must retain its stopped source selection.");
        yield* saved.cancelRestore({
          threadId: row.threadId,
          savedDiskOperationId: row.savedDiskOperationId,
          operationId: row.operationId,
        });
        yield* natives.releaseOperation({ threadId: row.threadId, operationId: row.operationId });
        yield* sql`UPDATE relay_thread_vm_restores SET phase='aborted',claim_id=NULL,claim_until=NULL,
        error_code=NULL WHERE operation_id=${row.operationId}`;
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
    retryBackupPreparation,
    completeAbort,
    defer,
    // Shared by the serving coordinator; each mutation remains in its caller's transaction.
    lock,
    requireClaim,
    requireRecovery,
  };
}
