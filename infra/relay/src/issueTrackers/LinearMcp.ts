import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";
import { LINEAR_MCP_RESOURCE } from "./LinearOAuth.ts";

const unavailable = () =>
  new IssueTrackerFailure({
    code: "unavailable",
    message: "Linear could not complete the request.",
  });
const isFailure = Schema.is(IssueTrackerFailure);
const safeFailure = (cause: unknown) => (isFailure(cause) ? cause : unavailable());
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
// Linear reports a missing issue as an MCP tool error with status 400, not HTTP 404.
const decodeMissingIssue = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Literal("invalid_request"),
      status: Schema.Literal(400),
      message: Schema.Literal("Could not find referenced Issue."),
    }),
  ),
);
type ReadTool = "get_workspace" | "get_user" | "get_issue" | "list_comments" | "extract_images";

/** Each operation owns its MCP session; credentials and sessions never cross organization boundaries. */
export const callLinearTools = Effect.fn("linearMcp.callTools")(function* (
  accessToken: string,
  calls: ReadonlyArray<{ name: ReadTool; arguments: Record<string, unknown> }>,
) {
  const http = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const limit = calls.some((call) => call.name === "extract_images") ? 8 * 1024 * 1024 : 256 * 1024;
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const client = new Client({ name: "Launchpad", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(LINEAR_MCP_RESOURCE), {
        authProvider: { token: async () => accessToken },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (
            request.url !== LINEAR_MCP_RESOURCE ||
            !["GET", "POST", "DELETE"].includes(request.method)
          )
            throw unavailable();
          let outgoing = HttpClientRequest.make(request.method as "GET" | "POST" | "DELETE")(
            request.url,
          ).pipe(HttpClientRequest.setHeaders(Object.fromEntries(request.headers)));
          if (request.method === "POST")
            outgoing = outgoing.pipe(
              HttpClientRequest.bodyText(await request.text(), "application/json"),
            );
          return run(
            Effect.gen(function* () {
              const response = yield* http.execute(outgoing);
              if (response.status === 401)
                return yield* new IssueTrackerFailure({
                  code: "auth_required",
                  message: "Reconnect Linear in Organization settings.",
                });
              if (response.status === 403)
                return yield* new IssueTrackerFailure({
                  code: "forbidden",
                  message: "The connected Linear account cannot access this content.",
                });
              if (response.status >= 300 && response.status < 400) return yield* unavailable();
              if (response.status === 202 || response.status === 204)
                return new Response(null, { status: response.status, headers: response.headers });
              if (response.status === 404 || response.status === 410)
                return yield* new IssueTrackerFailure({
                  code: "not_found",
                  message: "The Linear content was not found.",
                });
              const collected = yield* response.stream.pipe(
                Stream.runFoldEffect(
                  () => ({ size: 0, chunks: [] as Uint8Array[] }),
                  (state, chunk) => {
                    if (state.size + chunk.length > limit) return Effect.fail(unavailable());
                    state.chunks.push(chunk);
                    return Effect.succeed({
                      size: state.size + chunk.length,
                      chunks: state.chunks,
                    });
                  },
                ),
              );
              const bytes = new Uint8Array(collected.size);
              let offset = 0;
              for (const chunk of collected.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return new Response(bytes, {
                status: response.status,
                headers: response.headers,
              });
            }).pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "error",
                credentials: "omit",
              }),
            ),
            { signal: AbortSignal.any([signal, request.signal]) },
          );
        },
      });
      try {
        await client.connect(transport, { signal });
        const results = await Promise.all(calls.map((call) => client.callTool(call, { signal })));
        for (const [index, result] of results.entries()) {
          if (!result.isError) continue;
          const content = result.content[0];
          if (
            calls[index]?.name === "get_issue" &&
            result.content.length === 1 &&
            content?.type === "text" &&
            decodeMissingIssue(content.text)._tag === "Success"
          )
            throw new IssueTrackerFailure({
              code: "not_found",
              message: "The Linear issue was not found or is not visible to the connected account.",
            });
          throw unavailable();
        }
        return results;
      } finally {
        await client.close();
      }
    },
    catch: safeFailure,
  }).pipe(
    Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(unavailable()) }),
  );
});

/** Linear's read tools return JSON in a text content block. */
export const linearToolJson = Effect.fn("linearMcp.toolJson")(function* (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
}) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content.filter((entry) => entry.type === "text");
  if (content.length !== 1 || content[0]?.text === undefined) return yield* unavailable();
  return yield* decodeJson(content[0].text).pipe(Effect.mapError(unavailable));
});
