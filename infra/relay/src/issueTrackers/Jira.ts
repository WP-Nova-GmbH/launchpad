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
import { JIRA_DESCRIPTION_TRUNCATION_NOTICE } from "./JiraDiscussion.ts";
import { JIRA_MCP_RESOURCE } from "./JiraOAuth.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 20_000;
const IssueKey = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/),
  Schema.isMaxLength(256),
);
const CloudId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
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
const OAuthSites = Schema.Array(
  Schema.Struct({
    id: CloudId,
    url: Schema.String,
    name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
    scopes: Schema.Array(Schema.String),
  }),
);
// Rovo v2 returns data.resources with cloudId and no per-site scope list.
// The OAuth token's Jira read scope is checked during exchange; preserve filtering
// for older accessible-resource responses that do include per-site scopes.
const RovoResources = Schema.Struct({
  resources: Schema.Array(
    Schema.Struct({
      cloudId: CloudId,
      url: Schema.String,
      name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
      scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeOAuthSites = Schema.decodeUnknownEffect(
  Schema.Union([OAuthSites, Schema.Struct({ data: Schema.Union([OAuthSites, RovoResources]) })]),
);
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

const validateAccessToken = Effect.fnUntraced(function* (accessToken: string) {
  if (!accessToken.trim() || /[\r\n]/.test(accessToken)) {
    return yield* new IssueTrackerFailure({
      code: "auth_required",
      message: "The Jira authorization is invalid. Reconnect Jira in Organization settings.",
    });
  }
  return accessToken.trim();
});

const checkStatus = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 401) {
    return yield* new IssueTrackerFailure({
      code: "auth_required",
      message: "Atlassian rejected Jira access. Reconnect Jira in Organization settings.",
    });
  }
  if (response.status === 403) {
    return yield* new IssueTrackerFailure({
      code: "forbidden",
      message:
        "Jira denied access. Check the connected account's permissions and your Atlassian MCP settings.",
    });
  }
  if (response.status === 404) {
    return yield* new IssueTrackerFailure({
      code: "not_found",
      message: "The Jira site or issue was not found, or is not visible to the connected account.",
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
  const reply = yield* decodeRpcResponse(payload).pipe(
    Effect.tapError(() => Effect.logWarning("Jira MCP RPC decoding failed")),
    Effect.mapError(unavailable),
  );
  if (reply.id !== id || reply.error || reply.result === undefined) {
    yield* Effect.logWarning("Jira MCP invalid RPC response", {
      idMatches: reply.id === id,
      rpcErrorCode: reply.error?.code,
      hasResult: reply.result !== undefined,
    });
    return yield* unavailable();
  }
  return reply.result;
});

const callJiraTool = Effect.fnUntraced(function* (
  accessToken: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
) {
  const http = yield* HttpClient.HttpClient;
  let sessionId: string | undefined;
  let protocolVersion: string = PROTOCOL_VERSIONS[0];
  const headers = () => ({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  });
  const post = (body: { readonly method: string; readonly [key: string]: unknown }) =>
    http
      .execute(
        HttpClientRequest.post(JIRA_MCP_RESOURCE).pipe(
          HttpClientRequest.setHeaders(headers()),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((response) =>
          checkStatus(response).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Jira MCP request rejected", {
                stage: body.method,
                tool: name,
                httpStatus: response.status,
                code: error.code,
              }),
            ),
          ),
        ),
      );
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
        name,
        arguments: args,
      },
    });
    const toolResult = yield* readRpcResponse(response, 2).pipe(
      Effect.flatMap(decodeToolResult),
      Effect.mapError(unavailable),
    );
    if (toolResult.isError) {
      yield* Effect.logWarning("Jira MCP tool returned an error", { tool: name });
      // Upstream text can contain request details, so only classify it; never surface it.
      const text =
        toolResult.content
          ?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
          .join("\n") ?? "";
      if (/insufficient.scope|scope does not match/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "forbidden",
          message:
            "Atlassian did not grant the required Jira permissions. Reconnect Jira and allow read access.",
        });
      }
      if (/\b401\b|unauthori[sz]ed|invalid.*token|expired.*token/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "auth_required",
          message: "Atlassian rejected Jira access. Reconnect Jira in Organization settings.",
        });
      }
      if (/\b403\b|forbidden|permission/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "forbidden",
          message: "The connected account does not have permission to read this Jira issue.",
        });
      }
      if (/\b404\b|not found|does not exist/i.test(text)) {
        return yield* new IssueTrackerFailure({
          code: "not_found",
          message: "The Jira issue was not found, or is not visible to the connected account.",
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
    return payload;
  });
  return yield* result.pipe(
    Effect.ensuring(
      sessionId
        ? http
            .execute(
              HttpClientRequest.delete(JIRA_MCP_RESOURCE).pipe(
                HttpClientRequest.setHeaders(headers()),
              ),
            )
            .pipe(Effect.timeout("2 seconds"), Effect.ignore)
        : Effect.void,
    ),
  );
});

