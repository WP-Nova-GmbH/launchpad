import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_native_checkpoints (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    native_thread_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
    archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
    published_artifact_id TEXT,
    PRIMARY KEY (thread_id, generation, turn_id)
  )`;
});
