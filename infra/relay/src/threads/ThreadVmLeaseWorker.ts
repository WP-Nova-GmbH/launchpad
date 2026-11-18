import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { SandboxInfo } from "e2b";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { makeThreadVmResumeStore, workflowVmNativePauseCheckpoint } from "./ThreadVmResumeStore.ts";
import { wakeQueuedThreadVm } from "./ThreadVmWakeAdmission.ts";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import type { MissingWorkflowVmSourceReconciler } from "./ThreadVmFinalSaveStore.ts";

interface LeaseCandidate {
  readonly resourceKind: "personal" | "organization_workflow";
  readonly allocationState: "running" | "paused";
  readonly nativePausedGeneration: number | null;
  readonly allocationId: string;
  readonly computeRef: string;
  readonly operationId: string;
  readonly templateId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly generation: number;
  readonly capacityOperationId: string;
  readonly workflowCheckpointJobId: string | null;
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

/** Renew running allocations and observe native-paused workflow VMs without waking them. */
export function makeThreadVmLeaseWorker(
  sql: PgClient,
  renew: Renew,
  hostId: string,
  compute?: {
    readonly inspect: (
      sandboxId: string,
    ) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  },
  reconcileMissingSource?: MissingWorkflowVmSourceReconciler,
) {
  const runOne = Effect.fn("relay.thread_vm.lease.run_one")(function* (
    mode: "running" | "paused" = "running",
  ) {
    const [row] = yield* sql<LeaseCandidate>`SELECT a.allocation_id AS "allocationId",
      a.compute_ref AS "computeRef", a.template_id AS "templateId", p.operation_id AS "operationId",
      a.thread_id AS "threadId", t.repository_id AS "repositoryId", p.generation,c.operation_id AS "capacityOperationId",
      a.resource_kind AS "resourceKind", a.state AS "allocationState",
      a.native_paused_generation AS "nativePausedGeneration",
      CASE WHEN a.resource_kind='organization_workflow' AND ${workflowVmNativePauseCheckpoint(sql)}
        THEN t.workflow_job_id ELSE NULL END AS "workflowCheckpointJobId"
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN LATERAL (SELECT operation_id,host_id FROM relay_thread_vm_capacity c
        WHERE c.allocation_id=a.allocation_id AND c.host_id=${hostId} AND c.compute_ref=a.compute_ref
          AND ((${mode === "running"} AND a.state='running' AND c.state='started')
            OR (${mode === "paused" && compute !== undefined} AND a.state='paused'
              AND a.resource_kind='organization_workflow' AND c.state IN ('released','waiting','reserved')))
        ORDER BY position DESC LIMIT 1) c ON true
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      LEFT JOIN relay_thread_vm_leases l ON l.allocation_id = a.allocation_id
      WHERE a.runtime_protocol='native-v1' AND c.host_id = ${hostId}
        AND (a.resource_kind='personal' OR (a.resource_kind='organization_workflow'
          AND p.workflow_snapshot IS NOT NULL AND t.audience='repository' AND t.generation=p.generation))
        AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
        AND p.phase = 'created'
        AND (a.state='paused' OR l.renewed_at IS NULL OR l.renewed_at < clock_timestamp() - interval '4 minutes')
        AND (l.attempted_at IS NULL OR l.attempted_at < clock_timestamp() - interval '1 minute')
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
          WHERE x.allocation_id = a.allocation_id AND x.generation = p.generation
            AND (x.phase = 'sealed' OR (x.phase = 'pending'
              AND (x.native_checkpoint_operation_id IS NOT NULL OR x.workflow_checkpoint IS NOT NULL)
              AND x.source_sequence IS NOT NULL AND x.source_frozen_at IS NOT NULL
              AND x.boot_id IS NOT NULL)))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
          WHERE r.allocation_id = a.allocation_id AND (r.phase='resuming'
            OR (r.phase='waiting' AND (${mode === "running"} OR r.connect_claim_id IS NOT NULL))))
      ORDER BY l.attempted_at ASC NULLS FIRST, a.allocation_id LIMIT 1`;
    if (!row) return false;
    const claimed = yield* sql`INSERT INTO relay_thread_vm_leases (allocation_id, attempted_at)
      VALUES (${row.allocationId}, clock_timestamp()) ON CONFLICT (allocation_id)
      DO UPDATE SET attempted_at = clock_timestamp()
      WHERE relay_thread_vm_leases.attempted_at IS NULL
        OR relay_thread_vm_leases.attempted_at < clock_timestamp() - interval '1 minute'
      RETURNING allocation_id`;
    if (!claimed.length) return true;
    const renewed =
      row.allocationState === "running" &&
      (yield* renew(row.computeRef, {
        operationId: row.operationId,
        templateId: row.templateId,
        scope: {
          allocationId: row.allocationId,
          threadId: ThreadId.make(row.threadId),
          repositoryId: RelayRepositoryId.make(row.repositoryId),
          generation: row.generation,
        },
      }).pipe(Effect.isSuccess));
    if (!renewed && compute) {
      // Native paused state releases power capacity, without claiming a sealed
      // source or an independently recoverable backup. GET never wakes it.
      const info = yield* compute.inspect(row.computeRef).pipe(Effect.option);
      if (info._tag === "Some") {
        const sandbox = info.value;
        const paused =
          sandbox?.state === "paused" &&
          sandbox.sandboxId === row.computeRef &&
          sandbox.templateId === row.templateId.split(":")[0] &&
          sandbox.network?.allowPublicTraffic === false &&
          sandbox.lifecycle?.autoResume === false &&
          sandbox.metadata["launchpad.managed"] === "thread-vm-v1" &&
          sandbox.metadata["launchpad.allocation_id"] === row.allocationId &&
          threadVmOperationMatches(sandbox.metadata, row.operationId) &&
          sandbox.metadata["launchpad.thread_id"] === row.threadId &&
          sandbox.metadata["launchpad.generation"] === String(row.generation);
        if (paused && row.workflowCheckpointJobId) {
          if (
            row.allocationState === "running" &&
            (yield* makeThreadVmResumeStore(sql).reconcileNativePause({
              ...row,
              hostId,
              workflowJobId: row.workflowCheckpointJobId,
            }))
          )
            yield* wakeWorkflows();
        } else if (row.resourceKind === "organization_workflow" && sandbox === null) {
          if (
            reconcileMissingSource &&
            (yield* reconcileMissingSource({
              ...row,
              hostId,
              provisionOperationId: row.operationId,
            }))
          )
            yield* wakeWorkflows();
        } else if (row.resourceKind === "organization_workflow" && paused) {
          if (
            paused &&
            row.allocationState === "paused" &&
            row.nativePausedGeneration === row.generation
          )
            return true;
          const changed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [allocation] = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
                WHERE allocation_id=${row.allocationId} AND resource_kind='organization_workflow'
                  AND compute_ref=${row.computeRef} AND state=${row.allocationState}
                  AND deleted_at IS NULL FOR UPDATE`;
              if (!allocation) return false;
              const [capacity] = yield* sql`UPDATE relay_thread_vm_capacity c SET state='released'
                WHERE c.operation_id=${row.capacityOperationId} AND c.allocation_id=${row.allocationId}
                  AND c.compute_ref=${row.computeRef} AND c.host_id=${hostId}
                  AND c.state=${row.allocationState === "running" ? "started" : "released"}
                  AND EXISTS (SELECT 1 FROM relay_thread_vm_provisions p JOIN relay_thread_placements t
                    ON t.thread_id=${row.threadId} AND t.generation=p.generation
                      AND t.audience='repository' AND t.repository_id=${row.repositoryId}
                    WHERE p.allocation_id=c.allocation_id AND p.operation_id=${row.operationId}
                      AND p.generation=${row.generation} AND p.workflow_snapshot IS NOT NULL)
                RETURNING c.operation_id`;
              if (!capacity) return false;
              yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',native_paused_generation=${row.generation}
                WHERE allocation_id=${row.allocationId}`;
              return true;
            }),
          );
          if (changed) yield* wakeWorkflows();
        } else if (paused)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (yield* makeThreadVmResumeStore(sql).reconcileNativePause({ ...row, hostId }))
                yield* wakeQueuedThreadVm(sql, row.threadId);
            }),
          );
      }
    }
    if (renewed)
      yield* sql`UPDATE relay_thread_vm_leases SET renewed_at = clock_timestamp()
      WHERE allocation_id = ${row.allocationId} AND EXISTS (
        SELECT 1 FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
        JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id
        WHERE a.runtime_protocol='native-v1' AND a.resource_kind=${row.resourceKind} AND a.allocation_id = ${row.allocationId} AND a.compute_ref = ${row.computeRef}
          AND a.state = 'running' AND a.deleted_at IS NULL AND p.phase = 'created'
          AND p.operation_id = ${row.operationId} AND p.generation = ${row.generation}
          AND c.host_id = ${hostId} AND c.state = 'started')`;
    return true;
  });
  return { runOne };
}
