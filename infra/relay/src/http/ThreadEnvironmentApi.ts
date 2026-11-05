import { makeThreadVmBackupSourceStore } from "../threads/ThreadVmBackupSourceStore.ts";
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
import { makeThreadVmCodexAuthStore } from "../threads/ThreadVmCodexAuthStore.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import {
  authorizeWorkflowVmGuest,
  isWorkflowVmThread,
  requireWorkflowVmViewer,
  withWorkflowVmGuest,
} from "../jobs/WorkflowVmBinding.ts";
import {
  readWorkflowRunReviewSecrets,
  resolveWorkflowRunAttemptConfiguration,
} from "../jobs/WorkflowRunConfiguration.ts";

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
    if (
      yield* isWorkflowVmThread(sql, input.threadId).pipe(
        Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
      )
    ) {
      const { binding } = yield* authorizeWorkflowVmGuest(input).pipe(
        Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
      );
      return {
        userId: threadVmEndpointOwner(binding.allocationId),
        environmentId: binding.environmentId,
      };
    }
    const target = yield* withEnvironmentThread(
      input,
      true,
      Effect.gen(function* () {
        const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
        if (!placement) return yield* tenancyNotFound("thread_not_found");
        return yield* authorizeThreadVmConnection(
          placement.ownerUserId,
          ThreadId.make(input.threadId),
        ).pipe(
          Effect.catchTag("ThreadVmConnectionUnavailable", () =>
            tenancyNotFound("thread_not_found"),
          ),
        );
      }),
    );
    return {
      userId: threadVmEndpointOwner(target.identity.scope.allocationId),
      environmentId: target.environmentId,
    };
  });

