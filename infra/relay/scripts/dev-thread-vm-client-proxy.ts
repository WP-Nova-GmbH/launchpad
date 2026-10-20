// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { inspectE2BThreadVmIngress } from "../src/machines/E2BThreadVmConnection.ts";
import type { E2BThreadVmSettings } from "../src/machines/E2BThreadVmCompute.ts";
import {
  makeE2BThreadVmEndpoint,
  makeE2BThreadVmHealth,
  ThreadVmEndpointError,
} from "../src/machines/E2BThreadVmEndpoint.ts";
import {
  DevThreadVmClientEndpoint,
  type ThreadVmClientEndpoint,
} from "../src/threads/ThreadVmClientConnection.ts";
import {
  sameThreadVmTarget,
  ThreadVmConnectionUnavailable,
  type ThreadVmConnectionTarget,
} from "../src/threads/ThreadVmConnection.ts";

type Target = ThreadVmConnectionTarget & { readonly state: "running" | "paused" };
type Resolver = NonNullable<typeof DevThreadVmClientEndpoint.Service>;
const MAX_ENDPOINTS = 2;
const MAX_REQUESTS = 32;
const MAX_PENDING_WS_BYTES = 1024 * 1024;
const hopHeaders = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "content-length",
  "cookie",
  "set-cookie",
  "forwarded",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** Refuse a mixed local/public setup before any dev relay client or listener is constructed. */
export function localVmClientConnectionsEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.DEV_RELAY_LOCAL_VM_CONNECTIONS?.trim();
  if (!flag || flag === "0") return false;
  if (
    flag !== "1" ||
    env.T3CODE_DISABLE_MANAGED_TUNNELS !== "1" ||
    (env.RELAY_TUNNEL_CLEANUP_MODE?.trim() || "off") !== "off" ||
    ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "RELAY_TUNNEL_ZONE_NAME"].some((key) =>
      env[key]?.trim(),
    )
  ) {
    throw new Error(
      "Local VM client connections require disabled managed tunnels, no Cloudflare configuration and tunnel cleanup off.",
    );
  }
  return true;
}

function filteredHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const result: NodeHttp.OutgoingHttpHeaders = {};
  const connection = new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      hopHeaders.has(name) ||
      connection.has(name) ||
      name.startsWith("e2b-") ||
      name.startsWith("x-e2b-") ||
      name.startsWith("x-forwarded-")
    )
      continue;
    result[name] = value;
  }
  return result;
}

function allowedRequest(request: NodeHttp.IncomingMessage, host: string) {
  if (
    request.headers.host !== host ||
    !request.url?.startsWith("/") ||
    request.url.startsWith("//")
  )
    return false;
  const url = new URL(request.url, `http://${host}`);
  // This is the existing app's API transport. Guest HTML and static client assets have no role here.
  return (
    url.origin === `http://${host}` &&
    (url.pathname.startsWith("/api/") ||
      url.pathname === "/oauth/token" ||
      url.pathname === "/.well-known/t3/environment" ||
      url.pathname === "/ws")
  );
}

const listen = (server: NodeHttp.Server) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") reject(new Error("No local listener"));
          else resolve(address.port);
        });
      }),
    catch: () => new ThreadVmConnectionUnavailable(),
  });

