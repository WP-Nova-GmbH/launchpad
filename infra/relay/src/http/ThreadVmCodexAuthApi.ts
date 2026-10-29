import type {
  RelayPortableThreadPlacement,
  RelayThreadVmCodexAuthSelection,
  RelayThreadVmCodexAuthSource,
  RelayThreadVmProviderAuthRequest,
} from "@t3tools/contracts/relay";
import {
  RelayApi,
  RelayEnvironmentPrincipal,
  CodexVmConnectionError,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { CodexVmOAuth } from "../tenancy/CodexVmOAuth.ts";
import { makeCodexVmConnections } from "../tenancy/CodexVmConnections.ts";
import {
  makeThreadVmCodexAuthStore,
  type ThreadVmCodexAuthIdentity,
} from "../threads/ThreadVmCodexAuthStore.ts";
import { readPendingThreadVmProviderAuth } from "../threads/ThreadVmPendingProviderAuth.ts";
import { authorizeThreadEnvironment } from "./ThreadEnvironmentApi.ts";
import { withPrivateThreadOwnerAccess, withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";
import { appendRelayCredentialResponseHeaders } from "./Api.ts";
import {
  codexVmConnectionMetadata,
  makeCodexVmConnectionActions,
  mapCodexVmConnectionErrors,
} from "./CodexVmConnectionsApi.ts";

type Owner = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
};
const fail = (reason: CodexVmConnectionError["reason"]) => new CodexVmConnectionError({ reason });
const serializeSource = Effect.fn("relay.vm_codex_auth.serialize")(function* (
  input: ThreadVmCodexAuthIdentity,
) {
  const source = yield* makeThreadVmCodexAuthStore((yield* RelayDb).$client).connection(input);
  return source.selection.mode === "personal"
    ? source.selection
    : ({
        ...source.selection,
        connection: codexVmConnectionMetadata(
          source.connection,
          (yield* DateTime.now).epochMilliseconds,
        ),
      } satisfies RelayThreadVmCodexAuthSource);
});

/** Both lookup and token delivery use current permissions, not copied guest state. */
export const withThreadVmCodexAuthScope = <A, E, R>(
  input: Owner,
  use: (identity: ThreadVmCodexAuthIdentity) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const principal = yield* RelayEnvironmentPrincipal,
      sql = (yield* RelayDb).$client;
    if (
      !principal.threadVm ||
      principal.environmentId !== input.environmentId ||
      principal.threadVm.threadId !== input.threadId ||
      principal.threadVm.generation !== input.generation
    )
      return yield* tenancyNotFound("thread_not_found");
    const vm = principal.threadVm;
    const [owner] = yield* sql<{
      userId: string;
    }>`SELECT owner_user_id AS "userId" FROM relay_thread_placements WHERE thread_id=${input.threadId}`;
    if (!owner) return yield* tenancyNotFound("thread_not_found");
    return yield* withPrivateThreadOwnerAccess(input.threadId, "read", owner.userId, (placement) =>
      Effect.gen(function* () {
        yield* authorizeThreadEnvironment(input, placement, true);
        const [running] =
          yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=${vm.allocationId}
        AND organization_id=${placement.organizationId} AND owner_user_id=${owner.userId} AND state='running' AND deleted_at IS NULL FOR SHARE`;
        if (!running) return yield* tenancyNotFound("thread_not_found");
        const pending = yield* readPendingThreadVmProviderAuth(sql, input.threadId);
        const exactPending =
          pending?.binding.allocationId === vm.allocationId &&
          pending.binding.environmentId === input.environmentId &&
          pending.binding.generation === input.generation;
        if (!exactPending) {
          if (
            placement.environmentId !== input.environmentId ||
            placement.generation !== input.generation ||
            placement.operationId !== null
          )
            return yield* tenancyNotFound("thread_not_found");
          const ready =
            yield* sql`SELECT 1 FROM relay_thread_vm_ready WHERE allocation_id=${vm.allocationId}
          AND environment_id=${input.environmentId} AND generation=${input.generation} AND phase='ready'`;
          if (!ready.length) return yield* tenancyNotFound("thread_not_found");
        }
        return yield* use({
          ...input,
          allocationId: vm.allocationId,
          organizationId: placement.organizationId,
        });
      }),
    );
  });

const privateIdentity = Effect.fn("relay.vm_codex_auth.private_identity")(function* (
  placement: RelayPortableThreadPlacement,
) {
  const sql = (yield* RelayDb).$client,
    pending = yield* readPendingThreadVmProviderAuth(sql, placement.threadId);
  if (pending)
    return {
      ...pending.binding,
      threadId: placement.threadId,
      organizationId: placement.organizationId,
    };
  const [binding] = yield* sql<{
    allocationId: string;
    environmentId: string;
    generation: number;
  }>`SELECT b.allocation_id AS "allocationId",b.environment_id AS "environmentId",b.generation
    FROM relay_thread_vm_bindings b JOIN relay_thread_vm_allocations a USING(allocation_id)
    WHERE b.thread_id=${placement.threadId} AND b.environment_id=${placement.environmentId} AND b.generation=${placement.generation}
    AND b.revoked_at IS NULL AND a.organization_id=${placement.organizationId} AND a.deleted_at IS NULL AND a.state IN ('running','paused') FOR SHARE OF b,a`;
  return binding
    ? { ...binding, threadId: placement.threadId, organizationId: placement.organizationId }
    : null;
});

/** Secret-free status, including paused VMs, never inspects or wakes compute. */
export const getThreadVmCodexAuthSource = Effect.fn("relay.vm_codex_auth.private_status")(
  function* (threadId: string) {
    return yield* withPrivateThreadAccess(threadId, "read", (placement) =>
      Effect.gen(function* () {
        const identity = yield* privateIdentity(placement);
        return identity ? yield* serializeSource(identity) : null;
      }),
    );
  },
);

/** Selection is possible only at the existing, quarantined provider preparation boundary. */
export const selectThreadVmCodexAuthSource = Effect.fn("relay.vm_codex_auth.select_source")(
  function* (
    threadId: string,
    input: RelayThreadVmProviderAuthRequest & { readonly source: RelayThreadVmCodexAuthSelection },
  ) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(threadId, "write", (placement) =>
      Effect.gen(function* () {
        const pending = yield* readPendingThreadVmProviderAuth(sql, threadId);
        if (
          !pending ||
          pending.binding.operationId !== input.operationId ||
          pending.binding.allocationId !== input.allocationId ||
          pending.binding.generation !== input.generation
        )
          return yield* tenancyConflict("thread_placement_changed");
        const identity = { ...pending.binding, threadId, organizationId: placement.organizationId };
        yield* makeThreadVmCodexAuthStore(sql).select(identity, input.source);
        return yield* serializeSource(identity);
      }),
    );
  },
);

export const getEnvironmentThreadVmCodexAuthSource = (input: Owner) =>
  withThreadVmCodexAuthScope(input, (identity) =>
    Effect.gen(function* () {
      yield* makeThreadVmCodexAuthStore((yield* RelayDb).$client).acknowledge(identity);
      return yield* serializeSource(identity);
    }),
  );
export const getEnvironmentThreadVmCodexAuthToken = Effect.fn("relay.vm_codex_auth.token")(
  function* (input: Owner & { readonly connectionId: string }) {
    const sql = (yield* RelayDb).$client;
    const lookup = withThreadVmCodexAuthScope(input, (identity) =>
      Effect.gen(function* () {
        const source = yield* makeThreadVmCodexAuthStore(sql).connection(identity);
        if (
          source.selection.mode !== "organization" ||
          source.selection.connectionId !== input.connectionId ||
          source.connection?.status !== "connected"
        )
          return yield* fail("not_connected");
        return { ...identity, connection: source.connection };
      }),
    );
    const authorized = yield* lookup;
    const actions = makeCodexVmConnectionActions({
      store: makeCodexVmConnections(sql),
      oauth: yield* CodexVmOAuth,
      secrets: yield* RelaySecretBox,
    });
    const result = yield* actions.token(authorized.organizationId, input.connectionId);
    const current = yield* lookup;
    if (
      current.allocationId !== authorized.allocationId ||
      (result.status === "ready" &&
        (current.connection.epoch !== result.epoch ||
          current.connection.tokenRevision !== result.tokenRevision))
    )
      return yield* fail("not_connected");
    return result;
  },
);

export const threadVmCodexAuthApi = HttpApiBuilder.group(
  RelayApi,
  "threadVmCodexAuth",
  (handlers) =>
    handlers
      .handle("codexAuthSource", ({ params, payload }) =>
        getEnvironmentThreadVmCodexAuthSource({ ...params, ...payload }).pipe(
          mapCodexVmConnectionErrors,
        ),
      )
      .handle("codexAuthToken", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          return yield* getEnvironmentThreadVmCodexAuthToken({ ...params, ...payload });
        }).pipe(mapCodexVmConnectionErrors),
      ),
);
