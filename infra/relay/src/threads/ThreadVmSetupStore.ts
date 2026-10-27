import {
  RelayThreadVmInitialThread,
  type RelayThreadVmSetupErrorCode,
} from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";

export class ThreadVmSetupConflict extends Schema.TaggedError<ThreadVmSetupConflict>()(
  "ThreadVmSetupConflict",
  { message: Schema.String },
) {}
const encodeInitialState = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmInitialThread));
const decodeInitialState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayThreadVmInitialThread),
);
const conflict = (message: string) => new ThreadVmSetupConflict({ message });
export interface ThreadVmSetup {
  readonly allocationId: string;
  readonly threadId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly ownerUserId: string;
  readonly canonicalKey: string;
  readonly initialState: RelayThreadVmInitialThread | null;
  readonly branch: string;
  readonly revision: string;
  readonly phase: "pending" | "running" | "ready" | "failed";
  readonly environmentId: string | null;
  readonly errorCode: string | null;
  readonly receiptSha256: string | null;
}
type Intent = Pick<
  ThreadVmSetup,
  | "allocationId"
  | "threadId"
  | "organizationId"
  | "repositoryId"
  | "ownerUserId"
  | "canonicalKey"
  | "branch"
  | "revision"
> & {
  readonly initialState: RelayThreadVmInitialThread;
  readonly hostId: string;
  readonly templateId: string;
  readonly replacementRequestId?: string;
};

