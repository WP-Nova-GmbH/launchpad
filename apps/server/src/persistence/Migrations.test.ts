import * as Schema from "effect/Schema";
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
  combinedReaderMarker,
} from "./Migrations.ts";
import MigrationAuthSessionUser from "./Migrations/055_AuthSessionUser.ts";
import MigrationProjectionThreadMessageAuthor from "./Migrations/056_ProjectionThreadMessageAuthor.ts";

it.effect(
  "upgrades settled native and chat checkpoints without losing files, receipts or foreign keys",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`INSERT INTO thread_native_checkpoints(thread_id,turn_id,environment_id,generation,source_sequence,
      native_thread_id,directory,manifest_sha256,archive_sha256,published_artifact_id)
      VALUES ('thread','turn','environment',1,5,'native','/retained/native',${"a".repeat(64)},${"b".repeat(64)},'native-artifact')`;
      yield* sql`INSERT INTO thread_attachment_checkpoints(thread_id,generation,turn_id,environment_id,source_sequence,
      directory,manifest_sha256,published_artifact_id)
      VALUES ('thread',1,'turn','environment',5,'/retained/chat',${"c".repeat(64)},'chat-artifact')`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 68),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT turn_id,checkpoint_id,capture_operation_id,directory,published_artifact_id
      FROM thread_native_checkpoints`,
        [
          {
            turn_id: "turn",
            checkpoint_id: "turn",
            capture_operation_id: null,
            directory: "/retained/native",
            published_artifact_id: "native-artifact",
          },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT turn_id,checkpoint_id,directory,published_artifact_id FROM thread_attachment_checkpoints`,
        [
          {
            turn_id: "turn",
            checkpoint_id: "turn",
            directory: "/retained/chat",
            published_artifact_id: "chat-artifact",
          },
        ],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      yield* Effect.flip(sql`INSERT INTO thread_attachment_checkpoints(thread_id,generation,checkpoint_id,turn_id,environment_id,
      source_sequence,directory,manifest_sha256) VALUES ('thread',1,'missing','turn','environment',6,'/no-native',${"d".repeat(64)})`);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

