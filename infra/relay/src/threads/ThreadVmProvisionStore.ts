import type { ThreadVmCreationStopReceipt } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import type { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import { makeThreadVmEnrollmentStore } from "./ThreadVmEnrollmentStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";

export class ThreadVmProvisionConflict extends Schema.TaggedError<ThreadVmProvisionConflict>()(
  "ThreadVmProvisionConflict",
  { message: Schema.String },
) {}
export interface ThreadVmProvision {
  readonly allocationId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly creationIdentityFenced: boolean;
  readonly threadId: string;
  readonly templateId: string;
  readonly computeRef: string | null;
  readonly allocationState: "creating" | "running" | "paused" | "deleting" | "deleted";
  readonly phase: "pending" | "creating" | "created" | "cancelled";
  readonly claimId: string | null;
  readonly errorCode: string | null;
}
const conflict = (message: string) => new ThreadVmProvisionConflict({ message });

/** Internal API: reserve quota and authorize intent before enqueuing. Claims never transfer thread ownership. */
export function makeThreadVmProvisionStore(sql: PgClient) {
  const allocations = makeThreadVmAllocationStore(sql);
  const capacity = makeThreadVmCapacityStore(sql);
  const get = Effect.fn("relay.thread_vm_provision.get")(function* (allocationId: string) {
    const [row] =
      yield* sql<ThreadVmProvision>`SELECT p.allocation_id AS "allocationId", p.operation_id AS "operationId", p.generation,
      a.thread_id AS "threadId", a.template_id AS "templateId", a.compute_ref AS "computeRef", a.state AS "allocationState",
      p.phase, p.creation_identity_fenced AS "creationIdentityFenced", p.claim_id AS "claimId", p.error_code AS "errorCode"
      FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING (allocation_id)
      WHERE p.allocation_id = ${allocationId}`;
    return row ?? null;
  });
  const enqueue = Effect.fn("relay.thread_vm_provision.enqueue")(function* (input: {
    allocationId: string;
    operationId: string;
    generation: number;
    hostId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [allocation] = yield* sql<{
          state: string;
        }>`SELECT state FROM relay_thread_vm_allocations WHERE allocation_id = ${input.allocationId} FOR UPDATE`;
        if (!allocation) return yield* conflict("Reserve the VM allocation before provisioning");
        const prior = yield* get(input.allocationId);
        if (prior) {
          if (
            prior.operationId !== input.operationId ||
            prior.generation !== input.generation ||
            (yield* capacity.get(prior.operationId))?.hostId !== input.hostId
          )
            return yield* conflict("Provisioning identity was reused with different intent");
          return prior;
        }
        if (allocation.state !== "creating")
          return yield* conflict("Allocation no longer accepts provisioning");
        yield* capacity.request({ ...input, kind: "create" });
        yield* sql`INSERT INTO relay_thread_vm_provisions (allocation_id, operation_id, generation)
        VALUES (${input.allocationId}, ${input.operationId}, ${input.generation})`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  const claim = Effect.fn("relay.thread_vm_provision.claim")(function* (
    claimId: string,
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
        }>`SELECT p.allocation_id AS "allocationId" FROM relay_thread_vm_provisions p
        JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id = p.allocation_id
        WHERE c.host_id = ${hostId} AND p.phase IN ('pending', 'creating') AND p.retry_at <= clock_timestamp()
        AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
        AND (c.state IN ('reserved', 'started') OR a.state = 'deleting')
        ORDER BY p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = ${claimId}, claim_until = clock_timestamp() + interval '2 minutes', revision = revision + 1
        WHERE allocation_id = ${candidate.allocationId}`;
        return yield* get(candidate.allocationId);
      }),
    );
  });
  const locked = Effect.fnUntraced(function* (input: { allocationId: string; claimId: string }) {
    // All writers take allocation then operation, including cancellation and late create receipts.
    yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id = ${input.allocationId} FOR UPDATE`;
    const rows = yield* sql`SELECT allocation_id FROM relay_thread_vm_provisions
      WHERE allocation_id = ${input.allocationId} AND claim_id = ${input.claimId} AND claim_until > clock_timestamp() FOR UPDATE`;
    if (!rows.length) return yield* conflict("Provisioning worker claim expired or changed");
    return (yield* get(input.allocationId))!;
  });
  const beginCreate = Effect.fn("relay.thread_vm_provision.begin_create")(function* (input: {
    allocationId: string;
    claimId: string;
    templateId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* locked(input);
        if (row.phase !== "pending" || row.allocationState !== "creating")
          return yield* conflict("VM creation is already attempted or cancelled");
        // Choose the current image at first creation, then retain it for recovery and enrollment.
        yield* sql`UPDATE relay_thread_vm_allocations SET template_id = ${input.templateId}
          WHERE allocation_id = ${input.allocationId}`;
        yield* capacity.beginExecution(row.operationId);
        yield* sql`UPDATE relay_thread_vm_provisions SET phase = 'creating', creation_identity_fenced = true WHERE allocation_id = ${input.allocationId}`;
        return {
          ...row,
          templateId: input.templateId,
          phase: "creating" as const,
          creationIdentityFenced: true,
        };
      }),
    );
  });
  const recordCreated = Effect.fn("relay.thread_vm_provision.record_created")(function* (input: {
    allocationId: string;
    claimId: string;
    computeRef: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* locked(input);
        if (row.phase !== "creating")
          return yield* conflict("Provisioning does not accept a create receipt");
        yield* capacity.recordCreated(row.operationId, input.computeRef);
        yield* allocations.recordCreated(input);
        yield* sql`UPDATE relay_thread_vm_provisions SET phase = 'created', claim_id = NULL, claim_until = NULL, error_code = NULL WHERE allocation_id = ${input.allocationId}`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm_provision.defer")(function* (input: {
    allocationId: string;
    claimId: string;
    errorCode: "create_uncertain" | "compute_unavailable" | "identity_conflict";
  }) {
    const rows = yield* sql`UPDATE relay_thread_vm_provisions SET error_code = ${input.errorCode},
      retry_at = clock_timestamp() + interval '30 seconds', claim_id = NULL, claim_until = NULL
      WHERE allocation_id = ${input.allocationId} AND claim_id = ${input.claimId} AND claim_until > clock_timestamp()
      AND phase IN ('pending', 'creating') RETURNING allocation_id`;
    if (!rows.length) return yield* conflict("Provisioning worker claim expired or changed");
  });
  const cancelUnstarted = Effect.fn("relay.thread_vm_provision.cancel_unstarted")(
    function* (input: { allocationId: string; claimId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* locked(input);
          if (
            row.phase !== "pending" ||
            row.computeRef !== null ||
            row.allocationState !== "deleting"
          )
            return yield* conflict("External VM creation may already have started");
          yield* capacity.cancelUnstarted(row.operationId);
          yield* allocations.confirmDeleted({ allocationId: input.allocationId, computeRef: null });
          yield* sql`UPDATE relay_thread_vm_provisions SET phase = 'cancelled', claim_id = NULL, claim_until = NULL, error_code = NULL WHERE allocation_id = ${input.allocationId}`;
        }),
      );
    },
  );
  const confirmCreateCancelled = Effect.fn("relay.thread_vm_provision.confirm_create_cancelled")(
    function* (input: {
      allocationId: string;
      claimId: string;
      receipt: ThreadVmCreationStopReceipt;
    }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* locked(input);
          const receipt = input.receipt;
          if (
            row.phase !== "creating" ||
            !row.creationIdentityFenced ||
            row.allocationState !== "deleting" ||
            receipt.operationId !== row.operationId ||
            (row.computeRef !== null && row.computeRef !== receipt.computeRef)
          )
            return yield* conflict("Creation stop receipt does not match the cancelled operation");
          if (receipt.computeRef !== null) {
            const metadata = receipt.metadata;
            if (
              metadata["launchpad.managed"] !== "thread-vm-v1" ||
              metadata["launchpad.operation_id"] !== row.operationId ||
              metadata["launchpad.allocation_id"] !== row.allocationId ||
              metadata["launchpad.thread_id"] !== row.threadId ||
              metadata["launchpad.generation"] !== String(row.generation)
            )
              return yield* conflict("Creation stop identity belongs to another allocation");
            yield* allocations.recordCreated({
              allocationId: row.allocationId,
              computeRef: receipt.computeRef,
            });
          }
          yield* capacity.confirmCreateCancelled(row.operationId, receipt.computeRef);
          yield* allocations.confirmDeleted({
            allocationId: row.allocationId,
            computeRef: receipt.computeRef,
          });
          yield* sql`UPDATE relay_thread_vm_provisions SET phase = 'cancelled', claim_id = NULL, claim_until = NULL, error_code = NULL WHERE allocation_id = ${row.allocationId}`;
        }),
      );
    },
  );
  const rejectUnstarted = Effect.fn("relay.thread_vm_provision.reject_unstarted")(
    function* (input: { allocationId: string; claimId: string }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* locked(input);
          if (row.phase !== "pending") return yield* conflict("Creation may already have started");
          yield* allocations.requestDeletion(row.allocationId);
          yield* cancelUnstarted(input);
          yield* sql`UPDATE relay_thread_vm_provisions SET error_code = 'access_denied' WHERE allocation_id = ${row.allocationId}`;
        }),
      );
    },
  );
  const claimEnrollment = Effect.fn("relay.thread_vm_provision.claim_enrollment")(function* (
    claimId: string,
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
        }>`SELECT p.allocation_id AS "allocationId"
        FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING (allocation_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
        LEFT JOIN relay_thread_vm_enrollments e ON e.allocation_id = p.allocation_id
        WHERE c.host_id = ${hostId} AND p.phase = 'created' AND a.state = 'running' AND a.deleted_at IS NULL AND e.installed_at IS NULL
          AND p.retry_at <= clock_timestamp() AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
        ORDER BY p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = ${claimId}, claim_until = clock_timestamp() + interval '2 minutes', revision = revision + 1
        WHERE allocation_id = ${candidate.allocationId}`;
        return yield* get(candidate.allocationId);
      }),
    );
  });
  const finishEnrollment = Effect.fn("relay.thread_vm_provision.finish_enrollment")(
    function* (input: {
      allocationId: string;
      claimId: string;
      receipt: RelayThreadVmEnrollmentReceipt;
    }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* locked(input);
          if (
            row.phase !== "created" ||
            row.allocationId !== input.receipt.allocationId ||
            row.operationId !== input.receipt.operationId
          )
            return yield* conflict("Enrollment reply belongs to a different operation");
          yield* makeThreadVmEnrollmentStore(sql).confirmInstalled(input.receipt);
          yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = NULL, claim_until = NULL, error_code = NULL WHERE allocation_id = ${input.allocationId}`;
        }),
      );
    },
  );
  const deferEnrollment = Effect.fn("relay.thread_vm_provision.defer_enrollment")(
    function* (input: {
      allocationId: string;
      claimId: string;
      errorCode: "enrollment_unconfirmed" | "enrollment_access_denied";
    }) {
      const rows =
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = NULL, claim_until = NULL,
      error_code = ${input.errorCode}, retry_at = clock_timestamp() + interval '30 seconds'
      WHERE allocation_id = ${input.allocationId} AND claim_id = ${input.claimId} AND claim_until > clock_timestamp()
      AND phase = 'created' RETURNING allocation_id`;
      if (!rows.length) return yield* conflict("Enrollment worker claim expired or changed");
    },
  );
  const claimSetup = Effect.fn("relay.thread_vm_provision.claim_setup")(function* (
    claimId: string,
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
        }>`SELECT p.allocation_id AS "allocationId"
      FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING (allocation_id)
      JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
      JOIN relay_thread_vm_enrollments e ON e.allocation_id = p.allocation_id
      JOIN relay_thread_vm_setups s ON s.allocation_id = p.allocation_id
      WHERE c.host_id = ${hostId} AND p.phase = 'created' AND a.state = 'running' AND a.deleted_at IS NULL
      AND e.installed_at IS NOT NULL AND s.phase IN ('pending','running')
      AND p.retry_at <= clock_timestamp() AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
      ORDER BY p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = ${claimId}, claim_until = clock_timestamp() + interval '2 minutes', revision = revision + 1 WHERE allocation_id = ${candidate.allocationId}`;
        return yield* get(candidate.allocationId);
      }),
    );
  });
  const claimStartup = Effect.fn("relay.thread_vm_provision.claim_startup")(function* (
    claimId: string,
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
        }>`SELECT p.allocation_id AS "allocationId"
        FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING (allocation_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id = p.operation_id
        JOIN relay_thread_vm_setups s ON s.allocation_id = p.allocation_id
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE c.host_id = ${hostId} AND p.phase = 'created' AND a.state = 'running' AND a.deleted_at IS NULL
        AND p.generation=1 AND s.phase = 'ready' AND s.receipt_sha256 IS NOT NULL
        AND t.environment_id = s.environment_id AND t.generation = p.generation AND t.operation_id IS NULL
        AND p.retry_at <= clock_timestamp() AND (p.claim_until IS NULL OR p.claim_until <= clock_timestamp())
        ORDER BY p.retry_at,p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = ${claimId}, claim_until = clock_timestamp() + interval '2 minutes', revision = revision + 1 WHERE allocation_id = ${candidate.allocationId}`;
        return yield* get(candidate.allocationId);
      }),
    );
  });
  const claimMoveStartup = Effect.fn("relay.thread_vm_provision.claim_move_startup")(function* (
    claimId: string,
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
        }>`SELECT p.allocation_id AS "allocationId"
        FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING(allocation_id)
          JOIN relay_thread_vm_capacity c ON c.operation_id=p.operation_id
          JOIN relay_thread_vm_move_destinations d ON d.allocation_id=p.allocation_id
          JOIN relay_thread_moves m ON m.operation_id=d.operation_id
          JOIN relay_thread_placements t ON t.thread_id=a.thread_id
          JOIN relay_thread_vm_enrollments e ON e.allocation_id=p.allocation_id
          JOIN relay_thread_vm_bindings b ON b.allocation_id=p.allocation_id
          JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
          JOIN relay_thread_move_artifacts r ON r.operation_id=m.operation_id
        WHERE c.host_id=${hostId} AND p.phase='created' AND a.state='running' AND a.deleted_at IS NULL
          AND e.installed_at IS NOT NULL AND b.revoked_at IS NULL AND k.revoked_at IS NULL
          AND b.environment_id=m.destination_environment_id AND b.generation=p.generation
          AND ((m.phase IN ('frozen','ready') AND t.operation_id=m.operation_id AND t.generation=m.expected_generation)
            OR (m.phase='committed' AND t.operation_id=m.operation_id AND t.generation=p.generation AND t.environment_id=m.destination_environment_id)
            OR (m.phase='completed' AND t.operation_id IS NULL AND t.generation=p.generation AND t.environment_id=m.destination_environment_id))
          AND p.retry_at<=clock_timestamp() AND (p.claim_until IS NULL OR p.claim_until<=clock_timestamp())
        ORDER BY p.retry_at,p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id=${claimId},claim_until=clock_timestamp()+interval '2 minutes',revision=revision+1 WHERE allocation_id=${candidate.allocationId}`;
        return yield* get(candidate.allocationId);
      }),
    );
  });
  const releaseStartupClaim = Effect.fn("relay.thread_vm_provision.release_startup_claim")(
    function* (input: {
      allocationId: string;
      claimId: string;
      errorCode: "startup_unconfirmed" | "startup_access_denied" | null;
    }) {
      const rows =
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = NULL, claim_until = NULL,
      error_code = ${input.errorCode}, retry_at = clock_timestamp() + interval '60 seconds'
      WHERE allocation_id = ${input.allocationId} AND claim_id = ${input.claimId} AND claim_until > clock_timestamp()
      AND phase = 'created' RETURNING allocation_id`;
      if (!rows.length) return yield* conflict("VM startup claim expired or changed");
    },
  );
  // Call within the access transaction, before accepting an external setup result.
  const requireSetupClaim = Effect.fn("relay.thread_vm_provision.require_setup_claim")(
    function* (input: { allocationId: string; claimId: string }) {
      const row = yield* locked(input);
      if (row.phase !== "created" || row.allocationState !== "running")
        return yield* conflict("VM no longer accepts setup");
      return row;
    },
  );
  const releaseSetupClaim = Effect.fn("relay.thread_vm_provision.release_setup_claim")(
    function* (input: {
      allocationId: string;
      claimId: string;
      errorCode: "setup_unconfirmed" | "setup_access_denied" | null;
    }) {
      const rows =
        yield* sql`UPDATE relay_thread_vm_provisions SET claim_id = NULL, claim_until = NULL,
    error_code = ${input.errorCode}, retry_at = clock_timestamp() + interval '30 seconds'
    WHERE allocation_id = ${input.allocationId} AND claim_id = ${input.claimId} AND claim_until > clock_timestamp()
    AND phase = 'created' RETURNING allocation_id`;
      if (!rows.length) return yield* conflict("VM setup claim expired or changed");
    },
  );
  return {
    get,
    enqueue,
    claim,
    beginCreate,
    recordCreated,
    defer,
    cancelUnstarted,
    confirmCreateCancelled,
    rejectUnstarted,
    claimStartup,
    claimMoveStartup,
    releaseStartupClaim,
    claimSetup,
    requireSetupClaim,
    releaseSetupClaim,
    claimEnrollment,
    finishEnrollment,
    deferEnrollment,
  };
}
