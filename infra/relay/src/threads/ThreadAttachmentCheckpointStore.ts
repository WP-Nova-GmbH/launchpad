import { retireThreadCheckpoints } from "./ThreadCheckpointRetention.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  ThreadAttachmentCheckpointArchiveManifest,
  ThreadAttachmentCheckpointPublicationReceipt,
  ThreadAttachmentManifest,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
} from "@t3tools/contracts/relay";
import { attachmentCheckpointFiles } from "@t3tools/shared/attachmentCheckpointFiles";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadCheckpointObjects } from "./ThreadCheckpointObjects.ts";

const decodeHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadAttachmentCheckpointArchiveManifest),
);
const decodeAttachments = Schema.decodeEffect(Schema.fromJsonString(ThreadAttachmentManifest));
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(ThreadAttachmentManifest));
const decodeReceipt = Schema.decodeEffect(ThreadAttachmentCheckpointPublicationReceipt);
export class ThreadAttachmentCheckpointConflict extends Schema.TaggedError<ThreadAttachmentCheckpointConflict>()(
  "ThreadAttachmentCheckpointConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadAttachmentCheckpointConflict({ message });
const metadataLimit = 32 * 1024 * 1024;

/** Attachment objects share their native point's rolling retention and durable recovery pins. */
export function makeThreadAttachmentCheckpointStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const checkpointObjects = makeThreadCheckpointObjects(sql, objects, conflict);
  const getStored = Effect.fnUntraced(function* (nativeCheckpointOperationId: string) {
    const [row] = yield* sql<
      ThreadAttachmentCheckpointPublicationReceipt & { retained: boolean; artifactCount: number }
    >`SELECT
      a.operation_id AS "operationId",n.thread_id AS "threadId",n.turn_id AS "turnId",n.capture_operation_id AS "captureOperationId",
      n.source_environment_id AS "sourceEnvironmentId",n.generation,n.source_sequence AS "sourceSequence",
      n.archive_sha256 AS "nativeArchiveSha256",a.attachment_manifest_sha256 AS "attachmentManifestSha256",
      a.manifest_artifact_id AS "manifestArtifactId",a.manifest_sha256 AS "manifestSha256",n.retained,a.artifact_count AS "artifactCount"
      FROM relay_thread_attachment_checkpoints a JOIN relay_thread_native_checkpoints n ON n.operation_id=a.native_checkpoint_operation_id
      WHERE a.native_checkpoint_operation_id=${nativeCheckpointOperationId}`;
    return row ?? null;
  });
  const get = Effect.fn("relay.attachment_checkpoint.get")(function* (
    nativeCheckpointOperationId: string,
  ) {
    const row = yield* getStored(nativeCheckpointOperationId);
    return row?.retained ? yield* decodeReceipt(row) : null;
  });
  const getForOperation = Effect.fn("relay.attachment_checkpoint.operation.get")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
  }) {
    const [operation] = yield* sql<{
      checkpointOperationId: string;
    }>`SELECT o.checkpoint_operation_id AS "checkpointOperationId"
      FROM relay_thread_native_checkpoint_operations o JOIN relay_thread_native_checkpoints n ON n.operation_id=o.checkpoint_operation_id
      WHERE o.operation_id=${input.operationId} AND o.phase='active' AND n.thread_id=${input.threadId}`;
    const point = operation ? yield* getStored(operation.checkpointOperationId) : null;
    return point ? yield* decodeReceipt(point) : null;
  });
  const publish = Effect.fn("relay.attachment_checkpoint.publish")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly manifestArtifactId: string;
    readonly nativeCheckpointOperationId: string;
  }) {
    return yield* checkpointObjects.withPinned(
      {
        ...input,
        kind: "attachment",
        maxBytes: THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES + 2 * metadataLimit,
      },
      ({ artifact, readPinId, manifest, entries, byName, readFile, readMetadata }) =>
        Effect.gen(function* () {
          const header = yield* decodeHeader(yield* readMetadata("manifest.json", metadataLimit));
          if (
            header.threadId !== input.threadId ||
            header.operationId !== input.operationId ||
            header.sourceEnvironmentId !== manifest.sourceEnvironmentId ||
            header.generation !== manifest.generation ||
            byName.get("manifest.json")?.sha256 !== manifest.transferManifestSha256
          )
            return yield* conflict("Attachment checkpoint owner or manifest changed.");
          const attachments = yield* decodeAttachments(
            yield* readMetadata("attachments/manifest.json", metadataLimit),
          );
          if (encodeAttachments(attachments) !== encodeAttachments(header.attachments))
            return yield* conflict("Attachment checkpoint metadata disagrees.");
          const expected = attachmentCheckpointFiles(header);
          if (!expected || byName.size !== expected.size + 1)
            return yield* conflict("Attachment checkpoint file set is invalid.");
          for (const [name, descriptor] of expected) {
            const file = byName.get(name);
            if (
              !file ||
              file.sha256 !== descriptor.sha256 ||
              (descriptor.sizeBytes !== undefined && file.sizeBytes !== descriptor.sizeBytes)
            )
              return yield* conflict("Attachment checkpoint file descriptors disagree.");
          }
          // Metadata alone cannot certify chunks. Hash every complete file before publishing any pointer.
          for (const file of manifest.files) yield* readFile(file, () => {});
          const receipt = yield* decodeReceipt({
            ...header,
            captureOperationId: header.captureOperationId ?? null,
            manifestArtifactId: artifact.artifactId,
            manifestSha256: artifact.sha256,
          });
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [placement] = yield* sql<{
                environmentId: string;
                generation: number;
              }>`SELECT environment_id AS "environmentId",generation
            FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
              const [native] = yield* sql<{
                threadId: string;
                turnId: string;
                captureOperationId: string | null;
                environmentId: string;
                generation: number;
                sourceSequence: number;
                archiveSha256: string;
                retained: boolean;
              }>`SELECT
            thread_id AS "threadId",turn_id AS "turnId",capture_operation_id AS "captureOperationId",source_environment_id AS "environmentId",generation,
            source_sequence AS "sourceSequence",archive_sha256 AS "archiveSha256",retained
            FROM relay_thread_native_checkpoints WHERE operation_id=${input.nativeCheckpointOperationId} FOR UPDATE`;
              const prior = yield* getStored(input.nativeCheckpointOperationId);
              if (prior) {
                if (
                  !prior.retained ||
                  prior.threadId !== input.threadId ||
                  prior.operationId !== input.operationId ||
                  prior.manifestArtifactId !== input.manifestArtifactId
                )
                  return yield* conflict("Attachment publication intent changed or was retired.");
                return yield* decodeReceipt(prior);
              }
              if (
                !native?.retained ||
                native.threadId !== header.threadId ||
                native.turnId !== header.turnId ||
                native.captureOperationId !== (header.captureOperationId ?? null) ||
                native.environmentId !== header.sourceEnvironmentId ||
                native.generation !== header.generation ||
                native.sourceSequence !== header.sourceSequence ||
                native.archiveSha256 !== header.nativeArchiveSha256 ||
                placement?.environmentId !== header.sourceEnvironmentId ||
                placement.generation !== header.generation
              )
                return yield* conflict(
                  "Attachment checkpoint does not belong to that retained native point.",
                );
              const [watermark] = yield* sql<{
                sequence: number;
              }>`SELECT source_sequence AS sequence FROM relay_thread_history_watermarks
            WHERE thread_id=${input.threadId} AND environment_id=${header.sourceEnvironmentId} AND generation=${header.generation}`;
              if ((watermark?.sequence ?? -1) < header.sourceSequence)
                return yield* conflict("Attachment checkpoint history is incomplete.");
              yield* sql`INSERT INTO relay_thread_attachment_checkpoints
            (native_checkpoint_operation_id,operation_id,manifest_artifact_id,manifest_sha256,attachment_manifest_sha256,artifact_count)
            VALUES (${input.nativeCheckpointOperationId},${receipt.operationId},${receipt.manifestArtifactId},${receipt.manifestSha256},
              ${receipt.attachmentManifestSha256},${entries.length})`;
              yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
            SELECT artifact_id,${`native-checkpoint:${input.nativeCheckpointOperationId}`} FROM relay_thread_artifact_pins
            WHERE operation_id=${readPinId} ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
              // Existing recovery operations receive the same immutable point's additional files atomically.
              yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
            SELECT p.artifact_id,'native-recovery:' || o.operation_id FROM relay_thread_artifact_pins p
              CROSS JOIN relay_thread_native_checkpoint_operations o
            WHERE p.operation_id=${readPinId} AND o.checkpoint_operation_id=${input.nativeCheckpointOperationId} AND o.phase='active'
            ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
              yield* sql`UPDATE relay_thread_native_checkpoints SET artifact_count=artifact_count+${entries.length}
            WHERE operation_id=${input.nativeCheckpointOperationId}`;
              yield* retireThreadCheckpoints(sql, input.threadId);
              return receipt;
            }),
          );
        }),
    );
  });
  return { get, getForOperation, publish };
}
