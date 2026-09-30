import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

const MCP_URL = "https://mcp.atlassian.com/v2/mcp";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 20_000;
const IssueKey = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
  Schema.isMaxLength(256),
);
const CloudId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Tenant = Schema.Struct({ cloudId: CloudId });
const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const Initialized = Schema.Struct({ protocolVersion: Schema.Literals(PROTOCOL_VERSIONS) });
const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const JiraIssue = Schema.Struct({
  key: IssueKey,
  fields: Schema.Struct({
    summary: Schema.String.check(Schema.isMaxLength(4096)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(512)) })),
    ),
    assignee: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ displayName: Schema.String.check(Schema.isMaxLength(512)) })),
    ),
  }),
});

const decodeIssueKey = Schema.decodeEffect(IssueKey);
const decodeCloudId = Schema.decodeEffect(CloudId);
const decodeTenant = Schema.decodeUnknownEffect(Tenant);
const decodeRpcResponse = Schema.decodeUnknownEffect(RpcResponse);
const isRpcResponse = Schema.is(RpcResponse);
const decodeInitialized = Schema.decodeUnknownEffect(Initialized);
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeJiraIssue = Schema.decodeUnknownEffect(JiraIssue);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const unavailable = () =>
  new IssueTrackerFailure({
    code: "unavailable",
    message: "Jira could not complete the request. Try again later.",
  });
const invalidInput = (message: string) =>
  new IssueTrackerFailure({ code: "invalid_input", message });

const normalizeSite = Effect.fnUntraced(function* (value: string) {
  const url = yield* Effect.try({
    try: () => new URL(value.trim()),
    catch: () =>
      invalidInput("Enter a Jira Cloud site URL, such as https://example.atlassian.net."),
  });
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    return yield* invalidInput(
      "Enter a Jira Cloud site URL, such as https://example.atlassian.net.",
    );
  }
  return url.origin;
});

const issueKey = Effect.fnUntraced(function* (input: string, siteUrl: string) {
  let value = input.trim();
  if (value.includes("://")) {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () => invalidInput("Enter a Jira issue key or a link from the connected site."),
    });
    const match = /^\/browse\/([^/]+)\/?$/.exec(url.pathname);
    if (url.origin !== siteUrl || url.username || url.password || !match?.[1]) {
      return yield* invalidInput("The issue link must belong to the connected Jira site.");
    }
    value = match[1];
  }
  return yield* decodeIssueKey(value.toUpperCase()).pipe(
    Effect.mapError(() => invalidInput("Enter a Jira issue key, such as ENG-123.")),
  );
});

const validateKey = Effect.fnUntraced(function* (apiKey: string) {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
    return yield* invalidInput("Enter an Atlassian service-account API key.");
  }
  return apiKey.trim();
});

const checkStatus = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 401) {
    return yield* new IssueTrackerFailure({
      code: "auth_required",
      message: "The Jira service-account API key is invalid or expired. Reconnect Jira.",
    });
  }
  if (response.status === 403) {
    return yield* new IssueTrackerFailure({
      code: "forbidden",
      message:
        "Jira denied access. Check the service account's permissions and your Atlassian MCP settings.",
    });
  }
  if (response.status === 404) {
    return yield* new IssueTrackerFailure({
      code: "not_found",
      message: "The Jira site or issue was not found, or is not visible to the service account.",
    });
  }
  return yield* unavailable();
});

/** Limit both JSON and SSE responses before buffering; an SSE connection need not close after its reply. */
const responseText = (response: HttpClientResponse.HttpClientResponse) =>
  Stream.suspend(() => {
    let bytes = 0;
    return response.stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes > MAX_RESPONSE_BYTES ? Effect.fail(unavailable()) : Effect.succeed(chunk);
      }),
      Stream.decodeText,
    );
  });

const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  responseText(response).pipe(
    Stream.runCollect,
    Effect.flatMap((chunks) => decodeJson(chunks.join(""))),
    Effect.mapError(unavailable),
  );

const readRpcResponse = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  id: number,
) {
  let payload: unknown;
  if (response.headers["content-type"]?.includes("text/event-stream")) {
    const reply = yield* responseText(response).pipe(
      Stream.pipeThroughChannel(
        Sse.decodeDataSchema(Schema.Unknown, { maxEventSize: MAX_RESPONSE_BYTES }),
      ),
      Stream.map((event) => event.data),
      Stream.filter((data) => isRpcResponse(data) && data.id === id),
      Stream.runHead,
      Effect.mapError(unavailable),
    );
    if (Option.isNone(reply)) return yield* unavailable();
    payload = reply.value;
  } else {
    payload = yield* readJson(response);
  }
  const reply = yield* decodeRpcResponse(payload).pipe(Effect.mapError(unavailable));
  if (reply.id !== id || reply.error || reply.result === undefined) return yield* unavailable();
  return reply.result;
});

