import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
const JiraIssuePayload = Schema.Union([
  JiraIssue,
  Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(JiraIssue) }) }),
]);
const JiraIssueResponse = Schema.Union([
  JiraIssuePayload,
  Schema.Struct({ data: JiraIssuePayload }),
]);

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
const toolResultSchema = Schema.toStandardSchemaV1(ToolResult);
const decodeJiraIssue = Schema.decodeUnknownEffect(JiraIssueResponse);
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
      message: "The Jira authorization is invalid. Reconnect Jira in Account connections.",
    });
  }
  return accessToken.trim();
});

const checkStatus = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 429) {
    const retry = Number(response.headers["retry-after"]);
    return yield* new IssueTrackerFailure({
      code: "rate_limited",
      message: "Atlassian is rate limiting Jira requests. Try again later.",
      ...(Number.isInteger(retry) && retry > 0 && retry <= 3600
        ? { retryAfterSeconds: retry }
        : {}),
    });
  }
  if (response.status === 401) {
    return yield* new IssueTrackerFailure({
      code: "auth_required",
      message: "Atlassian rejected Jira access. Reconnect Jira in Account connections.",
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

const isFailure = Schema.is(IssueTrackerFailure);
const safeFailure = (cause: unknown) => (isFailure(cause) ? cause : unavailable());

/** One operation owns its session; the SDK handles framing and RPC correlation. */
const withJiraClient = Effect.fnUntraced(function* <A>(
  accessToken: string,
  request: (client: Client, signal: AbortSignal) => Promise<A>,
) {
  const http = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const client = new Client(
    { name: "launchpad", version: "1.0" },
    { supportedProtocolVersions: [...PROTOCOL_VERSIONS] },
  );
  let operationSignal: AbortSignal | undefined;
  let cleanupSignal: AbortSignal | undefined;
  let failure: IssueTrackerFailure | undefined;
  const transport = new StreamableHTTPClientTransport(new URL(JIRA_MCP_RESOURCE), {
    authProvider: { token: async () => accessToken },
    onInsufficientScope: "throw",
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const incoming = new Request(input, init);
      if (
        incoming.url !== JIRA_MCP_RESOURCE ||
        !["GET", "POST", "DELETE"].includes(incoming.method)
      )
        throw unavailable();
      // Replies arrive on POST; decline the SDK's unused background notification stream.
      if (incoming.method === "GET") return new Response(null, { status: 405 });
      const signal =
        incoming.method === "DELETE" && cleanupSignal
          ? cleanupSignal
          : AbortSignal.any([incoming.signal, ...(operationSignal ? [operationSignal] : [])]);
      let outgoing = HttpClientRequest.make(incoming.method as "POST" | "DELETE")(
        incoming.url,
      ).pipe(HttpClientRequest.setHeaders(Object.fromEntries(incoming.headers)));
      if (incoming.method === "POST")
        outgoing = outgoing.pipe(
          HttpClientRequest.bodyText(await incoming.text(), "application/json"),
        );
      return run(
        Effect.gen(function* () {
          const response = yield* http.execute(outgoing);
          yield* checkStatus(response);
          const sessionId = response.headers["mcp-session-id"];
          if (sessionId && (!/^[\x21-\x7e]+$/.test(sessionId) || sessionId.length > 256))
            return yield* unavailable();
          if (response.status === 202 || response.status === 204)
            return new Response(null, { status: response.status, headers: response.headers });
          let bytes = 0;
          const body = yield* Stream.toReadableStreamEffect(
            response.stream.pipe(
              Stream.mapEffect((chunk) => {
                bytes += chunk.byteLength;
                return bytes > MAX_RESPONSE_BYTES
                  ? Effect.fail(unavailable())
                  : Effect.succeed(chunk);
              }),
              Stream.interruptWhen(
                Effect.callback<void>((resume) => {
                  const abort = () => resume(Effect.void);
                  if (signal.aborted) abort();
                  else signal.addEventListener("abort", abort, { once: true });
                  return Effect.sync(() => signal.removeEventListener("abort", abort));
                }),
              ),
            ),
          );
          return new Response(body, { status: response.status, headers: response.headers });
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "error",
            credentials: "omit",
          }),
        ),
        { signal },
      );
    },
  });
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes a callback, not EventTarget.
  client.onerror = (cause) => {
    failure = safeFailure(cause);
    void client.close().catch(() => {});
  };
  return yield* Effect.tryPromise({
    try: async (signal) => {
      operationSignal = signal;
      await client.connect(transport, { signal });
      return request(client, signal);
    },
    catch: (cause) => failure ?? safeFailure(cause),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: (signal) => {
          cleanupSignal = signal;
          return transport.terminateSession();
        },
        catch: safeFailure,
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.ignore,
        Effect.ensuring(Effect.promise(() => client.close())),
      ),
    ),
  );
});

export const callJiraTool = Effect.fnUntraced(function* (
  accessToken: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
) {
  // Use the SDK request API so calls retain Jira's payload schema and never replay mutations.
  const toolResult = yield* withJiraClient(accessToken, (client, signal) =>
    client.request({ method: "tools/call", params: { name, arguments: args } }, toolResultSchema, {
      signal,
    }),
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
        message: "Atlassian rejected Jira access. Reconnect Jira in Account connections.",
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
  return (
    toolResult.structuredContent ??
    (yield* decodeJson(
      toolResult.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n") ?? "",
    ).pipe(Effect.mapError(unavailable)))
  );
});

const JiraToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
});
const toolListSchema = Schema.toStandardSchemaV1(JiraToolList);

