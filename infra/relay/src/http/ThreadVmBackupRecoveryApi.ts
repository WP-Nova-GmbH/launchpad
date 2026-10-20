import { ThreadId } from "@t3tools/contracts";
import {
  RelayClientPrincipal,
  type RelayThreadVmBackupRecoveryRequest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadVmBackupRecoveryStore } from "../threads/ThreadVmBackupRecoveryStore.ts";
import { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import { makeThreadVmRestoreStore } from "../threads/ThreadVmRestoreStore.ts";
import {
  serializeBackupRecovery,
  serializeThreadVmRestore,
} from "./ThreadVmRestoreSerialization.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict } from "./tenancyErrors.ts";

const errors = {
  ThreadVmBackupRecoveryConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmBackupConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};

export const getThreadVmBackupRecovery = Effect.fn("relay.api.thread_vm.backup_recovery")(
  function* (threadId: string) {
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* withPrivateThreadAccess(threadId, "read", () =>
      makeThreadVmBackupRecoveryStore(sql, objects)
        .candidate(threadId)
        .pipe(
          Effect.map((candidate) =>
            candidate ? { ...candidate, threadId: ThreadId.make(candidate.threadId) } : null,
          ),
        ),
    );
  },
  Effect.catchTags({
    ThreadVmBackupRecoveryConflict: errors.ThreadVmBackupRecoveryConflict,
    SchemaError: errors.SchemaError,
  }),
);

export const restoreThreadVmBackup = Effect.fn("relay.api.thread_vm.restore_backup")(
  function* (threadId: string, input: RelayThreadVmBackupRecoveryRequest) {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings?.restoreEnabled) return yield* relayInternalErrorResponse("upstream_unavailable");
    const { userId } = yield* RelayClientPrincipal,
      sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    yield* withPrivateThreadAccess(threadId, "read", () => Effect.void);
    yield* makeE2BRestoreClient(settings.compute).requireExecutionRetention();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},721864))`;
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.allocationId},721865))`;
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          Effect.gen(function* () {
            const row = yield* makeThreadVmBackupRecoveryStore(sql, objects).begin({
              ...input,
              threadId,
              actorUserId: userId,
            });
            // A lost admission reply can be retried after the cold restore has advanced.
            const restore = yield* makeThreadVmRestoreStore(sql, objects).get(row.operationId);
            if (
              restore &&
              (restore.backupRecoveryOperationId !== row.operationId ||
                restore.threadId !== row.threadId ||
                restore.allocationId !== row.allocationId ||
                restore.generation !== row.generation)
            )
              return yield* tenancyConflict("thread_checkpoint_conflict");
            return {
              status: "accepted" as const,
              restore: restore ? serializeThreadVmRestore(restore) : serializeBackupRecovery(row),
            };
          }),
        );
      }),
    );
  },
  Effect.catchTags({
    ThreadVmBackupRecoveryConflict: errors.ThreadVmBackupRecoveryConflict,
    ThreadNativeCheckpointConflict: errors.ThreadNativeCheckpointConflict,
    ThreadVmBackupConflict: errors.ThreadVmBackupConflict,
    E2BRestoreError: () => relayInternalErrorResponse("upstream_unavailable"),
    SqlError: errors.SqlError,
    SchemaError: errors.SchemaError,
  }),
);

export const cancelThreadVmBackupRecovery = Effect.fn("relay.api.thread_vm.cancel_backup_recovery")(
  function* (threadId: string, input: RelayThreadVmBackupRecoveryRequest) {
    const { userId } = yield* RelayClientPrincipal,
      sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},721864))`;
        return yield* withPrivateThreadAccess(threadId, "write", () =>
          makeThreadVmBackupRecoveryStore(sql, objects)
            .cancelIntent({ ...input, threadId, actorUserId: userId })
            .pipe(
              Effect.as({
                threadId: ThreadId.make(threadId),
                operationId: input.operationId,
                phase: "cancelled" as const,
              }),
            ),
        );
      }),
    );
  },
  Effect.catchTags({
    ThreadVmBackupRecoveryConflict: errors.ThreadVmBackupRecoveryConflict,
    ThreadNativeCheckpointConflict: errors.ThreadNativeCheckpointConflict,
    SqlError: errors.SqlError,
    SchemaError: errors.SchemaError,
  }),
);
