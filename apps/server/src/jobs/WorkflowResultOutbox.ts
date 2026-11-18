import * as NodeCrypto from "node:crypto";
import {
  type WorkflowRecoveryManifest,
  WorkflowVmDispatchBinding,
  WorkflowSavedResult,
  WorkflowResultSaving,
} from "@t3tools/contracts/workflows";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const WORKFLOW_SAVE_CYCLE_MS = 10 * 60_000;
const waitingForStorage = "waiting for storage";
const bindingCodec = Schema.fromJsonString(WorkflowVmDispatchBinding);
const resultCodec = Schema.fromJsonString(
  Schema.Struct({
    ...WorkflowSavedResult.fields,
    patch: Schema.optional(WorkflowSavedResult.fields.patch),
  }),
);
export type WorkflowResultCapture = typeof resultCodec.Type;
export interface WorkflowSaveIntent {
  publicationId: string;
  jobId: string;
  threadId: string;
  revision: number;
  bindingJson: string;
  recordJson: string;
  resultJson: string | null;
  sourceSequence: number;
  stateArtifactId: string;
  patchArtifactId: string;
  manifestArtifactId: string;
  nativeOperationId: string | null;
  manifestJson: string | null;
  status: "pending" | "failed" | "acknowledged";
  stage: string;
  startedAt: number;
  deadline: number;
  failures: number;
  retryAt: number;
  detail: string | null;
  permanent: number;
}
const columns = `publication_id AS "publicationId",job_id AS "jobId",thread_id AS "threadId",revision,binding_json AS "bindingJson",record_json AS "recordJson",result_json AS "resultJson",source_sequence AS "sourceSequence",state_artifact_id AS "stateArtifactId",patch_artifact_id AS "patchArtifactId",manifest_artifact_id AS "manifestArtifactId",native_operation_id AS "nativeOperationId",manifest_json AS "manifestJson",status,started_at AS "startedAt",deadline,failures,retry_at AS "retryAt",detail,stage,permanent`;
export const decodeWorkflowSaveBinding = Schema.decodeUnknownEffect(bindingCodec);
export const decodeWorkflowResultCapture = Schema.decodeUnknownEffect(resultCodec);

