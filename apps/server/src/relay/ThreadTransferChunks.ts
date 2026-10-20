import * as NodeCrypto from "node:crypto";
import {
  ThreadTransferChunkManifest,
  ThreadNativeCheckpointArchiveManifest,
  ThreadAttachmentCheckpointArchiveManifest,
} from "@t3tools/contracts/relay";
import type { ThreadTransferChunkManifest as ChunkManifest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ThreadTransferArchiveManifest } from "@t3tools/contracts/threadTransfer";

const decodeTransferArchive = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Union([
      ThreadTransferArchiveManifest,
      ThreadNativeCheckpointArchiveManifest,
      ThreadAttachmentCheckpointArchiveManifest,
    ]),
  ),
);
const decodeChunkManifest = Schema.decodeEffect(ThreadTransferChunkManifest);
const encodeChunkManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));

export class ThreadTransferChunkError extends Schema.TaggedError<ThreadTransferChunkError>()(
  "ThreadTransferChunkError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadTransferChunkError({ message });
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const artifactIdFor = (
  threadId: string,
  operationId: string,
  file: string,
  offset: number,
  size: number,
) => {
  // Stable IDs let an interrupted move repack and retry the same immutable object intent.
  const bytes = NodeCrypto.createHash("sha1")
    .update(Buffer.from("e35f95c9c76a4564a4aa2516b6ff83b5", "hex"))
    .update(JSON.stringify([threadId, operationId, file, offset, size]))
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const safePath = (value: string) =>
  value.length > 0 &&
  value.length <= 4096 &&
  !value
    .split("/")
    .some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes(":") ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        [...part].some((character) => character.charCodeAt(0) < 32),
    );
const inside = (root: string, child: string, separator: string) =>
  child === root || child.startsWith(`${root}${separator}`);
const artifactKind = (file: string) => {
  if (file === "manifest.json") return "manifest" as const;
  if (file.startsWith("history/")) return "history" as const;
  if (file.startsWith("workspace/")) return "workspace" as const;
  if (file.startsWith("attachments/")) return "attachment" as const;
  return "native" as const;
};
const validateFiles = (manifest: ChunkManifest) => {
  const folded = new Map<string, string>();
  const filePaths = new Set<string>();
  const chunkIds = new Set<string>();
  let sawManifest = false;
  for (const file of manifest.files) {
    if (
      !safePath(file.path) ||
      !/^(?:manifest\.json$|history\/|workspace\/|attachments\/|native\/)/u.test(file.path)
    )
      return false;
    if (filePaths.has(file.path)) return false;
    filePaths.add(file.path);
    const parts = file.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const key = prefix.normalize("NFD").toLowerCase();
      const prior = folded.get(key);
      if (prior && prior !== prefix) return false;
      folded.set(key, prefix);
    }
    if (file.path === "manifest.json") sawManifest = true;
    let total = 0;
    for (const chunk of file.chunks) {
      if (chunk.sizeBytes > 64 * 1024 * 1024 || chunkIds.has(chunk.artifactId)) return false;
      chunkIds.add(chunk.artifactId);
      total += chunk.sizeBytes;
    }
    if (total !== file.sizeBytes) return false;
  }
  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index++)
      if (filePaths.has(parts.slice(0, index).join("/"))) return false;
  }
  return sawManifest;
};