/** Fixed loopback origin; the narrow VM principal cannot configure arbitrary forwarding. */
export const recoverThreadVmEndpoint = Effect.fn("relay.api.thread_vm.recover_endpoint")(function* (
  input: Owner,
) {
  const provider = yield* ManagedEndpointProvider;
  const owner = yield* requireThreadVmEndpointOwner(input);
  const result = yield* provider
    .provision({
      ...owner,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    })
    .pipe(Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")));
  // No authorization transaction spans the external provider request. A lost/revoked reply leaves
  // an allocation tracked by the existing managed-endpoint cleanup rather than releasing a newer tunnel.
  const current = yield* requireThreadVmEndpointOwner(input);
  if (current.userId !== owner.userId || current.environmentId !== owner.environmentId)
    return yield* tenancyNotFound("thread_not_found");
  return result;
});

export const releaseThreadVmEndpoint = Effect.fn("relay.api.thread_vm.release_endpoint")(function* (
  input: Owner & { tunnelId: string },
) {
  const provider = yield* ManagedEndpointProvider;
  const owner = yield* requireThreadVmEndpointOwner(input);
  const released = yield* provider
    .release({ ...owner, expectedTunnelId: input.tunnelId })
    .pipe(Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")));
  return { released };
});

const mapJournalErrors = {
  ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};
const mapEncodedJournalErrors = {
  ...mapJournalErrors,
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
};
const encodeSetupReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));
const setupReceiptHash = Effect.fnUntraced(function* (receipt: RelayThreadVmSetupReceipt) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(yield* encodeSetupReceipt(receipt)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

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
    if (yield* isWorkflowVmThread(sql, input.threadId)) {
      const hash = yield* setupReceiptHash(receipt);
      return yield* withWorkflowVmGuest(
        { ...input, generation: 1 },
        "enrolled",
        ({ binding, snapshot }) =>
          Effect.gen(function* () {
            if (
              receipt.operationId !== binding.operationId ||
              receipt.scope.repositoryId !== binding.repositoryId ||
              receipt.revision !== snapshot.commitSha
            )
              return yield* tenancyNotFound("thread_not_found");
            yield* makeThreadVmCodexAuthStore(sql).requireAcknowledged(binding);
            const [ready] = yield* sql`SELECT s.allocation_id FROM relay_thread_vm_setups s
            JOIN relay_workflow_jobs j ON j.job_id=${binding.jobId}
            WHERE s.allocation_id=${binding.allocationId} AND s.phase='ready'
              AND s.environment_id=${binding.environmentId} AND s.receipt_sha256=${hash}
              AND j.status NOT IN ('cancelled','failed','cancelling')
              AND j.pending_control#>>'{response,operation}' IS DISTINCT FROM 'cancel'
              AND EXISTS (SELECT 1 FROM relay_thread_history h WHERE h.thread_id=${binding.threadId}
                AND h.environment_id=${binding.environmentId} AND h.source_sequence=${receipt.sequence}
                AND h.event_json->>'type'='thread.created')`;
            if (!ready) return { ready: false };
            yield* sql`UPDATE relay_thread_placements SET operation_id=NULL
            WHERE thread_id=${binding.threadId} AND workflow_job_id=${binding.jobId}
              AND operation_id=${binding.operationId}`;
            return { ready: true };
          }),
      );
    }
    return yield* withEnvironmentThread(
      { ...input, generation: 1 },
      true,
      Effect.gen(function* () {
        const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
        if (!placement) return yield* tenancyNotFound("thread_not_found");
        yield* makeThreadVmCodexAuthStore(sql).requireAcknowledged({
          ...input,
          generation: 1,
          allocationId: receipt.scope.allocationId,
          organizationId: placement.organizationId,
        });
        const hash = yield* setupReceiptHash(receipt);
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
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

/** A guest may validate a client only for its own private thread and current placement. */
export const checkThreadVmClientAccess = Effect.fn("relay.api.thread_environment.client_access")(
  function* (input: Owner & { readonly userId: string }) {
    const principal = yield* RelayEnvironmentPrincipal;
    const vmScope = principal.threadVm;
    if (!vmScope) return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    if (yield* isWorkflowVmThread(sql, input.threadId)) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { binding } = yield* authorizeWorkflowVmGuest(input);
            yield* requireWorkflowVmViewer(sql, binding, input.userId);
            return {
              environmentId: binding.environmentId,
              threadId: binding.threadId,
              projectId: binding.projectId,
              repositoryId: RelayRepositoryId.make(binding.repositoryId),
              generation: binding.generation,
              userId: input.userId,
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
    }
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

export const readThreadVmReviewSecrets = Effect.fnUntraced(
  function* (input: Owner & { readonly jobId: string }) {
    const sql = (yield* RelayDb).$client;
    const box = yield* RelaySecretBox;
    return yield* withWorkflowVmGuest(input, "active", ({ binding }) =>
      readWorkflowRunReviewSecrets(sql, box, binding).pipe(
        Effect.catchTag("WorkflowRunConfigurationError", ({ reason }) =>
          Effect.gen(function* () {
            if (reason === "storage")
              return yield* relayInternalErrorResponse("persistence_failed");
            return yield* tenancyNotFound("thread_not_found");
          }),
        ),
      ),
    );
  },
  Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
);

export const nextPortableThreadCommand = Effect.fn("relay.api.thread_environment.next")(function* (
  input: Owner,
) {
  const sql = (yield* RelayDb).$client;
  if (
    yield* isWorkflowVmThread(sql, input.threadId).pipe(
      Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
    )
  ) {
    yield* authorizeWorkflowVmGuest(input, "enrolled").pipe(
      Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
    );
    return null;
  }
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
    Effect.catchTags({
      ThreadPlacementConflict: mapJournalErrors.ThreadPlacementConflict,
      SchemaError: mapEncodedJournalErrors.SchemaError,
    }),
  );
  return { ok: true as const };
});
export const appendPortableThreadHistory = Effect.fn("relay.api.thread_environment.append")(
  function* (input: Owner & { readonly event: OrchestrationEvent }) {
    const sql = (yield* RelayDb).$client;
    const cursor = yield* Effect.gen(function* () {
      if (yield* isWorkflowVmThread(sql, input.threadId))
        return yield* withWorkflowVmGuest(input, "enrolled", ({ active }) =>
          Effect.gen(function* () {
            if (!active && input.event.type !== "thread.created")
              return yield* tenancyNotFound("thread_not_found");
            return yield* makeThreadJournalStore(sql).append(input, !active);
          }),
        );
      return yield* withEnvironmentThread(input, false, makeThreadJournalStore(sql).append(input));
    }).pipe(Effect.catchTags(mapEncodedJournalErrors));
    return { cursor };
  },
);
export const confirmPortableThreadHistoryThrough = Effect.fn(
  "relay.api.thread_environment.history_through",
)(function* (input: Owner & { readonly sourceSequence: number }) {
  const sql = (yield* RelayDb).$client;
  const sourceSequence = yield* Effect.gen(function* () {
    if (yield* isWorkflowVmThread(sql, input.threadId))
      return yield* withWorkflowVmGuest(input, "enrolled", ({ active }) =>
        makeThreadJournalStore(sql).confirmThrough(input, !active),
      );
    return yield* withEnvironmentThread(
      input,
      false,
      makeThreadJournalStore(sql).confirmThrough(input),
    );
  }).pipe(Effect.catchTags(mapJournalErrors));
  return { sourceSequence };
});
export const admitPortableThreadWork = Effect.fn("relay.api.thread_environment.admit")(function* (
  input: Owner & { readonly workId: string },
) {
  const sql = (yield* RelayDb).$client;
  const result = yield* Effect.gen(function* () {
    if (yield* isWorkflowVmThread(sql, input.threadId))
      return yield* withWorkflowVmGuest(input, "active", ({ binding }) =>
        Effect.gen(function* () {
          const [active] = yield* sql`SELECT 1 FROM relay_workflow_jobs
            WHERE job_id=${binding.jobId} AND record->>'startAttempted'='true'
              AND status NOT IN ('done','cancelled','failed','cancelling')`;
          if (!active) return yield* tenancyNotFound("thread_not_found");
          return yield* makeThreadPlacementStore(sql).admit(input, binding.jobId);
        }),
      );
    return yield* withEnvironmentThread(input, true, makeThreadPlacementStore(sql).admit(input));
  }).pipe(Effect.catchTags(mapJournalErrors));
  return { completed: result.completed, newlyAdmitted: result.newlyAdmitted };
});
export const completePortableThreadWork = Effect.fn("relay.api.thread_environment.complete")(
  function* (input: Owner & { readonly workId: string }) {
    const sql = (yield* RelayDb).$client;
    yield* Effect.gen(function* () {
      if (yield* isWorkflowVmThread(sql, input.threadId))
        return yield* withWorkflowVmGuest(input, "active", ({ binding }) =>
          makeThreadPlacementStore(sql).completeWork(input, binding.jobId),
        );
      return yield* withEnvironmentThread(
        input,
        false,
        makeThreadPlacementStore(sql).completeWork(input),
      );
    }).pipe(Effect.catchTags(mapJournalErrors));
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
    if (yield* isWorkflowVmThread(sql, input.threadId)) {
      const authorize = Effect.gen(function* () {
        const { snapshot, binding } = yield* authorizeWorkflowVmGuest(input);
        if (snapshot.canonicalKey !== input.canonicalKey)
          return yield* tenancyNotFound("thread_not_found");
        const [current] = yield* sql`SELECT 1 FROM relay_repository_aliases a
          JOIN relay_github_installations g USING(organization_id)
          WHERE a.repository_id=${binding.repositoryId} AND a.organization_id=${binding.organizationId}
            AND a.canonical_key=${snapshot.canonicalKey} AND g.installation_id=${snapshot.installationId}`;
        if (!current) return yield* tenancyNotFound("thread_not_found");
        return snapshot.installationId;
      });
      const installationId = yield* authorize;
      const token = yield* (yield* GithubApp).mintRepositoryToken({
        installationId,
        canonicalKey: input.canonicalKey,
        access: "read",
      });
      if ((yield* authorize) !== installationId) return yield* tenancyNotFound("thread_not_found");
      return { ...token, canonicalKey: input.canonicalKey };
    }
    const authorize = withThreadVmRepositoryScope(
      input,
      Effect.gen(function* () {
        const running = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
          WHERE allocation_id = ${vmScope.allocationId} AND thread_id = ${input.threadId}
          AND state = 'running' AND deleted_at IS NULL FOR SHARE`;
        if (!running.length) return yield* tenancyNotFound("thread_not_found");
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

const backupSourceOperation = Effect.fn("relay.api.thread_vm.backup_source")(
  function* (
    input: Owner & {
      operationId?: string;
      nativeCheckpointOperationId?: string;
      bootId?: string;
      sealEpoch?: number;
    },
    action: "get" | "freeze" | "cancel" | "activate",
  ) {
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadVmBackupSourceStore(
          (yield* RelayDb).$client,
          yield* ThreadArtifactObjectStorage,
        );
        const current = yield* store.get(input);
        if (!current) {
          if (action === "get") return null;
          return yield* tenancyNotFound("thread_not_found");
        }
        if (
          current.allocationId !== principal.threadVm.allocationId ||
          (action !== "get" && current.operationId !== input.operationId)
        )
          return yield* tenancyNotFound("thread_not_found");
        const owned = { ...input, operationId: current.operationId };
        const value =
          action === "get"
            ? current
            : action === "cancel"
              ? yield* store.cancelPending(owned)
              : action === "activate"
                ? yield* store.confirmActivation(owned)
                : yield* store.sourceFrozen({
                    ...owned,
                    nativeCheckpointOperationId: input.nativeCheckpointOperationId!,
                    bootId: input.bootId!,
                    sealEpoch: input.sealEpoch!,
                  });
        return {
          threadId: ThreadId.make(value.threadId),
          environmentId: EnvironmentId.make(value.environmentId),
          generation: value.generation,
          operationId: value.operationId,
          phase: value.phase,
          nativeCheckpointOperationId: value.sourceReceipt?.nativeCheckpointOperationId ?? null,
          canActivate: value.canActivate,
          sourceReopened: value.sourceReopened,
        };
      }),
    );
  },
  Effect.catchTags({
    ThreadVmBackupConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
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
    input: Owner & {
      operationId: string;
      nativeCheckpointOperationId: string;
      bootId: string;
      sealEpoch: number;
    },
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
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
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
  sourceActivationPending: operation.sourceActivationPending,
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
  function* (
    input: Owner & {
      operationId: string;
      nativeCheckpointOperationId: string;
      bootId: string;
      sealEpoch: number;
    },
  ) {
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

export const confirmThreadVmFinalSaveActivation = Effect.fn(
  "relay.api.thread_vm.final_save.confirm_activation",
)(
  function* (input: Owner & { operationId: string }) {
    const sql = (yield* RelayDb).$client;
    return yield* withEnvironmentThread(
      input,
      false,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadVmFinalSaveStore(sql, yield* ThreadArtifactObjectStorage);
        const operation = yield* store.get(input.operationId);
        if (
          !operation ||
          operation.threadId !== input.threadId ||
          operation.allocationId !== principal.threadVm.allocationId
        )
          return yield* tenancyNotFound("thread_not_found");
        return serializeFinalSave(yield* store.confirmActivation(input));
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
      .handle("getBackupSource", ({ params, payload }) =>
        backupSourceOperation({ ...params, ...payload }, "get"),
      )
      .handle("freezeBackupSource", ({ params, payload }) =>
        backupSourceOperation({ ...params, ...payload }, "freeze").pipe(
          Effect.flatMap((value) =>
            value ? Effect.succeed(value) : tenancyNotFound("thread_not_found"),
          ),
        ),
      )
      .handle("cancelBackupSource", ({ params, payload }) =>
        backupSourceOperation({ ...params, ...payload }, "cancel").pipe(
          Effect.flatMap((value) =>
            value ? Effect.succeed(value) : tenancyNotFound("thread_not_found"),
          ),
        ),
      )
      .handle("confirmBackupSourceActivation", ({ params, payload }) =>
        backupSourceOperation({ ...params, ...payload }, "activate").pipe(
          Effect.flatMap((value) =>
            value ? Effect.succeed(value) : tenancyNotFound("thread_not_found"),
          ),
        ),
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
      .handle("confirmFinalSaveActivation", ({ params, payload }) =>
        confirmThreadVmFinalSaveActivation({ ...params, ...payload }),
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
        checkThreadVmClientAccess({ ...params, ...payload }).pipe(
          Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
        ),
      )
      .handle("confirmInitialActivation", ({ params, payload }) =>
        confirmInitialVmActivation({ ...params, receipt: payload }),
      )
      .handle("resolveWorkflowVmAttempt", ({ params, payload }) =>
        Effect.gen(function* () {
          const sql = (yield* RelayDb).$client;
          const box = yield* RelaySecretBox;
          const { generation, jobId, ...attempt } = payload;
          yield* appendRelayCredentialResponseHeaders;
          return yield* withWorkflowVmGuest(
            { ...params, generation, jobId },
            "active",
            ({ binding }) =>
              resolveWorkflowRunAttemptConfiguration(sql, box, binding, attempt).pipe(
                Effect.catchTag("WorkflowRunConfigurationError", ({ reason }) =>
                  Effect.gen(function* () {
                    if (reason === "storage")
                      return yield* relayInternalErrorResponse("persistence_failed");
                    return yield* tenancyNotFound("thread_not_found");
                  }),
                ),
              ),
          );
        }).pipe(
          Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
        ),
      )
      .handle("readWorkflowVmReviewSecrets", ({ params, payload }) =>
        appendRelayCredentialResponseHeaders.pipe(
          Effect.andThen(readThreadVmReviewSecrets({ ...params, ...payload })),
        ),
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
