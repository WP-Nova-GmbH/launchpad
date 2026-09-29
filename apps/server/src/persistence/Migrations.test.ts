import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  markSharedThreadDatabase,
  migrationManifest,
  runMigrations,
  sharedThreadReaderMarker,
} from "./Migrations.ts";
import MigrationAuthSessionUser from "./Migrations/055_AuthSessionUser.ts";
import MigrationProjectionThreadMessageAuthor from "./Migrations/056_ProjectionThreadMessageAuthor.ts";

describe("migration history guard", () => {
  it.effect("commits cleanup fences with deletion and refuses readers that cannot honor them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('delete-test', 'thread', 'deleted-task', 1, 'thread.deleted', '2026-09-28T00:00:00Z', 'system', '{}', '{}')`;
      yield* sql
        .withTransaction(insert.pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.ignore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_cleanup_fences`, []);
      yield* insert;
      const fences = yield* sql`SELECT thread_id, process_ids_json FROM thread_cleanup_fences`;
      assert.deepStrictEqual(fences, [{ thread_id: "deleted-task", process_ids_json: null }]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: "OrchestrationEvents_ThreadCleanupReaderV1" }],
      );
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 59`;
      assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "backfills old deleted setup uncertainty without blocking never-started settled drafts",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 58 });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, deleted_at)
        VALUES ('uncertain', 'p', 'Unknown', '{}', 'full-access', 'default', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z'),
        ('never-started', 'p', 'Draft', '{}', 'full-access', 'default', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z')`;
        yield* sql`INSERT INTO projection_thread_prompt_queues VALUES
        ('uncertain', '{"preparation":{"state":"failed","settled":false}}'),
        ('never-started', '{"preparation":{"state":"pending","settled":true}}')`;
        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, process_ids_json FROM thread_cleanup_fences`,
          [{ thread_id: "uncertain", process_ids_json: null }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps activated shared databases readable only by a compatible build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* markSharedThreadDatabase;
      yield* markSharedThreadDatabase;
      assert.deepStrictEqual(yield* runMigrations(), []);
      const recorded = yield* sql<{
        name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`;
      assert.equal(recorded[0]?.name, sharedThreadReaderMarker);
      // The pre-queue reader compares known names and refuses before serving.
      assert.notEqual(recorded[0]?.name, migrationManifest.find(([id]) => id === 1)?.[1]);
      assert.notEqual(recorded[0]?.name, "OrchestrationEvents_SharedThreadReaderV1");
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 57`;
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, Migrator.MigrationError);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("upgrades an activated V1 database and preserves its work and legacy receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`INSERT INTO projection_thread_prompt_queues (thread_id, state_json) VALUES ('old-shared-thread', '{"entries":[{"messageId":"retained"}]}')`;
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
        VALUES ('old-receipt', 'thread', 'old-shared-thread', '2026-09-28T00:00:00.000Z', 1, 'accepted', NULL)`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [58, "CommandReceiptProjectScope"],
        [59, "ThreadCleanupFences"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT project_id FROM orchestration_command_receipts`, [
        { project_id: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT state_json FROM projection_thread_prompt_queues`, [
        { state_json: '{"entries":[{"messageId":"retained"}]}' },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: sharedThreadReaderMarker }],
      );
      yield* markSharedThreadDatabase;
      yield* sql`UPDATE projection_thread_prompt_queues SET state_json = '{}' WHERE thread_id = 'old-shared-thread'`;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: sharedThreadReaderMarker }],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "marks updates to existing queues and rejects a V2 marker without its required migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_prompt_queues (thread_id, state_json) VALUES ('old-thread', '{}')`;
        yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV1' WHERE migration_id = 1`;
        yield* sql`UPDATE projection_thread_prompt_queues SET state_json = '{"preparation":{"state":"pending"}}' WHERE thread_id = 'old-thread'`;
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
          [{ name: sharedThreadReaderMarker }],
        );
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 58`;
        assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("marks a database when its first durable prompt queue is written", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_thread_prompt_queues (thread_id, state_json) VALUES ('shared-thread', '{}')`;
      const recorded = yield* sql<{
        name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`;
      assert.equal(recorded[0]?.name, sharedThreadReaderMarker);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("refuses to run when a recorded id names a different change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET name = 'SomethingElse' WHERE migration_id = 55`;

      const error = yield* Effect.flip(runMigrations());

      assert.instanceOf(error, Migrator.MigrationError);
      assert.equal(error.kind, "BadState");
      assert.include(error.message, 'migration 55: database recorded "SomethingElse"');
      assert.include(error.message, 'this build defines "AuthSessionUser"');
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("tolerates recorded ids this build does not define", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'FromTheFuture')`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reruns from a renumbered migration's old id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A database migrated before upstream took ids 41 and 42: it ran the
      // fork's migrations under those ids and never saw 41–56 as they are now.
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* MigrationAuthSessionUser;
      yield* MigrationProjectionThreadMessageAuthor;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'AuthSessionUser'), (42, 'ProjectionThreadMessageAuthor')`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationManifest.filter(([id]) => id >= 41).map(([id]) => id),
      );
      const recorded = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (41, 55)
        ORDER BY migration_id
      `.withoutTransform;
      assert.deepStrictEqual(recorded, [
        { migration_id: 41, name: "AuthSessionClientConnection" },
        { migration_id: 55, name: "AuthSessionUser" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("passes when recorded names match the manifest", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
