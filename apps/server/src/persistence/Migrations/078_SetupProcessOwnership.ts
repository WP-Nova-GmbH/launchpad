import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE setup_processes (
    thread_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(thread_id, attempt_id)
  )`;
  yield* sql`CREATE TABLE setup_process_cleanup (
    thread_id TEXT NOT NULL, attempt_id TEXT NOT NULL, command_id TEXT NOT NULL,
    state TEXT NOT NULL, detail TEXT, PRIMARY KEY(thread_id, attempt_id, command_id)
  )`;
  for (const table of ["repository_workflow_jobs", "repository_workflow_cancellations"])
    yield* sql`DROP TRIGGER ${sql("workflow_reader_barrier_" + table)}`;
  yield* sql`DROP TRIGGER workflow_reader_barrier_preserve`;
  for (const table of [
    "repository_workflow_jobs",
    "repository_workflow_cancellations",
    "setup_processes",
  ]) {
    yield* sql`CREATE TRIGGER ${sql("workflow_reader_barrier_" + table)} AFTER INSERT ON ${sql(table)}
      BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV3' WHERE migration_id = 1; END`;
  }
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name != 'OrchestrationEvents_WorkflowReaderV3'
      AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
        OR EXISTS (SELECT 1 FROM setup_processes))
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV3' WHERE migration_id = 1; END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV3'
    WHERE migration_id = 1 AND (EXISTS (SELECT 1 FROM repository_workflow_jobs)
      OR EXISTS (SELECT 1 FROM repository_workflow_cancellations))`;
});
