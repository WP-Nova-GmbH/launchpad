import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, type RelayThreadVmRestoreRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadVmReplacementCoordinator } from "../threads/ThreadVmReplacementCoordinator.ts";
import { serializeReplacement } from "./ThreadVmsApi.ts";
import { makeThreadVmReplacementStore } from "../threads/ThreadVmReplacementStore.ts";
import { makeThreadVmRestoreStore } from "../threads/ThreadVmRestoreStore.ts";
import { makeThreadVmBackupRecoveryStore } from "../threads/ThreadVmBackupRecoveryStore.ts";
import {
  serializeBackupRecovery,
  serializeThreadVmRestore,
} from "./ThreadVmRestoreSerialization.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";

const errors = {
  ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmBackupConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmRestoreConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmSavedDiskConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmAllocationConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};
export const restoreThreadVm = Effect.fn("relay.api.thread_vm.restore")(function* (
  threadId: string,
  input: RelayThreadVmRestoreRequest,
) {
  const { settings } = yield* ThreadVmRuntimeConfiguration;
  if (!settings?.restoreEnabled) return yield* relayInternalErrorResponse("upstream_unavailable");
  const { userId } = yield* RelayClientPrincipal,
    sql = (yield* RelayDb).$client,
    objects = yield* ThreadArtifactObjectStorage;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // Reserve uses this lock before placement. Do not invert it in the access wrapper.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},721864))`;
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          makeThreadVmRestoreStore(sql, objects)
            .begin({ ...input, threadId, actorUserId: userId, serving: true })
            .pipe(
              Effect.map((restore) => ({
                status: "accepted" as const,
                restore: serializeThreadVmRestore(restore),
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
                  const [source] = yield* sql<{
                    hostId: string;
                    templateId: string;
                  }>`SELECT s.host_id AS "hostId",a.template_id AS "templateId" FROM relay_thread_vm_saved_disks s JOIN relay_thread_vm_backups b ON b.operation_id=s.backup_operation_id JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id WHERE s.operation_id=${input.savedDiskOperationId} AND s.thread_id=${threadId}`;
                  if (!source) return yield* tenancyNotFound("thread_not_found");
                  return yield* makeThreadVmReplacementCoordinator(sql, objects).record({
                    requestId: input.operationId,
                    threadId,
                    organizationId: placement.organizationId,
                    repositoryId: placement.repositoryId,
                    ownerUserId: userId,
                    hostId: source.hostId,
                    templateId: source.templateId,
                    intent: {
                      kind: "restore",
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
          const suggestedReplacement = yield* makeThreadVmReplacementStore(sql).suggest(userId);
          return {
            status: "quota_reached" as const,
            maxVms: error.maxVms,
            reservedVms: error.reservedVms,
            replacement: serializeReplacement(replacement),
            suggestedReplacement: suggestedReplacement
              ? {
                  allocationId: suggestedReplacement.allocationId,
                  threadId: ThreadId.make(suggestedReplacement.threadId),
                  state: suggestedReplacement.state,
                }
              : null,
          };
        }),
      ),
    );
}, Effect.catchTags(errors));
export const getThreadVmRestore = Effect.fn("relay.api.thread_vm.restore_status")(function* (
  threadId: string,
  operationId: string,
) {
  const sql = (yield* RelayDb).$client,
    objects = yield* ThreadArtifactObjectStorage;
  return yield* withPrivateThreadAccess(threadId, "read", () =>
    Effect.gen(function* () {
      const restore = yield* makeThreadVmRestoreStore(sql, objects).get(operationId);
      if (!restore) {
        const recovery = yield* makeThreadVmBackupRecoveryStore(sql, objects).get(operationId);
        if (recovery?.threadId === threadId) return serializeBackupRecovery(recovery);
      }
      if (!restore || restore.threadId !== threadId)
        return yield* tenancyNotFound("thread_not_found");
      return serializeThreadVmRestore(restore);
    }),
  );
});
export const cancelThreadVmRestore = Effect.fn("relay.api.thread_vm.cancel_restore")(
  function* (threadId: string, operationId: string) {
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* withPrivateThreadAccess(threadId, "write", () =>
      Effect.gen(function* () {
        const restores = makeThreadVmRestoreStore(sql, objects),
          restore = yield* restores.get(operationId);
        if (!restore) {
          const recoveries = makeThreadVmBackupRecoveryStore(sql, objects),
            recovery = yield* recoveries.get(operationId);
          if (recovery?.threadId === threadId)
            return serializeBackupRecovery(yield* recoveries.cancel(operationId));
        }
        if (!restore || restore.threadId !== threadId)
          return yield* tenancyNotFound("thread_not_found");
        return serializeThreadVmRestore(yield* restores.requestAbort(operationId));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmRestoreConflict: errors.ThreadVmRestoreConflict,
    ThreadVmBackupRecoveryConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: errors.ThreadNativeCheckpointConflict,
  }),
);
