import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workflow_result_outbox (
    publication_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    binding_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    result_json TEXT,
    source_sequence INTEGER NOT NULL,
    state_artifact_id TEXT NOT NULL,
    patch_artifact_id TEXT NOT NULL,
    manifest_artifact_id TEXT NOT NULL,
    native_operation_id TEXT,
    manifest_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','failed','acknowledged')),
    started_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL,
    detail TEXT,
    stage TEXT NOT NULL DEFAULT 'waiting for storage',
    permanent INTEGER NOT NULL DEFAULT 0,
    UNIQUE(job_id, revision)
  )`;
  yield* sql`CREATE INDEX workflow_outbox_pending ON workflow_result_outbox(thread_id,revision)
    WHERE status!='acknowledged'`;
});