/** Internal storage: the caller holds current owner/repository access for every mutation. */
export function makeThreadVmSetupStore(sql: PgClient) {
  const get = Effect.fn("relay.thread_vm_setup.get")(function* (allocationId: string) {
    const [row] = yield* sql<
      Omit<ThreadVmSetup, "initialState"> & { initialState: string | null }
    >`SELECT s.allocation_id AS "allocationId", a.thread_id AS "threadId",
      a.organization_id AS "organizationId", t.repository_id AS "repositoryId", a.owner_user_id AS "ownerUserId",
      s.initial_state AS "initialState", s.canonical_key AS "canonicalKey", s.branch, s.revision, s.phase, s.environment_id AS "environmentId",
      COALESCE(s.error_code, p.error_code) AS "errorCode", s.receipt_sha256 AS "receiptSha256"
      FROM relay_thread_vm_setups s JOIN relay_thread_vm_allocations a USING (allocation_id)
      JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id WHERE s.allocation_id = ${allocationId}`;
    return row
      ? {
          ...row,
          initialState:
            row.initialState === null
              ? null
              : yield* decodeInitialState(row.initialState).pipe(
                  Effect.mapError(() => conflict("Invalid persisted initial thread state")),
                ),
        }
      : null;
  });
  const enqueue = Effect.fn("relay.thread_vm_setup.enqueue")(function* (input: Intent) {
    if (
      !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/.test(input.canonicalKey) ||
      !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(input.revision) ||
      !input.branch.trim()
    )
      return yield* conflict(
        "Initial VM setup requires one GitHub repository, branch and exact revision",
      );
    const initialState = yield* encodeInitialState(input.initialState).pipe(
      Effect.mapError(() => conflict("Invalid initial thread state")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Match quota reservation's user-before-placement lock order, including idempotent retries.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerUserId}, 721864))`;
        const prior = yield* get(input.allocationId);
        if (prior) {
          if (
            !prior.initialState ||
            (yield* encodeInitialState(prior.initialState).pipe(
              Effect.mapError(() => conflict("Invalid persisted initial thread state")),
            )) !== initialState
          )
            return yield* conflict("Setup identity reused with different initial state");
          for (const key of [
            "threadId",
            "organizationId",
            "repositoryId",
            "ownerUserId",
            "canonicalKey",
            "branch",
            "revision",
          ] as const)
            if (prior[key] !== input[key])
              return yield* conflict("Setup identity reused with different intent");
          const [compute] = yield* sql`SELECT a.allocation_id FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id
          WHERE a.allocation_id = ${input.allocationId} AND a.template_id = ${input.templateId}
          AND c.operation_id = ${input.allocationId} AND c.host_id = ${input.hostId}`;
          if (!compute) return yield* conflict("Setup compute target changed");
          return prior;
        }
        const inserted = yield* sql`INSERT INTO relay_thread_placements
        (thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id,generation,operation_id)
        VALUES (${input.threadId},${input.organizationId},${input.repositoryId},${input.ownerUserId},
          ${`pending-vm:${input.allocationId}`},${`vm:${input.threadId}`},1,${input.allocationId})
        ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id`;
        if (!inserted.length)
          return yield* conflict("Initial VM setup cannot replace an existing thread");
        yield* makeThreadVmAllocationStore(sql).reserve(input);
        yield* makeThreadVmProvisionStore(sql).enqueue({
          allocationId: input.allocationId,
          operationId: input.allocationId,
          generation: 1,
          hostId: input.hostId,
        });
        yield* sql`INSERT INTO relay_thread_vm_setups (allocation_id,canonical_key,branch,revision,initial_state)
        VALUES (${input.allocationId},${input.canonicalKey},${input.branch},${input.revision},${initialState})`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  const lock = Effect.fnUntraced(function* (allocationId: string) {
    const setup = yield* get(allocationId);
    if (!setup) return yield* conflict("Initial VM setup does not exist");
    yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${setup.threadId} FOR UPDATE`;
    const [allocation] = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
      WHERE allocation_id = ${allocationId} AND state = 'running' AND deleted_at IS NULL FOR UPDATE`;
    if (!allocation) return yield* conflict("Setup VM is not running or is being deleted");
    yield* sql`SELECT allocation_id FROM relay_thread_vm_setups WHERE allocation_id = ${allocationId} FOR UPDATE`;
    return (yield* get(allocationId))!;
  });
  const requireBinding = Effect.fnUntraced(function* (setup: ThreadVmSetup, environmentId: string) {
    const [binding] = yield* sql`SELECT b.environment_id FROM relay_thread_vm_bindings b
      JOIN relay_thread_vm_enrollments e ON e.allocation_id = b.allocation_id
      JOIN relay_environment_credentials c ON c.credential_id = b.credential_id
      WHERE b.allocation_id = ${setup.allocationId} AND b.environment_id = ${environmentId}
      AND b.thread_id = ${setup.threadId} AND b.repository_id = ${setup.repositoryId} AND b.generation = 1
      AND b.revoked_at IS NULL AND e.installed_at IS NOT NULL AND c.revoked_at IS NULL
      AND c.environment_id = b.environment_id AND c.environment_public_key = b.environment_public_key
      FOR SHARE OF b,c`;
    if (!binding) return yield* conflict("Setup requires the installed, current VM identity");
  });
  const requireServerStart = Effect.fn("relay.thread_vm_setup.require_server_start")(function* (
    allocationId: string,
  ) {
    const setup = yield* lock(allocationId);
    if (setup.phase !== "ready" || !setup.environmentId || !setup.receiptSha256)
      return yield* conflict("VM preparation is not confirmed");
    yield* requireBinding(setup, setup.environmentId);
    const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
      WHERE thread_id = ${setup.threadId} AND environment_id = ${setup.environmentId}
      AND project_id = ${`vm:${setup.threadId}`} AND repository_id = ${setup.repositoryId}
      AND generation = 1 AND operation_id IS NULL`;
    if (!placement) return yield* conflict("VM no longer owns the prepared thread");
    return { ...setup, environmentId: setup.environmentId, receiptSha256: setup.receiptSha256 };
  });
  const begin = Effect.fn("relay.thread_vm_setup.begin")(function* (input: {
    allocationId: string;
    environmentId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const setup = yield* lock(input.allocationId);
        yield* requireBinding(setup, input.environmentId);
        if (
          setup.phase === "failed" ||
          (setup.environmentId !== null && setup.environmentId !== input.environmentId)
        )
          return yield* conflict("Setup is failed or assigned to another environment");
        if (setup.phase === "ready") return setup;
        const rows =
          yield* sql`UPDATE relay_thread_placements SET environment_id = ${input.environmentId}
        WHERE thread_id = ${setup.threadId} AND generation = 1 AND operation_id = ${setup.allocationId}
        AND environment_id IN (${`pending-vm:${setup.allocationId}`},${input.environmentId}) RETURNING thread_id`;
        if (!rows.length) return yield* conflict("Thread no longer belongs to this setup");
        yield* sql`UPDATE relay_thread_vm_setups SET phase = 'running', environment_id = ${input.environmentId}
        WHERE allocation_id = ${setup.allocationId}`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  const finish = Effect.fn("relay.thread_vm_setup.finish")(function* (input: {
    allocationId: string;
    environmentId: string;
    receiptSha256: string;
  }) {
    if (!/^[0-9a-f]{64}$/.test(input.receiptSha256))
      return yield* conflict("Invalid setup receipt digest");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const setup = yield* lock(input.allocationId);
        yield* requireBinding(setup, input.environmentId);
        if (
          setup.phase === "ready" &&
          setup.environmentId === input.environmentId &&
          setup.receiptSha256 === input.receiptSha256
        )
          return setup;
        if (setup.phase !== "running" || setup.environmentId !== input.environmentId)
          return yield* conflict("Setup has not completed at this environment");
        const rows = yield* sql`UPDATE relay_thread_placements SET operation_id = NULL
        WHERE thread_id = ${setup.threadId} AND environment_id = ${input.environmentId} AND generation = 1
        AND operation_id = ${setup.allocationId} RETURNING thread_id`;
        if (!rows.length) return yield* conflict("Setup no longer owns the placement hold");
        yield* sql`UPDATE relay_thread_vm_setups SET phase = 'ready', receipt_sha256 = ${input.receiptSha256}, error_code = NULL
        WHERE allocation_id = ${setup.allocationId}`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  const fail = Effect.fn("relay.thread_vm_setup.fail")(function* (input: {
    allocationId: string;
    environmentId: string;
    errorCode: RelayThreadVmSetupErrorCode;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const setup = yield* lock(input.allocationId);
        if (setup.phase !== "running" || setup.environmentId !== input.environmentId)
          return yield* conflict("Setup is not running here");
        yield* sql`UPDATE relay_thread_vm_setups SET phase = 'failed', error_code = ${input.errorCode} WHERE allocation_id = ${setup.allocationId}`;
        return (yield* get(input.allocationId))!;
      }),
    );
  });
  return { get, enqueue, begin, finish, fail, requireServerStart };
}
