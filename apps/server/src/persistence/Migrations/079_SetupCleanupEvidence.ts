import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE setup_processes SET record_json = json_set(record_json, '$.exited', json('false'))
    WHERE COALESCE(json_extract(record_json, '$.evidence.protocol'), 0) != 4`;
  yield* sql`UPDATE setup_process_cleanup SET state = 'pending', detail = NULL WHERE state = 'done'
    AND NOT EXISTS (SELECT 1 FROM setup_processes p WHERE p.thread_id = setup_process_cleanup.thread_id
      AND p.attempt_id = setup_process_cleanup.attempt_id AND json_extract(p.record_json, '$.evidence.protocol') = 4)`;
  for (const intent of ["approvalAttempt", "cancellationAttempt"]) {
    const state = `$.${intent}.setupCleanup.state`;
    const attempt = `$.${intent}.setupCleanup.attemptId`;
    yield* sql`UPDATE repository_workflow_jobs SET record_json = json_set(record_json, ${state}, 'pending')
      WHERE status NOT IN ('done', 'cancelled', 'failed') AND json_extract(record_json, ${state}) = 'done'
      AND NOT EXISTS (SELECT 1 FROM setup_processes p WHERE p.thread_id = repository_workflow_jobs.thread_id
        AND p.attempt_id = json_extract(repository_workflow_jobs.record_json, ${attempt})
        AND json_extract(p.record_json, '$.evidence.protocol') = 4)`;
  }
  const tables = [
    "repository_workflow_jobs",
    "repository_workflow_cancellations",
    "setup_processes",
  ];
  for (const table of tables) yield* sql`DROP TRIGGER ${sql("workflow_reader_barrier_" + table)}`;
  yield* sql`DROP TRIGGER workflow_reader_barrier_preserve`;
  for (const table of tables)
    yield* sql`CREATE TRIGGER ${sql("workflow_reader_barrier_" + table)} AFTER INSERT ON ${sql(table)}
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV4' WHERE migration_id = 1; END`;
  yield* sql`CREATE TRIGGER workflow_reader_barrier_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name != 'OrchestrationEvents_WorkflowReaderV4'
      AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
        OR EXISTS (SELECT 1 FROM setup_processes))
    BEGIN UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV4' WHERE migration_id = 1; END`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV4' WHERE migration_id = 1
    AND (EXISTS (SELECT 1 FROM repository_workflow_jobs) OR EXISTS (SELECT 1 FROM repository_workflow_cancellations)
      OR EXISTS (SELECT 1 FROM setup_processes))`;
});