/** Split the already frozen archive into immutable, individually bounded uploads. */
export const packThreadTransferArchive = Effect.fn("ThreadTransferChunks.pack")(function* (input: {
  readonly archiveDirectory: string;
  readonly scratchRoot: string;
  readonly expectedManifestSha256: string;
  readonly chunkSizeBytes?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.realPath(input.archiveDirectory);
  const scratch = path.resolve(input.scratchRoot);
  const chunkSize = input.chunkSizeBytes ?? 64 * 1024 * 1024;
  let ancestor = scratch;
  while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
  const resolvedScratch = path.resolve(
    yield* fs.realPath(ancestor),
    path.relative(ancestor, scratch),
  );
  if (
    inside(source, resolvedScratch, path.sep) ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > 64 * 1024 * 1024
  )
    return yield* fail("Invalid transfer chunk destination or size.");
  const manifestFile = path.join(source, "manifest.json");
  if ((yield* fs.realPath(manifestFile)) !== manifestFile)
    return yield* fail("The transfer manifest is not a regular source file.");
  const bytes = yield* fs.readFile(manifestFile);
  if (hash(bytes) !== input.expectedManifestSha256)
    return yield* fail("The frozen transfer manifest changed.");
  const transfer = yield* decodeTransferArchive(new TextDecoder().decode(bytes));
  const owner =
    transfer.format === "launchpad-thread-transfer-v1"
      ? {
          threadId: transfer.history.threadId,
          operationId: transfer.history.operationId,
          sourceEnvironmentId: transfer.history.environmentId,
          generation: transfer.history.generation,
        }
      : transfer;
  yield* fs.makeDirectory(scratch, { recursive: true, mode: 0o700 });
  if (inside(source, yield* fs.realPath(scratch), path.sep))
    return yield* fail("Transfer chunks cannot be stored inside the source archive.");
  const directory = yield* fs.makeTempDirectory({ directory: scratch, prefix: "chunks-" });
  return yield* Effect.gen(function* () {
    const files: ChunkManifest["files"][number][] = [];
    const visit = Effect.fnUntraced(function* (
      relative: string,
    ): Effect.fn.Return<
      void,
      ThreadTransferChunkError | import("effect/PlatformError").PlatformError,
      FileSystem.FileSystem
    > {
      const parent = relative ? path.join(source, relative) : source;
      for (const name of (yield* fs.readDirectory(parent)).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (!safePath(child)) return yield* fail("An archive path is not portable.");
        const absolute = path.join(source, child);
        if ((yield* fs.realPath(absolute)) !== absolute)
          return yield* fail("Archive entries cannot be symbolic links.");
        const stat = yield* fs.stat(absolute);
        if (stat.type === "Directory") {
          yield* visit(child);
          continue;
        }
        if (stat.type !== "File") return yield* fail("Archive entries must be regular files.");
        const sizeBytes = Number(stat.size);
        if (!Number.isSafeInteger(sizeBytes)) return yield* fail("Archive file is too large.");
        const chunks: ChunkManifest["files"][number]["chunks"][number][] = [];
        const whole = NodeCrypto.createHash("sha256");
        for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
          const expected = Math.min(chunkSize, sizeBytes - offset);
          const artifactId = artifactIdFor(
            owner.threadId,
            owner.operationId,
            child,
            offset,
            expected,
          );
          const digest = NodeCrypto.createHash("sha256");
          let written = 0;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const output = yield* fs.open(path.join(directory, artifactId), {
                flag: "wx",
                mode: 0o600,
              });
              yield* fs.stream(absolute, { offset, bytesToRead: expected }).pipe(
                Stream.runForEach((part) =>
                  Effect.gen(function* () {
                    written += part.length;
                    if (written > expected)
                      return yield* fail("Archive file changed during packing.");
                    whole.update(part);
                    digest.update(part);
                    yield* output.writeAll(part);
                  }),
                ),
              );
              yield* output.sync;
            }),
          );
          if (written !== expected) return yield* fail("Archive file changed during packing.");
          chunks.push({ artifactId, sha256: digest.digest("hex"), sizeBytes: expected });
        }
        files.push({ path: child, sha256: whole.digest("hex"), sizeBytes, chunks });
      }
    });
    yield* visit("");
    const manifest: ChunkManifest = {
      format: "launchpad-thread-chunks-v1",
      threadId: owner.threadId,
      operationId: owner.operationId,
      sourceEnvironmentId: owner.sourceEnvironmentId,
      generation: owner.generation,
      transferManifestSha256: input.expectedManifestSha256,
      files,
    };
    if (
      !validateFiles(manifest) ||
      files.find((file) => file.path === "manifest.json")?.sha256 !== input.expectedManifestSha256
    )
      return yield* fail("Frozen archive has an invalid file set.");
    const encoded = yield* encodeChunkManifest(manifest);
    const manifestPath = path.join(directory, "chunks.json");
    yield* fs.writeFileString(manifestPath, encoded, { flag: "wx", mode: 0o600 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* fs.open(manifestPath, { flag: "r" })).sync;
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    );
    const manifestBytes = new TextEncoder().encode(encoded);
    const manifestSha256 = hash(manifestBytes);
    const artifactId = artifactIdFor(
      manifest.threadId,
      manifest.operationId,
      "chunks.json",
      0,
      manifestBytes.byteLength,
    );
    const uploads = [
      ...manifest.files.flatMap((file) =>
        file.chunks.map((chunk) => ({
          ...chunk,
          kind: artifactKind(file.path),
          path: path.join(directory, chunk.artifactId),
        })),
      ),
      {
        artifactId,
        sha256: manifestSha256,
        sizeBytes: manifestBytes.byteLength,
        kind: "manifest" as const,
        path: manifestPath,
      },
    ];
    return { directory, manifest, sha256: manifestSha256, artifactId, uploads };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

/** Rebuild only in quarantine; the existing archive validator runs before installation. */
export const materializeThreadTransferChunks = Effect.fn("ThreadTransferChunks.materialize")(
  function* (input: {
    readonly manifest: ChunkManifest;
    readonly chunkDirectory: string;
    readonly destinationRoot: string;
    readonly threadId: string;
    readonly operationId: string;
    readonly transferManifestSha256: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* decodeChunkManifest(input.manifest);
    if (
      !validateFiles(manifest) ||
      manifest.threadId !== input.threadId ||
      manifest.operationId !== input.operationId ||
      manifest.transferManifestSha256 !== input.transferManifestSha256 ||
      manifest.files.find((file) => file.path === "manifest.json")?.sha256 !==
        input.transferManifestSha256
    )
      return yield* fail("Transfer chunks do not match the requested thread operation.");
    const chunks = yield* fs.realPath(input.chunkDirectory);
    yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({
      directory: input.destinationRoot,
      prefix: "thread-",
    });
    return yield* Effect.gen(function* () {
      for (const file of manifest.files) {
        const destination = path.join(directory, file.path);
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 });
        const whole = NodeCrypto.createHash("sha256");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const output = yield* fs.open(destination, { flag: "wx", mode: 0o600 });
            for (const chunk of file.chunks) {
              const source = path.join(chunks, chunk.artifactId);
              if (
                (yield* fs.realPath(source)) !== source ||
                (yield* fs.stat(source)).type !== "File"
              )
                return yield* fail("A transfer chunk is not a regular file.");
              const digest = NodeCrypto.createHash("sha256");
              let size = 0;
              yield* fs.stream(source).pipe(
                Stream.runForEach((part) =>
                  Effect.gen(function* () {
                    size += part.length;
                    if (size > chunk.sizeBytes)
                      return yield* fail("Transfer chunk exceeds its declared size.");
                    digest.update(part);
                    whole.update(part);
                    yield* output.writeAll(part);
                  }),
                ),
              );
              if (size !== chunk.sizeBytes || digest.digest("hex") !== chunk.sha256)
                return yield* fail("A transfer chunk failed verification.");
            }
            yield* output.sync;
          }),
        );
        if (whole.digest("hex") !== file.sha256)
          return yield* fail("A transfer file failed verification.");
      }
      return directory;
    }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  },
);
