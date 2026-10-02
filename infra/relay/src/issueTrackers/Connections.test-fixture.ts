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
} satisfies RelayConfiguration["Service"];

export const linearOAuth = {
  server: {
    issuer: "https://mcp.linear.app",
    authorization_endpoint: "https://mcp.linear.app/authorize",
    token_endpoint: "https://mcp.linear.app/token",
    registration_endpoint: "https://mcp.linear.app/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true as const,
  },
  client: { client_id: "dynamic-client", token_endpoint_auth_method: "none" as const },
};
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
    }),
  ),
);
export const toolName = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" && request.url.endsWith("/mcp/readonly")
    ? decodeRpc(new TextDecoder().decode(request.body.body)).params?.name
    : undefined;
const decodeFixtureRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeFixtureComments = Schema.decodeUnknownSync(
  Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: Schema.Record(Schema.String, Schema.Unknown) })),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
);
/** Wrap fixture provider data in actual MCP protocol responses; lifecycle tests can focus on races. */
const linearResponse = (request: HttpClientRequest.HttpClientRequest, response: Response) =>
  Effect.promise(async () => {
    if (!request.url.endsWith("/mcp/readonly") || response.status !== 200) return response;
    const rpc = decodeRpc(
      new TextDecoder().decode(
        request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(),
      ),
    );
    const name = rpc.params?.name;
    if (name === "extract_images") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            {
              type: "image",
              mimeType: response.headers.get("content-type")?.split(";")[0] ?? "image/png",
              data: btoa(binary),
            },
          ],
        },
      });
    }

    const body = decodeFixtureRecord(await response.json());
    const data = decodeFixtureRecord(body.data ?? body);
    let value: unknown = data;
    if (name === "get_workspace") {
      const organization = decodeFixtureRecord(data.organization ?? {});
      value = { ...organization, url: `https://linear.app/${organization.urlKey ?? "launchpad"}` };
    }
    if (name === "get_user")
      value = { id: "account", name: "Launchpad app", ...decodeFixtureRecord(data.viewer ?? {}) };
    if (name === "get_issue" && data.issue) {
      const issue = decodeFixtureRecord(data.issue);
      value = {
        ...issue,
        uuid: issue.id,
        id: issue.identifier,
        status: issue.state ? decodeFixtureRecord(issue.state).name : null,
        assignee: issue.assignee ? decodeFixtureRecord(issue.assignee).name : null,
      };
    }
    if (name === "list_comments" && data.comments) {
      const comments = decodeFixtureComments(data.comments);
      value = {
        comments: comments.edges.map(({ node }) => ({ ...node, author: node.user })),
        hasNextPage: comments.pageInfo.hasNextPage,
        endCursor: comments.pageInfo.hasNextPage ? "next-page" : null,
      };
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: encodeJson(value) }] },
    });
  });

