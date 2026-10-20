import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";

type Inspect = (
  sandboxId: string,
  identity: {
    readonly operationId: string;
    readonly templateId: string;
    readonly environmentId: string;
    readonly scope: {
      readonly allocationId: string;
      readonly threadId: ReturnType<typeof ThreadId.make>;
      readonly repositoryId: ReturnType<typeof RelayRepositoryId.make>;
      readonly generation: number;
    };
  },
) => Effect.Effect<
  | "busy"
  | "idle"
  | "unknown"
  | { readonly activity: "idle"; readonly inactiveWorkIds: ReadonlyArray<string> },
  ThreadVmComputeError
>;

interface Candidate {
  readonly allocationId: string;
  readonly computeRef: string;
  readonly operationId: string;
  readonly templateId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly generation: number;
}

/** Only a current running binding can supply a fresh idle report. Failed reads remain unknown. */
export function makeThreadVmActivityWorker(sql: PgClient, inspect: Inspect, hostId: string) {
  const activity = makeThreadVmActivityStore(sql);
  const runOne = Effect.fn("relay.thread_vm.activity.run_one")(function* () {
    // Older inspectors could clear idleness after the guest froze. A certified
    // current pause supplies a conservative idle start without inventing a live report.
    const repaired = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [paused] = yield* sql<{
          allocationId: string;
        }>`SELECT a.allocation_id AS "allocationId"
        FROM relay_thread_vm_activity v JOIN relay_thread_vm_pauses x USING(allocation_id)
        JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        JOIN relay_thread_vm_bindings b USING(allocation_id)
        WHERE a.state='paused' AND a.deleted_at IS NULL AND v.idle_since IS NULL
          AND x.phase='completed' AND x.generation=t.generation AND b.generation=t.generation
          AND b.environment_id=t.environment_id AND b.revoked_at IS NULL AND t.operation_id IS NULL
          AND x.native_checkpoint_operation_id IS NOT NULL AND x.source_frozen_at IS NOT NULL
          AND x.source_reopened_at IS NULL AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c
            WHERE c.allocation_id=a.allocation_id AND c.host_id=${hostId} AND c.state='released')
        ORDER BY a.allocation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!paused) return false;
        // Resume and command admission use this placement -> allocation -> activity order.
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${paused.allocationId} FOR UPDATE`;
        const rows = yield* sql`UPDATE relay_thread_vm_activity v SET idle_since=x.source_frozen_at
        FROM relay_thread_vm_pauses x,relay_thread_vm_allocations a
        WHERE v.allocation_id=${paused.allocationId} AND x.allocation_id=v.allocation_id
          AND a.allocation_id=v.allocation_id AND a.state='paused' AND a.deleted_at IS NULL
          AND x.phase='completed' AND x.source_reopened_at IS NULL AND v.idle_since IS NULL
        RETURNING v.allocation_id`;
        return rows.length === 1;
      }),
    );
    if (repaired) return true;
    const [row] = yield* sql<Candidate>`SELECT a.allocation_id AS "allocationId",
      a.compute_ref AS "computeRef", a.template_id AS "templateId", p.operation_id AS "operationId",
      b.environment_id AS "environmentId", a.thread_id AS "threadId", b.repository_id AS "repositoryId", p.generation
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id AND c.state = 'started'
      JOIN relay_thread_vm_ready s ON s.allocation_id = a.allocation_id
      JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      LEFT JOIN relay_thread_vm_activity v ON v.allocation_id = a.allocation_id
      WHERE c.host_id = ${hostId} AND a.state = 'running' AND a.compute_ref IS NOT NULL
        AND a.deleted_at IS NULL AND p.phase = 'created' AND s.phase = 'ready'
        AND b.revoked_at IS NULL AND b.generation = p.generation
        AND t.environment_id = b.environment_id AND t.generation = p.generation
        AND t.operation_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
          WHERE x.allocation_id=a.allocation_id AND x.phase IN ('pending','sealed'))
        AND (v.observed_at IS NULL OR v.observed_at < clock_timestamp() - interval '1 minute')
      ORDER BY v.observed_at ASC NULLS FIRST, a.allocation_id LIMIT 1`;
    if (!row) return false;
    const revision = yield* activity
      .beginInspection(row.allocationId)
      .pipe(Effect.catchTag("ThreadVmActivityConflict", () => Effect.succeed(null)));
    if (revision === null) return true;
    const inspected = yield* inspect(row.computeRef, {
      operationId: row.operationId,
      templateId: row.templateId,
      environmentId: row.environmentId,
      scope: {
        allocationId: row.allocationId,
        threadId: ThreadId.make(row.threadId),
        repositoryId: RelayRepositoryId.make(row.repositoryId),
        generation: row.generation,
      },
    }).pipe(Effect.catchTag("ThreadVmComputeError", () => Effect.succeed("unknown" as const)));
    const unfinished = yield* sql<{
      workId: string;
    }>`SELECT work_id AS "workId" FROM relay_thread_execution_admissions
      WHERE thread_id = ${row.threadId} AND generation = ${row.generation}
        AND completed = false`;
    const queued = yield* sql`SELECT 1 FROM relay_thread_commands
      WHERE thread_id = ${row.threadId} AND receipt_json IS NULL LIMIT 1`;
    const observed = typeof inspected === "string" ? inspected : inspected.activity;
    const inactive = new Set(typeof inspected === "string" ? [] : inspected.inactiveWorkIds);
    // Match every remote reservation to the exact locally started process reported
    // by the empty guest inventory. Lost admission replies and workspace writes
    // cannot be inferred complete from the absence of a running process.
    const pending = unfinished.some(
      ({ workId }) =>
        !["provider:", "terminal:", "setup:"].some((prefix) => workId.startsWith(prefix)) ||
        !inactive.has(workId),
    );
    const result = pending || queued.length ? "busy" : observed;
    // Revocation or a move after the external read must not refresh the old allocation's activity.
    const [current] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      WHERE a.allocation_id = ${row.allocationId} AND a.compute_ref = ${row.computeRef}
        AND a.state = 'running' AND a.deleted_at IS NULL AND p.operation_id = ${row.operationId}
        AND p.generation = ${row.generation} AND b.generation = p.generation
        AND b.revoked_at IS NULL AND t.environment_id = b.environment_id
        AND t.generation = p.generation AND t.operation_id IS NULL`;
    if (current)
      yield* activity
        .finishInspection({
          allocationId: row.allocationId,
          revision,
          activity: result,
          inactiveWorkIds: result === "idle" ? [...inactive] : [],
        })
        .pipe(Effect.catchTag("ThreadVmActivityConflict", () => Effect.succeed(false)));
    return true;
  });
  return { runOne };
}
