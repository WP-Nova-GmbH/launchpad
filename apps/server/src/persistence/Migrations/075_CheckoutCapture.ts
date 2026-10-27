import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE checkout_capture_holds (
    operation_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    checkout_root TEXT NOT NULL,
    git_common_root TEXT NOT NULL,
    admission_sequence INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('draining','capturing','released')),
    release_outcome TEXT CHECK(release_outcome IN ('sealed','failed','cancelled')),
    manifest_sha256 TEXT,
    CHECK((phase='released') = (release_outcome IS NOT NULL)),
    CHECK((release_outcome='sealed' AND manifest_sha256 IS NOT NULL) OR
      (COALESCE(release_outcome,'')!='sealed' AND manifest_sha256 IS NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX checkout_capture_active_root ON checkout_capture_holds(checkout_root)
    WHERE phase!='released'`;
  yield* sql`CREATE UNIQUE INDEX checkout_capture_common_git ON checkout_capture_holds(git_common_root)
    WHERE phase='capturing'`;
  // Ordinary threads have no portable ownership fence. These reservations still
  // survive a lost process reply or restart and must never imply another start.
  yield* sql`CREATE TABLE checkout_work_admissions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('provider','terminal','setup','workspace','vcs','write-file')),
    checkout_root TEXT NOT NULL,
    git_common_root TEXT NOT NULL,
    parent_admission_id TEXT,
    lineage_sequence INTEGER NOT NULL,
    turn_id TEXT,
    turn_finalized INTEGER NOT NULL DEFAULT 0 CHECK(turn_finalized IN (0,1)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
    rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected IN (0,1)),
    CHECK(rejected=0 OR (completed=1 AND turn_id IS NULL)),
    UNIQUE(thread_id,kind,work_id)
  )`;
  yield* sql`CREATE INDEX checkout_admissions_active_root ON checkout_work_admissions(checkout_root)
    WHERE completed=0`;
  for (const table of ["checkout_capture_holds", "checkout_work_admissions"])
    yield* sql.unsafe(`CREATE TRIGGER ${table}_reader_barrier AFTER INSERT ON ${table}
      BEGIN UPDATE effect_sql_migrations SET name='OrchestrationEvents_CheckoutCaptureReaderV1'
      WHERE migration_id=1; END`);
  // Older ownership triggers also write migration 1. Never downgrade this marker.
  yield* sql`CREATE TRIGGER checkout_capture_preserve_reader_barrier
    AFTER UPDATE OF name ON effect_sql_migrations
    WHEN NEW.migration_id=1 AND NEW.name!='OrchestrationEvents_CheckoutCaptureReaderV1'
      AND (EXISTS(SELECT 1 FROM checkout_capture_holds) OR EXISTS(SELECT 1 FROM checkout_work_admissions))
    BEGIN UPDATE effect_sql_migrations SET name='OrchestrationEvents_CheckoutCaptureReaderV1'
    WHERE migration_id=1; END`;
});
