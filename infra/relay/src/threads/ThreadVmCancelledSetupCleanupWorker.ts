import { confirmThreadVmCleanupIdentity } from "./ThreadVmCleanupIdentity.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import {
  makeThreadVmAllocationStore,
  type ThreadVmResourceKind,
} from "./ThreadVmAllocationStore.ts";

interface CleanupCompute {
  readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  /** Success acknowledges native DELETE of this known sandbox ID. */
  readonly destroy: (sandboxId: string) => Effect.Effect<void, ThreadVmComputeError>;
}

/** Tear down a known VM after setup failure or an authorized offline cancellation. */
export function makeThreadVmCancelledSetupCleanupWorker(
  sql: PgClient,
  compute: CleanupCompute,
  hostId: string,
) {
  const runOne = Effect.fn("relay.thread_vm.cancelled_setup_cleanup.run_one")(function* () {
    // Schedule the next attempt before contacting compute so an interrupted sweep also rotates.
    const [row] = yield* sql<{
      allocationId: string;
      operationId: string;
      computeRef: string;
      threadId: string;
      generation: number;
      resourceKind: ThreadVmResourceKind;
    }>`WITH candidate AS (
      SELECT a.allocation_id AS "allocationId", p.operation_id AS "operationId",
      a.compute_ref AS "computeRef", a.thread_id AS "threadId", p.generation, a.resource_kind AS "resourceKind"
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      WHERE a.runtime_protocol='native-v1' AND c.host_id = ${hostId} AND c.allocation_id=a.allocation_id
        AND a.state = 'deleting' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
        AND p.phase = 'created' AND p.generation = 1
        AND p.retry_at <= clock_timestamp() AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
        AND t.generation = 1 AND ((a.resource_kind='personal' AND c.state='started' AND t.operation_id=a.allocation_id)
          OR (a.resource_kind='organization_workflow' AND p.workflow_snapshot IS NOT NULL
            AND c.state IN ('started','released') AND c.compute_ref=a.compute_ref
            AND (t.operation_id=p.operation_id OR t.operation_id IS NULL)
            AND EXISTS (SELECT 1 FROM relay_workflow_jobs j WHERE j.job_id=t.workflow_job_id
              AND j.organization_id=t.organization_id AND j.repository_id=t.repository_id
              AND j.record#>>'{runtime,threadId}'=t.thread_id
              AND (
                (j.status='cancelling' AND j.record->>'vmCancellationConfirmed'='true'
                  AND (j.record->>'startAttempted'='false'
                    OR (a.native_paused_generation=p.generation AND c.state='released')))
                OR (j.record->>'startAttempted'='false' AND j.status IN ('preparing','cancelling')
                  AND t.operation_id=p.operation_id
                  AND EXISTS (SELECT 1 FROM relay_thread_vm_setups s
                    WHERE s.allocation_id=a.allocation_id AND s.environment_id=t.environment_id AND s.phase='failed'))
              ))))
      ORDER BY p.retry_at, c.position LIMIT 1 FOR UPDATE OF p SKIP LOCKED
    )
    UPDATE relay_thread_vm_provisions p SET retry_at = clock_timestamp() + interval '2 minutes'
    FROM candidate WHERE p.allocation_id = candidate."allocationId" RETURNING candidate.*`;
    if (!row) return false;
    const attempt = Effect.gen(function* () {
      if (!(yield* confirmThreadVmCleanupIdentity(sql, compute, row))) return;
      // A missing catalog entry still requires exact native DELETE reconciliation,
      // including after a previous acknowledgement was lost.
      yield* compute.destroy(row.computeRef);
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
          WHERE thread_id = ${row.threadId} AND generation = 1 AND
            (operation_id = ${row.operationId} OR (${row.resourceKind === "organization_workflow"} AND operation_id IS NULL))
          FOR UPDATE`;
          if (!placement) return false;
          const [current] = yield* sql<{ computeRef: string | null; state: string }>`
          SELECT compute_ref AS "computeRef", state FROM relay_thread_vm_allocations
          WHERE allocation_id = ${row.allocationId} FOR UPDATE`;
          if (current?.state !== "deleting" || current.computeRef !== row.computeRef) return false;
          yield* sql`UPDATE relay_environment_credentials SET revoked_at = COALESCE(revoked_at,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          WHERE credential_id IN (SELECT credential_id FROM relay_thread_vm_bindings
            WHERE allocation_id = ${row.allocationId})`;
          yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE allocation_id = ${row.allocationId}`;
          yield* makeThreadVmAllocationStore(sql).confirmDeleted({
            allocationId: row.allocationId,
            computeRef: row.computeRef,
            resourceKind: row.resourceKind,
          });
          return true;
        }),
      );
      if (deleted && row.resourceKind === "organization_workflow") yield* wakeWorkflows();
    });
    yield* attempt.pipe(Effect.catchTag("ThreadVmComputeError", () => Effect.void));
    return true;
  });
  return { runOne };
}
