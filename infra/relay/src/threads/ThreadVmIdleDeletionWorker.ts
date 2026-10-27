import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { lockThreadVmPolicy, writeThreadVmIdleDeadline } from "./ThreadVmPolicy.ts";

/** Reserves one due source drain, never stops/deletes compute. A stale deadline only schedules a refresh. */
export function makeThreadVmIdleDeletionWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  hostId: string,
) {
  const saves = makeThreadVmFinalSaveStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.idle_deletion.reserve_one")(function* () {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          allocationId: string;
          threadId: string;
          ownerUserId: string;
          organizationId: string;
          generation: number;
        }>`SELECT a.allocation_id AS "allocationId",a.thread_id AS "threadId",a.owner_user_id AS "ownerUserId",
        a.organization_id AS "organizationId",t.generation
        FROM relay_thread_vm_allocations a JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_bindings b USING(allocation_id) JOIN relay_thread_vm_provisions p USING(allocation_id)
        JOIN relay_thread_vm_ready s USING(allocation_id) JOIN relay_thread_vm_activity v USING(allocation_id)
        JOIN relay_thread_vm_policies policy ON policy.organization_id=a.organization_id
        JOIN LATERAL (SELECT host_id,state FROM relay_thread_vm_capacity WHERE allocation_id=a.allocation_id ORDER BY position DESC LIMIT 1) c ON true
        WHERE c.host_id=${hostId} AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL AND t.operation_id IS NULL
          AND a.owner_user_id=t.owner_user_id AND b.revoked_at IS NULL AND b.environment_id=t.environment_id AND b.generation=t.generation
          AND p.phase='created' AND p.generation=t.generation AND s.phase='ready' AND v.idle_since IS NOT NULL
          AND ((a.state='running' AND c.state='started' AND v.activity='idle' AND v.observed_at>=clock_timestamp()-interval '2 minutes')
            OR (a.state='paused' AND c.state='released' AND EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
              WHERE x.allocation_id=a.allocation_id AND x.generation=t.generation AND x.phase='completed' AND x.source_frozen_at IS NOT NULL AND x.native_checkpoint_operation_id IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id AND
            (x.phase IN ('pending','sealed') OR (x.phase='cancelled' AND x.source_reopened_at IS NULL)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes x WHERE x.allocation_id=a.allocation_id AND x.phase IN ('waiting','resuming'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x WHERE x.allocation_id=a.allocation_id AND x.phase IN ('pending','creating','captured','verifying','cleanup'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_commands x WHERE x.thread_id=a.thread_id AND x.receipt_json IS NULL)
          AND NOT EXISTS (SELECT 1 FROM relay_thread_execution_admissions x WHERE x.thread_id=a.thread_id AND NOT x.completed
            AND NOT (a.state='running' AND x.environment_id=t.environment_id AND x.generation=t.generation
              AND jsonb_exists(v.inactive_work_ids,x.work_id)))
          AND (v.lifecycle_checked_at IS NULL OR v.lifecycle_checked_at<=clock_timestamp()-interval '1 minute')
          AND (v.deadline_idle_since IS DISTINCT FROM v.idle_since OR v.deadline_policy_revision IS DISTINCT FROM policy.revision
            OR v.delete_due_at IS NULL OR v.delete_due_at<=clock_timestamp())
        ORDER BY COALESCE(v.lifecycle_checked_at,v.idle_since),a.allocation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!row) return false;
        const policy = yield* lockThreadVmPolicy(sql, row.organizationId);
        // Match activity inspection's allocation-before-activity lock order.
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
        const deadlines = yield* writeThreadVmIdleDeadline(sql, row.allocationId, policy);
        yield* sql`UPDATE relay_thread_vm_activity SET lifecycle_checked_at=clock_timestamp() WHERE allocation_id=${row.allocationId}`;
        if (!deadlines) return true;
        const [now] = yield* sql<{
          at: string;
        }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
        if (
          DateTime.makeUnsafe(deadlines.deleteAt).epochMilliseconds >
          DateTime.makeUnsafe(now!.at).epochMilliseconds
        )
          return true;
        const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* saves
          .begin({
            operationId,
            threadId: row.threadId,
            allocationId: row.allocationId,
            actorUserId: row.ownerUserId,
            expectedGeneration: row.generation,
            reason: "idle",
          })
          .pipe(
            Effect.catchTags({
              ThreadVmFinalSaveConflict: () => Effect.void,
              ThreadNativeCheckpointConflict: () => Effect.void,
            }),
          );
        return true;
      }),
    );
  });
  return { runOne };
}