const callJiraIssue = Effect.fnUntraced(function* (apiKey: string, cloudId: string, key: string) {
  const http = yield* HttpClient.HttpClient;
  let sessionId: string | undefined;
  let protocolVersion: string = PROTOCOL_VERSIONS[0];
  const headers = () => ({
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  });
  const post = (body: unknown) =>
    http
      .execute(
        HttpClientRequest.post(MCP_URL).pipe(
          HttpClientRequest.setHeaders(headers()),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(unavailable), Effect.flatMap(checkStatus));
  const initializedResponse = yield* post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "launchpad", version: "1.0" },
    },
  });
  sessionId = initializedResponse.headers["mcp-session-id"];
  if (sessionId && (!/^[\x21-\x7e]+$/.test(sessionId) || sessionId.length > 256))
    return yield* unavailable();
  const result = Effect.gen(function* () {
    const initialized = yield* readRpcResponse(initializedResponse, 1).pipe(
      Effect.flatMap(decodeInitialized),
      Effect.mapError(unavailable),
    );
    protocolVersion = initialized.protocolVersion;
    yield* post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = yield* post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "getJiraIssue",
        arguments: {
          cloudId,
          issueIdOrKey: key,
          fields: ["summary", "description", "status", "assignee"],
          responseContentFormat: "markdown",
        },
      },
    });
    const toolResult = yield* readRpcResponse(response, 2).pipe(
      Effect.flatMap(decodeToolResult),
      Effect.mapError(unavailable),
    );
    if (toolResult.isError) {
      // Upstream text can contain request details, so only classify it; never surface it.
      const text =
        toolResult.content
          ?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
          .join("\n") ?? "";
      if (/\b401\b|unauthori[sz]ed|invalid.*token|expired.*token/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "auth_required",
          message: "The Jira service-account API key is invalid or expired. Reconnect Jira.",
        });
      }
      if (/\b403\b|forbidden|permission/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "forbidden",
          message: "The service account does not have permission to read this Jira issue.",
        });
      }
      if (/\b404\b|not found|does not exist/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "not_found",
          message: "The Jira issue was not found, or is not visible to the service account.",
        });
      }
      return yield* unavailable();
    }
    const payload =
      toolResult.structuredContent ??
      (yield* decodeJson(
        toolResult.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n") ?? "",
      ).pipe(Effect.mapError(unavailable)));
    return yield* decodeJiraIssue(payload).pipe(Effect.mapError(unavailable));
  });
  return yield* result.pipe(
    Effect.ensuring(
      sessionId
        ? http
            .execute(
              HttpClientRequest.delete(MCP_URL).pipe(HttpClientRequest.setHeaders(headers())),
            )
            .pipe(Effect.timeout("2 seconds"), Effect.ignore)
        : Effect.void,
    ),
  );
});

const readIssue = Effect.fnUntraced(function* (input: {
  readonly siteUrl: string;
  readonly cloudId: string;
  readonly apiKey: string;
  readonly issue: string;
}) {
  const siteUrl = yield* normalizeSite(input.siteUrl);
  const key = yield* issueKey(input.issue, siteUrl);
  const apiKey = yield* validateKey(input.apiKey);
  const cloudId = yield* decodeCloudId(input.cloudId).pipe(
    Effect.mapError(() => invalidInput("Reconnect Jira to verify the connected site.")),
  );
  const result = yield* callJiraIssue(apiKey, cloudId, key);
  if (result.key !== key) return yield* unavailable();
  const description = result.fields.description ?? "";
  return {
    identifier: result.key,
    title: result.fields.summary,
    description:
      description.length > MAX_DESCRIPTION_LENGTH
        ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}\n\n[Description truncated by Launchpad. Open the issue for the full text.]`
        : description,
    url: `${siteUrl}/browse/${result.key}`,
    status: result.fields.status?.name ?? null,
    assignee: result.fields.assignee?.displayName ?? null,
  };
});

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unavailable()) }),
  );

export const readJiraIssue = Effect.fn("relay.jira.readIssue")(function* (input: {
  readonly siteUrl: string;
  readonly cloudId: string;
  readonly apiKey: string;
  readonly issue: string;
}) {
  return yield* readIssue(input);
}, bounded);

export const connectJira = Effect.fn("relay.jira.connect")(function* (input: {
  readonly siteUrl: string;
  readonly apiKey: string;
  readonly issue: string;
}) {
  const siteUrl = yield* normalizeSite(input.siteUrl);
  const key = yield* issueKey(input.issue, siteUrl);
  const apiKey = yield* validateKey(input.apiKey);
  const http = yield* HttpClient.HttpClient;
  // Atlassian documents this public site-to-cloudId lookup. No service-account secret goes to the site.
  // https://developer.atlassian.com/platform/teamwork-graph/understanding-aris/
  const response = yield* http
    .get(`${siteUrl}/_edge/tenant_info`)
    .pipe(Effect.mapError(unavailable), Effect.flatMap(checkStatus));
  const tenant = yield* readJson(response).pipe(
    Effect.flatMap(decodeTenant),
    Effect.mapError(unavailable),
  );
  yield* readIssue({ siteUrl, cloudId: tenant.cloudId, apiKey, issue: key });
  return { siteUrl, cloudId: tenant.cloudId, accountLabel: new URL(siteUrl).hostname };
}, bounded);
