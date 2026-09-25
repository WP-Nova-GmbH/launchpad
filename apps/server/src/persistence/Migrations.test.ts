import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import MigrationAuthSessionUser from "./Migrations/055_AuthSessionUser.ts";
import MigrationProjectionThreadMessageAuthor from "./Migrations/056_ProjectionThreadMessageAuthor.ts";

describe("migration history guard", () => {
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
        Array.from({ length: 16 }, (_, index) => 41 + index),
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
