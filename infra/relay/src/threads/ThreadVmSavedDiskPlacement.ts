import type { PgClient } from "@effect/sql-pg/PgClient";

/** SQL predicate for outer saved-disk `s` and placement `t` rows. Cancelling a
 * committed restore advances ownership, but never relabels the retained source. */
export const savedDiskHasCancelledRestorePlacement = (sql: PgClient) => sql`
  s.generation<t.generation AND EXISTS(
    SELECT 1 FROM relay_thread_vm_restores cancelled
    JOIN relay_thread_vm_allocations target ON target.allocation_id=cancelled.allocation_id
    JOIN relay_thread_vm_backups backup ON backup.operation_id=s.backup_operation_id
    JOIN relay_thread_vm_allocations source ON source.allocation_id=backup.allocation_id
    WHERE cancelled.saved_disk_operation_id=s.operation_id AND cancelled.thread_id=t.thread_id
      AND cancelled.phase='aborted'
      AND cancelled.committed_at IS NOT NULL AND cancelled.target_generation=t.generation
      AND cancelled.allocation_id=substring(t.environment_id FROM length('pending-restore:')+1)
      AND t.environment_id='pending-restore:'||cancelled.allocation_id
      AND target.thread_id=t.thread_id
      AND target.state='deleted' AND target.deleted_at IS NOT NULL AND target.runtime_protocol='native-v1'
      AND source.thread_id=t.thread_id AND source.runtime_protocol='native-v1'
      AND ((t.audience='private' AND cancelled.actor_user_id=t.owner_user_id
        AND target.owner_user_id=t.owner_user_id AND source.owner_user_id=t.owner_user_id)
      OR (t.audience='repository' AND t.owner_user_id IS NULL
        AND backup.source_receipt#>>'{workflowCheckpoint,jobId}'=t.workflow_job_id
        AND target.resource_kind='organization_workflow' AND target.owner_user_id IS NULL
        AND source.resource_kind='organization_workflow' AND source.owner_user_id IS NULL
        AND target.organization_id=t.organization_id AND source.organization_id=t.organization_id
        AND source.state='deleted' AND source.deleted_at IS NOT NULL
        AND cancelled.source_generation=s.generation
        AND cancelled.boot_create_started_at IS NULL AND cancelled.boot_receipt IS NULL
        AND cancelled.boot_ingress_recovery_claim_id IS NULL AND target.compute_ref IS NULL))
      AND backup.generation=s.generation AND backup.native_capture_receipt IS NOT NULL
  )`;
