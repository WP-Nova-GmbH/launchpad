import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { RelaySecretBox, SecretBoxError } from "../auth/SecretBox.ts";

import {
  completeLinear,
  disconnect,
  listConnections,
  readIssue,
  searchIssues,
  readComments,
  readImages,
  viewImage,
  startLinear,
} from "./Connections.ts";

import {
  encodeJson,
  recordKey,
  fixture,
  key,
  issueInput,
  linearRow,
  jiraRow,
  jiraOAuth,
  issueResponse,
  identityResponse,
  tokenResponse,
  toolName,
  linearOAuth,
} from "./Connections.test-fixture.ts";

const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, id: Schema.optionalKey(Schema.Number) }),
  ),
);
function jiraResponse(request: HttpClientRequest.HttpClientRequest) {
  if (request.method === "GET") return new Response(null, { status: 405 });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.body._tag !== "Uint8Array") throw new Error("Expected Jira request body");
  const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
  if (rpc.method === "initialize")
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "Jira", version: "1" },
      },
    });
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  return Response.json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: {
      structuredContent: { key: "LP-42", fields: { summary: "Example", description: "Read this" } },
    },
  });
}

describe("issue tracker connection lifecycle", () => {
  it.effect("uses the verified OAuth write profile without a separate switch", () =>
    Effect.gen(function* () {
      const readOnly = yield* fixture({ rows: [linearRow()] });
      expect((yield* listConnections("org").pipe(readOnly.provide)).connections[0]).toMatchObject({
        writesAvailable: false,
      });
      expect((yield* readOnly.store.get(key))?.writesEnabled).toBe(false);

      const row = {
        ...linearRow(),
        authorizationId: "pending-upgrade",
        pendingStateHash: "pending-state",
        pendingOAuthSealed: "sealed:pending",
        pendingExpiresAt: "2027-01-01T00:00:00.000Z",
        payloadSealed: `sealed:${encodeJson({
          service: "linear",
          oauth: { ...linearOAuth, resource: "https://mcp.linear.app/mcp" },
          accountId: "account",
          accessToken: "write-access",
          refreshToken: "write-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          workspaceId: "workspace",
          workspaceSlug: "launchpad",
          scopes: ["read", "write"],
        })}`,
      };
      const test = yield* fixture({ rows: [row], respond: () => Effect.succeed(issueResponse()) });
      expect((yield* listConnections("org").pipe(test.provide)).connections[0]).toMatchObject({
        writesAvailable: true,
      });
      const enabled = (yield* test.store.get(key))!;
      expect(enabled.writesEnabled).toBe(true);
      expect(enabled.writeGeneration).toBe(row.writeGeneration + 1);
      expect(enabled.authorizationId).toBe("pending-upgrade");
      yield* listConnections("org").pipe(test.provide);
      expect((yield* test.store.get(key))?.writeGeneration).toBe(enabled.writeGeneration);
      expect(yield* readIssue(issueInput).pipe(test.provide)).toMatchObject({
        identifier: "LP-42",
      });
    }),
  );
  it.effect("keeps stored write capability when saved credentials cannot be opened", () =>
    Effect.gen(function* () {
      const row = {
        ...linearRow(),
        payloadSealed: "sealed:unreadable",
        writesEnabled: true,
        writeGeneration: 7,
      };
      const test = yield* fixture({ rows: [row] });
      expect((yield* listConnections("org").pipe(test.provide)).connections[0]).toMatchObject({
        writesAvailable: false,
      });
      expect(yield* test.store.get(key)).toMatchObject({
        writesEnabled: true,
        writeGeneration: 7,
      });
    }),
  );
  it.effect("retains the write profile for a connection requiring sign-in", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [
          {
            ...linearRow(),
            status: "reconnect_required",
            payloadSealed: `sealed:${encodeJson({
              service: "linear",
              oauth: { ...linearOAuth, resource: "https://mcp.linear.app/mcp" },
              accountId: "account",
              accessToken: "expired-write-access",
              refreshToken: "write-refresh",
              expiresAt: 0,
              workspaceId: "workspace",
              workspaceSlug: "launchpad",
              scopes: ["read", "write"],
            })}`,
          },
        ],
      });
      expect((yield* listConnections("org").pipe(test.provide)).connections[0]).toMatchObject({
        status: "reconnect_required",
        writesAvailable: true,
      });
    }),
  );
  it.effect("searches through the connection owner and rejects an old generation", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow()],
        respond: () => Effect.succeed(issueResponse()),
      });
      expect(
        yield* searchIssues({
          ownerUserId: "org",
          connectionVersion: "initial",
          service: "linear",
          request: { query: "queue" },
        }).pipe(test.provide),
      ).toMatchObject({
        service: "linear",
        issues: [{ identifier: "LP-42" }],
        continuation: null,
      });
      expect(
        yield* searchIssues({
          ownerUserId: "org",
          connectionVersion: "old",
          service: "linear",
          request: { query: "queue" },
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "conflict" });
    }),
  );
  it.effect("marks a connection for reconnect when search receives an authorization failure", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow()],
        respond: () => Effect.succeed(new Response(null, { status: 401 })),
      });
      expect(
        yield* searchIssues({
          ownerUserId: "org",
          connectionVersion: "initial",
          service: "linear",
          request: { query: "queue" },
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "auth_required" });
      expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
    }),
  );
  it.effect("a stale failed search cannot invalidate refreshed credentials", () =>
    Effect.gen(function* () {
      const oldSearchStarted = yield* Deferred.make<void>();
      const releaseOldSearch = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow(60_001)],
        respond: (request) => {
          if (request.url.endsWith("/token")) return Effect.succeed(tokenResponse());
          if (request.headers.authorization === "Bearer old-access-secret")
            return Deferred.succeed(oldSearchStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOldSearch)),
              Effect.as(new Response(null, { status: 401 })),
            );
          return Effect.succeed(issueResponse());
        },
      });
      const input = {
        ownerUserId: "org",
        connectionVersion: "initial",
        service: "linear" as const,
        request: { query: "queue" },
      };
      const oldSearch = yield* searchIssues(input).pipe(
        test.provide,
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(oldSearchStarted);
      yield* TestClock.adjust(2);
      expect((yield* searchIssues(input).pipe(test.provide)).issues[0]?.identifier).toBe("LP-42");
      yield* Deferred.succeed(releaseOldSearch, undefined);
      expect(yield* Fiber.join(oldSearch)).toMatchObject({ code: "auth_required" });
      expect((yield* test.store.get(key))?.status).toBe("connected");
    }),
  );
  it.effect("returns a typed timeout before the relay deadline on slow search", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [
          {
            ...jiraRow(),
            payloadSealed: `sealed:${encodeJson({
              service: "jira",
              authType: "oauth",
              oauth: jiraOAuth,
              accessToken: "oauth-access",
              refreshToken: "oauth-refresh",
              expiresAt: Number.MAX_SAFE_INTEGER,
              siteUrl: "https://launchpad.atlassian.net",
              cloudId: "cloud",
              scopes: ["read:jira:agent-interface", "search:jira:agent-interface"],
            })}`,
          },
        ],
        respond: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const searching = yield* searchIssues({
        ownerUserId: "org",
        connectionVersion: "initial",
        service: "jira",
        request: { query: "queue" },
      }).pipe(test.provide, Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(searching)).toMatchObject({
        code: "unavailable",
        message: "The issue tracker took too long to respond. Try again.",
      });
      expect((yield* test.store.get({ ownerUserId: "org", service: "jira" }))?.status).toBe(
        "connected",
      );
    }),
  );
  it.effect("finishes Jira session cleanup before the relay search deadline", () =>
    Effect.gen(function* () {
      const callStarted = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [
          {
            ...jiraRow(),
            payloadSealed: `sealed:${encodeJson({
              service: "jira",
              authType: "oauth",
              oauth: jiraOAuth,
              accessToken: "oauth-access",
              refreshToken: "oauth-refresh",
              expiresAt: Number.MAX_SAFE_INTEGER,
              siteUrl: "https://launchpad.atlassian.net",
              cloudId: "cloud",
              scopes: ["read:jira:agent-interface", "search:jira:agent-interface"],
            })}`,
          },
        ],
        respond: (request) => {
          if (request.method === "GET") return Effect.succeed(new Response(null, { status: 405 }));
          if (request.method === "DELETE")
            return Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Effect.sleep("1500 millis")),
              Effect.as(new Response(null, { status: 204 })),
            );
          if (request.body._tag !== "Uint8Array") return Effect.die("Expected Jira request body");
          const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
          if (rpc.method === "initialize")
            return Effect.succeed(
              Response.json(
                {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "Jira", version: "1" },
                  },
                },
                { headers: { "Mcp-Session-Id": "jira-session" } },
              ),
            );
          if (rpc.method === "notifications/initialized")
            return Effect.succeed(new Response(null, { status: 202 }));
          return Deferred.succeed(callStarted, undefined).pipe(Effect.andThen(Effect.never));
        },
      });
      const searching = yield* searchIssues({
        ownerUserId: "org",
        connectionVersion: "initial",
        service: "jira",
        request: { query: "queue" },
      }).pipe(test.provide, Effect.flip, Effect.timeoutOption("9 seconds"), Effect.forkChild);
      yield* Deferred.await(callStarted);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(searching)).toMatchObject({
        _tag: "Some",
        value: {
          code: "unavailable",
          message: "The issue tracker took too long to respond. Try again.",
        },
      });
      yield* Deferred.await(cleanupStarted);
      expect(test.requests.some((request) => request.method === "DELETE")).toBe(true);
    }),
  );
  it.effect.each(["linear", "jira"] as const)(
    "rejects a replaced %s connection before reading with its credentials",
    (service) =>
      Effect.gen(function* () {
        const test = yield* fixture({ rows: [linearRow(), jiraRow()] });
        expect(
          yield* readIssue({
            ...issueInput,
            service,
            connectionVersion: "previous-connection",
          }).pipe(test.provide, Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(test.requests).toHaveLength(0);
      }),
  );

  it.effect.each(["disconnect", "replacement"] as const)(
    "stale Linear callback cannot undo %s",
    (action) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const test = yield* fixture({
          respond: (request) =>
            request.url.endsWith("/token")
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(tokenResponse()),
                )
              : Effect.succeed(identityResponse()),
        });
        const { authorizationUrl } = yield* startLinear({
          ownerUserId: "org",
          userId: "org",
        }).pipe(test.provide);
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        const callback = yield* completeLinear({
          state,
          iss: "https://mcp.linear.app",
          code: "authorization-code",
        }).pipe(test.provide, Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        if (action === "disconnect") yield* disconnect(key).pipe(test.provide);
        else yield* startLinear({ ownerUserId: "org", userId: "org" }).pipe(test.provide);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
        expect(test.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
        const row = yield* test.store.get(key);
        if (action === "disconnect") expect(row).toBeNull();
        else {
          expect(row?.updatedByUserId).toBe("org");
          expect(row?.payloadSealed).toBeNull();
          expect(row?.pendingStateHash).not.toBeNull();
        }
      }),
  );

  it.effect("successful OAuth consumes the state and rejects replay", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(request.url.endsWith("/token") ? tokenResponse() : identityResponse()),
      });
      const { authorizationUrl } = yield* startLinear({
        ownerUserId: "org",
        userId: "org",
      }).pipe(test.provide);
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      expect(
        yield* completeLinear({
          state,
          iss: "https://mcp.linear.app",
          code: "authorization-code",
        }).pipe(test.provide),
      ).toEqual({ status: "connected", accountLabel: "Launchpad · Launchpad app" });
      expect(
        yield* completeLinear({
          state,
          iss: "https://mcp.linear.app",
          code: "authorization-code",
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(test.requests).toHaveLength(3);
      expect((yield* test.store.get(key))?.pendingStateHash).toBeNull();
    }),
  );

  it.effect("isolates pending PKCE verifiers and invalidates a superseded authorization", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const first = yield* startLinear({ ownerUserId: "org", userId: "org" }).pipe(test.provide);
      const original = (yield* test.store.get(key))!;
      const second = yield* startLinear({ ownerUserId: "org", userId: "org" }).pipe(test.provide);
      const current = (yield* test.store.get(key))!;
      expect(current.pendingOAuthSealed).not.toBe(original.pendingOAuthSealed);
      expect(current.pendingOAuthSealed).toContain('"codeVerifier"');
      expect(encodeJson(second)).not.toContain('"codeVerifier"');
      expect(
        yield* completeLinear({
          state: new URL(first.authorizationUrl).searchParams.get("state")!,
          code: "stale",
          iss: "https://mcp.linear.app",
        }).pipe(test.provide, Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect((yield* test.store.get(key))?.authorizationId).toBe(second.authorizationId);
    }),
  );

  it.effect("serializes refresh across concurrent reads and persists the rotated token", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow(0)],
        respond: (request) =>
          request.url.endsWith("/token")
            ? Deferred.succeed(refreshStarted, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(tokenResponse()),
              )
            : Effect.succeed(issueResponse()),
      });
      const reads = yield* Effect.all([readIssue(issueInput), readIssue(issueInput)], {
        concurrency: 2,
      }).pipe(test.provide, Effect.forkChild);
      yield* Deferred.await(refreshStarted);
      yield* Deferred.await(test.secondLockRequested);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(reads)).toHaveLength(2);
      expect(test.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      expect(
        test.requests
          .filter((request) => ["get_issue", "list_comments"].includes(toolName(request) ?? ""))
          .map((request) => request.headers.authorization),
      ).toEqual(Array(6).fill("Bearer new-access-secret"));
      expect((yield* test.store.get(key))?.payloadSealed).toContain("new-refresh-secret");
    }),
  );

  it.effect.each([
    { status: 401, expectedCode: "auth_required", expectedStatus: "reconnect_required" },
    { status: 404, expectedCode: "not_found", expectedStatus: "connected" },
    { status: 503, expectedCode: "unavailable", expectedStatus: "connected" },
  ])(
    "marks reconnect only for lost authorization: HTTP $status",
    ({ status, expectedCode, expectedStatus }) =>
      Effect.gen(function* () {
        const test = yield* fixture({
          rows: [linearRow()],
          respond: () => Effect.succeed(new Response("secret upstream failure", { status })),
        });
        expect(yield* readIssue(issueInput).pipe(test.provide, Effect.flip)).toMatchObject({
          code: expectedCode,
        });
        expect((yield* test.store.get(key))?.status).toBe(expectedStatus);
      }),
  );

  it.effect("lists only display metadata, without sealed payloads or OAuth state", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [{ ...linearRow(), pendingStateHash: "sensitive-state" }],
      });
      const listed = yield* listConnections("org").pipe(test.provide);
      expect(listed).toEqual({
        connections: [
          {
            service: "linear",
            status: "connected",
            accountLabel: "Launchpad app",
            updatedAt: "2026-01-01T00:00:00.000Z",
            searchEnabled: true,
            writesAvailable: false,
          },
        ],
      });
      expect(encodeJson(listed)).not.toMatch(/secret|payload|sensitive-state/);
    }),
  );

  it.effect("disconnect denies subsequent reads without contacting Linear", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ rows: [linearRow()] });
      yield* disconnect(key).pipe(test.provide);
      expect(yield* readIssue(issueInput).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "not_configured",
      });
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("does not return issue content if the connection is deleted during a read", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow()],
        respond: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(issueResponse()),
          ),
      });
      const reading = yield* readIssue(issueInput).pipe(
        test.provide,
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* disconnect(key).pipe(test.provide);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(reading)).toMatchObject({ code: "conflict" });
    }),
  );
  it.effect("a stale unauthorized read cannot invalidate successfully refreshed credentials", () =>
    Effect.gen(function* () {
      const oldReadStarted = yield* Deferred.make<void>();
      const releaseOldRead = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow(60_001)],
        respond: (request) => {
          if (request.url.endsWith("/token")) return Effect.succeed(tokenResponse());
          if (request.headers.authorization === "Bearer old-access-secret")
            return Deferred.succeed(oldReadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOldRead)),
              Effect.as(new Response(null, { status: 401 })),
            );
          return Effect.succeed(issueResponse());
        },
      });
      const oldRead = yield* readIssue(issueInput).pipe(
        test.provide,
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(oldReadStarted);
      yield* TestClock.adjust(2);
      expect((yield* readIssue(issueInput).pipe(test.provide)).identifier).toBe("LP-42");
      yield* Deferred.succeed(releaseOldRead, undefined);
      expect(yield* Fiber.join(oldRead)).toMatchObject({ code: "auth_required" });
      expect((yield* test.store.get(key))?.status).toBe("connected");
    }),
  );

  it.effect.each(["decryption", "decoding"] as const)(
    "recovers from credential %s failure through explicit disconnect and connect",
    (failureMode) =>
      Effect.gen(function* () {
        const brokenPayload = "sealed:unreadable-old-credentials";
        const test = yield* fixture({
          rows: [{ ...linearRow(), payloadSealed: brokenPayload }],
          respond: (request) =>
            Effect.succeed(
              request.url.endsWith("/token")
                ? tokenResponse()
                : request.body._tag === "Uint8Array" &&
                    new TextDecoder().decode(request.body.body).includes("get_workspace")
                  ? identityResponse()
                  : commentsRequested(request)
                    ? commentsResponse()
                    : issueResponse(),
            ),
        });
        const box = yield* RelaySecretBox.pipe(test.provide);
        yield* Effect.gen(function* () {
          const readFailure = yield* readIssue(issueInput).pipe(Effect.flip);
          expect(readFailure).toMatchObject({ code: "auth_required" });
          expect(readFailure.message).toContain(
            "Disconnect Linear in Account connections, then connect it again.",
          );
          const pending = yield* startLinear({ ownerUserId: "org", userId: "org" });
          const callbackFailure = yield* completeLinear({
            state: new URL(pending.authorizationUrl).searchParams.get("state")!,
            iss: "https://mcp.linear.app",
            code: "new-authorization-code",
          }).pipe(Effect.flip);
          expect(callbackFailure).toMatchObject({
            code: "auth_required",
            message: readFailure.message,
          });
          expect(test.requests).toHaveLength(0);
          expect(yield* test.store.get(key)).toMatchObject({
            payloadSealed: brokenPayload,
            version: "initial",
            authorizationId: null,
            replacement: null,
          });

          // Follow the recovery instruction using the actual connection operations.
          yield* disconnect(key);
          const fresh = yield* startLinear({ ownerUserId: "org", userId: "org" });
          expect(
            yield* completeLinear({
              state: new URL(fresh.authorizationUrl).searchParams.get("state")!,
              iss: "https://mcp.linear.app",
              code: "fresh-authorization-code",
            }),
          ).toMatchObject({ status: "connected" });
          expect((yield* readIssue(issueInput)).identifier).toBe("LP-42");
          expect((yield* test.store.get(key))?.status).toBe("connected");
        }).pipe(
          Effect.provideService(RelaySecretBox, {
            ...box,
            open: (payload) =>
              failureMode === "decryption" && payload === brokenPayload
                ? Effect.fail(
                    new SecretBoxError({ operation: "open", cause: "Encryption key changed" }),
                  )
                : box.open(payload),
          }),
          test.provide,
        );
      }),
  );

  it.effect("marks reconnect when the newly refreshed credentials themselves fail", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow(0)],
        respond: (request) =>
          Effect.succeed(
            request.url.endsWith("/token") ? tokenResponse() : new Response(null, { status: 401 }),
          ),
      });
      expect(yield* readIssue(issueInput).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "auth_required",
      });
      expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
    }),
  );
  it.effect.each(["interrupt", "deadline"] as const)(
    "cleans up pending Linear callback after %s",
    (mode) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const test = yield* fixture({
          respond: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const { authorizationUrl } = yield* startLinear({
          ownerUserId: "org",
          userId: "org",
        }).pipe(test.provide);
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        const callback = yield* completeLinear({
          state,
          iss: "https://mcp.linear.app",
          code: "authorization-code",
        }).pipe(test.provide, Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        if (mode === "interrupt") yield* Fiber.interrupt(callback);
        else {
          yield* TestClock.adjust("8 seconds");
          expect(yield* Fiber.join(callback)).toMatchObject({ code: "unavailable" });
        }
        expect(yield* test.store.get(key)).toBeNull();
      }),
  );
});

