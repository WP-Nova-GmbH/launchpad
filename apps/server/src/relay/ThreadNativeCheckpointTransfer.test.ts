import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  exportCodexConversation,
  importCodexConversation,
} from "../provider/Drivers/CodexConversationTransfer.ts";
import {
  digestNativeCheckpointArchive,
  makeThreadNativeCheckpoint,
} from "./ThreadNativeCheckpoint.ts";
import {
  makeThreadNativeCheckpointTransfer,
  materializeNativeCheckpoint,
} from "./ThreadNativeCheckpointTransfer.ts";

const nativeId = "01900000-0000-7000-8000-000000000001";
const version = "0.159.3";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fnUntraced(function* (graph = false) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "checkpoint-transfer-" }),
  );
  const home = path.join(root, "source"),
    sessions = path.join(home, "sessions", "2026", "10", "01");
  yield* fs.makeDirectory(sessions, { recursive: true });
  const attachments = path.join(root, "attachments"),
    image = path.join(attachments, "image.png");
  yield* fs.makeDirectory(attachments);
  yield* fs.writeFile(image, new Uint8Array([137, 80, 78, 71, 0, 1]));
  const rolloutPath = path.join(sessions, `rollout-2026-10-01T12-00-00-${nativeId}.jsonl`);
  const row = (ordinal: number, type: string, payload: unknown) =>
    encode({ ordinal, timestamp: "2026-10-01T12:00:00Z", type, payload }) + "\n";
  yield* fs.writeFileString(
    rolloutPath,
    row(0, "session_meta", {
      id: nativeId,
      ...(graph ? { session_id: nativeId } : {}),
      cli_version: version,
      history_mode: "paginated",
    }) +
      row(1, "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "remember amber-otter" }],
      }) +
      row(2, "event_msg", {
        type: "user_message",
        message: "image",
        local_images: [image],
        file_ids: [],
      }),
  );
  yield* fs.writeFileString(path.join(home, "auth.json"), "private-login-must-stay-here");
  yield* fs.writeFileString(path.join(sessions, "unrelated.jsonl"), "unrelated-conversation");
  yield* sql`INSERT INTO thread_execution_fences
    (thread_id, relay_url, environment_id, project_id, generation, operation_id, phase)
    VALUES ('portable', 'https://relay.invalid', 'source', 'project', 1, 'enroll', 'active')`;
  const store = makeThreadNativeCheckpoint(sql);
  const point = yield* store.capture(
    { threadId: "portable", turnId: "turn-1", artifactRoot: path.join(root, "outbox") },
    (artifactRoot) =>
      exportCodexConversation({
        codexHome: home,
        rolloutPath,
        threadId: nativeId,
        artifactRoot,
        referencedFileRoots: [attachments],
      }).pipe(
        Effect.map((archive) => ({
          directory: archive.directory,
          nativeThreadId: archive.manifest.threadId,
        })),
      ),
  );
  const transfer = makeThreadNativeCheckpointTransfer(sql);
  const input = {
    threadId: "portable",
    generation: 1,
    turnId: "turn-1",
    sourceEnvironmentId: "source",
    scratchRoot: path.join(root, "packing"),
    chunkSizeBytes: 128,
  };
  const packed = yield* transfer.pack(input);
  const reconstruct = {
    manifest: packed.manifest,
    chunkDirectory: packed.directory,
    destinationRoot: path.join(root, "recovered"),
    threadId: "portable",
    operationId: packed.header.operationId,
    transferManifestSha256: packed.manifest.transferManifestSha256,
    expected: {
      threadId: "portable",
      operationId: packed.header.operationId,
      turnId: "turn-1",
      sourceEnvironmentId: "source",
      generation: 1,
      sourceSequence: 0,
    },
  };
  return {
    fs,
    path,
    sql,
    root,
    home,
    image,
    rolloutPath,
    point: point!,
    store,
    transfer,
    input,
    packed,
    reconstruct,
  };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory)),
  );

