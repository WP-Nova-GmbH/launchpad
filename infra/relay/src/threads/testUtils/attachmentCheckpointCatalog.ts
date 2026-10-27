import * as NodeCrypto from "node:crypto";
import { OrchestrationEvent, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../../../../apps/server/src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../../../../apps/server/src/persistence/Services/OrchestrationEventStore.ts";
import { attachmentRelativePath } from "../../../../../apps/server/src/attachmentStore.ts";
import { makeThreadAttachmentCheckpoint } from "../../../../../apps/server/src/relay/ThreadAttachmentCheckpoint.ts";
import { makeThreadAttachmentCheckpointTransfer } from "../../../../../apps/server/src/relay/ThreadAttachmentCheckpointTransfer.ts";
import { makeThreadAttachmentCheckpointStore } from "../ThreadAttachmentCheckpointStore.ts";
import { makeThreadJournalStore } from "../ThreadJournalStore.ts";
import {
  nativeCheckpointCatalogFixture,
  packedCheckpoint,
  nativeId,
} from "./nativeCheckpointCatalog.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const serverState = OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
export const attachmentCheckpointCatalogFixture = Effect.gen(function* () {
  const f = yield* nativeCheckpointCatalogFixture;
  const sourceEnvironmentId = `source-${f.threadId}`;
  yield* f.sql`UPDATE relay_thread_placements SET environment_id=${sourceEnvironmentId} WHERE thread_id=${f.threadId}`;
  const bundle = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      events = yield* OrchestrationEventStore;
    const attachment: ChatAttachment = {
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      id: `${f.threadId}-00000000-0000-4000-8000-000000000001-txt`,
    };
    const attachmentsDir = `${f.root}/source-chat-files`;
    yield* f.fs.makeDirectory(attachmentsDir);
    yield* f.fs.writeFileString(`${attachmentsDir}/${attachmentRelativePath(attachment)}`, "notes");
    yield* f.fs.writeFileString(
      `${attachmentsDir}/auth.json`,
      "unrelated-file-must-stay-on-source",
    );
    const at = "2026-10-05T10:00:00.000Z";
    const history: OrchestrationEvent[] = [];
    const append = Effect.fnUntraced(function* (type: string, payload: unknown) {
      const event = yield* events.append(
        decodeEvent({
          type,
          sequence: 0,
          eventId: `${f.threadId}-${history.length}`,
          aggregateKind: "thread",
          aggregateId: f.threadId,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload,
        }),
      );
      history.push(event);
    });
    yield* append("thread.created", {
      threadId: f.threadId,
      projectId: "project",
      title: "Retained history",
      modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: at,
      updatedAt: at,
    });
    yield* append("thread.message-sent", {
      threadId: f.threadId,
      messageId: "message",
      role: "user",
      text: "keep this attachment",
      attachments: [attachment],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    });
    const sourceSequence = history.at(-1)!.sequence;
    const native = yield* packedCheckpoint({
      root: f.root,
      threadId: f.threadId,
      turnId: "turn-1",
      sourceSequence,
      sourceEnvironmentId,
    });
    yield* makeThreadAttachmentCheckpoint(sql, events).capture({
      threadId: f.threadId,
      generation: 1,
      turnId: "turn-1",
      attachmentsDir,
      artifactRoot: `${f.root}/chat-outbox`,
    });
    const attachments = yield* makeThreadAttachmentCheckpointTransfer(sql).pack({
      threadId: f.threadId,
      generation: 1,
      turnId: "turn-1",
      sourceEnvironmentId,
      scratchRoot: `${f.root}/packing`,
      chunkSizeBytes: 128,
    });
    return { native, attachments, history, attachment, sourceSequence };
  }).pipe(Effect.provide(serverState));
  const journal = makeThreadJournalStore(f.sql);
  const owner = { threadId: f.threadId, environmentId: sourceEnvironmentId, generation: 1 };
  for (const event of bundle.history) yield* journal.append({ ...owner, event });
  yield* journal.confirmThrough({ ...owner, sourceSequence: bundle.sourceSequence });
  const store = makeThreadAttachmentCheckpointStore(f.sql, f.objects);
  const upload = Effect.fnUntraced(function* (
    packed: typeof bundle.native | typeof bundle.attachments,
    omit?: string,
  ) {
    for (const entry of packed.uploads) {
      if (entry.artifactId === omit) continue;
      const bytes = yield* f.fs.readFile(entry.path);
      yield* f.transfer.upload({
        ...entry,
        threadId: f.threadId,
        operationId: packed.header.operationId,
        retentionDays: 1,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      });
    }
  });
  const publish = store.publish({
    threadId: f.threadId,
    operationId: bundle.attachments.header.operationId,
    manifestArtifactId: bundle.attachments.artifactId,
    nativeCheckpointOperationId: bundle.native.header.operationId,
  });
  const recovery = {
    threadId: f.threadId,
    operationId: NodeCrypto.randomUUID(),
    checkpointOperationId: bundle.native.header.operationId,
    expected: {
      sourceEnvironmentId,
      generation: 1,
      sourceSequence: bundle.sourceSequence,
      nativeThreadId: nativeId,
    },
  };
  yield* upload(bundle.native);
  yield* f.publish(bundle.native);
  return {
    ...f,
    ...bundle,
    sourceEnvironmentId,
    journal,
    owner,
    storeNative: f.store,
    attachmentStore: store,
    upload,
    publishAttachments: publish,
    recovery,
  };
});

