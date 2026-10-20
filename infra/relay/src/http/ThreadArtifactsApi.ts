import { ThreadId } from "@t3tools/contracts";
import { RelayApi, type RelayThreadArtifactReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import {
  ThreadArtifactObjectStorage,
  ThreadArtifactObjectError,
} from "../threads/ThreadArtifactObjects.ts";
import { makeThreadArtifactTransfer } from "../threads/ThreadArtifactTransfer.ts";
import type { ThreadArtifactKind } from "../threads/ThreadArtifactStore.ts";
import { makeThreadNativeCheckpointStore } from "../threads/ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "../threads/ThreadAttachmentCheckpointStore.ts";
import { withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict } from "./tenancyErrors.ts";

type Owner = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
};
const artifactErrors = {
  PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  ThreadArtifactConflict: () => tenancyConflict("thread_artifact_conflict"),
  ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
};
const checkpointErrors = {
  ...artifactErrors,
  SchemaError: () => tenancyConflict("thread_checkpoint_conflict"),
  PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  TimeoutError: () => relayInternalErrorResponse("persistence_failed"),
};

/** Bound the stream before private storage sees it, including the Worker/R2 path. */
export const boundedArtifactBody = (
  body: Stream.Stream<Uint8Array, unknown>,
  sizeBytes: number,
) => {
  let received = 0;
  const fail = () => new ThreadArtifactObjectError({ operation: "upload size" });
  return body.pipe(
    Stream.mapError(fail),
    Stream.mapEffect((chunk) => {
      received += chunk.byteLength;
      return received > sizeBytes ? Effect.fail(fail()) : Effect.succeed(chunk);
    }),
    Stream.concat(
      Stream.fromEffect(
        Effect.suspend(() =>
          received === sizeBytes ? Effect.succeed(new Uint8Array()) : Effect.fail(fail()),
        ),
      ),
    ),
  );
};

/** A lost or revoked completion leaves unreferenced bytes for collection, never a recovery pointer. */
export const uploadPortableThreadArtifact = Effect.fn("relay.api.thread_artifacts.upload")(
  function* (
    input: Owner & {
      readonly artifactId: string;
      readonly operationId: string;
      readonly kind: ThreadArtifactKind;
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly body: Stream.Stream<Uint8Array, unknown>;
    },
  ) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    const transfer = makeThreadArtifactTransfer(sql, objects);
    const artifact = yield* withEnvironmentThread(input, true, transfer.prepare(input));
    if (artifact.state !== "pending" && artifact.state !== "complete")
      return yield* tenancyConflict("thread_artifact_conflict");
    const body = yield* Stream.toReadableStreamEffect(
      boundedArtifactBody(input.body, input.sizeBytes),
    );
    yield* transfer
      .uploadBytes(artifact, body)
      .pipe(Effect.ensuring(Effect.promise(() => body.cancel().catch(() => {}))));
    const completed = yield* withEnvironmentThread(
      input,
      true,
      transfer.complete({ ...input, retentionDays: 1 }),
    );
    // Keep internal storage keys and credentials inside the relay.
    return {
      artifactId: completed.artifactId,
      threadId: ThreadId.make(completed.threadId),
      operationId: completed.operationId,
      kind: completed.kind,
      sha256: completed.sha256,
      sizeBytes: completed.sizeBytes,
      state: "complete" as const,
    } satisfies RelayThreadArtifactReceipt;
  },
  Effect.catchTags({
    ...artifactErrors,
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const publishPortableThreadNativeCheckpoint = Effect.fn(
  "relay.api.thread_artifacts.publish_native",
)(
  function* (input: Owner & { readonly operationId: string; readonly manifestArtifactId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    return yield* withEnvironmentThread(
      input,
      true,
      makeThreadNativeCheckpointStore(sql, objects).publish(input),
    );
  },
  Effect.catchTags({
    ...checkpointErrors,
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  }),
);
export const publishPortableThreadAttachmentCheckpoint = Effect.fn(
  "relay.api.thread_artifacts.publish_attachments",
)(
  function* (
    input: Owner & {
      readonly operationId: string;
      readonly manifestArtifactId: string;
      readonly nativeCheckpointOperationId: string;
    },
  ) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    return yield* withEnvironmentThread(
      input,
      true,
      makeThreadAttachmentCheckpointStore(sql, objects).publish(input),
    );
  },
  Effect.catchTags({
    ...checkpointErrors,
    ThreadAttachmentCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  }),
);

export const threadArtifactsApi = HttpApiBuilder.group(RelayApi, "threadArtifacts", (handlers) =>
  handlers
    .handle("upload", ({ params, query }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* uploadPortableThreadArtifact({ ...params, ...query, body: request.stream });
      }),
    )
    .handle("publishNative", ({ params, payload }) =>
      publishPortableThreadNativeCheckpoint({ ...params, ...payload }),
    )
    .handle("publishAttachments", ({ params, payload }) =>
      publishPortableThreadAttachmentCheckpoint({ ...params, ...payload }),
    ),
);
