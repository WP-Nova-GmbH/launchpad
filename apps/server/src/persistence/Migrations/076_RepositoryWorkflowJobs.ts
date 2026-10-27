import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE repository_workflow_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,
    execution_reserved INTEGER NOT NULL,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX repository_workflow_jobs_status ON repository_workflow_jobs(status)`;
  // The environment ID scopes this slot even if several IDs are imported into
  // a database. Human reviews release it; uncertain work keeps its reservation.
  yield* sql`CREATE UNIQUE INDEX repository_workflow_execution_slot ON repository_workflow_jobs(json_extract(record_json, '$.workflow.definition.environmentId'))
    WHERE execution_reserved = 1`;
  // Older builds ignore new tables and would allow ordinary chat/git commands
  // to mutate a job's prepared result. Mark the database atomically on acceptance.
  yield* sql`CREATE TRIGGER workflow_reader_barrier AFTER INSERT ON repository_workflow_jobs
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV1' WHERE migration_id = 1;
    END`;
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name IN ('OrchestrationEvents', 'OrchestrationEvents_SharedThreadReaderV1', 'OrchestrationEvents_SharedThreadReaderV2', 'OrchestrationEvents_ThreadCleanupReaderV1')
      AND EXISTS (SELECT 1 FROM repository_workflow_jobs)
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV1' WHERE migration_id = 1;
    END`;
});
