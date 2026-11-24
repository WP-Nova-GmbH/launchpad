import type { PgClient } from "@effect/sql-pg/PgClient";
import { DEFAULT_WORKFLOW_VM_LIMIT } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { LinearWorkflowConfiguration } from "../Config.ts";
import { lockWorkflowVmOrganization } from "./WorkflowVmPolicyLock.ts";
import { hasWorkflowVmFollowUpRequest } from "./WorkflowVmFollowUpState.ts";

export class ThreadVmCapacityConflict extends Schema.TaggedError<ThreadVmCapacityConflict>()(
  "ThreadVmCapacityConflict",
  { message: Schema.String },
) {}
interface CapacityRequest {
  readonly operationId: string;
  readonly allocationId: string;
  readonly hostId: string;
  readonly kind: "create" | "resume";
  readonly state: "waiting" | "reserved" | "started" | "released";
  readonly computeRef: string | null;
}
interface OrderedCapacityAdmission {
  readonly workflowEnabled: boolean;
  readonly workflowOperationId?: string;
  readonly linearWorkflow?: Pick<LinearWorkflowConfiguration, "clientId" | "organizationId">;
}
const conflict = (message: string) => new ThreadVmCapacityConflict({ message });

/** SQL alias x is the original Codex connection. */
export const workflowVmCodexConnectionReady = (sql: PgClient) => sql`x.status='connected'
  AND (x.refresh_started_at IS NULL OR x.refresh_started_at::timestamptz>clock_timestamp()-interval '6 seconds')`;

// Uses c for the capacity request and a for its allocation, like ordered admission.
const eligibleWorkflowWaiter = (
  sql: PgClient,
  linear: OrderedCapacityAdmission["linearWorkflow"],
) =>
  sql`EXISTS (
  SELECT 1 FROM relay_thread_placements t JOIN relay_workflow_jobs j
    ON j.job_id=t.workflow_job_id AND j.organization_id=t.organization_id AND j.repository_id=t.repository_id
  JOIN relay_codex_vm_connections x ON x.organization_id=j.organization_id
    AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}' AND ${workflowVmCodexConnectionReady(sql)}
  LEFT JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
  WHERE t.thread_id=a.thread_id AND t.organization_id=a.organization_id AND (
  ${hasWorkflowVmFollowUpRequest(sql)}
  OR
  (t.operation_id=c.operation_id AND
    (c.kind<>'create' OR (j.record#>>'{origin,kind}') IS DISTINCT FROM 'automation' OR ${
      linear
        ? sql`EXISTS (
          SELECT 1 FROM relay_workflow_admissions admitted
          JOIN relay_workflow_repository_grants grant_row ON grant_row.grant_id=admitted.grant_id
            AND grant_row.repository_id=admitted.repository_id AND grant_row.organization_id=admitted.organization_id
            AND grant_row.connection_id=admitted.connection_id AND grant_row.generation=admitted.grant_generation
            AND NOT grant_row.revoked
          JOIN relay_workflow_connections source ON source.connection_id=admitted.connection_id
            AND source.organization_id=admitted.organization_id AND source.status='connected'
            AND source.payload_sealed IS NOT NULL
          JOIN relay_workflow_authorizations auth ON auth.organization_id=source.organization_id
            AND auth.application_id=source.application_id AND auth.exchange_lease_until IS NULL
          WHERE admitted.job_id=j.job_id AND admitted.workflow_id=j.record->>'workflowId'
            AND admitted.repository_id=j.repository_id AND admitted.organization_id=j.organization_id
            AND admitted.occurrence_id=j.record#>>'{origin,occurrenceId}'
            AND source.organization_id=${linear.organizationId}
            AND source.application_id=${linear.clientId}
            AND source.application_id=j.record#>>'{origin,source,applicationId}'
            AND source.workspace_id=j.record#>>'{origin,source,workspaceId}'
            AND source.connection_id=j.record#>>'{origin,source,connectionId}'
            AND grant_row.grant_id=j.record#>>'{origin,source,grantId}'
        )`
        : sql`false`
    })
    AND j.pending_control IS NULL AND ((j.status='queued' AND p.allocation_id IS NULL
      AND j.record#>>'{queueReason,code}'='vm_waiting_capacity') OR
      (j.status='preparing' AND p.phase='pending' AND p.workflow_snapshot IS NOT NULL
        AND p.retry_at<=clock_timestamp())))
  OR (t.audience='repository' AND j.pending_control->>'responseId'=c.operation_id
    AND j.pending_control->'checkpointDispatch' IS NULL
    AND ((((j.status='awaiting_review' AND j.pending_control#>>'{response,operation}' IN ('approve','request_changes'))
      OR (j.status='awaiting_input' AND j.pending_control#>>'{response,operation}'='input'))
      AND j.record#>>'{progress,checkpoint,checkpointId}'=j.pending_control#>>'{response,checkpointId}')
      OR (c.kind='create' AND j.status='paused'
        AND j.pending_control#>>'{response,operation}'='retry_action'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.record#>'{progress,actions}') action
          WHERE action->>'actionId'=j.pending_control#>>'{response,actionId}'
            AND action->>'stepId'=j.record#>>'{progress,stepId}'
            AND action->>'generation'=j.record#>>'{progress,generation}'
            AND action->>'retryable'='true')))
    AND j.record#>>'{progress,status}'=j.status
    AND j.record#>>'{progress,revision}'=j.pending_control#>>'{response,expectedRevision}'
    AND ((c.kind='resume' AND EXISTS (
      SELECT 1 FROM relay_thread_vm_resumes q WHERE q.operation_id=c.operation_id
        AND q.allocation_id=a.allocation_id AND q.generation=t.generation AND q.phase='waiting'
        AND q.retry_at<=clock_timestamp()))
      OR (c.kind='create' AND t.operation_id=c.operation_id AND EXISTS (
        SELECT 1 FROM relay_thread_vm_restores q WHERE q.operation_id=c.operation_id
          AND q.thread_id=t.thread_id AND q.allocation_id=a.allocation_id
          AND q.serving_requested AND q.host_id=c.host_id
          AND ((q.generation=t.generation AND q.phase IN ('pending','preparing','prepared'))
            OR (q.phase='committed' AND q.committed_at IS NOT NULL AND q.target_generation=t.generation
              AND a.compute_ref IS NULL AND c.compute_ref IS NULL
              AND q.boot_create_started_at IS NULL AND q.boot_receipt IS NULL
              AND q.boot_recovery_started_at IS NULL AND q.boot_ingress_recovery_claim_id IS NULL))))))))`;

