import type { OrchestrationEventStoreShape } from "../../../../../apps/server/src/persistence/Services/OrchestrationEventStore.ts";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../../../../../apps/server/src/persistence/Layers/Sqlite.ts";
import { exportCodexConversation } from "../../../../../apps/server/src/provider/Drivers/CodexConversationTransfer.ts";
import { makeThreadNativeCheckpoint } from "../../../../../apps/server/src/relay/ThreadNativeCheckpoint.ts";
import { makeThreadNativeCheckpointTransfer } from "../../../../../apps/server/src/relay/ThreadNativeCheckpointTransfer.ts";
import { makeThreadPlacementStore } from "../ThreadPlacementStore.ts";
import { makeThreadJournalStore } from "../ThreadJournalStore.ts";
import { makeThreadArtifactTransfer } from "../ThreadArtifactTransfer.ts";
import { makeLocalThreadArtifactObjects } from "../ThreadArtifactLocalObjects.ts";
import { makeThreadNativeCheckpointStore } from "../ThreadNativeCheckpointStore.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
export const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeChunkManifest = Schema.decodeEffect(
  Schema.fromJsonString(ThreadTransferChunkManifest),
);
export const nativeId = "01900000-0000-7000-8000-000000000001";
export const nativeCheckpointCatalogTestLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/u.test(new URL(databaseUrl).pathname))
      return yield* Effect.die("Native catalog tests need their own launchpad_vm_test_* database.");
    const sql = yield* PgClient.PgClient,
      fs = yield* FileSystem.FileSystem;
    const root = new URL("../../../migrations/postgres/", import.meta.url).pathname;
    for (const directory of (yield* fs.readDirectory(root)).toSorted()) {
      const migration = yield* fs.readFileString(`${root}${directory}/migration.sql`);
      yield* sql.withTransaction(
        Effect.forEach(migration.split("--> statement-breakpoint"), (statement) =>
          sql.unsafe(statement),
        ),
      );
    }
  }),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeEffectCrypto.layer,
      PgClient.layer({ url: Redacted.make(databaseUrl ?? "") }),
    ),
  ),
);

export const packedCheckpoint = Effect.fnUntraced(function* (input: {
  threadId: string;
  turnId: string;
  sourceSequence: number;
  root: string;
  nativeThreadId?: string;
  sourceEnvironmentId?: string;
  captureOperationId?: string;
  events?: Pick<OrchestrationEventStoreShape, "readAggregateRange">;
}) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const selectedNativeId = input.nativeThreadId ?? nativeId;
  const sourceEnvironmentId = input.sourceEnvironmentId ?? "local";
  const home = path.join(input.root, `source-${input.turnId}`);
  const sessions = path.join(home, "sessions", "2026", "10", "01");
  yield* fs.makeDirectory(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-10-01T12-00-00-${selectedNativeId}.jsonl`);
  yield* fs.writeFileString(
    rollout,
    encode({
      type: "session_meta",
      payload: {
        id: selectedNativeId,
        session_id: selectedNativeId,
        cli_version: "0.159.3",
        history_mode: "paginated",
      },
      ordinal: 0,
    }) +
      "\n" +
      encode({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `remember ${input.turnId}` }],
        },
        ordinal: 1,
      }) +
      "\n",
  );
  yield* fs.writeFileString(path.join(home, "auth.json"), "private-credentials-do-not-transfer");
  yield* sql`INSERT INTO thread_execution_fences
    (thread_id,relay_url,environment_id,project_id,generation,operation_id,phase)
    VALUES (${input.threadId},'https://relay.invalid',${sourceEnvironmentId},'project',1,'enroll','active')`;
  if (input.captureOperationId !== undefined)
    yield* sql`UPDATE thread_execution_fences SET phase='frozen',operation_id=${input.captureOperationId},
      frozen_sequence=${input.sourceSequence} WHERE thread_id=${input.threadId}`;
  yield* makeThreadNativeCheckpoint(sql).capture(
    {
      threadId: input.threadId,
      turnId: input.turnId,
      ...(input.captureOperationId === undefined
        ? {}
        : { captureOperationId: input.captureOperationId }),
      artifactRoot: path.join(input.root, `outbox-${input.turnId}`),
    },
    (artifactRoot) =>
      exportCodexConversation({
        codexHome: home,
        rolloutPath: rollout,
        threadId: selectedNativeId,
        artifactRoot,
      }).pipe(
        Effect.map((archive) => ({
          directory: archive.directory,
          nativeThreadId: archive.manifest.threadId,
        })),
      ),
  );
  yield* sql`UPDATE thread_native_checkpoints SET source_sequence=${input.sourceSequence}
    WHERE thread_id=${input.threadId}`;
  return yield* makeThreadNativeCheckpointTransfer(sql, input.events).pack({
    threadId: input.threadId,
    turnId: input.turnId,
    generation: 1,
    sourceEnvironmentId,
    ...(input.captureOperationId === undefined
      ? {}
      : { captureOperationId: input.captureOperationId }),
    scratchRoot: path.join(input.root, "packing"),
    chunkSizeBytes: 128,
  });
});
export const nativeCheckpointCatalogFixture = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient,
    fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "native-catalog-" }));
  const threadId = NodeCrypto.randomUUID();
  yield* makeThreadPlacementStore(sql).enroll({
    threadId,
    environmentId: "local",
    projectId: "project",
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "user",
  });
  const objects = makeLocalThreadArtifactObjects(fs, `${root}/objects`);
  const transfer = makeThreadArtifactTransfer(sql, objects);
  const store = makeThreadNativeCheckpointStore(sql, objects);
  const pack = (turnId: string, sourceSequence: number, nativeThreadId?: string) =>
    packedCheckpoint({
      root,
      threadId,
      turnId,
      sourceSequence,
      ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
    }).pipe(Effect.provide(SqlitePersistenceMemory));
  const upload = Effect.fnUntraced(function* (
    packed: Effect.Success<ReturnType<typeof pack>>,
    omit?: string,
  ) {
    for (const entry of packed.uploads) {
      if (entry.artifactId === omit) continue;
      const bytes = yield* fs.readFile(entry.path);
      yield* transfer.upload({
        ...entry,
        threadId,
        operationId: packed.header.operationId,
        retentionDays: 1,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
    }
  });
  const publish = (packed: Effect.Success<ReturnType<typeof pack>>) =>
    store.publish({
      threadId,
      operationId: packed.header.operationId,
      manifestArtifactId: packed.artifactId,
    });
  const mirror = (sourceSequence: number) =>
    makeThreadJournalStore(sql).confirmThrough({
      threadId,
      environmentId: "local",
      generation: 1,
      sourceSequence,
    });
  return { sql, fs, root, threadId, objects, transfer, store, pack, upload, publish, mirror };
});
