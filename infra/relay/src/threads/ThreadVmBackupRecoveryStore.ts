import type { PgClient } from "@effect/sql-pg/PgClient";
import type { RelayThreadVmIndependentHistory } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  E2BBackupColdProof,
  E2BExecutionRetentionCandidate,
  E2BExecutionRetentionReceipt,
  sameRetentionCandidate,
} from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";

export class ThreadVmBackupRecoveryConflict extends Schema.TaggedError<ThreadVmBackupRecoveryConflict>()(
  "ThreadVmBackupRecoveryConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmBackupRecoveryConflict({ message });
const decodeId = Schema.decodeEffect(Schema.String.check(Schema.isUUID()));
const decodeProof = Schema.decodeUnknownEffect(E2BBackupColdProof);
const decodeCandidate = Schema.decodeUnknownEffect(E2BExecutionRetentionCandidate);
const decodeRetention = Schema.decodeUnknownEffect(E2BExecutionRetentionReceipt);
const decodeStop = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...E2BExecutionRetentionReceipt.fields,
    physicallyStopped: Schema.Literal(true),
  }),
);
const matchesSource = (row: ThreadVmBackupRecovery, candidate: E2BExecutionRetentionCandidate) =>
  candidate.sandboxID === row.computeRef &&
  Object.keys(candidate.metadata).every((key) =>
    [
      "launchpad.managed",
      "launchpad.allocation_id",
      "launchpad.operation_id",
      "launchpad.thread_id",
      "launchpad.generation",
      "launchpad.restore",
      "launchpad.restore_parent_operation_id",
      "launchpad.restore_boot_attempt",
    ].includes(key),
  ) &&
  candidate.metadata["launchpad.managed"] === "thread-vm-v1" &&
  candidate.metadata["launchpad.allocation_id"] === row.sourceAllocationId &&
  candidate.metadata["launchpad.thread_id"] === row.threadId &&
  threadVmOperationMatches(candidate.metadata, row.sourceOperationId) &&
  candidate.metadata["launchpad.generation"] === String(row.generation);

export interface ThreadVmBackupRecoveryInput {
  readonly threadId: string;
  readonly actorUserId: string;
  readonly operationId: string;
  readonly allocationId: string;
  readonly expectedGeneration: number;
  readonly backup: {
    readonly sourceAllocationId: string;
    readonly backupOperationId: string;
    readonly capturedAt: string;
    readonly nativeCheckpointOperationId: string;
  };
}
export interface ThreadVmBackupRecovery {
  readonly operationId: string;
  readonly threadId: string;
  readonly allocationId: string;
  readonly sourceAllocationId: string;
  readonly actorUserId: string;
  readonly environmentId: string;
  readonly generation: number;
  readonly hostId: string;
  readonly computeRef: string;
  readonly sourceOperationId: string;
  readonly backupOperationId: string;
  readonly capturedAt: string;
  readonly nativeCheckpointOperationId: string;
  readonly nativeRelayCursor: number;
  readonly throughRelayCursor: number;
  readonly throughCommandPosition: number;
  readonly sourceTemplateId: string;
  readonly sourceBuildId: string;
  readonly independentHistory: RelayThreadVmIndependentHistory | null;
  readonly retentionCandidate: E2BExecutionRetentionCandidate | null;
  readonly retentionReceipt: unknown;
  readonly stopReceipt: unknown;
  readonly phase:
    | "pending"
    | "retaining"
    | "retained"
    | "stopped"
    | "restoring"
    | "completed"
    | "cancelled";
  readonly errorCode: string | null;
}
export type ThreadVmBackupRecoveryClaim = ThreadVmBackupRecovery & { readonly claimId: string };

/** Owner-selected workspace rollback. No final-save or saved-disk row is invented:
 * the damaged source remains held until independent retention and an exact stop. */
export function makeThreadVmBackupRecoveryStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects),
    backups = makeThreadVmBackupRetentionStore(sql),
    history = makeThreadVmRecoveryHistory(sql, objects);
  const get = Effect.fn("relay.thread_vm.backup_recovery.get")(function* (operationId: string) {
    const [row] =
      yield* sql<ThreadVmBackupRecovery>`SELECT operation_id AS "operationId",thread_id AS "threadId",
      allocation_id AS "allocationId",source_allocation_id AS "sourceAllocationId",actor_user_id AS "actorUserId",
      environment_id AS "environmentId",generation,host_id AS "hostId",compute_ref AS "computeRef",
      source_operation_id AS "sourceOperationId",backup_operation_id AS "backupOperationId",
      to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAt",
      native_checkpoint_operation_id AS "nativeCheckpointOperationId",native_relay_cursor AS "nativeRelayCursor",
      through_relay_cursor AS "throughRelayCursor",through_command_position AS "throughCommandPosition",
      source_template_id AS "sourceTemplateId",source_build_id AS "sourceBuildId",
      independent_history AS "independentHistory",retention_candidate AS "retentionCandidate",retention_receipt AS "retentionReceipt",stop_receipt AS "stopReceipt",phase,error_code AS "errorCode"
      FROM relay_thread_vm_backup_recoveries WHERE operation_id=${operationId}`;
    return row ?? null;
  });
  const source = Effect.fnUntraced(function* (threadId: string) {
    const [row] = yield* sql<{
      generation: number;
      operationId: string | null;
      actorUserId: string;
      environmentId: string;
      sourceAllocationId: string;
      computeRef: string;
      hostId: string;
      sourceOperationId: string;
    }>`SELECT t.generation,t.operation_id AS "operationId",t.owner_user_id AS "actorUserId",t.environment_id AS "environmentId",
      a.allocation_id AS "sourceAllocationId",a.compute_ref AS "computeRef",c.host_id AS "hostId",p.operation_id AS "sourceOperationId"
      FROM relay_thread_placements t JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
      JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
      JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
      JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
      JOIN LATERAL (SELECT host_id FROM relay_thread_vm_capacity WHERE allocation_id=a.allocation_id ORDER BY position DESC LIMIT 1) c ON true
      -- Private audience is the placement owner, as in privateThreadAccess.ts;
      -- placements have no visibility/deleted_at fields. begin also requires that exact actor.
      WHERE t.thread_id=${threadId} AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
        AND NOT EXISTS(SELECT 1 FROM relay_thread_local_enrollments e WHERE e.thread_id=t.thread_id AND e.phase='aborted')
        AND a.owner_user_id=t.owner_user_id AND a.thread_id=t.thread_id AND a.deleted_at IS NULL AND a.state IN ('running','paused')
        AND a.compute_ref IS NOT NULL AND p.phase='created' AND p.generation=t.generation
        AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.revoked_at IS NULL AND k.revoked_at IS NULL`;
    return row ?? null;
  });
  const selected = Effect.fnUntraced(function* (input: {
    threadId: string;
    sourceAllocationId: string;
    generation: number;
    backupOperationId?: string;
  }) {
    const [backup] = yield* sql<{
      backupOperationId: string;
      capturedAt: string | null;
      sourceTemplateId: string;
      sourceBuildId: string;
      proof: unknown;
    }>`
      SELECT b.operation_id AS "backupOperationId",to_char(b.capture_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAt",
        b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",b.probe_receipt AS proof
      FROM relay_thread_vm_backups b JOIN relay_thread_vm_allocations a USING(allocation_id)
      WHERE a.thread_id=${input.threadId} AND b.allocation_id=${input.sourceAllocationId} AND b.generation=${input.generation}
        AND (${input.backupOperationId ?? null}::text IS NULL OR b.operation_id=${input.backupOperationId ?? null})
        AND b.phase='verified' AND b.snapshot_id IS NOT NULL AND b.source_template_id IS NOT NULL AND b.source_build_id IS NOT NULL
      ORDER BY b.capture_started_at DESC NULLS LAST,b.created_at DESC,b.operation_id DESC LIMIT 1`;
    if (!backup) return null;
    const proof = yield* decodeProof(backup.proof).pipe(
      Effect.mapError(() => conflict("Backup cold proof is invalid.")),
    );
    if (
      proof.operationID !== backup.backupOperationId ||
      proof.generation !== `backup-${backup.backupOperationId}`
    )
      return yield* conflict("Backup cold proof belongs to another capture.");
    return backup;
  });
  const candidate = Effect.fn("relay.thread_vm.backup_recovery.candidate")(function* (
    threadId: string,
  ) {
    const current = yield* source(threadId),
      point = yield* natives.latestComplete(threadId);
    if (!current) return null;
    const backup = current ? yield* selected({ threadId, ...current }) : null;
    let blockedReason = !current
      ? "source_unavailable"
      : current.operationId
        ? "operation_in_progress"
        : !backup
          ? "verified_backup_unavailable"
          : !backup.capturedAt
            ? "capture_time_unknown"
            : !point
              ? "conversation_unavailable"
              : null;
    if (!blockedReason && current && point) {
      const inspected = yield* history
        .inspect({
          threadId,
          sourceEnvironmentId: current.environmentId,
          generation: current.generation,
          nativeCheckpointOperationId: point.operationId,
        })
        .pipe(Effect.result);
      if (inspected._tag === "Failure") blockedReason = "conversation_unavailable";
    }
    return {
      threadId,
      generation: current?.generation ?? 0,
      sourceAllocationId: current?.sourceAllocationId ?? "",
      backupOperationId: backup?.backupOperationId ?? null,
      capturedAt: backup?.capturedAt ?? null,
      nativeCheckpointOperationId: point?.operationId ?? null,
      available: blockedReason === null,
      blockedReason,
    };
  });
  const lock = Effect.fnUntraced(function* (operationId: string) {
    const prior = yield* get(operationId);
    if (!prior) return yield* conflict("Backup recovery does not exist.");
    const [placement] = yield* sql<{
      generation: number;
      operationId: string | null;
      actorUserId: string;
    }>`SELECT generation,operation_id AS "operationId",owner_user_id AS "actorUserId" FROM relay_thread_placements WHERE thread_id=${prior.threadId} FOR UPDATE`;
    yield* sql`SELECT operation_id FROM relay_thread_vm_backup_recoveries WHERE operation_id=${operationId} FOR UPDATE`;
    const row = (yield* get(operationId))!;
    if (row.phase === "cancelled" || row.phase === "completed") return row;
    if (
      !placement ||
      placement.operationId !== operationId ||
      placement.actorUserId !== row.actorUserId ||
      ![row.generation, row.generation + 1].includes(placement.generation)
    )
      return yield* conflict("Backup recovery no longer owns this placement.");
    return row;
  });
  const begin = Effect.fn("relay.thread_vm.backup_recovery.begin")(function* (
    input: ThreadVmBackupRecoveryInput,
  ) {
    yield* decodeId(input.operationId);
    yield* decodeId(input.allocationId);
    if (!Number.isFinite(Date.parse(input.backup.capturedAt)))
      return yield* conflict("Backup capture time is invalid.");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.allocationId},721865))`;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const cancelled =
          yield* sql`SELECT 1 FROM relay_thread_vm_backup_recovery_cancellations WHERE operation_id=${input.operationId}`;
        if (cancelled.length)
          return yield* conflict("This recovery intent was cancelled; choose a new operation.");
        const prior = yield* get(input.operationId);
        if (prior) {
          if (
            prior.threadId !== input.threadId ||
            prior.allocationId !== input.allocationId ||
            prior.actorUserId !== input.actorUserId ||
            prior.generation !== input.expectedGeneration ||
            prior.sourceAllocationId !== input.backup.sourceAllocationId ||
            prior.backupOperationId !== input.backup.backupOperationId ||
            prior.nativeCheckpointOperationId !== input.backup.nativeCheckpointOperationId ||
            prior.capturedAt !== input.backup.capturedAt ||
            prior.phase === "cancelled"
          )
            return yield* conflict(
              "Recovery identity was reused with a different or cancelled selection.",
            );
          return yield* lock(input.operationId);
        }
        const destination =
          yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=${input.allocationId}
          UNION ALL SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE allocation_id=${input.allocationId}`;
        if (destination.length)
          return yield* conflict("Recovery destination allocation ID is already reserved.");
        const operation =
          yield* sql`SELECT 1 FROM relay_thread_vm_capacity WHERE operation_id=${input.operationId}
          UNION ALL SELECT 1 FROM relay_thread_vm_provisions WHERE operation_id=${input.operationId}
          UNION ALL SELECT 1 FROM relay_thread_vm_restores WHERE operation_id=${input.operationId}`;
        if (operation.length) return yield* conflict("Recovery operation ID is already in use.");
        const current = yield* source(input.threadId);
        if (
          !current ||
          current.actorUserId !== input.actorUserId ||
          current.operationId !== null ||
          current.generation !== input.expectedGeneration ||
          current.sourceAllocationId !== input.backup.sourceAllocationId
        )
          return yield* conflict("Only the current private VM owner can recover this generation.");
        const active =
          yield* sql`SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=${current.sourceAllocationId} AND phase IN ('pending','sealed')
        UNION ALL SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=${current.sourceAllocationId} AND phase IN ('waiting','resuming')
        UNION ALL SELECT 1 FROM relay_thread_deletions WHERE thread_id=${input.threadId}`;
        if (active.length) return yield* conflict("Another VM lifecycle operation is pending.");
        const backup = yield* selected({
          threadId: input.threadId,
          sourceAllocationId: current.sourceAllocationId,
          generation: current.generation,
          backupOperationId: input.backup.backupOperationId,
        });
        if (!backup?.capturedAt || backup.capturedAt !== input.backup.capturedAt)
          return yield* conflict("The selected backup or its capture time changed.");
        yield* decodeId(backup.sourceBuildId);
        const complete = yield* history
          .inspect({
            threadId: input.threadId,
            sourceEnvironmentId: current.environmentId,
            generation: current.generation,
            nativeCheckpointOperationId: input.backup.nativeCheckpointOperationId,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SqlError"
                ? error
                : conflict("Independent recovery conversation is incomplete."),
            ),
          );
        yield* natives.pinCompleteForOperation({
          threadId: input.threadId,
          operationId: input.operationId,
          checkpointOperationId: complete.native.operationId,
          expected: complete.native,
        });
        yield* backups.pin({
          threadId: input.threadId,
          operationId: input.operationId,
          backupOperationId: backup.backupOperationId,
        });
        yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
        // Never-dispatched work can be cancelled. Uncertain captures remain truthful and retained.
        yield* sql`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL WHERE allocation_id=${current.sourceAllocationId} AND phase='pending' AND snapshot_id IS NULL AND source_template_id IS NULL AND source_build_id IS NULL AND probe_receipt IS NULL`;
        yield* sql`INSERT INTO relay_thread_vm_backup_recoveries (operation_id,thread_id,allocation_id,source_allocation_id,actor_user_id,environment_id,generation,host_id,compute_ref,source_operation_id,backup_operation_id,captured_at,native_checkpoint_operation_id,native_relay_cursor,through_relay_cursor,through_command_position,source_template_id,source_build_id,phase)
        VALUES (${input.operationId},${input.threadId},${input.allocationId},${current.sourceAllocationId},${input.actorUserId},${current.environmentId},${current.generation},${current.hostId},${current.computeRef},${current.sourceOperationId},${backup.backupOperationId},${backup.capturedAt}::timestamptz,${complete.native.operationId},${complete.nativeRelayCursor},${complete.throughRelayCursor},${complete.throughCommandPosition},${backup.sourceTemplateId},${backup.sourceBuildId},'pending')`;
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const claim = Effect.fn("relay.thread_vm.backup_recovery.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [next] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId" FROM relay_thread_vm_backup_recoveries r JOIN relay_thread_placements t USING(thread_id) WHERE r.host_id=${hostId} AND r.phase IN ('pending','retaining','retained','stopped') AND t.operation_id=r.operation_id AND t.generation=r.generation AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp()) ORDER BY r.created_at,r.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!next) return null;
        const row = yield* lock(next.operationId),
          claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_backup_recoveries SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${row.operationId}`;
        return { ...row, claimId };
      }),
    );
  });
  const authorize = Effect.fnUntraced(function* (
    input: Pick<ThreadVmBackupRecoveryClaim, "operationId" | "claimId">,
  ) {
    const row = yield* lock(input.operationId);
    const [owned] =
      yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE operation_id=${row.operationId} AND claim_id=${input.claimId} AND claim_until>clock_timestamp() AND phase IN ('pending','retaining','retained','stopped')`;
    if (!owned) return yield* conflict("Backup recovery worker claim expired or changed.");
    const [pin] =
      yield* sql`SELECT 1 FROM relay_thread_vm_backups b JOIN relay_thread_vm_backup_pins p ON p.backup_operation_id=b.operation_id WHERE p.operation_id=${row.operationId} AND b.operation_id=${row.backupOperationId} AND b.phase='verified' AND b.source_template_id=${row.sourceTemplateId} AND b.source_build_id=${row.sourceBuildId} AND b.capture_started_at=${row.capturedAt}::timestamptz`;
    if (!pin) return yield* conflict("Selected backup pin or immutable identity changed.");
    return row;
  });
  const recordHistory = Effect.fn("relay.thread_vm.backup_recovery.history")(function* (
    claim: ThreadVmBackupRecoveryClaim,
    descriptor: RelayThreadVmIndependentHistory,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        yield* history
          .verify({
            ...row,
            sourceEnvironmentId: row.environmentId,
            independentHistory: descriptor,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "SqlError"
                ? error
                : conflict("Independent recovery history is unconfirmed."),
            ),
          );
        const changed =
          yield* sql`UPDATE relay_thread_vm_backup_recoveries SET independent_history=${sql.json(descriptor)} WHERE operation_id=${row.operationId} AND (independent_history IS NULL OR independent_history=${sql.json(descriptor)}) RETURNING operation_id`;
        if (!changed.length) return yield* conflict("Independent history identity changed.");
      }),
    );
  });
  const beginRetention = Effect.fn("relay.thread_vm.backup_recovery.retain")(function* (
    claim: ThreadVmBackupRecoveryClaim,
    candidate: E2BExecutionRetentionCandidate,
  ) {
    const decoded = yield* decodeCandidate(candidate).pipe(
      Effect.mapError(() => conflict("Native retention candidate is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (
          !row.independentHistory ||
          !["pending", "retaining"].includes(row.phase) ||
          !matchesSource(row, decoded) ||
          (row.retentionCandidate && !sameRetentionCandidate(decoded, row.retentionCandidate))
        )
          return yield* conflict(
            "Independent history and the exact native source must be retained before sealing.",
          );
        yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='retaining',retention_candidate=${sql.json(decoded)} WHERE operation_id=${row.operationId}`;
        return { ...row, phase: "retaining" as const, retentionCandidate: decoded };
      }),
    );
  });
  const recordRetention = Effect.fn("relay.thread_vm.backup_recovery.retained")(function* (
    claim: ThreadVmBackupRecoveryClaim,
    receipt: E2BExecutionRetentionReceipt,
  ) {
    const decoded = yield* decodeRetention(receipt).pipe(
      Effect.mapError(() => conflict("Native retention receipt is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (
          !["retaining", "retained"].includes(row.phase) ||
          !row.retentionCandidate ||
          !matchesSource(row, decoded) ||
          decoded.recoveryOperationID !== row.operationId ||
          !sameRetentionCandidate(decoded, row.retentionCandidate) ||
          (decoded.retainedTemplateID === null) !== (decoded.buildID === null) ||
          (decoded.buildID !== null && !decoded.retainedBuildIDs.includes(decoded.buildID)) ||
          (decoded.buildID === null && decoded.retainedBuildIDs.length !== 0)
        )
          return yield* conflict("Native retention does not certify this exact damaged execution.");
        const changed =
          yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='retained',retention_receipt=${sql.json(decoded)} WHERE operation_id=${row.operationId} AND (retention_receipt IS NULL OR retention_receipt=${sql.json(decoded)}) RETURNING operation_id`;
        if (!changed.length) return yield* conflict("The retained source receipt changed.");
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const candidateChanged = Effect.fn("relay.thread_vm.backup_recovery.candidate_changed")(
    function* (claim: ThreadVmBackupRecoveryClaim) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* authorize(claim);
          if (row.phase !== "retaining" || row.retentionReceipt !== null)
            return yield* conflict("An accepted native retention cannot change its candidate.");
          yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='pending',retention_candidate=NULL,claim_id=NULL,claim_until=NULL,error_code='native_candidate_changed',retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        }),
      );
    },
  );
  const recordStopped = Effect.fn("relay.thread_vm.backup_recovery.stopped")(function* (
    claim: ThreadVmBackupRecoveryClaim,
    receipt: unknown,
  ) {
    const decoded = yield* decodeStop(receipt).pipe(
      Effect.mapError(() => conflict("Physical source stop is unconfirmed.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (
          row.phase !== "retained" ||
          !row.retentionReceipt ||
          !row.retentionCandidate ||
          !matchesSource(row, decoded) ||
          decoded.recoveryOperationID !== row.operationId ||
          !sameRetentionCandidate(decoded, row.retentionCandidate)
        )
          return yield* conflict("Physical stop does not belong to the retained source.");
        const { physicallyStopped: _stopped, ...retained } = decoded;
        const [same] =
          yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE operation_id=${row.operationId} AND retention_receipt=${sql.json(retained)}`;
        if (!same) return yield* conflict("Physical stop changed the preservation receipt.");
        yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='stopped',stop_receipt=${sql.json(decoded)} WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const cancel = Effect.fn("relay.thread_vm.backup_recovery.cancel")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* lock(operationId);
        if (row.phase === "cancelled") return row;
        if (row.phase !== "pending")
          return yield* conflict(
            "Source retention may have started; retry this held recovery instead of reviving the old VM.",
          );
        yield* history.release(row);
        yield* natives.releaseOperation(row);
        yield* backups.releasePin(row);
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${row.threadId} AND generation=${row.generation} AND operation_id=${row.operationId}`;
        yield* sql`UPDATE relay_thread_vm_backup_recoveries SET phase='cancelled',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${row.operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.backup_recovery.defer")(function* (
    claim: ThreadVmBackupRecoveryClaim,
    errorCode: string,
  ) {
    yield* sql`UPDATE relay_thread_vm_backup_recoveries SET claim_id=NULL,claim_until=NULL,error_code=${errorCode},retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()`;
  });
  const again = Effect.fnUntraced(function* (claim: ThreadVmBackupRecoveryClaim) {
    yield* sql`UPDATE relay_thread_vm_backup_recoveries SET claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()`;
  });
  const cancelIntent = Effect.fn("relay.thread_vm.backup_recovery.cancel_intent")(function* (
    input: ThreadVmBackupRecoveryInput,
  ) {
    yield* decodeId(input.operationId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [owner] =
          yield* sql`SELECT 1 FROM relay_thread_placements WHERE thread_id=${input.threadId} AND owner_user_id=${input.actorUserId} FOR UPDATE`;
        if (!owner) return yield* conflict("Only the private thread owner can cancel recovery.");
        const [prior] =
          yield* sql`SELECT 1 FROM relay_thread_vm_backup_recovery_cancellations WHERE operation_id=${input.operationId} AND thread_id=${input.threadId} AND actor_user_id=${input.actorUserId} AND request=${sql.json(input)}`;
        if (prior) return;
        const row = yield* get(input.operationId);
        if (row) {
          if (
            row.threadId !== input.threadId ||
            row.actorUserId !== input.actorUserId ||
            row.allocationId !== input.allocationId ||
            row.generation !== input.expectedGeneration ||
            row.sourceAllocationId !== input.backup.sourceAllocationId ||
            row.backupOperationId !== input.backup.backupOperationId ||
            row.capturedAt !== input.backup.capturedAt ||
            row.nativeCheckpointOperationId !== input.backup.nativeCheckpointOperationId
          )
            return yield* conflict("Cancellation selected a different recovery intent.");
          yield* cancel(input.operationId);
        }
        const [saved] =
          yield* sql`INSERT INTO relay_thread_vm_backup_recovery_cancellations(operation_id,thread_id,actor_user_id,request) VALUES(${input.operationId},${input.threadId},${input.actorUserId},${sql.json(input)}) ON CONFLICT DO NOTHING RETURNING operation_id`;
        if (!saved) return yield* conflict("Recovery cancellation identity was reused.");
      }),
    );
  });
  return {
    get,
    candidate,
    begin,
    claim,
    authorize,
    recordHistory,
    beginRetention,
    recordRetention,
    recordStopped,
    candidateChanged,
    cancel,
    cancelIntent,
    defer,
    again,
  };
}
