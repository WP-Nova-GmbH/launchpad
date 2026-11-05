import { ThreadNativeCheckpointPublicationReceipt } from "@t3tools/contracts/relay";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { flushThreadArtifactTree, syncThreadArtifactPath } from "./ThreadArtifactDurability.ts";

export class ThreadNativeCheckpointError extends Schema.TaggedError<ThreadNativeCheckpointError>()(
  "ThreadNativeCheckpointError",
  { message: Schema.String },
) {}
export interface NativeConversationArchive {
  readonly directory: string;
  readonly nativeThreadId: string;
}

const decodePublicationReceipt = Schema.decodeEffect(ThreadNativeCheckpointPublicationReceipt);
/** A frozen save has its own key without inventing or overwriting a provider turn. */
export const threadCheckpointId = (turnId: string, captureOperationId?: string | null) =>
  captureOperationId ? `frozen:${captureOperationId}` : turnId;

const encodeDigestEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const digestNativeCheckpointArchive = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const hash = NodeCrypto.createHash("sha256");
  let count = 0,
    bytes = 0n;
  const visit = Effect.fnUntraced(function* (
    relative: string,
  ): Effect.fn.Return<
    void,
    import("effect/PlatformError").PlatformError | ThreadNativeCheckpointError,
    FileSystem.FileSystem | Path.Path
  > {
    const current = path.join(directory, relative);
    if ((yield* fs.realPath(current)) !== current)
      return yield* new ThreadNativeCheckpointError({
        message: "Native checkpoint contains an unexpected link.",
      });
    const info = yield* fs.stat(current);
    if (++count > 1024 || relative.split(path.sep).length > 8)
      return yield* new ThreadNativeCheckpointError({
        message: "Native checkpoint exceeds its bounded storage format.",
      });
    if (info.type === "Directory") {
      hash.update(encodeDigestEntry([relative, "directory"]) + "\n");
      for (const name of (yield* fs.readDirectory(current)).sort())
        yield* visit(path.join(relative, name));
    } else if (info.type === "File") {
      bytes += info.size;
      if (bytes > 512n * 1024n * 1024n)
        return yield* new ThreadNativeCheckpointError({
          message: "Native checkpoint exceeds its bounded storage format.",
        });
      hash.update(encodeDigestEntry([relative, "file", String(info.size)]) + "\n");
      yield* fs
        .stream(current)
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
    } else
      return yield* new ThreadNativeCheckpointError({
        message: "Native checkpoint contains a non-file artifact.",
      });
  });
  yield* visit("");
  return hash.digest("hex");
});

/** A durable local outbox, not evidence that an independent relay copy exists.
 * VM deletion requires published_artifact_id plus the relay's pinned catalog receipt. */
