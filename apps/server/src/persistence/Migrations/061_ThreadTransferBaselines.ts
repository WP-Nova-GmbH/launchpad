import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_transfer_baselines (
    operation_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES thread_execution_fences(thread_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    manifest_sha256 TEXT NOT NULL,
    history_sha256 TEXT NOT NULL,
    receipts_sha256 TEXT NOT NULL,
    source_environment_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    destination_sequence INTEGER NOT NULL CHECK (destination_sequence > 0),
    UNIQUE(thread_id, generation)
  )`;
});
