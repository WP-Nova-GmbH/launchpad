// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { threadVmPreviewNode } from "./ThreadVmPreviewNode.ts";
import { ThreadVmPreviewWebSocket } from "./ThreadVmPreviewWebSocket.ts";
import { ThreadVmPreviewDenied } from "../threads/ThreadVmPreviewStore.ts";

const listen = (server: NodeHttp.Server) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") reject(new ThreadVmPreviewDenied());
          else resolve(address.port);
        });
      }),
    catch: () => new ThreadVmPreviewDenied(),
  });
it.effect(
  "forwards real HMR WebSocket frames and closes both sides on revoked access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = NodeHttp.createServer(),
          relay = NodeHttp.createServer(),
          appSockets = new NodeSocket.NodeWS.WebSocketServer({ server: app }),
          relaySockets = new NodeSocket.NodeWS.WebSocketServer({ server: relay });
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const group of [appSockets, relaySockets]) {
              for (const client of group.clients) client.terminate();
              group.close();
            }
            await Promise.all(
              [app, relay].map(
                (server) => new Promise<void>((resolve) => server.close(() => resolve())),
              ),
            );
          }),
        );
        const appPort = yield* listen(app),
          relayPort = yield* listen(relay),
          revoked = yield* Deferred.make<void, ThreadVmPreviewDenied>(),
          ready = yield* Deferred.make<void>(),
          connected = yield* Deferred.make<NodeSocket.NodeWS.WebSocket>(),
          closed = yield* Deferred.make<void>();
        let headers: NodeHttp.IncomingHttpHeaders | undefined, protocol: string | undefined;
        appSockets.on("connection", (socket, request) => {
          headers = request.headers;
          protocol = socket.protocol;
          socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
          socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
        });
        const transport = Context.get(
          yield* Layer.build(threadVmPreviewNode),
          ThreadVmPreviewWebSocket,
        );
        relaySockets.once("connection", (socket) =>
          Deferred.doneUnsafe(connected, Effect.succeed(socket)),
        );
        const client = new NodeSocket.NodeWS.WebSocket(
          `ws://127.0.0.1:${relayPort}/hmr`,
          "vite-hmr",
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => client.terminate()));
        const response = yield* Deferred.make<string>(),
          clientClosed = yield* Deferred.make<void>();
        client.on("message", (data) =>
          Deferred.doneUnsafe(response, Effect.succeed(data.toString())),
        );
        client.on("close", () => Deferred.doneUnsafe(clientClosed, Effect.void));
        const opened = new Promise<void>((resolve, reject) => {
          client.once("open", () => resolve());
          client.once("error", reject);
        });
        const accepted = yield* Deferred.await(connected);
        const request = HttpServerRequest.fromWeb(
          new Request(`http://127.0.0.1:${relayPort}/hmr`, {
            headers: { "sec-websocket-protocol": "vite-hmr" },
          }),
        );
        Object.defineProperty(request, "upgrade", {
          value: Socket.fromWebSocket(
            Effect.acquireRelease(Effect.succeed(accepted), (socket) =>
              Effect.sync(() => socket.close(1000)),
            ),
          ).pipe(
            Effect.map((socket) => {
              const reader = socket.reader;
              Object.defineProperty(socket, "reader", {
                value: reader.pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
              });
              return socket;
            }),
          ),
        });
        const proxy = yield* transport
          .open({
            request,
            url: `ws://127.0.0.1:${appPort}/hmr`,
            headers: {
              "E2b-Sandbox-Id": "private-vm",
              "E2b-Sandbox-Port": "4080",
              "e2b-traffic-access-token": "private-traffic-token",
            },
            guard: Deferred.await(revoked),
          })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => opened);
        yield* Deferred.await(ready);
        client.send("hmr-update");
        expect(yield* Deferred.await(response)).toBe("hmr-update");
        expect(protocol).toBe("vite-hmr");
        expect(headers).toMatchObject({
          "e2b-sandbox-id": "private-vm",
          "e2b-sandbox-port": "4080",
          "e2b-traffic-access-token": "private-traffic-token",
        });
        yield* Deferred.fail(revoked, new ThreadVmPreviewDenied());
        yield* Fiber.join(proxy);
        yield* Effect.all([Deferred.await(closed), Deferred.await(clientClosed)]);
      }),
    ),
  { timeout: 10_000 },
);

it.effect(
  "revokes an outstanding upstream handshake before upgrading the client",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = NodeHttp.createServer(),
          upgraded = yield* Deferred.make<void>();
        const sockets = new Set<import("node:stream").Duplex>();
        app.on("upgrade", (_request, socket) => {
          sockets.add(socket);
          Deferred.doneUnsafe(upgraded, Effect.void);
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => {
            for (const socket of sockets) socket.destroy();
            return new Promise<void>((resolve) => app.close(() => resolve()));
          }),
        );
        const port = yield* listen(app),
          revoked = yield* Deferred.make<void, ThreadVmPreviewDenied>();
        const request = HttpServerRequest.fromWeb(new Request("http://preview.test/hmr"));
        Object.defineProperty(request, "upgrade", {
          value: Effect.die("Client must not be upgraded"),
        });
        const transport = Context.get(
          yield* Layer.build(threadVmPreviewNode),
          ThreadVmPreviewWebSocket,
        );
        const opening = yield* transport
          .open({
            request,
            url: `ws://127.0.0.1:${port}/hmr`,
            headers: {},
            guard: Deferred.await(revoked),
          })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(upgraded);
        yield* Deferred.fail(revoked, new ThreadVmPreviewDenied());
        expect((yield* Fiber.join(opening))._tag).toBe("Failure");
      }),
    ),
  { timeout: 10_000 },
);
