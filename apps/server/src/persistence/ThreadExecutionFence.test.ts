import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { makeThreadExecutionFence, ThreadExecutionFenceError } from "./ThreadExecutionFence.ts";
import { makeCheckoutCapture } from "./CheckoutCapture.ts";

const enrollment = {
  threadId: "portable",
  projectId: "project",
  relayUrl: "https://relay.example",
  environmentId: "environment",
  generation: 1,
  operationId: "enroll",
};
const move = {
  threadId: "portable",
  generation: 1,
  operationId: "move",
  previousOperationId: "enroll",
};
const work = { threadId: "portable", generation: 1, workId: "turn-1", kind: "provider" as const };
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fence = makeThreadExecutionFence(sql);
  yield* fence.prepare(enrollment);
  return { sql, fence };
});

describe("durable thread execution ownership", () => {
  it.effect("scopes capture freeze to the checkout and shared Git operations", () =>
    Effect.gen(function* () {
      const { sql, fence } = yield* fixture;
      const capture = makeCheckoutCapture(sql);
      yield* fence.activate(enrollment);
      yield* fence.beginDrain(move);
      yield* capture.acquireDrain({
        ...move,
        environmentId: enrollment.environmentId,
        checkoutRoot: "/repository/main",
        gitCommonRoot: "/repository/main/.git",
      });
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('sibling-file','write-file')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('sibling-file','/repository/sibling/file')`;
      yield* sql`INSERT INTO checkout_operation_projects(operation_id,project_id) VALUES('sibling-file',${enrollment.projectId})`;
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('sibling-git','vcs')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('sibling-git','/repository/sibling'),('sibling-git','/repository/main/.git')`;
      assert.instanceOf(yield* Effect.flip(fence.freeze(move)), ThreadExecutionFenceError);
      yield* sql`DELETE FROM checkout_operations WHERE operation_id='sibling-git'`;
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('nested-file','write-file')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('nested-file','/repository/main/nested/file')`;
      assert.instanceOf(yield* Effect.flip(fence.freeze(move)), ThreadExecutionFenceError);
      yield* sql`DELETE FROM checkout_operations WHERE operation_id='nested-file'`;
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('unknown-path','vcs')`;
      assert.instanceOf(yield* Effect.flip(fence.freeze(move)), ThreadExecutionFenceError);
      yield* sql`DELETE FROM checkout_operations WHERE operation_id='unknown-path'`;
      assert.equal(yield* fence.freeze(move), 0);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM checkout_operations WHERE operation_id='sibling-file'`,
        1,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("binds held output to the original ownership and still requires a mutable fence", () =>
    Effect.gen(function* () {
      const { fence } = yield* fixture;
      const ownership = {
        environmentId: enrollment.environmentId,
        generation: enrollment.generation,
      };
      const frozen = yield* Effect.flip(fence.assertMutable(enrollment.threadId));
      assert.deepStrictEqual(
        frozen._tag === "ThreadExecutionFenceError" ? frozen.ownership : undefined,
        undefined,
      );
      yield* fence.activate(enrollment);
      yield* fence.assertMutable(enrollment.threadId, ownership);
      yield* fence.beginDrain(move);
      yield* fence.assertMutable(enrollment.threadId, ownership);
      for (const expected of [
        null,
        { ...ownership, generation: 2 },
        { ...ownership, environmentId: "other-environment" },
      ]) {
        assert.instanceOf(
          yield* Effect.flip(fence.assertMutable(enrollment.threadId, expected)),
          ThreadExecutionFenceError,
        );
      }
      yield* fence.assertMutable("ordinary-local-thread", null);
      assert.instanceOf(
        yield* Effect.flip(fence.assertMutable("ordinary-local-thread", ownership)),
        ThreadExecutionFenceError,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reuses only an aborted destination generation with a confirmed cleanup receipt", () =>
    Effect.gen(function* () {
      const { sql, fence } = yield* fixture;
      yield* fence.retire(enrollment);
      const retry = { ...enrollment, operationId: "retry" };
      assert.instanceOf(yield* Effect.flip(fence.prepare(retry)), ThreadExecutionFenceError);
      yield* sql`INSERT INTO thread_transfer_aborts(operation_id,thread_id,environment_id,generation)
      VALUES (${enrollment.operationId},${enrollment.threadId},${enrollment.environmentId},${enrollment.generation})`;
      yield* fence.prepare(retry);
      assert.equal((yield* fence.get(enrollment.threadId))?.phase, "frozen");
      assert.instanceOf(yield* Effect.flip(fence.beginWork(work)), ThreadExecutionFenceError);
      assert.instanceOf(yield* Effect.flip(fence.activate(enrollment)), ThreadExecutionFenceError);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "starts fenced, rejects incompatible readers and preserves that marker after deletion",
    () =>
      Effect.gen(function* () {
        const { sql, fence } = yield* fixture;
        assert.instanceOf(yield* Effect.flip(fence.beginWork(work)), ThreadExecutionFenceError);
        assert.instanceOf(
          yield* Effect.flip(fence.assertMutable(enrollment.threadId)),
          ThreadExecutionFenceError,
        );
        yield* fence.assertMutable("ordinary-local-thread");
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('delete-ordinary', 'thread', 'ordinary', 1, 'thread.deleted', '2026-10-02T00:00:00Z', 'system', '{}', '{}')`;
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
          [{ name: "OrchestrationEvents_PortableThreadReaderV1" }],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
        assert.equal((yield* Effect.flip(runMigrations()))._tag, "MigrationError");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "grants a work identity once and keeps uncertain work reserved after reconstructing the service",
    () =>
      Effect.gen(function* () {
        const { sql, fence } = yield* fixture;
        yield* fence.activate(enrollment);
        const results = yield* Effect.all(
          Array.from({ length: 12 }, () => fence.beginWork(work)),
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter(Boolean).length, 1);
        const recovered = makeThreadExecutionFence(sql);
        assert.equal(yield* recovered.beginWork(work), false);
        yield* recovered.beginDrain(move);
        assert.instanceOf(yield* Effect.flip(recovered.freeze(move)), ThreadExecutionFenceError);
        assert.instanceOf(
          yield* Effect.flip(recovered.beginWork({ ...work, workId: "turn-2" })),
          ThreadExecutionFenceError,
        );
        yield* recovered.completeWork(work);
        yield* recovered.completeWork(work);
        assert.equal(yield* recovered.freeze(move), 0);
        assert.equal(yield* recovered.beginWork(work), false);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "captures an immutable watermark and rejects stale activation after the ownership retires",
    () =>
      Effect.gen(function* () {
        const { sql, fence } = yield* fixture;
        yield* fence.activate(enrollment);
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES ('event', 'thread', 'portable', 1, 'thread.meta-updated', '2026-10-02T00:00:00Z', 'system', '{}', '{}')`;
        yield* fence.beginDrain(move);
        const cursor = yield* fence.freeze(move);
        assert.equal(cursor, 1);
        assert.equal(yield* fence.freeze(move), cursor);
        yield* fence.retire(move);
        yield* fence.retire(move);
        assert.instanceOf(yield* Effect.flip(fence.activate(move)), ThreadExecutionFenceError);
        assert.instanceOf(
          yield* Effect.flip(fence.assertProjectMutable("project")),
          ThreadExecutionFenceError,
        );
        yield* fence.prepare({ ...enrollment, generation: 3, operationId: "return" });
        assert.instanceOf(yield* Effect.flip(fence.activate(move)), ThreadExecutionFenceError);
        yield* fence.activate({ ...enrollment, generation: 3, operationId: "return" });
        assert.equal((yield* fence.get("portable"))?.phase, "active");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("cannot replay an old drain after cancellation and cannot change a work identity", () =>
    Effect.gen(function* () {
      const { fence } = yield* fixture;
      yield* fence.activate(enrollment);
      yield* fence.beginWork(work);
      assert.instanceOf(
        yield* Effect.flip(fence.beginWork({ ...work, kind: "terminal" })),
        ThreadExecutionFenceError,
      );
      assert.instanceOf(
        yield* Effect.flip(fence.completeWork({ ...work, workId: "unknown" })),
        ThreadExecutionFenceError,
      );
      yield* fence.completeWork(work);
      yield* fence.beginDrain(move);
      yield* fence.freeze(move);
      yield* fence.activate(move);
      const next = { ...move, operationId: "move-2", previousOperationId: "move" };
      yield* fence.beginDrain(next);
      yield* fence.activate(next);
      assert.instanceOf(yield* Effect.flip(fence.beginDrain(move)), ThreadExecutionFenceError);
      assert.instanceOf(
        yield* Effect.flip(fence.prepare({ ...enrollment, environmentId: "different" })),
        ThreadExecutionFenceError,
      );
      assert.instanceOf(
        yield* Effect.flip(fence.prepare({ ...enrollment, generation: 2 })),
        ThreadExecutionFenceError,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("serializes freeze against new work without relying on elapsed time", () =>
    Effect.gen(function* () {
      const { fence } = yield* fixture;
      yield* fence.activate(enrollment);
      const [started] = yield* Effect.all(
        [fence.beginWork(work).pipe(Effect.result), fence.beginDrain(move)],
        { concurrency: "unbounded" },
      );
      if (started._tag === "Success") {
        assert.instanceOf(yield* Effect.flip(fence.freeze(move)), ThreadExecutionFenceError);
        yield* fence.completeWork(work);
      }
      yield* fence.freeze(move);
      assert.instanceOf(
        yield* Effect.flip(fence.beginWork({ ...work, workId: "after-freeze" })),
        ThreadExecutionFenceError,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
