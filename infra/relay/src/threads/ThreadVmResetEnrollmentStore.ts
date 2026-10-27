import type { PgClient } from "@effect/sql-pg/PgClient";
import type { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { ThreadVmEnrollmentInvalid } from "./ThreadVmEnrollmentStore.ts";

/** Fresh enrollment commits reset ownership exactly once. Execution stays held
 * until the separately retained conversation, setup and paused queue are ready. */
export function makeThreadVmResetEnrollmentStore(sql: PgClient) {
  const assigned = Effect.fn("relay.thread_vm.reset.assign_enrolled")(function* (
    receipt: RelayThreadVmEnrollmentReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [reset] = yield* sql<{
          phase: string;
          expectedGeneration: number;
          sourceEnvironmentId: string;
          actorUserId: string;
        }>`SELECT r.phase,r.expected_generation AS "expectedGeneration",r.source_environment_id AS "sourceEnvironmentId",r.actor_user_id AS "actorUserId"
        FROM relay_thread_vm_resets r JOIN relay_thread_placements t USING(thread_id)
        WHERE r.operation_id=${receipt.operationId} AND r.allocation_id=${receipt.allocationId} AND r.thread_id=${receipt.threadId} FOR UPDATE OF t,r`;
        if (!reset) return false;
        if (
          !["pending", "creating", "importing"].includes(reset.phase) ||
          receipt.generation !== reset.expectedGeneration + 1
        )
          return yield* new ThreadVmEnrollmentInvalid();
        const [confirmed] = yield* sql`SELECT 1 FROM relay_thread_placements t
        JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
        JOIN relay_thread_vm_enrollments e ON e.allocation_id=b.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id=b.allocation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
        JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        JOIN relay_thread_vm_capacity cap ON cap.operation_id=p.operation_id
        WHERE t.thread_id=${receipt.threadId} AND t.operation_id=${receipt.operationId} AND t.owner_user_id=${reset.actorUserId}
          AND b.allocation_id=${receipt.allocationId} AND b.environment_id=${receipt.environmentId} AND b.environment_id<>${reset.sourceEnvironmentId}
          AND b.generation=${receipt.generation} AND b.repository_id=t.repository_id AND b.revoked_at IS NULL
          AND e.operation_id=${receipt.operationId} AND e.installed_at IS NOT NULL AND e.environment_id=b.environment_id
          AND e.credential_id=b.credential_id AND e.environment_public_key=b.environment_public_key AND c.revoked_at IS NULL
          AND p.operation_id=${receipt.operationId} AND p.generation=b.generation AND p.phase='created'
          AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
          AND cap.state='started' AND cap.compute_ref=a.compute_ref
          AND ((t.generation=${reset.expectedGeneration} AND t.environment_id=${reset.sourceEnvironmentId})
            OR (t.generation=${receipt.generation} AND t.environment_id=b.environment_id AND ${reset.phase === "importing"}))
        FOR SHARE OF b,e,p,a,c,cap`;
        if (!confirmed) return yield* new ThreadVmEnrollmentInvalid();
        yield* sql`UPDATE relay_thread_placements SET environment_id=${receipt.environmentId},generation=${receipt.generation},project_id=${`vm:${receipt.threadId}`}
        WHERE thread_id=${receipt.threadId} AND operation_id=${receipt.operationId}`;
        yield* sql`UPDATE relay_thread_vm_resets SET phase='importing',retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${receipt.operationId}`;
        return true;
      }),
    );
  });
  return { assigned };
}
