import * as NodeCrypto from "node:crypto";
import {
  ThreadId,
  TurnId,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
} from "@t3tools/contracts";
import {
  WorkflowRecoveryManifest,
  WorkflowSaveReceipt,
  WORKFLOW_RESULT_MAX_BYTES,
} from "@t3tools/contracts/workflows";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointDiffQuery } from "../checkpointing/CheckpointDiffQuery.ts";
import {
  CheckpointWorkflowDiffRestrictedError,
  CheckpointWorkflowPinUnavailableError,
} from "../checkpointing/Errors.ts";
import {
  makeWorkflowResultOutbox,
  decodeWorkflowResultCapture,
  decodeWorkflowSaveBinding,
  type WorkflowSaveIntent,
} from "../jobs/WorkflowResultOutbox.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import type { ThreadHistoryOwner, ThreadHistorySyncError } from "./ThreadHistorySync.ts";
import type {
  ThreadCheckpointTransport,
  ThreadCheckpointPublishError,
} from "./ThreadCheckpointPublisher.ts";
import { checkpointPublicationOperationId } from "./ThreadCheckpointIntent.ts";
import { flushThreadArtifactTree } from "./ThreadArtifactDurability.ts";

export class WorkflowResultSaveError extends Schema.TaggedError<WorkflowResultSaveError>()(
  "WorkflowResultSaveError",
  { detail: Schema.String, permanent: Schema.Boolean },
) {}
export interface WorkflowResultTransport {
  reserve: (
    owner: ThreadHistoryOwner,
    input: { publicationId: string; nativeCheckpointOperationId: string },
  ) => Effect.Effect<void, WorkflowResultSaveError>;
  publish: (
    owner: ThreadHistoryOwner,
    input: { publicationId: string; manifestArtifactId: string },
  ) => Effect.Effect<WorkflowSaveReceipt, WorkflowResultSaveError>;
}
const manifestCodec = Schema.fromJsonString(WorkflowRecoveryManifest);
const encodeManifest = Schema.encodeSync(manifestCodec);
const decodeManifest = Schema.decodeUnknownEffect(manifestCodec);
const isSaveError = Schema.is(WorkflowResultSaveError);
const isOutputLimit = Schema.is(VcsProcessOutputLimitError);
const isOutputRead = Schema.is(VcsProcessOutputReadError);
const isRestricted = Schema.is(CheckpointWorkflowDiffRestrictedError);
const isMissingPin = Schema.is(CheckpointWorkflowPinUnavailableError);
const fail = (detail: string, permanent = false) =>
  new WorkflowResultSaveError({ detail, permanent });
const describe = (error: unknown) =>
  isSaveError(error)
    ? error.detail
    : isOutputLimit(error)
      ? "This patch exceeds the 10 MB saved-result limit. Cancel the run and reduce the changes."
      : isOutputRead(error) && error.reason
        ? "This patch contains binary or invalid text and cannot be saved as complete review evidence."
        : error instanceof Error
          ? error.message
          : "Could not save the result. Retry saving.";
const permanent = (error: unknown) =>
  isSaveError(error)
    ? error.permanent
    : isOutputLimit(error) ||
      (isOutputRead(error) && error.reason !== undefined) ||
      (isRestricted(error) && error.reason === "contains_secret") ||
      isMissingPin(error);

