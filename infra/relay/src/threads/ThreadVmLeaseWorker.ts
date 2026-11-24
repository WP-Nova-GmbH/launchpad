import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { SandboxInfo } from "e2b";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import {
  makeThreadVmResumeStore,
  workflowVmFinishedReclaim,
  workflowVmNativePauseCheckpoint,
} from "./ThreadVmResumeStore.ts";
import { wakeQueuedThreadVm } from "./ThreadVmWakeAdmission.ts";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import type { MissingWorkflowVmSourceReconciler } from "./ThreadVmFinalSaveStore.ts";
import type { LinearWorkflowConfiguration } from "../Config.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";

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
  pauseOnTimeout?: boolean,
) => Effect.Effect<void | "pause_scheduled", ThreadVmComputeError>;

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
  finishedWorkflows?: {
    readonly linear?: Pick<LinearWorkflowConfiguration, "clientId" | "organizationId"> | undefined;
  },
) {
  const runOne = Effect.fn("relay.thread_vm.lease.run_one")(function* (
    mode: "running" | "paused" = "running",
  ) {
    const [fallback] =
      mode === "running" && compute
        ? yield* sql<{ allocationId: string }>`SELECT a.allocation_id AS "allocationId"
          FROM relay_workflow_vm_follow_ups f JOIN relay_thread_vm_pauses x ON x.operation_id=f.reclaim_operation_id
          JOIN relay_thread_vm_allocations a ON a.allocation_id=x.allocation_id
          JOIN relay_thread_vm_capacity c ON c.allocation_id=a.allocation_id
          JOIN relay_thread_placements t ON t.thread_id=a.thread_id AND t.workflow_job_id=f.job_id
          LEFT JOIN relay_thread_vm_leases l ON l.allocation_id=a.allocation_id
          WHERE f.reclaim_fallback AND x.phase='cancelled' AND x.source_reopened_at IS NOT NULL
            AND a.state='running' AND a.deleted_at IS NULL AND c.host_id=${hostId} AND c.state='started'
            AND t.operation_id IS NULL AND x.generation=t.generation
            AND (l.attempted_at IS NULL OR l.attempted_at<clock_timestamp()-interval '1 minute')
          ORDER BY l.attempted_at NULLS FIRST,a.allocation_id LIMIT 1`
        : [];
    const idleFinishedVm =
      fallback?.allocationId ??
      (mode === "running" && compute && finishedWorkflows
        ? yield* makeThreadVmCapacityStore(sql).finishedVmDueToPause(
            hostId,
            finishedWorkflows.linear,
          )
        : null);
    const [row] = yield* sql<LeaseCandidate>`SELECT a.allocation_id AS "allocationId",
      a.compute_ref AS "computeRef", a.template_id AS "templateId", p.operation_id AS "operationId",
      a.thread_id AS "threadId", t.repository_id AS "repositoryId", p.generation,c.operation_id AS "capacityOperationId",
      a.resource_kind AS "resourceKind", a.state AS "allocationState",
      a.native_paused_generation AS "nativePausedGeneration",
      CASE WHEN a.resource_kind='organization_workflow' AND
        (${workflowVmNativePauseCheckpoint(sql)} OR ${workflowVmFinishedReclaim(sql)})
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
        AND (a.state='paused' OR a.allocation_id=${idleFinishedVm ?? ""} OR l.renewed_at IS NULL
          OR l.renewed_at < clock_timestamp() - interval '4 minutes')
        AND (l.attempted_at IS NULL OR l.attempted_at < clock_timestamp() - interval '1 minute')
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
          WHERE x.allocation_id = a.allocation_id AND x.generation = p.generation
            AND (x.phase = 'sealed' OR (x.phase = 'pending'
              AND (x.native_checkpoint_operation_id IS NOT NULL OR x.workflow_checkpoint IS NOT NULL)
              AND x.source_sequence IS NOT NULL AND x.source_frozen_at IS NOT NULL
              AND x.boot_id IS NOT NULL
              AND (x.workflow_checkpoint IS NULL OR NOT (x.workflow_checkpoint ? 'finishedWorkspaceRevision')
                OR EXISTS(SELECT 1 FROM relay_thread_vm_backups z WHERE z.operation_id=x.backup_operation_id
                  AND z.phase='verified')))))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
          WHERE r.allocation_id = a.allocation_id AND (r.phase='resuming'
            OR (r.phase='waiting' AND (${mode === "running"} OR r.connect_claim_id IS NOT NULL))))
      ORDER BY (a.allocation_id=${idleFinishedVm ?? ""}) DESC,l.attempted_at ASC NULLS FIRST,a.allocation_id LIMIT 1`;
    if (!row) return false;
    const retiring = row.allocationId === idleFinishedVm;
    // Reconcile a short or uncertain expiry on the next sweep, even if
    // inspecting the now-stopped guest clears the idle observation.
    const claimed = yield* sql`INSERT INTO relay_thread_vm_leases (allocation_id, attempted_at)
      VALUES (${row.allocationId}, clock_timestamp()) ON CONFLICT (allocation_id)
      DO UPDATE SET attempted_at = clock_timestamp(),
        renewed_at = CASE WHEN ${retiring} THEN NULL ELSE relay_thread_vm_leases.renewed_at END
      WHERE relay_thread_vm_leases.attempted_at IS NULL
        OR relay_thread_vm_leases.attempted_at < clock_timestamp() - interval '1 minute'
      RETURNING allocation_id`;
    if (!claimed.length) return true;
    const identity = {
      operationId: row.operationId,
      templateId: row.templateId,
      scope: {
        allocationId: row.allocationId,
        threadId: ThreadId.make(row.threadId),
        repositoryId: RelayRepositoryId.make(row.repositoryId),
        generation: row.generation,
      },
    };
    const renewal =
      row.allocationState === "running"
        ? yield* (
            retiring ? renew(row.computeRef, identity, true) : renew(row.computeRef, identity)
          ).pipe(Effect.option)
        : Option.none();
    const renewed = Option.isSome(renewal) && renewal.value !== "pause_scheduled";
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
              yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${row.threadId} FOR UPDATE`;
              const [allocation] =
                yield* sql`SELECT a.allocation_id FROM relay_thread_vm_allocations a
                JOIN relay_thread_placements t USING(thread_id)
                WHERE a.allocation_id=${row.allocationId} AND a.resource_kind='organization_workflow'
                  AND a.compute_ref=${row.computeRef} AND a.state=${row.allocationState}
                  AND a.deleted_at IS NULL AND NOT ${workflowVmFinishedReclaim(sql)} FOR UPDATE OF a`;
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
