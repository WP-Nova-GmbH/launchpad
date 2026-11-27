import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import migration from "./Migrations/086_ThreadMoveTransferIntents.ts";
import { makeThreadMoveTransferIntent } from "./ThreadMoveTransferIntent.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const owner = { operationId: "move", threadId: "thread", environmentId: "source", generation: 2 };
const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_execution_fences(thread_id TEXT PRIMARY KEY,environment_id TEXT,generation INTEGER,operation_id TEXT,phase TEXT)`;
  yield* sql`CREATE TABLE projection_thread_prompt_queues(thread_id TEXT,state_json TEXT)`;
  yield* sql`CREATE TABLE thread_transfer_baselines(operation_id TEXT,generation INTEGER)`;
});

it.effect(
  "preserves legacy active/lost-begin, blocked and cancelling heads without binding future or destination moves",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* schema;
      for (const [name, phase, state] of [
        ["lost-begin", "active", "moving"],
        ["blocked", "draining", "blocked"],
        ["cancel", "frozen", "cancelling"],
        ["pending", "active", "pending"],
        ["retired", "retired", "moving"],
        ["incoming", "frozen", "moving"],
        ["active-incoming", "active", "moving"],
        ["later", "active", "moving"],
      ] as const) {
        const op = `${name}-move`;
        yield* sql`INSERT INTO thread_execution_fences VALUES(${name},'source',2,${phase === "active" ? "prior-enrollment" : op},${phase})`;
        const move = { kind: "move", state, operationId: op };
        const entries = name === "later" ? [{ kind: "prompt" }, move] : [move];
        yield* sql`INSERT INTO projection_thread_prompt_queues VALUES(${name},${encodeJson({ entries })})`;
        if (name === "incoming" || name === "active-incoming")
          yield* sql`INSERT INTO thread_transfer_baselines VALUES(${op},2)`;
      }
      yield* migration;
      const rows =
        yield* sql`SELECT thread_id,source_formats_json,encoding_policy,manifest_sha256 FROM thread_move_transfer_intents ORDER BY thread_id`;
      expect(rows).toEqual(
        ["blocked", "cancel", "lost-begin"].map((thread_id) => ({
          thread_id,
          source_formats_json: '["launchpad-thread-chunks-v1"]',
          encoding_policy: "v1-64MiB",
          manifest_sha256: null,
        })),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("persists a source offer and immutable policy/hash across a database restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-intent-" });
    const filename = `${root}/state.sqlite`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* schema;
        yield* migration;
        yield* sql`INSERT INTO thread_execution_fences VALUES('thread','source',2,'enrollment','active')`;
        const intents = makeThreadMoveTransferIntent(sql);
        const created = yield* intents.create(owner, [
          "launchpad-thread-chunks-v1",
          "launchpad-thread-chunks-v2",
        ]);
        expect(created.transferEncodingPolicy).toBeNull();
        yield* intents.bind(owner, "workspace-raw-v2-8MiB", "a".repeat(64));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const intents = makeThreadMoveTransferIntent(sql);
        const recovered = yield* intents.create(owner, ["launchpad-thread-chunks-v1"]);
        expect(recovered.sourceThreadTransferFormats).toEqual([
          "launchpad-thread-chunks-v1",
          "launchpad-thread-chunks-v2",
        ]);
        expect(recovered.transferEncodingPolicy).toBe("workspace-raw-v2-8MiB");
        expect(recovered.manifestSha256).toBe("a".repeat(64));
        for (const bind of [
          intents.bind(owner, "v1-64MiB", "a".repeat(64)),
          intents.bind(owner, "workspace-raw-v2-8MiB", "b".repeat(64)),
          intents.get({ ...owner, environmentId: "other" }),
          intents.get({ ...owner, generation: 3 }),
          intents.get({ ...owner, threadId: "other" }),
        ])
          expect((yield* Effect.flip(bind))._tag).toBe("ThreadMoveTransferIntentError");
        expect((yield* intents.get(owner))?.manifestSha256).toBe("a".repeat(64));
        yield* sql`PRAGMA ignore_check_constraints = ON`;
        yield* sql`UPDATE thread_move_transfer_intents SET encoding_policy='future-policy' WHERE operation_id='move'`;
        expect((yield* Effect.flip(intents.get(owner)))._tag).toBe("ThreadMoveTransferIntentError");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
