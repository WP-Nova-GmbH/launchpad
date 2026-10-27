import type { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import {
  confirmThreadVmRestoreActivation,
  getThreadVmRestoreRecovery,
  readThreadVmRestoreArtifact,
} from "./ThreadVmRestoreRecoveryApi.ts";
import {
  getThreadVmRepositoryBinding,
  withThreadVmRepositoryScope,
} from "./ThreadVmRepositoryApi.ts";
import {
  abortLocalThreadEnrollment,
  prepareLocalThreadEnrollment,
  receiveLocalEnrollmentReceipts,
  confirmLocalThreadEnrollment,
} from "./ThreadLocalEnrollmentApi.ts";
import {
  makeThreadVmPauseRecoveryStore,
  type ThreadVmPauseRecovery,
} from "../threads/ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmFinalSaveStore, type FinalSave } from "../threads/ThreadVmFinalSaveStore.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
import { authorizeThreadVmConnection } from "../threads/ThreadVmConnectionAccess.ts";
import { threadVmEndpointOwner } from "../threads/threadVmEndpointOwner.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { RelayRepositoryId, RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import { EnvironmentId, ProjectId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import {
  RelayApi,
  RelayEnvironmentPrincipal,
  type RelayThreadPersistedReceipt,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import { relayInternalErrorResponse, appendRelayCredentialResponseHeaders } from "./Api.ts";
import { withPrivateThreadOwnerAccess } from "./privateThreadAccess.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";

type Owner = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
};

/** Check one trusted environment identity under the caller's placement transaction.
 * Move destinations can hold the next generation before they become the owner. */
