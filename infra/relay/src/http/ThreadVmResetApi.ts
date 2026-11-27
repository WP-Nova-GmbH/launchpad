import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, type RelayThreadVmResetRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadVmResetStore, type ThreadVmReset } from "../threads/ThreadVmResetStore.ts";
import { makeThreadVmReplacementCoordinator } from "../threads/ThreadVmReplacementCoordinator.ts";
import { serializeReplacement } from "./ThreadVmsApi.ts";
import { makeThreadVmReplacementStore } from "../threads/ThreadVmReplacementStore.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";

export const serializeThreadVmReset = (row: ThreadVmReset) => ({
  operationId: row.operationId,
  allocationId: row.allocationId,
  threadId: ThreadId.make(row.threadId),
  generation: row.expectedGeneration + 1,
  phase: row.phase,
  errorCode: row.errorCode,
});
const errors = {
  ThreadMoveCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmResetConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmProvisionConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmAllocationConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
  SchemaError: () => tenancyConflict("thread_checkpoint_conflict"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};
/** Reset is an explicit owner action after disk expiry, never an implicit send or wake. */
export const resetThreadVm = Effect.fn("relay.api.thread_vm.reset")(function* (
  threadId: string,
  input: RelayThreadVmResetRequest,
) {
  const { settings } = yield* ThreadVmRuntimeConfiguration;
  if (!settings?.resetEnabled) return yield* relayInternalErrorResponse("upstream_unavailable");
  const { userId } = yield* RelayClientPrincipal,
    sql = (yield* RelayDb).$client,
    objects = yield* ThreadArtifactObjectStorage;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // Quota writers lock user before placement; access must not invert that order.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},721864))`;
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          makeThreadVmResetStore(sql, objects)
            .begin({
              ...input,
              threadId,
              actorUserId: userId,
              hostId: settings.hostId,
              templateId: settings.compute.templateId,
            })
            .pipe(
              Effect.map((row) => ({
                status: "accepted" as const,
                reset: serializeThreadVmReset(row),
              })),
            ),
        );
      }),
    )
    .pipe(
      Effect.catchTag("ThreadVmQuotaExceeded", (error) =>
        Effect.gen(function* () {
          const replacement = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},721864))`;
              return yield* withPrivateThreadAccess(threadId, "write", (placement) =>
                Effect.gen(function* () {
                  return yield* makeThreadVmReplacementCoordinator(sql, objects).record({
                    requestId: input.operationId,
                    threadId,
                    organizationId: placement.organizationId,
                    repositoryId: placement.repositoryId,
                    ownerUserId: userId,
                    hostId: settings.hostId,
                    templateId: settings.compute.templateId,
                    intent: {
                      kind: "reset",
                      threadId,
                      actorUserId: userId,
                      sourceEnvironmentId: placement.environmentId,
                      request: input,
                    },
                  });
                }),
              );
            }),
          );
          const suggested = yield* makeThreadVmReplacementStore(sql).suggest(userId);
          return {
            status: "quota_reached" as const,
            maxVms: error.maxVms,
            reservedVms: error.reservedVms,
            replacement: serializeReplacement(replacement),
            suggestedReplacement: suggested
              ? {
                  allocationId: suggested.allocationId,
                  threadId: ThreadId.make(suggested.threadId),
                  state: suggested.state,
                }
              : null,
          };
        }),
      ),
    );
}, Effect.catchTags(errors));
export const getThreadVmReset = Effect.fn("relay.api.thread_vm.reset_status")(function* (
  threadId: string,
  operationId: string,
) {
  const sql = (yield* RelayDb).$client,
    objects = yield* ThreadArtifactObjectStorage;
  return yield* withPrivateThreadAccess(threadId, "read", () =>
    Effect.gen(function* () {
      const row = yield* makeThreadVmResetStore(sql, objects).get(operationId);
      if (!row || row.threadId !== threadId) return yield* tenancyNotFound("thread_not_found");
      return serializeThreadVmReset(row);
    }),
  );
});
export const cancelThreadVmReset = Effect.fn("relay.api.thread_vm.reset_cancel")(
  function* (threadId: string, operationId: string) {
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* withPrivateThreadAccess(threadId, "write", () =>
      Effect.gen(function* () {
        const resets = makeThreadVmResetStore(sql, objects),
          row = yield* resets.get(operationId);
        if (!row || row.threadId !== threadId) return yield* tenancyNotFound("thread_not_found");
        return serializeThreadVmReset(yield* resets.requestCancellation(operationId));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmResetConflict: errors.ThreadVmResetConflict,
    ThreadVmAllocationConflict: errors.ThreadVmAllocationConflict,
  }),
);
