import * as Crypto from "effect/Crypto";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import {
  makeThreadArtifactStore,
  ThreadArtifactConflict,
  type ThreadArtifact,
  type ThreadArtifactKind,
} from "./ThreadArtifactStore.ts";
import { ThreadArtifactObjectError, makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";

type Objects = ReturnType<typeof makeThreadArtifactObjects>;

/** Completion is a database pointer to bytes already verified in private object storage. */
export function makeThreadArtifactTransfer(sql: PgClient, objects: Objects) {
  const catalog = makeThreadArtifactStore(sql);
  const upload = Effect.fn("relay.thread_artifact.upload")(function* (input: {
    readonly artifactId: string;
    readonly threadId: string;
    readonly operationId: string;
    readonly kind: ThreadArtifactKind;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly retentionDays: number | null;
    readonly body: ReadableStream<Uint8Array>;
  }) {
    const artifact = yield* catalog.begin(input);
    if (artifact.state === "complete") {
      yield* objects.verify({
        key: artifact.storageKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
      return artifact;
    }
    if (artifact.state !== "pending")
      return yield* new ThreadArtifactConflict({ message: "Artifact is being deleted" });
    yield* uploadBytes(artifact, input.body);
    return yield* catalog.complete(input);
  });

  /** Network I/O stays outside authorization transactions; completion is reauthorized separately. */
  const uploadBytes = Effect.fn("relay.thread_artifact.upload_bytes")(function* (
    artifact: ThreadArtifact,
    body: ReadableStream<Uint8Array>,
  ) {
    const pin = {
      artifactId: artifact.artifactId,
      threadId: artifact.threadId,
      operationId: yield* (yield* Crypto.Crypto).randomUUIDv4,
    };
    yield* Effect.acquireUseRelease(
      catalog.pinUpload(pin),
      () =>
        Effect.gen(function* () {
          // An interrupted upload may have published bytes before its reply was lost.
          // Verify the immutable object even if the retry's conditional put was rejected.
          yield* objects
            .put({ key: artifact.storageKey, body: body, sizeBytes: artifact.sizeBytes })
            .pipe(Effect.catchTag("ThreadArtifactObjectError", () => Effect.void));
          yield* objects.verify({
            key: artifact.storageKey,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          });
        }).pipe(
          Effect.timeout("10 minutes"),
          Effect.catchTag(
            "TimeoutError",
            () => new ThreadArtifactObjectError({ operation: "upload timeout" }),
          ),
        ),
      () => catalog.releasePin(pin).pipe(Effect.ignore),
    );
  });

  const readPinned = Effect.fn("relay.thread_artifact.read_pinned")(function* (input: {
    readonly artifactId: string;
    readonly threadId: string;
    readonly operationId: string;
  }) {
    const artifact = yield* catalog.pin({ ...input, leaseMinutes: 60 });
    return yield* Effect.gen(function* () {
      yield* objects.verify({
        key: artifact.storageKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
      return yield* objects.read(artifact.storageKey);
    }).pipe(Effect.onError(() => catalog.releasePin(input).pipe(Effect.ignore)));
  });

  const collectOne = Effect.fn("relay.thread_artifact.collect_one")(function* (threadId?: string) {
    yield* catalog.expireReadPins();
    const claim = yield* catalog.claimExpired(threadId);
    if (!claim) return false;
    yield* objects.remove(claim.storageKey).pipe(
      Effect.catchTag("ThreadArtifactObjectError", () =>
        catalog.deferDelete(claim).pipe(Effect.as(false)),
      ),
      Effect.flatMap((result) => (result === false ? Effect.void : catalog.confirmDeleted(claim))),
    );
    return true;
  });

  return {
    upload,
    prepare: catalog.begin,
    uploadBytes,
    complete: catalog.complete,
    readPinned,
    releasePin: catalog.releasePin,
    collectOne,
  };
}
