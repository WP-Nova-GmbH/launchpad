import { sha256 } from "@noble/hashes/sha2";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ThreadArtifactObjectError } from "./ThreadArtifactObjects.ts";

const failed = (operation: string) => new ThreadArtifactObjectError({ operation });
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Persistent private files for the Node development relay; the Worker uses R2. */
export function makeLocalThreadArtifactObjects(fs: FileSystem.FileSystem, root: string) {
  const file = (key: string) => {
    const match = /^thread-artifacts\/v1\/([0-9a-f-]{36})$/u.exec(key);
    return match ? `${root.replace(/\/$/u, "")}/${match[1]}` : null;
  };
  const put = Effect.fn("relay.thread_artifact.local.put")(function* (input: {
    readonly key: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly sizeBytes: number;
  }) {
    const path = file(input.key);
    if (
      !path ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > 64 * 1024 * 1024
    )
      return yield* failed("invalid upload");
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => failed("mkdir")));
    const body = Stream.fromReadableStream({
      evaluate: () => input.body,
      onError: () => failed("read upload"),
    });
    if (yield* fs.exists(path).pipe(Effect.mapError(() => failed("stat")))) {
      // Cancelling an unread retry destroys the Node request socket before its
      // receipt is sent. Consume the bounded body while keeping the object immutable.
      let received = 0;
      yield* Stream.runForEach(body, (chunk) => {
        received += chunk.byteLength;
        return received > input.sizeBytes ? Effect.fail(failed("upload size")) : Effect.void;
      });
      if (received !== input.sizeBytes) return yield* failed("upload size");
      return;
    }
    const uploadId = NodeCrypto.randomUUID();
    const temporaryPath = `${path}.${uploadId}.upload`;
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
          let written = 0;
          yield* Stream.runForEach(body, (chunk) =>
            Effect.gen(function* () {
              written += chunk.byteLength;
              if (written > input.sizeBytes) return yield* failed("upload size");
              yield* handle.writeAll(chunk);
            }),
          );
          if (written !== input.sizeBytes) return yield* failed("upload size");
          yield* handle.sync;
        }),
      );
      // A hard link publishes the completed bytes without replacing an object
      // that another retry has already published.
      yield* fs
        .link(temporaryPath, path)
        .pipe(
          Effect.catch((error) =>
            fs
              .exists(path)
              .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* fs.open(root, { flag: "r" })).sync;
        }),
      );
    }).pipe(
      Effect.mapError(() => failed("put")),
      Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
    );
  });
  const verify = Effect.fn("relay.thread_artifact.local.verify")(function* (input: {
    readonly key: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }) {
    const path = file(input.key);
    if (!path || !(yield* fs.exists(path).pipe(Effect.mapError(() => failed("stat")))))
      return yield* failed("missing");
    const hash = sha256.create();
    let size = 0;
    yield* Stream.runForEach(fs.stream(path), (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ).pipe(Effect.mapError(() => failed("read")));
    if (size !== input.sizeBytes || hex(hash.digest()) !== input.sha256)
      return yield* failed("checksum");
  });
  const read = Effect.fn("relay.thread_artifact.local.read")(function* (key: string) {
    const path = file(key);
    if (!path || !(yield* fs.exists(path).pipe(Effect.mapError(() => failed("stat")))))
      return yield* failed("missing");
    return fs.stream(path).pipe(Stream.mapError(() => failed("read")));
  });
  const remove = Effect.fn("relay.thread_artifact.local.remove")(function* (key: string) {
    const path = file(key);
    if (!path) return yield* failed("invalid key");
    yield* fs.remove(path, { force: true }).pipe(Effect.mapError(() => failed("delete")));
  });
  return { put, verify, read, remove };
}
