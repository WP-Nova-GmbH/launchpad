import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { exportCodexConversation } from "../provider/Drivers/CodexConversationTransfer.ts";
import { threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  materializeNativeCheckpoint,
  makeThreadNativeCheckpointTransfer,
} from "./ThreadNativeCheckpointTransfer.ts";
import { makeThreadAttachmentCheckpointTransfer } from "./ThreadAttachmentCheckpointTransfer.ts";
import {
  makeThreadCheckpointPublisher,
  ThreadCheckpointPublishError,
  type ThreadCheckpointTransport,
} from "./ThreadCheckpointPublisher.ts";
import {
  attachmentCheckpointFixture,
  runAttachmentCheckpointTest as run,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fnUntraced(function* (captureOperationId?: string) {
  const f = yield* attachmentCheckpointFixture;
  const nativeId = "01900000-0000-7000-8000-000000000076";
  const home = f.path.join(f.root, "codex"),
    sessions = f.path.join(home, "sessions", "2026", "10", "01");
  yield* f.fs.makeDirectory(sessions, { recursive: true });
  const rollout = f.path.join(sessions, `rollout-2026-10-01T12-00-00-${nativeId}.jsonl`);
  yield* f.fs.writeFileString(
    rollout,
    [
      {
        ordinal: 0,
        timestamp: "2026-10-01T12:00:00Z",
        type: "session_meta",
        payload: { id: nativeId, cli_version: "0.159.3", history_mode: "paginated" },
      },
      {
        ordinal: 1,
        timestamp: "2026-10-01T12:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "remember amber-otter" }],
        },
      },
    ]
      .map((row) => encode(row))
      .join("\n") + "\n",
  );
  const conversation = (artifactRoot: string) =>
    exportCodexConversation({
      codexHome: home,
      rolloutPath: rollout,
      threadId: nativeId,
      artifactRoot,
    }).pipe(
      Effect.map((archive) => ({
        directory: archive.directory,
        nativeThreadId: archive.manifest.threadId,
      })),
    );
  if (captureOperationId) {
    yield* f.native.capture({ ...f.nativeInput, turnId: "aaa-prior" }, conversation);
    yield* f.store.capture({ ...f.input, turnId: "aaa-prior" });
    yield* f.fences.beginDrain({
      ...f.owner,
      operationId: captureOperationId,
      previousOperationId: f.owner.operationId,
    });
    yield* f.fences.freeze({ ...f.owner, operationId: captureOperationId });
  }
  const turnId = "publish-turn";
  const frozen = captureOperationId ? { captureOperationId } : {};
  const point = (yield* f.native.capture({ ...f.nativeInput, turnId, ...frozen }, conversation))!;
  const saved = yield* f.store.capture({ ...f.input, turnId, ...frozen });
  const input = {
    threadId: f.owner.threadId,
    generation: 1,
    turnId,
    ...frozen,
    sourceEnvironmentId: f.owner.environmentId,
    scratchRoot: f.path.join(f.root, "packing"),
  };
  const packedNative = yield* makeThreadNativeCheckpointTransfer(f.sql, f.events).pack(input);
  const packedAttachments = yield* makeThreadAttachmentCheckpointTransfer(f.sql).pack(input);
  const nativeReceipt = {
    ...packedNative.header,
    nativeThreadId: nativeId,
    manifestArtifactId: packedNative.artifactId,
    manifestSha256: packedNative.sha256,
  };
  const attachmentReceipt = {
    ...packedAttachments.header,
    manifestArtifactId: packedAttachments.artifactId,
    manifestSha256: packedAttachments.sha256,
  };
  yield* f.fs.remove(packedNative.directory, { recursive: true });
  yield* f.fs.remove(packedAttachments.directory, { recursive: true });
  const uploaded = new Map<string, string>(),
    attempts: string[] = [],
    publications: string[] = [];
  let loseNativeReply = false,
    loseAttachmentReply = false,
    wrongUploadReceipt = false;
  const fail = () =>
    new ThreadCheckpointPublishError({ threadId: f.owner.threadId, detail: "Lost reply" });
  const transport: ThreadCheckpointTransport = {
    upload: (owner, file, body) =>
      Effect.gen(function* () {
        const hash = NodeCrypto.createHash("sha256");
        let size = 0;
        yield* Stream.runForEach(body.pipe(Stream.mapError(fail)), (part) =>
          Effect.sync(() => {
            hash.update(part);
            size += part.length;
          }),
        ).pipe(Effect.mapError(fail));
        expect(size).toBe(file.sizeBytes);
        expect(hash.digest("hex")).toBe(file.sha256);
        const intent = encode(file),
          prior = uploaded.get(file.artifactId);
        if (prior) expect(prior).toBe(intent);
        uploaded.set(file.artifactId, intent);
        attempts.push(file.artifactId);
        return {
          ...file,
          threadId: ThreadId.make(owner.threadId),
          state: "complete" as const,
          ...(wrongUploadReceipt ? { sha256: "0".repeat(64) } : {}),
        };
      }),
    publishNative: (_owner, input) =>
      Effect.gen(function* () {
        expect(input).toEqual({
          operationId: nativeReceipt.operationId,
          manifestArtifactId: nativeReceipt.manifestArtifactId,
        });
        for (const file of packedNative.uploads) expect(uploaded.has(file.artifactId)).toBe(true);
        publications.push("native");
        if (loseNativeReply) {
          loseNativeReply = false;
          return yield* fail();
        }
        return nativeReceipt;
      }),
    publishAttachments: (_owner, input) =>
      Effect.gen(function* () {
        expect(input).toEqual({
          operationId: attachmentReceipt.operationId,
          manifestArtifactId: attachmentReceipt.manifestArtifactId,
          nativeCheckpointOperationId: nativeReceipt.operationId,
        });
        for (const file of packedAttachments.uploads)
          expect(uploaded.has(file.artifactId)).toBe(true);
        publications.push("attachments");
        if (loseAttachmentReply) {
          loseAttachmentReply = false;
          return yield* fail();
        }
        return attachmentReceipt;
      }),
  };
  const publisher = () =>
    makeThreadCheckpointPublisher(f.sql, transport, input.scratchRoot, f.events);
  const acknowledgeHistory = f.sql`INSERT INTO thread_relay_history_cursors (thread_id,generation,source_sequence) VALUES (${f.owner.threadId},1,${point.sourceSequence})`;
  const markers = Effect.all({
    native: f.native.get(f.owner.threadId, 1, threadCheckpointId(turnId, captureOperationId)),
    attachments: f.store.get(f.owner.threadId, 1, threadCheckpointId(turnId, captureOperationId)),
  });
  return {
    ...f,
    point,
    saved,
    publisher,
    acknowledgeHistory,
    markers,
    input,
    uploaded,
    attempts,
    publications,
    nativeReceipt,
    attachmentReceipt,
    loseNative: () => {
      loseNativeReply = true;
    },
    loseAttachment: () => {
      loseAttachmentReply = true;
    },
    wrongReceipt: () => {
      wrongUploadReceipt = true;
    },
  };
});

