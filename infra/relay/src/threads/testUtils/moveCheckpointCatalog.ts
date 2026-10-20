import * as NodeCrypto from "node:crypto";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OrchestrationEvent } from "@t3tools/contracts";
import { ThreadTransferArchiveManifest } from "@t3tools/contracts/threadTransfer";
import {
  ThreadTransferChunkManifest,
  type CodexConversationManifest,
  type ThreadAttachmentManifest,
} from "@t3tools/contracts/relay";
import { makeThreadPlacementStore } from "../ThreadPlacementStore.ts";
import { makeThreadArtifactTransfer } from "../ThreadArtifactTransfer.ts";
import { makeThreadMoveArtifactStore } from "../ThreadMoveArtifactStore.ts";
import { makeLocalThreadArtifactObjects } from "../ThreadArtifactLocalObjects.ts";

const encodeArchive = Schema.encodeSync(Schema.fromJsonString(ThreadTransferArchiveManifest));
const encodeHistory = Schema.encodeSync(
  Schema.fromJsonString(ThreadTransferArchiveManifest.fields.history),
);
const encodeAttachments = Schema.encodeSync(
  Schema.fromJsonString(ThreadTransferArchiveManifest.fields.attachments),
);
const encodeWorkspace = Schema.encodeSync(
  Schema.fromJsonString(ThreadTransferArchiveManifest.fields.workspace),
);
const encodeChunks = Schema.encodeSync(Schema.fromJsonString(ThreadTransferChunkManifest));
const decodeChunks = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));
const bytes = (value: string) => new TextEncoder().encode(value);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));
const digest = (value: Uint8Array) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const part = (value: Uint8Array) => ({ sha256: digest(value), size: value.length });
/** Object storage and Postgres are real; the empty Git payload is not a destination import proof. */
export const prepareMoveCheckpointArchive = Effect.fnUntraced(function* (input: {
  sql: PgClient;
  fs: FileSystem.FileSystem;
  root: string;
  threadId: string;
  sourceEnvironmentId: string;
  operationId?: string;
  history: ReadonlyArray<OrchestrationEvent>;
  native?: CodexConversationManifest;
  attachments?: ThreadAttachmentManifest;
  extraFiles?: ReadonlyMap<string, Uint8Array>;
  omit?: string;
  corruptHistoryId?: boolean;
  corruptHistoryText?: boolean;
  vmDestination?: boolean;
  bundleContent?: Uint8Array;
}) {
  const placements = makeThreadPlacementStore(input.sql),
    operationId = input.operationId ?? NodeCrypto.randomUUID();
  const move = {
    threadId: input.threadId,
    operationId,
    actorUserId: "user",
    sourceEnvironmentId: input.sourceEnvironmentId,
    expectedGeneration: 1,
    destinationEnvironmentId: `destination-${input.threadId}`,
    destinationProjectId: "destination-project",
  };
  yield* placements.beginMove(move);
  if (input.vmDestination) {
    yield* input.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state)
      VALUES(${operationId},${input.threadId},'org','user','template','creating')`;
    yield* input.sql`INSERT INTO relay_thread_vm_move_destinations(operation_id,allocation_id) VALUES(${operationId},${operationId})`;
  }
  const eventBytes = bytes(
    input.history
      .map((e, i) =>
        encodeEvent(
          input.corruptHistoryId && i === 1
            ? ({ ...e, eventId: `wrong-${e.eventId}` } as OrchestrationEvent)
            : input.corruptHistoryText && e.type === "thread.message-sent"
              ? { ...e, payload: { ...e.payload, text: "changed after mirror" } }
              : e,
        ),
      )
      .join("\n") + "\n",
  );
  const history = {
    format: "launchpad-history-v1" as const,
    threadId: input.threadId,
    operationId,
    environmentId: input.sourceEnvironmentId,
    generation: 1,
    sourceSequence: input.history.at(-1)!.sequence,
    eventCount: input.history.length,
    events: part(eventBytes),
    receipts: part(bytes("")),
    receiptCount: 0,
  };
  const attachments = input.attachments ?? {
    format: "launchpad-attachments-v1" as const,
    threadId: input.threadId,
    files: [],
  };
  const empty = bytes("");
  const workspace = {
    format: "launchpad-workspace-v1" as const,
    threadId: input.threadId,
    objectFormat: "sha1" as const,
    head: "a".repeat(40),
    branch: "main",
    indexTree: "b".repeat(40),
    indexCommit: "c".repeat(40),
    checkpoints: [],
    bundle: part(input.bundleContent ?? empty),
    index: part(empty),
    files: [],
  };
  const header = {
    format: "launchpad-thread-transfer-v1" as const,
    history,
    attachments,
    workspace,
    native: input.native ?? null,
  };
  const manifest = bytes(encodeArchive(header));
  const files = new Map<string, Uint8Array>([
    ["manifest.json", manifest],
    ["history/manifest.json", bytes(encodeHistory(history))],
    ["history/events.jsonl", eventBytes],
    ["history/receipts.jsonl", empty],
    ["attachments/manifest.json", bytes(encodeAttachments(attachments))],
    ["workspace/manifest.json", bytes(encodeWorkspace(workspace))],
    ["workspace/repository.bundle", input.bundleContent ?? empty],
    ["workspace/index", empty],
    ...(input.extraFiles ?? []),
  ]);
  if (input.omit && files.get(input.omit)?.length === 0) files.delete(input.omit);
  const owner = {
    threadId: input.threadId,
    environmentId: input.sourceEnvironmentId,
    generation: 1,
  };
  yield* placements.sourceFrozen({
    ...move,
    ...owner,
    sourceCursor: history.sourceSequence,
    manifestSha256: digest(manifest),
  });
  const objects = makeLocalThreadArtifactObjects(input.fs, `${input.root}/move-objects`),
    transfer = makeThreadArtifactTransfer(input.sql, objects);
  const entries = [...files].map(([path, content]) => ({
    path,
    content,
    artifactId: NodeCrypto.randomUUID(),
    kind:
      path === "manifest.json"
        ? ("manifest" as const)
        : path.startsWith("attachments/")
          ? ("attachment" as const)
          : path.startsWith("history/")
            ? ("history" as const)
            : path.startsWith("native/")
              ? ("native" as const)
              : ("workspace" as const),
  }));
  const chunkManifest = {
    format: "launchpad-thread-chunks-v1" as const,
    threadId: input.threadId,
    operationId,
    sourceEnvironmentId: input.sourceEnvironmentId,
    generation: 1,
    transferManifestSha256: digest(manifest),
    files: entries.map((e) => ({
      path: e.path,
      sha256: digest(e.content),
      sizeBytes: e.content.length,
      chunks: e.content.length
        ? [{ artifactId: e.artifactId, sha256: digest(e.content), sizeBytes: e.content.length }]
        : [],
    })),
  };
  const manifestBytes = bytes(encodeChunks(chunkManifest)),
    manifestArtifactId = NodeCrypto.randomUUID();
  const uploads = [
    ...entries,
    {
      artifactId: manifestArtifactId,
      path: "chunks.json",
      kind: "manifest" as const,
      content: manifestBytes,
    },
  ];
  const upload = Effect.fnUntraced(function* () {
    for (const e of uploads)
      if (e.path !== input.omit && e.content.length)
        yield* transfer.upload({
          artifactId: e.artifactId,
          kind: e.kind,
          threadId: input.threadId,
          operationId,
          sha256: digest(e.content),
          sizeBytes: e.content.length,
          retentionDays: 1,
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(e.content);
              c.close();
            },
          }),
        });
  });
  yield* upload();
  const store = makeThreadMoveArtifactStore(input.sql, objects),
    publish = store.publish({ threadId: input.threadId, operationId, manifestArtifactId });
  const ready = placements.destinationReady({
    ...move,
    environmentId: move.destinationEnvironmentId,
    sourceCursor: history.sourceSequence,
    manifestSha256: digest(manifest),
  });
  return {
    move,
    owner,
    header,
    objects,
    transfer,
    store,
    placements,
    publish,
    ready,
    manifestArtifactId,
    uploads,
  };
});
export const readPackedMoveFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  packed: { artifactId: string; uploads: ReadonlyArray<{ artifactId: string; path: string }> },
) {
  const manifestFile = packed.uploads.find((e) => e.artifactId === packed.artifactId)!;
  const manifest = yield* decodeChunks(yield* fs.readFileString(manifestFile.path));
  const files = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    if (file.path === "manifest.json") continue;
    const content = new Uint8Array(file.sizeBytes);
    let offset = 0;
    for (const chunk of file.chunks) {
      const part = yield* fs.readFile(
        packed.uploads.find((e) => e.artifactId === chunk.artifactId)!.path,
      );
      content.set(part, offset);
      offset += part.length;
    }
    files.set(file.path, content);
  }
  return files;
});
