import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  materializeThreadTransferChunks,
  packThreadTransferArchive,
  packThreadTransferArchiveV2,
} from "./ThreadTransferChunks.ts";

const MiB = 1024 * 1024;
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const owner = {
  threadId: "packed-thread",
  operationId: "b67a11b5-5e08-4cc5-8ce9-14cc6ff4cf28",
  sourceEnvironmentId: "source",
  generation: 2,
};
const fixture = Effect.fnUntraced(function* (count = 2, large = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "thread-packed-" }));
  const archiveDirectory = path.join(root, "archive");
  const expected = new Map<string, { sha256: string; sizeBytes: number }>();
  const put = Effect.fnUntraced(function* (relative: string, bytes: Uint8Array) {
    const target = path.join(archiveDirectory, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, bytes);
    expected.set(relative, { sha256: hash(bytes), sizeBytes: bytes.length });
  });
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.alloc(1024, index % 251);
    bytes.writeUInt32LE(index);
    yield* put(`workspace/objects/${hash(bytes)}`, bytes);
  }
  yield* put(`workspace/objects/${hash(new Uint8Array())}`, new Uint8Array());
  if (large) {
    const bytes = new Uint8Array(17 * MiB).fill(17);
    yield* put(`workspace/objects/${hash(bytes)}`, bytes);
  }
  yield* put("workspace/repository.bundle", new Uint8Array(large ? 9 * MiB : 32).fill(31));
  yield* put("workspace/index", new Uint8Array(32).fill(7));
  yield* put("history/events.jsonl", new TextEncoder().encode("history\n"));
  yield* put("history/receipts.jsonl", new Uint8Array());
  const workspace = {
    format: "launchpad-workspace-v1",
    threadId: owner.threadId,
    objectFormat: "sha1",
    head: "a".repeat(40),
    branch: "main",
    indexTree: "a".repeat(40),
    indexCommit: "a".repeat(40),
    checkpoints: [],
    bundle: {
      sha256: expected.get("workspace/repository.bundle")!.sha256,
      size: large ? 9 * MiB : 32,
    },
    index: { sha256: expected.get("workspace/index")!.sha256, size: 32 },
    files: [],
  };
  const attachments = { format: "launchpad-attachments-v1", threadId: owner.threadId, files: [] };
  const history = {
    format: "launchpad-history-v1",
    threadId: owner.threadId,
    environmentId: owner.sourceEnvironmentId,
    generation: owner.generation,
    operationId: owner.operationId,
    sourceSequence: 0,
    eventCount: 0,
    receiptCount: 0,
    events: { sha256: expected.get("history/events.jsonl")!.sha256, size: 8 },
    receipts: { sha256: hash(new Uint8Array()), size: 0 },
  };
  for (const [relative, value] of [
    ["workspace/manifest.json", workspace],
    ["history/manifest.json", history],
    ["attachments/manifest.json", attachments],
    [
      "manifest.json",
      { format: "launchpad-thread-transfer-v1", workspace, history, attachments, native: null },
    ],
  ] as const)
    yield* put(relative, new TextEncoder().encode(encodeJson(value)));
  const input = {
    archiveDirectory,
    scratchRoot: path.join(root, "packing"),
    expectedManifestSha256: expected.get("manifest.json")!.sha256,
  };
  return { fs, path, root, input, expected };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "packs 2,000 small files into bounded objects and streams each object once on restore",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(2000, true);
        const packed = yield* packThreadTransferArchiveV2(f.input);
        expect(packed.uploads.length).toBeLessThanOrEqual(20);
        expect(packed.manifest.objects.every((object) => object.sizeBytes <= 8 * MiB)).toBe(true);
        const repeated = yield* packThreadTransferArchiveV2(f.input);
        expect(repeated.manifest).toEqual(packed.manifest);
        expect(repeated.artifactId).toBe(packed.artifactId);
        expect(repeated.sha256).toBe(packed.sha256);
        const references = new Map<string, string[]>();
        for (const file of packed.manifest.files)
          for (const slice of file.slices)
            references.set(slice.artifactId, [
              ...(references.get(slice.artifactId) ?? []),
              file.path,
            ]);
        expect(Array.from(references.values()).some((paths) => paths.length >= 1000)).toBe(true);
        for (const paths of references.values())
          if (paths.length > 1)
            expect(paths.every((name) => /^workspace\/objects\/[0-9a-f]{64}$/u.test(name))).toBe(
              true,
            );
        const opened = new Map<string, number>();
        let maxRead = 0;
        const restored = yield* materializeThreadTransferChunks({
          ...owner,
          manifest: packed.manifest,
          chunkDirectory: packed.directory,
          destinationRoot: f.path.join(f.root, "restored"),
          transferManifestSha256: f.input.expectedManifestSha256,
        }).pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.make({
              ...f.fs,
              open: (file, options) =>
                f.fs.open(file, options).pipe(
                  Effect.map((handle) => {
                    if (!file.startsWith(packed.directory + f.path.sep)) return handle;
                    opened.set(file, (opened.get(file) ?? 0) + 1);
                    return {
                      ...handle,
                      readAlloc: (size) => {
                        maxRead = Math.max(maxRead, size);
                        return handle.readAlloc(size);
                      },
                    };
                  }),
                ),
            }),
          ),
        );
        expect(opened.size).toBe(packed.manifest.objects.length);
        expect(Array.from(opened.values()).every((count) => count === 1)).toBe(true);
        expect(maxRead).toBeLessThanOrEqual(8 * MiB);
        for (const [relative, expected] of f.expected) {
          const digest = NodeCrypto.createHash("sha256");
          yield* f.fs.stream(f.path.join(restored, relative)).pipe(
            Stream.runForEach((part) =>
              Effect.sync(() => {
                digest.update(part);
              }),
            ),
          );
          expect(digest.digest("hex")).toBe(expected.sha256);
        }
        const empty = packed.manifest.files.find((file) => file.sizeBytes === 0)!;
        expect(empty.slices).toEqual([]);
      }),
    ),
);

