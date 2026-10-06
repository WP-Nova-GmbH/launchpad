import { EnvironmentId } from "@t3tools/contracts";
import { RelayIssueTrackerTurnPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  fixture,
  issueResponse,
  linearOAuth,
  linearRow,
  jiraRow,
  encodeJson,
  toolName,
} from "./Connections.test-fixture.ts";
import { WriteOperationStore, type WriteOperationRecord } from "./WriteOperationStore.ts";
import { mcpFixture } from "./LinearMcp.test-fixture.ts";
import { executeComment, prepareComment } from "./WriteOperations.ts";

const claims = RelayIssueTrackerTurnPrincipal.of({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: "thread-1",
  commandId: "command-1",
  commandDigest: "a".repeat(64),
  runtimeMode: "approval-required",
  ownerUserId: "org",
  expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
  connections: { linear: "initial" },
  writeGenerations: { linear: 4 },
});
const writeRow = () => ({
  ...linearRow(),
  writesEnabled: true,
  writeGeneration: 4,
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
});
const decodePayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      body: Schema.String,
      identifier: Schema.String,
      issueId: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeBaseline = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ complete: Schema.Boolean, commentIds: Schema.Array(Schema.String) }),
  ),
);
const decodeWriteRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      id: Schema.optionalKey(Schema.Number),
      params: Schema.optionalKey(
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  ),
);
const unusedOperations = WriteOperationStore.of({
  prepare: () => Effect.die("unexpected prepare"),
  get: () => Effect.die("unexpected get"),
  findUnknown: () => Effect.succeed(null),
  approve: () => Effect.die("unexpected approve"),
  reject: () => Effect.die("unexpected reject"),
  cancel: () => Effect.die("unexpected cancel"),
  claim: () => Effect.die("unexpected claim"),
  succeed: () => Effect.die("unexpected succeed"),
  outcomeUnknown: () => Effect.die("unexpected outcomeUnknown"),
  reconcileUnknown: () => Effect.die("unexpected reconcileUnknown"),
  reconcileVerifiedUnknown: () => Effect.die("unexpected reconcileVerifiedUnknown"),
  cancelPending: () => Effect.die("unexpected cancelPending"),
});

