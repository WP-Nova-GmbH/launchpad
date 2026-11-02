import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ThreadTransferArtifactManifest,
  type ThreadTransferChunkManifest,
  type ThreadTransferPackedManifest,
} from "@t3tools/contracts/relay";
import { downloadThreadArtifactChunks } from "./ThreadArtifactDownload.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(ThreadTransferArtifactManifest));
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
    transferManifestSha256: hash(bytes),
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
    setIndex: (value: ThreadTransferArtifactManifest) => {
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
          expect(got.manifest.transferManifestSha256).toBe(hash(f.bytes));
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
  it.effect("rejects a legacy payload object that aliases its index", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setIndex({
        ...f.manifest,
        files: f.manifest.files.map((file) => ({
          ...file,
          chunks: file.chunks.map((chunk) => ({ ...chunk, artifactId: f.indexId })),
        })),
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
  it.effect("downloads each shared v2 object once while preserving the wire manifest", () =>
    Effect.gen(function* () {
      const f = yield* packedFixture();
      const result = yield* downloadThreadArtifactChunks(f.input());
      expect(result.manifest).toEqual(f.manifest);
      expect(result.normalized.files).toHaveLength(3);
      expect(f.requested).toEqual([
        f.indexId,
        ...f.manifest.objects.map((object) => object.artifactId),
      ]);
      expect(
        Array.from(yield* f.fs.readFile(f.path.join(result.chunkDirectory, f.sharedId))),
      ).toEqual(Array.from(f.sharedBytes));
    }),
  );
  it.effect(
    "rejects a payload/index ID collision and invalid final slices before any payload read",
    () =>
      Effect.gen(function* () {
        for (const kind of ["collision", "range", "file-budget", "byte-budget"] as const) {
          const f = yield* packedFixture();
          const manifest =
            kind === "collision"
              ? {
                  ...f.manifest,
                  objects: f.manifest.objects.map((object) =>
                    object.artifactId === f.sharedId
                      ? { ...object, artifactId: f.indexId }
                      : object,
                  ),
                  files: f.manifest.files.map((file) => ({
                    ...file,
                    slices: file.slices.map((slice) =>
                      slice.artifactId === f.sharedId ? { ...slice, artifactId: f.indexId } : slice,
                    ),
                  })),
                }
              : kind === "range"
                ? {
                    ...f.manifest,
                    files: f.manifest.files.map((file, index) =>
                      index === f.manifest.files.length - 1
                        ? {
                            ...file,
                            slices: file.slices.map((slice) => ({
                              ...slice,
                              offset: slice.offset + 1,
                            })),
                          }
                        : file,
                    ),
                  }
                : f.manifest;
          f.setIndex(manifest);
          yield* Effect.flip(
            downloadThreadArtifactChunks({
              ...f.input(),
              maxFiles: kind === "file-budget" ? 2 : 3,
              maxBytes: kind === "byte-budget" ? 1 : 1024,
            }),
          );
          expect(f.requested).toEqual([f.indexId]);
        }
      }),
  );
  it.effect("bounds raw index bytes before decoding or fetching payload objects", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const requested: string[] = [];
      const error = yield* Effect.flip(
        downloadThreadArtifactChunks({
          ...f.input(),
          readArtifact: (id) =>
            Effect.sync(() => {
              requested.push(id);
              return Stream.fromIterable(
                Array.from({ length: 33 }, () => new Uint8Array(1024 * 1024)),
              );
            }),
        }),
      );
      expect(error._tag).toBe("ThreadArtifactDownloadError");
      expect(requested).toEqual([f.indexId]);
    }),
  );
});

const packedFixture = Effect.fnUntraced(function* () {
  const f = yield* fixture();
  const sharedId = NodeCrypto.randomUUID();
  const files = [new TextEncoder().encode("first"), new TextEncoder().encode("second")]
    .map((bytes) => ({ path: `workspace/objects/${hash(bytes)}`, bytes }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const sharedBytes = Uint8Array.from(files.flatMap((file) => Array.from(file.bytes)));
  let offset = 0;
  const manifest: ThreadTransferPackedManifest = {
    ...f.manifest,
    format: "launchpad-thread-chunks-v2",
    objects: [
      { artifactId: f.id, kind: "manifest", sha256: hash(f.bytes), sizeBytes: f.bytes.length },
      {
        artifactId: sharedId,
        kind: "workspace",
        sha256: hash(sharedBytes),
        sizeBytes: sharedBytes.length,
      },
    ],
    files: [
      {
        path: "manifest.json",
        sha256: hash(f.bytes),
        sizeBytes: f.bytes.length,
        slices: [{ artifactId: f.id, offset: 0, length: f.bytes.length }],
      },
      ...files.map((file) => {
        const slice = { artifactId: sharedId, offset, length: file.bytes.length };
        offset += file.bytes.length;
        return {
          path: file.path,
          sha256: hash(file.bytes),
          sizeBytes: file.bytes.length,
          slices: [slice],
        };
      }),
    ],
  };
  let index = new TextEncoder().encode(encode(manifest));
  const requested: string[] = [];
  return {
    ...f,
    sharedId,
    sharedBytes,
    manifest,
    requested,
    setIndex: (value: ThreadTransferPackedManifest) => {
      index = new TextEncoder().encode(encode(value));
    },
    input: () => ({
      ...f.input(),
      indexSha256: hash(index),
      maxFiles: 3,
      readArtifact: (id: string) =>
        Effect.sync(() => {
          requested.push(id);
          return Stream.make(id === f.indexId ? index : id === sharedId ? sharedBytes : f.bytes);
        }),
    }),
  };
});