/** A parked storage worker never holds the runner's control mutex. */
export function makeWorkflowResultPublisher(
  sql: SqlClient.SqlClient,
  transport: WorkflowResultTransport,
  uploads: Pick<ThreadCheckpointTransport, "upload">,
  dependencies: {
    synchronize: (
      threadId: string,
    ) => Effect.Effect<
      void,
      ThreadHistorySyncError | ThreadCheckpointPublishError,
      FileSystem.FileSystem | Path.Path
    >;
  },
  root: string,
) {
  const outbox = makeWorkflowResultOutbox(sql);
  const fences = makeThreadExecutionFence(sql);
  const lock = Semaphore.makeUnsafe(1);
  const attempt = Effect.fn("WorkflowResultPublisher.attempt")(function* (
    intent: WorkflowSaveIntent,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binding = yield* decodeWorkflowSaveBinding(intent.bindingJson);
    const owner = yield* fences.get(intent.threadId);
    if (
      !owner ||
      owner.phase === "retired" ||
      owner.environmentId !== binding.environmentId ||
      owner.generation !== binding.generation
    )
      return yield* fail("The saved result no longer belongs to this VM.", true);
    const capture = intent.resultJson
      ? yield* decodeWorkflowResultCapture(intent.resultJson)
      : null;
    let manifest = intent.manifestJson ? yield* decodeManifest(intent.manifestJson) : null;
    const directory = path.join(root, intent.publicationId);
    const stage = (value: string) =>
      sql`UPDATE workflow_result_outbox SET stage=${value} WHERE publication_id=${intent.publicationId}`;
    if (!manifest) {
      yield* stage("publishing the conversation and attachments");
      yield* dependencies
        .synchronize(intent.threadId)
        .pipe(Effect.mapError(() => fail("Could not publish the conversation or attachments.")));
      yield* stage("waiting for mirrored conversation history");
      const [cursor] = yield* sql<{
        sequence: number;
      }>`SELECT source_sequence AS sequence FROM thread_relay_history_cursors WHERE thread_id=${intent.threadId} AND generation=${binding.generation}`;
      if ((cursor?.sequence ?? 0) < intent.sourceSequence) return;
      let nativeOperationId: string | null = null;
      let sourceSequence = intent.sourceSequence;
      if (capture) {
        yield* stage("waiting for the exact native checkpoint");
        const [point] = yield* sql<{
          environmentId: string;
          sourceSequence: number;
          manifestSha256: string;
          archiveSha256: string;
          nativePublished: string | null;
          attachmentsPublished: string | null;
        }>`SELECT n.environment_id AS "environmentId",n.source_sequence AS "sourceSequence",n.manifest_sha256 AS "manifestSha256",n.archive_sha256 AS "archiveSha256",n.published_artifact_id AS "nativePublished",a.published_artifact_id AS "attachmentsPublished"
          FROM thread_native_checkpoints n JOIN thread_attachment_checkpoints a ON a.thread_id=n.thread_id AND a.generation=n.generation AND a.checkpoint_id=n.checkpoint_id
          WHERE n.thread_id=${intent.threadId} AND n.generation=${binding.generation} AND n.turn_id=${capture.turnId} AND n.capture_operation_id IS NULL`;
        if (!point?.nativePublished || !point.attachmentsPublished) return;
        nativeOperationId = checkpointPublicationOperationId(
          "launchpad-native-checkpoint-v1",
          intent.threadId,
          binding.generation,
          capture.turnId,
          point,
        );
        sourceSequence = Math.max(sourceSequence, point.sourceSequence);
      } else {
        const [previous] = yield* sql<{
          nativeOperationId: string | null;
        }>`SELECT native_operation_id AS "nativeOperationId" FROM workflow_result_outbox WHERE job_id=${intent.jobId} AND status='acknowledged' AND revision<${intent.revision} ORDER BY revision DESC LIMIT 1`;
        nativeOperationId = previous?.nativeOperationId ?? null;
      }
      yield* stage("waiting for mirrored conversation history");
      if ((cursor?.sequence ?? 0) < sourceSequence) return;
      if (nativeOperationId)
        yield* transport.reserve(owner, {
          publicationId: intent.publicationId,
          nativeCheckpointOperationId: nativeOperationId,
        });
      yield* stage("materializing the saved result");
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const materialize = Effect.fnUntraced(function* (artifactId: string, text: string) {
        const bytes = new TextEncoder().encode(text);
        const file = path.join(directory, artifactId);
        yield* fs.writeFile(file, bytes, { mode: 0o600 });
        return {
          artifactId,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        };
      });
      if (new TextEncoder().encode(intent.recordJson).length > 2_000_000)
        return yield* fail("The workflow recovery record exceeds its storage limit.", true);
      const state = yield* materialize(intent.stateArtifactId, intent.recordJson);
      let result: WorkflowRecoveryManifest["result"] = null;
      if (capture) {
        const query = yield* CheckpointDiffQuery;
        const patch =
          capture.outcome === "completed"
            ? yield* query
                .getTurnDiff({
                  threadId: ThreadId.make(intent.threadId),
                  fromTurnCount: capture.turnCount - 1,
                  toTurnCount: capture.turnCount,
                  ignoreWhitespace: false,
                  strictWorkflowReview: true,
                  expectedTurnId: TurnId.make(capture.turnId),
                })
                .pipe(
                  Effect.flatMap((diff) =>
                    diff.completeWorkflowReview && diff.targetTurnId === capture.turnId
                      ? Effect.succeed(diff.diff)
                      : fail("The captured diff is incomplete.", true),
                  ),
                )
            : yield* query.getSavedWorkflowCaptureDiff(binding, capture);
        if (new TextEncoder().encode(patch).length > WORKFLOW_RESULT_MAX_BYTES)
          return yield* fail("This patch exceeds the 10 MB saved-result limit.", true);
        result = { ...capture, patch: yield* materialize(intent.patchArtifactId, patch) };
      }
      manifest = {
        format: "workflow-recovery-v1",
        publicationId: intent.publicationId,
        binding,
        revision: intent.revision,
        state,
        sourceSequence,
        nativeCheckpointOperationId: nativeOperationId,
        result,
      };
      const encoded = encodeManifest(manifest);
      yield* materialize(intent.manifestArtifactId, encoded);
      yield* flushThreadArtifactTree(directory);
      yield* sql`UPDATE workflow_result_outbox SET manifest_json=${encoded},native_operation_id=${nativeOperationId} WHERE publication_id=${intent.publicationId} AND manifest_json IS NULL`;
    }
    const encoded = encodeManifest(manifest);
    const manifestBytes = new TextEncoder().encode(encoded);
    const descriptor = {
      artifactId: intent.manifestArtifactId,
      sha256: NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex"),
      sizeBytes: manifestBytes.length,
    };
    const acknowledge = Effect.fnUntraced(function* (receipt: WorkflowSaveReceipt) {
      if (
        !Schema.toEquivalence(WorkflowSaveReceipt)(receipt, {
          publicationId: intent.publicationId,
          jobId: intent.jobId,
          threadId: ThreadId.make(intent.threadId),
          revision: intent.revision,
          manifest: descriptor,
          binding,
          resultId: manifest.result?.resultId ?? null,
        })
      )
        return yield* fail("The save acknowledgement does not match this result.", true);
      yield* sql`UPDATE workflow_result_outbox SET status='acknowledged',detail=NULL WHERE publication_id=${intent.publicationId}`;
      yield* fs.remove(directory, { recursive: true, force: true });
    });
    if (intent.manifestJson) {
      // A reply may have been lost after the relay committed. Reconcile the same
      // immutable publication before requiring local files or transferring again.
      const prior = yield* transport
        .publish(owner, {
          publicationId: intent.publicationId,
          manifestArtifactId: intent.manifestArtifactId,
        })
        .pipe(Effect.timeout("15 seconds"), Effect.result);
      if (prior._tag === "Success") return yield* acknowledge(prior.success);
    }
    yield* stage("uploading the saved result");
    for (const object of [
      { ...manifest.state, kind: "history" as const },
      ...(manifest.result ? [{ ...manifest.result.patch, kind: "workspace" as const }] : []),
      { ...descriptor, kind: "manifest" as const },
    ]) {
      const receipt = yield* uploads.upload(
        owner,
        { ...object, operationId: intent.publicationId },
        fs.stream(path.join(directory, object.artifactId)),
      );
      if (
        receipt.artifactId !== object.artifactId ||
        receipt.operationId !== intent.publicationId ||
        receipt.threadId !== intent.threadId ||
        receipt.sha256 !== object.sha256 ||
        receipt.sizeBytes !== object.sizeBytes ||
        receipt.kind !== object.kind ||
        receipt.state !== "complete"
      )
        return yield* fail("The upload receipt does not match this result.", true);
    }
    yield* stage("waiting for the relay acknowledgement");
    const receipt = yield* transport.publish(owner, {
      publicationId: intent.publicationId,
      manifestArtifactId: intent.manifestArtifactId,
    });
    yield* acknowledge(receipt);
  });
  const synchronize = Effect.fn("WorkflowResultPublisher.synchronize")(function* (
    threadId: string,
  ) {
    yield* outbox.expire(threadId);
    const intent = yield* outbox.next(threadId);
    const now = yield* Clock.currentTimeMillis;
    if (!intent || intent.status !== "pending" || intent.retryAt > now) return;
    yield* attempt(intent).pipe(
      lock.withPermit,
      Effect.timeout(intent.deadline - now),
      Effect.catch((error) => outbox.fail(intent, describe(error), permanent(error))),
    );
    yield* outbox.expire(threadId);
  });
  return { synchronize };
}
