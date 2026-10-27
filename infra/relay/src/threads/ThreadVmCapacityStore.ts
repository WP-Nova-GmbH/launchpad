import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
        WHERE allocation_id = ${input.allocationId} FOR UPDATE`;
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
  const admitNext = Effect.fn("relay.vm_capacity.admit_next")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Serializes admission and limit edits across relay instances. No expiring
        // worker claim can authorize oversubscription or let a younger request pass.
        const [host] = yield* sql<{
          limit: number;
        }>`SELECT max_running_vms AS "limit" FROM relay_thread_vm_hosts
        WHERE host_id = ${hostId} FOR UPDATE`;
        if (!host) return yield* conflict("Compute host capacity has not been configured");
        const [usage] = yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM relay_thread_vm_capacity
        WHERE host_id = ${hostId} AND state IN ('reserved', 'started')`;
        if ((usage?.count ?? 0) >= host.limit) return null;
        const [row] = yield* sql<{
          operationId: string;
        }>`SELECT c.operation_id AS "operationId" FROM relay_thread_vm_capacity c
        JOIN relay_thread_vm_allocations a USING (allocation_id)
        WHERE c.host_id = ${hostId} AND c.state = 'waiting' AND a.state IN ('creating', 'paused')
        ORDER BY c.position FOR UPDATE OF c LIMIT 1`;
        if (!row) return null;
        yield* sql`UPDATE relay_thread_vm_capacity SET state = 'reserved' WHERE operation_id = ${row.operationId}`;
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
        WHERE allocation_id = ${request.allocationId} FOR UPDATE`;
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
      WHERE operation_id = ${operationId} AND state IN ('waiting', 'reserved', 'released') RETURNING operation_id`;
    if (!rows.length) return yield* conflict("External execution may already have started");
  });
  // Called only after the fenced creation API has sealed the exact operation and
  // returned a positive physical-stop receipt. A missing SDK row is never proof.
  const confirmCreateCancelled = Effect.fn("relay.vm_capacity.confirm_create_cancelled")(function* (
    operationId: string,
    computeRef: string | null,
  ) {
    const rows =
      yield* sql`UPDATE relay_thread_vm_capacity c SET state = 'released', compute_ref = ${computeRef}
      FROM relay_thread_vm_provisions p, relay_thread_vm_allocations a
      WHERE c.operation_id = ${operationId} AND c.kind = 'create' AND c.state = 'started'
        AND (c.compute_ref IS NULL OR c.compute_ref = ${computeRef})
        AND p.operation_id = c.operation_id AND p.phase = 'creating' AND p.creation_identity_fenced
        AND a.allocation_id = c.allocation_id AND a.state = 'deleting'
      RETURNING c.operation_id`;
    if (!rows.length) return yield* conflict("Creation does not accept a physical-stop receipt");
  });
  return {
    get,
    configure,
    request,
    admitNext,
    beginExecution,
    recordCreated,
    cancelUnstarted,
    confirmCreateCancelled,
  };
}