it.effect(
  "rejects corrupt packed bytes and invalid slices without retaining quarantine files",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const packed = yield* packThreadTransferArchiveV2(f.input);
        const object = packed.manifest.objects[0]!;
        const objectPath = f.path.join(packed.directory, object.artifactId);
        const bytes = yield* f.fs.readFile(objectPath);
        bytes[0] = bytes[0]! ^ 1;
        yield* f.fs.writeFile(objectPath, bytes);
        const input = {
          ...owner,
          manifest: packed.manifest,
          chunkDirectory: packed.directory,
          destinationRoot: f.path.join(f.root, "corrupt"),
          transferManifestSha256: f.input.expectedManifestSha256,
        };
        expect((yield* Effect.flip(materializeThreadTransferChunks(input)))._tag).toBe(
          "ThreadTransferChunkError",
        );
        expect(yield* f.fs.readDirectory(input.destinationRoot)).toEqual([]);
        const file = packed.manifest.files.find((entry) => entry.slices.length > 0)!;
        const invalid = {
          ...packed.manifest,
          files: packed.manifest.files.map((entry) =>
            entry === file
              ? {
                  ...entry,
                  slices: entry.slices.map((slice) => ({ ...slice, offset: slice.offset + 1 })),
                }
              : entry,
          ),
        };
        const invalidRoot = f.path.join(f.root, "invalid");
        expect(
          (yield* Effect.flip(
            materializeThreadTransferChunks({
              ...input,
              manifest: invalid,
              destinationRoot: invalidRoot,
            }),
          ))._tag,
        ).toBe("ThreadTransferChunkError");
        expect(yield* f.fs.exists(invalidRoot)).toBe(false);
      }),
    ),
);

it.effect("keeps legacy packing stable and namespaces v2 identities separately", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const legacy = yield* packThreadTransferArchive(f.input);
      const packed = yield* packThreadTransferArchiveV2(f.input);
      const ids = new Set(legacy.uploads.map((upload) => upload.artifactId));
      expect(packed.uploads.every((upload) => !ids.has(upload.artifactId))).toBe(true);
      const restored = yield* materializeThreadTransferChunks({
        ...owner,
        manifest: legacy.manifest,
        chunkDirectory: legacy.directory,
        destinationRoot: f.path.join(f.root, "legacy"),
        transferManifestSha256: f.input.expectedManifestSha256,
      });
      expect(yield* f.fs.readFileString(f.path.join(restored, "history/events.jsonl"))).toBe(
        "history\n",
      );
    }),
  ),
);

for (const action of ["packing", "materializing"] as const)
  it.effect(`removes ${action} quarantine when interrupted`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const packed = yield* packThreadTransferArchiveV2(f.input);
        const scratch =
          action === "packing"
            ? f.path.join(f.root, "interrupted-packing")
            : f.path.join(f.root, "interrupted-restore");
        const started = yield* Deferred.make<void>();
        const task = Effect.gen(function* () {
          if (action === "packing")
            yield* packThreadTransferArchiveV2({ ...f.input, scratchRoot: scratch });
          else
            yield* materializeThreadTransferChunks({
              ...owner,
              manifest: packed.manifest,
              chunkDirectory: packed.directory,
              destinationRoot: scratch,
              transferManifestSha256: f.input.expectedManifestSha256,
            });
        });
        const fiber = yield* task.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.make({
              ...f.fs,
              open: (path, options) =>
                f.fs
                  .open(path, options)
                  .pipe(
                    Effect.tap(() =>
                      path.startsWith(scratch + f.path.sep)
                        ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                        : Effect.void,
                    ),
                  ),
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(yield* f.fs.readDirectory(scratch)).toEqual([]);
      }),
    ),
  );
