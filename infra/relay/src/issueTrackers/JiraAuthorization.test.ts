import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { readIssue, listConnections } from "./Connections.ts";
import { encodeJson, fixture, jiraRow, jiraOAuth, membership } from "./Connections.test-fixture.ts";
import {
  completeJira,
  jiraCredentials,
  startJira,
  selectJiraSite,
  cancelJiraSelection,
} from "./JiraAuthorization.ts";
import { exchangeJiraCode, refreshJiraTokens, JiraPendingOAuth } from "./JiraOAuth.ts";

const decodePendingOAuth = Schema.decodeUnknownSync(Schema.fromJsonString(JiraPendingOAuth));
const key = { organizationId: "org", service: "jira" } as const;
const input = {
  organizationId: "org",
  userId: "admin",
};
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      id: Schema.optionalKey(Schema.Number),
      params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
    }),
  ),
);
const siteUrl = "https://launchpad.atlassian.net";
const sites = [
  { id: "cloud", url: siteUrl, name: "Launchpad Jira", scopes: ["read:jira:agent-interface"] },
];
const multipleSites = [
  ...sites,
  { ...sites[0]!, id: "other-cloud", url: "https://other.atlassian.net", name: "Other Jira" },
];
const oauthIssuer = "https://auth.atlassian.com/jira-issuer";
const oauthMetadataUrl =
  "https://auth.atlassian.com/.well-known/oauth-authorization-server/jira-issuer";