const commentsRequested = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" &&
  new TextDecoder().decode(request.body.body).includes("list_comments");
const commentsResponse = (
  body = Array.from(
    { length: 6 },
    (_, i) => `![screenshot](https://uploads.linear.app/screenshot-${i}.png)`,
  ).join("\n"),
) =>
  Response.json({
    data: {
      organization: { id: "workspace" },
      issue: { id: "issue-id" },
      comments: {
        edges: [
          {
            cursor: "cursor",
            node: {
              id: "comment",
              issueId: "issue-id",
              parentId: null,
              body,
              user: { name: "Alice" },
              createdAt: "2026-09-30T12:00:00Z",
              editedAt: null,
              url: "https://linear.app/launchpad/issue/LP-42#comment-comment",
            },
          },
        ],
        pageInfo: { hasNextPage: true },
      },
    },
  });

describe("Linear context lifecycle", () => {
  it.effect.each([429, 500])("preserves issue details when discussion returns HTTP %s", (status) =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow()],
        respond: (request) =>
          Effect.succeed(
            commentsRequested(request) ? new Response(null, { status }) : issueResponse(),
          ),
      });
      const result = yield* readIssue(issueInput).pipe(test.provide);
      expect(result.title).toBe("Read this issue");
      expect(result.linear?.discussion.status).toBe("unavailable");
      expect((yield* test.store.get(key))?.status).toBe("connected");
    }),
  );

  it.effect("returns the issue before the operation deadline when discussion stalls", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow()],
        respond: (request) =>
          commentsRequested(request)
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(issueResponse()),
      });
      const reading = yield* readIssue(issueInput).pipe(test.provide, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(reading);
      expect(result.identifier).toBe("LP-42");
      expect(result.linear?.discussion).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("timed out"),
      });
    }),
  );

  it.effect("does not disguise authentication loss during comments as partial success", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow()],
        respond: (request) =>
          Effect.succeed(
            commentsRequested(request) ? new Response(null, { status: 401 }) : issueResponse(),
          ),
      });
      expect(yield* readIssue(issueInput).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "auth_required",
      });
      expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
    }),
  );

  it.effect.each(["workspace", "disconnect", "generation", "owner", "grant"] as const)(
    "rejects old comment and image references after %s changes",
    (change) =>
      Effect.gen(function* () {
        const test = yield* fixture({
          rows: [linearRow(), { ...linearRow(), ownerUserId: "other-org" }],
          respond: (request) =>
            Effect.succeed(commentsRequested(request) ? commentsResponse() : issueResponse()),
        });
        const result = yield* readIssue(issueInput).pipe(test.provide);
        const discussion = result.linear!.discussion;
        if (discussion.status !== "available") throw new Error("Expected discussion");
        if (change === "disconnect") yield* disconnect(key).pipe(test.provide);
        else if (change !== "owner" && change !== "grant")
          yield* Ref.update(test.records, (rows) => {
            const current = rows.get(recordKey(key))!;
            const payload = JSON.parse(current.payloadSealed!.slice(7));
            const next = new Map(rows);
            next.set(recordKey(key), {
              ...current,
              version: "replacement",
              payloadSealed: `sealed:${JSON.stringify({ ...payload, ...(change === "workspace" ? { workspaceId: "other-workspace" } : { generation: "replacement" }) })}`,
            });
            return next;
          });
        const before = test.requests.length;
        const ownerUserId = change === "owner" ? "other-org" : "org";
        const access = {
          ownerUserId,
          ...(change === "grant" ? { connectionVersion: "previous-connection" } : {}),
        };
        expect(
          yield* readComments({ ...access, reference: discussion.continuation! }).pipe(
            test.provide,
            Effect.flip,
          ),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* viewImage({
            ...access,
            reference: discussion.comments[0]!.images[0]!.reference,
          }).pipe(test.provide, Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* readImages({
            ...access,
            reference: discussion.comments[0]!.imagesContinuation!,
          }).pipe(test.provide, Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(test.requests).toHaveLength(before);
      }),
  );

  it.effect("keeps continuation valid through token refresh and starting OAuth", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [linearRow(60_001)],
        respond: (request) =>
          Effect.succeed(
            request.url.endsWith("/token")
              ? tokenResponse()
              : commentsRequested(request)
                ? commentsResponse()
                : issueResponse(),
          ),
      });
      const result = yield* readIssue(issueInput).pipe(test.provide);
      yield* startLinear({ ownerUserId: "org", userId: "org" }).pipe(test.provide);
      yield* TestClock.adjust(2);
      const next = yield* readComments({
        ownerUserId: "org",
        reference: result.linear!.source,
      }).pipe(test.provide);
      expect(next.identifier).toBe("LP-42");
      expect(next.discussion.status).toBe("available");
    }),
  );
});