/** Read the tools offered to this specific OAuth grant; Atlassian rolls out names per account. */
export const listJiraTools = Effect.fnUntraced(function* (accessToken: string) {
  // Preserve the existing single-page discovery instead of the SDK's automatic pagination.
  return yield* withJiraClient(accessToken, (client, signal) =>
    client.request({ method: "tools/list" }, toolListSchema, { signal }),
  );
});

/** The comment tool is deferred on Rovo v2; inspect this grant before a write depends on it. */
export const jiraCommentReadRoute = Effect.fnUntraced(function* (accessToken: string) {
  const offered = (yield* listJiraTools(accessToken)).tools;
  if (offered.some((tool) => tool.name === "listJiraIssueComments"))
    return "listJiraIssueComments" as const;
  if (offered.some((tool) => tool.name === "executeRead")) return "executeRead" as const;
  if (offered.some((tool) => tool.name === "execute")) return "execute" as const;
  return yield* new IssueTrackerFailure({
    code: "forbidden",
    message: "This Jira connection cannot read issue comments, so a comment cannot be confirmed.",
  });
});

export const listJiraIssueComments = Effect.fnUntraced(function* (input: {
  readonly accessToken: string;
  readonly cloudId: string;
  readonly issueIdOrKey: string;
  readonly route: "listJiraIssueComments" | "executeRead" | "execute";
  readonly startAt: number;
  readonly maxResults: number;
}) {
  const args = {
    issueIdOrKey: input.issueIdOrKey,
    startAt: input.startAt,
    maxResults: input.maxResults,
  };
  return yield* callJiraTool(
    input.accessToken,
    input.route,
    input.route === "listJiraIssueComments"
      ? { cloudId: input.cloudId, ...args }
      : { name: "listJiraIssueComments", cloudId: input.cloudId, inputs: args },
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
  const decoded = yield* decodeJiraIssue(payload).pipe(Effect.mapError(unavailable));
  const issuePayload = "data" in decoded ? decoded.data : decoded;
  const result =
    "issues" in issuePayload
      ? issuePayload.issues.nodes.length === 1
        ? issuePayload.issues.nodes[0]!
        : yield* unavailable()
      : issuePayload;
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

const SearchIssue = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  key: IssueKey,
  fields: Schema.Struct({
    summary: Schema.String.check(Schema.isMaxLength(4096)),
    status: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    assignee: Schema.optionalKey(Schema.NullOr(Schema.Struct({ displayName: Schema.String }))),
    project: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  }),
});
const SearchResult = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(SearchIssue),
    remainingCount: Schema.optionalKey(Schema.Number),
    pageInfo: Schema.optionalKey(
      Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
      }),
    ),
  }),
});
const SearchResponse = Schema.Union([SearchResult, Schema.Struct({ data: SearchResult })]);
const decodeSearchResult = Schema.decodeUnknownEffect(SearchResponse);
const jqlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const searchJiraIssues = Effect.fn("relay.jira.searchIssues")(function* (input: {
  readonly siteUrl: string;
  readonly cloudId: string;
  readonly accessToken: string;
  readonly query?: string;
  readonly project?: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly cursor?: string;
}) {
  const siteUrl = yield* normalizeSite(input.siteUrl);
  const accessToken = yield* validateAccessToken(input.accessToken);
  const cloudId = yield* decodeCloudId(input.cloudId).pipe(Effect.mapError(unavailable));
  const clauses = [
    ...(input.query ? [`text ~ ${jqlString(input.query)}`] : []),
    ...(input.project ? [`project = ${jqlString(input.project)}`] : []),
    ...(input.status ? [`status = ${jqlString(input.status)}`] : []),
    ...(input.assignee
      ? [
          input.assignee.toLowerCase() === "me"
            ? "assignee = currentUser()"
            : `assignee = ${jqlString(input.assignee)}`,
        ]
      : []),
  ];
  if (clauses.length === 0) return yield* invalidInput("Enter search text or a filter.");
  const payload = yield* callJiraTool(accessToken, "searchJiraIssuesUsingJql", {
    cloudId,
    jql: `${clauses.join(" AND ")} ORDER BY updated DESC`,
    maxResults: 20,
    fields: ["summary", "status", "assignee", "project"],
    ...(input.cursor ? { nextPageToken: input.cursor } : {}),
  });
  const decoded = yield* decodeSearchResult(payload).pipe(Effect.mapError(unavailable));
  const result = "data" in decoded ? decoded.data : decoded;
  const page = result.issues;
  const nextCursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  if (
    page.nodes.length > 20 ||
    (page.pageInfo?.hasNextPage && (!nextCursor || nextCursor === input.cursor)) ||
    ((page.remainingCount ?? 0) > 0 && !nextCursor) ||
    (page.nodes.length === 20 && page.pageInfo === undefined && !nextCursor)
  )
    return yield* unavailable();
  return {
    issues: page.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.key,
      title: issue.fields.summary.slice(0, 512),
      url: `${siteUrl}/browse/${issue.key}`,
      status: issue.fields.status?.name.slice(0, 128) ?? null,
      assignee: issue.fields.assignee?.displayName.slice(0, 128) ?? null,
      project: issue.fields.project?.name.slice(0, 128) ?? null,
      team: null,
    })),
    cursor: nextCursor ?? null,
  };
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