export const authorizeThreadEnvironment = Effect.fnUntraced(function* (
  input: Owner,
  placement: import("@t3tools/contracts/relay").RelayPortableThreadPlacement,
  requireCurrentAccess: boolean,
) {
  const principal = yield* RelayEnvironmentPrincipal;
  if (!principal.credentialId || principal.environmentId !== input.environmentId)
    return yield* tenancyNotFound("thread_not_found");
  const sql = (yield* RelayDb).$client;
  // Hold the current key against revocation through the write, not only middleware authentication.
  const keys = yield* sql`SELECT environment_id FROM relay_environment_credentials
        WHERE credential_id = ${principal.credentialId} AND environment_id = ${principal.environmentId} AND environment_public_key = ${principal.environmentPublicKey}
        AND revoked_at IS NULL FOR SHARE`;
  if (!keys.length) return yield* tenancyNotFound("thread_not_found");
  if (principal.threadVm) {
    if (
      principal.threadVm.threadId !== input.threadId ||
      principal.threadVm.generation !== input.generation ||
      principal.threadVm.repositoryId !== placement.repositoryId
    )
      return yield* tenancyNotFound("thread_not_found");
    // Match the binding writer's allocation-before-binding lock order.
    const allocations = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
              WHERE allocation_id = ${principal.threadVm.allocationId} AND thread_id = ${input.threadId}
              AND deleted_at IS NULL AND (${!requireCurrentAccess} OR state <> 'deleting') FOR SHARE`;
    if (!allocations.length) return yield* tenancyNotFound("thread_not_found");
    const bindings = yield* sql`SELECT b.environment_id FROM relay_thread_vm_bindings b
              JOIN relay_thread_vm_allocations a ON a.allocation_id = b.allocation_id
              WHERE b.environment_id = ${principal.environmentId} AND b.environment_public_key = ${principal.environmentPublicKey}
              AND b.credential_id = ${principal.credentialId} AND b.allocation_id = ${principal.threadVm.allocationId}
              AND b.thread_id = ${input.threadId} AND a.thread_id = ${input.threadId} AND b.repository_id = ${placement.repositoryId}
              AND b.generation = ${input.generation} AND b.revoked_at IS NULL AND a.deleted_at IS NULL
              AND (${!requireCurrentAccess} OR a.state <> 'deleting') FOR SHARE OF b`;
    if (!bindings.length) return yield* tenancyNotFound("thread_not_found");
  } else {
    const links = yield* sql`SELECT user_id FROM relay_environment_links
        WHERE environment_id = ${principal.environmentId} AND environment_public_key = ${principal.environmentPublicKey}
        AND user_id = ${placement.ownerUserId} AND revoked_at IS NULL FOR SHARE`;
    if (!links.length) {
      const machines = yield* sql`SELECT machine_id FROM relay_machines
          WHERE environment_id = ${principal.environmentId} AND environment_public_key = ${principal.environmentPublicKey}
          AND organization_id = ${placement.organizationId} AND deprovisioned_at IS NULL FOR SHARE`;
      if (!machines.length) return yield* tenancyNotFound("thread_not_found");
    }
  }
});

/** Acknowledgements may drain after access removal; new work always requires current owner access. */
export const withEnvironmentThread = <A, E, R>(
  input: Owner,
  requireCurrentAccess: boolean,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const principal = yield* RelayEnvironmentPrincipal;
    if (!principal.credentialId || principal.environmentId !== input.environmentId)
      return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id = ${input.threadId} AND environment_id = ${principal.environmentId} FOR UPDATE`;
          if (!rows.length) return yield* tenancyNotFound("thread_not_found");
          const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
          if (!placement || placement.generation !== input.generation)
            return yield* tenancyConflict("thread_placement_changed");
          yield* authorizeThreadEnvironment(input, placement, requireCurrentAccess);
          return yield* requireCurrentAccess
            ? withPrivateThreadOwnerAccess(
                input.threadId,
                "write",
                placement.ownerUserId,
                () => action,
              )
            : action;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
  });
const requireThreadVmEndpointOwner = (input: Owner) =>
  Effect.gen(function* () {
    const principal = yield* RelayEnvironmentPrincipal;
    if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    const target = yield* withEnvironmentThread(
      input,
      true,
      Effect.gen(function* () {
        const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
        if (!placement) return yield* tenancyNotFound("thread_not_found");
        return yield* authorizeThreadVmConnection(
          placement.ownerUserId,
          ThreadId.make(input.threadId),
        );
      }),
    );
    return {
      userId: threadVmEndpointOwner(target.identity.scope.allocationId),
      environmentId: target.environmentId,
    };
  });

/** Fixed loopback origin; the narrow VM principal cannot configure arbitrary forwarding. */
export const recoverThreadVmEndpoint = Effect.fn("relay.api.thread_vm.recover_endpoint")(
  function* (input: Owner) {
    const provider = yield* ManagedEndpointProvider;
    const owner = yield* requireThreadVmEndpointOwner(input);
    const result = yield* provider.provision({
      ...owner,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    });
    // No authorization transaction spans the external provider request. A lost/revoked reply leaves
    // an allocation tracked by the existing managed-endpoint cleanup rather than releasing a newer tunnel.
    const current = yield* requireThreadVmEndpointOwner(input);
    if (current.userId !== owner.userId || current.environmentId !== owner.environmentId)
      return yield* tenancyNotFound("thread_not_found");
    return result;
  },
  Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")),
);

export const releaseThreadVmEndpoint = Effect.fn("relay.api.thread_vm.release_endpoint")(
  function* (input: Owner & { tunnelId: string }) {
    const provider = yield* ManagedEndpointProvider;
    const owner = yield* requireThreadVmEndpointOwner(input);
    return { released: yield* provider.release({ ...owner, expectedTunnelId: input.tunnelId }) };
  },
  Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")),
);

const mapJournalErrors = {
  ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
};
const encodeSetupReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));

