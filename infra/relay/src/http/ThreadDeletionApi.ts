import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, type RelayThreadDeletionRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeThreadDeletionStore, type ThreadDeletion } from "../threads/ThreadDeletionStore.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withSavedWorkflowThread } from "./WorkflowResultsApi.ts";
import { requireWorkflowVmMaintainer } from "../jobs/WorkflowVmBinding.ts";
const serialize = (row: ThreadDeletion) => ({
  threadId: ThreadId.make(row.threadId),
  operationId: row.operationId,
  generation: row.generation,
  phase: row.phase,
  errorCode: row.errorCode,
});
export const permanentlyDeleteThread = Effect.fn("relay.api.thread.permanently_delete")(
  function* (threadId: string, input: RelayThreadDeletionRequest) {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings?.permanentDeleteEnabled)
      return yield* relayInternalErrorResponse("upstream_unavailable");
    const { userId } = yield* RelayClientPrincipal,
      sql = (yield* RelayDb).$client,
      store = makeThreadDeletionStore(sql);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [hint] = yield* sql<{
          jobId: string | null;
          repositoryId: string;
        }>`SELECT workflow_job_id AS "jobId",repository_id AS "repositoryId" FROM relay_thread_placements WHERE thread_id=${threadId} AND audience='repository'`;
        if (hint?.jobId)
          yield* sql`SELECT job_id FROM relay_workflow_jobs WHERE job_id=${hint.jobId} FOR UPDATE`;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${threadId} FOR UPDATE`;
        const prior = yield* store.get(threadId);
        if (prior) {
          if (prior.requesterUserId !== userId) return yield* tenancyNotFound("thread_not_found");
          if (
            prior.operationId !== input.operationId ||
            prior.generation !== input.expectedGeneration
          )
            return yield* tenancyConflict("thread_placement_changed");
          return serialize(prior);
        }
        if (hint?.jobId) {
          const jobId = hint.jobId;
          return yield* withSavedWorkflowThread(
            { jobId, repositoryId: hint.repositoryId },
            (thread) =>
              Effect.gen(function* () {
                yield* requireWorkflowVmMaintainer(sql, thread, userId);
                return serialize(
                  yield* store.begin({
                    threadId,
                    operationId: input.operationId,
                    ownerUserId: null,
                    requesterUserId: userId,
                    generation: input.expectedGeneration,
                    hostId: settings.hostId,
                    workflow: {
                      jobId,
                      organizationId: thread.organizationId,
                      repositoryId: thread.repositoryId,
                    },
                  }),
                );
              }),
          );
        }
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          store
            .begin({
              threadId,
              operationId: input.operationId,
              ownerUserId: userId,
              generation: input.expectedGeneration,
              hostId: settings.hostId,
            })
            .pipe(Effect.map(serialize)),
        );
      }),
    );
  },
  Effect.catchTags({
    ThreadDeletionConflict: () => tenancyConflict("thread_deletion_conflict"),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
/** A requester may observe the cleanup receipt after audience/repository revocation.
 * This contains no retained conversation, artifact or environment credential. */
export const getThreadDeletion = Effect.fn("relay.api.thread.deletion_status")(
  function* (threadId: string) {
    const { userId } = yield* RelayClientPrincipal,
      row = yield* makeThreadDeletionStore((yield* RelayDb).$client).get(threadId);
    if (!row || row.requesterUserId !== userId) return yield* tenancyNotFound("thread_not_found");
    return serialize(row);
  },
  Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
);
