import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_execution_fences (
    thread_id TEXT PRIMARY KEY NOT NULL,
    relay_url TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('active', 'draining', 'frozen', 'retired')),
    frozen_sequence INTEGER CHECK (frozen_sequence >= 0)
  )`;
  yield* sql`CREATE INDEX thread_execution_fences_held_project
    ON thread_execution_fences(project_id) WHERE phase IN ('frozen', 'retired')`;
  yield* sql`CREATE TABLE thread_relay_command_deliveries (
    command_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES thread_execution_fences(thread_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    position INTEGER NOT NULL CHECK (position > 0),
    entry_json TEXT NOT NULL,
    normalized_json TEXT,
    receipt_json TEXT,
    settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
    UNIQUE(thread_id, generation, position)
  )`;
  yield* sql`CREATE INDEX thread_relay_command_deliveries_pending
    ON thread_relay_command_deliveries(thread_id, generation, position) WHERE settled = 0`;
  yield* sql`CREATE TABLE thread_relay_history_cursors (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_execution_fences(thread_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence >= 0)
  )`;
  yield* sql`CREATE TABLE thread_execution_work (
    thread_id TEXT NOT NULL REFERENCES thread_execution_fences(thread_id),
    work_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL CHECK (kind IN ('provider', 'terminal', 'setup', 'workspace')),
    started INTEGER NOT NULL DEFAULT 1 CHECK (started IN (0, 1)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    relay_completed INTEGER NOT NULL DEFAULT 0 CHECK (relay_completed IN (0, 1)),
    PRIMARY KEY (thread_id, work_id)
  )`;
  yield* sql`CREATE INDEX thread_execution_work_pending
    ON thread_execution_work(thread_id) WHERE completed = 0`;
  yield* sql`CREATE TRIGGER portable_thread_reader_barrier AFTER INSERT ON thread_execution_fences
    BEGIN
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_PortableThreadReaderV1'
        WHERE migration_id = 1;
    END`;
  // Deleting any thread must not downgrade a database that contains portable ownership.
  yield* sql`DROP TRIGGER thread_cleanup_fence_on_delete`;
  yield* sql`CREATE TRIGGER thread_cleanup_fence_on_delete
    AFTER INSERT ON orchestration_events WHEN NEW.event_type = 'thread.deleted'
    BEGIN
      INSERT OR IGNORE INTO thread_cleanup_fences (thread_id, deletion_sequence)
        VALUES (NEW.stream_id, NEW.sequence);
      UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_ThreadCleanupReaderV1'
        WHERE migration_id = 1 AND name != 'OrchestrationEvents_PortableThreadReaderV1';
    END`;
});
