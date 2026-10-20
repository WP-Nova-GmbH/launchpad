import * as NodeCrypto from "node:crypto";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ThreadArtifactDownloadError extends Schema.TaggedError<ThreadArtifactDownloadError>()(
  "ThreadArtifactDownloadError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadArtifactDownloadError({ message });
const decodeIndex = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Download an immutable index and bounded chunks into caller-scoped scratch.
 * Index SHA and archive-header SHA are different witnesses; verify each at its boundary. */
export const downloadThreadArtifactChunks = Effect.fn("ThreadArtifactDownload.chunks")(function* <
  E,
  R,
>(input: {
  indexArtifactId: string;
  indexSha256: string;
  threadId: string;
  operationId: string;
  sourceEnvironmentId: string;
  generation: number;
  scratchRoot: string;
  maxFiles: number;
  maxBytes: number;
  readArtifact: (id: string) => Effect.Effect<Stream.Stream<Uint8Array, E, R>, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const body = yield* input.readArtifact(input.indexArtifactId);
  let total = 0;
  const parts = yield* body.pipe(
    Stream.mapEffect((part) => {
      total += part.length;
      return total > 32 * 1024 * 1024
        ? Effect.fail(fail("Recovery index exceeds its size limit."))
        : Effect.succeed(part);
    }),
    Stream.runCollect,
    Effect.timeout("2 minutes"),
  );
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  if (hash(bytes) !== input.indexSha256) return yield* fail("Recovery index failed verification.");
  const manifest = yield* decodeIndex(new TextDecoder().decode(bytes));
  if (
    manifest.threadId !== input.threadId ||
    manifest.operationId !== input.operationId ||
    manifest.sourceEnvironmentId !== input.sourceEnvironmentId ||
    manifest.generation !== input.generation ||
    manifest.files.length > input.maxFiles ||
    manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) > input.maxBytes
  )
    return yield* fail("Recovery index belongs to another checkpoint or exceeds its limits.");
  const chunks = new Map<string, { sha256: string; sizeBytes: number }>();
  // Validate the entire index before fetching any chunk, including final entries.
  for (const file of manifest.files) {
    if (file.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== file.sizeBytes)
      return yield* fail("Recovery file has an incomplete chunk set.");
    for (const chunk of file.chunks) {
      if (
        chunks.has(chunk.artifactId) ||
        chunks.size >= 100_000 ||
        chunk.sizeBytes > 64 * 1024 * 1024
      )
        return yield* fail("Recovery index has invalid or repeated chunks.");
      chunks.set(chunk.artifactId, chunk);
    }
  }
  yield* fs.makeDirectory(input.scratchRoot, { recursive: true, mode: 0o700 });
  const chunkDirectory = yield* fs.makeTempDirectoryScoped({
    directory: input.scratchRoot,
    prefix: "chunks-",
  });
  for (const [id, chunk] of chunks) {
    const digest = NodeCrypto.createHash("sha256");
    let written = 0;
    const chunkBody = yield* input.readArtifact(id);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(path.join(chunkDirectory, id), { flag: "wx", mode: 0o600 });
        yield* chunkBody.pipe(
          Stream.runForEach((part) =>
            Effect.gen(function* () {
              written += part.length;
              if (written > chunk.sizeBytes)
                return yield* fail("Recovery chunk exceeds its immutable size.");
              digest.update(part);
              yield* output.writeAll(part);
            }),
          ),
          Effect.timeout("2 minutes"),
        );
        yield* output.sync;
      }),
    );
    if (written !== chunk.sizeBytes || digest.digest("hex") !== chunk.sha256)
      return yield* fail("Recovery chunk failed verification.");
  }
  return { manifest, chunkDirectory };
});