/** Scoped Node-only transport; the guest still authenticates every normal T3 request and WS ticket. */
export const makeDevThreadVmClientProxy = <E, R>(input: {
  readonly compute: E2BThreadVmSettings;
  readonly authorize: (userId: string, threadId: ThreadId) => Effect.Effect<Target, E, R>;
  readonly inspect?: typeof inspectE2BThreadVmIngress;
}) =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope;
    const resolveLock = yield* Semaphore.make(1);
    const context = yield* Effect.context<R>();
    const run = Effect.runPromiseWith(context);
    const entries = new Map<
      string,
      {
        readonly userId: string;
        readonly target: Target;
        readonly host: string;
        readonly scope: Scope.Closeable;
        readonly control: ThreadVmClientEndpoint["control"];
      }
    >();
    const inspect = input.inspect ?? inspectE2BThreadVmIngress;
    const control = makeE2BThreadVmEndpoint(input.compute);
    const health = makeE2BThreadVmHealth(input.compute);

    const resolveUnlocked: Resolver = ({ userId, threadId, target }) =>
      Effect.gen(function* () {
        if (
          target.identity.scope.threadId !== threadId ||
          !/^[a-z0-9]{1,58}$/u.test(target.sandboxId)
        )
          return yield* new ThreadVmConnectionUnavailable();
        const verify = Effect.suspend(() => input.authorize(userId, threadId)).pipe(
          Effect.flatMap((current) =>
            current.state === "running" && sameThreadVmTarget(current, target)
              ? Effect.void
              : Effect.fail(new ThreadVmConnectionUnavailable()),
          ),
        );
        // Paused status does not keep a connection worker alive. Reclaim inactive or
        // revoked entries across threads before the small listener cap is considered.
        for (const [key, entry] of entries) {
          const checked = yield* input
            .authorize(entry.userId, entry.target.identity.scope.threadId)
            .pipe(Effect.exit);
          if (
            checked._tag === "Failure" ||
            checked.value.state !== "running" ||
            !sameThreadVmTarget(checked.value, entry.target)
          ) {
            entries.delete(key);
            yield* Scope.close(entry.scope, Exit.void);
          }
        }
        for (const [key, entry] of entries) {
          if (entry.userId !== userId || entry.target.identity.scope.threadId !== threadId)
            continue;
          if (sameThreadVmTarget(entry.target, target) && entry.target.state === target.state) {
            return {
              endpoint: {
                providerKind: "manual" as const,
                httpBaseUrl: `http://${entry.host}`,
                wsBaseUrl: `ws://${entry.host}`,
              },
              control: entry.control,
            };
          }
          entries.delete(key);
          yield* Scope.close(entry.scope, Exit.void);
        }
        if (entries.size >= MAX_ENDPOINTS) return yield* new ThreadVmConnectionUnavailable();
        const scope = yield* Scope.fork(parentScope, "sequential");
        const sockets = new Set<NodeNet.Socket>();
        const upstreams = new Set<NodeHttp.ClientRequest>();
        const websocketClients = new Set<NodeSocket.NodeWS.WebSocket>();
        const selectedProtocols = new WeakMap<NodeHttp.IncomingMessage, string>();
        const wsServer = new NodeSocket.NodeWS.WebSocketServer({
          noServer: true,
          maxPayload: 32 * 1024 * 1024,
          handleProtocols: (protocols, request) => {
            const selected = selectedProtocols.get(request);
            return selected && protocols.has(selected) ? selected : false;
          },
        });
        const server = NodeHttp.createServer();
        server.maxConnections = MAX_REQUESTS * 2;
        let closed = false,
          minted = false,
          pendingControls = 0,
          activeRequests = 0;
        let host = "";
        const key = `${userId}\0${target.identity.scope.allocationId}\0${target.identity.scope.generation}`;
        const close = async () => {
          if (closed) return;
          closed = true;
          entries.delete(key);
          for (const request of upstreams) request.destroy();
          for (const socket of websocketClients) socket.terminate();
          for (const socket of sockets) socket.destroy();
          wsServer.close();
          await new Promise<void>((done) => server.close(() => done()));
        };
        yield* Scope.addFinalizer(scope, Effect.promise(close));
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        const prepare = async (request: NodeHttp.IncomingMessage, signal: AbortSignal) => {
          if (closed || !allowedRequest(request, host)) throw new Error("Invalid local request");
          await run(verify, { signal });
          const ingress = await inspect(
            input.compute,
            target.sandboxId,
            target.identity,
            fetch,
            signal,
          );
          await run(verify, { signal });
          if (ingress.sandboxId !== target.sandboxId) throw new Error("Changed VM ingress");
          const url = new URL(request.url!, ingress.origin);
          const headers = {
            ...filteredHeaders(request.headers),
            host,
            "E2b-Sandbox-Id": ingress.sandboxId,
            "E2b-Sandbox-Port": "3773",
            "e2b-traffic-access-token": Redacted.value(ingress.trafficAccessToken),
          };
          return { url, headers };
        };
        server.on("request", (request, response) => {
          if (activeRequests >= MAX_REQUESTS) {
            response.writeHead(503).end();
            return;
          }
          activeRequests++;
          const abort = new AbortController();
          response.once("close", () => {
            activeRequests--;
            abort.abort();
          });
          void (async () => {
            const { url, headers } = await prepare(request, abort.signal);
            if (response.destroyed) return;
            const upstream = (url.protocol === "https:" ? NodeHttps : NodeHttp).request(
              url,
              {
                method: request.method,
                headers,
                signal: abort.signal,
              },
              (received) => {
                void run(verify, { signal: abort.signal })
                  .then(() => {
                    if (response.destroyed) {
                      received.destroy();
                      return;
                    }
                    response.writeHead(
                      received.statusCode ?? 502,
                      filteredHeaders(received.headers),
                    );
                    received.pipe(response);
                  })
                  .catch(() => {
                    received.destroy();
                    response.writeHead(403).end();
                  });
              },
            );
            upstreams.add(upstream);
            upstream.once("close", () => upstreams.delete(upstream));
            upstream.setTimeout(30_000, () => upstream.destroy());
            upstream.on("error", () => {
              if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
              response.end();
            });
            request.pipe(upstream);
          })().catch(() => {
            if (!response.headersSent) response.writeHead(403, { "cache-control": "no-store" });
            response.end();
          });
        });
        server.on("upgrade", (request, socket, head) => {
          if (activeRequests >= MAX_REQUESTS || request.url?.split("?")[0] !== "/ws") {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
          }
          activeRequests++;
          const abort = new AbortController();
          socket.once("close", () => {
            activeRequests--;
            abort.abort();
          });
          void (async () => {
            const { url, headers } = await prepare(request, abort.signal);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            const upstream = new NodeSocket.NodeWS.WebSocket(url, protocols, {
              headers,
              handshakeTimeout: 10_000,
              maxPayload: 32 * 1024 * 1024,
            });
            websocketClients.add(upstream);
            let client: NodeSocket.NodeWS.WebSocket | undefined;
            let pendingBytes = 0;
            const pending: Array<{ data: NodeSocket.NodeWS.RawData; binary: boolean }> = [];
            const terminate = () => {
              upstream.terminate();
              client?.terminate();
            };
            socket.once("close", terminate);
            upstream.on("error", () => {
              if (!client) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
              terminate();
            });
            upstream.on("close", () => {
              websocketClients.delete(upstream);
              if (client?.readyState === NodeSocket.NodeWS.WebSocket.OPEN) client.close();
              else if (!client) socket.destroy();
            });
            upstream.on("message", (data, binary) => {
              if (client?.readyState === NodeSocket.NodeWS.WebSocket.OPEN)
                client.send(data, { binary });
              else {
                pendingBytes += Array.isArray(data)
                  ? data.reduce((n, b) => n + b.byteLength, 0)
                  : data.byteLength;
                if (pendingBytes > MAX_PENDING_WS_BYTES || pending.length >= 64) terminate();
                else pending.push({ data, binary });
              }
            });
            upstream.once("open", () => {
              void run(verify, { signal: abort.signal })
                .then(() => {
                  if (
                    closed ||
                    socket.destroyed ||
                    upstream.readyState !== NodeSocket.NodeWS.WebSocket.OPEN
                  ) {
                    terminate();
                    return;
                  }
                  selectedProtocols.set(request, upstream.protocol);
                  wsServer.handleUpgrade(request, socket, head, (accepted) => {
                    client = accepted;
                    websocketClients.add(accepted);
                    accepted.on("error", terminate);
                    accepted.on("message", (data, binary) => upstream.send(data, { binary }));
                    accepted.once("close", () => {
                      websocketClients.delete(accepted);
                      upstream.close();
                    });
                    for (const frame of pending)
                      accepted.send(frame.data, { binary: frame.binary });
                    pending.length = 0;
                  });
                })
                .catch(() => {
                  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                  terminate();
                });
            });
          })().catch(() => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
        });
        const port = yield* listen(server).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        host = `3773-${target.sandboxId}.localhost:${port}`;
        const runControl = <A, E>(request: Effect.Effect<A, E>) =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              if (closed) return yield* new ThreadVmEndpointError();
              pendingControls++;
            }),
            () => request,
            // Health and mint calls overlap across clients. A failed last call
            // releases only a never-issued listener with no active client traffic.
            (_, exit) =>
              Effect.gen(function* () {
                pendingControls--;
                if (
                  Exit.isFailure(exit) &&
                  !minted &&
                  pendingControls === 0 &&
                  activeRequests === 0
                )
                  yield* Scope.close(scope, Exit.void);
              }),
          );
        const entryControl: ThreadVmClientEndpoint["control"] = {
          mintCredential: (...args) =>
            runControl(
              control.mintCredential(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    minted = true;
                  }),
                ),
              ),
            ),
          health: (proof) => runControl(health(target.sandboxId, target.identity, proof)),
        };
        entries.set(key, { userId, target, host, scope, control: entryControl });
        if (target.state === "running") {
          yield* verify.pipe(
            Effect.repeat(Schedule.spaced("5 seconds")),
            Effect.catchCause(() => Effect.forkIn(Scope.close(scope, Exit.void), parentScope)),
            Effect.provide(context),
            Effect.forkIn(scope),
          );
        }
        return {
          endpoint: {
            providerKind: "manual" as const,
            httpBaseUrl: `http://${host}`,
            wsBaseUrl: `ws://${host}`,
          },
          control: entryControl,
        };
      }).pipe(
        Effect.mapError(() => new ThreadVmConnectionUnavailable()),
        Effect.provide(context),
      );
    return (request: Parameters<Resolver>[0]) =>
      resolveLock.withPermits(1)(resolveUnlocked(request));
  });
