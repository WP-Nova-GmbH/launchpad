import type { PgClient } from "@effect/sql-pg/PgClient";

/** Source holds for the current allocation `a` and placement `t`, matching inbox admission. */
export const threadVmSourceActivationPending = (sql: PgClient) => sql`(
  EXISTS(SELECT 1 FROM relay_thread_vm_pauses x
    WHERE x.allocation_id=a.allocation_id AND x.generation=t.generation
      AND (x.phase IN ('pending','sealed')
        OR (x.phase IN ('cancelled','completed') AND x.source_reopened_at IS NULL)))
  OR EXISTS(SELECT 1 FROM relay_thread_vm_backups x
    WHERE x.allocation_id=a.allocation_id AND x.generation=t.generation AND x.source_reopened_at IS NULL
      AND (x.phase IN ('pending','creating') OR x.source_receipt IS NOT NULL
        OR (x.phase='failed' AND x.capture_started_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses p WHERE p.backup_operation_id=x.operation_id))
)`;
