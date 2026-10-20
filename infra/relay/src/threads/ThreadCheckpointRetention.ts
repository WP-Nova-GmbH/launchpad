import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/** Call under the placement lock. Pending chat uploads cannot retire the last complete recovery point. */
export const retireThreadCheckpoints = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
) {
  const retired = yield* sql<{ operationId: string }>`WITH keep AS (
    (SELECT operation_id FROM relay_thread_native_checkpoints
      WHERE thread_id=${threadId} AND retained
      ORDER BY generation DESC,source_sequence DESC,published_at DESC,operation_id DESC LIMIT 2)
    UNION
    (SELECT n.operation_id FROM relay_thread_native_checkpoints n
      JOIN relay_thread_attachment_checkpoints a ON a.native_checkpoint_operation_id=n.operation_id
      WHERE n.thread_id=${threadId} AND n.retained
      ORDER BY n.generation DESC,n.source_sequence DESC,n.published_at DESC,n.operation_id DESC LIMIT 1)
  ) UPDATE relay_thread_native_checkpoints SET retained=false
    WHERE thread_id=${threadId} AND retained AND operation_id NOT IN (SELECT operation_id FROM keep)
    RETURNING operation_id AS "operationId"`;
  for (const old of retired) {
    yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${`native-checkpoint:${old.operationId}`}`;
    yield* sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()
      WHERE thread_id=${threadId} AND state='complete' AND (operation_id=${old.operationId}
        OR operation_id IN (SELECT operation_id FROM relay_thread_attachment_checkpoints
          WHERE native_checkpoint_operation_id=${old.operationId}))`;
  }
});
