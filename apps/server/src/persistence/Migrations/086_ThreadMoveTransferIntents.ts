import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_move_transfer_intents (
    operation_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES thread_execution_fences(thread_id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    source_formats_json TEXT NOT NULL CHECK(json_valid(source_formats_json)),
    encoding_policy TEXT CHECK(encoding_policy IN ('v1-64MiB','workspace-raw-v2-8MiB')),
    manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256)=64)
  )`;
  // Claimed legacy heads may have lost begin's reply before their fence started draining.
  yield* sql`INSERT INTO thread_move_transfer_intents
    (operation_id,thread_id,environment_id,generation,source_formats_json,encoding_policy)
    SELECT json_extract(q.state_json,'$.entries[0].operationId'),q.thread_id,f.environment_id,f.generation,
      '["launchpad-thread-chunks-v1"]','v1-64MiB'
    FROM projection_thread_prompt_queues q JOIN thread_execution_fences f USING(thread_id)
    WHERE json_extract(q.state_json,'$.entries[0].kind')='move'
      AND json_extract(q.state_json,'$.entries[0].state') IN ('moving','blocked','cancelling')
      AND json_extract(q.state_json,'$.entries[0].operationId') IS NOT NULL
      AND (f.phase='active' OR (f.phase IN ('draining','frozen')
        AND f.operation_id=json_extract(q.state_json,'$.entries[0].operationId')))
      AND NOT EXISTS(SELECT 1 FROM thread_transfer_baselines b
        WHERE b.operation_id=json_extract(q.state_json,'$.entries[0].operationId')
          AND b.generation=f.generation)`;
});
