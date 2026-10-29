import type { PgClient } from "@effect/sql-pg/PgClient";
import type { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { ThreadVmEnrollmentInvalid } from "./ThreadVmEnrollmentStore.ts";

/** Replace the restore placeholder only with its fresh, durably installed narrow
 * credential. The operation remains held through native/history import and setup. */
export function makeThreadVmRestoreEnrollmentStore(sql: PgClient) {
  const requested = Effect.fn("relay.thread_vm.restore.enrollment_scope")(function* (input: {
    operationId: string;
    allocationId: string;
    threadId: string;
    generation: number;
  }) {
    const [row] = yield* sql`SELECT 1 FROM relay_thread_vm_restores r
      JOIN relay_thread_placements t USING(thread_id)
      JOIN relay_thread_vm_provisions p ON p.allocation_id=r.allocation_id
      JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
      WHERE r.operation_id=${input.operationId} AND r.allocation_id=${input.allocationId}
        AND a.runtime_protocol='native-v1'
        AND r.thread_id=${input.threadId} AND r.target_generation=${input.generation}
        AND r.serving_requested AND r.phase='booted' AND r.boot_ingress_recovery_claim_id IS NULL AND r.boot_recovery_started_at IS NULL AND t.operation_id=r.operation_id
        AND t.generation=r.target_generation AND p.operation_id=r.operation_id AND p.phase='created'`;
    return Boolean(row);
  });
  const assigned = Effect.fn("relay.thread_vm.restore.assign_enrolled")(function* (
    receipt: RelayThreadVmEnrollmentReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [restore] = yield* sql<{
          phase: string;
          targetGeneration: number;
          actorUserId: string;
          recoveryBlocked: boolean;
        }>`
        SELECT r.phase,r.target_generation AS "targetGeneration",r.actor_user_id AS "actorUserId",
          (r.boot_ingress_recovery_claim_id IS NOT NULL OR r.boot_recovery_started_at IS NOT NULL) AS "recoveryBlocked"
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        WHERE r.operation_id=${receipt.operationId} AND r.allocation_id=${receipt.allocationId}
          AND r.thread_id=${receipt.threadId} FOR UPDATE OF t,r`;
        if (!restore) return false;
        if (restore.recoveryBlocked) return yield* new ThreadVmEnrollmentInvalid();
        const [confirmed] = yield* sql`SELECT 1 FROM relay_thread_placements t
        JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
        JOIN relay_thread_vm_enrollments e ON e.allocation_id=b.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id=b.allocation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
        JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        WHERE t.thread_id=${receipt.threadId} AND t.operation_id=${receipt.operationId}
          AND t.generation=${receipt.generation} AND t.owner_user_id=${restore.actorUserId}
          AND b.allocation_id=${receipt.allocationId} AND b.environment_id=${receipt.environmentId}
          AND b.generation=t.generation AND b.repository_id=t.repository_id AND b.revoked_at IS NULL
          AND e.operation_id=${receipt.operationId} AND e.installed_at IS NOT NULL
          AND e.environment_id=b.environment_id AND e.credential_id=b.credential_id
          AND e.environment_public_key=b.environment_public_key AND c.revoked_at IS NULL
          AND p.operation_id=${receipt.operationId} AND p.generation=t.generation AND p.phase='created'
          AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL AND a.runtime_protocol='native-v1'
          AND b.environment_id<> COALESCE((SELECT environment_id FROM relay_thread_vm_final_saves
            WHERE operation_id=(SELECT saved_disk_operation_id FROM relay_thread_vm_restores WHERE operation_id=${receipt.operationId})),
            (SELECT environment_id FROM relay_thread_vm_backup_recoveries WHERE operation_id=${receipt.operationId}))
          AND (t.environment_id=${`pending-restore:${receipt.allocationId}`} OR t.environment_id=b.environment_id)
        FOR SHARE OF b,e,p,a,c`;
        if (
          !confirmed ||
          receipt.generation !== restore.targetGeneration ||
          !["booted", "importing"].includes(restore.phase)
        )
          return yield* new ThreadVmEnrollmentInvalid();
        yield* sql`UPDATE relay_thread_placements SET environment_id=${receipt.environmentId}
        WHERE thread_id=${receipt.threadId} AND operation_id=${receipt.operationId}`;
        yield* sql`UPDATE relay_thread_vm_restores SET phase='importing',error_code=NULL,retry_at=clock_timestamp()
        WHERE operation_id=${receipt.operationId}`;
        return true;
      }),
    );
  });
  return { requested, assigned };
}
