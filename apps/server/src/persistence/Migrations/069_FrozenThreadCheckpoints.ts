import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_native_checkpoints_v2 (
    thread_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0), checkpoint_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, capture_operation_id TEXT, environment_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK(source_sequence>=0), native_thread_id TEXT NOT NULL,
    directory TEXT NOT NULL, manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),
    archive_sha256 TEXT NOT NULL CHECK(length(archive_sha256)=64), published_artifact_id TEXT,
    PRIMARY KEY(thread_id,generation,checkpoint_id)
  )`;
  yield* sql`INSERT INTO thread_native_checkpoints_v2
    SELECT thread_id,generation,turn_id,turn_id,NULL,environment_id,source_sequence,native_thread_id,
      directory,manifest_sha256,archive_sha256,published_artifact_id FROM thread_native_checkpoints`;
  yield* sql`CREATE TABLE thread_attachment_checkpoints_v2 (
    thread_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0), checkpoint_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, environment_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>=0),
    directory TEXT NOT NULL, manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64),published_artifact_id TEXT,
    PRIMARY KEY(thread_id,generation,checkpoint_id),
    FOREIGN KEY(thread_id,generation,checkpoint_id) REFERENCES thread_native_checkpoints_v2(thread_id,generation,checkpoint_id)
  )`;
  yield* sql`INSERT INTO thread_attachment_checkpoints_v2
    SELECT thread_id,generation,turn_id,turn_id,environment_id,source_sequence,directory,manifest_sha256,published_artifact_id
      FROM thread_attachment_checkpoints`;
  yield* sql`DROP TABLE thread_attachment_checkpoints`;
  yield* sql`DROP TABLE thread_native_checkpoints`;
  yield* sql`ALTER TABLE thread_native_checkpoints_v2 RENAME TO thread_native_checkpoints`;
  yield* sql`ALTER TABLE thread_attachment_checkpoints_v2 RENAME TO thread_attachment_checkpoints`;
  // Preserve the strongest reader barrier when older event triggers run later.
  const barriers = yield* sql<{
    name: string;
    definition: string;
  }>`SELECT name,sql AS definition FROM sqlite_master
    WHERE type='trigger' AND name IN ('thread_move_queue_reader_barrier','thread_move_baseline_reader_barrier',
      'portable_thread_reader_barrier','thread_cleanup_fence_on_delete')`;
  for (const trigger of barriers) {
    if (!trigger.definition.includes("WHERE migration_id = 1"))
      return yield* Effect.die("Reader barrier definition changed");
    yield* sql.unsafe(`DROP TRIGGER "${trigger.name}"`);
    yield* sql.unsafe(
      trigger.definition.replace(
        "WHERE migration_id = 1",
        "WHERE migration_id = 1 AND name != 'OrchestrationEvents_FrozenCheckpointReaderV1'",
      ),
    );
  }
  yield* sql`CREATE TRIGGER frozen_checkpoint_reader_barrier AFTER INSERT ON thread_native_checkpoints
    WHEN NEW.capture_operation_id IS NOT NULL BEGIN
      UPDATE effect_sql_migrations SET name='OrchestrationEvents_FrozenCheckpointReaderV1' WHERE migration_id=1;
    END`;
});
