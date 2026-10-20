import {
  confirmThreadVmCleanupIdentity,
  type ThreadVmCleanupCompute,
} from "./ThreadVmCleanupIdentity.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";

interface Compute extends ThreadVmCleanupCompute {
  /** Returns only after the patched host confirms all executions are stopped. */
  readonly destroy: (id: string) => Effect.Effect<void, ThreadVmComputeError>;
}
/** Cleanup is independent of guest availability and user access revocation.
 * A known cancelled destination or retired source never becomes serving again. */
export function makeThreadVmMoveCleanupWorker(sql: PgClient, compute: Compute, hostId: string) {
  const allocations = makeThreadVmAllocationStore(sql),
    placements = makeThreadPlacementStore(sql);
  const candidate = Effect.gen(function* () {
    const [row] = yield* sql<{
      allocationId: string;
      threadId: string;
      moveOperationId: string;
      operationId: string;
      generation: number;
      computeRef: string | null;
      role: "source" | "destination";
    }>`
      SELECT a.allocation_id AS "allocationId",a.thread_id AS "threadId",m.operation_id AS "moveOperationId",
        p.operation_id AS "operationId",p.generation,a.compute_ref AS "computeRef",
        CASE WHEN d.allocation_id=a.allocation_id THEN 'destination' ELSE 'source' END AS role
      FROM relay_thread_vm_allocations a JOIN relay_thread_vm_provisions p USING(allocation_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id=p.operation_id
        JOIN relay_thread_moves m ON m.thread_id=a.thread_id
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        LEFT JOIN relay_thread_vm_move_destinations d ON d.operation_id=m.operation_id AND d.allocation_id=a.allocation_id
        LEFT JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
      WHERE c.host_id=${hostId} AND (
        (d.allocation_id IS NOT NULL AND m.phase='aborting' AND t.operation_id=m.operation_id
          AND t.generation=m.expected_generation AND p.generation=m.expected_generation+1)
        OR (d.allocation_id IS NULL AND m.phase='completed' AND a.deleted_at IS NULL
          AND b.environment_id=m.source_environment_id AND b.generation=m.expected_generation
          AND t.generation>b.generation AND t.environment_id!=b.environment_id)
      ) ORDER BY c.position,m.operation_id LIMIT 1`;
    return row ?? null;
  });
  const lockCleanup = Effect.fnUntraced(function* (
    row: NonNullable<Effect.Success<typeof candidate>>,
    computeRef: string | null,
  ) {
    yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${row.threadId} FOR UPDATE`;
    yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
    const current = yield* allocations.get(row.allocationId);
    if (!current || current.threadId !== row.threadId || current.computeRef !== computeRef)
      return null;
    const move = yield* placements.getMove({
      threadId: row.threadId,
      operationId: row.moveOperationId,
    });
    const placement = yield* placements.get(row.threadId);
    if (
      !placement ||
      (row.role === "destination"
        ? move.phase !== "aborting" ||
          placement.operationId !== move.operationId ||
          placement.generation !== move.expectedGeneration
        : move.phase !== "completed" ||
          placement.generation <= row.generation ||
          placement.environmentId === move.sourceEnvironmentId)
    )
      return null;
    return current;
  });
  const runOne = Effect.fn("relay.thread_vm_move.cleanup")(
    function* () {
      const row = yield* candidate;
      if (!row) return false;
      const before = yield* allocations.get(row.allocationId);
      if (!before) return false;
      const admitted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* lockCleanup(row, before.computeRef);
          if (!current) return false;
          if (current.state !== "deleted") yield* allocations.requestDeletion(row.allocationId);
          return true;
        }),
      );
      if (!admitted) return true;
      // Never-created intents are cancelled by the provision worker. Ambiguous
      // creates retain their slot until that worker identifies the actual VM.
      if (before.computeRef === null && before.state !== "deleted") return true;
      if (before.state !== "deleted" && before.computeRef !== null) {
        if (
          !(yield* confirmThreadVmCleanupIdentity(sql, compute, {
            allocationId: row.allocationId,
            threadId: row.threadId,
            operationId: row.operationId,
            generation: row.generation,
            computeRef: before.computeRef,
          }))
        )
          return true;
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* lockCleanup(row, before.computeRef);
          if (!current || !["deleting", "deleted"].includes(current.state)) return;
          // Recheck admission after remote identity lookup and hold this thread's
          // placement lock through the certified stop, so cutover cannot race it.
          if (current.state !== "deleted" && current.computeRef)
            yield* compute.destroy(current.computeRef);
          yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        WHERE credential_id IN (SELECT credential_id FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId})`;
          yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE allocation_id=${row.allocationId}`;
          yield* allocations.confirmDeleted({
            allocationId: row.allocationId,
            computeRef: current.computeRef,
          });
          if (row.role === "destination")
            yield* placements.destinationRemoved({
              threadId: row.threadId,
              operationId: row.moveOperationId,
            });
        }),
      );
      return true;
    },
    Effect.catchTags({
      ThreadVmComputeError: () => Effect.succeed(true),
      E2BRestoreError: () => Effect.succeed(true),
      ThreadVmAllocationConflict: () => Effect.succeed(true),
    }),
  );
  return { runOne };
}
