import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, type RelayThreadDeletionRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeThreadDeletionStore, type ThreadDeletion } from "../threads/ThreadDeletionStore.ts";
import { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";
import { relayInternalErrorResponse } from "./Api.ts";
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
    const allowUncertainCaptureCleanup = yield* sql.withTransaction(
      Effect.gen(function* () {
        // A duplicate may have admitted its tombstone before this preflight.
        // Read both under the same lock; the write transaction below validates its owner and intent.
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${threadId} FOR UPDATE`;
        if (yield* store.get(threadId)) return false;
        return yield* withPrivateThreadAccess(threadId, "read", () =>
          store.needsUncertainCaptureCleanup(threadId),
        );
      }),
    );
    if (allowUncertainCaptureCleanup)
      yield* makeE2BRestoreClient(settings.compute).requireExecutionRetention();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${threadId} FOR UPDATE`;
        const prior = yield* store.get(threadId);
        if (prior) {
          if (prior.ownerUserId !== userId) return yield* tenancyNotFound("thread_not_found");
          if (
            prior.operationId !== input.operationId ||
            prior.generation !== input.expectedGeneration
          )
            return yield* tenancyConflict("thread_placement_changed");
          return serialize(prior);
        }
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          store
            .begin({
              threadId,
              operationId: input.operationId,
              ownerUserId: userId,
              generation: input.expectedGeneration,
              hostId: settings.hostId,
              allowUncertainCaptureCleanup,
            })
            .pipe(Effect.map(serialize)),
        );
      }),
    );
  },
  Effect.catchTags({
    ThreadDeletionConflict: () => tenancyConflict("thread_deletion_conflict"),
    E2BRestoreError: () => relayInternalErrorResponse("upstream_unavailable"),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
/** A requester may observe the cleanup receipt after audience/repository revocation.
 * This contains no retained conversation, artifact or environment credential. */
export const getThreadDeletion = Effect.fn("relay.api.thread.deletion_status")(
  function* (threadId: string) {
    const { userId } = yield* RelayClientPrincipal,
      row = yield* makeThreadDeletionStore((yield* RelayDb).$client).get(threadId);
    if (!row || row.ownerUserId !== userId) return yield* tenancyNotFound("thread_not_found");
    return serialize(row);
  },
  Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
);
