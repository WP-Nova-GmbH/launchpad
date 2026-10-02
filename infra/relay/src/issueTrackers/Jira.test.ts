import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { getJiraOAuthSites, readJiraIssue } from "./Jira.ts";

const accessToken = "oauth-access-secret";
const siteUrl = "https://acme.atlassian.net";
const cloudId = "a436116f-02ce-4520-8fbb-7301462a1674";
const input = { siteUrl, cloudId, accessToken, issue: "ENG-123" };
const issue = {
  key: "ENG-123",
  fields: {
    summary: "Fix the queue",
    description: "Keep **Steer** visible.",
    status: { name: "In progress" },
    assignee: { displayName: "Alex" },
  },
};
const RpcRequest = Schema.Struct({
  method: Schema.String,
  id: Schema.optionalKey(Schema.Number),
  params: Schema.optionalKey(Schema.Unknown),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcRequest = Schema.decodeEffect(Schema.fromJsonString(RpcRequest));
const reply = (result: unknown, id = 2) => Response.json({ jsonrpc: "2.0", id, result });
const toolReply = (data: unknown = issue) =>
  reply({ content: [{ type: "text", text: encodeJson(data) }] });

type RecordedRequest = {
  request: HttpClientRequest.HttpClientRequest;
  rpc: typeof RpcRequest.Type | undefined;
};
function harness(respond: (request: RecordedRequest) => Response = () => toolReply()) {
  const requests: RecordedRequest[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const rpc =
        request.body._tag === "Uint8Array"
          ? yield* decodeRpcRequest(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
          : undefined;
      const recorded = { request, rpc };
      requests.push(recorded);
      const response =
        request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : rpc?.method === "initialize"
            ? new Response(
                encodeJson({
                  jsonrpc: "2.0",
                  id: 1,
                  result: { protocolVersion: "2025-06-18" },
                }),
                {
                  headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
                },
              )
            : rpc?.method === "notifications/initialized"
              ? new Response(null, { status: 202 })
              : respond(recorded);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return { requests, provide: Effect.provideService(HttpClient.HttpClient, http) };
}

describe("Jira", () => {
  it.effect("reads Rovo v2 resource envelopes with cloudId and no per-site scopes", () =>
    Effect.gen(function* () {
      const payload = { data: { resources: [{ cloudId, url: siteUrl }] } };
      const { provide } = harness(
        () =>
          new Response(
            `event: message\ndata: ${encodeJson({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: encodeJson(payload) }] } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      expect(yield* getJiraOAuthSites(accessToken).pipe(provide)).toEqual([
        { cloudId, siteUrl, accountLabel: "acme.atlassian.net" },
      ]);
    }),
  );

  it.effect("accepts site lists in text and structured data envelopes", () =>
    Effect.gen(function* () {
      const resources = [
        { id: cloudId, url: siteUrl, name: "Acme", scopes: ["read:jira:agent-interface"] },
        {
          id: "confluence-only",
          url: "https://other.atlassian.net",
          scopes: ["read:confluence:agent-interface"],
        },
      ];
      for (const result of [
        { content: [{ type: "text", text: encodeJson({ data: resources }) }] },
        { structuredContent: { data: resources } },
        { structuredContent: resources },
      ]) {
        const { provide } = harness(
          () =>
            new Response(
              `event: message\ndata: ${encodeJson({ jsonrpc: "2.0", id: 2, result })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
        expect(yield* getJiraOAuthSites(accessToken).pipe(provide)).toEqual([
          { cloudId, siteUrl, accountLabel: "Acme" },
        ]);
      }
    }),
  );

  it.effect("validates resources inside site-list envelopes", () =>
    Effect.gen(function* () {
      for (const data of [
        null,
        {},
        { resources: [{ cloudId: "", url: siteUrl }] },
        { resources: [{ cloudId, url: "https://attacker.example" }] },
        {
          resources: [
            { cloudId, url: siteUrl },
            { cloudId, url: "https://other.atlassian.net" },
          ],
        },
        [{ id: cloudId, url: siteUrl }],
        [{ id: cloudId, url: "https://attacker.example", scopes: ["read:jira:agent-interface"] }],
      ]) {
        const { provide } = harness(() => toolReply({ data }));
        expect((yield* getJiraOAuthSites(accessToken).pipe(provide, Effect.flip)).code).toBe(
          "unavailable",
        );
      }
    }),
  );

  it.effect("reads issues using the OAuth access token and negotiated MCP session", () =>
    Effect.gen(function* () {
      const { requests, provide } = harness();
      expect(
        yield* readJiraIssue({ ...input, siteUrl: `${siteUrl}/` }).pipe(provide),
      ).toMatchObject({
        identifier: "ENG-123",
        url: `${siteUrl}/browse/ENG-123`,
      });
      expect(
        requests.every(({ request }) => request.url === "https://mcp.atlassian.com/v2/mcp"),
      ).toBe(true);
      const call = requests.find(({ rpc }) => rpc?.method === "tools/call");
      expect(call?.rpc?.params).toEqual({
        name: "getJiraIssue",
        arguments: {
          cloudId,
          issueIdOrKey: "ENG-123",
          fields: ["summary", "description", "status", "assignee"],
          responseContentFormat: "markdown",
        },
      });
      expect(call?.request.url).toBe("https://mcp.atlassian.com/v2/mcp");
      expect(call?.request.headers.authorization).toBe(`Bearer ${accessToken}`);
      expect(call?.request.headers["mcp-session-id"]).toBe("session-1");
      expect(call?.request.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(requests.at(-1)?.request.method).toBe("DELETE");
    }),
  );

  it.effect("normalizes issue links and returns only the requested issue details", () =>
    Effect.gen(function* () {
      const { provide } = harness();
      expect(
        yield* readJiraIssue({
          ...input,
          issue: `${siteUrl}/browse/eng-123?focusedCommentId=123`,
        }).pipe(provide),
      ).toEqual({
        identifier: "ENG-123",
        title: "Fix the queue",
        description: "Keep **Steer** visible.",
        url: `${siteUrl}/browse/ENG-123`,
        status: "In progress",
        assignee: "Alex",
      });
    }),
  );

  it.effect("accepts structured MCP content and missing nullable issue fields", () =>
    Effect.gen(function* () {
      const { provide } = harness(() =>
        reply({
          structuredContent: {
            key: "ENG-123",
            fields: { summary: "Title", description: null, assignee: null, status: null },
          },
        }),
      );
      expect(yield* readJiraIssue(input).pipe(provide)).toEqual({
        identifier: "ENG-123",
        title: "Title",
        description: "",
        url: `${siteUrl}/browse/ENG-123`,
        status: null,
        assignee: null,
      });
    }),
  );

  it.effect("rejects other-site links and unsupported issue input before sending credentials", () =>
    Effect.gen(function* () {
      const { requests, provide } = harness();
      for (const value of [
        "https://other.atlassian.net/browse/ENG-123",
        "https://user:pass@acme.atlassian.net/browse/ENG-123",
        "https://acme.atlassian.net.evil.test/browse/ENG-123",
        "https://acme.atlassian.net/jira/software/projects/ENG",
        "ENG-0",
        "not a key",
        "123",
      ]) {
        const error = yield* readJiraIssue({ ...input, issue: value }).pipe(provide, Effect.flip);
        expect(error.code).toBe("invalid_input");
      }
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect(
    "rejects non-Cloud origins, credentials, ports, and paths before sending credentials",
    () =>
      Effect.gen(function* () {
        const { requests, provide } = harness();
        for (const value of [
          "http://acme.atlassian.net",
          "https://localhost",
          "https://acme.atlassian.net.evil.test",
          "https://atlassian.net",
          "https://acme.atlassian.net:8443",
          "https://user:pass@acme.atlassian.net",
          `${siteUrl}/path`,
          `${siteUrl}?foo=bar`,
        ]) {
          const error = yield* readJiraIssue({ ...input, siteUrl: value }).pipe(
            provide,
            Effect.flip,
          );
          expect(error.code).toBe("invalid_input");
        }
        expect(requests).toHaveLength(0);
      }),
  );

  it.effect("refuses an empty or header-injected access token and missing cloud ID", () =>
    Effect.gen(function* () {
      const { requests, provide } = harness();
      for (const value of ["", " ", "key\r\nInjected: yes"]) {
        expect(
          (yield* readJiraIssue({ ...input, accessToken: value }).pipe(provide, Effect.flip)).code,
        ).toBe("auth_required");
      }
      expect(
        (yield* readJiraIssue({ ...input, cloudId: "" }).pipe(provide, Effect.flip)).code,
      ).toBe("invalid_input");
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("maps HTTP errors without exposing upstream response bodies or credentials", () =>
    Effect.gen(function* () {
      for (const [status, code] of [
        [401, "auth_required"],
        [403, "forbidden"],
        [404, "not_found"],
        [429, "unavailable"],
        [500, "unavailable"],
      ] as const) {
        const { requests, provide } = harness(
          () => new Response(`upstream includes ${accessToken}`, { status }),
        );
        const error = yield* readJiraIssue(input).pipe(provide, Effect.flip);
        expect(error.code).toBe(code);
        expect(encodeJson(error)).not.toContain(accessToken);
        expect(requests.at(-1)?.request.method).toBe("DELETE");
      }
    }),
  );

  it.effect("classifies MCP tool failures without forwarding their text", () =>
    Effect.gen(function* () {
      for (const [text, code] of [
        ["HTTP 401 Unauthorized", "auth_required"],
        ["HTTP 401 Unauthorized; scope does not match", "forbidden"],
        ["HTTP 403 Forbidden", "forbidden"],
        ["HTTP 404 Not found", "not_found"],
        ["Upstream failure", "unavailable"],
      ] as const) {
        const { provide } = harness(() =>
          reply({ isError: true, content: [{ type: "text", text: `${text}; ${accessToken}` }] }),
        );
        const error = yield* readJiraIssue(input).pipe(provide, Effect.flip);
        expect(error.code).toBe(code);
        expect(encodeJson(error)).not.toContain(accessToken);
      }
    }),
  );

  it.effect("reads an SSE reply without waiting for a long-lived stream to close", () =>
    Effect.gen(function* () {
      let canceled = false;
      const { provide } = harness(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: message\ndata: ${encodeJson({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${encodeJson({ jsonrpc: "2.0", id: 2, result: { structuredContent: issue } })}\n\n`,
                  ),
                );
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      expect((yield* readJiraIssue(input).pipe(provide)).title).toBe("Fix the queue");
      expect(canceled).toBe(true);
    }),
  );

  it.effect("rejects malformed data, wrong RPC IDs, and remote protocol errors", () =>
    Effect.gen(function* () {
      for (const response of [
        toolReply({ key: "ENG-123", fields: { summary: "Title", description: { type: "doc" } } }),
        reply({ structuredContent: issue }, 999),
        Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: accessToken } }),
        new Response("not JSON", { headers: { "content-type": "application/json" } }),
      ]) {
        const { provide } = harness(() => response);
        const error = yield* readJiraIssue(input).pipe(provide, Effect.flip);
        expect(error.code).toBe("unavailable");
        expect(encodeJson(error)).not.toContain(accessToken);
      }
    }),
  );

  it.effect("truncates long descriptions with an explicit notice and preserves the boundary", () =>
    Effect.gen(function* () {
      for (const length of [20_000, 20_001]) {
        const description = "x".repeat(length);
        const { provide } = harness(() =>
          toolReply({ ...issue, fields: { ...issue.fields, description } }),
        );
        const result = yield* readJiraIssue(input).pipe(provide);
        expect(result.description).toBe(
          length === 20_000
            ? description
            : `${"x".repeat(20_000)}\n\n[Description truncated by Launchpad. Open the issue for the full text.]`,
        );
      }
    }),
  );

  it.effect("does not split a Unicode character at the description length limit", () =>
    Effect.gen(function* () {
      const description = "x".repeat(19_999) + "🙂";
      const { provide } = harness(() =>
        toolReply({ ...issue, fields: { ...issue.fields, description } }),
      );
      const result = yield* readJiraIssue(input).pipe(provide);
      expect(result.description).toBe(
        "x".repeat(19_999) +
          "\n\n[Description truncated by Launchpad. Open the issue for the full text.]",
      );
    }),
  );

  it.effect("rejects an upstream issue that does not match the requested key", () =>
    Effect.gen(function* () {
      const { provide } = harness(() => toolReply({ ...issue, key: "ENG-124" }));
      expect((yield* readJiraIssue(input).pipe(provide, Effect.flip)).code).toBe("unavailable");
    }),
  );

  it.effect("rejects oversized title, status, and assignee fields", () =>
    Effect.gen(function* () {
      for (const fields of [
        { ...issue.fields, summary: "x".repeat(4097) },
        { ...issue.fields, status: { name: "x".repeat(513) } },
        { ...issue.fields, assignee: { displayName: "x".repeat(513) } },
      ]) {
        const { provide } = harness(() => toolReply({ ...issue, fields }));
        expect((yield* readJiraIssue(input).pipe(provide, Effect.flip)).code).toBe("unavailable");
      }
    }),
  );

  it.effect("caps buffered response size", () =>
    Effect.gen(function* () {
      const { provide } = harness(() =>
        toolReply({ ...issue, fields: { ...issue.fields, description: "x".repeat(1024 * 1024) } }),
      );
      expect((yield* readJiraIssue(input).pipe(provide, Effect.flip)).code).toBe("unavailable");
    }),
  );

  it.effect("bounds stalled requests without polling or real sleeps", () =>
    Effect.gen(function* () {
      const http = HttpClient.make(() => Effect.never);
      const fiber = yield* readJiraIssue(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("20 seconds");
      expect((yield* Fiber.join(fiber)).code).toBe("unavailable");
    }),
  );
});
