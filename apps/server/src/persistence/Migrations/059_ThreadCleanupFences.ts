import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_cleanup_fences (
    thread_id TEXT NOT NULL,
    deletion_sequence INTEGER NOT NULL,
    process_ids_json TEXT,
    PRIMARY KEY(thread_id, deletion_sequence)
  )`;
  // The fence exists in the deletion transaction, including a crash before a reactor
  // can capture process handles. Unknown ownership must never imply confirmed exit.
  yield* sql`CREATE TRIGGER IF NOT EXISTS thread_cleanup_fence_on_delete
    AFTER INSERT ON orchestration_events WHEN NEW.event_type = 'thread.deleted'
    BEGIN
      INSERT OR IGNORE INTO thread_cleanup_fences (thread_id, deletion_sequence)
        VALUES (NEW.stream_id, NEW.sequence);
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadCleanupReaderV1'
        WHERE migration_id = 1;
    END`;
  yield* sql`INSERT OR IGNORE INTO thread_cleanup_fences (thread_id, deletion_sequence)
    SELECT t.thread_id, COALESCE((SELECT MAX(e.sequence) FROM orchestration_events e
      WHERE e.stream_id = t.thread_id AND e.event_type = 'thread.deleted'), 0)
    FROM projection_threads t JOIN projection_thread_prompt_queues q ON q.thread_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL AND (
      json_extract(q.state_json, '$.preparation.state') = 'running' OR
      json_extract(q.state_json, '$.preparation.settled') = 0
    )`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadCleanupReaderV1'
    WHERE migration_id = 1 AND EXISTS (SELECT 1 FROM thread_cleanup_fences)`;
});
