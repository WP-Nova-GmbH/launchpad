import * as NodeCrypto from "node:crypto";
import {
  ThreadAttachmentCheckpointArchiveManifest,
  ThreadAttachmentManifest,
  ThreadTransferChunkManifest,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadNativeCheckpoint, threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  ThreadAttachmentCheckpointError,
  verifyThreadAttachmentCheckpointArchive,
} from "./ThreadAttachmentCheckpoint.ts";
import { checkpointPublicationOperationId } from "./ThreadCheckpointIntent.ts";
import { flushThreadArtifactTree } from "./ThreadArtifactDurability.ts";
import {
  packThreadTransferArchive,
  materializeThreadTransferChunks,
} from "./ThreadTransferChunks.ts";

const metadataLimit = 32 * 1024 * 1024;
const decodeHeaderValue = Schema.decodeEffect(ThreadAttachmentCheckpointArchiveManifest);
const decodeHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadAttachmentCheckpointArchiveManifest),
);
const encodeHeader = Schema.encodeEffect(
  Schema.fromJsonString(ThreadAttachmentCheckpointArchiveManifest),
);
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(ThreadAttachmentManifest));
const decodeChunks = Schema.decodeEffect(ThreadTransferChunkManifest);
const fail = (message: string) => new ThreadAttachmentCheckpointError({ message });
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
type Header = ThreadAttachmentCheckpointArchiveManifest;
type Identity = Pick<
  Header,
  | "threadId"
  | "operationId"
  | "turnId"
  | "sourceEnvironmentId"
  | "generation"
  | "sourceSequence"
  | "captureOperationId"
  | "nativeArchiveSha256"
  | "attachmentManifestSha256"
>;

/** Package only the immutable attachment outbox. Upload and independent retention are separate steps. */
export function makeThreadAttachmentCheckpointTransfer(sql: SqlClient.SqlClient) {
  const native = makeThreadNativeCheckpoint(sql),
    fences = makeThreadExecutionFence(sql);
  const own = Effect.fnUntraced(function* (input: {
    readonly threadId: string;
    readonly generation: number;
    readonly turnId: string;
    readonly captureOperationId?: string;
    readonly sourceEnvironmentId: string;
  }) {
    const point = yield* native.get(
        input.threadId,
        input.generation,
        threadCheckpointId(input.turnId, input.captureOperationId),
      ),
      fence = yield* fences.get(input.threadId);
    const [attachments] = yield* sql<{
      directory: string;
      manifestSha256: string;
      environmentId: string;
      sourceSequence: number;
    }>`
      SELECT directory,manifest_sha256 AS "manifestSha256",environment_id AS "environmentId",source_sequence AS "sourceSequence"
      FROM thread_attachment_checkpoints WHERE thread_id=${input.threadId} AND generation=${input.generation} AND checkpoint_id=${threadCheckpointId(input.turnId, input.captureOperationId)}`;
    if (
      !point ||
      !fence ||
      !attachments ||
      point.turnId !== input.turnId ||
      point.captureOperationId !== (input.captureOperationId ?? null) ||
      (input.captureOperationId !== undefined &&
        (fence.phase !== "frozen" ||
          fence.operationId !== input.captureOperationId ||
          fence.frozenSequence !== point.sourceSequence)) ||
      fence.phase === "retired" ||
      fence.environmentId !== input.sourceEnvironmentId ||
      fence.generation !== input.generation ||
      point.environmentId !== input.sourceEnvironmentId ||
      attachments.environmentId !== point.environmentId ||
      attachments.sourceSequence !== point.sourceSequence
    )
      return yield* fail("This environment does not own the requested attachment checkpoint.");
    return { point, attachments };
  });
  const pack = Effect.fn("ThreadAttachmentCheckpointTransfer.pack")(function* (input: {
    readonly threadId: string;
    readonly generation: number;
    readonly turnId: string;
    readonly captureOperationId?: string;
    readonly sourceEnvironmentId: string;
    readonly scratchRoot: string;
    readonly chunkSizeBytes?: number;
  }) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const { point, attachments } = yield* own(input);
    const source = yield* fs.realPath(attachments.directory);
    const scratch = path.resolve(input.scratchRoot);
    let ancestor = scratch;
    while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
    const canonicalScratch = path.resolve(
      yield* fs.realPath(ancestor),
      path.relative(ancestor, scratch),
    );
    if (canonicalScratch === source || canonicalScratch.startsWith(`${source}${path.sep}`))
      return yield* fail("Attachment packing requires separate staging storage.");
    yield* fs.makeDirectory(scratch, { recursive: true, mode: 0o700 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const stage = yield* fs.makeTempDirectoryScoped({
          directory: scratch,
          prefix: "attachment-transfer-",
        });
        const archive = path.join(stage, "archive");
        const original = yield* verifyThreadAttachmentCheckpointArchive(
          attachments,
          input.threadId,
        );
        const header = yield* decodeHeaderValue({
          format: "launchpad-attachment-checkpoint-v1",
          threadId: input.threadId,
          operationId: checkpointPublicationOperationId(
            "launchpad-attachment-checkpoint-v1",
            input.threadId,
            input.generation,
            input.turnId,
            {
              ...point,
              additionalManifestSha256: attachments.manifestSha256,
            },
          ),
          turnId: input.turnId,
          ...(input.captureOperationId === undefined
            ? {}
            : { captureOperationId: input.captureOperationId }),
          sourceEnvironmentId: input.sourceEnvironmentId,
          generation: input.generation,
          sourceSequence: point.sourceSequence,
          nativeArchiveSha256: point.archiveSha256,
          attachmentManifestSha256: attachments.manifestSha256,
          attachments: original.manifest,
        });
        yield* fs.makeDirectory(archive, { mode: 0o700 });
        const copy = path.join(archive, "attachments");
        yield* fs.copy(source, copy);
        yield* verifyThreadAttachmentCheckpointArchive(
          { ...attachments, directory: copy },
          input.threadId,
        );
        yield* verifyThreadAttachmentCheckpointArchive(attachments, input.threadId);
        const encoded = yield* encodeHeader(header),
          bytes = new TextEncoder().encode(encoded);
        if (bytes.length > metadataLimit)
          return yield* fail("Attachment checkpoint metadata is too large.");
        yield* fs.writeFile(path.join(archive, "manifest.json"), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        yield* flushThreadArtifactTree(archive);
        const packed = yield* packThreadTransferArchive({
          archiveDirectory: archive,
          scratchRoot: scratch,
          expectedManifestSha256: hash(bytes),
          ...(input.chunkSizeBytes === undefined ? {} : { chunkSizeBytes: input.chunkSizeBytes }),
        });
        return yield* Effect.gen(function* () {
          const expectedFiles = new Map([
            ["manifest.json", { sha256: hash(bytes), sizeBytes: bytes.length }],
            ["attachments/manifest.json", { sha256: attachments.manifestSha256 }],
            ...header.attachments.files.map(
              (file): [string, { sha256: string; sizeBytes: number }] => [
                `attachments/${attachmentRelativePath(file.attachment)}`,
                { sha256: file.sha256, sizeBytes: file.attachment.sizeBytes },
              ],
            ),
          ]);
          if (
            packed.manifest.files.length !== expectedFiles.size ||
            packed.manifest.files.some((file) => {
              const expected = expectedFiles.get(file.path);
              return (
                !expected ||
                expected.sha256 !== file.sha256 ||
                (expected.sizeBytes !== undefined && expected.sizeBytes !== file.sizeBytes)
              );
            })
          )
            return yield* fail("Attachment bytes changed during chunk packing.");
          const current = yield* own(input);
          if (
            current.point.archiveSha256 !== point.archiveSha256 ||
            current.attachments.manifestSha256 !== attachments.manifestSha256
          )
            return yield* fail("Attachment checkpoint identity changed while packing.");
          return { ...packed, header };
        }).pipe(
          Effect.onError(() =>
            fs.remove(packed.directory, { recursive: true }).pipe(Effect.ignore),
          ),
        );
      }),
    );
  });
  return { pack };
}

