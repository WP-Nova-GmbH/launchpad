import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { threadVmQuotaUsage } from "./ThreadVmQuota.ts";

export class ThreadVmQuotaExceeded extends Schema.TaggedError<ThreadVmQuotaExceeded>()(
  "ThreadVmQuotaExceeded",
  { maxVms: Schema.Number, reservedVms: Schema.Number },
) {}
export class ThreadVmAllocationConflict extends Schema.TaggedError<ThreadVmAllocationConflict>()(
  "ThreadVmAllocationConflict",
  { message: Schema.String },
) {}
export interface ThreadVmAllocation {
  readonly allocationId: string;
  readonly threadId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly templateId: string;
  readonly computeRef: string | null;
  readonly state: "creating" | "running" | "paused" | "deleting" | "deleted";
  readonly deletedAt: string | null;
}
type AllocationIntent = Omit<ThreadVmAllocation, "computeRef" | "state" | "deletedAt">;
const conflict = (message: string) => new ThreadVmAllocationConflict({ message });

/** Private storage API: callers authorize the thread and reserve before contacting compute. */
export function makeThreadVmAllocationStore(sql: PgClient) {
  const get = Effect.fn("relay.thread_vm.get")(function* (allocationId: string) {
    const [row] =
      yield* sql<ThreadVmAllocation>`SELECT allocation_id AS "allocationId", thread_id AS "threadId",
      organization_id AS "organizationId", owner_user_id AS "ownerUserId", template_id AS "templateId",
      compute_ref AS "computeRef", state, deleted_at AS "deletedAt"
      FROM relay_thread_vm_allocations WHERE allocation_id = ${allocationId}`;
    return row ?? null;
  });
  const lock = Effect.fnUntraced(function* (allocationId: string) {
    yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id = ${allocationId} FOR UPDATE`;
    const row = yield* get(allocationId);
    if (!row) return yield* conflict("VM allocation does not exist");
    return row;
  });
  const reserve = Effect.fn("relay.thread_vm.reserve")(function* (
    input: AllocationIntent & {
      readonly savedDiskRestoreOperationId?: string;
      readonly savedDiskResetOperationId?: string;
      readonly replacementRequestId?: string;
      readonly backupRecoveryOperationId?: string;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // All threads owned by this user share a lock, including concurrent first allocations.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerUserId}, 721864))`;
        // Recovery reserves its destination ID before stopping the source. Share
        // this namespace lock with admission, including across different owners.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.allocationId}, 721865))`;
        const prior = yield* get(input.allocationId);
        if (prior) {
          if (
            prior.threadId !== input.threadId ||
            prior.ownerUserId !== input.ownerUserId ||
            prior.organizationId !== input.organizationId ||
            prior.templateId !== input.templateId
          )
            return yield* conflict("Allocation ID reused with different intent");
          return prior;
        }
        const recovery = yield* sql<{ allowed: boolean }>`SELECT
          (r.operation_id=${input.backupRecoveryOperationId ?? null} AND r.thread_id=${input.threadId}
            AND r.actor_user_id=${input.ownerUserId} AND r.phase='stopped' AND r.stop_receipt IS NOT NULL
            AND t.operation_id=r.operation_id AND t.generation=r.generation
            AND t.organization_id=${input.organizationId} AND a.template_id=${input.templateId}) AS allowed
          FROM relay_thread_vm_backup_recoveries r JOIN relay_thread_placements t USING(thread_id)
          JOIN relay_thread_vm_allocations a ON a.allocation_id=r.source_allocation_id
          WHERE r.allocation_id=${input.allocationId} AND r.phase!='cancelled'`;
        if (
          recovery.some((row) => !row.allowed) ||
          (input.backupRecoveryOperationId && !recovery.length)
        )
          return yield* conflict("Allocation ID belongs to a different recovery reservation");
        yield* sql`INSERT INTO relay_thread_vm_policies (organization_id) VALUES (${input.organizationId}) ON CONFLICT DO NOTHING`;
        const [policy] = yield* sql<{
          maxVms: number;
        }>`SELECT max_vms_per_user AS "maxVms" FROM relay_thread_vm_policies
        WHERE organization_id = ${input.organizationId} FOR SHARE`;
        if (!policy) return yield* conflict("VM policy is missing");
        const [replacement] = yield* sql<{
          requestId: string;
          phase: string;
          matches: boolean;
          consumable: boolean;
        }>`
          SELECT request_id AS "requestId",phase,
            ((CASE intent_json::jsonb->>'kind' WHEN 'create' THEN intent_json::jsonb#>>'{request,allocationId}' WHEN 'move' THEN request_id ELSE intent_json::jsonb#>>'{request,allocationId}' END)=${input.allocationId}
              AND (intent_json::jsonb->>'kind' NOT IN ('reset','restore') OR request_id=COALESCE(${input.savedDiskResetOperationId ?? null},${input.savedDiskRestoreOperationId ?? null}))
              AND owner_user_id=${input.ownerUserId}
              AND organization_id=${input.organizationId} AND template_id=${input.templateId}) AS matches,
            EXISTS(SELECT 1 FROM relay_thread_vm_allocations victim
              JOIN relay_thread_vm_final_saves f ON f.operation_id=final_save_operation_id
              WHERE victim.allocation_id=victim_allocation_id AND victim.deleted_at IS NOT NULL
                AND victim.state='deleted' AND f.allocation_id=victim.allocation_id AND f.phase='completed') AS consumable
          FROM relay_thread_vm_replacements WHERE thread_id=${input.threadId}
            AND phase IN ('awaiting_choice','waiting') FOR UPDATE`;
        if (replacement && !replacement.matches)
          return yield* conflict("Thread has a different waiting VM request");
        if (
          replacement?.phase === "waiting" &&
          input.replacementRequestId !== replacement.requestId
        )
          return yield* new ThreadVmQuotaExceeded({
            maxVms: policy.maxVms,
            reservedVms: yield* threadVmQuotaUsage(sql, input.ownerUserId),
          });
        if (
          input.replacementRequestId &&
          (!replacement ||
            replacement.phase !== "waiting" ||
            replacement.requestId !== input.replacementRequestId ||
            !replacement.matches ||
            !replacement.consumable)
        )
          return yield* conflict("VM replacement reservation changed");
        const usage = yield* threadVmQuotaUsage(
          sql,
          input.ownerUserId,
          input.replacementRequestId ?? null,
        );
        if (usage >= policy.maxVms)
          return yield* new ThreadVmQuotaExceeded({
            maxVms: policy.maxVms,
            reservedVms: usage,
          });
        const threads =
          yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${input.threadId}
        AND organization_id = ${input.organizationId} FOR UPDATE`;
        if (!threads.length)
          return yield* conflict("Thread does not belong to the allocation organization");
        const saved = yield* sql<{ restoreOperationId: string | null; operationId: string | null }>`
          SELECT s.restore_operation_id AS "restoreOperationId", t.operation_id AS "operationId"
          FROM relay_thread_vm_saved_disks s JOIN relay_thread_placements t USING(thread_id)
          WHERE s.thread_id=${input.threadId} AND s.generation=t.generation AND s.phase != 'restored'`;
        const reset = input.savedDiskResetOperationId
          ? yield* sql`SELECT 1 FROM relay_thread_vm_resets r
              JOIN relay_thread_placements t USING(thread_id)
              JOIN relay_thread_vm_saved_disks s ON s.operation_id=r.saved_disk_operation_id
              WHERE r.operation_id=${input.savedDiskResetOperationId} AND r.allocation_id=${input.allocationId}
                AND r.thread_id=${input.threadId} AND r.actor_user_id=${input.ownerUserId}
                AND r.expected_generation=t.generation AND t.operation_id=r.operation_id
                AND r.phase='pending' AND s.thread_id=t.thread_id AND s.generation=t.generation AND s.phase='expired'`
          : [];
        if (input.savedDiskResetOperationId && !reset.length)
          return yield* conflict("Reset reservation no longer owns this expired workspace");
        if (
          saved.length &&
          !reset.length &&
          (!input.savedDiskRestoreOperationId ||
            saved.some(
              (row) =>
                row.restoreOperationId !== input.savedDiskRestoreOperationId ||
                row.operationId !== input.savedDiskRestoreOperationId,
            ))
        )
          return yield* conflict("Saved disk requires an explicit restore or reset admission");
        const existing =
          yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE thread_id = ${input.threadId} AND deleted_at IS NULL`;
        if (existing.length) return yield* conflict("Thread already has a VM allocation");
        yield* sql`INSERT INTO relay_thread_vm_allocations (allocation_id, thread_id, organization_id, owner_user_id, template_id, state)
        VALUES (${input.allocationId}, ${input.threadId}, ${input.organizationId}, ${input.ownerUserId}, ${input.templateId}, 'creating')`;
        if (replacement?.phase === "awaiting_choice")
          yield* sql`UPDATE relay_thread_vm_replacements SET phase='admitted',error_code=NULL WHERE request_id=${replacement.requestId}`;
        return yield* lock(input.allocationId);
      }),
    );
  });
  const recordCreated = Effect.fn("relay.thread_vm.record_created")(function* (input: {
    allocationId: string;
    computeRef: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const allocation = yield* lock(input.allocationId);
        if (allocation.computeRef !== null && allocation.computeRef !== input.computeRef)
          return yield* conflict("Allocation already has a different compute identity");
        if (allocation.state === "deleted")
          return yield* conflict("Allocation has already been removed");
        // An ambiguous create may resolve after deletion was requested. Keep deletion pending.
        yield* sql`UPDATE relay_thread_vm_allocations SET compute_ref = ${input.computeRef},
        state = CASE WHEN state = 'creating' THEN 'running' ELSE state END WHERE allocation_id = ${input.allocationId}`;
        return yield* lock(input.allocationId);
      }),
    );
  });
  const recordPowerState = Effect.fn("relay.thread_vm.record_power_state")(function* (input: {
    allocationId: string;
    computeRef: string;
    state: "running" | "paused";
    capacityOperationId?: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const allocation = yield* lock(input.allocationId);
        if (
          allocation.computeRef !== input.computeRef ||
          !["running", "paused"].includes(allocation.state)
        )
          return yield* conflict("VM no longer accepts power-state changes");
        const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
          WHERE allocation_id = ${input.allocationId} AND phase IN ('pending','sealed')`;
        if (pausing.length) return yield* conflict("VM pause is in progress");
        const resuming = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
          WHERE allocation_id = ${input.allocationId} AND phase IN ('waiting','resuming')`;
        if (resuming.length) return yield* conflict("VM resume is in progress");
        const backingUp = yield* sql`SELECT 1 FROM relay_thread_vm_backups
          WHERE allocation_id = ${input.allocationId}
            AND phase IN ('pending','creating','captured','verifying','cleanup')`;
        if (backingUp.length) return yield* conflict("VM backup is in progress");
        const capacity = yield* sql<{
          state: string;
          computeRef: string | null;
          operationId: string;
        }>`SELECT state, compute_ref AS "computeRef", operation_id AS "operationId"
          FROM relay_thread_vm_capacity WHERE allocation_id = ${input.allocationId} AND state != 'released' FOR UPDATE`;
        if (
          capacity.length &&
          !capacity.some(
            (row) =>
              row.state === "started" &&
              row.computeRef === input.computeRef &&
              row.operationId === input.capacityOperationId,
          )
        )
          return yield* conflict("Power receipt does not match the current capacity operation");
        if (input.state === "running" && allocation.state === "paused" && !capacity.length) {
          const enrolled =
            yield* sql`SELECT operation_id FROM relay_thread_vm_capacity WHERE allocation_id = ${input.allocationId}`;
          if (enrolled.length)
            return yield* conflict("Resume requires its own confirmed capacity admission");
        }
        yield* sql`UPDATE relay_thread_vm_allocations SET state = ${input.state} WHERE allocation_id = ${input.allocationId}`;
        if (input.state === "paused") {
          yield* sql`UPDATE relay_thread_vm_capacity SET state = 'released' WHERE allocation_id = ${input.allocationId}
            AND state = 'started' AND compute_ref = ${input.computeRef}`;
        }
        return yield* lock(input.allocationId);
      }),
    );
  });
  const requestDeletion = Effect.fn("relay.thread_vm.request_deletion")(function* (
    allocationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const allocation = yield* lock(allocationId);
        if (allocation.state === "deleted") return allocation;
        const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
          WHERE allocation_id = ${allocationId} AND phase IN ('pending','sealed')`;
        if (pausing.length) return yield* conflict("VM pause is in progress");
        const resuming = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
          WHERE allocation_id = ${allocationId} AND phase IN ('waiting','resuming')`;
        if (resuming.length) return yield* conflict("VM resume is in progress");
        const backingUp = yield* sql`SELECT 1 FROM relay_thread_vm_backups
          WHERE allocation_id = ${allocationId}
            AND phase IN ('pending','creating','captured','verifying','cleanup')`;
        if (backingUp.length) return yield* conflict("VM backup is in progress");
        yield* sql`UPDATE relay_thread_vm_allocations SET state = 'deleting' WHERE allocation_id = ${allocationId}`;
        return yield* lock(allocationId);
      }),
    );
  });
  // The reconciler must prove absence by allocation identity, including an ambiguous create.
  const confirmDeleted = Effect.fn("relay.thread_vm.confirm_deleted")(function* (input: {
    allocationId: string;
    computeRef: string | null;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const allocation = yield* lock(input.allocationId);
        if (allocation.computeRef !== input.computeRef)
          return yield* conflict("Compute identity changed during deletion");
        if (allocation.state === "deleted") return allocation;
        if (allocation.state !== "deleting")
          return yield* conflict("Deletion has not been requested");
        const capacity = yield* sql<{
          state: string;
          computeRef: string | null;
        }>`SELECT state, compute_ref AS "computeRef"
          FROM relay_thread_vm_capacity WHERE allocation_id = ${input.allocationId} AND state != 'released' FOR UPDATE`;
        if (
          capacity.some(
            (row) =>
              row.state === "started" &&
              (row.computeRef === null || row.computeRef !== input.computeRef),
          )
        )
          return yield* conflict("Unknown external execution still holds host capacity");
        yield* sql`UPDATE relay_thread_vm_capacity SET state = 'released' WHERE allocation_id = ${input.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_allocations SET state = 'deleted', deleted_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE allocation_id = ${input.allocationId}`;
        return yield* lock(input.allocationId);
      }),
    );
  });
  return { get, reserve, recordCreated, recordPowerState, requestDeletion, confirmDeleted };
}
