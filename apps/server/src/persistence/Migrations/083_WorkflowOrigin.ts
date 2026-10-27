import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN workflow_origin_json TEXT`;
  yield* sql`UPDATE repository_workflow_jobs SET record_json = json_set(record_json, '$.origin',
    json_object('kind','manual','userId',json_extract(record_json,'$.userId')))
    WHERE json_type(record_json,'$.origin') IS NULL AND json_type(record_json,'$.userId') = 'text'
      AND length(trim(json_extract(record_json,'$.userId'))) > 0`;
  const tables = [
    "repository_workflow_jobs",
    "repository_workflow_cancellations",
    "setup_processes",
    "thread_cleanup_fences",
  ];
  for (const table of tables) {
    yield* sql`DROP TRIGGER IF EXISTS ${sql("workflow_reader_barrier_" + table)}`;
    yield* sql`CREATE TRIGGER ${sql("workflow_reader_barrier_" + table)} AFTER INSERT ON ${sql(table)}
      BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV8' WHERE migration_id = 1; END`;
  }
  // Once activated, the marker must survive projection rebuilds and terminal-history cleanup.
  yield* sql`DROP TRIGGER workflow_reader_barrier_preserve`;
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND OLD.name = 'OrchestrationEvents_WorkflowReaderV8' AND NEW.name != OLD.name
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV8' WHERE migration_id = 1; END`;
  for (const operation of ["INSERT", "UPDATE"]) {
    yield* sql`CREATE TRIGGER ${sql("workflow_attribution_barrier_" + operation)} AFTER ${sql.literal(operation)} ON projection_thread_messages
      WHEN NEW.workflow_origin_json IS NOT NULL
      BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV8' WHERE migration_id = 1; END`;
  }
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV8' WHERE migration_id = 1
    AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
      OR EXISTS (SELECT 1 FROM setup_processes) OR EXISTS (SELECT 1 FROM thread_cleanup_fences))`;
});
