import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_transfer_aborts (
    operation_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0),
    UNIQUE(thread_id,generation,operation_id)
  )`;
  const triggers = yield* sql<{
    name: string;
    definition: string;
  }>`SELECT name,sql AS definition FROM sqlite_master WHERE type='trigger'
    AND name IN ('thread_move_queue_reader_barrier','thread_move_baseline_reader_barrier','portable_thread_reader_barrier',
      'thread_cleanup_fence_on_delete','frozen_checkpoint_reader_barrier')`;
  for (const trigger of triggers) {
    if (!/WHERE migration_id\s*=\s*1/u.test(trigger.definition))
      return yield* Effect.die("Reader barrier definition changed");
    yield* sql.unsafe(`DROP TRIGGER "${trigger.name}"`);
    yield* sql.unsafe(
      trigger.definition.replace(
        /WHERE migration_id\s*=\s*1/u,
        "WHERE migration_id = 1 AND name != 'OrchestrationEvents_TransferAbortReaderV1'",
      ),
    );
  }
  yield* sql`CREATE TRIGGER transfer_abort_reader_barrier AFTER INSERT ON thread_transfer_aborts BEGIN
    UPDATE effect_sql_migrations SET name='OrchestrationEvents_TransferAbortReaderV1' WHERE migration_id=1;
  END`;
});