export const linearRow = (expiresAt = Number.MAX_SAFE_INTEGER): ConnectionRecord => ({
  ...key,
  version: "initial",
  status: "connected",
  accountLabel: "Launchpad app",
  payloadSealed: `sealed:${encodeJson({ service: "linear", oauth: linearOAuth, accountId: "account", accessToken: "old-access-secret", refreshToken: "old-refresh-secret", expiresAt, workspaceId: "workspace", workspaceSlug: "launchpad" })}`,
  authorizationId: null,
  replacement: null,
  jiraSelection: null,
  pendingOAuthSealed: null,
  pendingStateHash: null,
  pendingExpiresAt: null,
  updatedByUserId: "admin",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
export const jiraOAuth = {
  server: {
    issuer: "https://auth.atlassian.com/jira-issuer",
    authorization_endpoint: "https://auth.atlassian.com/authorize",
    token_endpoint: "https://auth.atlassian.com/oauth/token",
    registration_endpoint: "https://auth.atlassian.com/jira-issuer/dcr/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  },
  client: { client_id: "jira-client", token_endpoint_auth_method: "none" as const },
};
export const jiraRow = (expiresAt = Number.MAX_SAFE_INTEGER): ConnectionRecord => ({
  ...linearRow(expiresAt),
  service: "jira",
  accountLabel: "launchpad.atlassian.net",
  payloadSealed: `sealed:${encodeJson({ service: "jira", authType: "oauth", oauth: jiraOAuth, accessToken: "oauth-access", refreshToken: "oauth-refresh", expiresAt, siteUrl: "https://launchpad.atlassian.net", cloudId: "cloud" })}`,
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
export const identityResponse = (
  workspaceId = "workspace",
  name = "Launchpad",
  accountId = "account",
) =>
  Response.json({
    data: {
      organization: { id: workspaceId, name, urlKey: "launchpad" },
      viewer: { id: accountId, name: "Launchpad app" },
    },
  });
export const tokenResponse = () =>
  Response.json({
    access_token: "new-access-secret",
    refresh_token: "new-refresh-secret",
    expires_in: 86400,
    token_type: "Bearer",
    scope: "read",
  });
export const recordKey = (record: ConnectionKey) => `${record.organizationId}:${record.service}`;

export const fixture = Effect.fnUntraced(function* (
  options: {
    readonly rawHttp?: boolean;
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
            version: existing?.version ?? `version-${++version}`,
            authorizationId: `auth-${++version}`,
            replacement: null,
            jiraSelection: null,
            status: existing?.status ?? "connecting",
            accountLabel: existing?.accountLabel ?? null,
            payloadSealed: existing?.payloadSealed ?? null,
            pendingOAuthSealed: input.pendingOAuthSealed ?? null,
            pendingStateHash: input.stateHash,
            pendingExpiresAt: input.expiresAt,
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
                          jiraSelection: null,
                          pendingOAuthSealed: null,
                          pendingStateHash: null,
                          pendingExpiresAt: null,
                        }
                      : null,
                  (current) =>
                    current.authorizationId === input.authorizationId &&
                    (input.expiresAt === undefined || current.pendingExpiresAt === input.expiresAt),
                ).pipe(Effect.asVoid),
          ),
        ),
      awaitJiraSelection: (input) =>
        update(
          input,
          (row) => ({
            ...row,
            jiraSelection: input.selection,
            pendingOAuthSealed: null,
            pendingExpiresAt: input.expiresAt,
          }),
          (row) => row.authorizationId === input.authorizationId && row.pendingStateHash === null,
        ),
      proposeReplacement: (input) =>
        update(
          input,
          (row) => ({
            ...row,
            replacement: input.replacement,
            authorizationId: null,
            pendingOAuthSealed: null,
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
          ...(input.userId ? { updatedByUserId: input.userId } : {}),
          authorizationId: null,
          replacement: null,
          jiraSelection: null,
          pendingOAuthSealed: null,
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
      withLock: (input, use) =>
        Effect.gen(function* () {
          lockRequests += 1;
          if (lockRequests >= 2) yield* Deferred.succeed(secondLockRequested, undefined);
          return yield* semaphore.withPermits(1)(get(input).pipe(Effect.flatMap(use)));
        }),
    });
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) => {
    if (!options.rawHttp && request.url.startsWith("https://mcp.linear.app")) {
      if (request.method === "GET" && request.url === "https://mcp.linear.app/mcp/readonly")
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 405 })),
        );
      let response: Response | undefined;
      if (request.url.includes("oauth-protected-resource"))
        response = Response.json({
          resource: "https://mcp.linear.app/mcp/readonly",
          authorization_servers: ["https://mcp.linear.app"],
          scopes_supported: ["read"],
        });
      else if (request.url.endsWith("oauth-authorization-server"))
        response = Response.json(linearOAuth.server);
      else if (request.url.endsWith("/register"))
        response = Response.json(
          {
            ...linearOAuth.client,
            redirect_uris: ["https://relay.test/v1/organization/issue-trackers/linear/callback"],
          },
          { status: 201 },
        );
      else if (request.url.endsWith("/mcp/readonly") && request.body._tag === "Uint8Array") {
        const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
        if (rpc.method === "initialize")
          response = Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "Linear", version: "1" },
            },
          });
        if (rpc.method === "notifications/initialized")
          response = new Response(null, { status: 202 });
      }
      if (response) return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }
    requests.push(request);
    return (options.respond?.(request) ?? Effect.die("Unexpected issue-tracker request")).pipe(
      Effect.flatMap((response) =>
        options.rawHttp ? Effect.succeed(response) : linearResponse(request, response),
      ),
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
