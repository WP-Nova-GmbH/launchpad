import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { wakeQueuedThreadVm } from "./ThreadVmWakeAdmission.ts";

export interface PauseClaim {
  readonly allocationId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly computeRef: string;
  readonly templateId: string;
  readonly provisionOperationId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly generation: number;
  readonly phase: "pending" | "sealed";
  readonly bootId: string;
}

/** A placement lock is shared with command admission and moves. The claim survives worker loss. */
export function makeThreadVmPauseStore(sql: PgClient) {
  const reserveIdle = Effect.fn("relay.thread_vm.pause.reserve_idle")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{ allocationId: string; generation: number }>`
          SELECT a.allocation_id AS "allocationId", t.generation
          FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
          JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id AND c.state = 'started'
          JOIN relay_thread_vm_activity v ON v.allocation_id = a.allocation_id
          JOIN relay_thread_vm_policies policy ON policy.organization_id = a.organization_id
          JOIN relay_thread_vm_ready s ON s.allocation_id = a.allocation_id
          JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
          JOIN relay_thread_placements t ON t.thread_id = a.thread_id
          WHERE c.host_id = ${hostId} AND c.state = 'started'
            AND a.state = 'running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
            AND p.phase = 'created' AND s.phase = 'ready' AND b.revoked_at IS NULL
            AND b.generation = p.generation AND t.environment_id = b.environment_id
            AND t.generation = p.generation AND t.operation_id IS NULL
            AND v.activity = 'idle' AND v.observed_at >= clock_timestamp() - interval '2 minutes'
            AND v.idle_since <= clock_timestamp() - make_interval(mins => policy.pause_after_idle_minutes)
            AND NOT EXISTS (SELECT 1 FROM relay_thread_execution_admissions e
              WHERE e.thread_id = a.thread_id AND e.generation = p.generation AND e.completed = false
                AND NOT (e.environment_id=t.environment_id AND jsonb_exists(v.inactive_work_ids,e.work_id)))
            AND NOT EXISTS (SELECT 1 FROM relay_thread_commands q
              WHERE q.thread_id = a.thread_id AND q.receipt_json IS NULL)
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
              WHERE x.allocation_id = a.allocation_id AND (x.phase IN ('pending','sealed') OR (x.phase='cancelled' AND x.source_reopened_at IS NULL) OR (x.phase='completed' AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r WHERE r.allocation_id=a.allocation_id AND r.generation=t.generation AND r.phase='completed'))))
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
              JOIN relay_thread_native_checkpoint_operations n ON n.operation_id=x.operation_id AND n.phase='active'
              WHERE x.allocation_id=a.allocation_id)
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
              WHERE x.allocation_id = a.allocation_id
                AND x.phase IN ('pending','creating','captured','verifying','cleanup'))
          ORDER BY v.idle_since, a.allocation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        // The candidate query owns the placement lock, shared with new commands and moves.
        const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`INSERT INTO relay_thread_vm_pauses (allocation_id, operation_id, generation, phase)
          VALUES (${candidate.allocationId}, ${operationId}, ${candidate.generation}, 'pending')
          ON CONFLICT (allocation_id) DO UPDATE SET operation_id = excluded.operation_id,
            generation = excluded.generation, phase = 'pending', boot_id = NULL,
            native_checkpoint_operation_id = NULL, source_sequence = NULL, source_frozen_at = NULL, source_reopened_at = NULL,
            claim_id = NULL, claim_until = NULL, retry_at = clock_timestamp()
          WHERE relay_thread_vm_pauses.phase IN ('cancelled','completed')`;
        return candidate.allocationId;
      }),
    );
  });

  /** Cancelling an uncertified pause holds delivery until the guest acknowledges its reopened fence. */
  const cancelBeforeFreeze = Effect.fn("relay.thread_vm.pause.cancel_before_freeze")(
    function* (input: {
      readonly threadId: string;
      readonly environmentId: string;
      readonly generation: number;
      readonly operationId: string;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [placement] =
            yield* sql`SELECT 1 FROM relay_thread_placements WHERE thread_id=${input.threadId}
        AND environment_id=${input.environmentId} AND generation=${input.generation} AND operation_id IS NULL FOR UPDATE`;
          if (!placement) return false;
          const [allocation] = yield* sql<{
            allocationId: string;
          }>`SELECT a.allocation_id AS "allocationId" FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_bindings b USING(allocation_id)
        WHERE a.thread_id=${input.threadId} AND a.state='running' AND a.deleted_at IS NULL
          AND b.environment_id=${input.environmentId} AND b.generation=${input.generation} AND b.revoked_at IS NULL FOR UPDATE OF a`;
          if (!allocation) return false;
          const rows =
            yield* sql`UPDATE relay_thread_vm_pauses SET phase='cancelled',claim_id=NULL,claim_until=NULL
        WHERE allocation_id=${allocation.allocationId} AND operation_id=${input.operationId} AND generation=${input.generation}
          AND phase='pending' AND native_checkpoint_operation_id IS NULL AND source_frozen_at IS NULL AND claim_id IS NULL
        RETURNING allocation_id`;
          if (rows.length !== 1) return false;
          yield* sql`UPDATE relay_thread_vm_activity SET revision=revision+1,activity='unknown',observed_at=NULL,idle_since=NULL,
        pause_due_at=NULL,delete_due_at=NULL,deadline_idle_since=NULL,deadline_policy_revision=NULL,deadline_time_zone=NULL,lifecycle_checked_at=NULL
        WHERE allocation_id=${allocation.allocationId}`;
          return true;
        }),
      );
    },
  );

  const claim = Effect.fn("relay.thread_vm.pause.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Omit<PauseClaim, "claimId">>`
          SELECT x.allocation_id AS "allocationId", x.operation_id AS "operationId",
            a.compute_ref AS "computeRef", a.template_id AS "templateId", p.operation_id AS "provisionOperationId",
            a.thread_id AS "threadId", b.repository_id AS "repositoryId",
            x.generation, x.phase, x.boot_id AS "bootId"
          FROM relay_thread_vm_pauses x
          JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
          JOIN relay_thread_vm_provisions p ON p.allocation_id = x.allocation_id
          JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id AND c.state = 'started'
          JOIN relay_thread_vm_bindings b ON b.allocation_id = x.allocation_id
            AND b.generation = x.generation AND b.revoked_at IS NULL
          JOIN relay_thread_placements t ON t.thread_id = a.thread_id
          WHERE c.host_id = ${hostId} AND x.phase IN ('pending','sealed')
            AND a.state = 'running' AND a.deleted_at IS NULL
            AND t.generation = x.generation AND t.environment_id = b.environment_id
            AND t.operation_id IS NULL
            AND x.native_checkpoint_operation_id IS NOT NULL AND x.source_sequence IS NOT NULL
            AND x.source_frozen_at IS NOT NULL AND x.boot_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM relay_thread_native_checkpoint_operations n
              WHERE n.operation_id=x.operation_id AND n.checkpoint_operation_id=x.native_checkpoint_operation_id AND n.phase='active')
            AND x.retry_at <= clock_timestamp()
            AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
          ORDER BY x.retry_at, x.allocation_id LIMIT 1 FOR UPDATE OF x SKIP LOCKED`;
        if (!row) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_pauses SET claim_id = ${claimId},
          claim_until = clock_timestamp() + interval '2 minutes'
          WHERE allocation_id = ${row.allocationId}`;
        return { ...row, claimId } satisfies PauseClaim;
      }),
    );
  });

  const markSealed = Effect.fn("relay.thread_vm.pause.mark_sealed")(function* (
    claim: PauseClaim,
    bootId: string,
  ) {
    const rows = yield* sql`UPDATE relay_thread_vm_pauses SET phase = 'sealed'
      WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase IN ('pending','sealed') AND boot_id=${bootId}
        AND native_checkpoint_operation_id IS NOT NULL AND source_frozen_at IS NOT NULL
      RETURNING allocation_id`;
    return rows.length === 1;
  });

  const finish = Effect.fn("relay.thread_vm.pause.finish")(function* (claim: PauseClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Lock order matches command admission: placement, then allocation.
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${claim.threadId} FOR UPDATE`;
        const [allocation] = yield* sql<{ state: string; computeRef: string }>`
          SELECT state, compute_ref AS "computeRef" FROM relay_thread_vm_allocations
          WHERE allocation_id = ${claim.allocationId} FOR UPDATE`;
        const [pause] = yield* sql<{ phase: string }>`SELECT phase FROM relay_thread_vm_pauses
          WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
            AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp() FOR UPDATE`;
        if (pause?.phase === "completed" && allocation?.state === "paused") return true;
        if (
          pause?.phase !== "sealed" ||
          allocation?.state !== "running" ||
          allocation.computeRef !== claim.computeRef
        )
          return false;
        const [placement] = yield* sql`SELECT 1 FROM relay_thread_placements t
          JOIN relay_thread_vm_bindings b ON b.thread_id = t.thread_id
          WHERE t.thread_id = ${claim.threadId} AND t.generation = ${claim.generation}
            AND t.operation_id IS NULL AND b.allocation_id = ${claim.allocationId}
            AND b.environment_id = t.environment_id AND b.generation = t.generation
            AND b.revoked_at IS NULL`;
        if (!placement) return false;
        const capacity = yield* sql`SELECT 1 FROM relay_thread_vm_capacity
          WHERE allocation_id = ${claim.allocationId} AND state = 'started'
            AND compute_ref = ${claim.computeRef} FOR UPDATE`;
        if (capacity.length !== 1) return false;
        yield* sql`UPDATE relay_thread_vm_allocations SET state = 'paused'
          WHERE allocation_id = ${claim.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_capacity SET state = 'released'
          WHERE allocation_id = ${claim.allocationId} AND state = 'started'
            AND compute_ref = ${claim.computeRef}`;
        yield* sql`UPDATE relay_thread_vm_pauses SET phase = 'completed',
          claim_id = NULL, claim_until = NULL WHERE allocation_id = ${claim.allocationId}`;
        yield* wakeQueuedThreadVm(sql, claim.threadId);
        return true;
      }),
    );
  });

  const cancel = Effect.fn("relay.thread_vm.pause.cancel")(function* (claim: PauseClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE relay_thread_vm_pauses SET phase = 'cancelled',
        claim_id = NULL, claim_until = NULL WHERE allocation_id = ${claim.allocationId}
        AND operation_id = ${claim.operationId} AND claim_id = ${claim.claimId}
        AND phase IN ('pending','sealed') RETURNING allocation_id`;
        if (rows.length)
          yield* sql`UPDATE relay_thread_vm_activity SET revision = revision + 1,
        activity = 'unknown', observed_at = NULL, idle_since = NULL
        WHERE allocation_id = ${claim.allocationId}`;
        return rows.length === 1;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.pause.defer")(function* (claim: PauseClaim) {
    yield* sql`UPDATE relay_thread_vm_pauses SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
        AND claim_id = ${claim.claimId} AND phase IN ('pending','sealed')`;
  });
  return { reserveIdle, cancelBeforeFreeze, claim, markSealed, finish, cancel, defer };
}
