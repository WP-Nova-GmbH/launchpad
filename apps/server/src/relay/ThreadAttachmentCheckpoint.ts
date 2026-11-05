import {
  ThreadAttachmentCheckpointPublicationReceipt,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
} from "@t3tools/contracts/relay";
import { attachmentRelativePath } from "../attachmentStore.ts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadNativeCheckpoint, threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";
import {
  exportThreadAttachments,
  threadAttachmentFiles,
  inspectThreadAttachmentFile,
  ThreadAttachmentManifest,
} from "./ThreadAttachmentTransfer.ts";
import { flushThreadArtifactTree, syncThreadArtifactPath } from "./ThreadArtifactDurability.ts";

export class ThreadAttachmentCheckpointError extends Schema.TaggedError<ThreadAttachmentCheckpointError>()(
  "ThreadAttachmentCheckpointError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadAttachmentCheckpointError({ message });
const decodePublicationReceipt = Schema.decodeEffect(ThreadAttachmentCheckpointPublicationReceipt);
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ThreadAttachmentManifest));
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const verifyThreadAttachmentCheckpointArchive = Effect.fnUntraced(function* (
  point: { directory: string; manifestSha256: string },
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const canonical = yield* fs.realPath(point.directory);
  if (canonical !== path.resolve(point.directory))
    return yield* fail("Attachment checkpoint storage was redirected.");
  const file = path.join(canonical, "manifest.json");
  if (
    (yield* fs.realPath(file)) !== file ||
    (yield* fs.stat(file)).type !== "File" ||
    (yield* fs.stat(file)).size > 32n * 1024n * 1024n
  )
    return yield* fail("Attachment checkpoint manifest is not a bounded regular file.");
  const bytes = yield* fs.readFile(file);
  if (hash(bytes) !== point.manifestSha256)
    return yield* fail("Attachment checkpoint manifest changed.");
  const manifest = yield* decodeManifest(new TextDecoder().decode(bytes));
  if (manifest.threadId !== threadId)
    return yield* fail("Attachment checkpoint belongs to a different thread.");
  if (
    manifest.files.length > THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES ||
    manifest.files.reduce((sum, entry) => sum + entry.attachment.sizeBytes, 0) >
      THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES
  )
    return yield* fail("Attachment checkpoint exceeds its bounded storage format.");
  const names = new Set([
    "manifest.json",
    ...manifest.files.map((entry) => attachmentRelativePath(entry.attachment)),
  ]);
  const actual = yield* fs.readDirectory(canonical);
  if (
    names.size !== manifest.files.length + 1 ||
    actual.length !== names.size ||
    actual.some((name) => !names.has(name))
  )
    return yield* fail("Attachment checkpoint contains missing or unexpected files.");
  const files = yield* threadAttachmentFiles(
    threadId,
    manifest.files.map((entry) => entry.attachment),
  );
  if (files.length !== manifest.files.length)
    return yield* fail("Attachment checkpoint repeats a file.");
  const hashes = new Map(manifest.files.map((entry) => [entry.attachment.id, entry.sha256]));
  for (const file of files) {
    const stored = yield* inspectThreadAttachmentFile(canonical, file.filename);
    if (
      stored.sha256 !== hashes.get(file.attachment.id) ||
      stored.sizeBytes !== file.attachment.sizeBytes
    )
      return yield* fail("Attachment checkpoint file failed verification.");
  }
  return { manifest };
});

/** Full chat attachments include removed queued prompts and historical answers;
 * native provider references alone are not enough to retain the visible history. */
