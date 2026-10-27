import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationEvent, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../../persistence/ThreadExecutionFence.ts";
import { makeThreadNativeCheckpoint } from "../ThreadNativeCheckpoint.ts";
import { makeThreadAttachmentCheckpoint } from "../ThreadAttachmentCheckpoint.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ThreadExecution } from "../ThreadExecution.ts";
import { makeThreadExecutionRelay } from "../ThreadExecutionRelay.ts";

const at = "2026-10-05T10:00:00.000Z";
const decode = Schema.decodeUnknownSync(OrchestrationEvent);
export const makeAttachmentCheckpointFixture = Effect.fnUntraced(function* (
  includeAttachments = true,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const events = yield* OrchestrationEventStore;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "attachment-checkpoint-" }),
  );
  const threadId = "attachment-thread",
    attachmentsDir = path.join(root, "files");
  yield* fs.makeDirectory(attachmentsDir);
  const attachments: ChatAttachment[] = [1, 2, 3].map((value) => ({
    type: "file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    id: `${threadId}-00000000-0000-4000-8000-00000000000${value}-txt`,
  }));
  for (const [index, attachment] of attachments.entries())
    yield* fs.writeFileString(
      path.join(attachmentsDir, attachmentRelativePath(attachment)!),
      `data${index}`,
    );
  yield* fs.writeFileString(path.join(attachmentsDir, "unrelated-auth.json"), "not-this-thread");
  let serial = 0;
  const append = (type: string, payload: unknown) =>
    events.append(
      decode({
        type,
        sequence: 0,
        eventId: `event-${++serial}`,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload,
      }),
    );
  yield* append("thread.created", {
    threadId,
    projectId: "project",
    title: "Attachments",
    modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdAt: at,
    updatedAt: at,
  });
  const message = (attachment: ChatAttachment) =>
    append("thread.message-sent", {
      threadId,
      messageId: `message-${serial}`,
      role: "user",
      text: "",
      attachments: [attachment],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    });
  if (includeAttachments) {
    yield* message(attachments[0]!);
    yield* append("thread.prompt-queue-changed", {
      threadId,
      entry: {
        messageId: "queued",
        text: "queued",
        attachments: [attachments[1]],
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 0,
        acceptedSequence: 1,
        createdAt: at,
        state: "pending",
      },
      updatedAt: at,
    });
    yield* append("thread.prompt-queue-changed", {
      threadId,
      removedMessageId: "queued",
      updatedAt: at,
    });
  }
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at)
    VALUES(${threadId},'project','Attachments','{"provider":"codex","model":"gpt-5"}',${at},${at})`;
  const owner = {
    threadId,
    environmentId: "source",
    projectId: "project",
    relayUrl: "https://relay.invalid",
    generation: 1,
    operationId: "enroll",
  };
  const fences = makeThreadExecutionFence(sql);
  yield* fences.prepare(owner);
  yield* fences.activate(owner);
  const native = makeThreadNativeCheckpoint(sql);
  const nativeInput = { threadId, turnId: "turn-1", artifactRoot: path.join(root, "native") };
  const point = yield* native.capture(nativeInput, (stage) =>
    Effect.gen(function* () {
      const directory = path.join(stage, "conversation");
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(path.join(directory, "manifest.json"), "{}");
      yield* fs.writeFileString(path.join(directory, "rollout.jsonl"), "native checkpoint fixture");
      return { directory, nativeThreadId: "native" };
    }),
  );
  const store = makeThreadAttachmentCheckpoint(sql, events);
  const input = {
    threadId,
    generation: 1,
    turnId: "turn-1",
    artifactRoot: path.join(root, "checkpoints"),
    attachmentsDir,
  };
  return {
    fs,
    path,
    sql,
    root,
    events,
    attachments,
    attachmentsDir,
    owner,
    fences,
    native,
    nativeInput,
    point: point!,
    store,
    input,
    message,
  };
});
export const attachmentCheckpointFixture = makeAttachmentCheckpointFixture();
const services = OrchestrationEventStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.effect(
      ThreadExecution,
      Effect.gen(function* () {
        return makeThreadExecutionRelay(yield* SqlClient.SqlClient, {
          admit: () => Effect.succeed({ completed: false, newlyAdmitted: true }),
          complete: () => Effect.void,
        });
      }),
    ).pipe(Layer.provide(SqlitePersistenceMemory)),
  ),
  Layer.provideMerge(NodeServices.layer),
);
export const runAttachmentCheckpointTest = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(services));