it.effect.each(["description", "comment"])(
  "retrieves all images beyond clipped %s text through real follow-up operations",
  (location) =>
    Effect.gen(function* () {
      const urls = Array.from({ length: 12 }, (_, i) => `https://uploads.linear.app/${i}.png`);
      const markdown =
        "x".repeat(21_000) + "\n\n" + urls.map((url) => `![proof](${url})`).join("\n");
      let removed = false;
      const test = yield* fixture({
        rows: [linearRow()],
        respond: (request) => {
          if (toolName(request) === "extract_images")
            return Effect.succeed(
              new Response(new Uint8Array([137, 80, 78, 71]), {
                headers: { "content-type": "image/png" },
              }),
            );
          const body = removed ? "Image removed" : markdown;
          const query =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          if (query.includes("LaunchpadCommentImage"))
            return Effect.succeed(
              Response.json({
                data: {
                  organization: { id: "workspace" },
                  comment: {
                    id: "comment",
                    issueId: "issue-id",
                    parentId: null,
                    body,
                    user: { name: "Alice" },
                    createdAt: "2026-09-30T12:00:00Z",
                    editedAt: null,
                    url: "https://linear.app/launchpad/issue/LP-42#comment-comment",
                  },
                },
              }),
            );
          return Effect.succeed(
            commentsRequested(request)
              ? commentsResponse(location === "comment" ? body : "No images")
              : issueResponse(location === "description" ? body : "No images"),
          );
        },
      });
      const result = yield* readIssue(issueInput).pipe(test.provide);
      expect(result).not.toHaveProperty("originalDescription");
      expect(encodeJson(result)).not.toContain("x".repeat(21_000));
      const context = result.linear!;
      if (context.discussion.status !== "available") throw new Error("Expected discussion");
      const initial = location === "description" ? context : context.discussion.comments[0]!;
      const found = [...initial.images];
      let continuation = initial.imagesContinuation;
      for (let page = 0; page < 2; page++) {
        expect(continuation).not.toBeNull();
        const next = yield* readImages({ ownerUserId: "org", reference: continuation! }).pipe(
          test.provide,
        );
        found.push(...next.images);
        continuation = next.imagesContinuation;
      }
      expect(continuation).toBeNull();
      expect(found.map((entry) => entry.url)).toEqual(urls);
      const lastImage = found.at(-1)!;
      const image = yield* viewImage({
        ownerUserId: "org",
        reference: lastImage.reference,
      }).pipe(test.provide);
      expect(image.image).toEqual({ mimeType: "image/png", data: "iVBORw==" });
      expect(toolName(test.requests.at(-1)!)).toBe("extract_images");
      const imageFetches = test.requests.filter(
        (request) => toolName(request) === "extract_images",
      ).length;
      removed = true;
      expect(
        yield* viewImage({ ownerUserId: "org", reference: lastImage.reference }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "not_found" });
      expect(
        test.requests.filter((request) => toolName(request) === "extract_images"),
      ).toHaveLength(imageFetches);
      yield* disconnect(key).pipe(test.provide);
      expect(
        yield* readImages({ ownerUserId: "org", reference: initial.imagesContinuation! }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "conflict" });
    }),
);

