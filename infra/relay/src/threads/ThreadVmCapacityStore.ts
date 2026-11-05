import type { PgClient } from "@effect/sql-pg/PgClient";
import { DEFAULT_WORKFLOW_VM_LIMIT } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { lockWorkflowVmOrganization } from "./WorkflowVmPolicyLock.ts";

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
}
const conflict = (message: string) => new ThreadVmCapacityConflict({ message });

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
  const admitNext = Effect.fn("relay.vm_capacity.admit_next")(function* (
    hostId: string,
    scope: "personal" | "all" | OrderedCapacityAdmission = "personal",
  ) {
    const ordered = typeof scope === "object" ? scope : null;
    const workflowOperationId = ordered?.workflowOperationId;
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
          organizationId: string;
          resourceKind: "personal" | "organization_workflow";
          requiresFreeze: boolean;
        }>`SELECT c.operation_id AS "operationId", a.organization_id AS "organizationId",
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
                  ? sql`EXISTS (
              SELECT 1 FROM relay_thread_placements t JOIN relay_workflow_jobs j
                ON j.job_id=t.workflow_job_id AND j.organization_id=t.organization_id AND j.repository_id=t.repository_id
              JOIN relay_codex_vm_connections x ON x.organization_id=j.organization_id
                AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}' AND x.status='connected'
                AND (x.refresh_started_at IS NULL OR x.refresh_started_at::timestamptz > clock_timestamp() - interval '6 seconds')
              LEFT JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
              WHERE t.thread_id=a.thread_id AND t.organization_id=a.organization_id AND t.operation_id=c.operation_id
                AND j.pending_control IS NULL AND ((j.status='queued' AND p.allocation_id IS NULL
                  AND j.record#>>'{queueReason,code}'='vm_waiting_capacity') OR
                  (j.status='preparing' AND p.phase='pending' AND p.workflow_snapshot IS NOT NULL
                    AND p.retry_at<=clock_timestamp())))`
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
    admitNext,
    beginExecution,
    recordCreated,
    cancelUnstarted,
  };
}