/** Reconstruct in quarantine. Installation into an environment remains an explicit, exclusive step. */
export const materializeAttachmentCheckpoint = Effect.fn(
  "ThreadAttachmentCheckpointTransfer.materialize",
)(function* (
  input: Parameters<typeof materializeThreadTransferChunks>[0] & { readonly expected: Identity },
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const manifest = yield* decodeChunks(input.manifest);
  if (
    manifest.threadId !== input.expected.threadId ||
    manifest.operationId !== input.expected.operationId ||
    manifest.sourceEnvironmentId !== input.expected.sourceEnvironmentId ||
    manifest.generation !== input.expected.generation ||
    manifest.files.length > THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES + 2 ||
    manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) >
      THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES + 2 * metadataLimit ||
    manifest.files.some(
      (file) => file.path !== "manifest.json" && !/^attachments\/[^/]+$/u.test(file.path),
    ) ||
    (manifest.files.find((file) => file.path === "manifest.json")?.sizeBytes ?? Infinity) >
      metadataLimit ||
    (manifest.files.find((file) => file.path === "attachments/manifest.json")?.sizeBytes ??
      Infinity) > metadataLimit
  )
    return yield* fail("Attachment chunks exceed or do not match the requested recovery point.");
  const directory = yield* materializeThreadTransferChunks({ ...input, manifest });
  return yield* Effect.gen(function* () {
    const header = yield* decodeHeader(
      yield* fs.readFileString(path.join(directory, "manifest.json")),
    );
    for (const key of [
      "threadId",
      "operationId",
      "turnId",
      "sourceEnvironmentId",
      "generation",
      "sourceSequence",
      "nativeArchiveSha256",
      "attachmentManifestSha256",
    ] as const)
      if (header[key] !== input.expected[key])
        return yield* fail("Attachment checkpoint does not match the requested recovery point.");
    if ((header.captureOperationId ?? null) !== (input.expected.captureOperationId ?? null))
      return yield* fail("Attachment checkpoint belongs to another frozen save.");
    const attachmentsDirectory = path.join(directory, "attachments");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const verified = yield* verifyThreadAttachmentCheckpointArchive(
          {
            directory: attachmentsDirectory,
            manifestSha256: header.attachmentManifestSha256,
          },
          header.threadId,
        );
        if (encodeAttachments(verified.manifest) !== encodeAttachments(header.attachments))
          return yield* fail("Attachment archive and checkpoint header disagree.");
        const allowed = new Set([
          "manifest.json",
          "attachments/manifest.json",
          ...verified.manifest.files.map(
            (file) => `attachments/${attachmentRelativePath(file.attachment)}`,
          ),
        ]);
        if (
          manifest.files.length !== allowed.size ||
          manifest.files.some((file) => !allowed.has(file.path))
        )
          return yield* fail("Unexpected files in the attachment recovery archive.");
      }),
    );
    return { directory, attachmentsDirectory, header };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});
