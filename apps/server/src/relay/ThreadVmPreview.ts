// @effect-diagnostics nodeBuiltinImport:off - Preserve the upstream-selected protocol on the native WebSocket upgrade.
import * as NodeHttp from "node:http";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { RelayThreadVmPreviewProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_THREAD_VM_PREVIEW_HEADER,
  RELAY_THREAD_VM_PREVIEW_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";

const decodeProof = Schema.decodeUnknownEffect(RelayThreadVmPreviewProofPayload);
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
const privateHeader = (name: string) =>
  ["authorization", "dpop", "x-access-token", "x-api-key", "forwarded"].includes(name) ||
  name.startsWith("e2b-") ||
  name.startsWith("x-e2b-") ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("cf-access-") ||
  name.startsWith("x-launchpad-") ||
  name.startsWith("x-t3-");
const privateCookie = (name: string) =>
  ["__Host-launchpad-vm-preview", "launchpad-vm-preview", "__session"].includes(name) ||
  name.startsWith("__clerk") ||
  name.startsWith("t3_") ||
  name.startsWith("t3-");
const connectionHeaders = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim()),
  );

function requestHeaders(request: HttpServerRequest.HttpServerRequest, origin: string) {
  const headers: Record<string, string> = {};
  const nominated = connectionHeaders(request.headers.connection);
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      !value ||
      hopHeaders.has(name) ||
      nominated.has(name) ||
      privateHeader(name) ||
      name === "cookie" ||
      name.startsWith("sec-websocket-")
    )
      continue;
    headers[name] = value;
  }
  const cookies = Object.entries(request.cookies).filter(([name]) => !privateCookie(name));
  if (cookies.length && !nominated.has("cookie"))
    headers.cookie = cookies
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
  if (request.headers.origin && !nominated.has("origin")) headers.origin = origin;
  return headers;
}

function responseCookies(cookies: Cookies.Cookies) {
  let result = Cookies.empty;
  for (const cookie of Object.values(cookies.cookies)) {
    if (privateCookie(cookie.name)) continue;
    const { domain: _domain, ...options } = cookie.options ?? {};
    result = Cookies.setUnsafe(result, cookie.name, cookie.value, options);
  }
  return result;
}

const proxyWebSocket = Effect.fn("ThreadVmPreview.websocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  headers: Record<string, string>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      let protocol = "";
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const upstream = yield* Socket.makeWebSocket(upstreamUrl.replace(/^http/, "ws"), {
        openTimeout: "10 seconds",
      }).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) => {
          const socket = new NodeSocket.NodeWS.WebSocket(url, protocols, { headers });
          socket.on("open", () => {
            protocol = socket.protocol;
          });
          socket.on("error", () => {});
          return socket;
        }),
      );
      const { pull } = yield* upstream.reader;
      const upstreamWriter = yield* upstream.writer;
      // Node's default upgrade selects the first offered protocol. Carry the
      // application's negotiated selection, which need not be the first offer.
      if (request.source instanceof NodeHttp.IncomingMessage) {
        if (protocol) request.source.headers["sec-websocket-protocol"] = protocol;
        else delete request.source.headers["sec-websocket-protocol"];
      }
      const client = yield* request.upgrade;
      const { pull: clientPull } = yield* client.reader;
      const clientWriter = yield* client.writer;
      yield* Effect.raceFirst(
        Effect.gen(function* () {
          while (true) yield* clientWriter.writeAll(yield* pull);
        }),
        Effect.gen(function* () {
          while (true) yield* upstreamWriter.writeAll(yield* clientPull);
        }),
      ).pipe(Effect.ignoreCause);
      return HttpServerResponse.empty();
    }),
  );
});

