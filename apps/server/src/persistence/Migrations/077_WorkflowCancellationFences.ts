import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE repository_workflow_cancellations (
    job_id TEXT PRIMARY KEY NOT NULL,
    record_json TEXT NOT NULL
  )`;
  yield* sql`DROP TRIGGER workflow_reader_barrier`;
  yield* sql`DROP TRIGGER workflow_reader_barrier_preserve`;
  for (const table of ["repository_workflow_jobs", "repository_workflow_cancellations"]) {
    yield* sql`CREATE TRIGGER ${sql(`workflow_reader_barrier_${table}`)} AFTER INSERT ON ${sql(table)}
      BEGIN
        UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV2' WHERE migration_id = 1;
      END`;
  }
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name != 'OrchestrationEvents_WorkflowReaderV2'
      AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations))
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV2' WHERE migration_id = 1;
    END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV2'
    WHERE migration_id = 1 AND EXISTS (SELECT 1 FROM repository_workflow_jobs)`;
});
