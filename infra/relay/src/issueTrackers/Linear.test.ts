import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

import {
  exchangeLinearCode,
  getLinearIdentity,
  linearAuthorizationUrl,
  readLinearIssue,
  refreshLinearTokens,
  revokeLinearToken,
} from "./Linear.ts";

const tokenInput = { clientId: "client", clientSecret: "client-secret" };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeFailure = Schema.encodeSync(Schema.fromJsonString(IssueTrackerFailure));
const issueInput = {
  accessToken: "access-secret",
  workspaceId: "workspace-id",
  workspaceSlug: "launchpad",
  issue: "LP-42",
};
const workspace = { id: "workspace-id", name: "Launchpad", urlKey: "launchpad" };
const issue = {
  id: "issue-id",
  identifier: "LP-42",
  title: "Connect issue trackers",
  description: "Read issues from chat.",
  url: "https://linear.app/launchpad/issue/LP-42/connect-issue-trackers",
  state: { name: "In Progress" },
  assignee: { name: "Alice" },
};
const tokenResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 86400,
};
const graphqlResponse = (entry: typeof issue | null = issue) =>
  Response.json({ data: { organization: workspace, issue: entry } });

function mockHttp(responses: Response[]) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = responses.shift();
    return response
      ? Effect.succeed(HttpClientResponse.fromWeb(request, response))
      : Effect.die("Unexpected Linear request");
  });
  return { requests, provide: Effect.provideService(HttpClient.HttpClient, client) };
}

function requestText(request: HttpClientRequest.HttpClientRequest | undefined) {
  expect(request?.body._tag).toBe("Uint8Array");
  return request?.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
}

const decodeQuery = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

describe("Linear authorization", () => {
  it("requests an organization app with read scope and PKCE", () => {
    const url = new URL(
      linearAuthorizationUrl({
        clientId: "client",
        redirectUri: "https://relay.test/oauth/linear/callback",
        state: "state",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client",
      redirect_uri: "https://relay.test/oauth/linear/callback",
      response_type: "code",
      state: "state",
      scope: "read",
      actor: "app",
      prompt: "consent",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
  });

  it.effect("exchanges a code and returns rotated refresh tokens", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        Response.json(tokenResponse),
        Response.json({ ...tokenResponse, refresh_token: "rotated-refresh" }),
      ]);
      expect(
        yield* exchangeLinearCode({
          ...tokenInput,
          redirectUri: "https://relay.test/callback",
          code: "auth-code",
          codeVerifier: "verifier",
        }).pipe(http.provide),
      ).toEqual({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 86400 });
      expect(
        yield* refreshLinearTokens({ ...tokenInput, refreshToken: "old-refresh" }).pipe(
          http.provide,
        ),
      ).toEqual({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 86400 });
      expect(http.requests.map((request) => request.url)).toEqual([
        "https://api.linear.app/oauth/token",
        "https://api.linear.app/oauth/token",
      ]);
      expect(new URLSearchParams(requestText(http.requests[0])).get("code_verifier")).toBe(
        "verifier",
      );
      expect(new URLSearchParams(requestText(http.requests[1])).get("refresh_token")).toBe(
        "old-refresh",
      );
      expect(http.requests[0]?.headers["content-type"]).toContain(
        "application/x-www-form-urlencoded",
      );
    }),
  );

  it.effect("reports expired refresh authorization without exposing upstream secrets", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        Response.json(
          { error: "invalid_grant", error_description: "client-secret old-refresh" },
          { status: 400 },
        ),
      ]);
      const failure = yield* refreshLinearTokens({
        ...tokenInput,
        refreshToken: "old-refresh",
      }).pipe(http.provide, Effect.flip);
      expect(failure.code).toBe("auth_required");
      expect(encodeFailure(failure)).not.toContain("secret");
      expect(encodeFailure(failure)).not.toContain("old-refresh");
    }),
  );

  it.effect.each([
    { ...tokenResponse, expires_in: 0 },
    { access_token: "secret", expires_in: 86400 },
    { ...tokenResponse, refresh_token: "" },
  ])("rejects malformed token responses %#", (body) =>
    Effect.gen(function* () {
      const http = mockHttp([Response.json(body)]);
      const failure = yield* refreshLinearTokens({ ...tokenInput, refreshToken: "refresh" }).pipe(
        http.provide,
        Effect.flip,
      );
      expect(failure.code).toBe("unavailable");
    }),
  );

  it.effect("identifies the connected workspace and app account", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        Response.json({ data: { organization: workspace, viewer: { name: "Launchpad Agent" } } }),
      ]);
      expect(yield* getLinearIdentity({ accessToken: "access-secret" }).pipe(http.provide)).toEqual(
        {
          workspaceId: "workspace-id",
          workspaceName: "Launchpad",
          workspaceSlug: "launchpad",
          accountLabel: "Launchpad · Launchpad Agent",
        },
      );
      expect(http.requests[0]?.headers.authorization).toBe("Bearer access-secret");
    }),
  );

  it.effect("revokes with the supported token form field and accepts an empty body", () =>
    Effect.gen(function* () {
      const http = mockHttp([new Response(null, { status: 200 })]);
      yield* revokeLinearToken({ ...tokenInput, token: "refresh-secret" }).pipe(http.provide);
      expect(http.requests[0]?.url).toBe("https://api.linear.app/oauth/revoke");
      expect(Object.fromEntries(new URLSearchParams(requestText(http.requests[0])))).toEqual({
        token: "refresh-secret",
        client_id: "client",
        client_secret: "client-secret",
      });
    }),
  );
});

