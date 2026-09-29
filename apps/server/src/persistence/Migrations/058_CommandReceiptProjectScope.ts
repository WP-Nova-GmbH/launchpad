import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(orchestration_command_receipts)`;
  if (!columns.some((column) => column.name === "project_id"))
    yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN project_id TEXT`;

  // V1 readers silently discard durable preparation. Cover updates to existing queues too.
  yield* sql`DROP TRIGGER IF EXISTS shared_thread_reader_barrier`;
  yield* sql`CREATE TRIGGER shared_thread_reader_barrier
    AFTER INSERT ON projection_thread_prompt_queues
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV2'
        WHERE migration_id = 1 AND name IN ('OrchestrationEvents', 'OrchestrationEvents_SharedThreadReaderV1');
    END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS shared_thread_reader_barrier_update
    AFTER UPDATE ON projection_thread_prompt_queues
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV2'
        WHERE migration_id = 1 AND name IN ('OrchestrationEvents', 'OrchestrationEvents_SharedThreadReaderV1');
    END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV2'
    WHERE migration_id = 1 AND (
      name = 'OrchestrationEvents_SharedThreadReaderV1' OR
      (name = 'OrchestrationEvents' AND EXISTS (SELECT 1 FROM projection_thread_prompt_queues))
    )`;
});