it.effect(
  "round trips a whole native checkpoint and relocates its referenced file without credentials",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const restored = yield* materializeNativeCheckpoint(f.reconstruct);
        expect(yield* digestNativeCheckpointArchive(restored.nativeDirectory)).toBe(
          f.point.archiveSha256,
        );
        const imported = yield* importCodexConversation({
          manifest: restored.header.native,
          rolloutPath: f.path.join(restored.nativeDirectory, "rollout.jsonl"),
          destinationRoot: f.path.join(f.root, "provider"),
          codexVersion: version,
        });
        expect(imported.resumeCursor).toEqual({
          threadId: nativeId,
          resumePolicy: "require-existing",
        });
        const text = yield* f.fs.readFileString(imported.rolloutPath);
        expect(text).toContain("amber-otter");
        expect(text).not.toContain(f.image);
        expect(text).toContain(f.path.join(imported.homePath, "native-files"));
        expect(yield* f.fs.exists(f.path.join(imported.homePath, "auth.json"))).toBe(false);
        expect(f.packed.manifest.files.some((file) => file.path.includes("unrelated"))).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.home, "auth.json"))).toBe(
          "private-login-must-stay-here",
        );
        expect((yield* f.store.get("portable", 1, "turn-1"))?.publishedArtifactId).toBeNull();
        const again = yield* f.transfer.pack(f.input);
        expect(again.sha256).toBe(f.packed.sha256);
        expect(again.artifactId).toBe(f.packed.artifactId);
      }),
    ),
);
it.effect("preserves the empty native graph directory in the complete archive digest", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture(true);
      expect(f.packed.header.native.format).toBe("codex-rollout-v3");
      expect(f.packed.header.directories).toContain("native-rollouts");
      const restored = yield* materializeNativeCheckpoint(f.reconstruct);
      expect(
        yield* f.fs.readDirectory(f.path.join(restored.nativeDirectory, "native-rollouts")),
      ).toEqual([]);
      const imported = yield* importCodexConversation({
        manifest: restored.header.native,
        rolloutPath: f.path.join(restored.nativeDirectory, "rollout.jsonl"),
        destinationRoot: f.path.join(f.root, "provider"),
        codexVersion: version,
      });
      expect(imported.resumeCursor.resumePolicy).toBe("require-existing");
    }),
  ),
);
it.effect(
  "corrupt immutable chunks cannot install a provider home and retain the source point",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const upload = f.packed.uploads.find((u) => u.kind === "native")!;
        yield* f.fs.writeFileString(upload.path, "corrupt");
        yield* Effect.flip(materializeNativeCheckpoint(f.reconstruct));
        expect(
          (yield* f.fs.exists(f.reconstruct.destinationRoot))
            ? yield* f.fs.readDirectory(f.reconstruct.destinationRoot)
            : [],
        ).toEqual([]);
        expect(yield* digestNativeCheckpointArchive(f.point.directory)).toBe(f.point.archiveSha256);
      }),
    ),
);
for (const expected of [
  { generation: 2 },
  { sourceEnvironmentId: "other" },
  { sourceSequence: 1 },
  { turnId: "other" },
])
  it.effect(`rejects a different recovery identity ${Object.keys(expected)[0]}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.flip(
          materializeNativeCheckpoint({
            ...f.reconstruct,
            expected: { ...f.reconstruct.expected, ...expected },
          }),
        );
        expect(
          (yield* f.fs.exists(f.reconstruct.destinationRoot))
            ? yield* f.fs.readDirectory(f.reconstruct.destinationRoot)
            : [],
        ).toEqual([]);
      }),
    ),
  );
it.effect("requires the retained point's actual environment and current generation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flip(f.transfer.pack({ ...f.input, sourceEnvironmentId: "other" }));
      yield* f.sql`UPDATE thread_execution_fences SET generation = 2 WHERE thread_id = 'portable'`;
      yield* Effect.flip(f.transfer.pack(f.input));
      expect(yield* digestNativeCheckpointArchive(f.point.directory)).toBe(f.point.archiveSha256);
    }),
  ),
);
it.effect("cannot put chunk scratch storage inside the immutable checkpoint", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flip(
        f.transfer.pack({ ...f.input, scratchRoot: f.path.join(f.point.directory, "packing") }),
      );
      expect(yield* digestNativeCheckpointArchive(f.point.directory)).toBe(f.point.archiveSha256);
    }),
  ),
);
it.effect(
  "an added private file fails even when a local catalog digest was changed to cover it",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.point.directory, "auth.json"), "do-not-pack");
        const digest = yield* digestNativeCheckpointArchive(f.point.directory);
        yield* f.sql`UPDATE thread_native_checkpoints SET archive_sha256 = ${digest} WHERE thread_id = 'portable'`;
        const error = yield* Effect.flip(f.transfer.pack(f.input));
        expect(error.message).toContain("Unexpected or missing");
        expect(yield* f.fs.readFileString(f.path.join(f.point.directory, "auth.json"))).toBe(
          "do-not-pack",
        );
      }),
    ),
);
it.effect("file descriptors are checked separately from the complete archive digest", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const file = f.packed.header.native.files![0]!;
      yield* f.fs.writeFileString(f.path.join(f.point.directory, "files", file.name), "wrong");
      const digest = yield* digestNativeCheckpointArchive(f.point.directory);
      yield* f.sql`UPDATE thread_native_checkpoints SET archive_sha256 = ${digest} WHERE thread_id = 'portable'`;
      yield* Effect.flip(f.transfer.pack(f.input));
      expect(yield* f.fs.exists(f.point.directory)).toBe(true);
    }),
  ),
);
it.effect("linked retained files are rejected before copying", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const file = f.packed.header.native.files![0]!,
        location = f.path.join(f.point.directory, "files", file.name);
      yield* f.fs.remove(location);
      yield* f.fs.symlink(f.path.join(f.home, "auth.json"), location);
      yield* Effect.flip(f.transfer.pack(f.input));
      expect(yield* f.fs.readFileString(f.path.join(f.home, "auth.json"))).toBe(
        "private-login-must-stay-here",
      );
    }),
  ),
);

it.effect("records only the matching publication receipt and retries it idempotently", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const receipt = {
        ...f.packed.header,
        nativeThreadId: nativeId,
        manifestArtifactId: f.packed.artifactId,
        manifestSha256: f.packed.sha256,
      };
      const published = yield* f.store.markPublished(receipt);
      expect(published?.publishedArtifactId).toBe(f.packed.artifactId);
      expect(yield* f.store.markPublished(receipt)).toEqual(published);
      for (const wrong of [
        { nativeManifestSha256: "0".repeat(64) },
        { archiveSha256: "0".repeat(64) },
        { sourceSequence: 1 },
        { sourceEnvironmentId: "other" },
        { manifestArtifactId: "01300000-0000-4000-8000-000000000002" },
      ])
        yield* Effect.flip(f.store.markPublished({ ...receipt, ...wrong }));
      expect(yield* f.store.get("portable", 1, "turn-1")).toEqual(published);
    }),
  ),
);
it.effect("native-only reconstruction bounds are checked before reading chunk storage", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const file = f.packed.manifest.files[0]!;
      for (const files of [
        [{ ...file, path: "history/private.json" }],
        [{ ...file, sizeBytes: 515 * 1024 * 1024 }],
        Array.from({ length: 1027 }, () => file),
      ])
        yield* Effect.flip(
          materializeNativeCheckpoint({
            ...f.reconstruct,
            chunkDirectory: f.path.join(f.root, "nonexistent"),
            manifest: { ...f.packed.manifest, files },
          }),
        );
      expect(yield* f.fs.exists(f.reconstruct.destinationRoot)).toBe(false);
    }),
  ),
);

it.effect("matched hashes cannot publish malformed native conversation history", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.fs.readDirectory(f.input.scratchRoot);
      const rollout = '{"type":"response_item","payload":{"type":"message"}}\n';
      const native = {
        ...f.packed.header.native,
        sha256: NodeCrypto.createHash("sha256").update(rollout).digest("hex"),
      };
      yield* f.fs.writeFileString(f.path.join(f.point.directory, "rollout.jsonl"), rollout);
      const manifest = encode(native);
      yield* f.fs.writeFileString(f.path.join(f.point.directory, "manifest.json"), manifest);
      const manifestSha = NodeCrypto.createHash("sha256").update(manifest).digest("hex");
      const archiveSha = yield* digestNativeCheckpointArchive(f.point.directory);
      yield* f.sql`UPDATE thread_native_checkpoints SET manifest_sha256=${manifestSha},archive_sha256=${archiveSha}
      WHERE thread_id='portable'`;
      yield* Effect.flip(f.transfer.pack(f.input));
      expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual(before);
      expect((yield* f.store.get("portable", 1, "turn-1"))?.publishedArtifactId).toBeNull();
      expect(yield* f.fs.exists(f.home)).toBe(true);
    }),
  ),
);

it.effect(
  "frozen native packaging preserves the real turn and verifies the exact freeze operation on recovery",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const operationId = NodeCrypto.randomUUID();
        yield* f.sql`UPDATE thread_execution_fences SET phase='frozen',operation_id=${operationId},frozen_sequence=0 WHERE thread_id='portable'`;
        const point = yield* f.store.captureFrozen(
          {
            threadId: "portable",
            turnId: "turn-1",
            operationId,
            artifactRoot: f.path.join(f.root, "outbox"),
          },
          (artifactRoot) =>
            exportCodexConversation({
              codexHome: f.home,
              rolloutPath: f.rolloutPath,
              threadId: nativeId,
              artifactRoot,
              referencedFileRoots: [f.path.dirname(f.image)],
            }).pipe(
              Effect.map((x) => ({ directory: x.directory, nativeThreadId: x.manifest.threadId })),
            ),
        );
        const packed = yield* f.transfer.pack({ ...f.input, captureOperationId: operationId });
        expect(packed.header.turnId).toBe("turn-1");
        expect(packed.header.captureOperationId).toBe(operationId);
        expect(packed.header.operationId).not.toBe(f.packed.header.operationId);
        expect(
          (yield* f.transfer.pack({ ...f.input, captureOperationId: operationId })).header
            .operationId,
        ).toBe(packed.header.operationId);
        const recovered = yield* materializeNativeCheckpoint({
          ...f.reconstruct,
          manifest: packed.manifest,
          chunkDirectory: packed.directory,
          operationId: packed.header.operationId,
          transferManifestSha256: packed.manifest.transferManifestSha256,
          expected: packed.header,
        });
        expect(recovered.header.native.threadId).toBe(nativeId);
        expect(point?.archiveSha256).toBe(f.point.archiveSha256);
        yield* Effect.flip(
          materializeNativeCheckpoint({
            ...f.reconstruct,
            manifest: packed.manifest,
            chunkDirectory: packed.directory,
            operationId: packed.header.operationId,
            transferManifestSha256: packed.manifest.transferManifestSha256,
            expected: { ...packed.header, captureOperationId: NodeCrypto.randomUUID() },
          }),
        );
        expect(yield* f.store.get("portable", 1, "turn-1")).toEqual(f.point);
      }),
    ),
);
