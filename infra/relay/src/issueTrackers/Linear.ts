import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { IssueDetails, IssueTrackerFailure } from "./IssueTrackerModels.ts";

const API_URL = "https://api.linear.app";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_DESCRIPTION_LENGTH = 20_000;
const REQUEST_TIMEOUT = "10 seconds";
const Identifier = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*-[1-9]\d*$/),
);
const Label = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const StableId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Workspace = Schema.Struct({ id: StableId, name: Label, urlKey: Label });
const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
});
const GraphqlErrors = Schema.Struct({
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        extensions: Schema.optionalKey(
          Schema.Struct({
            code: Schema.optionalKey(Schema.String),
            type: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  ),
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOAuthError = Schema.decodeUnknownEffect(
  Schema.Struct({ error: Schema.optionalKey(Schema.String) }),
);
const decodeGraphqlErrors = Schema.decodeUnknownEffect(GraphqlErrors);
const decodeTokens = Schema.decodeUnknownEffect(Tokens);
const decodeIdentifier = Schema.decodeUnknownEffect(Identifier);
const decodeIssueDetails = Schema.decodeUnknownEffect(IssueDetails);
const decodeIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({ organization: Workspace, viewer: Schema.Struct({ name: Label }) }),
  }),
);
const decodeIssue = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Workspace,
      issue: Schema.NullOr(
        Schema.Struct({
          id: StableId,
          identifier: Identifier,
          title: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
          description: Schema.NullOr(Schema.String),
          url: Schema.String.check(Schema.isMaxLength(4096)),
          state: Schema.NullOr(Schema.Struct({ name: Label })),
          assignee: Schema.NullOr(Schema.Struct({ name: Label })),
        }),
      ),
    }),
  }),
);

const unavailable = () =>
  new IssueTrackerFailure({
    code: "unavailable",
    message: "Linear could not complete the request.",
  });
const isTrackerFailure = Schema.is(IssueTrackerFailure);
const safeFailure = (error: unknown) => (isTrackerFailure(error) ? error : unavailable());
const authRequired = () =>
  new IssueTrackerFailure({ code: "auth_required", message: "Reconnect the Linear workspace." });
const forbidden = () =>
  new IssueTrackerFailure({
    code: "forbidden",
    message: "This Linear connection cannot access the requested workspace or issue.",
  });
const notFound = () =>
  new IssueTrackerFailure({ code: "not_found", message: "The Linear issue was not found." });
const invalidIssue = () =>
  new IssueTrackerFailure({
    code: "invalid_input",
    message: "Enter a Linear issue identifier or an issue URL from the connected workspace.",
  });

/** Stream the body so missing or misleading Content-Length cannot bypass the limit. */
const readBody = Effect.fn("relay.linear.read_body")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const decoder = new TextDecoder();
  const body = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, text: "" }),
      (body, chunk) => {
        const bytes = body.bytes + chunk.byteLength;
        return bytes > MAX_RESPONSE_BYTES
          ? Effect.fail(
              new IssueTrackerFailure({
                code: "unavailable",
                message: "Linear response exceeded the 256 KiB size limit.",
              }),
            )
          : Effect.succeed({ bytes, text: body.text + decoder.decode(chunk, { stream: true }) });
      },
    ),
    Effect.mapError(safeFailure),
  );
  return yield* decodeJson(body.text + decoder.decode()).pipe(Effect.mapError(safeFailure));
});

const execute = Effect.fn("relay.linear.execute")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(request)
    .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(safeFailure));
});

const readResponse = Effect.fn("relay.linear.read_response")(function* (
  request: HttpClientRequest.HttpClientRequest,
  graphqlErrors = false,
) {
  const response = yield* execute(request);
  if (response.status === 401) return yield* authRequired();
  if (response.status === 403) return yield* forbidden();
  if (response.status === 404) return yield* notFound();
  if (response.status === 400) {
    const body = yield* readBody(response).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(safeFailure),
    );
    if (graphqlErrors) return body;
    const error = yield* decodeOAuthError(body).pipe(Effect.mapError(safeFailure));
    if (error.error === "invalid_grant" || error.error === "invalid_token")
      return yield* authRequired();
    return yield* unavailable();
  }
  if (response.status < 200 || response.status >= 300) return yield* unavailable();
  return yield* readBody(response).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(safeFailure),
  );
});

export const graphql = Effect.fn("relay.linear.graphql")(function* <A>(
  accessToken: string,
  query: string,
  variables: Readonly<Record<string, string | number | null>>,
  decode: (body: unknown) => Effect.Effect<{ readonly data: A }, Schema.SchemaError>,
) {
  const request = yield* HttpClientRequest.post(`${API_URL}/graphql`).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.bodyJson({ query, variables }),
    Effect.mapError(safeFailure),
  );
  const body = yield* readResponse(request, true);
  const envelope = yield* decodeGraphqlErrors(body).pipe(Effect.mapError(safeFailure));
  if (envelope.errors?.length) {
    const codes = new Set(
      envelope.errors.flatMap((error) => [error.extensions?.code, error.extensions?.type]),
    );
    if (
      codes.has("AUTHENTICATION_ERROR") ||
      codes.has("UNAUTHENTICATED") ||
      codes.has("authentication error")
    )
      return yield* authRequired();
    if (codes.has("FORBIDDEN") || codes.has("forbidden")) return yield* forbidden();
    if (codes.has("ENTITY_NOT_FOUND") || codes.has("NOT_FOUND")) return yield* notFound();
    if (codes.has("invalid input") || codes.has("INPUT_ERROR")) return yield* invalidIssue();
    return yield* unavailable();
  }
  return yield* decode(body).pipe(
    Effect.map((envelope) => envelope.data),
    Effect.mapError(safeFailure),
  );
});

