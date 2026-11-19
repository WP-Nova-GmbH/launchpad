import type * as CF from "@cloudflare/workers-types";
import { WorkerExecutionContext } from "alchemy/Cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ThreadVmPreviewDenied } from "../threads/ThreadVmPreviewStore.ts";
import { ThreadVmPreviewWebSocket } from "./ThreadVmPreviewWebSocket.ts";

/** Workers receive the platform's raw upgrade response; both sockets close on revocation. */
export const threadVmPreviewCloudflare = Layer.succeed(
  ThreadVmPreviewWebSocket,
  ThreadVmPreviewWebSocket.of({
    open: (input) =>
      Effect.gen(function* () {
        const execution = yield* Effect.serviceOption(WorkerExecutionContext);
        if (Option.isNone(execution)) return yield* new ThreadVmPreviewDenied();
        const context = yield* Effect.context();
        const url = input.url.replace(/^ws/u, "http");
        // Fetch must retain the platform's 101/WebSocket response; HttpClient converts it.
        const upgradeFetch = globalThis.fetch.bind(globalThis);
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            upgradeFetch(url, {
              headers: {
                ...input.headers,
                upgrade: "websocket",
                ...(input.request.headers["sec-websocket-protocol"]
                  ? {
                      "sec-websocket-protocol": input.request.headers["sec-websocket-protocol"],
                    }
                  : {}),
              },
              redirect: "manual",
              signal,
            }),
          catch: () => new ThreadVmPreviewDenied(),
        }).pipe(
          Effect.raceFirst(input.guard.pipe(Effect.andThen(new ThreadVmPreviewDenied()))),
          Effect.timeout("10 seconds"),
          Effect.mapError(() => new ThreadVmPreviewDenied()),
        );
        const upstream = (response as unknown as CF.Response).webSocket;
        if (response.status !== 101 || !upstream) {
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
          return yield* new ThreadVmPreviewDenied();
        }
        const sockets = [upstream];
        const close = () => {
          for (const socket of sockets) {
            try {
              socket.close(1000, "Preview closed");
            } catch {}
          }
        };
        // Build the response before transferring socket cleanup to the bridge.
        const { server, raw } = yield* Effect.try({
          try: () => {
            const Pair = (
              globalThis as unknown as {
                WebSocketPair: new () => { 0: CF.WebSocket; 1: CF.WebSocket };
              }
            ).WebSocketPair;
            const pair = new Pair(),
              client = pair[0],
              server = pair[1];
            sockets.push(server);
            upstream.accept();
            server.accept();
            const headers = new Headers();
            const protocol = response.headers.get("sec-websocket-protocol");
            if (protocol) headers.set("sec-websocket-protocol", protocol);
            const raw = new (Response as unknown as typeof CF.Response)(null, {
              status: 101,
              headers,
              webSocket: client,
            });
            return { server, raw };
          },
          catch: () => new ThreadVmPreviewDenied(),
        }).pipe(Effect.onError(() => Effect.sync(close)));
        const bridge = Effect.callback<void>((resume) => {
          const forward = (sink: CF.WebSocket) => (event: CF.MessageEvent) => {
            try {
              sink.send(event.data);
            } catch {
              resume(Effect.void);
            }
          };
          const fromUpstream = forward(server),
            fromClient = forward(upstream),
            done = () => resume(Effect.void);
          upstream.addEventListener("message", fromUpstream);
          server.addEventListener("message", fromClient);
          for (const socket of [upstream, server]) {
            socket.addEventListener("close", done);
            socket.addEventListener("error", done);
          }
          return Effect.sync(() => {
            upstream.removeEventListener("message", fromUpstream);
            server.removeEventListener("message", fromClient);
            for (const socket of [upstream, server]) {
              socket.removeEventListener("close", done);
              socket.removeEventListener("error", done);
            }
          });
        });
        const lifetime = Effect.raceFirst(input.guard, bridge).pipe(
          Effect.ensuring(Effect.sync(close)),
          Effect.ignoreCause,
        );
        // Register the bridge at the Worker boundary. An unregistered detached
        // fiber can lose its authorization checks after the upgrade is returned.
        yield* Effect.try({
          try: () => execution.value.raw.waitUntil(Effect.runPromiseWith(context)(lifetime)),
          catch: () => new ThreadVmPreviewDenied(),
        }).pipe(Effect.onError(() => Effect.sync(close)));
        return HttpServerResponse.setBody(
          HttpServerResponse.empty({ status: 101 }),
          HttpBody.raw(raw),
        );
      }),
  }),
);
