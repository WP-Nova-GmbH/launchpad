import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations, verifyMigrationHistory } from "../persistence/Migrations.ts";
import {
  encodeCheckoutOperationBoot,
  recoverCheckoutOperations,
} from "./CheckoutOperationRecovery.ts";

const firstBoot = { host: "mac", session: "first-boot" };
const nextBoot = { ...firstBoot, session: "second-boot" };
const operations = (sql: SqlClient.SqlClient) =>
  sql<{ operationId: string; bootJson: string | null }>`
    SELECT operation_id AS "operationId",boot_json AS "bootJson"
    FROM checkout_operations ORDER BY operation_id`;

it.effect(
  "upgrades legacy checkout operations without releasing them and remains restartable",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('legacy','vcs')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('legacy','/repo/.git')`;
      yield* sql`INSERT INTO checkout_operation_projects(operation_id,project_id) VALUES('legacy','project')`;
      assert.deepStrictEqual(yield* runMigrations(), [[88, "CheckoutOperationBoot"]]);
      assert.deepStrictEqual(yield* operations(sql), [{ operationId: "legacy", bootJson: null }]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_operation_paths`, [
        { operation_id: "legacy", path: "/repo/.git" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_operation_projects`, [
        { operation_id: "legacy", project_id: "project" },
      ]);
      assert.strictEqual((yield* verifyMigrationHistory).through, 88);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "retains a legacy baseline across backend reconstruction until the same host reboots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('legacy','vcs')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('legacy','/repo/.git')`;
      yield* sql`INSERT INTO checkout_operation_projects(operation_id,project_id) VALUES('legacy','project')`;
      yield* sql`INSERT INTO checkout_capture_holds(operation_id,thread_id,environment_id,generation,checkout_root,git_common_root,admission_sequence,phase)
      VALUES('move','thread','mac',1,'/repo','/repo/.git',0,'draining')`;
      yield* sql`INSERT INTO checkout_work_admissions(admission_id,thread_id,work_id,kind,checkout_root,git_common_root,lineage_sequence)
      VALUES('provider','thread','turn','provider','/repo','/repo/.git',0)`;
      const hold = yield* sql`SELECT * FROM checkout_capture_holds`;
      const admission = yield* sql`SELECT * FROM checkout_work_admissions`;
      yield* recoverCheckoutOperations(sql, firstBoot);
      assert.deepStrictEqual(yield* operations(sql), [
        { operationId: "legacy", bootJson: encodeCheckoutOperationBoot(firstBoot) },
      ]);
      // Fresh invocations have no in-memory ownership state; the persisted baseline is authoritative.
      yield* recoverCheckoutOperations(sql, { ...firstBoot });
      assert.lengthOf(yield* operations(sql), 1);
      yield* sql`INSERT INTO checkout_operations(operation_id,kind,boot_json)
      VALUES('new-work','vcs',${encodeCheckoutOperationBoot(nextBoot)})`;
      yield* recoverCheckoutOperations(sql, nextBoot);
      assert.deepStrictEqual(yield* operations(sql), [
        { operationId: "new-work", bootJson: encodeCheckoutOperationBoot(nextBoot) },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_operation_paths`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_operation_projects`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_capture_holds`, hold);
      assert.deepStrictEqual(yield* sql`SELECT * FROM checkout_work_admissions`, admission);
      yield* recoverCheckoutOperations(sql, nextBoot);
      assert.lengthOf(yield* operations(sql), 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

for (const id of [86, 87])
  it.effect(`requires the known migration ${id} before accepting checkout boot metadata`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET name='UnexpectedMigration' WHERE migration_id=${id}`;
      const before =
        yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.include((yield* Effect.flip(verifyMigrationHistory)).message, `migration ${id}:`);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

it.effect("preserves unknown, malformed and foreign-host boot evidence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [id, boot] of [
      ["legacy", null],
      ["current", encodeCheckoutOperationBoot(firstBoot)],
      ["foreign", encodeCheckoutOperationBoot({ host: "other-host", session: "old-boot" })],
      ["invalid-json", "{"],
      ["missing-field", '{"host":"mac"}'],
      ["empty-field", '{"host":"mac","session":""}'],
      ["wrong-field-type", '{"host":"mac","session":42}'],
    ] as const)
      yield* sql`INSERT INTO checkout_operations(operation_id,kind,boot_json) VALUES(${id},'vcs',${boot})`;
    const initial = yield* operations(sql);
    yield* recoverCheckoutOperations(sql, null);
    assert.deepStrictEqual(yield* operations(sql), initial);
    yield* recoverCheckoutOperations(sql, firstBoot);
    assert.deepStrictEqual(
      yield* operations(sql),
      initial.map((row) =>
        row.operationId === "legacy"
          ? { ...row, bootJson: encodeCheckoutOperationBoot(firstBoot) }
          : row,
      ),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