export function makeThreadNativeCheckpoint(sql: SqlClient.SqlClient) {
  const fences = makeThreadExecutionFence(sql);
  const get = Effect.fnUntraced(function* (
    threadId: string,
    generation: number,
    checkpointId: string,
  ) {
    const [row] = yield* sql<{
      directory: string;
      turnId: string;
      captureOperationId: string | null;
      environmentId: string;
      generation: number;
      nativeThreadId: string;
      manifestSha256: string;
      archiveSha256: string;
      sourceSequence: number;
      publishedArtifactId: string | null;
    }>`SELECT directory, turn_id AS "turnId",capture_operation_id AS "captureOperationId",environment_id AS "environmentId", generation, native_thread_id AS "nativeThreadId", manifest_sha256 AS "manifestSha256",
      source_sequence AS "sourceSequence", archive_sha256 AS "archiveSha256", published_artifact_id AS "publishedArtifactId"
      FROM thread_native_checkpoints WHERE thread_id = ${threadId}
      AND generation = ${generation} AND checkpoint_id = ${checkpointId}`;
    return row ?? null;
  });
  const capture = Effect.fn("ThreadNativeCheckpoint.capture")(function* <E, R>(
    input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly artifactRoot: string;
      readonly captureOperationId?: string;
    },
    exportConversation: (artifactRoot: string) => Effect.Effect<NativeConversationArchive, E, R>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fence = yield* fences.get(input.threadId);
    if (!fence) {
      if (input.captureOperationId !== undefined)
        return yield* new ThreadNativeCheckpointError({
          message: "A final checkpoint requires enrolled frozen ownership.",
        });
      return null;
    }
    const checkpointId = threadCheckpointId(input.turnId, input.captureOperationId);
    const frozen = input.captureOperationId !== undefined;
    const assertOwner = Effect.fnUntraced(function* () {
      const owner = yield* fences.get(input.threadId);
      if (
        !owner ||
        owner.generation !== fence.generation ||
        owner.environmentId !== fence.environmentId ||
        (frozen
          ? owner.phase !== "frozen" ||
            owner.operationId !== input.captureOperationId ||
            owner.frozenSequence === null ||
            owner.frozenSequence !== fence.frozenSequence
          : owner.phase !== "active" && owner.phase !== "draining")
      )
        return yield* new ThreadNativeCheckpointError({
          message: "Thread ownership changed during native checkpoint capture.",
        });
      if (frozen) {
        const [head] = yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM orchestration_events
          WHERE aggregate_kind='thread' AND stream_id=${input.threadId}`;
        const pending =
          yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${input.threadId}
          AND (completed=0 OR relay_completed=0) LIMIT 1`;
        if (head?.sequence !== owner.frozenSequence || pending.length)
          return yield* new ThreadNativeCheckpointError({
            message: "Frozen history or stopped-work acknowledgement is incomplete.",
          });
      }
      return owner;
    });
    if (frozen) {
      yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(input.captureOperationId);
      yield* assertOwner();
    }
    if (!frozen && fence.phase !== "active" && fence.phase !== "draining")
      return yield* new ThreadNativeCheckpointError({
        message: "This thread no longer owns native checkpoint capture.",
      });
    const prior = yield* get(input.threadId, fence.generation, checkpointId);
    if (prior) {
      const text = yield* fs.readFileString(path.join(prior.directory, "manifest.json"));
      if (
        NodeCrypto.createHash("sha256").update(text).digest("hex") !== prior.manifestSha256 ||
        (yield* digestNativeCheckpointArchive(prior.directory)) !== prior.archiveSha256
      )
        return yield* new ThreadNativeCheckpointError({
          message: "The retained native checkpoint is damaged.",
        });
      if (
        prior.turnId !== input.turnId ||
        prior.environmentId !== fence.environmentId ||
        (frozen && prior.sourceSequence !== fence.frozenSequence) ||
        prior.captureOperationId !== (input.captureOperationId ?? null)
      )
        return yield* new ThreadNativeCheckpointError({
          message: "Checkpoint capture identity changed.",
        });
      yield* assertOwner();
      return prior;
    }
    const key = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex");
    const root = path.join(input.artifactRoot, key);
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    const stage = yield* fs.realPath(
      yield* fs.makeTempDirectory({ directory: root, prefix: "checkpoint-" }),
    );
    return yield* Effect.gen(function* () {
      const archive = yield* exportConversation(stage);
      const canonical = yield* fs.realPath(archive.directory);
      const canonicalStage = yield* fs.realPath(stage);
      if (!canonical.startsWith(`${canonicalStage}${path.sep}`))
        return yield* new ThreadNativeCheckpointError({
          message: "Native checkpoint escaped its staging directory.",
        });
      const manifest = yield* fs.readFileString(path.join(canonical, "manifest.json"));
      const manifestSha256 = NodeCrypto.createHash("sha256").update(manifest).digest("hex");
      const archiveSha256 = yield* digestNativeCheckpointArchive(canonical);
      yield* flushThreadArtifactTree(stage);
      // Flush newly-created parent links as well as the files themselves.
      yield* syncThreadArtifactPath(root);
      yield* syncThreadArtifactPath(input.artifactRoot);
      yield* syncThreadArtifactPath(path.dirname(input.artifactRoot));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* assertOwner();
          const concurrent = yield* get(input.threadId, fence.generation, checkpointId);
          if (concurrent)
            return yield* new ThreadNativeCheckpointError({
              message: "Another capture already published this turn's native checkpoint.",
            });
          const [head] = yield* sql<{
            sequence: number;
          }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}`;
          const sourceSequence = head?.sequence ?? 0;
          yield* sql`INSERT INTO thread_native_checkpoints
          (thread_id, checkpoint_id, turn_id, capture_operation_id, environment_id, generation, source_sequence, native_thread_id, directory, manifest_sha256, archive_sha256)
          VALUES (${input.threadId}, ${checkpointId}, ${input.turnId},${input.captureOperationId ?? null}, ${fence.environmentId}, ${fence.generation},
            ${sourceSequence}, ${archive.nativeThreadId}, ${canonical}, ${manifestSha256}, ${archiveSha256})`;
          return {
            directory: canonical,
            turnId: input.turnId,
            captureOperationId: input.captureOperationId ?? null,
            environmentId: fence.environmentId,
            generation: fence.generation,
            nativeThreadId: archive.nativeThreadId,
            manifestSha256,
            archiveSha256,
            sourceSequence,
            publishedArtifactId: null,
          };
        }),
      );
    }).pipe(
      Effect.onError(() =>
        get(input.threadId, fence.generation, checkpointId).pipe(
          Effect.flatMap((committed) =>
            committed?.directory.startsWith(`${stage}${path.sep}`)
              ? Effect.void
              : fs.remove(stage, { recursive: true }),
          ),
          // Preserve an uncertain candidate when its catalog cannot be read.
          Effect.ignore,
        ),
      ),
    );
  });
  /** A caller supplies a trusted relay receipt; this marker alone never proves pins still exist. */
  const markPublished = Effect.fn("ThreadNativeCheckpoint.markPublished")(function* (
    value: ThreadNativeCheckpointPublicationReceipt,
  ) {
    const receipt = yield* decodePublicationReceipt(value);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const point = yield* get(
          receipt.threadId,
          receipt.generation,
          threadCheckpointId(receipt.turnId, receipt.captureOperationId),
        );
        if (
          !point ||
          point.turnId !== receipt.turnId ||
          point.captureOperationId !== (receipt.captureOperationId ?? null) ||
          point.environmentId !== receipt.sourceEnvironmentId ||
          point.sourceSequence !== receipt.sourceSequence ||
          point.nativeThreadId !== receipt.nativeThreadId ||
          point.manifestSha256 !== receipt.nativeManifestSha256 ||
          point.archiveSha256 !== receipt.archiveSha256 ||
          (point.publishedArtifactId !== null &&
            point.publishedArtifactId !== receipt.manifestArtifactId)
        )
          return yield* new ThreadNativeCheckpointError({
            message: "Publication receipt does not match the local native checkpoint.",
          });
        yield* sql`UPDATE thread_native_checkpoints SET published_artifact_id=${receipt.manifestArtifactId}
        WHERE thread_id=${receipt.threadId} AND generation=${receipt.generation} AND checkpoint_id=${threadCheckpointId(receipt.turnId, receipt.captureOperationId)}`;
        return yield* get(
          receipt.threadId,
          receipt.generation,
          threadCheckpointId(receipt.turnId, receipt.captureOperationId),
        );
      }),
    );
  });
  return {
    capture,
    get,
    markPublished,
    captureFrozen: <E, R>(
      input: {
        readonly threadId: string;
        readonly turnId: string;
        readonly operationId: string;
        readonly artifactRoot: string;
      },
      exportConversation: (artifactRoot: string) => Effect.Effect<NativeConversationArchive, E, R>,
    ) => capture({ ...input, captureOperationId: input.operationId }, exportConversation),
  };
}
