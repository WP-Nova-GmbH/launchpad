import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  combinedReaderMarker,
  migrationManifest,
  runMigrations,
  verifyMigrationHistory,
} from "./Migrations.ts";
import { legacyWorkflowDatabase, originalWorkflowMigrations } from "./Migrations.test-fixture.ts";

const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    migration_id: number;
    name: string;
    created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`
    .withoutTransform;
});
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    ledger: yield* ledger,
    schema: yield* sql`SELECT type,name,sql FROM sqlite_master ORDER BY type,name`,
    jobs: yield* sql`SELECT * FROM repository_workflow_jobs`,
  };
});
const assertCanonical = Effect.gen(function* () {
  const rows = yield* ledger;
  assert.deepStrictEqual(
    rows.map((row) => [
      row.migration_id,
      row.migration_id === 1 ? "OrchestrationEvents" : row.name,
    ]),
    migrationManifest.map(([id, name]) => [id, name]),
  );
  assert.equal((yield* verifyMigrationHistory).kind, "canonical");
  assert.deepEqual(yield* runMigrations(), []);
});
for (const through of [0, 40, 58, 59, ...Array.from({ length: 16 }, (_, i) => i + 60)])
  it.effect(`upgrades the real VM/common prefix ${through}`, () =>
    Effect.gen(function* () {
      if (through > 0) yield* runMigrations({ toMigrationInclusive: through });
      yield* runMigrations();
      yield* assertCanonical;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
for (let through = 60; through <= 67; through++)
  it.effect(`normalizes original workflow prefix ${through} without rerunning it`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyWorkflowDatabase(through);
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-01 12:34:56.123' WHERE migration_id BETWEEN 60 AND 67`;
      const record =
        '{"userId":"alice","origin":{"kind":"manual","userId":"alice"},"manualPause":{"state":"paused"},"approvalAttempt":{"setupCleanup":{"state":"pending"}},"retained":true}';
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','awaiting_review',0,${record})`;
      if (through >= 61)
        yield* sql`INSERT INTO repository_workflow_cancellations VALUES ('cancel','{"retained":true}')`;
      if (through >= 62) {
        yield* sql`INSERT INTO setup_processes VALUES ('thread','attempt','{"exited":false,"evidence":{"protocol":4}}')`;
        yield* sql`INSERT INTO setup_process_cleanup VALUES ('thread','attempt','cleanup','pending',NULL)`;
      }
      assert.equal((yield* verifyMigrationHistory).kind, "legacy-workflow");
      const old = (yield* ledger).filter((row) => row.migration_id >= 60);
      yield* runMigrations();
      yield* assertCanonical;
      const current = yield* ledger;
      for (const row of old)
        assert.deepInclude(current, { ...row, migration_id: row.migration_id + 16 });
      assert.deepEqual(yield* sql`SELECT record_json FROM repository_workflow_jobs`, [
        { record_json: record },
      ]);
      assert.equal(current[0]?.name, combinedReaderMarker);
      if (through >= 61)
        assert.deepEqual(yield* sql`SELECT record_json FROM repository_workflow_cancellations`, [
          { record_json: '{"retained":true}' },
        ]);
      if (through >= 62)
        assert.deepEqual(yield* sql`SELECT state FROM setup_process_cleanup`, [
          { state: "pending" },
        ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

for (const corruption of [
  "nonpositive-id",
  "hole",
  "mixed",
  "future",
  "workflow-column",
  "workflow-trigger",
  "vm-table",
])
  it.effect(`rejects legacy ${corruption} without changing its data`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyWorkflowDatabase();
      if (corruption === "nonpositive-id")
        yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (0,'Unknown')`;
      if (corruption === "hole")
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id=63`;
      if (corruption === "mixed")
        yield* sql`UPDATE effect_sql_migrations SET name='ThreadTransferBaselines' WHERE migration_id=61`;
      if (corruption === "future")
        yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (99,'Unknown')`;
      if (corruption === "workflow-column")
        yield* sql`ALTER TABLE repository_workflow_jobs ADD COLUMN unknown TEXT`;
      if (corruption === "workflow-trigger")
        yield* sql`DROP TRIGGER workflow_reader_barrier_setup_processes`;
      if (corruption === "vm-table") yield* sql`CREATE TABLE thread_execution_fences(unknown TEXT)`;
      const before = yield* snapshot;
      assert.equal((yield* Effect.exit(runMigrations()))._tag, "Failure");
      assert.deepEqual(yield* snapshot, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

for (const point of ["delete", "restore", "cleanup", "barrier"])
  it.effect(`rolls back normalization at ${point}, reopens, and retries`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-migration-rollback-" });
      const database = NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") });
      const before = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* legacyWorkflowDatabase(point === "cleanup" ? 62 : 67);
        yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','running',0,'{}')`;
        if (point === "cleanup") {
          yield* sql`INSERT INTO setup_processes VALUES ('thread','attempt','{"exited":true}')`;
          yield* sql`CREATE TRIGGER fail_migration BEFORE UPDATE ON setup_processes BEGIN SELECT RAISE(ABORT,'injected'); END`;
        } else if (point === "barrier") {
          yield* sql`CREATE TRIGGER fail_migration BEFORE UPDATE OF name ON effect_sql_migrations WHEN NEW.name=${sql.literal("'" + combinedReaderMarker + "'")} BEGIN SELECT RAISE(ABORT,'injected'); END`;
        } else {
          yield* sql`CREATE TRIGGER fail_migration BEFORE INSERT ON effect_sql_migrations WHEN NEW.migration_id=${sql.literal(point === "delete" ? "60" : "76")} BEGIN SELECT RAISE(ABORT,'injected'); END`;
        }
        const original = yield* snapshot;
        assert.equal((yield* Effect.exit(runMigrations()))._tag, "Failure");
        assert.deepEqual(yield* snapshot, original);
        return original;
      }).pipe(Effect.provide(database));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* snapshot, before);
        yield* sql`DROP TRIGGER fail_migration`;
        yield* runMigrations();
        yield* assertCanonical;
      }).pipe(Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect("keeps a pruned VM activation and avoids competing sticky reader triggers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 75 });
    yield* sql`PRAGMA recursive_triggers=ON`;
    yield* sql`INSERT INTO checkout_work_admissions(admission_id,thread_id,work_id,kind,checkout_root,git_common_root,lineage_sequence) VALUES ('a','t','w','provider','/repo','/repo/.git',0)`;
    yield* sql`DELETE FROM checkout_work_admissions`;
    yield* runMigrations();
    assert.equal((yield* ledger)[0]?.name, combinedReaderMarker);
    yield* sql`UPDATE effect_sql_migrations SET name='OrchestrationEvents_WorkflowReaderV8' WHERE migration_id=1`;
    yield* sql`UPDATE effect_sql_migrations SET name='OrchestrationEvents_CheckoutCaptureReaderV1' WHERE migration_id=1`;
    assert.equal((yield* ledger)[0]?.name, combinedReaderMarker);
    yield* assertCanonical;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("runs pending cleanup evidence once while preserving checkpoint foreign keys", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* legacyWorkflowDatabase(62);
    yield* sql`INSERT INTO setup_processes VALUES ('t','a','{"exited":true}')`;
    yield* sql`INSERT INTO setup_process_cleanup VALUES ('t','a','stop','done','old')`;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT state,detail FROM setup_process_cleanup`, [
      { state: "pending", detail: null },
    ]);
    yield* sql`UPDATE setup_process_cleanup SET state='done',detail='new proof'`;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT state,detail FROM setup_process_cleanup`, [
      { state: "done", detail: "new proof" },
    ]);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.lengthOf(originalWorkflowMigrations, 8);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
