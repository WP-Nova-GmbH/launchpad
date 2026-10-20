import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { SandboxInfo } from "e2b";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { wakeQueuedThreadVm } from "./ThreadVmWakeAdmission.ts";

interface LeaseCandidate {
  readonly allocationId: string;
  readonly computeRef: string;
  readonly operationId: string;
  readonly templateId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly generation: number;
}
type Renew = (
  sandboxId: string,
  identity: {
    readonly operationId: string;
    readonly templateId: string;
    readonly scope: {
      readonly allocationId: string;
      readonly threadId: ReturnType<typeof ThreadId.make>;
      readonly repositoryId: ReturnType<typeof RelayRepositoryId.make>;
      readonly generation: number;
    };
  },
) => Effect.Effect<void, ThreadVmComputeError>;

/** Renew every admitted running allocation, including quarantined setup/restore.
 * A lease preserves compute; it grants no execution or access and never wakes it. */
export function makeThreadVmLeaseWorker(
  sql: PgClient,
  renew: Renew,
  hostId: string,
  compute?: {
    readonly pausedSnapshotsSupported: Effect.Effect<boolean>;
    readonly inspect: (
      sandboxId: string,
    ) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  },
) {
  const runOne = Effect.fn("relay.thread_vm.lease.run_one")(function* () {
    const [row] = yield* sql<LeaseCandidate>`SELECT a.allocation_id AS "allocationId",
      a.compute_ref AS "computeRef", a.template_id AS "templateId", p.operation_id AS "operationId",
      a.thread_id AS "threadId", t.repository_id AS "repositoryId", p.generation
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id AND c.state = 'started'
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      LEFT JOIN relay_thread_vm_leases l ON l.allocation_id = a.allocation_id
      WHERE c.host_id = ${hostId} AND c.state = 'started'
        AND a.state = 'running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
        AND p.phase = 'created'
        AND (l.renewed_at IS NULL OR l.renewed_at < clock_timestamp() - interval '4 minutes')
        AND (l.attempted_at IS NULL OR l.attempted_at < clock_timestamp() - interval '1 minute')
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
          WHERE x.allocation_id = a.allocation_id AND x.generation = p.generation
            AND (x.phase = 'sealed' OR (x.phase = 'pending'
              AND x.native_checkpoint_operation_id IS NOT NULL
              AND x.source_sequence IS NOT NULL AND x.source_frozen_at IS NOT NULL
              AND x.boot_id IS NOT NULL)))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
          WHERE r.allocation_id = a.allocation_id AND r.phase IN ('waiting','resuming'))
      ORDER BY l.attempted_at ASC NULLS FIRST, a.allocation_id LIMIT 1`;
    if (!row) return false;
    const claimed = yield* sql`INSERT INTO relay_thread_vm_leases (allocation_id, attempted_at)
      VALUES (${row.allocationId}, clock_timestamp()) ON CONFLICT (allocation_id)
      DO UPDATE SET attempted_at = clock_timestamp()
      WHERE relay_thread_vm_leases.attempted_at IS NULL
        OR relay_thread_vm_leases.attempted_at < clock_timestamp() - interval '1 minute'
      RETURNING allocation_id`;
    if (!claimed.length) return true;
    const renewed = yield* renew(row.computeRef, {
      operationId: row.operationId,
      templateId: row.templateId,
      scope: {
        allocationId: row.allocationId,
        threadId: ThreadId.make(row.threadId),
        repositoryId: RelayRepositoryId.make(row.repositoryId),
        generation: row.generation,
      },
    }).pipe(Effect.option);
    if (renewed._tag === "None" && compute && (yield* compute.pausedSnapshotsSupported)) {
      // Certified GET refuses an ambiguous/memory pause (409). It never wakes
      // compute and proves all registered old executions stopped before paused.
      const info = yield* compute.inspect(row.computeRef).pipe(Effect.option);
      if (info._tag === "Some" && info.value?.state === "paused") {
        const paused = info.value;
        if (
          paused.sandboxId === row.computeRef &&
          paused.metadata["launchpad.managed"] === "thread-vm-v1" &&
          paused.metadata["launchpad.allocation_id"] === row.allocationId &&
          threadVmOperationMatches(paused.metadata, row.operationId) &&
          paused.metadata["launchpad.thread_id"] === row.threadId &&
          paused.metadata["launchpad.generation"] === String(row.generation)
        )
          if (yield* makeThreadVmResumeStore(sql).reconcileNativePause({ ...row, hostId }))
            yield* wakeQueuedThreadVm(sql, row.threadId);
      }
    }
    if (renewed._tag === "Some")
      yield* sql`UPDATE relay_thread_vm_leases SET renewed_at = clock_timestamp()
      WHERE allocation_id = ${row.allocationId} AND EXISTS (
        SELECT 1 FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
        JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id
        WHERE a.allocation_id = ${row.allocationId} AND a.compute_ref = ${row.computeRef}
          AND a.state = 'running' AND a.deleted_at IS NULL AND p.phase = 'created'
          AND p.operation_id = ${row.operationId} AND p.generation = ${row.generation}
          AND c.host_id = ${hostId} AND c.state = 'started')`;
    return true;
  });
  return { runOne };
}