describe("migration history guard", () => {
  for (const payload of ['{"entry":{"kind":"move"}}', '{"order":["second","first"]}']) {
    it.effect(`protects queue semantics from older readers: ${payload}`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('queue-change', 'thread', 'moving-thread', 1, 'thread.prompt-queue-changed', '2026-10-05T00:00:00Z', 'system', ${payload}, '{}')`;
        yield* sql
          .withTransaction(insert.pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.ignore);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
          [{ name: "OrchestrationEvents" }],
        );
        yield* insert;
        yield* sql`INSERT INTO thread_execution_fences
          (thread_id, relay_url, environment_id, project_id, generation, operation_id, phase)
          VALUES ('moving-thread', 'https://relay.test', 'env', 'project', 1, 'move', 'active')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('delete-other', 'thread', 'other-thread', 1, 'thread.deleted', '2026-10-05T00:00:00Z', 'system', '{}', '{}')`;
        yield* markSharedThreadDatabase;
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
          [{ name: combinedReaderMarker }],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 66`;
        assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  }

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
        [{ name: combinedReaderMarker }],
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
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 57),
      );
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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
it.effect(
  "preserves workflow ownership barriers through other thread changes and refuses older readers",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO repository_workflow_jobs (job_id, thread_id, status, execution_reserved, record_json) VALUES ('job', 'thread', 'running', 1, '{}')`;
      yield* markSharedThreadDatabase;
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES ('workflow-delete-test', 'thread', 'another-thread', 1, 'thread.deleted', '2026-10-08T00:00:00Z', 'system', '{}', '{}')`;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: combinedReaderMarker }],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 76`;
      assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("upgrades workflow ownership without changing accepted jobs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 76 });
    yield* sql`INSERT INTO repository_workflow_jobs (job_id, thread_id, status, execution_reserved, record_json) VALUES ('retained-job', 'retained-thread', 'running', 1, '{"retained":"job"}')`;
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
      [{ name: "OrchestrationEvents_WorkflowReaderV1" }],
    );
    assert.deepStrictEqual(yield* runMigrations(), [
      [77, "WorkflowCancellationFences"],
      [78, "SetupProcessOwnership"],
      [79, "SetupCleanupEvidence"],
      [80, "SetupLifecycleCleanup"],
      [81, "WorkflowSteps"],
      [82, "WorkflowManualPause"],
      [83, "WorkflowOrigin"],
      [84, "WorkflowPortableReader"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM repository_workflow_jobs`, [
      {
        job_id: "retained-job",
        thread_id: "retained-thread",
        status: "running",
        execution_reserved: 1,
        record_json: '{"retained":"job"}',
      },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
      [{ name: combinedReaderMarker }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("protects a cancellation-only database from older workflow readers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repository_workflow_cancellations (job_id, record_json) VALUES ('cancelled-job', '{}')`;
    yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV1' WHERE migration_id = 1`;
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
      [{ name: combinedReaderMarker }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 77`;
    assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("setup ownership alone activates and preserves the process reader barrier", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO setup_processes (thread_id, attempt_id, record_json) VALUES ('thread', 'attempt', '{}')`;
    yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_SharedThreadReaderV2' WHERE migration_id = 1`;
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
      [{ name: combinedReaderMarker }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 79`;
    assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "V3 upgrade invalidates old cleanup booleans and private done without reopening terminal history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      const record = '{"threadId":"thread","attemptId":"setup","exited":true}';
      yield* sql`INSERT INTO setup_processes VALUES ('thread', 'setup', ${record})`;
      yield* sql`INSERT INTO setup_process_cleanup VALUES ('thread', 'setup', 'approve-cid', 'done', NULL)`;
      const active =
        '{"approvalAttempt":{"approvedBy":"first","commandId":"approve-cid","checkpointId":"saved","setupCleanup":{"attemptId":"setup","state":"done","detail":null}},"cancellationAttempt":{"commandId":"cancel-cid","setupCleanup":{"attemptId":"setup","state":"done","detail":null}}}';
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('active', 'thread', 'awaiting_review', 0, ${active})`;
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('terminal', 'history', 'done', 0, ${active})`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [79, "SetupCleanupEvidence"],
        [80, "SetupLifecycleCleanup"],
        [81, "WorkflowSteps"],
        [82, "WorkflowManualPause"],
        [83, "WorkflowOrigin"],
        [84, "WorkflowPortableReader"],
      ]);
      const rows = yield* sql<{
        state: string;
        approver: string;
        cid: string;
        cancellation: string;
      }>`SELECT
      json_extract(record_json, '$.approvalAttempt.setupCleanup.state') AS state,
      json_extract(record_json, '$.approvalAttempt.approvedBy') AS approver,
      json_extract(record_json, '$.approvalAttempt.commandId') AS cid,
      json_extract(record_json, '$.cancellationAttempt.setupCleanup.state') AS cancellation
      FROM repository_workflow_jobs WHERE job_id = 'active'`;
      assert.deepStrictEqual(rows, [
        { state: "pending", approver: "first", cid: "approve-cid", cancellation: "pending" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT record_json FROM repository_workflow_jobs WHERE job_id = 'terminal'`,
        [{ record_json: active }],
      );
      assert.deepStrictEqual(yield* sql`SELECT state FROM setup_process_cleanup`, [
        { state: "pending" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(record_json, '$.exited') AS exited FROM setup_processes`,
        [{ exited: 0 }],
      );
      yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV3' WHERE migration_id = 1`;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: combinedReaderMarker }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("V4 upgrade preserves cleanup proof and blocks old PID-only fence readers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    const record =
      '{"threadId":"thread","attemptId":"setup","terminalId":"setup","createdAt":"now","pid":123,"identity":"birth","completed":true,"exited":true,"legacy":false,"ownershipVersion":4,"evidence":{"protocol":4,"source":"native"}}';
    yield* sql`INSERT INTO setup_processes VALUES ('thread', 'setup', ${record})`;
    yield* sql`INSERT INTO thread_cleanup_fences VALUES ('thread', 1, '[123]')`;
    yield* sql`INSERT INTO repository_workflow_jobs VALUES ('terminal', 'thread', 'done', 0, '{"history":"retained"}')`;
    assert.deepStrictEqual(yield* runMigrations(), [
      [80, "SetupLifecycleCleanup"],
      [81, "WorkflowSteps"],
      [82, "WorkflowManualPause"],
      [83, "WorkflowOrigin"],
      [84, "WorkflowPortableReader"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT record_json FROM setup_processes`, [
      { record_json: record },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT record_json FROM repository_workflow_jobs`, [
      { record_json: '{"history":"retained"}' },
    ]);
    yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV4' WHERE migration_id = 1`;
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
      [{ name: combinedReaderMarker }],
    );
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 80`;
    assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "a V6 workflow upgrade retains pause data and refuses a reader missing manual hold semantics",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      const record = '{"manualPause":{"state":"paused","promptId":null}}';
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('paused-job', 'thread', 'waiting_capacity', 0, ${record})`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [82, "WorkflowManualPause"],
        [83, "WorkflowOrigin"],
        [84, "WorkflowPortableReader"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT record_json FROM repository_workflow_jobs`, [
        { record_json: record },
      ]);
      yield* sql`UPDATE repository_workflow_jobs SET status = 'done', record_json = '{}'`;
      yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV6' WHERE migration_id = 1`;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: combinedReaderMarker }],
      );
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 82`;
      assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "backfills real legacy starters and protects attribution-only history after terminal cleanup",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      const record = { userId: "alice", instruction: "retained", progress: { status: "done" } };
      yield* sql`INSERT INTO repository_workflow_jobs VALUES ('old', 'old-thread', 'done', 0, ${encodeJson(record)})`;
      yield* runMigrations();
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM repository_workflow_jobs`;
      assert.deepStrictEqual(decodeJson(rows[0]!.record_json), {
        ...record,
        origin: { kind: "manual", userId: "alice" },
      });
      yield* sql`DELETE FROM repository_workflow_jobs`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at,workflow_origin_json)
    VALUES ('auto','thread',NULL,'user','task',0,'now','now','{"kind":"automation","jobId":"job","workflowId":"flow","workflowName":"Frozen"}')`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationEvents_WorkflowReaderV7' WHERE migration_id = 1`;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`,
        [{ name: combinedReaderMarker }],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 83`;
      assert.instanceOf(yield* Effect.flip(runMigrations()), Migrator.MigrationError);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
