import { sha256 } from "@noble/hashes/sha2";
import * as Alchemy from "alchemy";
import type { R2 } from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class ThreadArtifactObjectError extends Schema.TaggedError<ThreadArtifactObjectError>()(
  "ThreadArtifactObjectError",
  { operation: Schema.String },
) {}

const failed = (operation: string) => new ThreadArtifactObjectError({ operation });
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** No object URL or storage credentials escape this internal boundary. */
export function makeThreadArtifactObjects(
  bucket: R2.ReadWriteBucketClient,
  runtimeContext: Alchemy.BaseRuntimeContext,
) {
  const put = Effect.fn("relay.thread_artifact.object.put")(function* (input: {
    readonly key: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly sizeBytes: number;
  }) {
    if (
      !input.key.startsWith("thread-artifacts/v1/") ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > 64 * 1024 * 1024
    )
      return yield* failed("invalid upload");
    // A lost response may find an existing object. Never overwrite it; the
    // caller must verify its bytes against the immutable catalog intent.
    yield* bucket
      .put(input.key, input.body, {
        contentLength: input.sizeBytes,
        onlyIf: { etagDoesNotMatch: "*" },
      })
      .pipe(
        Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
        Effect.mapError(() => failed("put")),
      );
  });

  const verify = Effect.fn("relay.thread_artifact.object.verify")(function* (input: {
    readonly key: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }) {
    const object = yield* bucket.get(input.key).pipe(
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
      Effect.mapError(() => failed("get")),
    );
    if (!object || object.size !== input.sizeBytes) return yield* failed("missing or wrong size");
    const hash = sha256.create();
    let size = 0;
    yield* Stream.runForEach(object.body, (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ).pipe(Effect.mapError(() => failed("read")));
    if (size !== input.sizeBytes || hex(hash.digest()) !== input.sha256)
      return yield* failed("checksum");
  });

  const read = Effect.fn("relay.thread_artifact.object.read")(function* (key: string) {
    const object = yield* bucket.get(key).pipe(
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
      Effect.mapError(() => failed("get")),
    );
    if (!object) return yield* failed("missing");
    return object.body.pipe(Stream.mapError(() => failed("read")));
  });

  const remove = Effect.fn("relay.thread_artifact.object.remove")(function* (key: string) {
    yield* bucket.delete(key).pipe(
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
      Effect.mapError(() => failed("delete")),
    );
  });

  return { put, verify, read, remove };
}

export class ThreadArtifactObjectStorage extends Context.Service<
  ThreadArtifactObjectStorage,
  ReturnType<typeof makeThreadArtifactObjects>
>()("launchpad-relay/threads/ThreadArtifactObjects/ThreadArtifactObjectStorage") {}