/** Use inside a transaction that is about to authorize work for the pinned connection. */
export const lockReadyWorkflowVmCodexConnection = Effect.fnUntraced(function* (
  sql: PgClient,
  organizationId: string,
  connectionId: string | null,
) {
  const [connection] = yield* sql`SELECT 1 FROM relay_codex_vm_connections x
    WHERE x.organization_id=${organizationId} AND x.connection_id=${connectionId}
      AND ${workflowVmCodexConnectionReady(sql)} FOR SHARE`;
  return connection !== undefined;
});

/** Internal operator/worker API. A lost create or expired claim keeps its physical capacity. */
export function makeThreadVmCapacityStore(sql: PgClient) {
  const get = Effect.fn("relay.vm_capacity.get")(function* (operationId: string) {
    const [row] =
      yield* sql<CapacityRequest>`SELECT operation_id AS "operationId", allocation_id AS "allocationId",
      host_id AS "hostId", kind, state, compute_ref AS "computeRef"
      FROM relay_thread_vm_capacity WHERE operation_id = ${operationId}`;
    return row ?? null;
  });
  const configure = Effect.fn("relay.vm_capacity.configure")(function* (
    hostId: string,
    maxRunningVms: number,
  ) {
    if (!hostId || !Number.isSafeInteger(maxRunningVms) || maxRunningVms < 1)
      return yield* conflict("Host capacity must be a positive whole number");
    yield* sql`INSERT INTO relay_thread_vm_hosts (host_id, max_running_vms) VALUES (${hostId}, ${maxRunningVms})
      ON CONFLICT (host_id) DO UPDATE SET max_running_vms = excluded.max_running_vms
      WHERE relay_thread_vm_hosts.max_running_vms != excluded.max_running_vms`;
  });
  const request = Effect.fn("relay.vm_capacity.request")(function* (
    input: Pick<CapacityRequest, "operationId" | "allocationId" | "hostId" | "kind">,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [allocation] = yield* sql<{
          state: string;
          computeRef: string | null;
        }>`SELECT state, compute_ref AS "computeRef" FROM relay_thread_vm_allocations
        WHERE allocation_id = ${input.allocationId} AND runtime_protocol='native-v1' FOR UPDATE`;
        const prior = yield* get(input.operationId);
        if (prior) {
          if (
            prior.allocationId !== input.allocationId ||
            prior.hostId !== input.hostId ||
            prior.kind !== input.kind
          )
            return yield* conflict("Capacity operation identity changed");
          return prior;
        }
        if (allocation?.state !== (input.kind === "create" ? "creating" : "paused"))
          return yield* conflict("Allocation does not accept this capacity request");
        const hosts =
          yield* sql`SELECT host_id FROM relay_thread_vm_hosts WHERE host_id = ${input.hostId}`;
        if (!hosts.length) return yield* conflict("Compute host capacity has not been configured");
        const existing = yield* sql`SELECT operation_id FROM relay_thread_vm_capacity
        WHERE allocation_id = ${input.allocationId} AND state != 'released'`;
        if (existing.length) return yield* conflict("Allocation already has a capacity operation");
        if (input.kind === "resume") {
          const [previous] = yield* sql<{
            hostId: string;
          }>`SELECT host_id AS "hostId" FROM relay_thread_vm_capacity
            WHERE allocation_id = ${input.allocationId} ORDER BY position DESC LIMIT 1`;
          if (!previous || previous.hostId !== input.hostId || !allocation.computeRef)
            return yield* conflict(
              "Resume must use the allocation's existing host and compute identity",
            );
        }
        yield* sql`INSERT INTO relay_thread_vm_capacity (operation_id, allocation_id, host_id, kind, compute_ref)
        VALUES (${input.operationId}, ${input.allocationId}, ${input.hostId}, ${input.kind}, ${input.kind === "resume" ? allocation.computeRef : null})`;
        return (yield* get(input.operationId))!;
      }),
    );
  });
  /** Cheap preflight only. Admission repeats both limits under their locks. */
  const hasWorkflowSlot = Effect.fnUntraced(function* (hostId: string, organizationId: string) {
    const [capacity] = yield* sql<{ available: boolean }>`SELECT EXISTS (
      SELECT 1 FROM relay_thread_vm_hosts h WHERE h.host_id=${hostId}
        AND h.max_running_vms>(SELECT count(*) FROM relay_thread_vm_capacity c
          WHERE c.host_id=h.host_id AND c.state IN ('reserved','started'))
    ) AND COALESCE((SELECT max_running_workflow_vms FROM relay_thread_vm_policies
      WHERE organization_id=${organizationId}),${DEFAULT_WORKFLOW_VM_LIMIT}) > (
        SELECT count(*) FROM relay_thread_vm_capacity c JOIN relay_thread_vm_allocations a USING(allocation_id)
        WHERE a.organization_id=${organizationId} AND a.resource_kind='organization_workflow'
          AND c.state IN ('reserved','started')
    ) AS available`;
    return capacity?.available === true;
  });
  const finishedVmDueToPause = Effect.fn("relay.vm_capacity.finished_vm_due_to_pause")(function* (
    hostId: string,
    linear: OrderedCapacityAdmission["linearWorkflow"],
    requireTerminalCheckpoint = false,
  ) {
    const [candidate] = yield* sql<{ allocationId: string }>`WITH charged AS (
      SELECT c.host_id,a.organization_id,a.resource_kind FROM relay_thread_vm_capacity c
      JOIN relay_thread_vm_allocations a USING(allocation_id)
      WHERE c.state IN ('reserved','started')
    ), org_usage AS (
      SELECT organization_id,count(*) AS used FROM charged
      WHERE resource_kind='organization_workflow' GROUP BY organization_id
    ), waiting AS (
      SELECT a.organization_id,COALESCE(u.used,0) AS used,
        COALESCE(policy.max_running_workflow_vms,${DEFAULT_WORKFLOW_VM_LIMIT}) AS vm_limit
      FROM relay_thread_vm_capacity c JOIN relay_thread_vm_allocations a USING(allocation_id)
      LEFT JOIN org_usage u USING(organization_id)
      LEFT JOIN relay_thread_vm_policies policy USING(organization_id)
      WHERE c.host_id=${hostId} AND c.state='waiting' AND a.state IN ('creating','paused')
        AND a.runtime_protocol='native-v1' AND a.resource_kind='organization_workflow'
        AND a.deleted_at IS NULL AND ${eligibleWorkflowWaiter(sql, linear)}
    ), finished AS (
      SELECT a.allocation_id,a.organization_id,policy.pause_after_idle_minutes,v.activity,v.observed_at,
        t.thread_id,t.environment_id,t.generation,v.inactive_work_ids,
        v.idle_since AS observed_idle_since,
        CASE WHEN l.renewed_at IS NULL THEN l.attempted_at END AS awaiting_lease_confirmation,
        GREATEST(v.idle_since,(j.record->>'updatedAt')::timestamptz) AS idle_since
      FROM relay_thread_vm_capacity c JOIN relay_thread_vm_allocations a USING(allocation_id)
      JOIN relay_thread_vm_activity v USING(allocation_id)
      JOIN relay_thread_vm_bindings b USING(allocation_id)
      JOIN relay_thread_vm_ready ready ON ready.allocation_id=a.allocation_id
        AND ready.environment_id=b.environment_id AND ready.generation=b.generation
      JOIN relay_thread_vm_provisions provision ON provision.allocation_id=a.allocation_id
      LEFT JOIN relay_thread_vm_leases l ON l.allocation_id=a.allocation_id
      JOIN relay_thread_vm_policies policy ON policy.organization_id=a.organization_id
      JOIN relay_thread_placements t ON t.thread_id=a.thread_id
      JOIN relay_workflow_jobs j ON j.job_id=t.workflow_job_id AND j.organization_id=t.organization_id
        AND j.repository_id=t.repository_id
      LEFT JOIN relay_workflow_vm_follow_ups f ON f.job_id=j.job_id
      WHERE c.host_id=${hostId} AND c.state='started' AND c.compute_ref=a.compute_ref
        AND a.state='running' AND a.deleted_at IS NULL
        AND a.runtime_protocol='native-v1' AND a.resource_kind='organization_workflow'
        AND t.audience='repository' AND t.operation_id IS NULL AND t.generation=b.generation
        AND t.environment_id=b.environment_id AND b.revoked_at IS NULL
        AND t.organization_id=a.organization_id AND t.repository_id=b.repository_id
        AND j.status IN ('done','cancelled','failed') AND j.pending_control IS NULL
        AND j.record#>>'{progress,executionReleased}'='true'
        AND COALESCE(j.record#>'{progress,resultSaving}','null'::jsonb)='null'::jsonb
        AND (NOT ${requireTerminalCheckpoint} OR EXISTS(SELECT 1 FROM relay_workflow_recovery_heads h
          JOIN relay_workflow_recovery_records recovery ON recovery.job_id=h.job_id
            AND recovery.revision=h.revision AND recovery.publication_id=h.publication_id
          WHERE h.job_id=j.job_id AND recovery.manifest->>'terminalExecutionReleased'='true'
            AND recovery.manifest#>>'{binding,allocationId}'=a.allocation_id
            AND recovery.manifest#>>'{binding,environmentId}'=t.environment_id
            AND recovery.manifest#>>'{binding,generation}'=t.generation::text))
        AND f.operation_id IS NULL AND f.reclaim_operation_id IS NULL
        AND (f.open_until IS NULL OR f.open_until<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM relay_workflow_vm_follow_up_pushes push
          WHERE push.job_id=j.job_id AND push.status='armed')
        AND provision.workflow_snapshot IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM relay_thread_commands q
          WHERE q.thread_id=t.thread_id AND q.receipt_json IS NULL)
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses p
          WHERE p.allocation_id=a.allocation_id AND p.phase IN ('pending','sealed'))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
          WHERE r.allocation_id=a.allocation_id AND r.phase IN ('waiting','resuming'))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
          WHERE x.allocation_id=a.allocation_id AND x.phase IN ('pending','creating','captured','verifying','cleanup'))
    )
    SELECT f.allocation_id AS "allocationId" FROM finished f
    WHERE f.activity='idle' AND f.observed_idle_since IS NOT NULL
      AND f.observed_at >= clock_timestamp()-interval '2 minutes'
      AND f.idle_since <= clock_timestamp()-interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM relay_thread_execution_admissions e
        WHERE e.thread_id=f.thread_id AND e.generation=f.generation AND NOT e.completed
          AND NOT (e.environment_id=f.environment_id AND jsonb_exists(f.inactive_work_ids,e.work_id)))
      AND (f.idle_since <= clock_timestamp()-make_interval(mins => f.pause_after_idle_minutes)
        OR (NOT EXISTS (SELECT 1 FROM finished pending WHERE pending.allocation_id<>f.allocation_id
          AND pending.awaiting_lease_confirmation>=clock_timestamp()-interval '2 minutes')
        AND EXISTS (SELECT 1 FROM waiting w WHERE w.vm_limit>0 AND (
          (w.organization_id=f.organization_id AND w.used>=w.vm_limit)
          OR (w.used<w.vm_limit AND EXISTS (
            SELECT 1 FROM relay_thread_vm_hosts h WHERE h.host_id=${hostId}
              AND h.max_running_vms <= (SELECT count(*) FROM charged c WHERE c.host_id=h.host_id)
          ))
        ))))
    ORDER BY f.idle_since,f.allocation_id LIMIT 1`;
    return candidate?.allocationId ?? null;
  });

  const admitNext = Effect.fn("relay.vm_capacity.admit_next")(function* (
    hostId: string,
    scope: "personal" | "all" | OrderedCapacityAdmission = "personal",
  ) {
    const ordered = typeof scope === "object" ? scope : null;
    const workflowOperationId = ordered?.workflowOperationId;
    const linear = ordered?.linearWorkflow;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Serializes admission and limit edits across relay instances. No expiring
        // worker claim can authorize oversubscription or let a younger request pass.
        const [host] = yield* sql<{
          limit: number;
        }>`SELECT max_running_vms AS "limit" FROM relay_thread_vm_hosts
        WHERE host_id = ${hostId} FOR NO KEY UPDATE`;
        if (!host) return yield* conflict("Compute host capacity has not been configured");
        const [usage] = yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM relay_thread_vm_capacity
        WHERE host_id = ${hostId} AND state IN ('reserved', 'started')`;
        if ((usage?.count ?? 0) >= host.limit) return null;
        const [row] = yield* sql<{
          operationId: string;
          allocationId: string;
          kind: CapacityRequest["kind"];
          position: string;
          organizationId: string;
          resourceKind: "personal" | "organization_workflow";
          requiresFreeze: boolean;
        }>`SELECT c.operation_id AS "operationId",a.allocation_id AS "allocationId",c.kind,
          c.position::text AS position,a.organization_id AS "organizationId",
          a.resource_kind AS "resourceKind", ${
            ordered
              ? sql`EXISTS (
            SELECT 1 FROM relay_thread_placements t JOIN relay_workflow_jobs j ON j.job_id=t.workflow_job_id
            WHERE t.thread_id=a.thread_id AND j.status='queued')`
              : sql`false`
          } AS "requiresFreeze"
          FROM relay_thread_vm_capacity c
        JOIN relay_thread_vm_allocations a USING (allocation_id)
        WHERE a.runtime_protocol='native-v1' AND c.host_id = ${hostId} AND c.state = 'waiting' AND a.state IN ('creating', 'paused')
          AND (a.resource_kind='personal' OR (a.resource_kind='organization_workflow'
            AND ${
              scope === "all"
                ? sql`true`
                : ordered?.workflowEnabled
                  ? eligibleWorkflowWaiter(sql, linear)
                  : sql`false`
            }
            AND (SELECT count(*) FROM relay_thread_vm_capacity occupied
              JOIN relay_thread_vm_allocations charged ON charged.allocation_id=occupied.allocation_id
              WHERE charged.organization_id=a.organization_id AND charged.resource_kind='organization_workflow'
                AND occupied.state IN ('reserved','started')) < COALESCE((
                  SELECT max_running_workflow_vms FROM relay_thread_vm_policies
                  WHERE organization_id=a.organization_id),${DEFAULT_WORKFLOW_VM_LIMIT})))
        ORDER BY c.position LIMIT 1`;
        if (
          !row ||
          (workflowOperationId !== undefined && row.operationId !== workflowOperationId) ||
          (row.requiresFreeze && row.operationId !== workflowOperationId)
        )
          return null;
        if (row.resourceKind === "organization_workflow") {
          yield* lockWorkflowVmOrganization(sql, row.organizationId);
          const [organization] = yield* sql<{ limit: number; used: number }>`SELECT
            COALESCE((SELECT max_running_workflow_vms FROM relay_thread_vm_policies
              WHERE organization_id=${row.organizationId}),${DEFAULT_WORKFLOW_VM_LIMIT}) AS "limit",
            (SELECT count(*)::int FROM relay_thread_vm_capacity c
              JOIN relay_thread_vm_allocations a USING(allocation_id)
              WHERE a.organization_id=${row.organizationId} AND a.resource_kind='organization_workflow'
                AND c.state IN ('reserved','started')) AS used`;
          if (!organization || organization.used >= organization.limit) return null;
        }
        const rows = yield* sql`UPDATE relay_thread_vm_capacity c SET state = 'reserved'
          WHERE c.operation_id = ${row.operationId} AND c.state='waiting'
            AND c.allocation_id=${row.allocationId} AND c.kind=${row.kind} AND c.position=${row.position}::bigint
            AND c.host_id=${hostId}
            AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a
              WHERE a.allocation_id=c.allocation_id AND a.runtime_protocol='native-v1'
                AND a.resource_kind=${row.resourceKind} AND a.organization_id=${row.organizationId}
                AND a.state IN ('creating','paused') AND a.deleted_at IS NULL)
          RETURNING operation_id`;
        if (!rows.length) return null;
        return yield* get(row.operationId);
      }),
    );
  });
  const beginExecution = Effect.fn("relay.vm_capacity.begin_execution")(function* (
    operationId: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const request = yield* get(operationId);
        if (!request) return yield* conflict("Capacity request does not exist");
        const [allocation] = yield* sql<{
          state: string;
        }>`SELECT state FROM relay_thread_vm_allocations
        WHERE allocation_id = ${request.allocationId} AND runtime_protocol='native-v1' FOR UPDATE`;
        if (allocation?.state !== (request.kind === "create" ? "creating" : "paused"))
          return yield* conflict("Allocation no longer accepts execution");
        const rows = yield* sql`UPDATE relay_thread_vm_capacity SET state = 'started'
        WHERE operation_id = ${operationId} AND state = 'reserved' RETURNING operation_id`;
        if (!rows.length)
          return yield* conflict("Execution requires an unused capacity reservation");
      }),
    );
  });
  const recordCreated = Effect.fn("relay.vm_capacity.record_created")(function* (
    operationId: string,
    computeRef: string,
  ) {
    const rows = yield* sql`UPDATE relay_thread_vm_capacity SET compute_ref = ${computeRef}
      WHERE operation_id = ${operationId} AND state = 'started' AND (compute_ref IS NULL OR compute_ref = ${computeRef}) RETURNING operation_id`;
    if (!rows.length)
      return yield* conflict("Capacity belongs to a different or retired execution");
  });
  const cancelUnstarted = Effect.fn("relay.vm_capacity.cancel_unstarted")(function* (
    operationId: string,
  ) {
    const rows = yield* sql`UPDATE relay_thread_vm_capacity SET state = 'released'
      WHERE operation_id = ${operationId} AND state IN ('waiting', 'reserved', 'released')
        AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a WHERE a.allocation_id=relay_thread_vm_capacity.allocation_id AND a.runtime_protocol='native-v1') RETURNING operation_id`;
    if (!rows.length) return yield* conflict("External execution may already have started");
  });
  return {
    get,
    configure,
    request,
    hasWorkflowSlot,
    finishedVmDueToPause,
    admitNext,
    beginExecution,
    recordCreated,
    cancelUnstarted,
  };
}
