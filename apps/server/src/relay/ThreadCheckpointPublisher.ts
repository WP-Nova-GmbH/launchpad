import type {
  RelayThreadArtifactReceipt,
  ThreadNativeCheckpointPublicationReceipt,
  ThreadAttachmentCheckpointPublicationReceipt,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";
import { makeThreadNativeCheckpoint } from "./ThreadNativeCheckpoint.ts";
import { makeThreadAttachmentCheckpoint } from "./ThreadAttachmentCheckpoint.ts";
import { makeThreadNativeCheckpointTransfer } from "./ThreadNativeCheckpointTransfer.ts";
import { makeThreadAttachmentCheckpointTransfer } from "./ThreadAttachmentCheckpointTransfer.ts";

export interface ThreadCheckpointUpload {
  readonly artifactId: string;
  readonly operationId: string;
  readonly kind: "workspace" | "native" | "attachment" | "history" | "manifest";
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface ThreadCheckpointTransport {
  readonly upload: (
    owner: ThreadHistoryOwner,
    upload: ThreadCheckpointUpload,
    body: Stream.Stream<Uint8Array, unknown>,
  ) => Effect.Effect<RelayThreadArtifactReceipt, ThreadCheckpointPublishError>;
  readonly publishNative: (
    owner: ThreadHistoryOwner,
    input: { operationId: string; manifestArtifactId: string },
  ) => Effect.Effect<ThreadNativeCheckpointPublicationReceipt, ThreadCheckpointPublishError>;
  readonly publishAttachments: (
    owner: ThreadHistoryOwner,
    input: { operationId: string; manifestArtifactId: string; nativeCheckpointOperationId: string },
  ) => Effect.Effect<ThreadAttachmentCheckpointPublicationReceipt, ThreadCheckpointPublishError>;
}
export class ThreadCheckpointPublishError extends Schema.TaggedError<ThreadCheckpointPublishError>()(
  "ThreadCheckpointPublishError",
  { threadId: Schema.String, detail: Schema.String },
) {}

/** Immutable local outboxes are the retry journal. Only paired, relay-confirmed receipts mark them published. */
export function makeThreadCheckpointPublisher(
  sql: SqlClient.SqlClient,
  transport: ThreadCheckpointTransport,
  scratchRoot: string,
  events: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
) {
  const fences = makeThreadExecutionFence(sql);
  const native = makeThreadNativeCheckpoint(sql);
  const attachments = makeThreadAttachmentCheckpoint(sql, events);
  const nativeTransfer = makeThreadNativeCheckpointTransfer(sql, events);
  const attachmentTransfer = makeThreadAttachmentCheckpointTransfer(sql);
  // Each coordinator instance has one transfer at a time, bounding staging disk and stream pressure.
  const lock = Semaphore.makeUnsafe(1);
  const synchronize = Effect.fn("ThreadCheckpointPublisher.synchronize")(
    function* (threadId: string, captureOperationId: string | null = null) {
      const owner = yield* fences.get(threadId);
      if (!owner || owner.phase === "retired") return;
      const [point] = yield* sql<{
        turnId: string;
        captureOperationId: string | null;
        sourceSequence: number;
      }>`SELECT
      n.turn_id AS "turnId",n.capture_operation_id AS "captureOperationId",n.source_sequence AS "sourceSequence"
      FROM thread_native_checkpoints n JOIN thread_attachment_checkpoints a
        ON a.thread_id=n.thread_id AND a.generation=n.generation AND a.checkpoint_id=n.checkpoint_id
      JOIN thread_relay_history_cursors c ON c.thread_id=n.thread_id AND c.generation=n.generation
      WHERE n.thread_id=${threadId} AND n.generation=${owner.generation} AND n.environment_id=${owner.environmentId}
        AND (n.published_artifact_id IS NULL OR a.published_artifact_id IS NULL)
        AND c.source_sequence>=n.source_sequence
        AND (${captureOperationId} IS NULL OR n.capture_operation_id=${captureOperationId})
      ORDER BY n.source_sequence,n.checkpoint_id LIMIT 1`;
      if (!point) return;
      const input = {
        threadId,
        generation: owner.generation,
        turnId: point.turnId,
        sourceEnvironmentId: owner.environmentId,
        scratchRoot,
        ...(point.captureOperationId ? { captureOperationId: point.captureOperationId } : {}),
      };
      const fs = yield* FileSystem.FileSystem;
      const upload = Effect.fnUntraced(function* (packed: {
        header: { operationId: string };
        uploads: ReadonlyArray<{
          artifactId: string;
          kind: ThreadCheckpointUpload["kind"];
          sha256: string;
          sizeBytes: number;
          path: string;
        }>;
      }) {
        for (const file of packed.uploads) {
          const expected = {
            artifactId: file.artifactId,
            operationId: packed.header.operationId,
            kind: file.kind,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
          };
          const receipt = yield* transport
            .upload(owner, expected, fs.stream(file.path))
            .pipe(Effect.timeout("2 minutes"));
          if (
            receipt.threadId !== threadId ||
            receipt.operationId !== expected.operationId ||
            receipt.artifactId !== expected.artifactId ||
            receipt.sha256 !== expected.sha256 ||
            receipt.sizeBytes !== expected.sizeBytes ||
            receipt.kind !== expected.kind ||
            receipt.state !== "complete"
          )
            return yield* new ThreadCheckpointPublishError({
              threadId,
              detail: "The relay artifact receipt does not match this checkpoint.",
            });
        }
      });
      // Pack both before publishing: a missing/corrupt attachment must not retire the last complete recovery point.
      const packedNative = yield* nativeTransfer.pack(input);
      yield* Effect.gen(function* () {
        const packedAttachments = yield* attachmentTransfer.pack(input);
        yield* Effect.gen(function* () {
          yield* upload(packedNative);
          const nativeReceipt = yield* transport
            .publishNative(owner, {
              operationId: packedNative.header.operationId,
              manifestArtifactId: packedNative.artifactId,
            })
            .pipe(Effect.timeout("2 minutes"));
          if (
            nativeReceipt.operationId !== packedNative.header.operationId ||
            nativeReceipt.manifestArtifactId !== packedNative.artifactId ||
            nativeReceipt.manifestSha256 !== packedNative.sha256
          )
            return yield* new ThreadCheckpointPublishError({
              threadId,
              detail: "Native publication returned a different checkpoint.",
            });
          yield* native.markPublished(nativeReceipt);
          yield* upload(packedAttachments);
          const attachmentReceipt = yield* transport
            .publishAttachments(owner, {
              operationId: packedAttachments.header.operationId,
              manifestArtifactId: packedAttachments.artifactId,
              nativeCheckpointOperationId: nativeReceipt.operationId,
            })
            .pipe(Effect.timeout("2 minutes"));
          if (
            attachmentReceipt.operationId !== packedAttachments.header.operationId ||
            attachmentReceipt.manifestArtifactId !== packedAttachments.artifactId ||
            attachmentReceipt.manifestSha256 !== packedAttachments.sha256
          )
            return yield* new ThreadCheckpointPublishError({
              threadId,
              detail: "Attachment publication returned a different checkpoint.",
            });
          yield* attachments.markPublished(attachmentReceipt);
        }).pipe(
          Effect.ensuring(
            fs
              .remove(packedAttachments.directory, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        );
      }).pipe(
        Effect.ensuring(
          fs.remove(packedNative.directory, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    },
    lock.withPermit,
    (effect, threadId, _captureOperationId: string | null = null) =>
      effect.pipe(
        Effect.mapError(
          () =>
            new ThreadCheckpointPublishError({
              threadId,
              detail: "Checkpoint publication will retry; the local copy is retained.",
            }),
        ),
      ),
  );
  return { synchronize };
}