describe("prepare issue comments", () => {
  it.effect("keeps an old uncertain comment guarded until an explicit retry is prepared", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(
        (name) =>
          Effect.succeed(
            name === "list_comments" ? { comments: [], hasNextPage: false } : undefined,
          ),
        [],
        [writeRow()],
      );
      const prior = {
        operationId: "unknown-before-reconnect",
        state: "outcome_unknown",
        connectionVersion: "old-connection",
        writeGeneration: 3,
        resultResourceId: null,
      } as WriteOperationRecord;
      let prepared: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
      const store = WriteOperationStore.of({
        ...unusedOperations,
        findUnknown: () => Effect.succeed(prior),
        prepare: (candidate) =>
          Effect.sync(() => {
            prepared = candidate;
            return { operation: candidate as WriteOperationRecord, reused: false };
          }),
      });
      const request = {
        environmentId: "environment-1",
        providerSessionId: "session-2",
        invocationId: "retry-1",
        service: "linear" as const,
        issue: "LP-42",
        body: "Exact note",
      };
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          test.provide,
          Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
          Effect.provideService(WriteOperationStore, store),
        );
      expect((yield* provide(prepareComment(request))).operation.operationId).toBe(
        prior.operationId,
      );
      expect(prepared).toBeUndefined();
      yield* provide(prepareComment({ ...request, retryAfterUnknown: true }));
      expect(prepared).toMatchObject({
        connectionVersion: "initial",
        writeGeneration: 4,
        retryOfOperationId: prior.operationId,
      });
      expect(test.calls.some((call) => call.name === "save_comment")).toBe(false);
    }),
  );
  it.effect("reconciles an uncertain comment only after a matching provider read", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(
        (name) =>
          Effect.succeed(
            name === "list_comments"
              ? { comments: [{ id: "comment-1", body: "Exact note" }], hasNextPage: false }
              : undefined,
          ),
        [],
        [writeRow()],
      );
      const previous = {
        operationId: "previous-1",
        state: "outcome_unknown",
        connectionVersion: "initial",
        writeGeneration: 4,
        resultResourceId: "comment-1",
        payloadSealed: `sealed:${encodeJson({
          service: "linear",
          identifier: "LP-42",
          issueId: "issue-id",
          issueUrl: "https://linear.app/launchpad/issue/LP-42",
          body: "Exact note",
        })}`,
      } as WriteOperationRecord;
      let reconciled = false;
      const store = WriteOperationStore.of({
        ...unusedOperations,
        findUnknown: () => Effect.succeed(previous),
        prepare: () => Effect.succeed({ operation: previous, reused: true }),
        reconcileVerifiedUnknown: () =>
          Effect.sync(() => {
            reconciled = true;
            return { ...previous, state: "succeeded" };
          }),
      });
      const result = yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-2",
        invocationId: "retry-1",
        service: "linear",
        issue: "LP-42",
        body: "Exact note",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      expect(result.operation.state).toBe("succeeded");
      expect(reconciled).toBe(true);
      expect(test.calls.some((call) => call.name === "save_comment")).toBe(false);
    }),
  );
  it.effect("stores the exact validated proposal under the initiating user's turn", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [writeRow()],
        respond: (request) =>
          Effect.succeed(
            toolName(request) === "list_comments"
              ? Response.json({
                  data: { comments: { edges: [], pageInfo: { hasNextPage: false } } },
                })
              : issueResponse(),
          ),
      });
      let stored: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        prepare: (input) =>
          Effect.sync(() => {
            stored = input;
            return { operation: input as WriteOperationRecord, reused: false };
          }),
      });
      yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "invocation-1",
        service: "linear",
        issue: "LP-42",
        body: "  A precise test comment.  ",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, operations),
      );
      expect(stored).toMatchObject({
        ownerUserId: "org",
        service: "linear",
        environmentId: "environment-1",
        threadId: "thread-1",
        commandId: "command-1",
        providerSessionId: "session-1",
        invocationId: "invocation-1",
        connectionVersion: "initial",
        writeGeneration: 4,
        runtimeMode: "approval-required",
        action: "add_comment",
        target: "workspace:issue-id",
      });
      expect(decodePayload(stored!.payloadSealed!.slice("sealed:".length))).toMatchObject({
        body: "  A precise test comment.  ",
        identifier: "LP-42",
        issueId: "issue-id",
      });
      expect(stored!.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(decodeBaseline(stored!.baselineSealed!.slice("sealed:".length))).toEqual({
        complete: true,
        commentIds: [],
      });
      expect(test.requests.length).toBeGreaterThan(0);
    }),
  );

  it.effect("binds a Jira comment to the selected site's canonical issue", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
        rawHttp: true,
        respond: (request) => {
          if (request.method === "DELETE")
            return Effect.succeed(new Response(null, { status: 204 }));
          if (request.body._tag !== "Uint8Array") return Effect.die("missing Jira request body");
          const rpc = decodeWriteRpc(new TextDecoder().decode(request.body.body));
          if (rpc.method === "notifications/initialized")
            return Effect.succeed(new Response(null, { status: 202 }));
          return Effect.succeed(
            Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              result:
                rpc.method === "initialize"
                  ? { protocolVersion: "2025-11-25" }
                  : rpc.method === "tools/list"
                    ? { tools: [{ name: "executeRead", inputSchema: {} }] }
                    : rpc.params?.name === "executeRead"
                      ? { structuredContent: { comments: [], total: 0 } }
                      : { structuredContent: { key: "LP-42", fields: { summary: "Example" } } },
            }),
          );
        },
      });
      let stored: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        prepare: (input) =>
          Effect.sync(() => {
            stored = input;
            return { operation: input as WriteOperationRecord, reused: false };
          }),
      });
      yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "jira-invocation",
        service: "jira",
        issue: "LP-42",
        body: "A Jira test comment",
      }).pipe(
        test.provide,
        Effect.provideService(
          RelayIssueTrackerTurnPrincipal,
          RelayIssueTrackerTurnPrincipal.of({
            ...claims,
            connections: { jira: "initial" },
            writeGenerations: { jira: 4 },
          }),
        ),
        Effect.provideService(WriteOperationStore, operations),
      );
      expect(stored).toMatchObject({
        ownerUserId: "org",
        service: "jira",
        target: "https://launchpad.atlassian.net/browse/LP-42",
      });
      expect(decodeBaseline(stored!.baselineSealed!.slice("sealed:".length)).complete).toBe(false);
    }),
  );

  it.effect("rejects empty comments before reading the provider", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ rows: [writeRow()] });
      const error = yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "invocation-1",
        service: "linear",
        issue: "LP-42",
        body: "   ",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, unusedOperations),
        Effect.flip,
      );
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("does not prepare a Jira comment when comment listing is unavailable", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
        rawHttp: true,
        respond: (request) =>
          Effect.sync(() => {
            if (request.method === "DELETE") return new Response(null, { status: 204 });
            if (request.body._tag !== "Uint8Array") throw new Error("Missing Jira request");
            const rpc = decodeWriteRpc(new TextDecoder().decode(request.body.body));
            if (rpc.method === "notifications/initialized")
              return new Response(null, { status: 202 });
            const result =
              rpc.method === "initialize"
                ? { protocolVersion: "2025-11-25" }
                : rpc.method === "tools/list"
                  ? { tools: [{ name: "getJiraIssue", inputSchema: {} }] }
                  : { structuredContent: { key: "LP-42", fields: { summary: "Example" } } };
            return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
          }),
      });
      const failure = yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "jira-no-list",
        service: "jira",
        issue: "LP-42",
        body: "Never posted",
      }).pipe(
        test.provide,
        Effect.provideService(
          RelayIssueTrackerTurnPrincipal,
          RelayIssueTrackerTurnPrincipal.of({
            ...claims,
            connections: { jira: "initial" },
            writeGenerations: { jira: 4 },
          }),
        ),
        Effect.provideService(WriteOperationStore, unusedOperations),
        Effect.flip,
      );
      expect(failure).toMatchObject({ code: "forbidden" });
    }),
  );

  it.effect("rejects a turn admitted before the write permission generation changed", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ rows: [writeRow()] });
      const oldGrant = RelayIssueTrackerTurnPrincipal.of({
        ...claims,
        writeGenerations: { linear: 3 },
      });
      const error = yield* prepareComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "invocation-1",
        service: "linear",
        issue: "LP-42",
        body: "A comment",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, oldGrant),
        Effect.provideService(WriteOperationStore, unusedOperations),
        Effect.flip,
      );
      expect(error._tag).toBe("RelayAuthInvalidError");
      expect(test.requests).toHaveLength(0);
    }),
  );
});

