import { openThreadVmPreview } from "./ThreadVmPreviewApi.ts";
import {
  getThreadVmBackupRecovery,
  restoreThreadVmBackup,
  cancelThreadVmBackupRecovery,
} from "./ThreadVmBackupRecoveryApi.ts";
import { threadVmProviderAuth } from "./ThreadVmProviderAuthApi.ts";
import {
  getThreadVmCodexAuthSource,
  selectThreadVmCodexAuthSource,
} from "./ThreadVmCodexAuthApi.ts";
import { permanentlyDeleteThread, getThreadDeletion } from "./ThreadDeletionApi.ts";
import { resetThreadVm, getThreadVmReset, cancelThreadVmReset } from "./ThreadVmResetApi.ts";
import {
  restoreThreadVm,
  getThreadVmRestore,
  cancelThreadVmRestore,
} from "./ThreadVmRestoreApi.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayOrganizationId,
  RelayRepositoryId,
  RelayClientPrincipal,
  type RelayThreadVmReplacement,
  type RelayThreadVmCreateRequest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { makeThreadVmSetupStore, type ThreadVmSetup } from "../threads/ThreadVmSetupStore.ts";
import { makeThreadVmCapacityStore } from "../threads/ThreadVmCapacityStore.ts";
import { makeThreadVmResumeStore } from "../threads/ThreadVmResumeStore.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import {
  makeThreadVmReplacementCoordinator,
  type ThreadVmReplacement,
} from "../threads/ThreadVmReplacementCoordinator.ts";
import { makeThreadVmReplacementStore } from "../threads/ThreadVmReplacementStore.ts";
import { makeThreadVmStatusStore } from "../threads/ThreadVmStatusStore.ts";
import { makeThreadVmAllocationStore } from "../threads/ThreadVmAllocationStore.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";

const serializeSetup = (setup: ThreadVmSetup) => ({
  ...setup,
  organizationId: RelayOrganizationId.make(setup.organizationId),
  repositoryId: RelayRepositoryId.make(setup.repositoryId),
  threadId: ThreadId.make(setup.threadId),
  environmentId: setup.environmentId === null ? null : EnvironmentId.make(setup.environmentId),
});
export const serializeReplacement = (request: ThreadVmReplacement) =>
  ({
    requestId: request.requestId,
    threadId: ThreadId.make(request.threadId),
    phase: request.phase,
    victimAllocationId: request.victimAllocationId,
    errorCode: request.errorCode,
  }) satisfies RelayThreadVmReplacement;
const mapReplacementErrors = {
  ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
  ThreadVmAllocationConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmProvisionConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
};

/** Compatibility endpoint: the first version admits VMs only through a thread move. */
export const createThreadVm = Effect.fn("relay.api.thread_vms.create")(function* (
  _input: RelayThreadVmCreateRequest,
) {
  return yield* tenancyConflict("thread_vm_move_required");
});

export const getThreadVmSetup = Effect.fn("relay.api.thread_vms.get_setup")(
  function* (threadId: string) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(threadId, "read", () =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ allocationId: string }>`SELECT s.allocation_id AS "allocationId"
      FROM relay_thread_vm_setups s JOIN relay_thread_vm_allocations a USING (allocation_id)
      WHERE a.thread_id = ${threadId} AND a.deleted_at IS NULL`;
        const setup = row ? yield* makeThreadVmSetupStore(sql).get(row.allocationId) : null;
        return setup ? serializeSetup(setup) : null;
      }),
    );
  },
  Effect.catchTag("ThreadVmSetupConflict", () => tenancyConflict("thread_placement_changed")),
);

/** Status uses retained database state and never contacts or wakes compute. */
export const getThreadVmStatus = Effect.fn("relay.api.thread_vms.get_status")(function* (
  threadId: string,
) {
  const sql = (yield* RelayDb).$client;
  return yield* withPrivateThreadAccess(threadId, "read", (placement) =>
    makeThreadVmStatusStore(sql).read(threadId, placement.generation),
  );
});

