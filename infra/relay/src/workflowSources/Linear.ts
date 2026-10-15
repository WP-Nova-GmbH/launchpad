import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { WORKFLOW_LINEAR_CALLBACK_PATH } from "@t3tools/contracts/relay";
import { RelayConfiguration } from "../Config.ts";
import { fail, now } from "./Store.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
export const Tokens = Schema.Struct({
  access_token: Text,
  refresh_token: Text,
  expires_in: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 31_536_000 })),
  token_type: Schema.Literal("Bearer"),
  scope: Schema.String,
});
export const Credentials = Schema.Struct({
  accessToken: Text,
  refreshToken: Text,
  expiresAt: Schema.Number,
});
export const Pending = Schema.Struct({ state: Text, verifier: Text });
export const Identity = Schema.Struct({
  organization: Schema.Struct({ id: Text, name: Text }),
  viewer: Schema.Struct({ id: Text, name: Text }),
});
const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeError = Schema.decodeUnknownEffect(ErrorBody);
const decodeTokens = Schema.decodeUnknownEffect(Tokens);
const decodeIdentity = Schema.decodeUnknownEffect(Schema.Struct({ data: Identity }));
export const configuration = Effect.gen(function* () {
  const c = yield* RelayConfiguration;
  if (!c.linearWorkflow?.clientId.trim())
    return yield* fail("not_configured", "Native Linear workflow connections are not configured.");
  return {
    ...c.linearWorkflow,
    callbackUrl: c.relayIssuer.replace(/\/$/, "") + WORKFLOW_LINEAR_CALLBACK_PATH,
  };
});
export const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    catch: () => fail("unavailable", "Could not prepare authorization."),
  });
export const hash = (value: string) =>
  sha256(value).pipe(
    Effect.map((b) => Array.from(b, (b) => b.toString(16).padStart(2, "0")).join("")),
  );
export const authorizationUrl = Effect.fn("workflowSources.linear.authorizationUrl")(function* (
  pending: typeof Pending.Type,
) {
  const config = yield* configuration;
  const challenge = yield* sha256(pending.verifier).pipe(
    Effect.map((b) =>
      btoa(String.fromCharCode(...b))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    ),
  );
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: "read",
    actor: "user",
    prompt: "consent",
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
});
export const request = Effect.fn("workflowSources.linear.request")(
  function* (req: HttpClientRequest.HttpClientRequest, stage: "code" | "refresh" | "read") {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(req)
      .pipe(Effect.mapError(() => fail("unavailable", "Linear is unavailable.")));
    const bytes = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => new Uint8Array(0),
        (prev, chunk) => {
          if (prev.length + chunk.length > 524_288)
            return Effect.fail(fail("unavailable", "Linear returned too much data."));
          const next = new Uint8Array(prev.length + chunk.length);
          next.set(prev);
          next.set(chunk, prev.length);
          return Effect.succeed(next);
        },
      ),
      Effect.mapError(() => fail("unavailable", "Could not read the Linear response.")),
    );
    const value = yield* decodeJson(new TextDecoder().decode(bytes)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const error =
      value === null
        ? { error: undefined, errors: undefined }
        : yield* decodeError(value).pipe(
            Effect.mapError(() => fail("unavailable", "Linear returned malformed errors.")),
          );
    if (error.error === "invalid_client" || error.error === "unauthorized_client")
      return yield* fail(
        "service_configuration",
        "Linear service configuration needs attention. Retry after it is restored.",
      );
    if (stage === "refresh" && error.error === "invalid_grant")
      return yield* fail("reconnect_required", "The source owner must reconnect Linear.");
    if (
      response.status === 429 ||
      error.errors?.some((e) => e.extensions?.code === "RATELIMITED")
    ) {
      const time = yield* now;
      const retry = response.headers["retry-after"];
      const candidates = [
        retry
          ? Number.isFinite(Number(retry))
            ? time + Number(retry) * 1000
            : Date.parse(retry)
          : NaN,
        Number(response.headers["x-ratelimit-requests-reset"]),
        Number(response.headers["x-ratelimit-endpoint-requests-reset"]),
        Number(response.headers["x-ratelimit-complexity-reset"]),
      ].filter((n) => Number.isFinite(n) && n > time);
      return yield* fail(
        "rate_limited",
        "Linear is rate limited. Retry later.",
        Math.min(time + 86_400_000, Math.max(time + 1000, ...candidates)),
      );
    }
    if (stage === "read" && response.status === 401)
      return yield* fail("reconnect_required", "Linear access needs refreshing.");
    if (response.status === 403)
      return yield* fail("forbidden", "This Linear resource is not accessible.");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      error.error ||
      error.errors?.length ||
      value === null
    )
      return yield* fail("unavailable", "Linear could not complete this request.");
    return value;
  },
  (effect) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
      }),
      Effect.timeoutOrElse({
        duration: "3 seconds",
        orElse: () => Effect.fail(fail("unavailable", "Linear took too long to respond.")),
      }),
    ),
);
export const exchange = Effect.fn("workflowSources.linear.exchange")(function* (
  input: { code: string; verifier: string } | { refreshToken: string },
) {
  const config = yield* configuration;
  const refresh = "refreshToken" in input;
  const params = new URLSearchParams({
    client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: Redacted.value(config.clientSecret) } : {}),
    ...(refresh
      ? { grant_type: "refresh_token", refresh_token: input.refreshToken }
      : {
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: config.callbackUrl,
        }),
  });
  const result = yield* request(
    HttpClientRequest.post("https://api.linear.app/oauth/token").pipe(
      HttpClientRequest.bodyText(params.toString(), "application/x-www-form-urlencoded"),
    ),
    refresh ? "refresh" : "code",
  );
  const tokens = yield* decodeTokens(result).pipe(
    Effect.mapError(() => fail("unavailable", "Linear returned invalid credentials.")),
  );
  if (
    tokens.scope
      .split(/[ ,]+/)
      .filter(Boolean)
      .some((s) => s !== "read") ||
    !tokens.scope.split(/[ ,]+/).includes("read")
  )
    return yield* fail(
      "service_configuration",
      "Linear authorization did not have the requested read-only scope.",
    );
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: (yield* now) + tokens.expires_in * 1000,
  };
});
export const graphql = Effect.fn("workflowSources.linear.graphql")(function* <A>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  decode: (value: unknown) => Effect.Effect<{ readonly data: A }, Schema.SchemaError>,
) {
  const req = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post("https://api.linear.app/graphql").pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
    ),
    { query, variables },
  ).pipe(Effect.mapError(() => fail("invalid_input", "Invalid Linear query.")));
  const result = yield* request(req, "read");
  const envelope = yield* decode(result).pipe(
    Effect.mapError(() => fail("unavailable", "Linear returned incomplete data.")),
  );
  return envelope.data;
});
export const identity = (token: string) =>
  graphql(
    token,
    "query WorkflowSourceIdentity { organization { id name } viewer { id name } }",
    {},
    decodeIdentity,
  );
