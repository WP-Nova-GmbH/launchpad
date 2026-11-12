import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "./ThreadExecutionFence.ts";
import {
  assertThreadTransferRuntime,
  ThreadTransferRuntimeError,
} from "./ThreadTransferRuntime.ts";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-26T10:00:00.000Z";
const cursor = {
  threadId: "00000000-0000-4000-8000-000000000001",
  resumePolicy: "require-existing",
  portableStateId: "a".repeat(64),
};
const shutdownPayload = {
  activeTurnId: null,
  lastRuntimeEvent: "provider.stopAll",
  lastRuntimeEventAt: at,
};
let serial = 0;
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadId = `thread-${++serial}`,
    projectId = `project-${serial}`,
    operationId = `move-${serial}`;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Test', '/workspace', '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Test', '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', 'main', ${at}, ${at})`;
  yield* makeThreadExecutionFence(sql).prepare({
    threadId,
    projectId,
    operationId,
    generation: 2,
    environmentId: "destination",
    relayUrl: "https://relay.example",
  });
  yield* sql`INSERT INTO thread_transfer_baselines (operation_id, thread_id, generation, manifest_sha256, history_sha256, receipts_sha256,
    source_environment_id, source_sequence, destination_sequence, native_runtime_json)
    VALUES (${operationId}, ${threadId}, 2, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, 'source', 1, 1,
      ${encode({ ...cursor, providerInstanceId: "codex" })})`;
  yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
    VALUES (${threadId}, 'codex', 'codex', 'codex', 'full-access', 'stopped', ${at}, ${encode(cursor)}, NULL)`;
  return { sql, threadId, check: assertThreadTransferRuntime(sql, operationId) };
});

it.layer(SqlitePersistenceMemory)("transferred native runtime validation", (it) => {
  it.effect("accepts absent payloads and harmless graceful shutdown metadata", () =>
    Effect.gen(function* () {
      const { sql, threadId, check } = yield* fixture;
      yield* check;
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = 'null' WHERE thread_id = ${threadId}`;
      yield* check;
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = ${encode(shutdownPayload)} WHERE thread_id = ${threadId}`;
      yield* check;
    }),
  );
  for (const { name, payload } of [
    { name: "active turn", payload: { ...shutdownPayload, activeTurnId: "active-turn" } },
    {
      name: "continuation state",
      payload: { ...shutdownPayload, continueAfterServerUpdate: "active-turn" },
    },
    {
      name: "cleared continuation state",
      payload: { ...shutdownPayload, continueAfterServerUpdate: null },
    },
    { name: "extra provider state", payload: { ...shutdownPayload, cwd: "/workspace" } },
    {
      name: "another runtime event",
      payload: { ...shutdownPayload, lastRuntimeEvent: "provider.session.start" },
    },
    {
      name: "invalid shutdown timestamp",
      payload: { ...shutdownPayload, lastRuntimeEventAt: "not-a-date" },
    },
  ]) {
    it.effect(`rejects shutdown payloads with ${name}`, () =>
      Effect.gen(function* () {
        const { sql, threadId, check } = yield* fixture;
        yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = ${encode(payload)} WHERE thread_id = ${threadId}`;
        expect(yield* Effect.flip(check)).toBeInstanceOf(ThreadTransferRuntimeError);
      }),
    );
  }
  it.effect("rejects a mismatched native cursor even with harmless shutdown metadata", () =>
    Effect.gen(function* () {
      const { sql, threadId, check } = yield* fixture;
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json = ${encode(shutdownPayload)},
        resume_cursor_json = ${encode({ ...cursor, portableStateId: "e".repeat(64) })} WHERE thread_id = ${threadId}`;
      expect(yield* Effect.flip(check)).toBeInstanceOf(ThreadTransferRuntimeError);
    }),
  );
});
