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
  readComments,
  readImages,
  viewImage,
  saveJira,
  startLinear,
} from "./Connections.ts";

import {
  encodeJson,
  recordKey,
  fixture,
  key,
  issueInput,
  membership,
  linearRow,
  issueResponse,
  identityResponse,
  tokenResponse,
} from "./Connections.test-fixture.ts";

const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, id: Schema.optionalKey(Schema.Number) }),
  ),
);
function jiraResponse(request: HttpClientRequest.HttpClientRequest) {
  if (request.url.endsWith("/_edge/tenant_info")) return Response.json({ cloudId: "cloud" });
  if (request.body._tag !== "Uint8Array") throw new Error("Expected Jira request body");
  const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
  if (rpc.method === "initialize")
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-11-25" } });
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
  it.effect.each(["disconnect", "replacement"] as const)(
    "stale Jira validation cannot undo %s",
    (action) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const test = yield* fixture({
          respond: (request) =>
            request.url.endsWith("/_edge/tenant_info")
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(jiraResponse(request)),
                )
              : Effect.succeed(jiraResponse(request)),
        });
        const jiraKey = { organizationId: "org", service: "jira" } as const;
        const saving = yield* saveJira({
          organizationId: "org",
          userId: "admin",
          siteUrl: "https://launchpad.atlassian.net",
          apiKey: "jira-secret",
          issue: "LP-42",
        }).pipe(test.provide, Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        if (action === "disconnect") yield* disconnect(jiraKey).pipe(test.provide);
        else yield* test.store.begin({ ...jiraKey, userId: "other-admin" });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(saving)).toMatchObject({ code: "conflict" });
        const row = yield* test.store.get(jiraKey);
        if (action === "disconnect") expect(row).toBeNull();
        else {
          expect(row?.updatedByUserId).toBe("other-admin");
          expect(row?.payloadSealed).toBeNull();
        }
      }),
  );

  it.effect.each(["disconnect", "replacement"] as const)(
    "stale Linear callback cannot undo %s",
    (action) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const test = yield* fixture({
          membership: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(membership),
          ),
        });
        const { authorizationUrl } = yield* startLinear({
          organizationId: "org",
          userId: "admin",
        }).pipe(test.provide);
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        const callback = yield* completeLinear({ state, code: "authorization-code" }).pipe(
          test.provide,
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        if (action === "disconnect") yield* disconnect(key).pipe(test.provide);
        else
          yield* startLinear({ organizationId: "org", userId: "other-admin" }).pipe(test.provide);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(callback)).toMatchObject({ code: "conflict" });
        expect(test.requests).toHaveLength(0);
        const row = yield* test.store.get(key);
        if (action === "disconnect") expect(row).toBeNull();
        else {
          expect(row?.updatedByUserId).toBe("other-admin");
          expect(row?.payloadSealed).toBeNull();
          expect(row?.pendingStateHash).not.toBeNull();
        }
      }),
  );

  it.effect("successful OAuth consumes the state and rejects replay", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) =>
          Effect.succeed(
            request.url.endsWith("/oauth/token") ? tokenResponse() : identityResponse(),
          ),
      });
      const { authorizationUrl } = yield* startLinear({
        organizationId: "org",
        userId: "admin",
      }).pipe(test.provide);
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      expect(
        yield* completeLinear({ state, code: "authorization-code" }).pipe(test.provide),
      ).toEqual({ status: "connected", accountLabel: "Launchpad · Launchpad app" });
      expect(
        yield* completeLinear({ state, code: "authorization-code" }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "conflict" });
      expect(test.requests).toHaveLength(2);
      expect((yield* test.store.get(key))?.pendingStateHash).toBeNull();
    }),
  );

  it.effect("serializes refresh across concurrent reads and persists the rotated token", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        rows: [linearRow(0)],
        respond: (request) =>
          request.url.endsWith("/oauth/token")
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
      expect(test.requests.filter((request) => request.url.endsWith("/oauth/token"))).toHaveLength(
        1,
      );
      expect(
        test.requests
          .filter((request) => request.url.endsWith("/graphql"))
          .map((request) => request.headers.authorization),
      ).toEqual(Array(4).fill("Bearer new-access-secret"));
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
        linearAvailable: true,
        connections: [
          {
            service: "linear",
            status: "connected",
            accountLabel: "Launchpad app",
            updatedAt: "2026-01-01T00:00:00.000Z",
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
          if (request.url.endsWith("/oauth/token")) return Effect.succeed(tokenResponse());
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
              request.url.endsWith("/oauth/token")
                ? tokenResponse()
                : request.body._tag === "Uint8Array" &&
                    new TextDecoder().decode(request.body.body).includes("LaunchpadIdentity")
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
            "Disconnect Linear in Organization settings, then connect it again.",
          );
          const pending = yield* startLinear({ organizationId: "org", userId: "admin" });
          const callbackFailure = yield* completeLinear({
            state: new URL(pending.authorizationUrl).searchParams.get("state")!,
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
          const fresh = yield* startLinear({ organizationId: "org", userId: "admin" });
          expect(
            yield* completeLinear({
              state: new URL(fresh.authorizationUrl).searchParams.get("state")!,
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
            request.url.endsWith("/oauth/token")
              ? tokenResponse()
              : new Response(null, { status: 401 }),
          ),
      });
      expect(yield* readIssue(issueInput).pipe(test.provide, Effect.flip)).toMatchObject({
        code: "auth_required",
      });
      expect((yield* test.store.get(key))?.status).toBe("reconnect_required");
    }),
  );
  it.effect.each(["interrupt", "deadline"] as const)(
    "cleans up pending Jira validation after %s",
    (mode) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const test = yield* fixture({
          respond: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const saving = yield* saveJira({
          organizationId: "org",
          userId: "admin",
          siteUrl: "https://launchpad.atlassian.net",
          apiKey: "jira-secret",
          issue: "LP-42",
        }).pipe(test.provide, Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        if (mode === "interrupt") yield* Fiber.interrupt(saving);
        else {
          yield* TestClock.adjust("8 seconds");
          expect(yield* Fiber.join(saving)).toMatchObject({ code: "unavailable" });
        }
        expect(yield* test.store.get({ organizationId: "org", service: "jira" })).toBeNull();
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
          organizationId: "org",
          userId: "admin",
        }).pipe(test.provide);
        const state = new URL(authorizationUrl).searchParams.get("state")!;
        const callback = yield* completeLinear({ state, code: "authorization-code" }).pipe(
          test.provide,
          Effect.flip,
          Effect.forkChild,
        );
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
  new TextDecoder().decode(request.body.body).includes("LaunchpadComments");
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

  it.effect.each(["workspace", "disconnect", "generation", "organization"] as const)(
    "rejects old comment and image references after %s changes",
    (change) =>
      Effect.gen(function* () {
        const test = yield* fixture({
          rows: [linearRow(), { ...linearRow(), organizationId: "other-org" }],
          respond: (request) =>
            Effect.succeed(commentsRequested(request) ? commentsResponse() : issueResponse()),
        });
        const result = yield* readIssue(issueInput).pipe(test.provide);
        const discussion = result.linear!.discussion;
        if (discussion.status !== "available") throw new Error("Expected discussion");
        if (change === "disconnect") yield* disconnect(key).pipe(test.provide);
        else if (change !== "organization")
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
        const organizationId = change === "organization" ? "other-org" : "org";
        expect(
          yield* readComments({ organizationId, reference: discussion.continuation! }).pipe(
            test.provide,
            Effect.flip,
          ),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* viewImage({
            organizationId,
            reference: discussion.comments[0]!.images[0]!.reference,
          }).pipe(test.provide, Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* readImages({
            organizationId,
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
            request.url.endsWith("/oauth/token")
              ? tokenResponse()
              : commentsRequested(request)
                ? commentsResponse()
                : issueResponse(),
          ),
      });
      const result = yield* readIssue(issueInput).pipe(test.provide);
      yield* startLinear({ organizationId: "org", userId: "admin" }).pipe(test.provide);
      yield* TestClock.adjust(2);
      const next = yield* readComments({
        organizationId: "org",
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
          if (request.url.startsWith("https://uploads.linear.app/"))
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
        const next = yield* readImages({ organizationId: "org", reference: continuation! }).pipe(
          test.provide,
        );
        found.push(...next.images);
        continuation = next.imagesContinuation;
      }
      expect(continuation).toBeNull();
      expect(found.map((entry) => entry.url)).toEqual(urls);
      const lastImage = found.at(-1)!;
      const image = yield* viewImage({
        organizationId: "org",
        reference: lastImage.reference,
      }).pipe(test.provide);
      expect(image.image).toEqual({ mimeType: "image/png", data: "iVBORw==" });
      expect(test.requests.at(-1)?.url).toBe(lastImage.url);
      const imageFetches = test.requests.filter((request) =>
        request.url.startsWith("https://uploads.linear.app/"),
      ).length;
      removed = true;
      expect(
        yield* viewImage({ organizationId: "org", reference: lastImage.reference }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "not_found" });
      expect(
        test.requests.filter((request) => request.url.startsWith("https://uploads.linear.app/")),
      ).toHaveLength(imageFetches);
      yield* disconnect(key).pipe(test.provide);
      expect(
        yield* readImages({ organizationId: "org", reference: initial.imagesContinuation! }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "conflict" });
    }),
);
