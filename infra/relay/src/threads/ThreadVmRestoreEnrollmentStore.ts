import type { PgClient } from "@effect/sql-pg/PgClient";
import type {
  RelayThreadVmEnrollmentReceipt,
  RelayThreadVmWorkflowCheckpoint,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import {
  authorizeWorkflowVmCheckpoint,
  lockWorkflowVmCheckpoint,
} from "../jobs/WorkflowVmCheckpoint.ts";
import { ThreadVmEnrollmentInvalid } from "./ThreadVmEnrollmentStore.ts";
import {
  withPreparingWorkflowVm,
  type WorkflowVmPreparationScope,
} from "./ThreadVmWorkflowAccess.ts";
import { readCurrentWorkflowCheckpoint } from "./WorkflowVmWorkspace.ts";

interface WorkflowEnrollmentScope extends WorkflowVmPreparationScope {
  readonly restore?: true;
  readonly runnerTemplateRef?: string;
}

/** Replace the restore placeholder only with its fresh, durably installed narrow
 * credential. The operation remains held through native/history import and setup. */
export function makeThreadVmRestoreEnrollmentStore(sql: PgClient) {
  const withWorkflowEnrollment = <A, E, R>(
    input: {
      operationId: string;
      allocationId: string;
      threadId?: string;
      generation?: number;
    },
    use: (scope: WorkflowEnrollmentScope) => Effect.Effect<A, E, R>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const [hint] = yield* sql<{
          workflowJobId: string | null;
          threadId: string;
          generation: number | null;
        }>`SELECT t.workflow_job_id AS "workflowJobId",r.thread_id AS "threadId",r.target_generation AS generation
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        WHERE r.operation_id=${input.operationId} AND r.allocation_id=${input.allocationId}`;
        if (!hint) return yield* withPreparingWorkflowVm(sql, input, use);
        if (
          !hint.workflowJobId ||
          !hint.generation ||
          (input.threadId !== undefined && input.threadId !== hint.threadId) ||
          (input.generation !== undefined && input.generation !== hint.generation)
        )
          return yield* new ThreadVmEnrollmentInvalid();
        const job = yield* lockWorkflowVmCheckpoint(sql, hint.workflowJobId);
        const codexConnectionId = job?.record.vmAdmission?.codexConnectionId;
        if (
          !job ||
          !codexConnectionId ||
          job.record.runtime?.kind !== "vm" ||
          job.record.runtime.threadId !== hint.threadId
        )
          return yield* new ThreadVmEnrollmentInvalid();
        const [scope] = yield* sql<{
          checkpoint: RelayThreadVmWorkflowCheckpoint;
          actorUserId: string;
          issued: boolean;
          runnerTemplateRef: string;
        }>`SELECT backup.native_capture_receipt#>'{source,workflowCheckpoint}' AS checkpoint,
        r.actor_user_id AS "actorUserId",e.environment_id IS NOT NULL AS issued, initial.template_id AS "runnerTemplateRef"
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
        JOIN relay_thread_vm_capacity capacity ON capacity.operation_id=r.operation_id AND capacity.allocation_id=a.allocation_id
        JOIN relay_thread_vm_saved_disks s ON s.operation_id=r.saved_disk_operation_id
        JOIN relay_thread_vm_backups backup ON backup.operation_id=s.backup_operation_id
        JOIN relay_thread_vm_allocations initial ON initial.thread_id=t.thread_id AND initial.organization_id=t.organization_id
        JOIN relay_thread_vm_provisions runner ON runner.allocation_id=initial.allocation_id
        LEFT JOIN relay_thread_vm_enrollments e ON e.allocation_id=a.allocation_id
        WHERE r.operation_id=${input.operationId} AND r.allocation_id=${input.allocationId}
          AND r.thread_id=${hint.threadId} AND r.target_generation=${hint.generation}
          AND r.serving_requested AND r.phase IN ('booted','importing') AND r.bootstrap_receipt IS NOT NULL
          AND r.boot_ingress_recovery_claim_id IS NULL AND r.boot_recovery_started_at IS NULL
          AND t.operation_id=r.operation_id AND t.generation=r.target_generation
          AND t.audience='repository' AND t.owner_user_id IS NULL AND t.workflow_job_id=${job.jobId}
          AND t.repository_id=${job.repositoryId} AND t.organization_id=${job.organizationId}
          AND a.owner_user_id IS NULL AND a.organization_id=t.organization_id AND a.thread_id=t.thread_id
          AND a.runtime_protocol='native-v1' AND a.resource_kind='organization_workflow'
          AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref=r.boot_receipt->>'sandboxId'
          AND p.operation_id=r.operation_id AND p.phase='created' AND p.generation=t.generation
          AND capacity.state='started' AND capacity.compute_ref=a.compute_ref
          AND s.phase='restoring' AND s.restore_operation_id=r.operation_id AND s.restore_allocation_id=a.allocation_id
          AND backup.phase='verified' AND backup.native_capture_receipt#>>'{source,workflowCheckpoint,jobId}'=${job.jobId}
          AND initial.resource_kind='organization_workflow' AND runner.generation=1
          AND runner.workflow_snapshot=p.workflow_snapshot
          AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
        FOR SHARE OF r,s,backup,runner,initial`;
        if (!scope) return yield* new ThreadVmEnrollmentInvalid();
        if (!scope.issued) {
          const response = yield* authorizeWorkflowVmCheckpoint(sql, job);
          if (
            response?.responseId !== input.operationId ||
            response.userId !== scope.actorUserId ||
            response.checkpoint.checkpointId !== scope.checkpoint.checkpointId ||
            (response.checkpoint.generation ?? 0) !== scope.checkpoint.checkpointGeneration ||
            !(yield* readCurrentWorkflowCheckpoint(sql, scope.checkpoint))
          )
            return yield* new ThreadVmEnrollmentInvalid();
        }
        return yield* use({
          workflowJobId: job.jobId,
          organizationId: job.organizationId,
          repositoryId: job.repositoryId,
          codexConnectionId,
          restore: true,
          runnerTemplateRef: scope.runnerTemplateRef,
        });
      }),
    );
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
        AND a.runtime_protocol='native-v1' AND a.resource_kind='personal'
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
          workflowJobId: string | null;
          recoveryBlocked: boolean;
        }>`
        SELECT r.phase,r.target_generation AS "targetGeneration",r.actor_user_id AS "actorUserId",t.workflow_job_id AS "workflowJobId",
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
          AND t.generation=${receipt.generation} AND a.organization_id=t.organization_id
          AND ${
            restore.workflowJobId
              ? sql`t.audience='repository' AND t.owner_user_id IS NULL AND t.workflow_job_id=${restore.workflowJobId}
                AND a.resource_kind='organization_workflow' AND a.owner_user_id IS NULL AND p.workflow_snapshot IS NOT NULL`
              : sql`t.owner_user_id=${restore.actorUserId} AND a.resource_kind='personal'`
          }
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
  return { requested, assigned, withWorkflowEnrollment };
}
