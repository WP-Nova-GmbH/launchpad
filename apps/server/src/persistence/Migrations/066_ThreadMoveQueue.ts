import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Older readers accept the same event type but discard ordering or cannot
  // understand a move. Mark the database in the event's own transaction.
  yield* sql`CREATE TRIGGER thread_move_queue_reader_barrier
    AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.prompt-queue-changed' AND
      (json_extract(NEW.payload_json, '$.entry.kind') = 'move' OR
       json_type(NEW.payload_json, '$.order') = 'array')
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadMoveQueueReaderV1'
        WHERE migration_id = 1;
    END`;
  // A transfer baseline imports its queue without re-inserting every source
  // event. Protect that path too, including explicitly reordered prompt queues.
  yield* sql`CREATE TRIGGER thread_move_baseline_reader_barrier
    AFTER INSERT ON thread_transfer_baselines
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadMoveQueueReaderV1'
        WHERE migration_id = 1;
    END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadMoveQueueReaderV1'
    WHERE migration_id = 1 AND EXISTS (SELECT 1 FROM thread_transfer_baselines)`;
  yield* sql`DROP TRIGGER portable_thread_reader_barrier`;
  yield* sql`CREATE TRIGGER portable_thread_reader_barrier AFTER INSERT ON thread_execution_fences
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_PortableThreadReaderV1'
        WHERE migration_id = 1 AND name != 'OrchestrationEvents_ThreadMoveQueueReaderV1';
    END`;
  yield* sql`DROP TRIGGER thread_cleanup_fence_on_delete`;
  yield* sql`CREATE TRIGGER thread_cleanup_fence_on_delete
    AFTER INSERT ON orchestration_events WHEN NEW.event_type = 'thread.deleted'
    BEGIN
      INSERT OR IGNORE INTO thread_cleanup_fences (thread_id, deletion_sequence)
        VALUES (NEW.stream_id, NEW.sequence);
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadCleanupReaderV1'
        WHERE migration_id = 1 AND name NOT IN
          ('OrchestrationEvents_PortableThreadReaderV1', 'OrchestrationEvents_ThreadMoveQueueReaderV1');
    END`;
});
