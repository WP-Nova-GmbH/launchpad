// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ThreadVmPreviewDenied } from "../threads/ThreadVmPreviewStore.ts";
import { ThreadVmPreviewWebSocket } from "./ThreadVmPreviewWebSocket.ts";

export const threadVmPreviewNode = Layer.succeed(
  ThreadVmPreviewWebSocket,
  ThreadVmPreviewWebSocket.of({
    open: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          let protocol = "";
          const upstream = yield* Socket.makeWebSocket(input.url, {
            openTimeout: "10 seconds",
          }).pipe(
            Effect.provideService(Socket.WebSocketConstructor, (url) => {
              const socket = new NodeSocket.NodeWS.WebSocket(
                url,
                (input.request.headers["sec-websocket-protocol"] ?? "")
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean),
                { headers: input.headers },
              );
              // ws emits cancellation errors after the scoped Effect reader detaches.
              socket.on("error", () => {});
              socket.once("open", () => {
                protocol = socket.protocol;
              });
              return socket;
            }),
          );
          const { pull } = yield* upstream.reader.pipe(
            Effect.raceFirst(input.guard.pipe(Effect.andThen(new ThreadVmPreviewDenied()))),
          );
          const upstreamWriter = yield* upstream.writer;
          // Connect upstream before upgrading the client, so a rejected handshake stays an HTTP error.
          // Node otherwise selects the first offer, even when the app selected another.
          if (input.request.source instanceof NodeHttp.IncomingMessage) {
            if (protocol) input.request.source.headers["sec-websocket-protocol"] = protocol;
            else delete input.request.source.headers["sec-websocket-protocol"];
          }
          const client = yield* input.request.upgrade;
          const { pull: clientPull } = yield* client.reader;
          const clientWriter = yield* client.writer;
          yield* Effect.raceFirst(
            input.guard,
            Effect.raceFirst(
              Effect.gen(function* () {
                while (true) yield* clientWriter.writeAll(yield* pull);
              }),
              Effect.gen(function* () {
                while (true) yield* upstreamWriter.writeAll(yield* clientPull);
              }),
            ),
          ).pipe(Effect.ignoreCause);
          return HttpServerResponse.empty();
        }),
      ).pipe(Effect.mapError(() => new ThreadVmPreviewDenied())),
  }),
);
