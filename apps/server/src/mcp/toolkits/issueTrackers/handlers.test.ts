import { McpSchema, McpServer } from "effect/unstable/ai";
import { IssueTrackersToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { RelayReadIssueRequest, type RelayReadIssueResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import {
  setMcpProviderSession,
  bindIssueTrackerTurn,
  completeIssueTrackerTurn,
} from "../../McpProviderSession.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkitHandlersLive } from "./handlers.ts";
import { IssueTrackersToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-1");
const credential = "personal-turn-secret";
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(RelayReadIssueRequest));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result: RelayReadIssueResponse = {
  service: "jira",
  accountLabel: "acme.atlassian.net",
  identifier: "ENG-123",
  title: "Fix queue",
  description: "Keep Steer visible",
  url: "https://acme.atlassian.net/browse/ENG-123",
  status: "In progress",
  assignee: null,
};
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  issueTrackerAuthorizationId: "command-1",
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly grant?: boolean;
    readonly admitted?: boolean;
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const readSecrets: string[] = [];
  const scope = invocation(["issue-trackers"]);
  setMcpProviderSession({
    ...scope,
    endpoint: "http://localhost/mcp",
    authorizationHeader: "Bearer session-secret",
  });
  if (options.admitted !== false)
    bindIssueTrackerTurn(scope.threadId, scope.providerSessionId, "turn-1");
  const values = new Map(
    options.grant === false
      ? []
      : [
          [
            `issue-tracker-turn-${Buffer.from("command-1").toString("base64url")}`,
            encodeJson({
              authorization: credential,
              relayUrl: "https://relay.example.test",
              claims: {
                ownerUserId: "alice",
                environmentId,
                threadId: scope.threadId,
                commandId: "command-1",
                commandDigest: "a".repeat(64),
                expiresAt: 4102444800000,
                connections: { jira: "v1", linear: "v1" },
              },
            }),
          ],
        ],
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) =>
        Effect.sync(() => {
          readSecrets.push(name);
          const value = values.get(name);
          return value === undefined ? Option.none() : Option.some(new TextEncoder().encode(value));
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(
            request,
            options.respond?.(request) ?? Response.json(result),
          );
        }),
      ),
    ),
  );
  const toolkit = yield* IssueTrackersToolkit.pipe(
    Effect.provide(IssueTrackersToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    name: keyof typeof IssueTrackersToolkit.tools = "read_jira_issue",
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["issue-trackers"],
  ) =>
    toolkit.handle(name, { issue: "ENG-123" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((entries) => entries.at(-1)?.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    );
  return { call, requests, readSecrets, dependencies };
});

describe("issue tracker MCP handlers", () => {
  it.effect("denies personal reads before the submitted prompt is admitted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ admitted: false });
      expect(yield* harness.call().pipe(Effect.flip)).toMatchObject({ code: "not_configured" });
      expect(harness.requests).toHaveLength(0);
      expect(harness.readSecrets).toHaveLength(0);
    }),
  );
  it.effect("refuses a provider credential without the issue tracker capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("read_jira_issue", ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "RelayIssueTrackerError", code: "not_configured" });
      expect(error.message).toContain("Account → Connections");
      expect(harness.requests).toHaveLength(0);
      expect(harness.readSecrets).toHaveLength(0);
    }),
  );

  it.effect("rejects missing personal grants even when the provider has the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ grant: false });
      expect(yield* harness.call().pipe(Effect.flip)).toMatchObject({ code: "not_configured" });
      expect(harness.requests).toHaveLength(0);
    }),
  );

  it.effect("rejects calls after completion and from a replaced provider session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const scope = invocation(["issue-trackers"]);
      bindIssueTrackerTurn(scope.threadId, scope.providerSessionId, "turn-1");
      completeIssueTrackerTurn(scope.threadId, scope.providerInstanceId, "turn-1");
      expect(yield* harness.call().pipe(Effect.flip)).toMatchObject({ code: "not_configured" });
      setMcpProviderSession({
        ...scope,
        providerSessionId: "replacement",
        issueTrackerAuthorizationId: "other-user-grant",
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer another",
      });
      expect(yield* harness.call().pipe(Effect.flip)).toMatchObject({ code: "not_configured" });
      expect(harness.requests).toHaveLength(0);
    }),
  );

  it.effect(
    "reads through the relay for the credential's environment and uses the initiating user’s grant",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.call()).toEqual(result);
        expect(harness.requests).toHaveLength(1);
        const request = harness.requests[0]!;
        expect(request.url).toBe(
          "https://relay.example.test/v1/environments/environment-1/issue-trackers/jira/read",
        );
        expect(request.headers.authorization).toBe(`Bearer ${credential}`);
        expect(request.method).toBe("POST");
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") {
          expect(yield* decodeRequest(new TextDecoder().decode(request.body.body))).toEqual({
            issue: "ENG-123",
          });
        }
        expect(harness.readSecrets.every((name) => name.startsWith("issue-tracker-turn-"))).toBe(
          true,
        );
      }),
  );

  it.effect("routes the fixed Linear tool to the same scoped relay path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () => Response.json({ ...result, service: "linear", accountLabel: "Acme" }),
      });
      expect(yield* harness.call("read_linear_issue")).toMatchObject({
        service: "linear",
        accountLabel: "Acme",
      });
      expect(harness.requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/environment-1/issue-trackers/linear/read",
      );
    }),
  );

  it.effect(
    "preserves actionable relay failure codes without leaking arbitrary upstream text",
    () =>
      Effect.gen(function* () {
        for (const code of ["auth_required", "forbidden", "not_found", "not_configured"] as const) {
          const harness = yield* makeHarness({
            respond: () =>
              Response.json(
                {
                  _tag: "RelayIssueTrackerError",
                  code,
                  message: `Unsafe upstream details ${credential}`,
                },
                { status: 400 },
              ),
          });
          const error = yield* harness.call().pipe(Effect.flip);
          expect(error).toMatchObject({ code });
          expect(encodeJson(error)).not.toContain(credential);
          expect(error.message).not.toContain("Unsafe upstream");
        }
      }),
  );

  it.effect("hides HTTP error requests containing the personal turn grant", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () => new Response(`Request failed with ${credential}`, { status: 502 }),
      });
      const error = yield* harness.call().pipe(Effect.flip);
      expect(error).toMatchObject({ code: "unavailable" });
      expect(encodeJson(error)).not.toContain(credential);
    }),
  );
});

