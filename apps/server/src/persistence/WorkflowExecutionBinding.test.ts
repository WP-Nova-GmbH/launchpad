import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations, verifyMigrationHistory } from "./Migrations.ts";
import { executionBindingReaderMarker } from "./MigrationCompatibility.ts";

const oldRecord = JSON.stringify({
  workflow: {
    definition: { name: "Frozen", environmentId: "environment", projectId: "project", steps: [] },
  },
  approvedBy: "alice",
  providerContinuation: { continuationKey: "keep" },
});
const currentRecord = JSON.stringify({
  runtime: { kind: "machine", environmentId: "environment", projectId: "project" },
});
const decodeConverted = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      runtime: Schema.Unknown,
      workflow: Schema.Struct({ definition: Schema.Struct({ target: Schema.Unknown }) }),
      approvedBy: Schema.String,
      providerContinuation: Schema.Unknown,
    }),
  ),
);
const marker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    name: string;
  }>`SELECT name FROM effect_sql_migrations WHERE migration_id=1`)[0]!.name;
});

it.effect("normalizes a frozen legacy execution and keeps the slot and reader fences", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 88 });
    yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','running',1,${oldRecord})`;
    yield* runMigrations();
    const [row] = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM repository_workflow_jobs`;
    const next = yield* decodeConverted(row!.record_json);
    assert.deepEqual(next.runtime, {
      kind: "machine",
      environmentId: "environment",
      projectId: "project",
    });
    assert.deepEqual(next.workflow.definition.target, next.runtime);
    assert.equal(next.approvedBy, "alice");
    assert.deepEqual(next.providerContinuation, { continuationKey: "keep" });
    assert.equal(yield* marker, executionBindingReaderMarker);
    assert.isTrue(
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('other','other-thread','running',1,${currentRecord})`.pipe(
        Effect.isFailure,
      ),
    );
    yield* sql`DELETE FROM repository_workflow_jobs`;
    yield* sql`UPDATE effect_sql_migrations SET name='OrchestrationEvents_WorkflowPortableReaderV1' WHERE migration_id=1`;
    assert.equal(yield* marker, executionBindingReaderMarker);
    yield* verifyMigrationHistory;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

for (const operation of ["INSERT", "UPDATE"] as const)
  it.effect(`activates the reader barrier on the first canonical ${operation}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      assert.notEqual(yield* marker, executionBindingReaderMarker);
      if (operation === "INSERT")
        yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','done',0,${currentRecord})`;
      else {
        yield* sql`INSERT INTO repository_workflow_jobs VALUES ('job','thread','done',0,'{}')`;
        assert.notEqual(yield* marker, executionBindingReaderMarker);
        yield* sql`UPDATE repository_workflow_jobs SET record_json=${currentRecord} WHERE job_id='job'`;
      }
      assert.equal(yield* marker, executionBindingReaderMarker);
      yield* verifyMigrationHistory;
      assert.isTrue(
        yield* sql`INSERT INTO repository_workflow_jobs VALUES ('bad','bad-thread','running',1,'{}')`.pipe(
          Effect.isFailure,
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