describe("execute issue comments", () => {
  const payload = encodeJson({
    service: "linear",
    identifier: "LP-42",
    issueUrl: "https://linear.app/launchpad/issue/LP-42",
    issueId: "issue-id",
    body: "Approved comment",
  });
  const operation = {
    operationId: "operation-1",
    action: "add_comment",
    ownerUserId: "org",
    service: "linear",
    environmentId: "environment-1",
    threadId: "thread-1",
    commandId: "command-1",
    providerSessionId: "session-1",
    connectionVersion: "initial",
    writeGeneration: 4,
    state: "ready",
    payloadSealed: `sealed:${payload}`,
  } as WriteOperationRecord;
  const fullAccess = RelayIssueTrackerTurnPrincipal.of({ ...claims, runtimeMode: "full-access" });

  it.effect("posts once and stores the provider-returned comment identity", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(
        (name) =>
          Effect.succeed(
            name === "save_comment"
              ? { id: "comment-1" }
              : name === "list_comments"
                ? { comments: [{ id: "comment-1", body: "Approved comment" }], hasNextPage: false }
                : undefined,
          ),
        ["save_comment"],
        [writeRow()],
      );
      let saved: { resourceId: string; url: string } | undefined;
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        get: () => Effect.succeed(operation),
        claim: () => Effect.succeed({ ...operation, state: "executing", claimFence: "fence" }),
        outcomeUnknown: (_id, _fence, _error, result) =>
          Effect.sync(() => {
            if (result) saved = result;
            return true;
          }),
        reconcileUnknown: () => Effect.succeed({ ...operation, state: "succeeded" }),
      });
      const result = yield* executeComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "operation-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, fullAccess),
        Effect.provideService(WriteOperationStore, operations),
      );
      expect(result).toMatchObject({ state: "succeeded", resourceId: "comment-1" });
      expect(saved).toMatchObject({ resourceId: "comment-1" });
      expect(test.calls.filter((call) => call.name === "save_comment")).toEqual([
        { name: "save_comment", arguments: { issueId: "issue-id", body: "Approved comment" } },
      ]);
      expect(test.calls.filter((call) => call.name === "list_comments")).toHaveLength(2);
    }),
  );

  it.effect(
    "reports an unknown outcome instead of posting again when read-back cannot confirm",
    () =>
      Effect.gen(function* () {
        const test = yield* mcpFixture(
          (name) => Effect.succeed(name === "save_comment" ? { id: "comment-1" } : undefined),
          ["save_comment"],
          [writeRow()],
        );
        let unknown = false;
        const operations = WriteOperationStore.of({
          ...unusedOperations,
          get: () => Effect.succeed(operation),
          claim: () => Effect.succeed({ ...operation, state: "executing", claimFence: "fence" }),
          outcomeUnknown: () =>
            Effect.sync(() => {
              unknown = true;
              return true;
            }),
        });
        const result = yield* executeComment({
          environmentId: "environment-1",
          providerSessionId: "session-1",
          operationId: "operation-1",
        }).pipe(
          test.provide,
          Effect.provideService(RelayIssueTrackerTurnPrincipal, fullAccess),
          Effect.provideService(WriteOperationStore, operations),
        );
        expect(result.state).toBe("outcome_unknown");
        expect(unknown).toBe(true);
        expect(test.calls.filter((call) => call.name === "save_comment")).toHaveLength(1);
      }),
  );

  it.effect("settles an interrupted claimed comment without dispatching it twice", () =>
    Effect.gen(function* () {
      const enteredProvider = yield* Deferred.make<void>();
      const test = yield* mcpFixture(
        (name) =>
          name === "save_comment"
            ? Deferred.succeed(enteredProvider, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(undefined),
        ["save_comment"],
        [writeRow()],
      );
      let state = "ready";
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        get: () => Effect.succeed({ ...operation, state } as WriteOperationRecord),
        claim: () =>
          Effect.sync(() => {
            state = "executing";
            return { ...operation, state, claimFence: "fence" } as WriteOperationRecord;
          }),
        outcomeUnknown: () =>
          Effect.sync(() => {
            if (state === "executing") state = "outcome_unknown";
            return true;
          }),
      });
      const execute = executeComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "operation-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, fullAccess),
        Effect.provideService(WriteOperationStore, operations),
      );
      const fiber = yield* execute.pipe(Effect.forkChild);
      yield* Deferred.await(enteredProvider);
      yield* Fiber.interrupt(fiber);
      expect(state).toBe("outcome_unknown");
      expect((yield* execute).state).toBe("outcome_unknown");
      expect(test.calls.filter((call) => call.name === "save_comment")).toHaveLength(1);
    }),
  );

  it.effect("keeps the returned comment ID when read-back is interrupted", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const test = yield* mcpFixture(
        (name) =>
          name === "save_comment"
            ? Effect.succeed({ id: "comment-1" })
            : name === "list_comments"
              ? state === "outcome_unknown"
                ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({ comments: [], hasNextPage: false })
              : Effect.succeed(undefined),
        ["save_comment"],
        [writeRow()],
      );
      let state = "ready";
      let candidate: { resourceId: string; url: string } | undefined;
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        get: () => Effect.succeed({ ...operation, state } as WriteOperationRecord),
        claim: () =>
          Effect.sync(() => {
            state = "executing";
            return { ...operation, state, claimFence: "fence" } as WriteOperationRecord;
          }),
        outcomeUnknown: (_id, _fence, _error, result) =>
          Effect.sync(() => {
            if (state === "executing") {
              state = "outcome_unknown";
              candidate = result;
            }
            return true;
          }),
      });
      const execute = executeComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "operation-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, fullAccess),
        Effect.provideService(WriteOperationStore, operations),
      );
      const fiber = yield* execute.pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(fiber);
      expect(state).toBe("outcome_unknown");
      expect(candidate).toMatchObject({ resourceId: "comment-1" });
      expect((yield* execute).state).toBe("outcome_unknown");
      expect(test.calls.filter((call) => call.name === "save_comment")).toHaveLength(1);
    }),
  );

  it.effect("does not dispatch an unapproved proposal", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(undefined, [], [writeRow()]);
      const operations = WriteOperationStore.of({
        ...unusedOperations,
        get: () => Effect.succeed({ ...operation, state: "awaiting_approval" }),
      });
      const error = yield* executeComment({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "operation-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, fullAccess),
        Effect.provideService(WriteOperationStore, operations),
        Effect.flip,
      );
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(test.calls).toHaveLength(0);
    }),
  );

  it.effect("uses the Jira comment tool and argument names advertised to this grant", () =>
    Effect.gen(function* () {
      for (const [returnedBody, readRoute, writeResponse] of [
        ["Jira note\r\n", "executeRead", "structured"],
        [
          {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Jira note" }] }],
          },
          "listJiraIssueComments",
          "structured",
        ],
        ["Jira note", "listJiraIssueComments", "text-data-comment-id"],
      ] as const) {
        const sent: { name: string; arguments: Record<string, unknown> }[] = [];
        let posted = false;
        const test = yield* fixture({
          rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
          rawHttp: true,
          respond: (request) =>
            Effect.sync(() => {
              if (request.method === "DELETE") return new Response(null, { status: 204 });
              if (request.body._tag !== "Uint8Array") throw new Error("Missing Jira request");
              const rpc = decodeWriteRpc(new TextDecoder().decode(request.body.body));
              if (rpc.method === "notifications/initialized")
                return new Response(null, { status: 202 });
              if (rpc.params?.name && rpc.params.arguments)
                sent.push({ name: rpc.params.name, arguments: rpc.params.arguments });
              const result =
                rpc.method === "initialize"
                  ? { protocolVersion: "2025-11-25" }
                  : rpc.method === "tools/list"
                    ? {
                        tools: [
                          {
                            name: "addCommentToJiraIssue",
                            inputSchema: {
                              properties: {
                                cloudId: {},
                                issueIdOrKey: {},
                                commentBody: {},
                                contentFormat: {},
                              },
                            },
                          },
                          { name: readRoute, inputSchema: {} },
                        ],
                      }
                    : rpc.params?.name === "addCommentToJiraIssue"
                      ? ((posted = true),
                        writeResponse === "text-data-comment-id"
                          ? {
                              content: [
                                {
                                  type: "text",
                                  text: encodeJson({
                                    data: {
                                      message: "Comment added successfully",
                                      commentId: "comment-1",
                                      body: "Jira note",
                                      appliedContentFormat: "markdown",
                                      jsmCommentType: "public",
                                    },
                                  }),
                                },
                              ],
                            }
                          : { structuredContent: { id: "comment-1" } })
                      : rpc.params?.name === readRoute
                        ? {
                            structuredContent: {
                              comments:
                                posted &&
                                (readRoute === "executeRead"
                                  ? (rpc.params.arguments?.inputs as { startAt?: number })?.startAt
                                  : rpc.params.arguments?.startAt) === 950
                                  ? [{ id: "comment-1", body: returnedBody, issueKey: "LP-42" }]
                                  : [],
                              total: posted ? 1_000 : 0,
                            },
                          }
                        : {
                            structuredContent: {
                              key: "LP-42",
                              fields: { summary: "Example" },
                            },
                          };
              return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
            }),
        });
        const jiraOperation = {
          ...operation,
          service: "jira",
          target: "https://launchpad.atlassian.net/browse/LP-42",
          payloadSealed: `sealed:${encodeJson({
            service: "jira",
            identifier: "LP-42",
            issueUrl: "https://launchpad.atlassian.net/browse/LP-42",
            body: "Jira note",
          })}`,
        } as WriteOperationRecord;
        const store = WriteOperationStore.of({
          ...unusedOperations,
          get: () => Effect.succeed(jiraOperation),
          claim: () =>
            Effect.succeed({ ...jiraOperation, state: "executing", claimFence: "fence" }),
          outcomeUnknown: () => Effect.succeed(true),
          reconcileUnknown: () => Effect.succeed({ ...jiraOperation, state: "succeeded" }),
        });
        const jiraClaims = RelayIssueTrackerTurnPrincipal.of({
          ...claims,
          connections: { jira: "initial" },
          writeGenerations: { jira: 4 },
        });
        const result = yield* executeComment({
          environmentId: "environment-1",
          providerSessionId: "session-1",
          operationId: "operation-1",
        }).pipe(
          test.provide,
          Effect.provideService(RelayIssueTrackerTurnPrincipal, jiraClaims),
          Effect.provideService(WriteOperationStore, store),
        );
        expect(result.state).toBe("succeeded");
        expect(sent.filter((call) => call.name === "addCommentToJiraIssue")).toEqual([
          {
            name: "addCommentToJiraIssue",
            arguments: {
              cloudId: "cloud",
              issueIdOrKey: "LP-42",
              commentBody: "Jira note",
              contentFormat: "markdown",
            },
          },
        ]);
        expect(
          sent
            .filter((call) => call.name === readRoute)
            .some(
              (call) =>
                (readRoute === "executeRead"
                  ? (call.arguments.inputs as { startAt?: number })?.startAt
                  : call.arguments.startAt) === 950,
            ),
        ).toBe(true);
      }
    }),
  );

  it.effect(
    "keeps Jira comments uncertain when the returned ID has no matching body on this issue",
    () =>
      Effect.gen(function* () {
        for (const comment of [
          { id: "comment-1", body: "Different note", issueKey: "LP-42" },
          { id: "comment-1", body: "Jira note", issueKey: "OTHER-7" },
        ]) {
          let posts = 0;
          const test = yield* fixture({
            rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
            rawHttp: true,
            respond: (request) =>
              Effect.sync(() => {
                if (request.method === "DELETE") return new Response(null, { status: 204 });
                if (request.body._tag !== "Uint8Array") throw new Error("Missing Jira request");
                const rpc = decodeWriteRpc(new TextDecoder().decode(request.body.body));
                if (rpc.method === "notifications/initialized")
                  return new Response(null, { status: 202 });
                const result =
                  rpc.method === "initialize"
                    ? { protocolVersion: "2025-11-25" }
                    : rpc.method === "tools/list"
                      ? {
                          tools: [
                            { name: "executeRead", inputSchema: {} },
                            {
                              name: "addCommentToJiraIssue",
                              inputSchema: { properties: { body: {} } },
                            },
                          ],
                        }
                      : rpc.params?.name === "executeRead"
                        ? { structuredContent: { comments: posts ? [comment] : [], total: posts } }
                        : rpc.params?.name === "addCommentToJiraIssue"
                          ? (posts++, { structuredContent: { id: "comment-1" } })
                          : { structuredContent: { key: "LP-42", fields: { summary: "Example" } } };
                return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
              }),
          });
          const jiraOperation = {
            ...operation,
            service: "jira",
            target: "https://launchpad.atlassian.net/browse/LP-42",
            payloadSealed: `sealed:${encodeJson({
              service: "jira",
              identifier: "LP-42",
              issueUrl: "https://launchpad.atlassian.net/browse/LP-42",
              body: "Jira note",
            })}`,
          } as WriteOperationRecord;
          let candidate: { resourceId: string; url: string } | undefined;
          const store = WriteOperationStore.of({
            ...unusedOperations,
            get: () => Effect.succeed(jiraOperation),
            claim: () =>
              Effect.succeed({ ...jiraOperation, state: "executing", claimFence: "fence" }),
            outcomeUnknown: (_id, _fence, _error, result) =>
              Effect.sync(() => {
                if (result) candidate = result;
                return true;
              }),
          });
          const result = yield* executeComment({
            environmentId: "environment-1",
            providerSessionId: "session-1",
            operationId: "operation-1",
          }).pipe(
            test.provide,
            Effect.provideService(
              RelayIssueTrackerTurnPrincipal,
              RelayIssueTrackerTurnPrincipal.of({
                ...claims,
                connections: { jira: "initial" },
                writeGenerations: { jira: 4 },
              }),
            ),
            Effect.provideService(WriteOperationStore, store),
          );
          expect(result.state).toBe("outcome_unknown");
          expect(candidate).toMatchObject({ resourceId: "comment-1" });
          expect(posts).toBe(1);
        }
      }),
  );
});
