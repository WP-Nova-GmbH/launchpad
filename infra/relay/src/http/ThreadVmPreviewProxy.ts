import { ThreadVmPreviewWebSocket } from "./ThreadVmPreviewWebSocket.ts";
export { ThreadVmPreviewWebSocket } from "./ThreadVmPreviewWebSocket.ts";
import { threadVmPreviewRequestUrl as previewRequestUrl } from "./threadVmPreviewHost.ts";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  Cookies,
  HttpClient,
  HttpClientRequest,
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { ThreadVmConnectionTarget } from "../threads/ThreadVmConnection.ts";
import { RelayDb } from "../db.ts";
import { inspectE2BThreadVmIngress } from "../machines/E2BThreadVmConnection.ts";
import { authorizeThreadVmConnection } from "../threads/ThreadVmConnectionAccess.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import {
  makeThreadVmPreviewStore,
  ThreadVmPreviewDenied,
  type ThreadVmPreviewGrant,
} from "../threads/ThreadVmPreviewStore.ts";
import { newPreviewSecret, previewOrigin, previewSecretHash } from "./ThreadVmPreviewApi.ts";

export const PREVIEW_COOKIE = "__Host-launchpad-vm-preview";
const LOCAL_PREVIEW_COOKIE = "launchpad-vm-preview";
const BOOTSTRAP = "/__launchpad_preview/";
const bootstrapHtml = `<!doctype html><meta charset="utf-8"><title>Opening VM preview</title><p id="status">Opening preview…</p><script>
(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,"",location.pathname);
try{const response=await fetch("${BOOTSTRAP}connect",{method:"POST",headers:{"Content-Type":"text/plain"},body:ticket});
if(!response.ok)throw Error();location.replace("/");}catch{document.getElementById("status").textContent="This preview link has expired. Open a new preview from Launchpad.";}})();
</script>`;

