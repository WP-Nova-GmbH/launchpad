import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import type { E2BRestoreError } from "../machines/E2BRestoreClient.ts";

export class ThreadDeletionConflict extends Schema.TaggedError<ThreadDeletionConflict>()(
  "ThreadDeletionConflict",
  { message: Schema.String },
) {}
const fail = () =>
  new ThreadDeletionConflict({
    message: "Thread deletion identity or resource cleanup is unconfirmed.",
  });
export interface ThreadDeletion {
  readonly threadId: string;
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly generation: number;
  readonly hostId: string;
  readonly phase: "stopping" | "cleaning" | "completed";
  readonly errorCode: string | null;
  readonly allowUncertainCaptureCleanup: boolean;
}
export interface ThreadDeletionClaim {
  readonly threadId: string;
  readonly claimId: string;
}
/** Caller authorizes admission; cleanup continues after repository access is revoked.
 * A tombstone stops new work immediately, but never proves physical VM absence. */
export function makeThreadDeletionStore(sql: PgClient) {
  const get = Effect.fn("relay.thread.delete.get")(function* (threadId: string) {
    const [row] =
      yield* sql<ThreadDeletion>`SELECT thread_id AS "threadId",operation_id AS "operationId",owner_user_id AS "ownerUserId",generation,host_id AS "hostId",phase,error_code AS "errorCode",allow_uncertain_capture_cleanup AS "allowUncertainCaptureCleanup" FROM relay_thread_deletions WHERE thread_id=${threadId}`;
    return row ?? null;
  });
  const needsUncertainCaptureCleanup = Effect.fn("relay.thread.delete.needs_capture_cleanup")(
    function* (threadId: string) {
      const rows =
        yield* sql`SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
      WHERE a.thread_id=${threadId} AND (x.phase IN ('creating','captured','verifying','cleanup') OR (x.phase='pending' AND (x.snapshot_id IS NOT NULL OR x.source_template_id IS NOT NULL OR x.source_build_id IS NOT NULL OR x.probe_receipt IS NOT NULL))) LIMIT 1`;
      return rows.length > 0;
    },
  );
  const begin = Effect.fn("relay.thread.delete.begin")(function* (
    input: Omit<ThreadDeletion, "phase" | "errorCode" | "allowUncertainCaptureCleanup"> & {
      readonly sourceDeleted?: boolean;
      readonly allowUncertainCaptureCleanup?: boolean;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const prior = yield* get(input.threadId);
        if (prior) {
          if (
            prior.operationId !== input.operationId ||
            prior.ownerUserId !== input.ownerUserId ||
            prior.generation !== input.generation ||
            prior.hostId !== input.hostId
          )
            return yield* fail();
          return prior;
        }
        const valid =
          yield* sql`SELECT 1 FROM relay_thread_placements t WHERE thread_id=${input.threadId} AND owner_user_id=${input.ownerUserId} AND generation=${input.generation} AND operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM relay_thread_local_enrollments e WHERE e.thread_id=t.thread_id AND e.phase='aborted')
    AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a WHERE a.thread_id=t.thread_id)
    AND (${input.sourceDeleted === true} OR EXISTS(SELECT 1 FROM relay_thread_vm_bindings b WHERE b.thread_id=t.thread_id AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM relay_thread_vm_saved_disks s WHERE s.thread_id=t.thread_id AND s.generation=t.generation AND s.phase IN ('available','expired')))
    AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations a JOIN relay_thread_vm_resumes x USING(allocation_id) WHERE a.thread_id=t.thread_id AND x.phase IN ('waiting','resuming'))
    AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations a JOIN relay_thread_vm_pauses x USING(allocation_id) WHERE a.thread_id=t.thread_id AND x.phase IN ('pending','sealed'))
    AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.thread_id=t.thread_id AND (x.phase IN ('creating','captured','verifying','cleanup') OR (x.phase='pending' AND (x.snapshot_id IS NOT NULL OR x.source_template_id IS NOT NULL OR x.source_build_id IS NOT NULL OR x.probe_receipt IS NOT NULL)))
      AND NOT (${input.allowUncertainCaptureCleanup === true} AND x.phase IN ('creating','captured','verifying','cleanup')
        AND x.snapshot_name='launchpad-backup-' || x.operation_id AND x.compute_ref=a.compute_ref AND a.compute_ref IS NOT NULL
        AND EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id AND p.phase='created' AND p.generation=x.generation)
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id))
      AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE x.phase IN ('creating','captured','verifying','cleanup')
        AND x.snapshot_name='launchpad-backup-' || x.operation_id AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
        AND r.source_allocation_id=a.allocation_id AND r.thread_id=t.thread_id AND r.generation=x.generation AND r.phase='completed'
        AND a.state='deleted' AND a.deleted_at IS NOT NULL AND r.retention_receipt->>'kind'='retained_for_stop'
        AND r.retention_receipt->>'recoveryOperationID'=r.operation_id AND r.retention_receipt->>'sandboxID'=a.compute_ref
        AND r.stop_receipt->>'physicallyStopped'='true' AND r.stop_receipt-'physicallyStopped'=r.retention_receipt))
    AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations a JOIN relay_thread_vm_capacity c USING(allocation_id) WHERE a.thread_id=t.thread_id AND c.host_id!=${input.hostId})`;
        if (!valid.length) return yield* fail();
        yield* sql`UPDATE relay_thread_vm_backups x SET phase='retired',claim_id=NULL,claim_until=NULL
          FROM relay_thread_vm_allocations a WHERE a.allocation_id=x.allocation_id AND a.thread_id=${input.threadId}
            AND x.phase='pending' AND x.snapshot_id IS NULL AND x.source_template_id IS NULL AND x.source_build_id IS NULL AND x.probe_receipt IS NULL`;
        yield* sql`INSERT INTO relay_thread_deletions(thread_id,operation_id,owner_user_id,generation,host_id,phase,allow_uncertain_capture_cleanup) VALUES(${input.threadId},${input.operationId},${input.ownerUserId},${input.generation},${input.hostId},'stopping',${input.allowUncertainCaptureCleanup === true})`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
        yield* sql`UPDATE relay_thread_vm_allocations SET state='deleting' WHERE thread_id=${input.threadId} AND deleted_at IS NULL`;
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE credential_id IN(SELECT credential_id FROM relay_thread_vm_bindings WHERE thread_id=${input.threadId})`;
        yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE thread_id=${input.threadId}`;
        return (yield* get(input.threadId))!;
      }),
    );
  });
  /** The environment remains the event writer. Reconcile an existing accepted
   * Delete command only after both its persisted receipt and deleted event arrived. */
  const admitMirrored = Effect.fn("relay.thread.delete.admit_mirrored")(function* (
    hostId: string,
    requireCaptureFence?: Effect.Effect<void, E2BRestoreError>,
  ) {
    const candidates = yield* sql<{
      threadId: string;
      ownerUserId: string;
      generation: number;
    }>`SELECT DISTINCT t.thread_id AS "threadId",t.owner_user_id AS "ownerUserId",t.generation
    FROM relay_thread_history h JOIN relay_thread_placements t USING(thread_id)
    JOIN relay_thread_commands q ON q.thread_id=t.thread_id AND q.command_id=h.event_json->>'commandId'
    WHERE h.event_json->>'type'='thread.deleted' AND h.environment_id=t.environment_id AND q.accepted_generation=t.generation
      AND q.payload_json->>'type'='thread.delete' AND q.actor_json->>'userId'=t.owner_user_id AND q.receipt_json->>'status'='accepted'
      AND (q.receipt_json->>'sequence')::int>=h.source_sequence AND t.operation_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
      AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a JOIN relay_thread_vm_capacity c USING(allocation_id) WHERE a.thread_id=t.thread_id AND c.host_id=${hostId})
    ORDER BY t.thread_id LIMIT 20`;
    for (const candidate of candidates) {
      const needsCaptureCleanup = yield* needsUncertainCaptureCleanup(candidate.threadId);
      const allowUncertainCaptureCleanup =
        needsCaptureCleanup && requireCaptureFence
          ? yield* requireCaptureFence.pipe(
              Effect.as(true),
              Effect.catchTag("E2BRestoreError", () => Effect.succeed(false)),
            )
          : false;
      const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const admitted = yield* begin({
        ...candidate,
        hostId,
        operationId,
        sourceDeleted: true,
        allowUncertainCaptureCleanup,
      }).pipe(
        Effect.as(true),
        Effect.catchTag("ThreadDeletionConflict", () => Effect.succeed(false)),
      );
      if (admitted) return true;
    }
    return false;
  });
  const claim = Effect.fn("relay.thread.delete.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          threadId: string;
        }>`SELECT thread_id AS "threadId" FROM relay_thread_deletions WHERE host_id=${hostId} AND phase!='completed' AND retry_at<=clock_timestamp() AND (claim_until IS NULL OR claim_until<=clock_timestamp()) ORDER BY retry_at,created_at,thread_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_deletions SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE thread_id=${row.threadId}`;
        return { ...row, claimId };
      }),
    );
  });
  const authorize = Effect.fn("relay.thread.delete.authorize")(function* (
    input: ThreadDeletionClaim,
  ) {
    yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
    const rows =
      yield* sql`SELECT 1 FROM relay_thread_deletions d JOIN relay_thread_placements t USING(thread_id) WHERE d.thread_id=${input.threadId} AND d.claim_id=${input.claimId} AND d.claim_until>clock_timestamp() AND d.phase!='completed' AND t.operation_id=d.operation_id AND t.generation=d.generation`;
    if (!rows.length) return yield* fail();
    return (yield* get(input.threadId))!;
  });
  const nextAllocation = Effect.fn("relay.thread.delete.next_allocation")(function* (
    input: ThreadDeletionClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(input);
        const [row] = yield* sql<{
          allocationId: string;
          computeRef: string | null;
          operationId: string | null;
          generation: number | null;
          provisionPhase: string | null;
          needsCaptureCleanup: boolean;
        }>`SELECT a.allocation_id AS "allocationId",a.compute_ref AS "computeRef",p.operation_id AS "operationId",p.generation,p.phase AS "provisionPhase",
          EXISTS(SELECT 1 FROM relay_thread_vm_backups x WHERE x.allocation_id=a.allocation_id AND x.phase IN ('creating','captured','verifying','cleanup')) AS "needsCaptureCleanup"
          FROM relay_thread_vm_allocations a LEFT JOIN relay_thread_vm_provisions p USING(allocation_id)
          JOIN relay_thread_deletions d ON d.thread_id=a.thread_id
          WHERE a.thread_id=${input.threadId} AND (a.deleted_at IS NULL OR (d.allow_uncertain_capture_cleanup
            AND EXISTS(SELECT 1 FROM relay_thread_vm_backups x WHERE x.allocation_id=a.allocation_id AND x.phase IN ('creating','captured','verifying','cleanup'))
            AND NOT COALESCE(a.deletion_stop_receipt->>'operationId'=d.operation_id AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id
              AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref AND a.deletion_stop_receipt->>'sourceOperationId'=p.operation_id
              AND a.deletion_stop_receipt->>'generation'=p.generation::text AND a.deletion_stop_receipt->>'physicallyStopped'='true'
              AND a.deletion_stop_receipt->>'captureAdmissionSealed'='true',false)))
          ORDER BY a.allocation_id LIMIT 1 FOR UPDATE OF a`;
        return row ?? null;
      }),
    );
  });
  const stopped = Effect.fn("relay.thread.delete.stopped")(function* (
    claim: ThreadDeletionClaim,
    allocationId: string,
    computeRef: string,
    captureAdmissionSealed = false,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(claim);
        const deletion = yield* get(claim.threadId);
        const [valid] = yield* sql<{
          sourceOperationId: string;
          generation: number;
        }>`SELECT p.operation_id AS "sourceOperationId",p.generation
          FROM relay_thread_vm_allocations a JOIN relay_thread_vm_provisions p USING(allocation_id)
          WHERE a.thread_id=${claim.threadId} AND a.allocation_id=${allocationId} AND a.compute_ref=${computeRef} AND a.state IN ('deleting','deleted') FOR UPDATE OF a`;
        if (!valid || !deletion) return yield* fail();
        yield* makeThreadVmAllocationStore(sql).confirmDeleted({ allocationId, computeRef });
        yield* sql`UPDATE relay_thread_vm_allocations SET deletion_stop_receipt=${sql.json({ operationId: deletion.operationId, allocationId, computeRef, ...valid, physicallyStopped: true, captureAdmissionSealed })} WHERE allocation_id=${allocationId}`;
      }),
    );
  });
  const clean = Effect.fn("relay.thread.delete.clean")(function* (claim: ThreadDeletionClaim) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(claim);
        if (
          (yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE thread_id=${claim.threadId} AND deleted_at IS NULL`)
            .length
        )
          return yield* fail();
        yield* sql`UPDATE relay_thread_deletions SET phase='cleaning' WHERE thread_id=${claim.threadId}`;
        yield* sql`UPDATE relay_thread_native_checkpoints SET retained=false WHERE thread_id=${claim.threadId}`;
        yield* sql`UPDATE relay_thread_move_checkpoints SET repository_retained=false,repository_upload=NULL WHERE thread_id=${claim.threadId}`;
        yield* sql`UPDATE relay_thread_native_checkpoint_operations SET phase='released',released_at=COALESCE(released_at,clock_timestamp()) WHERE checkpoint_operation_id IN(SELECT operation_id FROM relay_thread_native_checkpoints WHERE thread_id=${claim.threadId})`;
        // Keep finite active read leases. Durable pins belong to this deleted thread's operations.
        yield* sql`DELETE FROM relay_thread_artifact_pins WHERE expires_at IS NULL AND artifact_id IN(SELECT artifact_id FROM relay_thread_artifacts WHERE thread_id=${claim.threadId})`;
        yield* sql`UPDATE relay_thread_artifacts SET state='deleting',retention_until=clock_timestamp() WHERE thread_id=${claim.threadId} AND state IN ('pending','complete')`;
      }),
    );
  });
  const finish = Effect.fn("relay.thread.delete.finish")(function* (claim: ThreadDeletionClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorize(claim);
        const remaining =
          yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE thread_id=${claim.threadId} AND deleted_at IS NULL
    UNION ALL SELECT 1 FROM relay_thread_vm_bindings WHERE thread_id=${claim.threadId} AND deletion_endpoint_removed_at IS NULL
    UNION ALL SELECT 1 FROM relay_thread_vm_restores WHERE thread_id=${claim.threadId} AND (prepare_started_at IS NOT NULL OR boot_prepare_started_at IS NOT NULL) AND deletion_cleaned_at IS NULL
    UNION ALL SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE thread_id=${claim.threadId} AND retention_receipt IS NOT NULL AND retention_retired_at IS NULL
    UNION ALL SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.thread_id=${claim.threadId} AND x.phase IN ('creating','captured','verifying','cleanup')
    UNION ALL SELECT 1 FROM relay_thread_artifacts WHERE thread_id=${claim.threadId} AND state!='deleted'
    UNION ALL SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.thread_id=${claim.threadId} AND x.snapshot_id IS NOT NULL AND x.phase!='retired'`;
        if (remaining.length) return false;
        yield* sql`DELETE FROM relay_thread_vm_replacements WHERE thread_id=${claim.threadId}`;
        yield* sql`UPDATE relay_thread_vm_setups SET initial_state=NULL WHERE allocation_id IN (SELECT allocation_id FROM relay_thread_vm_allocations WHERE thread_id=${claim.threadId})`;
        yield* sql`DELETE FROM relay_thread_vm_enrollments WHERE allocation_id IN (SELECT allocation_id FROM relay_thread_vm_allocations WHERE thread_id=${claim.threadId})`;
        yield* sql`DELETE FROM relay_thread_history WHERE thread_id=${claim.threadId}`;
        yield* sql`DELETE FROM relay_thread_commands WHERE thread_id=${claim.threadId}`;
        yield* sql`DELETE FROM relay_thread_local_receipts WHERE thread_id=${claim.threadId}`;
        yield* sql`UPDATE relay_thread_deletions SET phase='completed',completed_at=clock_timestamp(),claim_id=NULL,claim_until=NULL,error_code=NULL WHERE thread_id=${claim.threadId}`;
        return true;
      }),
    );
  });
  const defer = Effect.fn("relay.thread.delete.defer")(function* (
    claim: ThreadDeletionClaim,
    errorCode: string | null,
  ) {
    yield* sql`UPDATE relay_thread_deletions SET claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp()+interval '30 seconds',error_code=${errorCode} WHERE thread_id=${claim.threadId} AND claim_id=${claim.claimId} AND phase!='completed'`;
  });
  return {
    get,
    needsUncertainCaptureCleanup,
    begin,
    admitMirrored,
    claim,
    authorize,
    nextAllocation,
    stopped,
    clean,
    finish,
    defer,
  };
}
