import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";
import * as Schema from "effect/Schema";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";
import { makeOAuthRequest } from "./OAuthHttp.ts";
export { oauthErrorCode as linearOAuthErrorCode } from "./OAuthHttp.ts";

export const LINEAR_MCP_RESOURCE = "https://mcp.linear.app/mcp/readonly";
export const LINEAR_WRITE_MCP_RESOURCE = "https://mcp.linear.app/mcp";
export const LinearResource = Schema.Literals([LINEAR_MCP_RESOURCE, LINEAR_WRITE_MCP_RESOURCE]);
export type LinearResource = typeof LinearResource.Type;
const resourceMetadata = (resource: LinearResource) =>
  `https://mcp.linear.app/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
export const LINEAR_READ_SCOPE = "read";
export const LinearOAuthEndpoint = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.origin === "https://mcp.linear.app" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
);
const Server = Schema.Struct({
  issuer: LinearOAuthEndpoint,
  authorization_endpoint: LinearOAuthEndpoint,
  token_endpoint: LinearOAuthEndpoint,
  registration_endpoint: LinearOAuthEndpoint,
  response_types_supported: Schema.mutable(Schema.Array(Schema.String)),
  code_challenge_methods_supported: Schema.mutable(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.mutable(Schema.Array(Schema.String)),
  authorization_response_iss_parameter_supported: Schema.Literal(true),
});
const Client = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optionalKey(Schema.NonEmptyString),
  token_endpoint_auth_method: Schema.Literal("none"),
});
/** The issuer and registration stay together through callback, workspace confirmation and refresh. */
export const LinearOAuthSession = Schema.Struct({
  server: Server,
  client: Client,
  resource: Schema.optionalKey(LinearResource),
});
export const LinearPendingOAuth = Schema.Struct({
  ...LinearOAuthSession.fields,
  redirectUri: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
});
const decodeServer = Schema.decodeUnknownSync(Server);
const decodeClient = Schema.decodeUnknownSync(Client);
const decodeTokens = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.optionalKey(Schema.NonEmptyString),
    expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
    token_type: Schema.String,
    scope: Schema.optionalKey(Schema.String),
  }),
);
const unavailable = () =>
  new IssueTrackerFailure({
    code: "unavailable",
    message: "Linear could not complete authorization. Try connecting Linear again.",
  });
const authRequired = () =>
  new IssueTrackerFailure({
    code: "auth_required",
    message:
      "Linear authorization has expired or was revoked. Reconnect Linear in Account connections.",
  });
const isOAuthEndpoint = Schema.is(LinearOAuthEndpoint);
const sdkRequest = makeOAuthRequest({
  span: "linearOAuth.sdk",
  label: "Linear",
  allowsRequest: (request) => {
    const url = new URL(request.url);
    return (
      isOAuthEndpoint(request.url) ||
      (url.origin === "https://mcp.linear.app" &&
        url.pathname.startsWith("/.well-known/") &&
        request.method === "GET")
    );
  },
  diagnosticHeaders: { requestId: "x-request-id", traceId: "x-trace-id" },
  unavailable,
  authRequired,
  forbidden: () =>
    new IssueTrackerFailure({
      code: "forbidden",
      message: "Linear denied authorization. Check your Linear account's access and reconnect.",
    }),
});

const tokenResult = (value: unknown, resource: LinearResource, previousRefreshToken?: string) => {
  const tokens = decodeTokens(value);
  if (tokens.token_type.toLowerCase() !== "bearer") throw unavailable();
  if (
    resource === LINEAR_MCP_RESOURCE &&
    tokens.scope !== undefined &&
    tokens.scope.trim() !== LINEAR_READ_SCOPE
  )
    throw new IssueTrackerFailure({
      code: "forbidden",
      message: "Authorize read-only Linear access to connect this workspace.",
    });
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw authRequired();
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresIn: tokens.expires_in,
    scopes: tokens.scope?.split(/\s+/).filter(Boolean),
  };
};

export const beginLinearOAuth = (input: {
  readonly redirectUri: string;
  readonly state: string;
  readonly resource?: LinearResource;
}) =>
  sdkRequest("authorization", async (fetchFn) => {
    const resource = input.resource ?? LINEAR_MCP_RESOURCE;
    const requestedScope = resource === LINEAR_MCP_RESOURCE ? LINEAR_READ_SCOPE : undefined;
    const discovery = await discoverOAuthServerInfo(resource, {
      resourceMetadataUrl: new URL(resourceMetadata(resource)),
      fetchFn,
    });
    if (discovery.resourceMetadata?.resource !== resource) throw unavailable();
    const server = decodeServer(discovery.authorizationServerMetadata);
    if (
      new URL(server.issuer).href !== new URL(discovery.authorizationServerUrl).href ||
      !server.code_challenge_methods_supported.includes("S256") ||
      !server.token_endpoint_auth_methods_supported.includes("none")
    )
      throw unavailable();
    const registered = await registerClient(server.issuer, {
      metadata: server,
      clientMetadata: {
        client_name: "Launchpad",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      ...(requestedScope ? { scope: requestedScope } : {}),
      fetchFn,
    });
    const client = decodeClient({
      ...registered,
      token_endpoint_auth_method: registered.token_endpoint_auth_method ?? "none",
    });
    const started = await startAuthorization(server.issuer, {
      metadata: server,
      clientInformation: client,
      redirectUrl: input.redirectUri,
      state: input.state,
      ...(requestedScope ? { scope: requestedScope } : {}),
      resource,
    });
    return {
      authorizationUrl: started.authorizationUrl.toString(),
      pending: {
        server,
        client,
        redirectUri: input.redirectUri,
        codeVerifier: started.codeVerifier,
        resource,
      },
    };
  });
export const exchangeLinearCode = (
  input: typeof LinearPendingOAuth.Type & { readonly code: string; readonly iss?: string },
) =>
  sdkRequest("token exchange", async (fetchFn) => {
    const result = tokenResult(
      await exchangeAuthorization(input.server.issuer, {
        metadata: input.server,
        clientInformation: input.client,
        authorizationCode: input.code,
        ...(input.iss !== undefined ? { iss: input.iss } : {}),
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        resource: input.resource ?? LINEAR_MCP_RESOURCE,
        fetchFn,
      }),
      input.resource ?? LINEAR_MCP_RESOURCE,
    );
    if (
      (input.resource ?? LINEAR_MCP_RESOURCE) === LINEAR_WRITE_MCP_RESOURCE &&
      result.scopes?.length === 1 &&
      result.scopes[0] === LINEAR_READ_SCOPE
    )
      throw new IssueTrackerFailure({
        code: "forbidden",
        message: "Linear granted only read access. Reconnect and allow issue changes.",
      });
    return result;
  });
// Refresh-only: the SDK's general auth() helper can fall back to interactive authorization.
export const refreshLinearTokens = (input: {
  readonly oauth: typeof LinearOAuthSession.Type;
  readonly refreshToken: string;
}) =>
  sdkRequest("token refresh", async (fetchFn) =>
    tokenResult(
      await refreshAuthorization(input.oauth.server.issuer, {
        metadata: input.oauth.server,
        clientInformation: input.oauth.client,
        refreshToken: input.refreshToken,
        resource: input.oauth.resource ?? LINEAR_MCP_RESOURCE,
        fetchFn,
      }),
      input.oauth.resource ?? LINEAR_MCP_RESOURCE,
      input.refreshToken,
    ),
  );