const readIssue = Effect.fnUntraced(function* (input: {
  readonly siteUrl: string;
  readonly cloudId: string;
  readonly accessToken: string;
  readonly issue: string;
}) {
  const siteUrl = yield* normalizeSite(input.siteUrl);
  const key = yield* issueKey(input.issue, siteUrl);
  const accessToken = yield* validateAccessToken(input.accessToken);
  const cloudId = yield* decodeCloudId(input.cloudId).pipe(
    Effect.mapError(() => invalidInput("Reconnect Jira to verify the connected site.")),
  );
  const payload = yield* callJiraTool(accessToken, "getJiraIssue", {
    cloudId,
    issueIdOrKey: key,
    fields: ["summary", "description", "status", "assignee"],
    responseContentFormat: "markdown",
  });
  const result = yield* decodeJiraIssue(payload).pipe(Effect.mapError(unavailable));
  if (result.key !== key) return yield* unavailable();
  const description = result.fields.description ?? "";
  return {
    identifier: result.key,
    title: result.fields.summary,
    description:
      description.length > MAX_DESCRIPTION_LENGTH
        ? `${description.slice(0, MAX_DESCRIPTION_LENGTH).replace(/[\uD800-\uDBFF]$/u, "")}${JIRA_DESCRIPTION_TRUNCATION_NOTICE}`
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
  readonly accessToken: string;
  readonly issue: string;
}) {
  return yield* readIssue(input);
}, bounded);

/** Only return Jira Cloud sites that the OAuth grant authorizes for issue reads. */
export const getJiraOAuthSites = Effect.fn("relay.jira.oauthSites")(
  function* (accessToken: string) {
    const payload = yield* callJiraTool(accessToken, "getAccessibleAtlassianResources", {});
    const decoded = yield* decodeOAuthSites(payload).pipe(Effect.mapError(unavailable));
    const data = "data" in decoded ? decoded.data : decoded;
    const resources = "resources" in data ? data.resources : data;
    const sites = new Map<string, { cloudId: string; siteUrl: string; accountLabel: string }>();
    for (const resource of resources) {
      if (resource.scopes && !resource.scopes.includes("read:jira:agent-interface")) continue;
      const cloudId = "cloudId" in resource ? resource.cloudId : resource.id;
      const siteUrl = yield* normalizeSite(resource.url).pipe(Effect.mapError(unavailable));
      const previous = sites.get(cloudId);
      if (previous && previous.siteUrl !== siteUrl) return yield* unavailable();
      sites.set(cloudId, {
        cloudId,
        siteUrl,
        accountLabel: resource.name?.trim() || new URL(siteUrl).hostname,
      });
    }
    return [...sites.values()].sort(
      (a, b) => a.accountLabel.localeCompare(b.accountLabel) || a.siteUrl.localeCompare(b.siteUrl),
    );
  },
  bounded,
  Effect.mapError((error) =>
    error.code === "unavailable"
      ? new IssueTrackerFailure({
          code: "unavailable",
          message: "Could not verify your Jira sites after signing in. Try connecting Jira again.",
        })
      : error,
  ),
);
