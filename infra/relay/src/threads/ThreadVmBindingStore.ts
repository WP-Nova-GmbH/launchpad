import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { ThreadVmProvisionConflict } from "./ThreadVmProvisionStore.ts";

/** Called only after verifying the allocation's enrollment proof; never accepts a client-selected scope. */
export function makeThreadVmBindingStore(sql: PgClient) {
  const bind = Effect.fn("relay.thread_vm_binding.bind")(function* (input: {
    allocationId: string;
    operationId: string;
    environmentId: string;
    environmentPublicKey: string;
    credentialId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [allocation] = yield* sql<{
          threadId: string;
          repositoryId: string;
          generation: number;
        }>`
        SELECT a.thread_id AS "threadId", t.repository_id AS "repositoryId", p.generation
        FROM relay_thread_vm_allocations a JOIN relay_thread_vm_provisions p USING (allocation_id)
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE a.allocation_id = ${input.allocationId} AND p.operation_id = ${input.operationId}
        AND a.state = 'running' AND a.deleted_at IS NULL AND p.phase = 'created' AND a.compute_ref IS NOT NULL
        FOR UPDATE OF a`;
        if (!allocation)
          return yield* new ThreadVmProvisionConflict({
            message: "Allocation has no matching completed create operation",
          });
        const credentials = yield* sql`SELECT credential_id FROM relay_environment_credentials
        WHERE credential_id = ${input.credentialId} AND environment_id = ${input.environmentId}
        AND environment_public_key = ${input.environmentPublicKey} AND revoked_at IS NULL FOR SHARE`;
        if (!credentials.length)
          return yield* new ThreadVmProvisionConflict({
            message: "Enrollment credential does not match the environment identity",
          });
        const anchors =
          yield* sql`SELECT environment_id FROM relay_environment_links WHERE environment_id = ${input.environmentId} AND revoked_at IS NULL
        UNION ALL SELECT environment_id FROM relay_machines WHERE environment_id = ${input.environmentId} AND deprovisioned_at IS NULL`;
        if (anchors.length)
          return yield* new ThreadVmProvisionConflict({
            message: "A thread VM requires a fresh environment identity",
          });
        const [binding] = yield* sql<{ environmentId: string }>`INSERT INTO relay_thread_vm_bindings
        (environment_id, allocation_id, thread_id, repository_id, generation, environment_public_key, credential_id)
        VALUES (${input.environmentId}, ${input.allocationId}, ${allocation.threadId}, ${allocation.repositoryId}, ${allocation.generation}, ${input.environmentPublicKey}, ${input.credentialId})
        ON CONFLICT (environment_id) DO UPDATE SET credential_id = EXCLUDED.credential_id
        WHERE relay_thread_vm_bindings.allocation_id = EXCLUDED.allocation_id
          AND relay_thread_vm_bindings.thread_id = EXCLUDED.thread_id AND relay_thread_vm_bindings.repository_id = EXCLUDED.repository_id
          AND relay_thread_vm_bindings.generation = EXCLUDED.generation AND relay_thread_vm_bindings.environment_public_key = EXCLUDED.environment_public_key
          AND relay_thread_vm_bindings.revoked_at IS NULL RETURNING environment_id AS "environmentId"`;
        if (!binding)
          return yield* new ThreadVmProvisionConflict({
            message: "Environment already has a different or revoked VM binding",
          });
        return { allocationId: input.allocationId, ...allocation };
      }),
    );
  });
  const revoke = Effect.fn("relay.thread_vm_binding.revoke")(function* (allocationId: string) {
    yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE allocation_id = ${allocationId}`;
  });
  return { bind, revoke };
}