it.effect(
  "delivers Linear image bytes as MCP image content without copying them into metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const imageResult = {
          service: "linear",
          accountLabel: "Team app",
          identifier: "LP-1",
          url: "https://linear.app/team/issue/LP-1",
          workspaceId: "workspace",
          issueId: "issue",
          image: { mimeType: "image/png", data: "iVBORw==" },
        };
        const harness = yield* makeHarness({ respond: () => Response.json(imageResult) });
        const output = yield* callRegisteredTool(harness, "view_linear_image");
        expect(output.isError).toBe(false);
        expect(output.content).toContainEqual({
          type: "image",
          mimeType: "image/png",
          data: new Uint8Array([137, 80, 78, 71]),
        });
        expect(output.structuredContent).toMatchObject({
          accountLabel: "Team app",
          identifier: "LP-1",
        });
        expect(encodeJson(output.structuredContent)).not.toContain(imageResult.image.data);
        expect(encodeJson(output.content.filter((block) => block.type === "text"))).not.toContain(
          imageResult.image.data,
        );
        expect(harness.requests[0]?.url).toContain("/issue-trackers/linear/image");
      }),
    ),
);

function callRegisteredTool(harness: Effect.Success<ReturnType<typeof makeHarness>>, name: string) {
  const layer = IssueTrackersToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(harness.dependencies),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({
      name,
      arguments: { reference: "source-reference" },
    });
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(["issue-trackers"]),
    ),
    Effect.provideService(
      McpSchema.McpServerClient,
      McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    ),
  );
}

it.effect.each([
  { code: "image_too_large", text: "5 MiB" },
  { code: "unsupported_image", text: "not a supported image" },
  { code: "forbidden", text: "permission" },
  { code: "auth_required", text: "Account → Connections" },
  { code: "conflict", text: "Read the issue again" },
  { code: "not_found", text: "no longer accessible" },
  { code: "unavailable", text: "Try again later" },
])("reports a safe, actionable image failure for $code through MCP", ({ code, text }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () =>
          Response.json(
            { _tag: "RelayIssueTrackerError", code, message: `Unsafe upstream ${credential}` },
            { status: 400 },
          ),
      });
      const output = yield* callRegisteredTool(harness, "view_linear_image");
      expect(output.isError).toBe(true);
      expect(output.structuredContent).toMatchObject({
        error: { code, message: expect.stringContaining(text) },
      });
      expect(output.content).toContainEqual({ type: "text", text: expect.stringContaining(text) });
      expect(encodeJson(output)).not.toContain(credential);
      expect(encodeJson(output)).not.toContain("Unsafe upstream");
    }),
  ),
);

it.effect("routes image-reference pagination through the managed relay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () =>
          Response.json({
            service: "linear",
            accountLabel: "Team app",
            identifier: "LP-1",
            url: "https://linear.app/team/issue/LP-1",
            workspaceId: "workspace",
            issueId: "issue",
            images: [],
            imagesTruncated: false,
            imagesContinuation: null,
          }),
      });
      const output = yield* callRegisteredTool(harness, "read_linear_images");
      expect(output.isError).not.toBe(true);
      expect(harness.requests[0]?.url).toContain("/issue-trackers/linear/images");
    }),
  ),
);