/** A prepared VM may open its local fence only after initial history and verified setup are durable. */
export const confirmInitialVmActivation = Effect.fn(
  "relay.api.thread_environment.confirm_initial_activation",
)(
  function* (input: {
    environmentId: string;
    threadId: string;
    receipt: RelayThreadVmSetupReceipt;
  }) {
    const principal = yield* RelayEnvironmentPrincipal;
    const receipt = input.receipt;
    if (
      !principal.threadVm ||
      receipt.scope.generation !== 1 ||
      receipt.scope.allocationId !== principal.threadVm.allocationId ||
      receipt.scope.threadId !== input.threadId ||
      receipt.environmentId !== input.environmentId ||
      receipt.projectId !== `vm:${input.threadId}` ||
      receipt.workspaceRoot !== "/workspace/project"
    )
      return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    return yield* withEnvironmentThread(
      { ...input, generation: 1 },
      true,
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const digest = yield* crypto.digest(
          "SHA-256",
          new TextEncoder().encode(yield* encodeSetupReceipt(receipt)),
        );
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const rows = yield* sql`SELECT s.allocation_id FROM relay_thread_vm_setups s
      JOIN relay_thread_placements p ON p.thread_id = ${input.threadId}
      JOIN relay_thread_vm_allocations a ON a.allocation_id = s.allocation_id AND a.thread_id = p.thread_id
      WHERE s.allocation_id = ${receipt.scope.allocationId} AND s.phase = 'ready'
      AND s.environment_id = ${input.environmentId} AND s.receipt_sha256 = ${hash}
      AND p.operation_id IS NULL AND p.project_id = ${receipt.projectId} AND p.repository_id = ${receipt.scope.repositoryId}
      AND a.state = 'running' AND a.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM relay_thread_history h WHERE h.thread_id = p.thread_id
        AND h.environment_id = ${input.environmentId} AND h.source_sequence = ${receipt.sequence}
        AND h.event_json->>'type' = 'thread.created') FOR SHARE OF s,a`;
        return { ready: rows.length === 1 };
      }),
    );
  },
  Effect.catchTags({
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

/** A guest may validate a client only for its own private thread and current placement. */
export const checkThreadVmClientAccess = Effect.fn("relay.api.thread_environment.client_access")(
  function* (input: Owner & { readonly userId: string }) {
    const principal = yield* RelayEnvironmentPrincipal;
    const vmScope = principal.threadVm;
    if (!vmScope) return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    return yield* withEnvironmentThread(
      input,
      false,
      // Check the connecting user, not just the VM owner; running state is required below.
      withPrivateThreadOwnerAccess(input.threadId, "read", input.userId, (placement) =>
        Effect.gen(function* () {
          const running = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
            WHERE allocation_id = ${vmScope.allocationId} AND state = 'running' FOR SHARE`;
          if (!running.length) return yield* tenancyNotFound("thread_not_found");
          return {
            environmentId: EnvironmentId.make(placement.environmentId),
            threadId: ThreadId.make(placement.threadId),
            projectId: ProjectId.make(placement.projectId),
            repositoryId: RelayRepositoryId.make(placement.repositoryId),
            generation: placement.generation,
            userId: input.userId,
          };
        }),
      ),
    );
  },
);

export const nextPortableThreadCommand = Effect.fn("relay.api.thread_environment.next")(function* (
  input: Owner,
) {
  const sql = (yield* RelayDb).$client;
  return yield* withEnvironmentThread(input, true, makeThreadJournalStore(sql).next(input)).pipe(
    Effect.catchTag("ThreadPlacementConflict", () => tenancyConflict("thread_placement_changed")),
  );
});
export const acknowledgePortableThreadCommand = Effect.fn(
  "relay.api.thread_environment.acknowledge",
)(function* (
  input: Owner & {
    readonly commandId: string;
    readonly receipt: RelayThreadPersistedReceipt;
    readonly commandReceipt?: OrchestrationCommandReceipt;
  },
) {
  const sql = (yield* RelayDb).$client;
  yield* withEnvironmentThread(input, false, makeThreadJournalStore(sql).acknowledge(input)).pipe(
    Effect.catchTags(mapJournalErrors),
  );
  return { ok: true as const };
});
export const appendPortableThreadHistory = Effect.fn("relay.api.thread_environment.append")(
  function* (input: Owner & { readonly event: OrchestrationEvent }) {
    const sql = (yield* RelayDb).$client;
    const cursor = yield* withEnvironmentThread(
      input,
      false,
      makeThreadJournalStore(sql).append(input),
    ).pipe(Effect.catchTags(mapJournalErrors));
    return { cursor };
  },
);
export const confirmPortableThreadHistoryThrough = Effect.fn(
  "relay.api.thread_environment.history_through",
)(function* (input: Owner & { readonly sourceSequence: number }) {
  const sql = (yield* RelayDb).$client;
  const sourceSequence = yield* withEnvironmentThread(
    input,
    false,
    makeThreadJournalStore(sql).confirmThrough(input),
  ).pipe(
    Effect.catchTag("ThreadPlacementConflict", () => tenancyConflict("thread_placement_changed")),
  );
  return { sourceSequence };
});
export const admitPortableThreadWork = Effect.fn("relay.api.thread_environment.admit")(function* (
  input: Owner & { readonly workId: string },
) {
  const sql = (yield* RelayDb).$client;
  const result = yield* withEnvironmentThread(
    input,
    true,
    makeThreadPlacementStore(sql).admit(input),
  ).pipe(
    Effect.catchTag("ThreadPlacementConflict", () => tenancyConflict("thread_placement_changed")),
  );
  return { completed: result.completed, newlyAdmitted: result.newlyAdmitted };
});
export const completePortableThreadWork = Effect.fn("relay.api.thread_environment.complete")(
  function* (input: Owner & { readonly workId: string }) {
    const sql = (yield* RelayDb).$client;
    yield* withEnvironmentThread(
      input,
      false,
      makeThreadPlacementStore(sql).completeWork(input),
    ).pipe(
      Effect.catchTag("ThreadPlacementConflict", () => tenancyConflict("thread_placement_changed")),
    );
    return { ok: true as const };
  },
);
/** Recheck authorization after the external mint; never hold database locks over GitHub I/O. */
export const mintThreadVmRepositoryToken = Effect.fn("relay.api.thread_environment.github_token")(
  function* (input: Owner & { readonly canonicalKey: string }) {
    const principal = yield* RelayEnvironmentPrincipal;
    if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
    const vmScope = principal.threadVm;
    const sql = (yield* RelayDb).$client;
    const authorize = withThreadVmRepositoryScope(
      input,
      Effect.gen(function* () {
        const [scope] = yield* sql<{ installationId: string; accountLogin: string }>`
        SELECT g.installation_id AS "installationId", g.account_login AS "accountLogin"
        FROM relay_repository_aliases r
        JOIN relay_thread_placements t ON t.repository_id = r.repository_id AND t.organization_id = r.organization_id
        JOIN relay_github_installations g ON g.organization_id = r.organization_id
        WHERE t.thread_id = ${input.threadId} AND r.repository_id = ${vmScope.repositoryId}
          AND r.canonical_key = ${input.canonicalKey}
        FOR SHARE OF r, g`;
        if (
          !scope ||
          !input.canonicalKey
            .toLowerCase()
            .startsWith(`github.com/${scope.accountLogin.toLowerCase()}/`)
        )
          return yield* tenancyNotFound("thread_not_found");
        return scope;
      }),
    );
    const scope = yield* authorize;
    const github = yield* GithubApp;
    const token = yield* github.mintRepositoryToken({
      installationId: scope.installationId,
      canonicalKey: input.canonicalKey,
    });
    const current = yield* authorize;
    if (
      current.installationId !== scope.installationId ||
      current.accountLogin !== scope.accountLogin
    )
      return yield* tenancyNotFound("thread_not_found");
    return { ...token, canonicalKey: input.canonicalKey };
  },
  Effect.catchTags({
    ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    GithubAppNotConfigured: () => relayInternalErrorResponse("upstream_unavailable"),
    GithubRequestFailed: () => relayInternalErrorResponse("upstream_unavailable"),
  }),
);

const serializePause = (pause: ThreadVmPauseRecovery) => ({
  threadId: ThreadId.make(pause.threadId),
  environmentId: EnvironmentId.make(pause.environmentId),
  generation: pause.generation,
  operationId: pause.operationId,
  phase: pause.phase,
  bootId: pause.bootId,
  sourceSequence: pause.sourceSequence,
  nativeCheckpointOperationId: pause.nativeCheckpointOperationId,
  canActivate: pause.canActivate,
  sourceReopened: pause.sourceReopened,
});
export const getThreadVmPause = Effect.fn("relay.api.thread_vm.pause.get")(function* (
  input: Owner,
) {
  return yield* withEnvironmentThread(
    input,
    false,
    Effect.gen(function* () {
      const principal = yield* RelayEnvironmentPrincipal;
      if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
      const pause = yield* makeThreadVmPauseRecoveryStore(
        (yield* RelayDb).$client,
        yield* ThreadArtifactObjectStorage,
      ).get(input);
      if (pause && pause.allocationId !== principal.threadVm.allocationId)
        return yield* tenancyNotFound("thread_not_found");
      return pause ? serializePause(pause) : null;
    }),
  );
});
export const freezeThreadVmPause = Effect.fn("relay.api.thread_vm.pause.freeze")(
  function* (
    input: Owner & { operationId: string; nativeCheckpointOperationId: string; bootId: string },
  ) {
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadVmPauseRecoveryStore(
          (yield* RelayDb).$client,
          yield* ThreadArtifactObjectStorage,
        );
        const pause = yield* store.get(input);
        if (
          !pause ||
          pause.allocationId !== principal.threadVm.allocationId ||
          pause.operationId !== input.operationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializePause(yield* store.sourceFrozen(input));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmPauseConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
export const confirmThreadVmPauseActivation = Effect.fn("relay.api.thread_vm.pause.activate")(
  function* (input: Owner & { operationId: string }) {
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadVmPauseRecoveryStore(
          (yield* RelayDb).$client,
          yield* ThreadArtifactObjectStorage,
        );
        const pause = yield* store.get(input);
        if (
          !pause ||
          pause.allocationId !== principal.threadVm.allocationId ||
          pause.operationId !== input.operationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializePause(yield* store.confirmActivation(input));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmPauseConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  }),
);
export const cancelThreadVmPause = Effect.fn("relay.api.thread_vm.pause.cancel")(
  function* (input: Owner & { operationId: string }) {
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadVmPauseRecoveryStore(
          (yield* RelayDb).$client,
          yield* ThreadArtifactObjectStorage,
        );
        const pause = yield* store.get(input);
        if (
          !pause ||
          pause.allocationId !== principal.threadVm.allocationId ||
          pause.operationId !== input.operationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializePause(yield* store.cancelBeforeFreeze(input));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmPauseConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);
const serializeFinalSave = (operation: FinalSave) => ({
  threadId: ThreadId.make(operation.threadId),
  environmentId: EnvironmentId.make(operation.environmentId),
  generation: operation.generation,
  operationId: operation.operationId,
  phase: operation.phase,
  nativeCheckpointOperationId: operation.nativeCheckpointOperationId,
});

/** Only the enrolled allocation may acknowledge the frozen source; access removal still permits draining. */
export const getThreadVmFinalSave = Effect.fn("relay.api.thread_vm.final_save.get")(function* (
  input: Owner,
) {
  const sql = (yield* RelayDb).$client;
  return yield* withEnvironmentThread(
    input,
    false,
    Effect.gen(function* () {
      const principal = yield* RelayEnvironmentPrincipal;
      if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
      const objects = yield* ThreadArtifactObjectStorage;
      const [row] = yield* sql<{ operationId: string }>`SELECT f.operation_id AS "operationId"
      FROM relay_thread_vm_final_saves f JOIN relay_thread_placements t USING(thread_id)
      WHERE f.thread_id=${input.threadId} AND f.environment_id=${input.environmentId}
        AND f.generation=${input.generation} AND f.allocation_id=${principal.threadVm.allocationId}
        AND (t.operation_id=f.operation_id OR f.phase='aborted')
      ORDER BY f.completed_at DESC NULLS FIRST, f.operation_id LIMIT 1`;
      if (!row) return null;
      const operation = yield* makeThreadVmFinalSaveStore(sql, objects).get(row.operationId);
      return operation ? serializeFinalSave(operation) : null;
    }),
  );
});
export const freezeThreadVmFinalSave = Effect.fn("relay.api.thread_vm.final_save.freeze")(
  function* (input: Owner & { operationId: string; nativeCheckpointOperationId: string }) {
    const sql = (yield* RelayDb).$client;
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const objects = yield* ThreadArtifactObjectStorage;
        const store = makeThreadVmFinalSaveStore(sql, objects);
        const operation = yield* store.get(input.operationId);
        if (
          !operation ||
          operation.threadId !== input.threadId ||
          operation.allocationId !== principal.threadVm.allocationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializeFinalSave(yield* store.sourceFrozen(input));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmFinalSaveConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const cancelThreadVmFinalSave = Effect.fn("relay.api.thread_vm.final_save.cancel")(
  function* (input: Owner & { operationId: string }) {
    const sql = (yield* RelayDb).$client;
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const objects = yield* ThreadArtifactObjectStorage;
        const store = makeThreadVmFinalSaveStore(sql, objects);
        const operation = yield* store.get(input.operationId);
        if (
          !operation ||
          operation.threadId !== input.threadId ||
          operation.allocationId !== principal.threadVm.allocationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializeFinalSave(yield* store.cancelBeforeFreeze(input));
      }),
    );
  },
  Effect.catchTags({
    ThreadVmFinalSaveConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);

export const threadEnvironmentApi = HttpApiBuilder.group(
  RelayApi,
  "threadEnvironment",
  (handlers) =>
    handlers
      .handle("confirmRestoreActivation", ({ params, payload }) =>
        confirmThreadVmRestoreActivation(
          { ...params, generation: payload.scope.generation },
          payload,
        ),
      )
      .handle("getRestoreRecovery", ({ params, payload }) =>
        getThreadVmRestoreRecovery({ ...params, ...payload }),
      )
      .handle("restoreArtifact", ({ params, query }) =>
        readThreadVmRestoreArtifact({ ...params, ...query }),
      )
      .handle("cancelPause", ({ params, payload }) =>
        cancelThreadVmPause({ ...params, ...payload }),
      )
      .handle("confirmPauseActivation", ({ params, payload }) =>
        confirmThreadVmPauseActivation({ ...params, ...payload }),
      )
      .handle("getPause", ({ params, payload }) => getThreadVmPause({ ...params, ...payload }))
      .handle("freezePause", ({ params, payload }) =>
        freezeThreadVmPause({ ...params, ...payload }),
      )
      .handle("cancelFinalSave", ({ params, payload }) =>
        cancelThreadVmFinalSave({ ...params, ...payload }),
      )
      .handle("getFinalSave", ({ params, payload }) =>
        getThreadVmFinalSave({ ...params, ...payload }),
      )
      .handle("freezeFinalSave", ({ params, payload }) =>
        freezeThreadVmFinalSave({ ...params, ...payload }),
      )
      .handle("repositoryBinding", ({ params, payload }) =>
        getThreadVmRepositoryBinding({ ...params, ...payload }),
      )
      .handle("abortLocalEnrollment", ({ params, payload }) =>
        abortLocalThreadEnrollment({ ...params, ...payload }),
      )
      .handle("prepareLocalEnrollment", ({ params, payload }) =>
        prepareLocalThreadEnrollment({ ...params, ...payload }),
      )
      .handle("receiveLocalEnrollmentReceipts", ({ params, payload }) =>
        receiveLocalEnrollmentReceipts({ ...params, ...payload }),
      )
      .handle("confirmLocalEnrollment", ({ params, payload }) =>
        confirmLocalThreadEnrollment({ ...params, ...payload }),
      )
      .handle("recoverEndpoint", ({ params, payload }) =>
        appendRelayCredentialResponseHeaders.pipe(
          Effect.andThen(recoverThreadVmEndpoint({ ...params, ...payload })),
        ),
      )
      .handle("releaseEndpoint", ({ params, payload }) =>
        releaseThreadVmEndpoint({ ...params, ...payload }),
      )
      .handle("checkClientAccess", ({ params, payload }) =>
        checkThreadVmClientAccess({ ...params, ...payload }),
      )
      .handle("confirmInitialActivation", ({ params, payload }) =>
        confirmInitialVmActivation({ ...params, receipt: payload }),
      )
      .handle("mintRepositoryToken", ({ params, payload }) =>
        mintThreadVmRepositoryToken({ ...params, ...payload }),
      )
      .handle("nextCommand", ({ params, payload }) =>
        nextPortableThreadCommand({ ...params, ...payload }),
      )
      .handle("acknowledgeCommand", ({ params, payload }) =>
        acknowledgePortableThreadCommand({ ...params, ...payload }),
      )
      .handle("appendHistory", ({ params, payload }) =>
        appendPortableThreadHistory({ ...params, ...payload }),
      )
      .handle("confirmHistoryThrough", ({ params, payload }) =>
        confirmPortableThreadHistoryThrough({ ...params, ...payload }),
      )
      .handle("admitWork", ({ params, payload }) =>
        admitPortableThreadWork({ ...params, ...payload }),
      )
      .handle("completeWork", ({ params, payload }) =>
        completePortableThreadWork({ ...params, ...payload }),
      ),
);
