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
  CLOUD_MACHINE_IDENTITY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
  encodeCloudMachineIdentityJson,
} from "../../../cloud/config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkitHandlersLive } from "./handlers.ts";
import { IssueTrackersToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-1");
const credential = "executor-secret";
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
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly role?: "agent_executor" | "review_host" | "personal";
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const readSecrets: string[] = [];
  const values = new Map([
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, credential],
    ...(options.role === "personal"
      ? []
      : [
          [
            CLOUD_MACHINE_IDENTITY,
            yield* encodeCloudMachineIdentityJson({
              machineId: "machine-1",
              organizationId: "org-1",
              role: options.role ?? "agent_executor",
            }),
          ] as const,
        ]),
  ]);
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
  return { call, requests, readSecrets };
});

describe("issue tracker MCP handlers", () => {
  it.effect("refuses a provider credential without the issue tracker capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("read_jira_issue", ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "RelayIssueTrackerError", code: "not_configured" });
      expect(error.message).toContain("organization-managed executors");
      expect(harness.requests).toHaveLength(0);
      expect(harness.readSecrets).toHaveLength(0);
    }),
  );

  it.effect(
    "rechecks enrollment and rejects personal and review hosts even with a capability",
    () =>
      Effect.gen(function* () {
        for (const role of ["personal", "review_host"] as const) {
          const harness = yield* makeHarness({ role });
          const error = yield* harness.call().pipe(Effect.flip);
          expect(error).toMatchObject({ code: "not_configured" });
          expect(harness.requests).toHaveLength(0);
        }
      }),
  );

  it.effect(
    "reads through the relay for the credential's environment and preserves shared identity",
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
        expect(harness.readSecrets.every((name) => name.startsWith("cloud-"))).toBe(true);
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

  it.effect("hides HTTP error requests containing the environment credential", () =>
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