const resourceMetadataUrl = "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp";
const tokenEndpoint = "https://auth.atlassian.com/oauth/token";
const oauthMetadata = {
  issuer: oauthIssuer,
  authorization_endpoint: "https://auth.atlassian.com/authorize",
  token_endpoint: tokenEndpoint,
  registration_endpoint: `${oauthIssuer}/dcr/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};
function response(request: HttpClientRequest.HttpClientRequest, resources: unknown = sites) {
  if (request.url === resourceMetadataUrl)
    return Response.json({
      resource: "https://mcp.atlassian.com/v2/mcp",
      authorization_servers: [oauthIssuer],
    });
  if (request.url === oauthMetadataUrl) return Response.json(oauthMetadata);
  if (request.url === oauthMetadata.registration_endpoint)
    return Response.json({
      client_id: "jira-client",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://relay.test/v1/organization/issue-trackers/jira/callback"],
    });
  if (request.url === tokenEndpoint)
    return Response.json({
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "read:jira:agent-interface offline_access",
    });
  if (request.url !== "https://mcp.atlassian.com/v2/mcp")
    return new Response(null, { status: 404 });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.body._tag !== "Uint8Array") throw new Error("Expected MCP request");
  const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  const result =
    rpc.method === "initialize"
      ? { protocolVersion: "2025-11-25" }
      : rpc.params?.name === "getJiraIssue"
        ? {
            structuredContent: {
              key: "LP-42",
              fields: { summary: "OAuth issue", description: "Issue context" },
            },
          }
        : {
            structuredContent: resources,
          };
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
}
const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;

const connected = Effect.fnUntraced(function* () {
  const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
  const started = yield* startJira(input).pipe(test.provide);
  yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
    test.provide,
  );
  return test;
});

describe("Jira OAuth", () => {
  it.effect("connects sites returned in the Rovo v2 resource envelope", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(
            response(request, {
              data: { resources: [{ cloudId: "cloud", url: siteUrl }] },
            }),
          ),
      });
      const started = yield* startJira(input).pipe(test.provide);
      expect(
        yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
          test.provide,
        ),
      ).toEqual({
        status: "connected",
        accountLabel: "launchpad.atlassian.net",
      });
      const active = yield* jiraCredentials(key).pipe(test.provide);
      expect(active.credentials).toMatchObject({ authType: "oauth", cloudId: "cloud", siteUrl });
      expect(active.row.pendingStateHash).toBeNull();
    }),
  );

  it.effect("registers a PKCE client and automatically connects the only Jira site", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
      const started = yield* startJira(input).pipe(test.provide);
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe(oauthMetadata.authorization_endpoint);
      expect(test.requests.map((request) => request.url)).toEqual([
        resourceMetadataUrl,
        oauthMetadataUrl,
        oauthMetadata.registration_endpoint,
      ]);
      expect(url.searchParams.getAll("audience")).toEqual([]);
      expect(url.searchParams.getAll("prompt")).toEqual(["consent"]);
      expect(url.searchParams.get("resource")).toBe("https://mcp.atlassian.com/v2/mcp");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.has("code_verifier")).toBe(false);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([
        "read:me",
        "read:account",
        "offline_access",
        "email",
        "read:jira:agent-interface",
      ]);
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://relay.test/v1/organization/issue-trackers/jira/callback",
      );
      expect(started.connection.authorization?.id).toBe(started.authorizationId);
      const state = stateFrom(started.authorizationUrl);
      expect(yield* completeJira({ state, code: "code" }).pipe(test.provide)).toEqual({
        status: "connected",
        accountLabel: "Launchpad Jira",
      });
      const active = yield* jiraCredentials(key).pipe(test.provide);
      expect(active.credentials).toMatchObject({
        authType: "oauth",
        cloudId: "cloud",
        siteUrl,
        oauth: { client: { client_id: "jira-client" }, server: { token_endpoint: tokenEndpoint } },
      });
      expect(active.row.pendingStateHash).toBeNull();
      const requestsBeforeReplay = test.requests.length;
      expect(
        yield* completeJira({ state, code: "code" }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(test.requests).toHaveLength(requestsBeforeReplay);
    }),
  );

  it.effect.each([
    ["issuer", { ...oauthMetadata, issuer: "https://auth.atlassian.com/other-issuer" }],
    ["endpoint", { ...oauthMetadata, token_endpoint: "https://untrusted.example/token" }],
    ["PKCE", { ...oauthMetadata, code_challenge_methods_supported: ["plain"] }],
  ] as const)("rejects incompatible %s metadata before registration", ([_name, metadata]) =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(
            request.url === oauthMetadataUrl ? Response.json(metadata) : response(request),
          ),
      });
      expect(yield* startJira(input).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "unavailable",
      });
      expect(test.requests.map((request) => request.url)).toEqual([
        resourceMetadataUrl,
        oauthMetadataUrl,
      ]);
      expect(yield* test.store.get(key)).toBeNull();
    }),
  );

  it.effect("rejects metadata for a different resource before registering a client", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: () =>
          Effect.succeed(
            Response.json({
              resource: "https://other.example/mcp",
              authorization_servers: [oauthIssuer],
            }),
          ),
      });
      expect(yield* startJira(input).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "unavailable",
      });
      expect(test.requests.every((request) => request.method === "GET")).toBe(true);
      expect(yield* test.store.get(key)).toBeNull();
    }),
  );

  it.effect("retains the discovered token endpoint for exchange and refresh", () =>
    Effect.gen(function* () {
      const originalEndpoint = "https://auth.atlassian.com/original/token";
      let callbackStarted = false;
      const test = yield* fixture({
        respond: (request) => {
          if (request.url === oauthMetadataUrl) {
            expect(callbackStarted).toBe(false);
            return Effect.succeed(
              Response.json({ ...oauthMetadata, token_endpoint: originalEndpoint }),
            );
          }
          if (request.url === originalEndpoint) {
            return Effect.succeed(response({ ...request, url: tokenEndpoint }));
          }
          return Effect.succeed(response(request));
        },
      });
      const started = yield* startJira(input).pipe(test.provide);
      callbackStarted = true;
      yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
        test.provide,
      );
      yield* TestClock.adjust("60 minutes");
      yield* jiraCredentials(key).pipe(test.provide);
      const tokenRequests = test.requests.filter((request) => request.url === originalEndpoint);
      expect(tokenRequests).toHaveLength(2);
      for (const request of tokenRequests) {
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") {
          expect(
            new URLSearchParams(new TextDecoder().decode(request.body.body)).get("resource"),
          ).toBe("https://mcp.atlassian.com/v2/mcp");
        }
      }
    }),
  );

  it.effect("declining authorization clears the pending attempt", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
      const started = yield* startJira(input).pipe(test.provide);
      expect(
        yield* completeJira({ state: stateFrom(started.authorizationUrl), code: null }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "invalid_input" });
      expect(yield* test.store.get(key)).toBeNull();
      expect(test.requests).toHaveLength(3);
    }),
  );

  it.effect("rejects expired and tampered state before exchanging a code", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
      const started = yield* startJira(input).pipe(test.provide);
      const state = stateFrom(started.authorizationUrl);
      expect(
        yield* completeJira({ state: state + "tampered", code: "code" }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "conflict" });
      yield* TestClock.adjust("16 minutes");
      expect(
        yield* completeJira({ state, code: "code" }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(test.requests).toHaveLength(3);
    }),
  );

  it.effect("does not authorize a different organization or a non-admin", () =>
    Effect.gen(function* () {
      for (const entry of [
        { ...membership, role: "member" as const },
        { ...membership, organization: { ...membership.organization, organizationId: "other" } },
      ]) {
        const test = yield* fixture({ membership: Effect.succeed(entry) });
        expect(yield* startJira(input).pipe(test.provide, Effect.flip)).toMatchObject({
          code: "forbidden",
        });
        expect(test.requests).toHaveLength(0);
      }
    }),
  );

  it.effect("rejects a grant with no eligible Jira sites", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(
            response(request, [{ ...sites[0]!, scopes: ["read:confluence:agent-interface"] }]),
          ),
      });
      const started = yield* startJira(input).pipe(test.provide);
      expect(
        yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(yield* test.store.get(key)).toBeNull();
    }),
  );

  it.effect.each(["disconnect", "new attempt"] as const)(
    "an in-flight callback cannot undo %s",
    (action) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const test = yield* fixture({
          respond: (request) =>
            request.url.endsWith("/token")
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(response(request)),
                )
              : Effect.succeed(response(request)),
        });
        const started = yield* startJira(input).pipe(test.provide);
        const callback = yield* completeJira({
          state: stateFrom(started.authorizationUrl),
          code: "code",
        }).pipe(test.provide, Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        if (action === "disconnect") yield* test.store.remove(key);
        else yield* startJira(input).pipe(test.provide);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
        const row = yield* test.store.get(key);
        if (action === "disconnect") expect(row).toBeNull();
        else expect(row?.pendingStateHash).not.toBeNull();
      }),
  );

  it.effect("preserves the active grant while a replacement authorization is abandoned", () =>
    Effect.gen(function* () {
      const test = yield* connected();
      const previous = yield* test.store.get(key);
      const next = yield* startJira(input).pipe(test.provide);
      expect((yield* test.store.get(key))?.version).toBe(previous?.version);
      yield* completeJira({ state: stateFrom(next.authorizationUrl), code: null }).pipe(
        test.provide,
        Effect.flip,
      );
      expect((yield* jiraCredentials(key).pipe(test.provide)).row.payloadSealed).toBe(
        previous?.payloadSealed,
      );
    }),
  );

  it.effect("rotates expiring credentials once across concurrent reads", () =>
    Effect.gen(function* () {
      const test = yield* connected();
      const version = (yield* test.store.get(key))?.version;
      yield* TestClock.adjust("60 minutes");
      const values = yield* Effect.all([jiraCredentials(key), jiraCredentials(key)], {
        concurrency: 2,
      }).pipe(test.provide);
      expect(values).toHaveLength(2);
      expect(test.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      expect((yield* test.store.get(key))?.version).toBe(version);
    }),
  );

  it.effect("retains a refresh token when the provider does not rotate it", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: () =>
          Effect.succeed(
            Response.json({ access_token: "next", token_type: "Bearer", expires_in: 3600 }),
          ),
      });
      expect(
        yield* refreshJiraTokens({ oauth: jiraOAuth, refreshToken: "old" }).pipe(test.provide),
      ).toMatchObject({ accessToken: "next", refreshToken: "old" });
    }),
  );

  it.effect("fails safely for revoked grants without exposing upstream details", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: () =>
          Effect.succeed(
            Response.json(
              { error: "invalid_grant", error_description: "private secret" },
              { status: 400 },
            ),
          ),
      });
      const error = yield* exchangeJiraCode({
        ...jiraOAuth,
        redirectUri: "https://relay.test/callback",
        code: "code",
        codeVerifier: "verifier",
      }).pipe(test.provide, Effect.flip);
      expect(error.code).toBe("auth_required");
      expect(error.message).not.toContain("private secret");
    }),
  );
});

it.effect("uses the saved OAuth grant through the real issue-read orchestration", () =>
  Effect.gen(function* () {
    const test = yield* connected();
    const result = yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide);
    expect(result).toMatchObject({
      service: "jira",
      identifier: "LP-42",
      title: "OAuth issue",
      accountLabel: "Launchpad Jira",
    });
    const requests = test.requests.filter(
      (request) => request.url === "https://mcp.atlassian.com/v2/mcp",
    );
    expect(
      requests.every((request) => request.headers.authorization === "Bearer oauth-access"),
    ).toBe(true);
    expect(encodeJson(result)).not.toContain("oauth-access");
  }),
);

it.effect("marks revoked OAuth credentials for reconnect through issue reads", () =>
  Effect.gen(function* () {
    const original = yield* connected();
    const row = (yield* original.store.get(key))!;
    const test = yield* fixture({
      rows: [row],
      respond: () => Effect.succeed(new Response(null, { status: 401 })),
    });
    expect(
      yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide, Effect.flip),
    ).toMatchObject({ code: "auth_required" });
    expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
  }),
);

it.effect.each(["invalid_client", "invalid_grant", "invalid_token"])(
  "requires reconnect when refreshing Jira returns %s",
  (error) =>
    Effect.gen(function* () {
      const original = yield* connected();
      const row = (yield* original.store.get(key))!;
      yield* TestClock.adjust("60 minutes");
      const test = yield* fixture({
        rows: [row],
        respond: () => Effect.succeed(Response.json({ error }, { status: 400 })),
      });
      expect(
        yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "auth_required" });
      expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
    }),
);

it.effect("keeps the Jira connection during a temporary token endpoint outage", () =>
  Effect.gen(function* () {
    const original = yield* connected();
    const row = (yield* original.store.get(key))!;
    yield* TestClock.adjust("60 minutes");
    const test = yield* fixture({
      rows: [row],
      respond: () => Effect.succeed(new Response(null, { status: 503 })),
    });
    expect(
      yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide, Effect.flip),
    ).toMatchObject({ code: "unavailable" });
    expect(yield* test.store.get(key)).toEqual(row);
  }),
);

it.effect("rejects saved credentials without an OAuth grant before calling Atlassian", () =>
  Effect.gen(function* () {
    const row = {
      ...jiraRow(),
      payloadSealed: `sealed:${encodeJson({ service: "jira", apiKey: "unsupported-key", siteUrl, cloudId: "cloud" })}`,
    };
    const test = yield* fixture({ rows: [row] });
    expect(
      yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide, Effect.flip),
    ).toMatchObject({
      code: "auth_required",
    });
    expect(test.requests).toHaveLength(0);
    expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
  }),
);

it.effect.each(["interrupt", "deadline"] as const)(
  "cleans up pending Jira OAuth exchange after %s",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const test = yield* fixture({
        respond: (request) =>
          request.url.endsWith("/token")
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(response(request)),
      });
      const started = yield* startJira(input).pipe(test.provide);
      const callback = yield* completeJira({
        state: stateFrom(started.authorizationUrl),
        code: "code",
      }).pipe(test.provide, Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      if (mode === "interrupt") yield* Fiber.interrupt(callback);
      else {
        yield* TestClock.adjust("8 seconds");
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "unavailable" });
      }
      expect(yield* test.store.get(key)).toBeNull();
    }),
);

describe("Jira site selection", () => {
  const choose = { ...input, cloudId: "other-cloud" };
  const pendingSelection = Effect.fnUntraced(function* (active = false) {
    const test = yield* fixture({
      rows: active ? [jiraRow()] : [],
      respond: (request) => Effect.succeed(response(request, multipleSites)),
    });
    const started = yield* startJira(input).pipe(test.provide);
    expect(
      yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
        test.provide,
      ),
    ).toEqual({ status: "awaiting_site_selection" });
    return { ...test, authorizationId: started.authorizationId };
  });

  it.effect("persists the choices, hides them from members, and connects the selected site", () =>
    Effect.gen(function* () {
      const test = yield* pendingSelection();
      const admin = yield* listConnections("org", true).pipe(test.provide);
      expect(admin.connections[0]?.authorization?.phase).toBe("selecting_site");
      expect(admin.connections[0]?.jiraSites).toHaveLength(2);
      expect(encodeJson(admin)).not.toContain("oauth-access");
      expect(encodeJson(admin)).not.toContain("oauth-refresh");
      const member = yield* listConnections("org").pipe(test.provide);
      expect(member.connections[0]?.jiraSites).toBeUndefined();
      expect((yield* test.store.get(key))?.status).toBe("connecting");
      const requestsBefore = test.requests.length;
      yield* selectJiraSite({ ...choose, authorizationId: test.authorizationId }).pipe(
        test.provide,
      );
      expect(test.requests.length).toBeGreaterThan(requestsBefore);
      const credentials = yield* jiraCredentials(key).pipe(test.provide);
      expect(credentials.credentials).toMatchObject({
        cloudId: "other-cloud",
        siteUrl: "https://other.atlassian.net",
      });
      expect(credentials.row.jiraSelection).toBeNull();
      expect(credentials.row.authorizationId).toBeNull();
      expect(
        yield* selectJiraSite({ ...choose, authorizationId: test.authorizationId }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "conflict" });
    }),
  );

  it.effect("deduplicates cloud IDs before deciding whether to show a picker", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(response(request, [sites[0]!, { ...sites[0]!, url: siteUrl + "/" }])),
      });
      const started = yield* startJira(input).pipe(test.provide);
      expect(
        yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
          test.provide,
        ),
      ).toMatchObject({ status: "connected" });
      expect((yield* test.store.get(key))?.jiraSelection).toBeNull();
    }),
  );

  it.effect("rejects arbitrary choices and attempts belonging to a different organization", () =>
    Effect.gen(function* () {
      const test = yield* pendingSelection();
      const previous = yield* test.store.get(key);
      const requestsBefore = test.requests.length;
      expect(
        yield* selectJiraSite({
          ...choose,
          authorizationId: test.authorizationId,
          cloudId: "unlisted",
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "invalid_input" });
      expect(
        yield* selectJiraSite({
          ...choose,
          authorizationId: test.authorizationId,
          organizationId: "other-org",
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "forbidden" });
      expect(yield* test.store.get(key)).toEqual(previous);
      expect(test.requests).toHaveLength(requestsBefore);
    }),
  );

  it.effect(
    "rechecks site access before saving and retains the previous connection on failure",
    () =>
      Effect.gen(function* () {
        const pending = yield* pendingSelection(true);
        const row = (yield* pending.store.get(key))!;
        const test = yield* fixture({
          rows: [row],
          respond: (request) => Effect.succeed(response(request, sites)),
        });
        expect(
          yield* selectJiraSite({ ...choose, authorizationId: pending.authorizationId }).pipe(
            test.provide,
            Effect.flip,
          ),
        ).toMatchObject({ code: "forbidden" });
        expect(yield* test.store.get(key)).toEqual(row);
      }),
  );

  it.effect.each([false, true])(
    "cancelling the picker preserves an active connection: %s",
    (active) =>
      Effect.gen(function* () {
        const test = yield* pendingSelection(active);
        if (active) {
          expect(yield* readIssue({ ...key, issue: "LP-42" }).pipe(test.provide)).toMatchObject({
            title: "OAuth issue",
          });
        }
        yield* cancelJiraSelection({ ...input, authorizationId: test.authorizationId }).pipe(
          test.provide,
        );
        const row = yield* test.store.get(key);
        if (active) {
          expect(row?.payloadSealed).toBe(jiraRow().payloadSealed);
          expect(row?.jiraSelection).toBeNull();
          expect(row?.authorizationId).toBeNull();
        } else expect(row).toBeNull();
      }),
  );

  it.effect.each(["select", "list"] as const)(
    "expires the pending grant when handled by %s",
    (action) =>
      Effect.gen(function* () {
        const test = yield* pendingSelection(true);
        yield* TestClock.adjust("15 minutes");
        if (action === "select") {
          expect(
            yield* selectJiraSite({ ...choose, authorizationId: test.authorizationId }).pipe(
              test.provide,
              Effect.flip,
            ),
          ).toMatchObject({ code: "conflict" });
        } else yield* listConnections("org", true).pipe(test.provide);
        const row = yield* test.store.get(key);
        expect(row?.jiraSelection).toBeNull();
        expect(row?.payloadSealed).toBe(jiraRow().payloadSealed);
      }),
  );

  it.effect("does not keep a picker beyond the OAuth access token's lifetime", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(
            request.url.endsWith("/token")
              ? Response.json({
                  access_token: "oauth-access",
                  refresh_token: "refresh",
                  expires_in: 30,
                  token_type: "Bearer",
                })
              : response(request, multipleSites),
          ),
      });
      const started = yield* startJira(input).pipe(test.provide);
      yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
        test.provide,
      );
      yield* TestClock.adjust("30 seconds");
      expect((yield* listConnections("org", true).pipe(test.provide)).connections).toEqual([]);
    }),
  );

  it.effect("rejects selection and cancellation after the caller loses admin access", () =>
    Effect.gen(function* () {
      const pending = yield* pendingSelection();
      const row = (yield* pending.store.get(key))!;
      const test = yield* fixture({
        rows: [row],
        membership: Effect.succeed({ ...membership, role: "member" }),
      });
      expect(
        yield* selectJiraSite({ ...choose, authorizationId: pending.authorizationId }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(
        yield* cancelJiraSelection({ ...input, authorizationId: pending.authorizationId }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "forbidden" });
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect.each(["disconnect", "new attempt", "cancel", "other selection"] as const)(
    "an in-flight selection cannot undo %s",
    (action) =>
      Effect.gen(function* () {
        const pending = yield* pendingSelection();
        const row = (yield* pending.store.get(key))!;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        const test = yield* fixture({
          rows: [row],
          respond: (request) => {
            if (request.url === "https://mcp.atlassian.com/v2/mcp" && !held) {
              held = true;
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(response(request, multipleSites)),
              );
            }
            return Effect.succeed(response(request, multipleSites));
          },
        });
        const selection = { ...choose, authorizationId: pending.authorizationId };
        const selecting = yield* selectJiraSite(selection).pipe(
          test.provide,
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        if (action === "disconnect") yield* test.store.remove(key);
        else if (action === "new attempt") {
          yield* startJira(input).pipe(test.provide);
        } else if (action === "cancel") yield* cancelJiraSelection(selection).pipe(test.provide);
        else yield* selectJiraSite({ ...selection, cloudId: "cloud" }).pipe(test.provide);
        const after = yield* test.store.get(key);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(selecting)).toMatchObject({ code: "conflict" });
        expect(yield* test.store.get(key)).toEqual(after);
      }),
  );
});

it.effect(
  "resumes a persisted OAuth attempt on another relay instance without exposing PKCE in state",
  () =>
    Effect.gen(function* () {
      const first = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
      const started = yield* startJira(input).pipe(first.provide);
      const state = stateFrom(started.authorizationUrl);
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const pending = (yield* first.store.get(key))!;
      expect(pending.pendingOAuthSealed).toContain("sealed:");
      expect(pending.payloadSealed).toBeNull();
      expect(encodeJson(started)).not.toContain("codeVerifier");
      const second = yield* fixture({
        rows: [pending],
        respond: (request) => Effect.succeed(response(request)),
      });
      yield* completeJira({ state, code: "code" }).pipe(second.provide);
      expect(second.requests[0]?.url).toBe(tokenEndpoint);
      expect((yield* second.store.get(key))?.pendingOAuthSealed).toBeNull();
    }),
);

it.effect.each(["https://auth.atlassian.com/wrong-issuer", ""])(
  "rejects a mismatched callback issuer before redeeming the code: %s",
  (iss) =>
    Effect.gen(function* () {
      const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
      const started = yield* startJira(input).pipe(test.provide);
      const before = test.requests.length;
      yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code", iss }).pipe(
        test.provide,
        Effect.flip,
      );
      expect(test.requests).toHaveLength(before);
      expect(yield* test.store.get(key)).toBeNull();
    }),
);

it.effect("handles explicit OAuth denial even when a code is also present", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ respond: (request) => Effect.succeed(response(request)) });
    const started = yield* startJira(input).pipe(test.provide);
    const before = test.requests.length;
    expect(
      yield* completeJira({
        state: stateFrom(started.authorizationUrl),
        code: "code",
        error: "access_denied",
      }).pipe(test.provide, Effect.flip),
    ).toMatchObject({ code: "invalid_input" });
    expect(test.requests).toHaveLength(before);
    expect(yield* test.store.get(key)).toBeNull();
  }),
);

it.effect("requires an issuer when the authorization server advertised it", () =>
  Effect.gen(function* () {
    const test = yield* fixture({
      respond: (request) =>
        Effect.succeed(
          request.url === oauthMetadataUrl
            ? Response.json({
                ...oauthMetadata,
                authorization_response_iss_parameter_supported: true,
              })
            : response(request),
        ),
    });
    const started = yield* startJira(input).pipe(test.provide);
    const before = test.requests.length;
    yield* completeJira({ state: stateFrom(started.authorizationUrl), code: "code" }).pipe(
      test.provide,
      Effect.flip,
    );
    expect(test.requests).toHaveLength(before);
  }),
);

it.effect.each(["redirect", "oversized"] as const)(
  "rejects a %s token response without following it or retrying the code",
  (mode) =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: () =>
          Effect.succeed(
            mode === "redirect"
              ? new Response(null, {
                  status: 302,
                  headers: { location: "https://untrusted.example/token" },
                })
              : new Response("x".repeat(65_537)),
          ),
      });
      expect(
        yield* exchangeJiraCode({
          ...jiraOAuth,
          redirectUri: "https://relay.test/callback",
          codeVerifier: "verifier",
          code: "private-code",
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "unavailable" });
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.url).toBe(tokenEndpoint);
    }),
);

it.effect("debug logs include OAuth request IDs without credentials or callback secrets", () => {
  const logs: Array<unknown> = [];
  const logger = Logger.make(({ message }) => {
    logs.push(message);
  });
  return Effect.gen(function* () {
    const test = yield* fixture({
      respond: (request) => {
        const result = response(request);
        result.headers.set("atl-request-id", "diagnostic-request-id");
        result.headers.set("atl-traceid", "diagnostic-trace-id");
        result.headers.set("set-cookie", "private-cookie");
        return Effect.succeed(result);
      },
    });
    const started = yield* startJira(input).pipe(test.provide);
    const state = stateFrom(started.authorizationUrl);
    const pending = (yield* test.store.get(key))!;
    const privatePending = decodePendingOAuth(pending.pendingOAuthSealed!.slice("sealed:".length));
    yield* completeJira({ state, code: "private-authorization-code", iss: oauthIssuer }).pipe(
      test.provide,
    );
    const output = encodeJson(logs);
    for (const milestone of [
      "Jira OAuth authorization ready",
      "Jira OAuth callback matched",
      "Jira OAuth sites verified",
      "Jira OAuth callback completed",
      "diagnostic-request-id",
      "diagnostic-trace-id",
      started.authorizationId,
    ])
      expect(output).toContain(milestone);
    for (const secret of [
      state,
      privatePending.codeVerifier,
      "jira-client",
      "oauth-access",
      "oauth-refresh",
      "private-cookie",
      "private-authorization-code",
    ])
      expect(output).not.toContain(secret);
  }).pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  );
});

it.effect("logs only the OAuth error category when the token exchange fails", () => {
  const logs: Array<unknown> = [];
  const logger = Logger.make(({ message }) => {
    logs.push(message);
  });
  return Effect.gen(function* () {
    const test = yield* fixture({
      respond: () =>
        Effect.succeed(
          Response.json(
            {
              error: "invalid_grant",
              error_description: "private-provider-error",
            },
            { status: 400 },
          ),
        ),
    });
    yield* exchangeJiraCode({
      ...jiraOAuth,
      redirectUri: "https://relay.test/callback",
      codeVerifier: "private-verifier",
      code: "private-code",
    }).pipe(test.provide, Effect.flip);
    const output = encodeJson(logs);
    expect(output).toContain("Jira OAuth stage failed");
    expect(output).toContain("invalid_grant");
    for (const secret of ["private-provider-error", "private-verifier", "private-code"])
      expect(output).not.toContain(secret);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});