it.effect("waits for mirrored history and a complete attachment outbox before upload", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.publisher().synchronize(f.owner.threadId);
      expect(f.attempts).toEqual([]);
      yield* f.acknowledgeHistory;
      yield* f.publisher().synchronize(f.owner.threadId);
      const points = yield* f.markers;
      expect(points.native?.publishedArtifactId).toBe(f.nativeReceipt.manifestArtifactId);
      expect(points.attachments?.publishedArtifactId).toBe(f.attachmentReceipt.manifestArtifactId);
      const count = f.attempts.length;
      yield* f.publisher().synchronize(f.owner.threadId);
      expect(f.attempts).toHaveLength(count);
      expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual([]);
    }),
  ),
);
it.effect(
  "retries an uncertain native publication with the same artifact and operation IDs after restart",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.acknowledgeHistory;
        f.loseNative();
        expect(yield* Effect.flip(f.publisher().synchronize(f.owner.threadId))).toMatchObject({
          _tag: "ThreadCheckpointPublishError",
          threadId: f.owner.threadId,
        });
        expect((yield* f.markers).native?.publishedArtifactId).toBeNull();
        const first = [...f.attempts];
        yield* f.publisher().synchronize(f.owner.threadId);
        expect(f.attempts.slice(first.length, first.length * 2)).toEqual(first);
        expect(f.publications).toEqual(["native", "native", "attachments"]);
        expect((yield* f.markers).attachments?.publishedArtifactId).toBe(
          f.attachmentReceipt.manifestArtifactId,
        );
        expect(yield* f.fs.exists(f.point.directory)).toBe(true);
      }),
    ),
);
it.effect(
  "retries the missing attachment receipt without treating native publication as a complete pair",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.acknowledgeHistory;
        f.loseAttachment();
        yield* Effect.flip(f.publisher().synchronize(f.owner.threadId));
        const pending = yield* f.markers;
        expect(pending.native?.publishedArtifactId).toBe(f.nativeReceipt.manifestArtifactId);
        expect(pending.attachments?.publishedArtifactId).toBeNull();
        yield* f.publisher().synchronize(f.owner.threadId);
        expect(f.publications).toEqual(["native", "attachments", "native", "attachments"]);
        expect((yield* f.markers).attachments?.publishedArtifactId).toBe(
          f.attachmentReceipt.manifestArtifactId,
        );
        expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual([]);
      }),
    ),
);
it.effect("rejects a mismatched upload receipt and preserves both local outboxes", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.acknowledgeHistory;
      f.wrongReceipt();
      yield* Effect.flip(f.publisher().synchronize(f.owner.threadId));
      expect(f.publications).toEqual([]);
      expect((yield* f.markers).native?.publishedArtifactId).toBeNull();
      expect((yield* f.markers).attachments?.publishedArtifactId).toBeNull();
      expect(yield* f.fs.exists(f.point.directory)).toBe(true);
      expect(yield* f.fs.exists(f.saved.directory)).toBe(true);
    }),
  ),
);
it.effect("does not upload retired ownership or a corrupt local conversation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.acknowledgeHistory;
      yield* f.sql`UPDATE thread_execution_fences SET phase='retired' WHERE thread_id=${f.owner.threadId}`;
      yield* f.publisher().synchronize(f.owner.threadId);
      expect(f.attempts).toEqual([]);
      yield* f.sql`UPDATE thread_execution_fences SET phase='active' WHERE thread_id=${f.owner.threadId}`;
      yield* f.fs.writeFileString(f.path.join(f.point.directory, "rollout.jsonl"), "damaged");
      yield* Effect.flip(f.publisher().synchronize(f.owner.threadId));
      expect(f.attempts).toEqual([]);
      expect((yield* f.markers).native?.publishedArtifactId).toBeNull();
    }),
  ),
);

