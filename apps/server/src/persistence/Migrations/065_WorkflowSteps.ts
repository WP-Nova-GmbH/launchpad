import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS repository_workflow_jobs_status ON repository_workflow_jobs (status, job_id)`;
  const tables = [
    "repository_workflow_jobs",
    "repository_workflow_cancellations",
    "setup_processes",
    "thread_cleanup_fences",
  ];
  for (const table of tables)
    yield* sql`DROP TRIGGER IF EXISTS ${sql("workflow_reader_barrier_" + table)}`;
  yield* sql`DROP TRIGGER workflow_reader_barrier_preserve`;
  for (const table of tables)
    yield* sql`CREATE TRIGGER ${sql("workflow_reader_barrier_" + table)} AFTER INSERT ON ${sql(table)}
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV6' WHERE migration_id = 1; END`;
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name != 'OrchestrationEvents_WorkflowReaderV6'
      AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
        OR EXISTS (SELECT 1 FROM setup_processes) OR EXISTS (SELECT 1 FROM thread_cleanup_fences))
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV6' WHERE migration_id = 1; END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV6' WHERE migration_id = 1
    AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
      OR EXISTS (SELECT 1 FROM setup_processes) OR EXISTS (SELECT 1 FROM thread_cleanup_fences))`;
});
