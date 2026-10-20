import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/** Advisory only. Replacing a VM must recheck owner, access, idleness and quota under locks. */
export function makeThreadVmReplacementStore(sql: PgClient) {
  const list = Effect.fn("relay.thread_vm.replacement.list")(function* (ownerUserId: string) {
    const candidates = yield* sql<{
      allocationId: string;
      threadId: string;
      state: "running" | "paused";
      title: string | null;
    }>`SELECT a.allocation_id AS "allocationId", a.thread_id AS "threadId", a.state,title.value AS title
      FROM relay_thread_vm_allocations a
      JOIN relay_thread_placements t ON t.thread_id = a.thread_id
      JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
        AND b.generation = t.generation AND b.environment_id = t.environment_id
        AND b.revoked_at IS NULL
      JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id AND p.phase='created'
      JOIN relay_thread_vm_ready s ON s.allocation_id = a.allocation_id AND s.phase = 'ready'
      JOIN relay_repositories repository ON repository.repository_id=t.repository_id AND repository.organization_id=t.organization_id
      JOIN relay_organization_members m ON m.organization_id = a.organization_id
        AND m.user_id = ${ownerUserId}
      LEFT JOIN relay_repository_access grant_row ON grant_row.repository_id = t.repository_id
        AND grant_row.organization_id = a.organization_id AND grant_row.user_id = ${ownerUserId}
      LEFT JOIN relay_thread_vm_activity v ON v.allocation_id = a.allocation_id
      LEFT JOIN relay_thread_vm_pauses pause ON pause.allocation_id = a.allocation_id
      LEFT JOIN LATERAL(SELECT event_json->'payload'->>'title' AS value FROM relay_thread_history
        WHERE thread_id=a.thread_id AND event_json->>'type' IN('thread.created','thread.meta-updated')
          AND event_json->'payload'->>'title' IS NOT NULL ORDER BY cursor DESC LIMIT 1) title ON true
      WHERE a.owner_user_id = ${ownerUserId} AND t.owner_user_id = ${ownerUserId}
        AND a.deleted_at IS NULL AND t.operation_id IS NULL
        AND (m.role = 'admin' OR grant_row.user_id IS NOT NULL)
        AND v.idle_since IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x WHERE x.allocation_id=a.allocation_id
          AND x.phase IN ('pending','creating','captured','verifying','cleanup'))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes resume
          WHERE resume.allocation_id = a.allocation_id AND resume.phase IN ('waiting','resuming'))
        AND NOT EXISTS (SELECT 1 FROM relay_thread_commands q
          WHERE q.thread_id = a.thread_id AND q.receipt_json IS NULL)
        AND NOT EXISTS (SELECT 1 FROM relay_thread_execution_admissions e
          WHERE e.thread_id = a.thread_id AND e.generation = t.generation AND e.completed = false
            AND NOT (a.state='running' AND e.environment_id=t.environment_id AND jsonb_exists(v.inactive_work_ids,e.work_id)))
        AND ((a.state = 'paused' AND pause.phase = 'completed' AND pause.generation=t.generation
          AND pause.source_frozen_at IS NOT NULL AND pause.native_checkpoint_operation_id IS NOT NULL AND pause.source_reopened_at IS NULL
          AND EXISTS(SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id
            AND c.state='released' AND c.position=(SELECT max(position) FROM relay_thread_vm_capacity WHERE allocation_id=a.allocation_id))) OR
          (a.state = 'running' AND v.activity = 'idle'
            AND v.observed_at >= clock_timestamp() - interval '2 minutes'
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses pending
              WHERE pending.allocation_id = a.allocation_id AND (pending.phase IN ('pending','sealed') OR (pending.phase='cancelled' AND pending.source_reopened_at IS NULL)))
            AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c
              WHERE c.allocation_id = a.allocation_id AND c.state = 'started')))
      ORDER BY v.last_work_at ASC NULLS FIRST, v.idle_since ASC NULLS FIRST,
        a.allocation_id LIMIT 20`;
    return candidates;
  });
  const suggest = (ownerUserId: string) =>
    list(ownerUserId).pipe(Effect.map((rows) => rows[0] ?? null));
  return { list, suggest };
}