const proxyHttp = Effect.fn("ThreadVmPreview.http")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstream: URL,
  headers: Record<string, string>,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client
    .execute(
      HttpClientRequest.make(request.method)(upstream.href).pipe(
        HttpClientRequest.setHeaders(headers),
        request.method === "GET" || request.method === "HEAD"
          ? (self) => self
          : HttpClientRequest.bodyStream(request.stream),
      ),
    )
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  const responseHeaders: Record<string, string> = {};
  const nominated = connectionHeaders(response.headers.connection);
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      !value ||
      hopHeaders.has(name) ||
      nominated.has(name) ||
      privateHeader(name) ||
      ["content-encoding", "set-cookie", "clear-site-data"].includes(name)
    )
      continue;
    responseHeaders[name] = value;
  }
  if (responseHeaders.location) {
    const location = new URL(responseHeaders.location, upstream);
    if (
      location.origin === upstream.origin ||
      (location.protocol === "http:" &&
        location.hostname === "localhost" &&
        location.port === upstream.port)
    )
      responseHeaders.location = `${location.pathname}${location.search}${location.hash}`;
  }
  responseHeaders["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    cookies: nominated.has("set-cookie") ? Cookies.empty : responseCookies(response.cookies),
  });
});

/** Native E2B may forward routing credentials. Only this trusted guest hop
 * receives them; the selected application gets a new, sanitized loopback request. */
const handlePreview = Effect.fn("ThreadVmPreview.handle")(
  function* (token: string) {
    if (token.length > 8192) return HttpServerResponse.empty({ status: 403 });
    const vm = yield* readInstalledThreadVm();
    if (!vm) return HttpServerResponse.empty({ status: 404 });
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const proof = yield* verifyRelayJwt({
      publicKey: vm.cloudMintPublicKey,
      token,
      typ: RELAY_THREAD_VM_PREVIEW_TYP,
      issuer: vm.relayIssuer,
      audience: `t3-env:${vm.environmentId}`,
      nowEpochSeconds: now,
      maxTokenAge: "30 seconds",
    }).pipe(Effect.flatMap(decodeProof));
    if (
      proof.environmentId !== vm.environmentId ||
      proof.operationId !== vm.operationId ||
      proof.sub !== vm.scope.threadId ||
      proof.scope.allocationId !== vm.scope.allocationId ||
      proof.scope.threadId !== vm.scope.threadId ||
      proof.scope.repositoryId !== vm.scope.repositoryId ||
      proof.scope.generation !== vm.scope.generation ||
      proof.iat > now + 5 ||
      proof.exp <= now ||
      proof.exp <= proof.iat ||
      proof.exp - proof.iat > 30
    )
      return HttpServerResponse.empty({ status: 403 });
    const fence = yield* makeThreadExecutionFence(yield* SqlClient.SqlClient).get(
      vm.scope.threadId,
    );
    if (
      !fence ||
      fence.phase !== "active" ||
      fence.environmentId !== vm.environmentId ||
      fence.generation !== vm.scope.generation ||
      fence.relayUrl !== vm.relayUrl ||
      fence.projectId !== `vm:${vm.scope.threadId}`
    )
      return HttpServerResponse.empty({ status: 403 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method))
      return HttpServerResponse.empty({ status: 405 });
    const path = request.originalUrl;
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/u.test(path))
      return HttpServerResponse.empty({ status: 400 });
    const origin = `http://127.0.0.1:${proof.port}`;
    const upstream = new URL(origin + path);
    if (upstream.origin !== origin) return HttpServerResponse.empty({ status: 400 });
    const headers = requestHeaders(request, origin);
    return request.headers.upgrade?.toLowerCase() === "websocket"
      ? yield* proxyWebSocket(request, upstream.href, headers).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })),
        )
      : yield* proxyHttp(request, upstream, headers).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })),
        );
  },
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
);

export const threadVmPreviewMiddlewareLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = request.headers[RELAY_THREAD_VM_PREVIEW_HEADER];
      return token === undefined ? yield* httpEffect : yield* handlePreview(token);
    }),
  { global: true },
);