/** Durable retry metadata is separate from immutable run/result bytes. */
export function makeWorkflowResultOutbox(sql: SqlClient.SqlClient) {
  const unstarted = sql`stage=${waitingForStorage} AND failures=0 AND detail IS NULL
    AND manifest_json IS NULL AND native_operation_id IS NULL`;
  const next = (threadId: string) =>
    sql
      .unsafe<WorkflowSaveIntent>(
        `SELECT ${columns} FROM workflow_result_outbox WHERE thread_id=? AND status!='acknowledged' ORDER BY revision LIMIT 1`,
        [threadId],
      )
      .pipe(Effect.map(([row]) => row ?? null));
  const claim = Effect.fn("WorkflowResultOutbox.claim")(function* (threadId: string) {
    const now = yield* Clock.currentTimeMillis;
    const [claimed] = yield* sql<WorkflowSaveIntent>`UPDATE workflow_result_outbox SET
      started_at=CASE WHEN ${unstarted} THEN ${now} ELSE started_at END,
      deadline=CASE WHEN ${unstarted} THEN ${now + WORKFLOW_SAVE_CYCLE_MS} ELSE deadline END,
      stage=CASE WHEN ${unstarted} THEN 'starting save' ELSE stage END
      WHERE publication_id=(SELECT publication_id FROM workflow_result_outbox
        WHERE thread_id=${threadId} AND status!='acknowledged' ORDER BY revision LIMIT 1)
        AND status='pending' AND retry_at<=${now} AND ((${unstarted}) OR deadline>${now})
      RETURNING ${sql.literal(columns)}`;
    return claimed ?? null;
  });
  const enqueue = Effect.fn("WorkflowResultOutbox.enqueue")(function* (input: {
    binding: WorkflowVmDispatchBinding;
    recordJson: string;
    result?: WorkflowResultCapture;
    afterRestoredRevision?: number;
    latestRelayRevision?: number;
  }) {
    const { binding } = input;
    const [previous] = yield* sql<{
      recordJson: string;
      bindingJson: string;
      revision: number;
    }>`SELECT record_json AS "recordJson",binding_json AS "bindingJson",revision
      FROM workflow_result_outbox WHERE job_id=${binding.jobId} ORDER BY revision DESC LIMIT 1`;
    const captured =
      input.result &&
      !(yield* sql`SELECT 1 FROM workflow_result_outbox WHERE job_id=${binding.jobId} AND json_extract(result_json,'$.turnId')=${input.result.turnId}`)
        .length
        ? input.result
        : undefined;
    const bindingJson = yield* Schema.encodeEffect(bindingCodec)(binding);
    if (input.afterRestoredRevision !== undefined) {
      if (previous?.revision !== input.afterRestoredRevision) return;
    } else if (
      previous?.bindingJson === bindingJson &&
      previous.recordJson === input.recordJson &&
      !captured
    )
      return;
    const now = yield* Clock.currentTimeMillis;
    const [sequence] = yield* sql<{
      value: number;
    }>`SELECT COALESCE(MAX(sequence),0) AS value FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${binding.threadId}`;
    if (!captured && input.afterRestoredRevision === undefined && previous) {
      // Once the publisher claims the head, its state and artifacts stay immutable.
      const [coalesced] = yield* sql`UPDATE workflow_result_outbox SET
        record_json=${input.recordJson},source_sequence=${sequence?.value ?? 0}
        WHERE job_id=${binding.jobId} AND binding_json=${bindingJson}
          AND revision=${previous.revision} AND revision=(SELECT MAX(revision)
            FROM workflow_result_outbox WHERE job_id=${binding.jobId})
          AND status='pending' AND result_json IS NULL AND ${unstarted}
        RETURNING publication_id`;
      if (coalesced) return;
    }
    yield* sql`INSERT INTO workflow_result_outbox ${sql.insert({
      publication_id: NodeCrypto.randomUUID(),
      job_id: binding.jobId,
      thread_id: binding.threadId,
      revision: Math.max(previous?.revision ?? 0, input.latestRelayRevision ?? 0) + 1,
      binding_json: bindingJson,
      record_json: input.recordJson,
      result_json: captured ? yield* Schema.encodeEffect(resultCodec)(captured) : null,
      source_sequence: sequence?.value ?? 0,
      state_artifact_id: NodeCrypto.randomUUID(),
      patch_artifact_id: NodeCrypto.randomUUID(),
      manifest_artifact_id: NodeCrypto.randomUUID(),
      status: "pending",
      stage: waitingForStorage,
      started_at: 0,
      deadline: 0,
      retry_at: now,
    })}`;
  });
  const restore = Effect.fn("WorkflowResultOutbox.restore")(function* (input: {
    binding: WorkflowVmDispatchBinding;
    manifest: WorkflowRecoveryManifest;
    manifestArtifactId: string;
    recordJson: string;
    sourceSequence: number;
  }) {
    const { binding, manifest } = input;
    const bindingJson = yield* Schema.encodeEffect(bindingCodec)(binding);
    yield* sql`INSERT INTO workflow_result_outbox ${sql.insert({
      publication_id: manifest.publicationId,
      job_id: binding.jobId,
      thread_id: binding.threadId,
      revision: manifest.revision,
      binding_json: bindingJson,
      record_json: input.recordJson,
      source_sequence: input.sourceSequence,
      state_artifact_id: manifest.state.artifactId,
      patch_artifact_id: manifest.result?.patch.artifactId ?? NodeCrypto.randomUUID(),
      manifest_artifact_id: input.manifestArtifactId,
      status: "acknowledged",
      started_at: 0,
      deadline: 0,
      retry_at: 0,
    })} ON CONFLICT DO NOTHING`;
    const [installed] = yield* sql`SELECT 1 FROM workflow_result_outbox
      WHERE publication_id=${manifest.publicationId} AND job_id=${binding.jobId}
        AND thread_id=${binding.threadId} AND revision=${manifest.revision}
        AND binding_json=${bindingJson} AND record_json=${input.recordJson}
        AND source_sequence=${input.sourceSequence} AND state_artifact_id=${manifest.state.artifactId}
        AND manifest_artifact_id=${input.manifestArtifactId} AND status='acknowledged'`;
    return installed !== undefined;
  });
  const result = (jobId: string, turnId: string) =>
    sql<{
      publicationId: string;
      status: WorkflowSaveIntent["status"];
      detail: string | null;
      permanent: number;
      resultId: string;
    }>`SELECT publication_id AS "publicationId",status,detail,permanent,json_extract(result_json,'$.resultId') AS "resultId" FROM workflow_result_outbox WHERE job_id=${jobId} AND json_extract(result_json,'$.turnId')=${turnId} LIMIT 1`.pipe(
      Effect.map(([row]) => row ?? null),
    );
  const saving = (jobId: string) =>
    sql<{
      publicationId: string;
      status: WorkflowSaveIntent["status"];
      detail: string | null;
      permanent: number;
      resultId: string | null;
      stepId: string | null;
    }>`SELECT publication_id AS "publicationId",status,detail,permanent,
      json_extract(result_json,'$.resultId') AS "resultId",
      json_extract(result_json,'$.stepId') AS "stepId"
      FROM workflow_result_outbox WHERE job_id=${jobId} AND status!='acknowledged' ORDER BY revision LIMIT 1`.pipe(
      Effect.map(([row]): WorkflowResultSaving | undefined =>
        row
          ? {
              publicationId: row.publicationId,
              resultId: row.resultId,
              ...(row.stepId ? { stepId: row.stepId } : {}),
              state: row.status === "failed" ? "failed" : "saving",
              detail: row.detail,
              retryable: row.status === "failed" && !row.permanent,
            }
          : undefined,
      ),
    );
  const fail = Effect.fn("WorkflowResultOutbox.fail")(function* (
    intent: WorkflowSaveIntent,
    detail: string,
    permanent = false,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE workflow_result_outbox SET failures=failures+1,retry_at=${now + 5_000},detail=stage||': '||${detail},permanent=${permanent ? 1 : 0},status=CASE WHEN ${permanent} OR failures+1>=3 OR deadline<=${now} THEN 'failed' ELSE 'pending' END WHERE publication_id=${intent.publicationId} AND status='pending'`;
  });
  const expire = Effect.fn("WorkflowResultOutbox.expire")(function* (threadId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE workflow_result_outbox SET status='failed',detail='Saving timed out while '||stage||'. Retry saving to continue.'
      WHERE thread_id=${threadId} AND status='pending' AND NOT (${unstarted}) AND deadline<=${now}`;
  });
  const retry = Effect.fn("WorkflowResultOutbox.retry")(function* (
    jobId: string,
    publicationId: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return (
      (yield* sql`UPDATE workflow_result_outbox SET status='pending',failures=0,started_at=${now},deadline=${now + WORKFLOW_SAVE_CYCLE_MS},retry_at=${now},detail=NULL WHERE job_id=${jobId} AND publication_id=${publicationId} AND status='failed' AND permanent=0 RETURNING publication_id`)
        .length > 0
    );
  });
  return { next, claim, enqueue, restore, result, saving, fail, expire, retry };
}
