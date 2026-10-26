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
export { oauthErrorCode as jiraOAuthErrorCode } from "./OAuthHttp.ts";

export const JIRA_MCP_RESOURCE = "https://mcp.atlassian.com/v2/mcp";
const RESOURCE_METADATA = "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp";
export const JIRA_READ_SCOPE = "read:jira:agent-interface";
export const JIRA_SEARCH_SCOPE = "search:jira:agent-interface";
export const JIRA_WRITE_SCOPE = "write:jira:agent-interface";
const readScopes = [
  "read:me",
  "read:account",
  "offline_access",
  "email",
  JIRA_READ_SCOPE,
  JIRA_SEARCH_SCOPE,
];
const requestedScopes = (writes: boolean) =>
  writes ? [...readScopes, JIRA_WRITE_SCOPE] : readScopes;
export const JiraOAuthEndpoint = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.origin === "https://auth.atlassian.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
);
const Server = Schema.Struct({
  issuer: JiraOAuthEndpoint,
  authorization_endpoint: JiraOAuthEndpoint,
  token_endpoint: JiraOAuthEndpoint,
  registration_endpoint: JiraOAuthEndpoint,
  response_types_supported: Schema.mutable(Schema.Array(Schema.String)),
  code_challenge_methods_supported: Schema.mutable(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.mutable(Schema.Array(Schema.String)),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});
const Client = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optionalKey(Schema.NonEmptyString),
  token_endpoint_auth_method: Schema.Literal("none"),
});
/** The issuer and registration stay together through callback, site selection and refresh. */
export const JiraOAuthSession = Schema.Struct({ server: Server, client: Client });
export const JiraPendingOAuth = Schema.Struct({
  ...JiraOAuthSession.fields,
  redirectUri: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
  writes: Schema.optionalKey(Schema.Boolean),
  requestedScopes: Schema.optionalKey(Schema.Array(Schema.String)),
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
    message: "Atlassian could not complete authorization. Try connecting Jira again.",
  });
const authRequired = () =>
  new IssueTrackerFailure({
    code: "auth_required",
    message:
      "Jira authorization has expired or was revoked. Reconnect Jira in Account connections.",
  });
const isOAuthEndpoint = Schema.is(JiraOAuthEndpoint);
const sdkRequest = makeOAuthRequest({
  span: "jiraOAuth.sdk",
  label: "Jira",
  allowsRequest: (request) => {
    const url = new URL(request.url);
    return (
      isOAuthEndpoint(request.url) ||
      (url.origin === "https://mcp.atlassian.com" &&
        url.pathname.startsWith("/.well-known/") &&
        request.method === "GET")
    );
  },
  diagnosticHeaders: { atlassianRequestId: "atl-request-id", atlassianTraceId: "atl-traceid" },
  unavailable,
  authRequired,
  forbidden: () =>
    new IssueTrackerFailure({
      code: "forbidden",
      message:
        "Atlassian denied authorization. Check your organization's Jira access and callback-domain settings.",
    }),
});

const tokenResult = (
  value: unknown,
  options: {
    readonly previousRefreshToken?: string;
    readonly fallbackScopes?: ReadonlyArray<string> | undefined;
  } = {},
) => {
  const tokens = decodeTokens(value);
  if (tokens.token_type.toLowerCase() !== "bearer") throw unavailable();
  const scopes =
    tokens.scope !== undefined ? tokens.scope.split(/\s+/).filter(Boolean) : options.fallbackScopes;
  if (scopes !== undefined && !scopes.includes(JIRA_READ_SCOPE))
    throw new IssueTrackerFailure({
      code: "forbidden",
      message: "Authorize Jira read access to connect this site.",
    });
  const refreshToken = tokens.refresh_token ?? options.previousRefreshToken;
  if (!refreshToken) throw authRequired();
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresIn: tokens.expires_in,
    ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
  };
};

export const beginJiraOAuth = (input: {
  readonly redirectUri: string;
  readonly state: string;
  readonly writes?: boolean;
}) =>
  sdkRequest("authorization", async (fetchFn) => {
    const scopes = requestedScopes(input.writes === true);
    const scope = scopes.join(" ");
    const discovery = await discoverOAuthServerInfo(JIRA_MCP_RESOURCE, {
      resourceMetadataUrl: new URL(RESOURCE_METADATA),
      fetchFn,
    });
    if (discovery.resourceMetadata?.resource !== JIRA_MCP_RESOURCE) throw unavailable();
    const server = decodeServer(discovery.authorizationServerMetadata);
    if (
      server.issuer !== discovery.authorizationServerUrl ||
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
      scope,
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
      scope,
      resource: JIRA_MCP_RESOURCE,
    });
    return {
      authorizationUrl: started.authorizationUrl.toString(),
      pending: {
        server,
        client,
        redirectUri: input.redirectUri,
        codeVerifier: started.codeVerifier,
        writes: input.writes === true,
        requestedScopes: scopes,
      },
    };
  });
export const exchangeJiraCode = (
  input: typeof JiraPendingOAuth.Type & { readonly code: string; readonly iss?: string },
) =>
  sdkRequest("token exchange", async (fetchFn) =>
    tokenResult(
      await exchangeAuthorization(input.server.issuer, {
        metadata: input.server,
        clientInformation: input.client,
        authorizationCode: input.code,
        ...(input.iss !== undefined ? { iss: input.iss } : {}),
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        resource: JIRA_MCP_RESOURCE,
        fetchFn,
      }),
      // Older pending attempts did not save their request; only their read grant is known.
      { fallbackScopes: input.requestedScopes ?? [JIRA_READ_SCOPE] },
    ),
  );
// Refresh-only: the SDK's general auth() helper can fall back to interactive authorization.
export const refreshJiraTokens = (input: {
  readonly oauth: typeof JiraOAuthSession.Type;
  readonly refreshToken: string;
  readonly scopes?: ReadonlyArray<string>;
}) =>
  sdkRequest("token refresh", async (fetchFn) =>
    tokenResult(
      await refreshAuthorization(input.oauth.server.issuer, {
        metadata: input.oauth.server,
        clientInformation: input.oauth.client,
        refreshToken: input.refreshToken,
        resource: JIRA_MCP_RESOURCE,
        fetchFn,
      }),
      { previousRefreshToken: input.refreshToken, fallbackScopes: input.scopes },
    ),
  );