export function linearAuthorizationUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge?: string;
}): string {
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    scope: "read",
    actor: "app",
    prompt: "consent",
    ...(input.codeChallenge
      ? { code_challenge: input.codeChallenge, code_challenge_method: "S256" }
      : {}),
  }).toString();
  return url.toString();
}

const requestTokens = Effect.fn("relay.linear.request_tokens")(function* (
  fields: Readonly<Record<string, string>>,
) {
  const body = yield* readResponse(
    HttpClientRequest.post(`${API_URL}/oauth/token`).pipe(HttpClientRequest.bodyUrlParams(fields)),
  );
  const tokens = yield* decodeTokens(body).pipe(Effect.mapError(safeFailure));
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
});

export const exchangeLinearCode = Effect.fn("relay.linear.exchange_code")(function* (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier?: string;
}) {
  return yield* requestTokens({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
    ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
  });
});

export const refreshLinearTokens = Effect.fn("relay.linear.refresh_tokens")(function* (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}) {
  return yield* requestTokens({
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });
});

export const getLinearIdentity = Effect.fn("relay.linear.get_identity")(function* (input: {
  readonly accessToken: string;
}) {
  const data = yield* graphql(
    input.accessToken,
    "query LaunchpadIdentity { organization { id name urlKey } viewer { name } }",
    {},
    decodeIdentity,
  );
  return {
    workspaceId: data.organization.id,
    workspaceName: data.organization.name,
    workspaceSlug: data.organization.urlKey,
    accountLabel: `${data.organization.name} · ${data.viewer.name}`,
  };
});

const issueIdentifier = Effect.fn("relay.linear.issue_identifier")(function* (
  issue: string,
  workspaceSlug: string,
) {
  const value = issue.trim();
  let identifier = value;
  if (value.includes(":")) {
    const url = yield* Effect.try({ try: () => new URL(value), catch: invalidIssue });
    const match = /^\/([^/]+)\/issue\/([^/]+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
    if (
      url.origin !== "https://linear.app" ||
      url.username ||
      url.password ||
      !match ||
      match[1] !== workspaceSlug
    )
      return yield* invalidIssue();
    identifier = match[2] ?? "";
  }
  return yield* decodeIdentifier(identifier).pipe(
    Effect.map((id) => id.toUpperCase()),
    Effect.mapError(invalidIssue),
  );
});

export const readLinearIssue = Effect.fn("relay.linear.read_issue")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly issue: string;
  readonly issueId?: string;
}) {
  const identifier = input.issueId ?? (yield* issueIdentifier(input.issue, input.workspaceSlug));
  const data = yield* graphql(
    input.accessToken,
    "query LaunchpadIssue($id: String!) { organization { id name urlKey } issue(id: $id) { id identifier title description url state { name } assignee { name } } }",
    { id: identifier },
    decodeIssue,
  );
  if (
    data.organization.id !== input.workspaceId ||
    data.organization.urlKey !== input.workspaceSlug
  )
    return yield* forbidden();
  if (data.issue === null) return yield* notFound();
  const issue = data.issue;
  const returnedIdentifier = yield* issueIdentifier(issue.url, input.workspaceSlug).pipe(
    Effect.mapError(unavailable),
  );
  if (
    input.issueId
      ? issue.id !== input.issueId || returnedIdentifier !== issue.identifier.toUpperCase()
      : issue.identifier.toUpperCase() !== identifier || returnedIdentifier !== identifier
  )
    return yield* unavailable();
  const description = issue.description ?? "";
  const details = yield* decodeIssueDetails({
    identifier: issue.identifier,
    title: issue.title,
    description:
      description.length > MAX_DESCRIPTION_LENGTH
        ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}\n\n[Description truncated by Launchpad. Open the issue for the full text.]`
        : description,
    url: issue.url,
    status: issue.state?.name ?? null,
    assignee: issue.assignee?.name ?? null,
  }).pipe(Effect.mapError(safeFailure));
  const result = { ...details, issueId: issue.id };
  const notice = "\n\n[Description truncated by Launchpad. Open the issue for the full text.]";
  let shortened = result.description;
  while (new TextEncoder().encode(encodeJson(result)).byteLength > 48 * 1024) {
    if (shortened.length === 0)
      return yield* new IssueTrackerFailure({
        code: "unavailable",
        message: "Linear issue metadata exceeded the response size limit.",
      });
    shortened = shortened.slice(0, Math.floor(shortened.length / 2));
    result.description = shortened + notice;
  }
  return { ...result, originalDescription: description };
});

export const revokeLinearToken = Effect.fn("relay.linear.revoke_token")(function* (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly token: string;
}) {
  const response = yield* execute(
    HttpClientRequest.post(`${API_URL}/oauth/revoke`).pipe(
      HttpClientRequest.bodyUrlParams({
        token: input.token,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    ),
  );
  if (response.status === 401) return yield* authRequired();
  if (response.status !== 200) return yield* unavailable();
});
