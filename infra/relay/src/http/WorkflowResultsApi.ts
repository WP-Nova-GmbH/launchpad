import { ThreadId } from "@t3tools/contracts";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import { makeThreadAttachmentCheckpointStore } from "../threads/ThreadAttachmentCheckpointStore.ts";
import { openRetainedThreadAttachment } from "./ThreadHistoryApi.ts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { type WorkflowRecoveryManifest } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { requireWorkflowVmViewer, withWorkflowVmGuest } from "../jobs/WorkflowVmBinding.ts";
import { makeWorkflowResults } from "../jobs/WorkflowResults.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";

const errors = {
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
  SchemaError: () => tenancyConflict("thread_checkpoint_conflict"),
  WorkflowResultConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadArtifactConflict: () => tenancyConflict("thread_artifact_conflict"),
  ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
};
type Owner = { threadId: string; environmentId: string; generation: number };
export const reserveWorkflowResult = Effect.fn("relay.api.workflow_result.reserve")(
  function* (input: Owner & { publicationId: string; nativeCheckpointOperationId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    yield* withWorkflowVmGuest(input, "enrolled", () =>
      makeWorkflowResults(sql, objects).reserve(input),
    );
  },
  Effect.catchTags({
    SqlError: errors.SqlError,
    SchemaError: errors.SchemaError,
    WorkflowResultConflict: errors.WorkflowResultConflict,
    ThreadNativeCheckpointConflict: errors.ThreadNativeCheckpointConflict,
  }),
);
export const publishWorkflowResult = Effect.fn("relay.api.workflow_result.publish")(
  function* (input: Owner & { publicationId: string; manifestArtifactId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    yield* withWorkflowVmGuest(input, "enrolled", () => Effect.void);
    return yield* makeWorkflowResults(sql, objects).publish(
      input,
      (manifest: WorkflowRecoveryManifest) =>
        withWorkflowVmGuest(input, "enrolled", (resolved) => {
          const binding = resolved.binding;
          return Object.entries(binding).every(
            ([key, value]) => Reflect.get(manifest.binding, key) === value,
          )
            ? Effect.void
            : tenancyNotFound("thread_not_found");
        }),
    );
  },
  Effect.catchTags({
    ...errors,
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

/** Saved history belongs to the repository, independent of compute or its old writer. */
export const withSavedWorkflowThread = <A, E, R>(
  scope: { repositoryId: string; jobId: string },
  read: (thread: {
    threadId: string;
    organizationId: string;
    repositoryId: string;
    generation: number;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    const { userId } = yield* RelayClientPrincipal;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [thread] = yield* sql<{
          threadId: string;
          organizationId: string;
          repositoryId: string;
          generation: number;
        }>`
      SELECT t.thread_id AS "threadId",t.organization_id AS "organizationId",t.repository_id AS "repositoryId",t.generation
      FROM relay_thread_placements t JOIN relay_workflow_jobs j ON j.job_id=t.workflow_job_id
        AND j.repository_id=t.repository_id AND j.organization_id=t.organization_id
      JOIN relay_repositories r ON r.repository_id=t.repository_id AND r.organization_id=t.organization_id
      WHERE t.audience='repository' AND t.workflow_job_id=${scope.jobId} AND t.repository_id=${scope.repositoryId}
        AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
      FOR SHARE OF t,r`;
        if (!thread) return yield* tenancyNotFound("thread_not_found");
        yield* requireWorkflowVmViewer(sql, thread, userId);
        return yield* read(thread);
      }),
    );
  });
export const listSavedWorkflowResults = Effect.fn("relay.api.workflow_result.list")(
  function* (scope: { repositoryId: string; jobId: string; before?: number }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    return yield* withSavedWorkflowThread(scope, (thread) =>
      makeWorkflowResults(sql, objects)
        .list(scope.jobId, scope.before)
        .pipe(
          Effect.map((page) => ({
            ...page,
            threadId: ThreadId.make(thread.threadId),
            generation: thread.generation,
          })),
        ),
    );
  },
  Effect.catchTags({ SqlError: errors.SqlError, SchemaError: errors.SchemaError }),
);
export const readSavedWorkflowResult = Effect.fn("relay.api.workflow_result.read")(
  function* (scope: { repositoryId: string; jobId: string; resultId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    yield* withSavedWorkflowThread(scope, () => Effect.void);
    const result = yield* makeWorkflowResults(sql, objects).read(scope.jobId, scope.resultId);
    return yield* withSavedWorkflowThread(scope, () => Effect.succeed(result));
  },
  Effect.catchTags({
    SqlError: errors.SqlError,
    SchemaError: errors.SchemaError,
    WorkflowResultConflict: errors.WorkflowResultConflict,
    ThreadArtifactConflict: errors.ThreadArtifactConflict,
    ThreadArtifactObjectError: errors.ThreadArtifactObjectError,
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const getSavedWorkflowHistory = Effect.fn("relay.api.workflow_result.history")(
  function* (scope: {
    repositoryId: string;
    jobId: string;
    resultId: string;
    after: number;
    limit: number;
  }) {
    const sql = (yield* RelayDb).$client;
    return yield* withSavedWorkflowThread(scope, (thread) =>
      Effect.gen(function* () {
        const [point] = yield* sql<{ through: number | null }>`SELECT MAX(h.cursor)::int AS through
        FROM relay_workflow_saved_results r JOIN relay_thread_native_checkpoints n ON n.operation_id=r.native_checkpoint_operation_id
        JOIN relay_thread_history h ON h.thread_id=r.thread_id AND h.environment_id=n.source_environment_id AND h.source_sequence<=n.source_sequence
        WHERE r.job_id=${scope.jobId} AND r.thread_id=${thread.threadId} AND r.result_id=${scope.resultId}`;
        if (point?.through == null) return yield* tenancyNotFound("thread_not_found");
        return {
          entries: yield* makeThreadJournalStore(sql).history({
            threadId: thread.threadId,
            after: scope.after,
            limit: scope.limit,
            through: point.through,
          }),
        };
      }),
    );
  },
  Effect.catchTags({
    SqlError: errors.SqlError,
    ThreadPlacementConflict: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
export const getSavedWorkflowAttachment = Effect.fn("relay.api.workflow_result.attachment")(
  function* (scope: {
    repositoryId: string;
    jobId: string;
    resultId: string;
    attachmentId: string;
  }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    const saved = yield* withSavedWorkflowThread(scope, (thread) =>
      Effect.gen(function* () {
        const point = yield* makeThreadAttachmentCheckpointStore(sql, objects).getForResult({
          threadId: thread.threadId,
          resultId: scope.resultId,
        });
        if (!point) return yield* tenancyNotFound("thread_not_found");
        return { threadId: thread.threadId, point };
      }),
    );
    const stream = yield* openRetainedThreadAttachment(
      { threadId: saved.threadId, attachmentId: scope.attachmentId },
      saved.point,
    );
    return yield* withSavedWorkflowThread(scope, () => Effect.succeed(stream));
  },
  Effect.catchTags({
    SqlError: errors.SqlError,
    SchemaError: errors.SchemaError,
    ThreadArtifactConflict: errors.ThreadArtifactConflict,
    ThreadArtifactObjectError: errors.ThreadArtifactObjectError,
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
    TimeoutError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
