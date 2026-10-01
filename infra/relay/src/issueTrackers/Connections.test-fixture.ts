import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayConfiguration } from "../Config.ts";
import { Organizations, type OrganizationMembershipRecord } from "../tenancy/Organizations.ts";
import { ConnectionStore, type ConnectionKey, type ConnectionRecord } from "./ConnectionStore.ts";
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const key = { organizationId: "org", service: "linear" } as const;
export const issueInput = { ...key, issue: "LP-42" };
export const membership: OrganizationMembershipRecord = {
  userId: "admin",
  role: "admin",
  joinedAt: "2026-01-01T00:00:00.000Z",
  organization: { organizationId: "org", name: "Launchpad", createdAt: "2026-01-01T00:00:00.000Z" },
};
const configuration = {
  relayIssuer: "https://relay.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  linear: { clientId: "client", clientSecret: Redacted.make("linear-client-secret") },
} satisfies RelayConfiguration["Service"];

export const linearRow = (expiresAt = Number.MAX_SAFE_INTEGER): ConnectionRecord => ({
  ...key,
  version: "initial",
  status: "connected",
  accountLabel: "Launchpad app",
  payloadSealed: `sealed:${encodeJson({ service: "linear", accessToken: "old-access-secret", refreshToken: "old-refresh-secret", expiresAt, workspaceId: "workspace", workspaceSlug: "launchpad" })}`,
  authorizationId: null,
  replacement: null,
  pendingStateHash: null,
  pendingExpiresAt: null,
  updatedByUserId: "admin",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
export const issueResponse = (description = "Example") =>
  Response.json({
    data: {
      organization: { id: "workspace", name: "Launchpad", urlKey: "launchpad" },
      issue: {
        id: "issue-id",
        identifier: "LP-42",
        title: "Read this issue",
        description,
        url: "https://linear.app/launchpad/issue/LP-42/example",
        state: null,
        assignee: null,
      },
    },
  });
export const identityResponse = (workspaceId = "workspace", name = "Launchpad") =>
  Response.json({
    data: {
      organization: { id: workspaceId, name, urlKey: "launchpad" },
      viewer: { name: "Launchpad app" },
    },
  });
export const tokenResponse = () =>
  Response.json({
    access_token: "new-access-secret",
    refresh_token: "new-refresh-secret",
    expires_in: 86400,
  });
export const recordKey = (record: ConnectionKey) => `${record.organizationId}:${record.service}`;

export const fixture = Effect.fnUntraced(function* (
  options: {
    readonly store?: ConnectionStore["Service"];
    readonly rows?: ReadonlyArray<ConnectionRecord>;
    readonly membership?: Effect.Effect<OrganizationMembershipRecord | null>;
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
  } = {},
) {
  const records = yield* Ref.make(
    new Map((options.rows ?? []).map((row) => [recordKey(row), row])),
  );
  const semaphore = yield* Semaphore.make(1);
  const secondLockRequested = yield* Deferred.make<void>();
  let lockRequests = 0;
  let version = 0;
  const get = (input: ConnectionKey) =>
    Ref.get(records).pipe(Effect.map((rows) => rows.get(recordKey(input)) ?? null));
  const update = (
    input: ConnectionKey & { readonly version: string },
    change: (row: ConnectionRecord) => ConnectionRecord | null,
    matches: (row: ConnectionRecord) => boolean = () => true,
  ) =>
    Ref.modify(records, (rows) => {
      const existing = rows.get(recordKey(input));
      if (!existing || existing.version !== input.version || !matches(existing))
        return [false, rows] as const;
      const next = new Map(rows);
      const changed = change(existing);
      if (changed) next.set(recordKey(input), changed);
      else next.delete(recordKey(input));
      return [true, next] as const;
    });
  const store =
    options.store ??
    ConnectionStore.of({
      get,
      list: (organizationId) =>
        Ref.get(records).pipe(
          Effect.map((rows) =>
            [...rows.values()].filter((row) => row.organizationId === organizationId),
          ),
        ),
      findPending: (stateHash) =>
        Ref.get(records).pipe(
          Effect.map(
            (rows) => [...rows.values()].find((row) => row.pendingStateHash === stateHash) ?? null,
          ),
        ),
      begin: (input) =>
        Ref.modify(records, (rows) => {
          const existing = rows.get(recordKey(input));
          const row: ConnectionRecord = {
            ...input,
            version:
              input.service === "linear" && existing ? existing.version : `version-${++version}`,
            authorizationId: input.service === "linear" ? `auth-${++version}` : null,
            replacement: null,
            status: existing?.status ?? "connecting",
            accountLabel: existing?.accountLabel ?? null,
            payloadSealed: existing?.payloadSealed ?? null,
            pendingStateHash: input.stateHash ?? null,
            pendingExpiresAt: input.expiresAt ?? null,
            updatedByUserId: input.userId,
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
          return [row, new Map(rows).set(recordKey(input), row)] as const;
        }),
      claimAuthorization: (input) =>
        update(
          input,
          (row) => ({ ...row, pendingStateHash: null }),
          (row) =>
            row.authorizationId === input.authorizationId &&
            row.pendingStateHash === input.stateHash,
        ),
      cancelAuthorization: (input) =>
        get(input).pipe(
          Effect.flatMap((row) =>
            !row
              ? Effect.void
              : update(
                  row,
                  (current) =>
                    current.payloadSealed
                      ? {
                          ...current,
                          authorizationId: null,
                          pendingStateHash: null,
                          pendingExpiresAt: null,
                        }
                      : null,
                  (current) => current.authorizationId === input.authorizationId,
                ).pipe(Effect.asVoid),
          ),
        ),
      proposeReplacement: (input) =>
        update(
          input,
          (row) => ({
            ...row,
            replacement: input.replacement,
            authorizationId: null,
            pendingStateHash: null,
            pendingExpiresAt: null,
          }),
          (row) => row.authorizationId === input.authorizationId && row.pendingStateHash === null,
        ),
      cancelReplacement: (input) =>
        update(
          input,
          (row) => ({ ...row, replacement: null }),
          (row) => row.replacement?.id === input.proposalId,
        ).pipe(Effect.asVoid),
      complete: (input) =>
        update(input, (row) => ({
          ...row,
          version: `version-${++version}`,
          payloadSealed: input.payloadSealed,
          accountLabel: input.accountLabel,
          status: "connected",
          authorizationId: null,
          replacement: null,
          pendingStateHash: null,
          pendingExpiresAt: null,
        })),
      refresh: (input) => update(input, (row) => ({ ...row, payloadSealed: input.payloadSealed })),
      requireReconnect: (input) =>
        update(input, (row) =>
          row.payloadSealed === input.payloadSealed
            ? { ...row, status: "reconnect_required" }
            : row,
        ).pipe(Effect.asVoid),
      remove: (input) =>
        Ref.update(records, (rows) => {
          const next = new Map(rows);
          next.delete(recordKey(input));
          return next;
        }),
      cancel: (input) =>
        update(input, (row) =>
          row.payloadSealed ? { ...row, pendingStateHash: null, pendingExpiresAt: null } : null,
        ).pipe(Effect.asVoid),
      withLock: (input, use) =>
        Effect.gen(function* () {
          lockRequests += 1;
          if (lockRequests >= 2) yield* Deferred.succeed(secondLockRequested, undefined);
          return yield* semaphore.withPermits(1)(get(input).pipe(Effect.flatMap(use)));
        }),
    });
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) => {
    requests.push(request);
    return (options.respond?.(request) ?? Effect.die("Unexpected issue-tracker request")).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    );
  });
  const organizations = Organizations.of({
    ensureForUser: () => Effect.die("unexpected ensure"),
    getMembershipForUser: () => options.membership ?? Effect.succeed(membership),
    listMembers: () => Effect.die("unexpected list"),
    countAdmins: () => Effect.die("unexpected count"),
    countMembers: () => Effect.die("unexpected count"),
    updateMemberRole: () => Effect.die("unexpected update"),
    removeMember: () => Effect.die("unexpected remove"),
    addMember: () => Effect.die("unexpected add"),
    rename: () => Effect.die("unexpected rename"),
    deleteOrganization: () => Effect.die("unexpected delete"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(ConnectionStore, store),
    Layer.succeed(RelayConfiguration, configuration),
    Layer.succeed(Organizations, organizations),
    Layer.succeed(HttpClient.HttpClient, http),
    NodeCrypto.layer,
    Layer.succeed(RelaySecretBox, {
      seal: (text) => Effect.succeed(`sealed:${text}`),
      open: (text) => Effect.succeed(text.slice("sealed:".length)),
    }),
  );
  return { store, records, requests, secondLockRequested, provide: Effect.provide(layer) };
});