const Page = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ id: Text, name: Text, archivedAt: Schema.NullOr(Schema.String) }),
  ),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Text) }),
});
const Organization = Schema.Struct({ id: Text });
const decodeTeams = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Struct({ organization: Organization, page: Page }) }),
);
const decodeStates = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Organization,
      page: Schema.Struct({ id: Text, page: Page }),
    }),
  }),
);
const decodeLabels = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Organization,
      team: Schema.Struct({ id: Text }),
      page: Page,
    }),
  }),
);
export const metadata = Effect.fn("workflowSources.linear.metadata")(function* (
  token: string,
  workspace: string,
  kind: "teams" | "states" | "labels",
  teamId: string | undefined,
  after: string | null,
  first: number,
) {
  if (kind !== "teams" && !teamId)
    return yield* fail("invalid_input", "Choose a Linear team first.");
  const connection =
    kind === "teams"
      ? "teams(first:$first,after:$after)"
      : kind === "states"
        ? "team(id:$team) { id page: states(first:$first,after:$after)"
        : "issueLabels(first:$first,after:$after,filter:{isGroup:{eq:false},or:[{team:{id:{eq:$team}}},{team:{null:true}}]})";
  const pageFields = "{ nodes { id name archivedAt } pageInfo { hasNextPage endCursor } }";
  const query =
    kind === "states"
      ? `query WorkflowSourceStates($first:Int!,$after:String,$team:String!) { organization {id} page: ${connection} ${pageFields} } }`
      : `query WorkflowSourceMetadata($first:Int!,$after:String${kind === "labels" ? ",$team:String!" : ""}) { organization {id} ${kind === "labels" ? "team(id:$team){id}" : ""} page: ${connection} ${pageFields} }`;
  const result = yield* graphql<
    | Effect.Success<ReturnType<typeof decodeTeams>>["data"]
    | Effect.Success<ReturnType<typeof decodeStates>>["data"]
    | Effect.Success<ReturnType<typeof decodeLabels>>["data"]
  >(token, query, { first, after, ...(teamId ? { team: teamId } : {}) }, (value) =>
    kind === "states"
      ? decodeStates(value)
      : kind === "labels"
        ? decodeLabels(value)
        : decodeTeams(value),
  );
  if (result.organization.id !== workspace)
    return yield* fail("workspace_mismatch", "Linear returned a different workspace.");
  const returnedTeam =
    "id" in result.page ? result.page.id : "team" in result ? result.team.id : null;
  if (kind !== "teams" && returnedTeam !== teamId)
    return yield* fail("unavailable", "Linear returned a different team.");
  const page = "page" in result.page ? result.page.page : result.page;
  if (page.nodes.length > first || (page.pageInfo.hasNextPage && !page.pageInfo.endCursor))
    return yield* fail("unavailable", "Linear returned an invalid metadata page.");
  return {
    items: page.nodes.filter((n) => !n.archivedAt).map(({ id, name }) => ({ id, name })),
    after: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
});