describe("Linear issue reading", () => {
  it.effect.each(["lp-42", "https://linear.app/launchpad/issue/LP-42/connect-issue-trackers"])(
    "reads %s using a bounded issue query",
    (reference) =>
      Effect.gen(function* () {
        const http = mockHttp([graphqlResponse()]);
        expect(
          yield* readLinearIssue({ ...issueInput, issue: reference }).pipe(http.provide),
        ).toEqual({
          issueId: "issue-id",
          identifier: "LP-42",
          title: issue.title,
          description: issue.description,
          originalDescription: issue.description,
          url: issue.url,
          status: "In Progress",
          assignee: "Alice",
        });
        const request = decodeQuery(requestText(http.requests[0]));
        expect(request.variables).toEqual({ id: "LP-42" });
        expect(request.query).toContain("organization { id name urlKey }");
        expect(http.requests[0]?.url).toBe("https://api.linear.app/graphql");
      }),
  );

  it.effect.each([
    "https://linear.app/other-workspace/issue/LP-42/title",
    "https://linear.app.attacker.test/launchpad/issue/LP-42",
    "http://linear.app/launchpad/issue/LP-42",
    "https://user:password@linear.app/launchpad/issue/LP-42",
    "https://linear.app/launchpad/project/LP-42",
    "LP-42\nquery { secrets }",
  ])("rejects invalid or foreign workspace references before requesting: %s", (reference) =>
    Effect.gen(function* () {
      const http = mockHttp([]);
      const failure = yield* readLinearIssue({ ...issueInput, issue: reference }).pipe(
        http.provide,
        Effect.flip,
      );
      expect(failure.code).toBe("invalid_input");
      expect(http.requests).toHaveLength(0);
    }),
  );

  it.effect("refuses a token whose workspace identity changed", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        Response.json({ data: { organization: { ...workspace, id: "other-workspace" }, issue } }),
      ]);
      const failure = yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip);
      expect(failure.code).toBe("forbidden");
      expect(encodeFailure(failure)).not.toContain(issue.description);
    }),
  );

  it.effect("handles missing issues and nullable display fields", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        graphqlResponse(null),
        Response.json({
          data: {
            organization: workspace,
            issue: { ...issue, description: null, state: null, assignee: null },
          },
        }),
      ]);
      expect((yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip)).code).toBe(
        "not_found",
      );
      expect(yield* readLinearIssue(issueInput).pipe(http.provide)).toMatchObject({
        description: "",
        status: null,
        assignee: null,
      });
    }),
  );

  it.effect("truncates long descriptions with an explicit notice", () =>
    Effect.gen(function* () {
      const http = mockHttp([graphqlResponse({ ...issue, description: "x".repeat(30_000) })]);
      const details = yield* readLinearIssue(issueInput).pipe(http.provide);
      expect(details.description.startsWith("x".repeat(20_000))).toBe(true);
      expect(details.description).toContain("Description truncated by Launchpad");
      expect(details.description.length).toBeLessThan(21_000);
    }),
  );

  it.effect.each([
    { extensions: { code: "AUTHENTICATION_ERROR" }, expected: "auth_required" },
    { extensions: { type: "authentication error" }, expected: "auth_required" },
    { extensions: { type: "forbidden" }, expected: "forbidden" },
    { extensions: { type: "invalid input" }, expected: "invalid_input" },
    { extensions: { code: "FORBIDDEN" }, expected: "forbidden" },
    { extensions: { code: "ENTITY_NOT_FOUND" }, expected: "not_found" },
    { extensions: { code: "RATELIMITED" }, expected: "unavailable" },
  ])(
    "classifies GraphQL errors without returning partial data: $expected",
    ({ extensions, expected }) =>
      Effect.gen(function* () {
        const http = mockHttp([
          Response.json({
            data: { organization: workspace, issue },
            errors: [{ extensions, message: "access-secret provider details" }],
          }),
        ]);
        const failure = yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip);
        expect(failure.code).toBe(expected);
        expect(encodeFailure(failure)).not.toContain("access-secret");
      }),
  );

  it.effect.each([
    { status: 401, expected: "auth_required" },
    { status: 403, expected: "forbidden" },
    { status: 404, expected: "not_found" },
    { status: 429, expected: "unavailable" },
    { status: 503, expected: "unavailable" },
  ])("classifies HTTP $status", ({ status, expected }) =>
    Effect.gen(function* () {
      const http = mockHttp([new Response("access-secret", { status })]);
      const failure = yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip);
      expect(failure.code).toBe(expected);
      expect(encodeFailure(failure)).not.toContain("access-secret");
    }),
  );

  it.effect("rejects oversized chunked responses without trusting Content-Length", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(200_000)));
            controller.enqueue(new TextEncoder().encode("x".repeat(100_000)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      const http = mockHttp([response]);
      expect((yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip)).code).toBe(
        "unavailable",
      );
      expect(cancelled).toBe(true);
    }),
  );

  it.effect("rejects malformed JSON and foreign URLs returned by Linear", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        new Response("{broken"),
        graphqlResponse({ ...issue, url: "https://attacker.test/issue/LP-42" }),
      ]);
      expect((yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip)).code).toBe(
        "unavailable",
      );
      expect((yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip)).code).toBe(
        "unavailable",
      );
    }),
  );

  it.effect("classifies GraphQL authentication errors returned with HTTP 400", () =>
    Effect.gen(function* () {
      const http = mockHttp([
        Response.json(
          { errors: [{ extensions: { type: "authentication error" } }] },
          { status: 400 },
        ),
      ]);
      expect((yield* readLinearIssue(issueInput).pipe(http.provide, Effect.flip)).code).toBe(
        "auth_required",
      );
    }),
  );

  it.effect("bounds stalled requests using the test clock", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const http = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const request = yield* readLinearIssue(issueInput).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(request)).code).toBe("unavailable");
    }),
  );
});

it.effect("bounds escaped issue text without losing the source link", () =>
  Effect.gen(function* () {
    const http = mockHttp([graphqlResponse({ ...issue, description: "\u0000".repeat(20_000) })]);
    const { originalDescription, ...result } = yield* readLinearIssue(issueInput).pipe(
      http.provide,
    );
    expect(originalDescription).toBe("\u0000".repeat(20_000));
    expect(result.url).toBe(issue.url);
    expect(result.description).toContain("Description truncated");
    expect(new TextEncoder().encode(encodeJson(result)).length).toBeLessThanOrEqual(48 * 1024);
  }),
);