export function makeThreadAttachmentCheckpoint(
  sql: SqlClient.SqlClient,
  events: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
) {
  const native = makeThreadNativeCheckpoint(sql),
    fences = makeThreadExecutionFence(sql);
  const get = Effect.fnUntraced(function* (
    threadId: string,
    generation: number,
    checkpointId: string,
  ) {
    const [row] = yield* sql<{
      environmentId: string;
      sourceSequence: number;
      directory: string;
      manifestSha256: string;
      publishedArtifactId: string | null;
    }>`SELECT environment_id AS "environmentId",
      source_sequence AS "sourceSequence",directory,manifest_sha256 AS "manifestSha256",
      published_artifact_id AS "publishedArtifactId" FROM thread_attachment_checkpoints
      WHERE thread_id=${threadId} AND generation=${generation} AND checkpoint_id=${checkpointId}`;
    return row ?? null;
  });
  const current = Effect.fnUntraced(function* (input: {
    threadId: string;
    generation: number;
    turnId: string;
    captureOperationId?: string;
  }) {
    const fence = yield* fences.get(input.threadId),
      point = yield* native.get(
        input.threadId,
        input.generation,
        threadCheckpointId(input.turnId, input.captureOperationId),
      );
    if (
      !fence ||
      !point ||
      point.turnId !== input.turnId ||
      point.captureOperationId !== (input.captureOperationId ?? null) ||
      (input.captureOperationId !== undefined &&
        (fence.phase !== "frozen" ||
          fence.operationId !== input.captureOperationId ||
          fence.frozenSequence !== point.sourceSequence)) ||
      fence.phase === "retired" ||
      fence.generation !== input.generation ||
      fence.environmentId !== point.environmentId
    )
      return yield* fail("This environment does not own the attachment checkpoint's native point.");
    if (input.captureOperationId !== undefined) {
      const [head] = yield* sql<{
        sequence: number;
      }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM orchestration_events
        WHERE aggregate_kind='thread' AND stream_id=${input.threadId}`;
      const pending =
        yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${input.threadId}
        AND (completed=0 OR relay_completed=0) LIMIT 1`;
      if (head?.sequence !== point.sourceSequence || pending.length)
        return yield* fail(
          "Frozen attachment history or stopped-work acknowledgement is incomplete.",
        );
    }
    return point;
  });
  const capture = Effect.fn("ThreadAttachmentCheckpoint.capture")(function* (input: {
    readonly threadId: string;
    readonly generation: number;
    readonly turnId: string;
    readonly captureOperationId?: string;
    readonly artifactRoot: string;
    readonly attachmentsDir: string;
  }) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const point = yield* current(input);
    const prior = yield* get(
      input.threadId,
      input.generation,
      threadCheckpointId(input.turnId, input.captureOperationId),
    );
    yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
    const root = yield* fs.realPath(input.artifactRoot);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        if (prior) {
          if (
            prior.environmentId !== point.environmentId ||
            prior.sourceSequence !== point.sourceSequence
          )
            return yield* fail("Attachment checkpoint identity changed.");
          yield* verifyThreadAttachmentCheckpointArchive(prior, input.threadId);
          yield* current(input);
          return prior;
        }
        const [head] = yield* sql<{ count: number; last: number }>`SELECT count(*) AS count,
        COALESCE(max(sequence),0) AS last FROM orchestration_events
        WHERE aggregate_kind='thread' AND stream_id=${input.threadId} AND sequence<=${point.sourceSequence}`;
        if (!head?.count || head.last !== point.sourceSequence)
          return yield* fail("The native point's complete retained history is unavailable.");
        let count = 0,
          previous = 0;
        const identities = new Set<string>();
        const attachments = yield* collectThreadAttachmentReferences(
          input.threadId,
          events
            .readAggregateRange({
              aggregateKind: "thread",
              aggregateId: input.threadId,
              fromSequenceExclusive: 0,
              toSequenceInclusive: point.sourceSequence,
              limit: head.count,
            })
            .pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (
                    event.sequence <= previous ||
                    event.sequence > point.sourceSequence ||
                    identities.has(event.eventId) ||
                    (count === 0 && event.type !== "thread.created")
                  )
                    return yield* fail("Attachment history is incomplete or out of order.");
                  count++;
                  previous = event.sequence;
                  identities.add(event.eventId);
                }),
              ),
            ),
        );
        if (count !== head.count || previous !== point.sourceSequence)
          return yield* fail("Attachment history omitted part of the native point's watermark.");
        const unique = new Map(attachments.map((attachment) => [attachment.id, attachment]));
        if (
          unique.size > THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES ||
          [...unique.values()].reduce((sum, attachment) => sum + attachment.sizeBytes, 0) >
            THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES
        )
          return yield* fail("Attachment checkpoint exceeds its bounded storage format.");
        const archive = yield* exportThreadAttachments({
          threadId: input.threadId,
          attachments,
          attachmentsDir: input.attachmentsDir,
          artifactRoot: root,
        });
        return yield* Effect.gen(function* () {
          const directory = yield* fs.realPath(archive.directory);
          if (!directory.startsWith(`${root}${path.sep}`))
            return yield* fail("Attachment checkpoint escaped staging storage.");
          const manifestSha256 = hash(yield* fs.readFile(path.join(directory, "manifest.json")));
          yield* verifyThreadAttachmentCheckpointArchive(
            { directory, manifestSha256 },
            input.threadId,
          );
          yield* flushThreadArtifactTree(directory);
          yield* syncThreadArtifactPath(root);
          yield* syncThreadArtifactPath(path.dirname(root));
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const owner = yield* current(input);
              if (
                owner.environmentId !== point.environmentId ||
                owner.sourceSequence !== point.sourceSequence
              )
                return yield* fail("Attachment checkpoint ownership changed during export.");
              yield* sql`INSERT INTO thread_attachment_checkpoints
            (thread_id,generation,checkpoint_id,turn_id,environment_id,source_sequence,directory,manifest_sha256)
            VALUES (${input.threadId},${input.generation},${threadCheckpointId(input.turnId, input.captureOperationId)},${input.turnId},${point.environmentId},
              ${point.sourceSequence},${directory},${manifestSha256})`;
              return (yield* get(
                input.threadId,
                input.generation,
                threadCheckpointId(input.turnId, input.captureOperationId),
              ))!;
            }),
          );
        }).pipe(
          Effect.onError(() =>
            get(
              input.threadId,
              input.generation,
              threadCheckpointId(input.turnId, input.captureOperationId),
            ).pipe(
              Effect.flatMap((committed) =>
                committed?.directory === archive.directory
                  ? Effect.void
                  : fs.remove(archive.directory, { recursive: true }),
              ),
              Effect.ignore,
            ),
          ),
        );
      }),
    );
  });
  /** A trusted catalog receipt acknowledges bytes; live retention pins must be checked separately. */
  const markPublished = Effect.fn("ThreadAttachmentCheckpoint.markPublished")(function* (
    value: ThreadAttachmentCheckpointPublicationReceipt,
  ) {
    const receipt = yield* decodePublicationReceipt(value);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const point = yield* get(
          receipt.threadId,
          receipt.generation,
          threadCheckpointId(receipt.turnId, receipt.captureOperationId),
        );
        const nativePoint = yield* native.get(
          receipt.threadId,
          receipt.generation,
          threadCheckpointId(receipt.turnId, receipt.captureOperationId),
        );
        if (
          !point ||
          !nativePoint ||
          point.environmentId !== receipt.sourceEnvironmentId ||
          point.sourceSequence !== receipt.sourceSequence ||
          nativePoint.turnId !== receipt.turnId ||
          nativePoint.captureOperationId !== (receipt.captureOperationId ?? null) ||
          nativePoint.archiveSha256 !== receipt.nativeArchiveSha256 ||
          nativePoint.environmentId !== receipt.sourceEnvironmentId ||
          nativePoint.sourceSequence !== receipt.sourceSequence ||
          point.manifestSha256 !== receipt.attachmentManifestSha256 ||
          (point.publishedArtifactId !== null &&
            point.publishedArtifactId !== receipt.manifestArtifactId)
        )
          return yield* fail(
            "Attachment publication receipt does not match this local checkpoint.",
          );
        yield* sql`UPDATE thread_attachment_checkpoints SET published_artifact_id=${receipt.manifestArtifactId}
        WHERE thread_id=${receipt.threadId} AND generation=${receipt.generation} AND checkpoint_id=${threadCheckpointId(receipt.turnId, receipt.captureOperationId)}
          AND (published_artifact_id IS NULL OR published_artifact_id=${receipt.manifestArtifactId})`;
        return (yield* get(
          receipt.threadId,
          receipt.generation,
          threadCheckpointId(receipt.turnId, receipt.captureOperationId),
        ))!;
      }),
    );
  });
  return { capture, get, markPublished };
}