const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const hopHeaders = new Set([
  "host",
  "connection",
  "upgrade",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);
/** Client credentials and E2B routing headers are never application input. */
export function previewRequestHeaders(
  request: HttpServerRequest.HttpServerRequest,
  origin: string,
) {
  const headers: Record<string, string> = {};
  const connectionHeaders = new Set(
    (request.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      !value ||
      hopHeaders.has(name) ||
      connectionHeaders.has(name) ||
      [
        "authorization",
        "dpop",
        "cookie",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
      ].includes(name) ||
      name.startsWith("e2b-") ||
      name.startsWith("x-e2b-") ||
      name.startsWith("x-forwarded-")
    )
      continue;
    headers[name] = value;
  }
  const appCookies = Object.entries(request.cookies).filter(
    ([name]) =>
      ![PREVIEW_COOKIE, LOCAL_PREVIEW_COOKIE, "__session"].includes(name) &&
      !name.startsWith("__clerk") &&
      !name.startsWith("t3-"),
  );
  if (appCookies.length)
    headers.cookie = appCookies
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
  if (request.headers.origin) headers.origin = origin;
  return headers;
}
function appCookies(cookies: Cookies.Cookies) {
  let result = Cookies.empty;
  for (const cookie of Object.values(cookies.cookies)) {
    if ([PREVIEW_COOKIE, LOCAL_PREVIEW_COOKIE].includes(cookie.name)) continue;
    // VM code may set its own host cookies, never a parent-domain credential.
    const { domain: _domain, ...options } = cookie.options ?? {};
    result = Cookies.setUnsafe(result, cookie.name, cookie.value, options);
  }
  return result;
}
export const previewGrantMatches = (
  grant: ThreadVmPreviewGrant,
  target: ThreadVmConnectionTarget,
) =>
  target.identity.scope.threadId === grant.threadId &&
  target.identity.scope.allocationId === grant.allocationId &&
  target.identity.scope.generation === grant.generation;

const handle = Effect.fn("relay.thread_vm.preview.proxy")(function* (
  previewId: string,
  baseUrl: string,
  transport: typeof fetch,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parsed = previewRequestUrl(request);
  if (Option.isNone(parsed)) return yield* new ThreadVmPreviewDenied();
  const url = parsed.value,
    origin = previewOrigin(baseUrl, previewId),
    secure = new URL(baseUrl).protocol === "https:",
    cookieName = secure ? PREVIEW_COOKIE : LOCAL_PREVIEW_COOKIE;
  const method = request.method,
    upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method))
    return yield* new ThreadVmPreviewDenied();
  if (
    (request.headers.origin && request.headers.origin !== origin) ||
    ((upgrade || !["GET", "HEAD"].includes(method)) && request.headers.origin !== origin)
  )
    return yield* new ThreadVmPreviewDenied();
  const sql = (yield* RelayDb).$client,
    store = makeThreadVmPreviewStore(sql);
  const authorize = Effect.fnUntraced(function* (grant: ThreadVmPreviewGrant) {
    const target = yield* authorizeThreadVmConnection(grant.userId, ThreadId.make(grant.threadId));
    if (!previewGrantMatches(grant, target)) return yield* new ThreadVmPreviewDenied();
    return target;
  });
  if (url.pathname === BOOTSTRAP && method === "GET")
    return HttpServerResponse.text(bootstrapHtml, {
      contentType: "text/html",
      headers: {
        ...privateHeaders,
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    });
  if (url.pathname === `${BOOTSTRAP}connect` && method === "POST") {
    if (Number(request.headers["content-length"] ?? 0) > 128)
      return yield* new ThreadVmPreviewDenied();
    // A stream limit also covers chunked requests without Content-Length.
    const secret = yield* Stream.runFoldEffect(
      request.stream,
      () => "",
      (text, chunk) =>
        text.length + chunk.length > 128
          ? Effect.fail(new ThreadVmPreviewDenied())
          : Effect.succeed(text + new TextDecoder().decode(chunk)),
    ).pipe(Effect.timeout("5 seconds"));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) return yield* new ThreadVmPreviewDenied();
    const sha = yield* previewSecretHash(secret),
      grant = yield* store.ticket(previewId, sha);
    yield* authorize(grant);
    const session = yield* newPreviewSecret();
    yield* store.claim(previewId, sha, yield* previewSecretHash(session));
    yield* authorize(grant);
    return HttpServerResponse.setCookieUnsafe(
      HttpServerResponse.empty({ status: 204, headers: privateHeaders }),
      cookieName,
      session,
      { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: "1 hour" },
    );
  }
  if (url.pathname.startsWith(BOOTSTRAP)) return yield* new ThreadVmPreviewDenied();
  const session = request.cookies[cookieName];
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return yield* new ThreadVmPreviewDenied();
  const sha = yield* previewSecretHash(session),
    grant = yield* store.session(previewId, sha),
    target = yield* authorize(grant);
  const { settings } = yield* ThreadVmRuntimeConfiguration;
  if (!settings) return yield* new ThreadVmPreviewDenied();
  const ingress = yield* Effect.tryPromise({
    try: (signal) =>
      inspectE2BThreadVmIngress(
        settings.compute,
        target.sandboxId,
        target.identity,
        transport,
        signal,
      ),
    catch: () => new ThreadVmPreviewDenied(),
  });
  yield* authorize(grant);
  const upstream = new URL(ingress.origin);
  // Preserve the request path without URL resolution allowing an authority change.
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  upstream.hash = "";
  const headers = {
    ...previewRequestHeaders(request, upstream.origin),
    "E2b-Sandbox-Id": ingress.sandboxId,
    "E2b-Sandbox-Port": String(grant.port),
    "e2b-traffic-access-token": Redacted.value(ingress.trafficAccessToken),
  };
  const context = Context.make(RelayDb, yield* RelayDb);
  const guard = Effect.gen(function* () {
    yield* store.session(previewId, sha);
    yield* authorize(grant);
  }).pipe(
    Effect.provide(context),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.andThen(new ThreadVmPreviewDenied()),
    Effect.mapError(() => new ThreadVmPreviewDenied()),
  );
  if (upgrade) {
    upstream.protocol = upstream.protocol.replace("http", "ws");
    return yield* (yield* ThreadVmPreviewWebSocket).open({
      request,
      url: upstream.href,
      headers,
      guard,
    });
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client
    .execute(
      HttpClientRequest.make(method)(upstream.href).pipe(
        HttpClientRequest.setHeaders(headers),
        ["GET", "HEAD"].includes(method)
          ? (r) => r
          : HttpClientRequest.bodyStream(request.stream.pipe(Stream.interruptWhen(guard))),
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.raceFirst(guard),
      Effect.timeout("30 seconds"),
    );
  yield* authorize(grant);
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      value &&
      !hopHeaders.has(name) &&
      !["content-encoding", "set-cookie", "clear-site-data"].includes(name) &&
      !name.startsWith("e2b-")
    )
      responseHeaders[name] = value;
  }
  if (responseHeaders.location) {
    const location = new URL(responseHeaders.location, upstream);
    if (location.origin === upstream.origin)
      responseHeaders.location = `${origin}${location.pathname}${location.search}${location.hash}`;
  }
  Object.assign(responseHeaders, privateHeaders);
  return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(guard)), {
    status: response.status,
    headers: responseHeaders,
    cookies: appCookies(response.cookies),
  });
});

/** Host interception runs before API routing, including API-shaped paths on an app origin. */
export const makeThreadVmPreviewRoutes = (transport: typeof fetch = fetch) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const context = Context.pick(
        RelayDb,
        ThreadVmRuntimeConfiguration,
        HttpClient.HttpClient,
        ThreadVmPreviewWebSocket,
        Crypto.Crypto,
      )(
        yield* Effect.context<
          | RelayDb
          | ThreadVmRuntimeConfiguration
          | HttpClient.HttpClient
          | ThreadVmPreviewWebSocket
          | Crypto.Crypto
        >(),
      );
      const { settings } = yield* ThreadVmRuntimeConfiguration;
      return <E, R>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!settings?.previewBaseUrl) return yield* next;
          const base = new URL(settings.previewBaseUrl),
            parsed = previewRequestUrl(request);
          if (Option.isNone(parsed)) return HttpServerResponse.text("Bad Request", { status: 400 });
          const host = parsed.value.hostname;
          if (host !== base.hostname && !host.endsWith(`.${base.hostname}`)) return yield* next;
          const id = host.slice(0, -(base.hostname.length + 1));
          if (!/^[0-9a-f]{32}$/u.test(id) || parsed.value.port !== base.port)
            return HttpServerResponse.text("Not Found", { status: 404, headers: privateHeaders });
          return yield* handle(id, settings.previewBaseUrl, transport).pipe(
            Effect.provide(context),
            Effect.catch(() =>
              Effect.succeed(
                HttpServerResponse.text("Preview unavailable. Open a new preview from Launchpad.", {
                  status: 403,
                  headers: privateHeaders,
                }),
              ),
            ),
          );
        });
    }),
    { global: true },
  );

export const threadVmPreviewRoutes = makeThreadVmPreviewRoutes();