export const resumeThreadVm = Effect.fn("relay.api.thread_vms.resume")(
  function* (threadId: string) {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings) return yield* relayInternalErrorResponse("upstream_unavailable");
    const sql = (yield* RelayDb).$client;
    yield* makeThreadVmCapacityStore(sql).configure(settings.hostId, settings.maxRunningVms);
    return yield* withPrivateThreadAccess(threadId, "write", () =>
      makeThreadVmResumeStore(sql).request(threadId),
    );
  },
  Effect.catchTags({
    ThreadVmResumeConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

/** Cancelling an unactivated setup retains quota until its VM is physically gone. */
export const cancelInitialThreadVmSetup = Effect.fn("relay.api.thread_vms.cancel_setup")(
  function* (threadId: string) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(threadId, "write", () =>
      Effect.gen(function* () {
        const [setup] = yield* sql<{ allocationId: string; state: string }>`
          SELECT a.allocation_id AS "allocationId", a.state
          FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_setups s ON s.allocation_id = a.allocation_id
          JOIN relay_thread_placements t ON t.thread_id = a.thread_id
          WHERE t.thread_id = ${threadId} AND t.operation_id = a.allocation_id
            AND t.generation = 1 AND s.phase <> 'ready'
          FOR SHARE OF s`;
        if (!setup) return yield* tenancyConflict("thread_placement_changed");
        const allocation =
          setup.state === "deleted"
            ? null
            : yield* makeThreadVmAllocationStore(sql).requestDeletion(setup.allocationId);
        return {
          allocationId: setup.allocationId,
          status:
            allocation?.state === "deleting" ? ("pending_cleanup" as const) : ("deleted" as const),
        };
      }),
    );
  },
  Effect.catchTags({
    ThreadVmAllocationConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);

export const getThreadVmReplacement = Effect.fn("relay.api.thread_vms.get_replacement")(
  function* (requestId: string) {
    const { userId } = yield* RelayClientPrincipal;
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    const request = yield* makeThreadVmReplacementCoordinator(sql, objects).get(requestId);
    if (!request || request.ownerUserId !== userId)
      return yield* tenancyNotFound("thread_not_found");
    return serializeReplacement(request);
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);
/** Advisory choices are bounded and never contact compute. Selection revalidates under locks. */
export const getThreadVmReplacementCandidates = Effect.fn(
  "relay.api.thread_vms.replacement_candidates",
)(
  function* (requestId: string) {
    const { userId } = yield* RelayClientPrincipal;
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    const request = yield* makeThreadVmReplacementCoordinator(sql, objects).get(requestId);
    if (!request || request.ownerUserId !== userId)
      return yield* tenancyNotFound("thread_not_found");
    if (request.phase !== "awaiting_choice") return [];
    return (yield* makeThreadVmReplacementStore(sql).list(userId)).map((candidate) => ({
      ...candidate,
      threadId: ThreadId.make(candidate.threadId),
    }));
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);
export const selectThreadVmReplacement = Effect.fn("relay.api.thread_vms.select_replacement")(
  function* (input: { requestId: string; victimAllocationId: string }) {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings?.replacementEnabled || !settings.autoBackupEnabled)
      return yield* relayInternalErrorResponse("upstream_unavailable");
    const { userId } = yield* RelayClientPrincipal;
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return serializeReplacement(
      yield* makeThreadVmReplacementCoordinator(sql, objects).select({
        ...input,
        ownerUserId: userId,
      }),
    );
  },
  Effect.catchTags({
    ...mapReplacementErrors,
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmQuotaExceeded: () => tenancyConflict("thread_placement_changed"),
    ThreadVmFinalSaveConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmBackupConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadVmResetConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmRestoreConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmSavedDiskConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadMoveCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  }),
);
export const cancelThreadVmReplacement = Effect.fn("relay.api.thread_vms.cancel_replacement")(
  function* (requestId: string) {
    const { userId } = yield* RelayClientPrincipal;
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return serializeReplacement(
      yield* makeThreadVmReplacementCoordinator(sql, objects).cancel({
        requestId,
        ownerUserId: userId,
      }),
    );
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmFinalSaveConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);

export const threadVmsApi = HttpApiBuilder.group(RelayApi, "threadVms", (handlers) =>
  handlers
    .handle("getProviderAuthSource", ({ params }) => getThreadVmCodexAuthSource(params.threadId))
    .handle("selectProviderAuthSource", ({ params, payload }) =>
      selectThreadVmCodexAuthSource(params.threadId, payload),
    )
    .handle("getProviderAuth", ({ params }) => threadVmProviderAuth(params.threadId, "status"))
    .handle("startProviderAuth", ({ params, payload }) =>
      threadVmProviderAuth(params.threadId, "start", payload).pipe(
        Effect.flatMap((value) =>
          value ? Effect.succeed(value) : tenancyConflict("thread_placement_changed"),
        ),
      ),
    )
    .handle("cancelProviderAuth", ({ params, payload }) =>
      threadVmProviderAuth(params.threadId, "cancel", payload).pipe(
        Effect.flatMap((value) =>
          value ? Effect.succeed(value) : tenancyConflict("thread_placement_changed"),
        ),
      ),
    )
    .handle("openPreview", ({ params, payload }) =>
      openThreadVmPreview(params.threadId, payload.port),
    )
    .handle("permanentlyDelete", ({ params, payload }) =>
      permanentlyDeleteThread(params.threadId, payload),
    )
    .handle("getDeletion", ({ params }) => getThreadDeletion(params.threadId))
    .handle("reset", ({ params, payload }) => resetThreadVm(params.threadId, payload))
    .handle("getReset", ({ params }) => getThreadVmReset(params.threadId, params.operationId))
    .handle("cancelReset", ({ params }) => cancelThreadVmReset(params.threadId, params.operationId))
    .handle("restore", ({ params, payload }) => restoreThreadVm(params.threadId, payload))
    .handle("getBackupRecovery", ({ params }) => getThreadVmBackupRecovery(params.threadId))
    .handle("restoreBackup", ({ params, payload }) =>
      restoreThreadVmBackup(params.threadId, payload),
    )
    .handle("getRestore", ({ params }) => getThreadVmRestore(params.threadId, params.operationId))
    .handle("cancelBackupRecovery", ({ params, payload }) =>
      cancelThreadVmBackupRecovery(params.threadId, payload),
    )
    .handle("cancelRestore", ({ params }) =>
      cancelThreadVmRestore(params.threadId, params.operationId),
    )
    .handle("create", ({ payload }) => createThreadVm(payload))
    .handle("getReplacementCandidates", ({ params }) =>
      getThreadVmReplacementCandidates(params.requestId),
    )
    .handle("getReplacement", ({ params }) => getThreadVmReplacement(params.requestId))
    .handle("selectReplacement", ({ params, payload }) =>
      selectThreadVmReplacement({ ...params, ...payload }),
    )
    .handle("cancelReplacement", ({ params }) => cancelThreadVmReplacement(params.requestId))
    .handle("getSetup", ({ params }) => getThreadVmSetup(params.threadId))
    .handle("getStatus", ({ params }) => getThreadVmStatus(params.threadId))
    .handle("resume", ({ params }) => resumeThreadVm(params.threadId))
    .handle("cancelSetup", ({ params }) => cancelInitialThreadVmSetup(params.threadId)),
);
