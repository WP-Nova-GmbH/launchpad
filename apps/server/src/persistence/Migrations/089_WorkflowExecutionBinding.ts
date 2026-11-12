import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { combinedReaderMarker, executionBindingReaderMarker } from "../MigrationCompatibility.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep the old trigger names/marker text readable until a changed-format row
  // is written. A personal database can still be opened by the preceding build.
  yield* sql`DROP TRIGGER workflow_portable_reader_preserve`;
  yield* sql`CREATE TRIGGER workflow_portable_reader_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND (
      (OLD.name = ${sql.literal("'" + executionBindingReaderMarker + "'")} AND NEW.name != ${sql.literal("'" + executionBindingReaderMarker + "'")})
      OR (OLD.name != ${sql.literal("'" + executionBindingReaderMarker + "'")} AND NEW.name != ${sql.literal("'" + combinedReaderMarker + "'")}
        AND NEW.name != ${sql.literal("'" + executionBindingReaderMarker + "'")} AND
        (OLD.name = ${sql.literal("'" + combinedReaderMarker + "'")} OR NEW.name IN
          ('OrchestrationEvents_WorkflowReaderV1','OrchestrationEvents_WorkflowReaderV2','OrchestrationEvents_WorkflowReaderV3',
           'OrchestrationEvents_WorkflowReaderV4','OrchestrationEvents_WorkflowReaderV5','OrchestrationEvents_WorkflowReaderV6',
           'OrchestrationEvents_WorkflowReaderV7','OrchestrationEvents_WorkflowReaderV8','OrchestrationEvents_PortableThreadReaderV1',
           'OrchestrationEvents_ThreadMoveQueueReaderV1','OrchestrationEvents_FrozenCheckpointReaderV1',
           'OrchestrationEvents_TransferAbortReaderV1','OrchestrationEvents_CheckoutCaptureReaderV1','OrchestrationEvents_ThreadCleanupReaderV1'))))
    BEGIN UPDATE effect_sql_migrations SET name = CASE WHEN OLD.name = ${sql.literal("'" + executionBindingReaderMarker + "'")}
      THEN ${sql.literal("'" + executionBindingReaderMarker + "'")} ELSE ${sql.literal("'" + combinedReaderMarker + "'")} END WHERE migration_id = 1; END`;
  for (const operation of ["INSERT", "UPDATE"] as const) {
    yield* sql.unsafe(`CREATE TRIGGER execution_binding_reader_${operation} AFTER ${operation} ON repository_workflow_jobs
      WHEN json_type(NEW.record_json, '$.runtime') IS NOT NULL
        OR json_type(NEW.record_json, '$.workflow.definition.target') IS NOT NULL
      BEGIN UPDATE effect_sql_migrations SET name = '${executionBindingReaderMarker}' WHERE migration_id = 1; END`);
    yield* sql.unsafe(`CREATE TRIGGER execution_binding_slot_${operation} BEFORE ${operation} ON repository_workflow_jobs
      WHEN NEW.execution_reserved = 1 AND (
        COALESCE(json_type(NEW.record_json, '$.runtime.environmentId'), json_type(NEW.record_json, '$.workflow.definition.environmentId'), '') != 'text'
        OR COALESCE(json_extract(NEW.record_json, '$.runtime.environmentId'), json_extract(NEW.record_json, '$.workflow.definition.environmentId'), '') = '')
      BEGIN SELECT RAISE(ABORT, 'A reserved workflow needs a resolved execution environment.'); END`);
  }
  yield* sql`DROP INDEX repository_workflow_execution_slot`;
  yield* sql`CREATE UNIQUE INDEX repository_workflow_execution_slot ON repository_workflow_jobs(
    COALESCE(json_extract(record_json, '$.runtime.environmentId'), json_extract(record_json, '$.workflow.definition.environmentId')))
    WHERE execution_reserved = 1`;
  // Reader activation and conversion occur in the migrator's transaction. No
  // workflow/checkpoint/publication IDs or continuation state are regenerated.
  yield* sql`UPDATE repository_workflow_jobs SET record_json = json_set(
    json_remove(record_json, '$.workflow.definition.environmentId', '$.workflow.definition.projectId'),
    '$.runtime', json_object('kind','machine',
      'environmentId',json_extract(record_json,'$.workflow.definition.environmentId'),
      'projectId',json_extract(record_json,'$.workflow.definition.projectId')),
    '$.workflow.definition.target', json_object('kind','machine',
      'environmentId',json_extract(record_json,'$.workflow.definition.environmentId'),
      'projectId',json_extract(record_json,'$.workflow.definition.projectId')))
    WHERE json_type(record_json,'$.workflow.definition.target') IS NULL
      AND json_type(record_json,'$.workflow.definition.environmentId') = 'text'
      AND json_type(record_json,'$.workflow.definition.projectId') = 'text'`;
  const unresolved = yield* sql`SELECT 1 FROM repository_workflow_jobs WHERE execution_reserved = 1
    AND (COALESCE(json_type(record_json,'$.runtime.environmentId'),json_type(record_json,'$.workflow.definition.environmentId'),'') != 'text'
      OR COALESCE(json_extract(record_json,'$.runtime.environmentId'),json_extract(record_json,'$.workflow.definition.environmentId'),'') = '') LIMIT 1`;
  if (unresolved.length)
    return yield* Effect.die("A reserved workflow has no resolved execution environment.");
  yield* sql`UPDATE effect_sql_migrations SET name = ${executionBindingReaderMarker}
    WHERE migration_id = 1 AND EXISTS (SELECT 1 FROM repository_workflow_jobs
      WHERE json_type(record_json,'$.runtime') IS NOT NULL
        OR json_type(record_json,'$.workflow.definition.target') IS NOT NULL)`;
});
