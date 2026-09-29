import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_prompt_queues (thread_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`;
  // See sharedThreadReaderMarker: the previous reader must refuse this database
  // once shared work exists, even when it ignores this migration's new id.
  yield* sql`CREATE TRIGGER IF NOT EXISTS shared_thread_reader_barrier
    AFTER INSERT ON projection_thread_prompt_queues
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV1'
        WHERE migration_id = 1 AND name = 'OrchestrationEvents';
    END`;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_messages)`;
  if (!columns.some((column) => column.name === "edited_by_json"))
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN edited_by_json TEXT`;
  if (!columns.some((column) => column.name === "steered_by_json"))
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN steered_by_json TEXT`;
});
