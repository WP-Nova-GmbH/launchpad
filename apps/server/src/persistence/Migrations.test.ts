import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";

describe("migration history guard", () => {
  it.effect("refuses to run when a recorded id names a different change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET name = 'AuthSessionClientConnection' WHERE migration_id = 41`;

      const error = yield* Effect.flip(runMigrations());

      assert.instanceOf(error, Migrator.MigrationError);
      assert.equal(error.kind, "BadState");
      assert.include(
        error.message,
        'migration 41: database recorded "AuthSessionClientConnection"',
      );
      assert.include(error.message, 'this build defines "AuthSessionUser"');
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("tolerates recorded ids this build does not define", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (43, 'ProjectionThreadsUnsettledAt')`;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("passes when recorded names match the manifest", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
