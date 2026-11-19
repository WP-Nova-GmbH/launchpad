import * as NodeCrypto from "node:crypto";
import { RelayThreadVmRepositoryUpload } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ThreadVmRepositoryUploadError extends Schema.TaggedError<ThreadVmRepositoryUploadError>()(
  "ThreadVmRepositoryUploadError",
  {},
) {}
const fail = () => new ThreadVmRepositoryUploadError();
const decodeRepository = Schema.decodeEffect(RelayThreadVmRepositoryUpload);

/** A reset reads only the retained uploaded bundle. It never contacts a Git remote. */
export const downloadThreadVmRepositoryUpload = Effect.fn("ThreadVmRepositoryUpload.download")(
  function* <E, R>(input: {
    repository: RelayThreadVmRepositoryUpload;
    threadId: string;
    scratchRoot: string;
    readArtifact: (id: string) => Effect.Effect<Stream.Stream<Uint8Array, E, R>, E, R>;
  }) {
    const repository = yield* decodeRepository(input.repository);
    const { bundle } = repository;
    if (
      repository.threadId !== input.threadId ||
      bundle.sizeBytes <= 0 ||
      bundle.sizeBytes > 64 * 1024 ** 3 ||
      bundle.chunks.length === 0 ||
      bundle.chunks.length > 100_000 ||
      new Set(bundle.chunks.map((chunk) => chunk.artifactId)).size !== bundle.chunks.length ||
      bundle.chunks.some((chunk) => chunk.sizeBytes > 64 * 1024 * 1024) ||
      bundle.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== bundle.sizeBytes
    )
      return yield* fail();
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    yield* fs.makeDirectory(input.scratchRoot, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: input.scratchRoot,
      prefix: "repository-",
    });
    const bundlePath = path.join(directory, "repository.bundle");
    const whole = NodeCrypto.createHash("sha256");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(bundlePath, { flag: "wx", mode: 0o600 });
        for (const chunk of bundle.chunks) {
          const digest = NodeCrypto.createHash("sha256");
          let size = 0;
          const body = yield* input.readArtifact(chunk.artifactId);
          yield* body.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                size += part.length;
                if (size > chunk.sizeBytes) return yield* fail();
                digest.update(part);
                whole.update(part);
                yield* output.writeAll(part);
              }),
            ),
            Effect.timeout("2 minutes"),
          );
          if (size !== chunk.sizeBytes || digest.digest("hex") !== chunk.sha256)
            return yield* fail();
        }
        yield* output.sync;
      }),
    );
    if (whole.digest("hex") !== bundle.sha256) return yield* fail();
    return { bundlePath, objectFormat: repository.objectFormat, sha256: bundle.sha256 };
  },
  Effect.mapError(fail),
);
