import type { PgClient } from "@effect/sql-pg/PgClient";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayThreadVmProviderAuthBinding } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

/** Database-only discovery. The caller holds private owner access and the placement lock. */
export const readPendingThreadVmProviderAuth = Effect.fn("relay.thread_vm.pending_provider_auth")(
  function* (sql: PgClient, threadId: string) {
    const [row] = yield* sql<{
      operationId: string;
      allocationId: string;
      environmentId: string;
      generation: number;
      repositoryId: string;
      computeRef: string;
      templateId: string;
    }>`SELECT e.operation_id AS "operationId",b.allocation_id AS "allocationId",
      b.environment_id AS "environmentId",b.generation,b.repository_id AS "repositoryId",
      a.compute_ref AS "computeRef",a.template_id AS "templateId"
      FROM relay_thread_placements t
      JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id AND b.repository_id=t.repository_id
      JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id AND a.owner_user_id=t.owner_user_id
      JOIN relay_thread_vm_enrollments e ON e.allocation_id=b.allocation_id
      JOIN relay_thread_vm_provisions p ON p.allocation_id=b.allocation_id
      JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
      JOIN relay_thread_vm_capacity cap ON cap.operation_id=p.operation_id
      WHERE t.thread_id=${threadId} AND t.operation_id=e.operation_id
        AND b.revoked_at IS NULL AND k.revoked_at IS NULL AND k.environment_id=b.environment_id
        AND k.environment_public_key=b.environment_public_key
        AND e.installed_at IS NOT NULL AND e.environment_id=b.environment_id
        AND e.credential_id=b.credential_id AND e.environment_public_key=b.environment_public_key
        AND p.operation_id=e.operation_id AND p.generation=b.generation AND p.phase='created'
        AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
        AND cap.state='started' AND cap.compute_ref=a.compute_ref
        AND (
          EXISTS(SELECT 1 FROM relay_thread_moves m WHERE m.operation_id=t.operation_id
            AND m.thread_id=t.thread_id AND m.actor_user_id=t.owner_user_id
            AND m.phase IN('preparing','frozen') AND m.expected_generation=t.generation
            AND m.source_environment_id=t.environment_id AND m.destination_environment_id=b.environment_id
            AND b.generation=t.generation+1)
          OR EXISTS(SELECT 1 FROM relay_thread_vm_resets r WHERE r.operation_id=t.operation_id
            AND r.thread_id=t.thread_id AND r.actor_user_id=t.owner_user_id
            AND r.allocation_id=b.allocation_id AND r.phase='importing'
            AND r.expected_generation+1=t.generation AND b.generation=t.generation
            AND b.environment_id=t.environment_id)
          OR EXISTS(SELECT 1 FROM relay_thread_vm_restores r WHERE r.operation_id=t.operation_id
            AND r.thread_id=t.thread_id AND r.actor_user_id=t.owner_user_id
            AND r.allocation_id=b.allocation_id AND r.phase='importing' AND r.serving_requested
            AND r.generation+1=t.generation AND b.generation=t.generation
            AND b.environment_id=t.environment_id)
        ) FOR SHARE OF b,a,e,p,k,cap`;
    if (!row) return null;
    const binding: RelayThreadVmProviderAuthBinding = {
      operationId: row.operationId,
      allocationId: row.allocationId,
      environmentId: EnvironmentId.make(row.environmentId),
      generation: row.generation,
      instanceId: "codex",
    };
    return {
      binding,
      repositoryId: row.repositoryId,
      computeRef: row.computeRef,
      templateId: row.templateId,
    };
  },
);
