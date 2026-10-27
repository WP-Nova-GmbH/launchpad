import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";

interface CleanupCompute {
  readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  /** The patched host returns only after every registered execution is physically stopped. */
  readonly destroy: (sandboxId: string) => Effect.Effect<void, ThreadVmComputeError>;
}

/** Only an unactivated first setup may be cancelled without a recovery save. */
export function makeThreadVmCancelledSetupCleanupWorker(
  sql: PgClient,
  compute: CleanupCompute,
  hostId: string,
) {
  const runOne = Effect.fn("relay.thread_vm.cancelled_setup_cleanup.run_one")(function* () {
    const [row] = yield* sql<{
      allocationId: string;
      operationId: string;
      computeRef: string;
      threadId: string;
      generation: number;
    }>`SELECT a.allocation_id AS "allocationId", p.operation_id AS "operationId",
      a.compute_ref AS "computeRef", a.thread_id AS "threadId", p.generation
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      WHERE c.host_id = ${hostId} AND c.state = 'started'
        AND a.state = 'deleting' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
        AND p.phase = 'created' AND p.generation = 1
        AND t.operation_id = a.allocation_id AND t.generation = 1
      ORDER BY c.position LIMIT 1`;
    if (!row) return false;
    const attempt = Effect.gen(function* () {
      const info = yield* compute.inspect(row.computeRef);
      if (
        info &&
        (info.sandboxId !== row.computeRef ||
          info.metadata["launchpad.managed"] !== "thread-vm-v1" ||
          info.metadata["launchpad.allocation_id"] !== row.allocationId ||
          !threadVmOperationMatches(info.metadata, row.operationId) ||
          info.metadata["launchpad.thread_id"] !== row.threadId ||
          info.metadata["launchpad.generation"] !== String(row.generation))
      )
        return;
      // A missing catalog entry is not proof of absence; obtain the patched host's
      // physical receipt even after an earlier stop reply was lost.
      yield* compute.destroy(row.computeRef);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [current] = yield* sql<{ computeRef: string | null; state: string }>`
          SELECT compute_ref AS "computeRef", state FROM relay_thread_vm_allocations
          WHERE allocation_id = ${row.allocationId} FOR UPDATE`;
          if (current?.state !== "deleting" || current.computeRef !== row.computeRef) return;
          const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
          WHERE thread_id = ${row.threadId} AND operation_id = ${row.allocationId}
            AND generation = 1 FOR UPDATE`;
          if (!placement) return;
          yield* sql`UPDATE relay_environment_credentials SET revoked_at = COALESCE(revoked_at,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          WHERE credential_id IN (SELECT credential_id FROM relay_thread_vm_bindings
            WHERE allocation_id = ${row.allocationId})`;
          yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE allocation_id = ${row.allocationId}`;
          yield* makeThreadVmAllocationStore(sql).confirmDeleted({
            allocationId: row.allocationId,
            computeRef: row.computeRef,
          });
        }),
      );
    });
    yield* attempt.pipe(Effect.catchTag("ThreadVmComputeError", () => Effect.void));
    return true;
  });
  return { runOne };
}