/** Every later point is packed from real event-store history, not just rewritten catalog metadata. */
export const laterAttachmentCheckpoint = Effect.fnUntraced(function* (
  f: Pick<
    Effect.Success<typeof attachmentCheckpointCatalogFixture>,
    | "history"
    | "native"
    | "threadId"
    | "root"
    | "sourceEnvironmentId"
    | "journal"
    | "owner"
    | "upload"
    | "storeNative"
  >,
  offset: number,
  captureOperationId?: string,
) {
  const bundle = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      events = yield* OrchestrationEventStore;
    const history: OrchestrationEvent[] = [];
    for (const event of f.history) history.push(yield* events.append(event));
    for (let index = 1; index <= offset; index++) {
      const message = f.history[1]!;
      history.push(
        yield* events.append(
          decodeEvent({
            ...message,
            sequence: 0,
            eventId: `${f.threadId}-later-${index}`,
            payload: { ...message.payload, messageId: `later-${index}`, text: `later-${index}` },
          }),
        ),
      );
    }
    const sourceSequence = history.at(-1)!.sequence,
      turnId = captureOperationId ? f.native.header.turnId : `later-${offset}`;
    const native = yield* packedCheckpoint({
      root: f.root,
      threadId: f.threadId,
      turnId,
      sourceSequence,
      sourceEnvironmentId: f.sourceEnvironmentId,
      ...(captureOperationId === undefined ? {} : { captureOperationId }),
      events,
    });
    yield* makeThreadAttachmentCheckpoint(sql, events).capture({
      threadId: f.threadId,
      generation: 1,
      turnId,
      ...(captureOperationId === undefined ? {} : { captureOperationId }),
      attachmentsDir: `${f.root}/source-chat-files`,
      artifactRoot: `${f.root}/chat-outbox`,
    });
    const attachments = yield* makeThreadAttachmentCheckpointTransfer(sql).pack({
      threadId: f.threadId,
      generation: 1,
      turnId,
      sourceEnvironmentId: f.sourceEnvironmentId,
      ...(captureOperationId === undefined ? {} : { captureOperationId }),
      scratchRoot: `${f.root}/packing`,
      chunkSizeBytes: 128,
    });
    return { native, attachments, history, sourceSequence };
  }).pipe(Effect.provide(serverState));
  for (const event of bundle.history) yield* f.journal.append({ ...f.owner, event });
  yield* f.journal.confirmThrough({ ...f.owner, sourceSequence: bundle.sourceSequence });
  yield* f.upload(bundle.native);
  yield* f.storeNative.publish({
    threadId: f.threadId,
    operationId: bundle.native.header.operationId,
    manifestArtifactId: bundle.native.artifactId,
  });
  return bundle;
});
