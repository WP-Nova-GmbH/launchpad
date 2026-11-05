import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { combinedReaderMarker } from "../MigrationCompatibility.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The older sticky guards can fight each other when both kinds of work exist.
  yield* sql`DROP TRIGGER IF EXISTS workflow_reader_barrier_preserve`;
  yield* sql`DROP TRIGGER IF EXISTS checkout_capture_preserve_reader_barrier`;
  yield* sql`CREATE TRIGGER workflow_portable_reader_preserve AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id = 1 AND NEW.name != ${sql.literal("'" + combinedReaderMarker + "'")}
      AND (OLD.name = ${sql.literal("'" + combinedReaderMarker + "'")} OR NEW.name IN
        ('OrchestrationEvents_WorkflowReaderV1','OrchestrationEvents_WorkflowReaderV2','OrchestrationEvents_WorkflowReaderV3',
        'OrchestrationEvents_WorkflowReaderV4','OrchestrationEvents_WorkflowReaderV5','OrchestrationEvents_WorkflowReaderV6',
        'OrchestrationEvents_WorkflowReaderV7','OrchestrationEvents_WorkflowReaderV8','OrchestrationEvents_PortableThreadReaderV1',
        'OrchestrationEvents_ThreadMoveQueueReaderV1','OrchestrationEvents_FrozenCheckpointReaderV1',
        'OrchestrationEvents_TransferAbortReaderV1','OrchestrationEvents_CheckoutCaptureReaderV1','OrchestrationEvents_ThreadCleanupReaderV1'))
    BEGIN UPDATE effect_sql_migrations SET name = ${sql.literal("'" + combinedReaderMarker + "'")} WHERE migration_id = 1; END`;
  // Include historical activation even when all protected rows have been pruned.
  yield* sql`UPDATE effect_sql_migrations SET name = ${combinedReaderMarker} WHERE migration_id = 1 AND
    (name NOT IN ('OrchestrationEvents','OrchestrationEvents_SharedThreadReaderV1','OrchestrationEvents_SharedThreadReaderV2')
    OR EXISTS(SELECT 1 FROM repository_workflow_jobs) OR EXISTS(SELECT 1 FROM repository_workflow_cancellations)
    OR EXISTS(SELECT 1 FROM setup_processes) OR EXISTS(SELECT 1 FROM thread_cleanup_fences)
    OR EXISTS(SELECT 1 FROM thread_execution_fences) OR EXISTS(SELECT 1 FROM thread_transfer_baselines)
    OR EXISTS(SELECT 1 FROM thread_native_checkpoints) OR EXISTS(SELECT 1 FROM thread_transfer_aborts)
    OR EXISTS(SELECT 1 FROM checkout_capture_holds) OR EXISTS(SELECT 1 FROM checkout_work_admissions))`;
});
