import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import { downloadThreadArtifactChunks } from "./ThreadArtifactDownload.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(ThreadTransferChunkManifest));
const hash = (value: Uint8Array) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "restore-download-" }),
  );
  const id = NodeCrypto.randomUUID(),
    indexId = NodeCrypto.randomUUID(),
    bytes = new TextEncoder().encode("checkpoint bytes");
  const manifest = {
    format: "launchpad-thread-chunks-v1" as const,
    threadId: "thread",
    operationId: NodeCrypto.randomUUID(),
    sourceEnvironmentId: "source",
    generation: 1,
    transferManifestSha256: "a".repeat(64),
    files: [
      {
        path: "manifest.json",
        sha256: hash(bytes),
        sizeBytes: bytes.length,
        chunks: [{ artifactId: id, sha256: hash(bytes), sizeBytes: bytes.length }],
      },
    ],
  };
  let index = new TextEncoder().encode(encode(manifest)),
    chunk = bytes;
  const requested: string[] = [];
  const input = () => ({
    ...manifest,
    indexArtifactId: indexId,
    indexSha256: hash(index),
    scratchRoot: root,
    maxFiles: 2,
    maxBytes: 1024,
    readArtifact: (artifactId: string) =>
      Effect.sync(() => {
        requested.push(artifactId);
        return Stream.fromIterable([artifactId === indexId ? index : chunk]);
      }),
  });
  return {
    fs,
    path,
    root,
    id,
    indexId,
    bytes,
    manifest,
    requested,
    input,
    setIndex: (value: ThreadTransferChunkManifest) => {
      index = new TextEncoder().encode(encode(value));
    },
    setChunk: (value: Uint8Array) => {
      chunk = Uint8Array.from(value);
    },
  };
});
it.layer(NodeServices.layer)("immutable artifact downloads", (it) => {
  it.effect("verifies the index and chunks and removes scoped scratch after consumption", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let directory = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const got = yield* downloadThreadArtifactChunks(f.input());
          directory = got.chunkDirectory;
          expect(Array.from(yield* f.fs.readFile(f.path.join(directory, f.id)))).toEqual(
            Array.from(f.bytes),
          );
          expect(got.manifest.transferManifestSha256).toBe("a".repeat(64));
        }),
      );
      expect(yield* f.fs.exists(directory)).toBe(false);
    }),
  );
  it.effect("rejects a trusted index digest mismatch before downloading chunks", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flip(
        downloadThreadArtifactChunks({ ...f.input(), indexSha256: "0".repeat(64) }),
      );
      expect(f.requested).toEqual([f.indexId]);
    }),
  );
  it.effect(
    "rejects foreign scope and oversized or incomplete files before downloading chunks",
    () =>
      Effect.gen(function* () {
        for (const mutate of [
          (m: ThreadTransferChunkManifest) => ({ ...m, generation: 2 }),
          (m: ThreadTransferChunkManifest) => ({ ...m, sourceEnvironmentId: "other" }),
          (m: ThreadTransferChunkManifest) => ({
            ...m,
            files: [{ ...m.files[0]!, sizeBytes: 2048 }],
          }),
          (m: ThreadTransferChunkManifest) => ({ ...m, files: [{ ...m.files[0]!, sizeBytes: 1 }] }),
        ]) {
          const f = yield* fixture();
          f.setIndex(mutate(f.manifest));
          yield* Effect.flip(downloadThreadArtifactChunks(f.input()));
          expect(f.requested).toEqual([f.indexId]);
        }
      }),
  );
  it.effect("validates the complete index before any repeated chunk can be fetched", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setIndex({
        ...f.manifest,
        files: [f.manifest.files[0]!, { ...f.manifest.files[0]!, path: "native/rollout.jsonl" }],
      });
      yield* Effect.flip(downloadThreadArtifactChunks(f.input()));
      expect(f.requested).toEqual([f.indexId]);
    }),
  );
  it.effect("rejects short, oversized and altered bytes and cleans failed downloads", () =>
    Effect.gen(function* () {
      for (const bytes of [new Uint8Array(1), new Uint8Array(1024), new Uint8Array(16)]) {
        const f = yield* fixture();
        f.setChunk(bytes);
        yield* Effect.scoped(Effect.flip(downloadThreadArtifactChunks(f.input())));
        expect(yield* f.fs.readDirectory(f.root)).toEqual([]);
      }
    }),
  );
});
