import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  RelayThreadVmIndependentHistory,
  ThreadTransferArtifactManifest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { materializeThreadVmIndependentHistory } from "./ThreadVmIndependentHistory.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeIndex = Schema.encodeSync(Schema.fromJsonString(ThreadTransferArtifactManifest));
const decodeHistory = Schema.decodeUnknownEffect(RelayThreadVmIndependentHistory);
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string) => new TextEncoder().encode(text);
const at = "2026-10-30T00:00:00.000Z";
const fixture = Effect.fnUntraced(function* (
  version: "v1" | "v2",
  mutation?: "extra-file" | "header" | "gap",
) {
  const fs = yield* FileSystem.FileSystem;
  const scratchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "independent-history-" });
  const threadId = "independent-thread";
  const operationId = NodeCrypto.randomUUID();
  const end = mutation === "gap" ? 3 : 2;
  const events = [
    {
      type: "thread.created",
      sequence: 1,
      eventId: "created",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        projectId: "project",
        title: "Independent",
        modelSelection: { provider: "codex", model: "gpt-5", instanceId: "codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      type: "thread.message-sent",
      sequence: end,
      eventId: "message",
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        messageId: "message",
        role: "user",
        text: "Keep independent history.",
        turnId: null,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    },
  ];
  const eventBytes = utf8(events.map((event) => encodeJson(event)).join("\n") + "\n");
  const receiptBytes = new Uint8Array();
  const header = {
    format: "launchpad-history-v1",
    threadId,
    operationId,
    environmentId: mutation === "header" ? "other" : "source",
    generation: 1,
    sourceSequence: end,
    eventCount: events.length,
    events: { sha256: digest(eventBytes), size: eventBytes.length },
    receiptCount: 0,
    receipts: { sha256: digest(receiptBytes), size: 0 },
  };
  const headerBytes = utf8(encodeJson(header));
  const entries = [
    { path: "history/manifest.json", bytes: headerBytes },
    { path: "history/events.jsonl", bytes: eventBytes },
    { path: "history/receipts.jsonl", bytes: receiptBytes },
  ];
  if (mutation === "extra-file")
    entries.push({ path: "native/unrelated-credentials", bytes: utf8("must not import") });
  if (version === "v2") entries.sort((left, right) => (left.path < right.path ? -1 : 1));
  const objects = new Map<string, Uint8Array>();
  const files = entries.map((entry) => {
    const artifactId = NodeCrypto.randomUUID();
    if (entry.bytes.length) objects.set(artifactId, entry.bytes);
    return {
      path: entry.path,
      sha256: digest(entry.bytes),
      sizeBytes: entry.bytes.length,
      chunks: entry.bytes.length
        ? [{ artifactId, sha256: digest(entry.bytes), sizeBytes: entry.bytes.length }]
        : [],
    };
  });
  const scope = {
    threadId,
    operationId,
    sourceEnvironmentId: "source",
    generation: 1,
    transferManifestSha256: digest(headerBytes),
  };
  const manifest: ThreadTransferArtifactManifest =
    version === "v1"
      ? { ...scope, format: "launchpad-thread-chunks-v1", files }
      : {
          ...scope,
          format: "launchpad-thread-chunks-v2",
          objects: files.flatMap((file) =>
            file.chunks.map((chunk) => ({
              ...chunk,
              kind: file.path.startsWith("history/") ? ("history" as const) : ("native" as const),
            })),
          ),
          files: files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            slices: file.chunks.map((chunk) => ({
              artifactId: chunk.artifactId,
              offset: 0,
              length: chunk.sizeBytes,
            })),
          })),
        };
  const indexId = NodeCrypto.randomUUID();
  const index = utf8(encodeIndex(manifest));
  objects.set(indexId, index);
  const history = yield* decodeHistory({
    manifestArtifactId: indexId,
    manifestSha256: digest(index),
    sequenceSpace: "relay-cursor-v1",
    nativeBoundary: {
      checkpointOperationId: NodeCrypto.randomUUID(),
      sourceEnvironmentId: "source",
      generation: 1,
      sourceSequence: 1,
      relayCursor: 1,
    },
    throughRelayCursor: end,
    throughCommandPosition: 0,
  });
  const requested: string[] = [];
  return {
    requested,
    indexId,
    input: {
      threadId,
      operationId,
      history,
      scratchRoot,
      readArtifact: (id: string) =>
        Effect.sync(() => {
          requested.push(id);
          return Stream.make(objects.get(id)!);
        }),
    },
  };
});

it.layer(NodeServices.layer)("independent history indexes", (it) => {
  for (const version of ["v1", "v2"] as const)
    it.effect(
      `restores the three history-only files from ${version} without a top-level manifest`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(version);
          const restored = yield* materializeThreadVmIndependentHistory(f.input);
          const events = Array.from(yield* Stream.runCollect(restored.events));
          expect(events.map((event) => event.sequence)).toEqual([1, 2]);
          expect(events[1]?.type).toBe("thread.message-sent");
          expect(new Set(f.requested).size).toBe(f.requested.length);
        }),
    );
  for (const mutation of ["extra-file", "header", "gap"] as const)
    it.effect(`rejects v2 independent history with ${mutation}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture("v2", mutation);
        yield* Effect.flip(materializeThreadVmIndependentHistory(f.input));
        if (mutation === "extra-file") expect(f.requested).toEqual([f.indexId]);
      }),
    );
});
