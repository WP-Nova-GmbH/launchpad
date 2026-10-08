import { EnvironmentId } from "@t3tools/contracts";
import { RelayIssueTrackerTurnPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  encodeJson,
  jiraRow,
  linearOAuth,
  linearRow,
  fixture,
} from "./Connections.test-fixture.ts";
import { mcpFixture, issue } from "./LinearMcp.test-fixture.ts";
import { WriteOperationStore, type WriteOperationRecord } from "./WriteOperationStore.ts";
import { executeEdit, prepareEdit } from "./WriteIssueEdits.ts";

const claims = RelayIssueTrackerTurnPrincipal.of({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: "thread-1",
  commandId: "command-1",
  commandDigest: "a".repeat(64),
  runtimeMode: "full-access",
  ownerUserId: "org",
  expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
  connections: { linear: "initial" },
  writeGenerations: { linear: 4 },
});
const row = () => ({
  ...linearRow(),
  writesEnabled: true,
  writeGeneration: 4,
  payloadSealed: `sealed:${encodeJson({
    service: "linear",
    oauth: {
      ...linearOAuth,
      resource: "https://mcp.linear.app/mcp",
    },
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
      field: Schema.String,
      value: Schema.String,
      issueId: Schema.String,
    }),
  ),
);
const decodeRpc = Schema.decodeUnknownSync(
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
const unused = WriteOperationStore.of({
  prepare: () => Effect.die("unexpected prepare"),
  get: () => Effect.die("unexpected get"),
  findUnknown: () => Effect.succeed(null),
  approve: () => Effect.die("unexpected approve"),
  reject: () => Effect.die("unexpected reject"),
  cancel: () => Effect.die("unexpected cancel"),
  claim: () => Effect.die("unexpected claim"),
  outcomeUnknown: () => Effect.die("unexpected outcomeUnknown"),
  reconcileUnknown: () => Effect.die("unexpected reconcileUnknown"),
  reconcileVerifiedUnknown: () => Effect.die("unexpected reconcileVerifiedUnknown"),
});
const operation = {
  operationId: "edit-1",
  action: "edit_issue",
  ownerUserId: "org",
  service: "linear",
  environmentId: "environment-1",
  threadId: "thread-1",
  commandId: "command-1",
  providerSessionId: "session-1",
  connectionVersion: "initial",
  writeGeneration: 4,
  state: "ready",
  payloadSealed: `sealed:${encodeJson({
    service: "linear",
    identifier: "LP-42",
    issueUrl: issue.url,
    issueId: "issue-id",
    field: "title",
    value: "New title",
    providerValue: "New title",
    expectedValue: "New title",
  })}`,
  baselineSealed: `sealed:${encodeJson({ value: issue.title })}`,
} as WriteOperationRecord;

describe("issue field edits", () => {
  it.effect("rejects Jira description edits before provider access", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ rows: [] });
      const failure = yield* prepareEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "description-jira",
        service: "jira",
        issue: "LP-42",
        field: "description",
        value: "Replacement",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, unused),
        Effect.flip,
      );
      expect(failure).toMatchObject({ code: "invalid_input" });
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("refuses an older prepared Jira description edit before claiming it", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
      });
      const oldOperation = {
        ...operation,
        service: "jira",
        payloadSealed: `sealed:${encodeJson({
          service: "jira",
          identifier: "LP-42",
          issueUrl: "https://launchpad.atlassian.net/browse/LP-42",
          field: "description",
          value: "Replacement",
          providerValue: "Replacement",
          expectedValue: "Replacement",
        })}`,
      } as WriteOperationRecord;
      const store = WriteOperationStore.of({
        ...unused,
        get: () => Effect.succeed(oldOperation),
      });
      const failure = yield* executeEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "edit-1",
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
        Effect.flip,
      );
      expect(failure).toMatchObject({ code: "invalid_input" });
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("still prepares a Linear description replacement", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(undefined, [], [row()]);
      let prepared: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
      const store = WriteOperationStore.of({
        ...unused,
        prepare: (input) =>
          Effect.sync(() => {
            prepared = input;
            return { operation: input as WriteOperationRecord, reused: false };
          }),
      });
      yield* prepareEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "description-linear",
        service: "linear",
        issue: "LP-42",
        field: "description",
        value: "New description",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      expect(decodePayload(prepared!.payloadSealed!.slice(7))).toMatchObject({
        field: "description",
        value: "New description",
      });
    }),
  );

  it.effect("reconciles a saved edit candidate before rejecting an already matching field", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(undefined, [], [row()]);
      const unknown = {
        ...operation,
        state: "outcome_unknown",
        resultResourceId: "LP-42",
        resultUrl: issue.url,
        payloadSealed: `sealed:${encodeJson({
          service: "linear",
          identifier: "LP-42",
          issueUrl: issue.url,
          issueId: "issue-id",
          field: "title",
          value: issue.title,
          providerValue: issue.title,
          expectedValue: issue.title,
        })}`,
      } as WriteOperationRecord;
      let reconciled = false;
      const store = WriteOperationStore.of({
        ...unused,
        findUnknown: () => Effect.succeed(unknown),
        reconcileVerifiedUnknown: () =>
          Effect.sync(() => {
            reconciled = true;
            return { ...unknown, state: "succeeded" } as WriteOperationRecord;
          }),
      });
      const result = yield* prepareEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "retry-edit",
        service: "linear",
        issue: "LP-42",
        field: "title",
        value: issue.title,
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      expect(reconciled).toBe(true);
      expect(result.operation.state).toBe("succeeded");
    }),
  );
  it.effect.each([
    { outcome: "confirmed", stream: "rejected" },
    { outcome: "confirmed", stream: "closed" },
    { outcome: "lost-response", stream: "unsupported" },
    { outcome: "interrupted", stream: "unsupported" },
  ] as const)(
    "handles a $outcome Jira status transition with a $stream notification stream",
    ({ outcome, stream }) =>
      Effect.gen(function* () {
        let status = "To Do";
        let state = "ready";
        const enteredWrite = yield* Deferred.make<void>();
        const sent: { name: string; arguments: Record<string, unknown> }[] = [];
        const test = yield* fixture({
          rows: [{ ...jiraRow(), writesEnabled: true, writeGeneration: 4 }],
          rawHttp: true,
          respond: (request) =>
            Effect.gen(function* () {
              if (request.method === "GET")
                return stream === "closed"
                  ? new Response("", { headers: { "content-type": "text/event-stream" } })
                  : new Response(null, { status: stream === "rejected" ? 500 : 405 });
              if (request.method === "DELETE") return new Response(null, { status: 204 });
              if (request.body._tag !== "Uint8Array") throw new Error("Missing Jira request body");
              const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
              if (rpc.method === "notifications/initialized")
                return new Response(null, { status: 202 });
              if (rpc.params?.name && rpc.params.arguments)
                sent.push({ name: rpc.params.name, arguments: rpc.params.arguments });
              if (rpc.params?.name === "transitionJiraIssue" && outcome !== "confirmed") {
                status = "In Progress";
                if (outcome === "lost-response") return new Response(null, { status: 503 });
                yield* Deferred.succeed(enteredWrite, undefined);
                return yield* Effect.never;
              }
              const result =
                rpc.method === "initialize"
                  ? {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "Jira", version: "1" },
                    }
                  : rpc.method === "tools/list"
                    ? {
                        tools: ["getTransitionsForJiraIssue", "transitionJiraIssue"].map(
                          (name) => ({
                            name,
                            inputSchema: { type: "object", properties: {} },
                          }),
                        ),
                      }
                    : rpc.params?.name === "getTransitionsForJiraIssue"
                      ? {
                          structuredContent: {
                            transitions: [
                              { id: "31", name: "Start Progress", to: { name: "In Progress" } },
                            ],
                          },
                        }
                      : rpc.params?.name === "transitionJiraIssue"
                        ? ((status = "In Progress"), { structuredContent: { success: true } })
                        : {
                            structuredContent: {
                              key: "LP-42",
                              fields: { summary: "Example", status: { name: status } },
                            },
                          };
              return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
            }),
        });
        let prepared: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
        const store = WriteOperationStore.of({
          ...unused,
          prepare: (input) =>
            Effect.sync(() => {
              prepared = input;
              return {
                operation: {
                  ...input,
                  operationId: "edit-jira",
                  state: "ready",
                } as WriteOperationRecord,
                reused: false,
              };
            }),
          get: () =>
            Effect.succeed({
              ...prepared,
              operationId: "edit-jira",
              state,
            } as WriteOperationRecord),
          claim: () =>
            Effect.sync(() => {
              state = "executing";
              return {
                ...prepared,
                operationId: "edit-jira",
                state,
                claimFence: "fence",
              } as WriteOperationRecord;
            }),
          outcomeUnknown: () =>
            Effect.sync(() => {
              if (state === "executing") state = "outcome_unknown";
              return true;
            }),
          reconcileUnknown: () =>
            Effect.sync(() => {
              state = "succeeded";
              return { ...operation, state } as WriteOperationRecord;
            }),
        });
        const jiraClaims = RelayIssueTrackerTurnPrincipal.of({
          ...claims,
          connections: { jira: "initial" },
          writeGenerations: { jira: 4 },
        });
        yield* prepareEdit({
          environmentId: "environment-1",
          providerSessionId: "session-1",
          invocationId: "invocation-jira",
          service: "jira",
          issue: "LP-42",
          field: "status",
          value: "In Progress",
        }).pipe(
          test.provide,
          Effect.provideService(RelayIssueTrackerTurnPrincipal, jiraClaims),
          Effect.provideService(WriteOperationStore, store),
        );
        const execute = executeEdit({
          environmentId: "environment-1",
          providerSessionId: "session-1",
          operationId: "edit-jira",
        }).pipe(
          test.provide,
          Effect.provideService(RelayIssueTrackerTurnPrincipal, jiraClaims),
          Effect.provideService(WriteOperationStore, store),
        );
        if (outcome === "interrupted") {
          const fiber = yield* execute.pipe(Effect.forkChild);
          yield* Deferred.await(enteredWrite);
          yield* Fiber.interrupt(fiber);
          expect(state).toBe("outcome_unknown");
        } else {
          expect((yield* execute).state).toBe(
            outcome === "confirmed" ? "succeeded" : "outcome_unknown",
          );
        }
        if (outcome !== "confirmed") expect((yield* execute).state).toBe("outcome_unknown");
        expect(status).toBe("In Progress");
        expect(test.requests.filter((request) => request.method === "GET")).toEqual([]);
        expect(sent.filter((call) => call.name === "transitionJiraIssue")).toEqual([
          {
            name: "transitionJiraIssue",
            arguments: { cloudId: "cloud", issueIdOrKey: "LP-42", transition: { id: "31" } },
          },
        ]);
      }),
  );

  it.effect("prepares one exact Linear field replacement", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(undefined, [], [row()]);
      let prepared: Parameters<WriteOperationStore["Service"]["prepare"]>[0] | undefined;
      const store = WriteOperationStore.of({
        ...unused,
        prepare: (input) =>
          Effect.sync(() => {
            prepared = input;
            return { operation: input as WriteOperationRecord, reused: false };
          }),
      });
      yield* prepareEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        invocationId: "invocation-1",
        service: "linear",
        issue: "LP-42",
        field: "title",
        value: "New title",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      expect(prepared).toMatchObject({
        action: "edit_issue",
        target: "workspace:issue-id",
        ownerUserId: "org",
        commandId: "command-1",
      });
      expect(decodePayload(prepared!.payloadSealed!.slice(7))).toMatchObject({
        field: "title",
        value: "New title",
        issueId: "issue-id",
      });
    }),
  );

  it.effect("writes once and confirms the exact changed field by reading it back", () =>
    Effect.gen(function* () {
      let title = issue.title;
      const test = yield* mcpFixture(
        (name, args) =>
          Effect.sync(() => {
            if (name === "get_issue") return { ...issue, title };
            if (name === "save_issue") {
              title = args.title as string;
              return { id: "issue-id" };
            }
            return undefined;
          }),
        ["save_issue"],
        [row()],
      );
      let saved = false;
      const store = WriteOperationStore.of({
        ...unused,
        get: () => Effect.succeed(operation),
        claim: () => Effect.succeed({ ...operation, state: "executing", claimFence: "fence" }),
        outcomeUnknown: () => Effect.succeed(true),
        reconcileUnknown: () =>
          Effect.sync(() => {
            saved = true;
            return { ...operation, state: "succeeded" };
          }),
      });
      const result = yield* executeEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "edit-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      expect(result.state).toBe("succeeded");
      expect(saved).toBe(true);
      expect(test.calls.filter((call) => call.name === "save_issue")).toEqual([
        { name: "save_issue", arguments: { id: "issue-id", title: "New title" } },
      ]);
    }),
  );

  it.effect("blocks a stale baseline before any write", () =>
    Effect.gen(function* () {
      const test = yield* mcpFixture(
        (name) =>
          Effect.succeed(
            name === "get_issue" ? { ...issue, title: "Changed elsewhere" } : undefined,
          ),
        ["save_issue"],
        [row()],
      );
      const store = WriteOperationStore.of({ ...unused, get: () => Effect.succeed(operation) });
      const failure = yield* executeEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "edit-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
        Effect.flip,
      );
      expect(failure).toMatchObject({ code: "conflict" });
      expect(test.calls.some((call) => call.name === "save_issue")).toBe(false);
    }),
  );

  it.effect("settles an interrupted claimed edit and refuses a second dispatch", () =>
    Effect.gen(function* () {
      const enteredProvider = yield* Deferred.make<void>();
      const test = yield* mcpFixture(
        (name) =>
          name === "save_issue"
            ? Deferred.succeed(enteredProvider, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(name === "get_issue" ? issue : undefined),
        ["save_issue"],
        [row()],
      );
      let state = "ready";
      const store = WriteOperationStore.of({
        ...unused,
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
      const execute = executeEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "edit-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      const fiber = yield* execute.pipe(Effect.forkChild);
      yield* Deferred.await(enteredProvider);
      yield* Fiber.interrupt(fiber);
      expect(state).toBe("outcome_unknown");
      expect((yield* execute).state).toBe("outcome_unknown");
      expect(test.calls.filter((call) => call.name === "save_issue")).toHaveLength(1);
    }),
  );

  it.effect("keeps the edit candidate when read-back is interrupted", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const test = yield* mcpFixture(
        (name) => {
          if (name === "save_issue") return Effect.succeed({ id: "issue-id" });
          if (name === "get_issue") {
            return state === "outcome_unknown"
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(issue);
          }
          return Effect.succeed(undefined);
        },
        ["save_issue"],
        [row()],
      );
      let state = "ready";
      let candidate: { resourceId: string; url: string } | undefined;
      const store = WriteOperationStore.of({
        ...unused,
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
      const execute = executeEdit({
        environmentId: "environment-1",
        providerSessionId: "session-1",
        operationId: "edit-1",
      }).pipe(
        test.provide,
        Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
        Effect.provideService(WriteOperationStore, store),
      );
      const fiber = yield* execute.pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(fiber);
      expect(state).toBe("outcome_unknown");
      expect(candidate).toMatchObject({ resourceId: "LP-42", url: issue.url });
      expect(test.calls.filter((call) => call.name === "save_issue")).toHaveLength(1);
    }),
  );
});
