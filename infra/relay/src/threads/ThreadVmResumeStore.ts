import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";

export class ThreadVmResumeConflict extends Schema.TaggedError<ThreadVmResumeConflict>()(
  "ThreadVmResumeConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmResumeConflict({ message });
const operationId = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

interface ResumeRecord {
  readonly operationId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly phase: "waiting" | "resuming" | "completed";
}
export interface ResumeClaim extends ResumeRecord {
  readonly claimId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly computeRef: string;
  readonly templateId: string;
  readonly provisionOperationId: string;
  readonly pauseOperationId: string | null;
  readonly capacityState: "reserved" | "started";
}

/** Explicit wake reserves the same allocation and waits for physical host capacity. */
export function makeThreadVmResumeStore(sql: PgClient) {
  /** Only a certified, non-waking native inspection may call this. A timeout
   * releases power capacity without inventing a frozen conversation checkpoint. */
  const reconcileNativePause = Effect.fn("relay.thread_vm.resume.reconcile_native_pause")(
    function* (input: {
      readonly allocationId: string;
      readonly computeRef: string;
      readonly threadId: string;
      readonly generation: number;
      readonly operationId: string;
      readonly hostId: string;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements
            WHERE thread_id=${input.threadId} FOR UPDATE`;
          const [current] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
            JOIN relay_thread_vm_bindings b USING(allocation_id)
            JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
            JOIN relay_thread_vm_provisions p USING(allocation_id)
            JOIN relay_thread_placements t ON t.thread_id=a.thread_id
            JOIN relay_thread_vm_capacity c ON c.allocation_id=a.allocation_id
            WHERE a.allocation_id=${input.allocationId} AND a.compute_ref=${input.computeRef}
              AND a.thread_id=${input.threadId} AND a.state='running' AND a.deleted_at IS NULL
              AND t.generation=${input.generation} AND t.operation_id IS NULL
              AND t.owner_user_id=a.owner_user_id AND t.environment_id=b.environment_id
              AND b.generation=t.generation AND b.revoked_at IS NULL AND k.revoked_at IS NULL
              AND p.operation_id=${input.operationId} AND p.generation=t.generation AND p.phase='created'
              AND c.host_id=${input.hostId} AND c.compute_ref=a.compute_ref AND c.state='started'
              AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id
                AND (x.phase='sealed' OR (x.phase='pending' AND (x.native_checkpoint_operation_id IS NOT NULL OR x.source_frozen_at IS NOT NULL OR x.boot_id IS NOT NULL OR x.claim_id IS NOT NULL))
                  OR (x.source_frozen_at IS NOT NULL AND x.source_reopened_at IS NULL)))
              AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r WHERE r.allocation_id=a.allocation_id AND r.phase IN ('waiting','resuming'))
            FOR UPDATE OF a,c`;
          if (!current) return false;
          // The guest may already own this drain even before publishing its
          // checkpoint. Keep its identity and delivery hold until resumed ack.
          yield* sql`UPDATE relay_thread_vm_pauses SET phase='cancelled',claim_id=NULL,claim_until=NULL
            WHERE allocation_id=${input.allocationId} AND generation=${input.generation} AND phase='pending'
              AND native_checkpoint_operation_id IS NULL AND source_frozen_at IS NULL AND boot_id IS NULL AND claim_id IS NULL`;
          yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',native_paused_generation=${input.generation}
            WHERE allocation_id=${input.allocationId}`;
          yield* sql`UPDATE relay_thread_vm_capacity SET state='released'
            WHERE allocation_id=${input.allocationId} AND compute_ref=${input.computeRef} AND state='started'`;
          yield* sql`UPDATE relay_thread_vm_activity SET revision=revision+1,activity='unknown',observed_at=NULL,
            idle_since=NULL,pause_due_at=NULL,delete_due_at=NULL WHERE allocation_id=${input.allocationId}`;
          return true;
        }),
      );
    },
  );
  const get = Effect.fn("relay.thread_vm.resume.get")(function* (allocationId: string) {
    const [row] = yield* sql<ResumeRecord>`SELECT operation_id AS "operationId",
      allocation_id AS "allocationId", generation, phase
      FROM relay_thread_vm_resumes WHERE allocation_id = ${allocationId}`;
    return row ?? null;
  });
  const request = Effect.fn("relay.thread_vm.resume.request")(function* (threadId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{ generation: number; operationId: string | null }>`
        SELECT generation, operation_id AS "operationId" FROM relay_thread_placements
        WHERE thread_id = ${threadId} FOR UPDATE`;
        if (!placement || placement.operationId !== null)
          return yield* conflict("Thread placement is unavailable for wake");
        const [allocation] = yield* sql<{
          allocationId: string;
          state: string;
          computeRef: string;
          nativePausedGeneration: number | null;
        }>`
        SELECT allocation_id AS "allocationId", state, compute_ref AS "computeRef",
          native_paused_generation AS "nativePausedGeneration"
        FROM relay_thread_vm_allocations WHERE thread_id = ${threadId}
          AND deleted_at IS NULL FOR UPDATE`;
        if (!allocation || allocation.state !== "paused" || !allocation.computeRef)
          return yield* conflict("VM is not paused");
        const [binding] = yield* sql`SELECT 1 FROM relay_thread_vm_bindings b
        JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
        WHERE b.allocation_id = ${allocation.allocationId}
          AND b.generation = ${placement.generation} AND b.revoked_at IS NULL AND k.revoked_at IS NULL`;
        const [pause] = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
        WHERE allocation_id = ${allocation.allocationId} AND phase = 'completed' AND generation=${placement.generation}`;
        if (!binding || (!pause && allocation.nativePausedGeneration !== placement.generation))
          return yield* conflict("VM pause has not been confirmed");
        const prior = yield* get(allocation.allocationId);
        if (prior?.phase !== "completed" && prior) return prior;
        const [host] = yield* sql<{ hostId: string }>`SELECT host_id AS "hostId"
        FROM relay_thread_vm_capacity WHERE allocation_id = ${allocation.allocationId}
        ORDER BY position DESC LIMIT 1`;
        if (!host) return yield* conflict("VM host is unknown");
        const newOperationId = operationId();
        yield* sql`INSERT INTO relay_thread_vm_resumes (allocation_id, operation_id, generation, phase)
        VALUES (${allocation.allocationId}, ${newOperationId}, ${placement.generation}, 'waiting')
        ON CONFLICT (allocation_id) DO UPDATE SET operation_id = excluded.operation_id,
          generation = excluded.generation, phase = 'waiting', claim_id = NULL,
          claim_until = NULL, retry_at = clock_timestamp()
        WHERE relay_thread_vm_resumes.phase = 'completed'`;
        yield* makeThreadVmCapacityStore(sql).request({
          operationId: newOperationId,
          allocationId: allocation.allocationId,
          hostId: host.hostId,
          kind: "resume",
        });
        return (yield* get(allocation.allocationId))!;
      }),
    );
  });

  const claim = Effect.fn("relay.thread_vm.resume.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Omit<ResumeClaim, "claimId">>`
        SELECT r.operation_id AS "operationId", r.allocation_id AS "allocationId",
          r.generation, r.phase, a.thread_id AS "threadId",
          b.repository_id AS "repositoryId", a.compute_ref AS "computeRef", a.template_id AS "templateId",
          p.operation_id AS "provisionOperationId",
          CASE WHEN x.phase='cancelled' AND x.source_reopened_at IS NULL THEN x.operation_id
            WHEN a.native_paused_generation=r.generation THEN NULL ELSE x.operation_id END AS "pauseOperationId",
          c.state AS "capacityState"
        FROM relay_thread_vm_resumes r
        JOIN relay_thread_vm_allocations a ON a.allocation_id = r.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id = r.allocation_id
        LEFT JOIN relay_thread_vm_pauses x ON x.allocation_id = r.allocation_id AND x.generation=r.generation
        JOIN relay_thread_vm_capacity c ON c.operation_id = r.operation_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id = r.allocation_id
          AND b.generation = r.generation AND b.revoked_at IS NULL
        JOIN relay_environment_credentials k ON k.credential_id=b.credential_id AND k.revoked_at IS NULL
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE c.host_id = ${hostId} AND r.phase IN ('waiting','resuming')
          AND c.state IN ('reserved','started') AND a.state IN ('paused','running')
          AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
          AND (a.native_paused_generation=r.generation OR (x.phase='completed' AND x.generation=r.generation))
          AND t.generation = r.generation AND t.environment_id = b.environment_id
          AND t.owner_user_id=a.owner_user_id
          AND t.operation_id IS NULL AND r.retry_at <= clock_timestamp()
          AND (r.claim_until IS NULL OR r.claim_until <= clock_timestamp())
        ORDER BY c.position LIMIT 1 FOR UPDATE OF r SKIP LOCKED`;
        if (!row) return null;
        const claimId = operationId();
        yield* sql`UPDATE relay_thread_vm_resumes SET claim_id = ${claimId},
        claim_until = clock_timestamp() + interval '2 minutes'
        WHERE allocation_id = ${row.allocationId}`;
        return { ...row, claimId } satisfies ResumeClaim;
      }),
    );
  });
  const requireCurrent = Effect.fnUntraced(function* (claim: ResumeClaim) {
    const [current] = yield* sql`SELECT 1 FROM relay_thread_placements t
      JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id
      JOIN relay_thread_vm_bindings b USING(allocation_id)
      JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
      WHERE t.thread_id=${claim.threadId} AND t.generation=${claim.generation} AND t.operation_id IS NULL
        AND a.allocation_id=${claim.allocationId} AND a.compute_ref=${claim.computeRef} AND a.deleted_at IS NULL
        AND t.owner_user_id=a.owner_user_id AND b.environment_id=t.environment_id AND b.generation=t.generation
        AND b.revoked_at IS NULL AND k.revoked_at IS NULL
      FOR UPDATE OF t,a`;
    if (!current) return yield* conflict("Resume ownership or credentials changed.");
  });
  const begin = Effect.fn("relay.thread_vm.resume.begin")(function* (claim: ResumeClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireCurrent(claim);
        if (claim.capacityState === "reserved")
          yield* makeThreadVmCapacityStore(sql).beginExecution(claim.operationId);
        const [row] = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
        WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
          AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
          AND phase IN ('waiting','resuming') FOR UPDATE`;
        if (!row) return yield* conflict("Resume claim expired");
        yield* sql`UPDATE relay_thread_vm_resumes SET phase = 'resuming'
        WHERE allocation_id = ${claim.allocationId}`;
      }),
    );
  });
  const finishPower = Effect.fn("relay.thread_vm.resume.finish_power")(function* (
    claim: ResumeClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireCurrent(claim);
        const [allocation] = yield* sql<{ state: string; computeRef: string }>`
        SELECT state, compute_ref AS "computeRef" FROM relay_thread_vm_allocations
        WHERE allocation_id = ${claim.allocationId} FOR UPDATE`;
        const [resume] = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
        WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
          AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
          AND phase = 'resuming' FOR UPDATE`;
        const [capacity] = yield* sql`SELECT 1 FROM relay_thread_vm_capacity
        WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
          AND state = 'started' AND compute_ref = ${claim.computeRef} FOR UPDATE`;
        if (
          !resume ||
          !capacity ||
          allocation?.computeRef !== claim.computeRef ||
          !["paused", "running"].includes(allocation.state)
        )
          return false;
        yield* sql`UPDATE relay_thread_vm_allocations SET state = 'running'
        WHERE allocation_id = ${claim.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_activity SET revision = revision + 1,
        activity = 'unknown', observed_at = NULL, idle_since = NULL,
        last_work_at = clock_timestamp() WHERE allocation_id = ${claim.allocationId}`;
        return true;
      }),
    );
  });
  const complete = Effect.fn("relay.thread_vm.resume.complete")(function* (claim: ResumeClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireCurrent(claim);
        const rows = yield* sql`UPDATE relay_thread_vm_resumes r SET phase = 'completed',
      claim_id = NULL, claim_until = NULL FROM relay_thread_vm_allocations a
      WHERE r.allocation_id = ${claim.allocationId} AND r.operation_id = ${claim.operationId}
        AND r.claim_id = ${claim.claimId} AND r.claim_until > clock_timestamp()
        AND r.phase = 'resuming' AND a.allocation_id = r.allocation_id
        AND a.state = 'running' AND a.compute_ref = ${claim.computeRef}
      RETURNING r.allocation_id`;
        if (rows.length === 1)
          yield* sql`UPDATE relay_thread_vm_allocations SET native_paused_generation=NULL
        WHERE allocation_id=${claim.allocationId}`;
        return rows.length === 1;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.resume.defer")(function* (claim: ResumeClaim) {
    yield* sql`UPDATE relay_thread_vm_resumes SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
        AND claim_id = ${claim.claimId} AND phase IN ('waiting','resuming')`;
  });
  return { get, request, claim, begin, finishPower, complete, defer, reconcileNativePause };
}
