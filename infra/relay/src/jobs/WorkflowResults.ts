import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  WorkflowRecoveryManifest,
  WorkflowSaveReceipt,
  WorkflowSavedResult,
} from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeThreadArtifactStore } from "../threads/ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "../threads/ThreadArtifactTransfer.ts";
import type { makeThreadArtifactObjects } from "../threads/ThreadArtifactObjects.ts";
import {
  makeThreadNativeCheckpointStore,
  releaseThreadNativeCheckpointOperation,
} from "../threads/ThreadNativeCheckpointStore.ts";

export class WorkflowResultConflict extends Schema.TaggedError<WorkflowResultConflict>()(
  "WorkflowResultConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new WorkflowResultConflict({ message });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRecoveryManifest));
const decodeReceipt = Schema.decodeUnknownEffect(WorkflowSaveReceipt);
const decodeResult = Schema.decodeUnknownEffect(WorkflowSavedResult);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(WorkflowRecoveryManifest));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(WorkflowSavedResult));

/** Bytes are verified outside writer locks; visibility and permanent pins commit together. */
export function makeWorkflowResults(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const artifacts = makeThreadArtifactStore(sql);
  const transfer = makeThreadArtifactTransfer(sql, objects);
  const native = makeThreadNativeCheckpointStore(sql, objects);
  const withObject = <A, E, R>(
    threadId: string,
    artifactId: string,
    maxBytes: number,
    use: (
      text: string,
      artifact: NonNullable<Effect.Success<ReturnType<typeof artifacts.get>>>,
    ) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const artifact = yield* artifacts.get(artifactId);
      if (
        !artifact ||
        artifact.threadId !== threadId ||
        artifact.state !== "complete" ||
        artifact.sizeBytes > maxBytes
      )
        return yield* conflict("The saved result object is unavailable or exceeds its limit.");
      const lease = {
        threadId,
        artifactId,
        operationId: yield* (yield* Crypto.Crypto).randomUUIDv4,
      };
      return yield* Effect.acquireUseRelease(
        transfer.readPinned(lease),
        (stream) =>
          Effect.gen(function* () {
            const bytes = new Uint8Array(artifact.sizeBytes);
            let offset = 0;
            yield* Stream.runForEach(stream, (chunk) =>
              Effect.gen(function* () {
                if (offset + chunk.length > bytes.length)
                  return yield* conflict("The saved object changed size.");
                bytes.set(chunk, offset);
                offset += chunk.length;
              }),
            );
            if (offset !== bytes.length) return yield* conflict("The saved object is incomplete.");
            const text = yield* Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              catch: () => conflict("The saved object is not UTF-8."),
            });
            return yield* use(text, artifact);
          }),
        () => artifacts.releasePin(lease).pipe(Effect.ignore),
      );
    });
  const reserve = Effect.fn("relay.workflow_result.reserve")(function* (input: {
    threadId: string;
    environmentId: string;
    generation: number;
    publicationId: string;
    nativeCheckpointOperationId: string;
  }) {
    const point = yield* native.get(input.nativeCheckpointOperationId);
    if (
      !point ||
      point.threadId !== input.threadId ||
      point.sourceEnvironmentId !== input.environmentId ||
      point.generation !== input.generation
    )
      return yield* conflict("The native checkpoint is unavailable.");
    yield* native.pinCompleteForOperation({
      threadId: input.threadId,
      operationId: input.publicationId,
      checkpointOperationId: point.operationId,
      expected: point,
    });
  });
  const publish = Effect.fn("relay.workflow_result.publish")(function* <E, R>(
    input: {
      threadId: string;
      publicationId: string;
      manifestArtifactId: string;
    },
    authorize: (manifest: WorkflowRecoveryManifest) => Effect.Effect<void, E, R>,
  ) {
    return yield* withObject(
      input.threadId,
      input.manifestArtifactId,
      2_000_000,
      (text, artifact) =>
        Effect.gen(function* () {
          const manifest = yield* decodeManifest(text);
          const { binding } = manifest;
          if (
            manifest.publicationId !== input.publicationId ||
            binding.threadId !== input.threadId ||
            artifact.operationId !== input.publicationId ||
            artifact.kind !== "manifest"
          )
            return yield* conflict("Publication and manifest identities disagree.");
          const verifyObject = (reference: typeof manifest.state, kind: string, max: number) =>
            Effect.gen(function* () {
              const lease = {
                threadId: input.threadId,
                artifactId: reference.artifactId,
                operationId: yield* (yield* Crypto.Crypto).randomUUIDv4,
              };
              // Hold this lease until the entire publication has installed permanent pins.
              yield* Effect.acquireRelease(artifacts.pin({ ...lease, leaseMinutes: 60 }), () =>
                artifacts.releasePin(lease).pipe(Effect.ignore),
              );
              yield* withObject(input.threadId, reference.artifactId, max, (_text, item) =>
                item.sha256 === reference.sha256 &&
                item.sizeBytes === reference.sizeBytes &&
                item.kind === kind &&
                item.operationId === input.publicationId
                  ? Effect.void
                  : Effect.fail(conflict("The result object descriptor disagrees with its bytes.")),
              );
            });
          yield* verifyObject(manifest.state, "history", 2_000_000);
          if (manifest.result) yield* verifyObject(manifest.result.patch, "workspace", 10_000_000);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              // All shared result, retirement and deletion writers acquire job before placement.
              yield* sql`SELECT job_id FROM relay_workflow_jobs WHERE job_id=${binding.jobId} FOR UPDATE`;
              yield* authorize(manifest);
              const [prior] = yield* sql<{
                manifest: WorkflowRecoveryManifest;
                manifestArtifactId: string;
                manifestSha256: string;
                manifestSizeBytes: number;
              }>`SELECT manifest,manifest_artifact_id AS "manifestArtifactId",manifest_sha256 AS "manifestSha256",manifest_size_bytes AS "manifestSizeBytes" FROM relay_workflow_recovery_records WHERE job_id=${binding.jobId} AND revision=${manifest.revision}`;
              const receipt = yield* decodeReceipt({
                publicationId: manifest.publicationId,
                jobId: binding.jobId,
                threadId: binding.threadId,
                revision: manifest.revision,
                manifest: {
                  artifactId: artifact.artifactId,
                  sha256: artifact.sha256,
                  sizeBytes: artifact.sizeBytes,
                },
                binding,
                resultId: manifest.result?.resultId ?? null,
              });
              if (prior) {
                if (
                  encodeManifest(prior.manifest) !== encodeManifest(manifest) ||
                  prior.manifestArtifactId !== artifact.artifactId ||
                  prior.manifestSha256 !== artifact.sha256 ||
                  prior.manifestSizeBytes !== artifact.sizeBytes
                )
                  return yield* conflict(
                    "A recovery revision cannot change its immutable contents.",
                  );
                return receipt;
              }
              const [head] = yield* sql<{
                publicationId: string;
                revision: number;
              }>`SELECT publication_id AS "publicationId",revision FROM relay_workflow_recovery_heads WHERE job_id=${binding.jobId}`;
              if (head && head.revision >= manifest.revision)
                return yield* conflict("This recovery revision is obsolete.");
              const [watermark] = yield* sql<{
                sequence: number;
              }>`SELECT source_sequence AS sequence FROM relay_thread_history_watermarks WHERE thread_id=${binding.threadId} AND environment_id=${binding.environmentId} AND generation=${binding.generation}`;
              if ((watermark?.sequence ?? 0) < manifest.sourceSequence)
                return yield* conflict("The conversation is not fully mirrored.");
              if (manifest.nativeCheckpointOperationId) {
                const point = yield* native.getForOperation({
                  threadId: binding.threadId,
                  operationId: manifest.publicationId,
                });
                if (
                  !point ||
                  point.operationId !== manifest.nativeCheckpointOperationId ||
                  point.sourceEnvironmentId !== binding.environmentId ||
                  point.generation !== binding.generation ||
                  point.sourceSequence > manifest.sourceSequence ||
                  (manifest.result && point.turnId !== manifest.result.turnId)
                )
                  return yield* conflict(
                    "The saved result does not own its exact complete native checkpoint.",
                  );
              } else if (manifest.result)
                return yield* conflict("An Agent result requires a native checkpoint.");
              const pin = (artifactId: string, operationId: string) =>
                artifacts.pin({ threadId: binding.threadId, artifactId, operationId });
              yield* pin(artifact.artifactId, `workflow-record:${manifest.publicationId}`);
              yield* pin(manifest.state.artifactId, `workflow-record:${manifest.publicationId}`);
              if (manifest.result) {
                const result = manifest.result;
                const [old] = yield* sql<{
                  result: WorkflowSavedResult;
                }>`SELECT result FROM relay_workflow_saved_results WHERE job_id=${binding.jobId} AND turn_id=${result.turnId}`;
                if (old && encodeResult(old.result) !== encodeResult(result))
                  return yield* conflict("An Agent result cannot change after capture.");
                yield* sql`INSERT INTO relay_workflow_saved_results(result_id,job_id,thread_id,turn_id,revision,result,native_checkpoint_operation_id) VALUES(${result.resultId},${binding.jobId},${binding.threadId},${result.turnId},${manifest.revision},${sql.json(result)},${manifest.nativeCheckpointOperationId!}) ON CONFLICT(job_id,turn_id) DO NOTHING`;
                yield* pin(result.patch.artifactId, `workflow-result:${result.resultId}`);
                // Retain chat files independently of the provider archive and its rotation.
                yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id)
            SELECT a.artifact_id,${`workflow-result:${result.resultId}`} FROM relay_thread_artifacts a
            JOIN relay_thread_attachment_checkpoints c ON c.operation_id=a.operation_id
            WHERE c.native_checkpoint_operation_id=${manifest.nativeCheckpointOperationId} AND a.thread_id=${binding.threadId} AND a.state='complete'
            ON CONFLICT(artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
              }
              yield* sql`INSERT INTO relay_workflow_recovery_records(publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest) VALUES(${manifest.publicationId},${binding.jobId},${binding.threadId},${manifest.revision},${artifact.artifactId},${artifact.sha256},${artifact.sizeBytes},${sql.json(manifest)})`;
              yield* sql`INSERT INTO relay_workflow_recovery_heads(job_id,publication_id,revision) VALUES(${binding.jobId},${manifest.publicationId},${manifest.revision}) ON CONFLICT(job_id) DO UPDATE SET publication_id=EXCLUDED.publication_id,revision=EXCLUDED.revision`;
              if (head) {
                const previous = yield* native.getForOperation({
                  threadId: binding.threadId,
                  operationId: head.publicationId,
                });
                if (previous)
                  yield* releaseThreadNativeCheckpointOperation(sql, {
                    threadId: binding.threadId,
                    operationId: head.publicationId,
                  });
              }
              return receipt;
            }),
          );
        }),
    ).pipe(Effect.scoped);
  });
  const list = Effect.fn("relay.workflow_result.list")(function* (jobId: string, before?: number) {
    const rows = yield* sql<{
      result: unknown;
      revision: number;
    }>`SELECT result,revision FROM relay_workflow_saved_results WHERE job_id=${jobId} AND (${before ?? null}::int IS NULL OR revision<${before ?? null}) ORDER BY revision DESC LIMIT 51`;
    const page = rows.slice(0, 50);
    return {
      results: yield* Effect.forEach(page, (row) => decodeResult(row.result)),
      nextCursor: rows.length > 50 ? page.at(-1)!.revision : null,
    };
  });
  const read = Effect.fn("relay.workflow_result.read")(function* (jobId: string, resultId: string) {
    const [row] = yield* sql<{
      threadId: string;
      result: unknown;
    }>`SELECT thread_id AS "threadId",result FROM relay_workflow_saved_results WHERE job_id=${jobId} AND result_id=${resultId}`;
    if (!row) return yield* conflict("The saved result is unavailable.");
    const result = yield* decodeResult(row.result);
    return yield* withObject(
      row.threadId,
      result.patch.artifactId,
      10_000_000,
      (patch, artifact) =>
        artifact.sha256 === result.patch.sha256 && artifact.sizeBytes === result.patch.sizeBytes
          ? Effect.succeed({ result, patch })
          : Effect.fail(conflict("The saved patch digest changed.")),
    );
  });
  return { reserve, publish, list, read };
}