it.effect("publishes the exact frozen recovery point ahead of an older unpublished turn", () =>
  run(
    Effect.gen(function* () {
      const operationId = NodeCrypto.randomUUID(),
        f = yield* fixture(operationId);
      yield* f.acknowledgeHistory;
      yield* f.publisher().synchronize(f.owner.threadId, operationId);
      expect((yield* f.markers).native?.publishedArtifactId).toBe(
        f.nativeReceipt.manifestArtifactId,
      );
      expect((yield* f.markers).attachments?.publishedArtifactId).toBe(
        f.attachmentReceipt.manifestArtifactId,
      );
      expect(
        (yield* f.native.get(f.owner.threadId, 1, "aaa-prior"))?.publishedArtifactId,
      ).toBeNull();
      expect((yield* f.fences.get(f.owner.threadId))?.phase).toBe("frozen");
      expect(f.publications).toEqual(["native", "attachments"]);
    }),
  ),
);

it.effect(
  "frozen recovery retains complete accepted/rejected receipts after the source database and files are lost",
  () =>
    run(
      Effect.gen(function* () {
        const operationId = NodeCrypto.randomUUID(),
          f = yield* fixture(operationId);
        const at = "2026-10-07T12:00:00.000Z";
        yield* f.sql`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,project_id,accepted_at,result_sequence,status,error)
    VALUES('internal-stopped','thread',${f.owner.threadId},'project',${at},${f.point.sourceSequence},'accepted',NULL),
      ('rejected-command','thread',${f.owner.threadId},'project',${at},0,'rejected','Already handled')`;
        const transfer = makeThreadNativeCheckpointTransfer(f.sql, f.events);
        const packed = yield* transfer.pack(f.input),
          retried = yield* transfer.pack(f.input);
        expect(retried.manifest).toEqual(packed.manifest);
        expect(packed.header.recoveryHistory).toMatchObject({
          operationId,
          eventCount: 4,
          receiptCount: 2,
        });
        expect(packed.uploads.some((file) => file.kind === "history")).toBe(true);
        yield* f.fs.remove(f.point.directory, { recursive: true });
        yield* f.fs.remove(f.path.join(f.root, "codex"), { recursive: true });
        yield* f.sql`DELETE FROM orchestration_events WHERE stream_id=${f.owner.threadId}`;
        yield* f.sql`DELETE FROM orchestration_command_receipts WHERE aggregate_id=${f.owner.threadId}`;
        const recovered = yield* materializeNativeCheckpoint({
          manifest: packed.manifest,
          chunkDirectory: packed.directory,
          destinationRoot: f.path.join(f.root, "recovered"),
          threadId: f.owner.threadId,
          operationId: packed.header.operationId,
          transferManifestSha256: packed.manifest.transferManifestSha256,
          expected: packed.header,
        });
        expect(
          recovered.recoveryHistory?.receipts.map((r) => [
            r.commandId,
            r.status,
            r.acceptedAt,
            r.error,
          ]),
        ).toEqual([
          ["internal-stopped", "accepted", at, null],
          ["rejected-command", "rejected", at, "Already handled"],
        ]);
        const history = yield* Stream.runCollect(recovered.recoveryHistory!.events);
        expect(history.map((e) => e.eventId)).toEqual(["event-1", "event-2", "event-3", "event-4"]);
        expect(history[2]?.type).toBe("thread.prompt-queue-changed");
        expect(yield* f.fs.exists(f.path.join(recovered.nativeDirectory, "auth.json"))).toBe(false);
      }),
    ),
);

it.effect("ordinary turn checkpoints do not export live, changing history", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const packed = yield* makeThreadNativeCheckpointTransfer(f.sql, f.events).pack(f.input);
      expect(packed.header.recoveryHistory).toBeUndefined();
      expect(packed.uploads.some((file) => file.kind === "history")).toBe(false);
    }),
  ),
);
