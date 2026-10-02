import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  OAuthError,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

export const JIRA_MCP_RESOURCE = "https://mcp.atlassian.com/v2/mcp";
const RESOURCE_METADATA = "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp";
export const JIRA_READ_SCOPE = "read:jira:agent-interface";
// Keep the identity scopes from Atlassian's consent flow, but only request Jira reads.
const scope = ["read:me", "read:account", "offline_access", "email", JIRA_READ_SCOPE].join(" ");
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
      "Jira authorization has expired or was revoked. Reconnect Jira in Organization settings.",
  });
const isIssueTrackerFailure = Schema.is(IssueTrackerFailure);
const isJiraOAuthEndpoint = Schema.is(JiraOAuthEndpoint);
// Log only protocol error names, never provider descriptions or raw exception text.
export const jiraOAuthErrorCode = (value: unknown) =>
  typeof value === "string" &&
  [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "invalid_token",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_target",
    "server_error",
    "temporarily_unavailable",
  ].includes(value)
    ? value
    : "unknown";
const diagnosticHeader = (value: string | undefined) =>
  value && /^[a-zA-Z0-9:,. _-]{1,128}$/.test(value) ? value : undefined;
const sanitizeError = (cause: unknown) => {
  if (isIssueTrackerFailure(cause)) return cause;
  if (
    cause instanceof OAuthError &&
    ["invalid_client", "invalid_grant", "invalid_token", "unauthorized_client"].includes(cause.code)
  )
    return authRequired();
  return unavailable();
};

// The SDK owns OAuth; this bridge retains the relay's HTTP limits and injectable test client.
const sdkRequest = Effect.fn("jiraOAuth.sdk")(
  function* <A>(stage: string, use: (fetchFn: typeof fetch) => Promise<A>) {
    const http = yield* HttpClient.HttpClient;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    let oauthError: string | undefined;
    return yield* Effect.tryPromise({
      try: (signal) =>
        use(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (
            !(
              isJiraOAuthEndpoint(request.url) ||
              (url.origin === "https://mcp.atlassian.com" &&
                url.pathname.startsWith("/.well-known/") &&
                request.method === "GET")
            )
          )
            throw unavailable();
          const body = request.method === "GET" ? undefined : await request.text();
          let outgoing = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
            request.url,
          ).pipe(HttpClientRequest.setHeaders(Object.fromEntries(request.headers)));
          if (body !== undefined)
            outgoing = outgoing.pipe(
              HttpClientRequest.bodyText(
                body,
                request.headers.get("content-type") ?? "application/x-www-form-urlencoded",
              ),
            );
          const result = await run(
            Effect.gen(function* () {
              const response = yield* http.execute(outgoing);
              yield* (response.status >= 400 ? Effect.logWarning : Effect.logDebug)(
                "Jira OAuth HTTP response",
                {
                  stage,
                  endpoint: url.origin + url.pathname,
                  method: request.method,
                  httpStatus: response.status,
                  atlassianRequestId: diagnosticHeader(response.headers["atl-request-id"]),
                  atlassianTraceId: diagnosticHeader(response.headers["atl-traceid"]),
                  serverDate: diagnosticHeader(response.headers.date),
                },
              );
              if (response.status === 401) return yield* authRequired();
              if (response.status === 403)
                return yield* new IssueTrackerFailure({
                  code: "forbidden",
                  message:
                    "Atlassian denied authorization. Check your organization's Jira access and callback-domain settings.",
                });
              if (response.status >= 300 && response.status < 400) return yield* unavailable();
              const bytes = yield* response.stream.pipe(
                Stream.runFoldEffect(
                  () => new Uint8Array(0),
                  (previous, chunk) => {
                    if (previous.length + chunk.length > 65_536) return Effect.fail(unavailable());
                    const next = new Uint8Array(previous.length + chunk.length);
                    next.set(previous);
                    next.set(chunk, previous.length);
                    return Effect.succeed(next);
                  },
                ),
              );
              return new Response(response.status === 204 ? null : bytes, {
                status: response.status,
                headers: response.headers,
              });
            }).pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "error",
                credentials: "omit",
              }),
              Effect.match({ onFailure: sanitizeError, onSuccess: (value) => value }),
            ),
            { signal: AbortSignal.any([signal, request.signal]) },
          );
          if (isIssueTrackerFailure(result)) throw result;
          return result;
        }),
      catch: (cause) => {
        if (cause instanceof OAuthError) oauthError = jiraOAuthErrorCode(cause.code);
        return sanitizeError(cause);
      },
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Jira OAuth stage failed", {
          stage,
          code: error.code,
          oauthError,
        }),
      ),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(unavailable()) }),
    ),
);

const tokenResult = (value: unknown, previousRefreshToken?: string) => {
  const tokens = decodeTokens(value);
  if (tokens.token_type.toLowerCase() !== "bearer") throw unavailable();
  if (tokens.scope !== undefined && !tokens.scope.split(/\s+/).includes(JIRA_READ_SCOPE))
    throw new IssueTrackerFailure({
      code: "forbidden",
      message: "Authorize Jira read access to connect this site.",
    });
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw authRequired();
  return { accessToken: tokens.access_token, refreshToken, expiresIn: tokens.expires_in };
};

export const beginJiraOAuth = (input: { readonly redirectUri: string; readonly state: string }) =>
  sdkRequest("authorization", async (fetchFn) => {
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
    ),
  );
// Refresh-only: the SDK's general auth() helper can fall back to interactive authorization.
export const refreshJiraTokens = (input: {
  readonly oauth: typeof JiraOAuthSession.Type;
  readonly refreshToken: string;
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
      input.refreshToken,
    ),
  );
