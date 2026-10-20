import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/** Call under the owner's quota advisory lock. A live victim already occupies the
 * slot; after its confirmed deletion the waiting replacement occupies it instead. */
export const threadVmQuotaUsage = Effect.fnUntraced(function* (
  sql: PgClient,
  ownerUserId: string,
  consumingRequestId: string | null = null,
) {
  const [usage] = yield* sql<{ count: number }>`SELECT (
    (SELECT count(*) FROM relay_thread_vm_allocations WHERE owner_user_id=${ownerUserId} AND deleted_at IS NULL) +
    (SELECT count(*) FROM relay_thread_vm_replacements r
      JOIN relay_thread_vm_allocations victim ON victim.allocation_id=r.victim_allocation_id
      WHERE r.owner_user_id=${ownerUserId} AND r.phase='waiting' AND victim.deleted_at IS NOT NULL
        AND r.request_id IS DISTINCT FROM ${consumingRequestId}
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations incoming
          WHERE incoming.allocation_id=(CASE r.intent_json::jsonb->>'kind' WHEN 'move' THEN r.request_id ELSE r.intent_json::jsonb#>>'{request,allocationId}' END) AND incoming.deleted_at IS NULL))
    )::int AS count`;
  return usage?.count ?? 0;
});
