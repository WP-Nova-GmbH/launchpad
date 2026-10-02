import { OAuthError } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

const isIssueTrackerFailure = Schema.is(IssueTrackerFailure);
// Log only protocol error names, never provider descriptions or raw exception text.
export const oauthErrorCode = (value: unknown) =>
  typeof value === "string" &&
  [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "invalid_token",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_target",
    "server_error",
    "temporarily_unavailable",
  ].includes(value)
    ? value
    : "unknown";
const diagnosticHeader = (value: string | undefined) =>
  value && /^[a-zA-Z0-9:,. _-]{1,128}$/.test(value) ? value : undefined;

/** Bridge SDK fetch calls into the relay's bounded, injectable HTTP client. Provider policy stays at the call site. */
export function makeOAuthRequest(options: {
  readonly span: string;
  readonly label: string;
  readonly allowsRequest: (request: Request) => boolean;
  readonly diagnosticHeaders: Readonly<Record<string, string>>;
  readonly unavailable: () => IssueTrackerFailure;
  readonly authRequired: () => IssueTrackerFailure;
  readonly forbidden: () => IssueTrackerFailure;
}) {
  const sanitizeError = (cause: unknown) => {
    if (isIssueTrackerFailure(cause)) return cause;
    if (
      cause instanceof OAuthError &&
      ["invalid_client", "invalid_grant", "invalid_token", "unauthorized_client"].includes(
        cause.code,
      )
    )
      return options.authRequired();
    return options.unavailable();
  };

  // The SDK owns OAuth; this bridge retains the relay's HTTP limits and injectable test client.
  return Effect.fn(options.span)(
    function* <A>(stage: string, use: (fetchFn: typeof fetch) => Promise<A>) {
      const http = yield* HttpClient.HttpClient;
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      let oauthError: string | undefined;
      return yield* Effect.tryPromise({
        try: (signal) =>
          use(async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (!options.allowsRequest(request)) throw options.unavailable();
            const body = request.method === "GET" ? undefined : await request.text();
            let outgoing = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
              request.url,
            ).pipe(HttpClientRequest.setHeaders(Object.fromEntries(request.headers)));
            if (body !== undefined)
              outgoing = outgoing.pipe(
                HttpClientRequest.bodyText(
                  body,
                  request.headers.get("content-type") ?? "application/x-www-form-urlencoded",
                ),
              );
            const result = await run(
              Effect.gen(function* () {
                const response = yield* http.execute(outgoing);
                yield* (response.status >= 400 ? Effect.logWarning : Effect.logDebug)(
                  `${options.label} OAuth HTTP response`,
                  {
                    stage,
                    endpoint: url.origin + url.pathname,
                    method: request.method,
                    httpStatus: response.status,
                    ...Object.fromEntries(
                      Object.entries(options.diagnosticHeaders).map(([name, header]) => [
                        name,
                        diagnosticHeader(response.headers[header]),
                      ]),
                    ),
                    serverDate: diagnosticHeader(response.headers.date),
                  },
                );
                if (response.status === 401) return yield* options.authRequired();
                if (response.status === 403) return yield* options.forbidden();
                if (response.status >= 300 && response.status < 400)
                  return yield* options.unavailable();
                const bytes = yield* response.stream.pipe(
                  Stream.runFoldEffect(
                    () => new Uint8Array(0),
                    (previous, chunk) => {
                      if (previous.length + chunk.length > 65_536)
                        return Effect.fail(options.unavailable());
                      const next = new Uint8Array(previous.length + chunk.length);
                      next.set(previous);
                      next.set(chunk, previous.length);
                      return Effect.succeed(next);
                    },
                  ),
                );
                return new Response(response.status === 204 ? null : bytes, {
                  status: response.status,
                  headers: response.headers,
                });
              }).pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  redirect: "error",
                  credentials: "omit",
                }),
                Effect.match({ onFailure: sanitizeError, onSuccess: (value) => value }),
              ),
              { signal: AbortSignal.any([signal, request.signal]) },
            );
            if (isIssueTrackerFailure(result)) throw result;
            return result;
          }),
        catch: (cause) => {
          if (cause instanceof OAuthError) oauthError = oauthErrorCode(cause.code);
          return sanitizeError(cause);
        },
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`${options.label} OAuth stage failed`, {
            stage,
            code: error.code,
            oauthError,
          }),
        ),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "8 seconds",
          orElse: () => Effect.fail(options.unavailable()),
        }),
      ),
  );
}