it.effect("fits the full Jira read response when issue fields exceed the serialized budget", () =>
  Effect.gen(function* () {
    const title = "\u0001".repeat(4096);
    const description = "\u0001".repeat(20_000);
    const test = yield* fixture({
      rows: [jiraRow()],
      respond: (request) => {
        const rpc =
          request.body._tag === "Uint8Array"
            ? decodeRpc(new TextDecoder().decode(request.body.body))
            : undefined;
        return Effect.succeed(
          rpc?.method === "tools/call"
            ? Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  structuredContent: {
                    key: "LP-42",
                    fields: {
                      summary: title,
                      description,
                      status: { name: "Open" },
                      assignee: null,
                    },
                  },
                },
              })
            : jiraResponse(request),
        );
      },
    });
    const result = yield* readIssue({
      ownerUserId: "org",
      service: "jira",
      issue: "LP-42",
    }).pipe(test.provide);
    expect(new TextEncoder().encode(encodeJson(result)).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(result).toMatchObject({
      service: "jira",
      identifier: "LP-42",
      title,
      status: "Open",
      assignee: null,
      accountLabel: "launchpad.atlassian.net",
      url: "https://launchpad.atlassian.net/browse/LP-42",
    });
    expect(result.description.length).toBeLessThan(description.length);
    expect(
      result.description.endsWith(
        "\n\n[Description truncated by Launchpad. Open the issue for the full text.]",
      ),
    ).toBe(true);
  }),
);
