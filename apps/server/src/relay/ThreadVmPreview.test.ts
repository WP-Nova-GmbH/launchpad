// @effect-diagnostics nodeBuiltinImport:off - Real loopback proxy fixtures exercise native HTTP and WebSocket framing.
// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off - Browser-facing wire tests intentionally use native fetch and raw fixture payloads.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmPreviewProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_THREAD_VM_PREVIEW_HEADER,
  RELAY_THREAD_VM_PREVIEW_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { threadVmPreviewMiddlewareLayer } from "./ThreadVmPreview.ts";

const key = NodeCrypto.generateKeyPairSync("ed25519");
const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const vm = {
  operationId: "operation",
  environmentId: EnvironmentId.make("environment"),
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repository",
    generation: 2,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "private-environment-credential",
  cloudMintPublicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const listen = (server: NodeHttp.Server) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") reject(new Error("Fixture has no address"));
          else resolve(address.port);
        });
      }),
  );
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  FetchHttpClient.layer,
);

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase)
    VALUES('thread',${vm.relayUrl},${vm.environmentId},'vm:thread',2,'operation','active')`;
  const requests: Array<{ url: string; headers: NodeHttp.IncomingHttpHeaders; body: string }> = [];
  let streamRelease: () => void = () => {};
  const streamReleased = new Promise<void>((resolve) => {
    streamRelease = resolve;
  });
  const closed = yield* Deferred.make<void>();
  const app = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.url === "/redirect") {
        const address = app.address();
        if (!address || typeof address === "string") throw new Error("Fixture has no address");
        response.writeHead(302, {
          location: `http://127.0.0.1:${address.port}/final?x=1#part`,
          "set-cookie": ["app_session=app-value; Path=/", "t3_session=must-not-install; Path=/"],
        });
        response.end();
      } else if (request.url === "/fail") {
        response.destroy();
      } else if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first");
        streamReleased.then(() => response.end("second"));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(requests.at(-1)));
      }
    });
  });
  const appSockets = new NodeSocket.NodeWS.WebSocketServer({
    server: app,
    handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
  });
  appSockets.on("error", () => {});
  appSockets.on("connection", (socket, request) => {
    requests.push({ url: request.url ?? "", headers: request.headers, body: "socket" });
    socket.on("message", (data, binary) => socket.send(data, { binary }));
    socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
  });
  const native = NodeHttp.createServer();
  const nativeSockets = new Set<NodeNet.Socket>();
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      streamRelease();
      for (const socket of nativeSockets) socket.destroy();
      for (const socket of appSockets.clients) socket.terminate();
      appSockets.close();
      for (const server of [native, app]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
  );
  const appPort = yield* listen(app);
  const secrets = Layer.mock(ServerSecretStore)({
    get: (name) =>
      Effect.succeed(
        name === THREAD_VM_IDENTITY_SECRET
          ? Option.some(new TextEncoder().encode(JSON.stringify(vm)))
          : Option.none(),
      ),
  });
  const serving = HttpRouter.serve(
    HttpRouter.add("*", "/*", HttpServerResponse.text("management")).pipe(
      Layer.provide(threadVmPreviewMiddlewareLayer),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provide(secrets),
  );
  const context = yield* Layer.build(serving);
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") throw new Error("Fixture has no TCP address");
  const guestPort = address.port;
  // Stock's native proxy may pass its routing credentials unchanged. This
  // fixture deliberately does so for both HTTP and raw WebSocket upgrades.
  native.on("request", (request, response) => {
    const upstream = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: guestPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          connection: `${request.headers.connection ?? "keep-alive"}, x-hop-secret`,
          "x-hop-secret": "connection-private",
          "cf-access-client-secret": "cloudflare-private",
        },
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => response.end());
    request.pipe(upstream);
  });
  native.on("upgrade", (request, socket, head) => {
    const headers = {
      ...request.headers,
      connection: `${request.headers.connection ?? "Upgrade"}, x-hop-secret`,
      "x-hop-secret": "connection-private",
      "cf-access-client-secret": "cloudflare-private",
    };
    const upstream = NodeNet.connect(guestPort, "127.0.0.1");
    nativeSockets.add(upstream);
    upstream.once("connect", () => {
      upstream.write(
        `GET ${request.url} HTTP/1.1\r\n` +
          Object.entries(headers)
            .flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((part) => `${name}: ${part}\r\n`),
            )
            .join("") +
          "\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      nativeSockets.delete(upstream);
      socket.destroy();
    });
  });
  const nativePort = yield* listen(native);
  const proof = (overrides: Partial<RelayThreadVmPreviewProofPayload> = {}) =>
    Effect.gen(function* () {
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      return yield* signRelayJwt({
        privateKey,
        typ: RELAY_THREAD_VM_PREVIEW_TYP,
        payload: {
          iss: vm.relayIssuer,
          aud: `t3-env:${vm.environmentId}`,
          sub: vm.scope.threadId,
          jti: NodeCrypto.randomUUID(),
          iat: now,
          exp: now + 30,
          environmentId: vm.environmentId,
          operationId: vm.operationId,
          scope: vm.scope,
          port: appPort,
          ...overrides,
        },
      });
    });
  const headers = (token: string) => ({
    [RELAY_THREAD_VM_PREVIEW_HEADER]: token,
    "e2b-traffic-access-token": "native-traffic-secret",
    "e2b-sandbox-port": "untrusted-port",
    "x-access-token": "envd-secret",
    "x-api-key": "management-secret",
    "x-forwarded-host": "attacker.test",
    authorization: "Bearer relay-secret",
    dpop: "dpop-secret",
    cookie:
      "app_session=app-cookie; __session=clerk-secret; t3_session_3773=server-secret; __Host-launchpad-vm-preview=preview-secret",
    origin: "https://preview.test",
  });
  return {
    appPort,
    origin: `http://127.0.0.1:${nativePort}`,
    proof,
    headers,
    requests,
    streamRelease,
    closed,
    sql,
  };
});

describe("trusted thread VM preview hop", () => {
  it.effect("keeps preview authorization after a backup reactivates the execution fence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const token = yield* f.proof();
        const fences = makeThreadExecutionFence(f.sql);
        const backup = {
          threadId: vm.scope.threadId,
          generation: vm.scope.generation,
          operationId: "periodic-backup",
        };
        yield* fences.beginDrain({ ...backup, previousOperationId: vm.operationId });
        expect(
          (yield* Effect.promise(() => fetch(f.origin + "/", { headers: f.headers(token) })))
            .status,
        ).toBe(403);
        yield* fences.activate(backup);
        const response = yield* Effect.promise(() =>
          fetch(f.origin + "/after-backup", { headers: f.headers(token) }),
        );
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.text());
        expect(f.requests.map((request) => request.url)).toEqual(["/after-backup"]);
      }),
    ).pipe(Effect.provide(dependencies)),
  );

  it.effect(
    "streams HTTP through the native hop without forwarding routing or relay credentials",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const token = yield* f.proof();
          const response = yield* Effect.promise(() =>
            fetch(f.origin + "/nested/path?x=1&x=2", {
              method: "POST",
              headers: {
                ...f.headers(token),
                "content-type": "text/plain",
                "x-application": "retained",
              },
              body: "application body",
            }),
          );
          expect(response.status).toBe(200);
          const body = yield* Effect.promise(() => response.text());
          expect(body).not.toMatch(
            /native-traffic-secret|envd-secret|management-secret|relay-secret|dpop-secret|clerk-secret|server-secret|preview-secret|connection-private|cloudflare-private/,
          );
          expect(body).not.toContain(token);
          expect(f.requests[0]).toMatchObject({
            url: "/nested/path?x=1&x=2",
            body: "application body",
            headers: {
              cookie: "app_session=app-cookie",
              "x-application": "retained",
              origin: `http://127.0.0.1:${f.appPort}`,
            },
          });
          expect(f.requests[0]!.headers).not.toHaveProperty("x-forwarded-host");
          const stream = yield* Effect.promise(() =>
            fetch(f.origin + "/stream", { headers: f.headers(token) }),
          );
          const reader = stream.body!.getReader();
          expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe(
            "first",
          );
          yield* Effect.sync(f.streamRelease);
          expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toBe(
            "second",
          );
          yield* Effect.promise(() => reader.cancel());
        }),
      ).pipe(Effect.provide(dependencies)),
  );

  it.effect("keeps application cookies and returns loopback redirects without following them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const headers = f.headers(yield* f.proof());
        const response = yield* Effect.promise(() =>
          fetch(f.origin + "/redirect", { headers, redirect: "manual" }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/final?x=1#part");
        expect(response.headers.get("set-cookie")).toContain("app_session=app-value");
        expect(response.headers.get("set-cookie")).not.toContain("t3_session");
        expect(f.requests).toHaveLength(1);
        const failed = yield* Effect.promise(() => fetch(f.origin + "/fail", { headers }));
        expect(failed.status).toBe(502);
        expect(yield* Effect.promise(() => failed.text())).toBe("");
      }),
    ).pipe(Effect.provide(dependencies)),
  );

  it.effect("rejects stale or untrusted scopes and never opens management ports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
        for (const overrides of [
          { port: 3773 },
          { port: 49983 },
          { port: 80 },
          { environmentId: EnvironmentId.make("other") },
          { operationId: "other" },
          { scope: { ...vm.scope, generation: 3 } },
          { scope: { ...vm.scope, allocationId: "other" } },
          { scope: { ...vm.scope, repositoryId: "other" } },
          { scope: { ...vm.scope, threadId: ThreadId.make("other") } },
          { sub: "other" },
          { exp: now - 1 },
          { exp: now + 31 },
          { iat: now + 6 },
        ]) {
          const token = yield* f.proof(overrides);
          const response = yield* Effect.promise(() =>
            fetch(f.origin + "/", { headers: f.headers(token) }),
          );
          expect(response.status).toBe(403);
        }
        const valid = yield* f.proof();
        for (const token of ["unverified", valid.slice(0, -8) + "invalid_"]) {
          const response = yield* Effect.promise(() =>
            fetch(f.origin + "/", { headers: f.headers(token) }),
          );
          expect(response.status).toBe(403);
        }
        for (const invalidFence of [
          f.sql`UPDATE thread_execution_fences SET phase='draining' WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET phase='frozen' WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET phase='retired' WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET environment_id='other' WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET generation=3 WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET project_id='other' WHERE thread_id='thread'`,
          f.sql`UPDATE thread_execution_fences SET relay_url='https://other.test' WHERE thread_id='thread'`,
        ]) {
          yield* f.sql`UPDATE thread_execution_fences SET phase='active',environment_id=${vm.environmentId},
            generation=${vm.scope.generation},project_id='vm:thread',relay_url=${vm.relayUrl} WHERE thread_id='thread'`;
          yield* invalidFence;
          expect(
            (yield* Effect.promise(() => fetch(f.origin + "/", { headers: f.headers(valid) })))
              .status,
          ).toBe(403);
        }
        expect(f.requests).toHaveLength(0);
        expect(
          yield* Effect.promise(async () =>
            (
              await fetch(f.origin + "/", {
                headers: { "x-forwarded-port": String(f.appPort) },
              })
            ).text(),
          ),
        ).toBe("management");
      }),
    ).pipe(Effect.provide(dependencies)),
  );

  it.effect(
    "preserves WebSocket traffic after backup reactivation through both hops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const token = yield* f.proof();
          const fences = makeThreadExecutionFence(f.sql);
          const backup = {
            threadId: vm.scope.threadId,
            generation: vm.scope.generation,
            operationId: "periodic-backup",
          };
          yield* fences.beginDrain({ ...backup, previousOperationId: vm.operationId });
          yield* fences.activate(backup);
          const client = new NodeSocket.NodeWS.WebSocket(
            f.origin.replace(/^http/, "ws") + "/hmr?app=1",
            ["first", "vite-hmr"],
            { headers: f.headers(token) },
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => client.terminate()));
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                client.once("open", resolve);
                client.once("error", reject);
              }),
          );
          expect(client.protocol).toBe("vite-hmr");
          expect(f.requests[0]).toMatchObject({
            url: "/hmr?app=1",
            headers: { cookie: "app_session=app-cookie" },
          });
          const serialized = JSON.stringify(f.requests[0]!.headers);
          expect(serialized).not.toMatch(
            /native-traffic-secret|envd-secret|management-secret|relay-secret|preview-secret|server-secret|clerk-secret|dpop-secret|connection-private|cloudflare-private/,
          );
          expect(serialized).not.toContain(token);
          for (const message of ["hmr-update", Buffer.from([0, 1, 255])]) {
            const echoed = new Promise<{ data: Buffer; binary: boolean }>((resolve) =>
              client.once("message", (data, binary) =>
                resolve({ data: Buffer.from(data as Buffer), binary }),
              ),
            );
            client.send(message);
            const result = yield* Effect.promise(() => echoed);
            expect(result.data).toEqual(Buffer.from(message));
            expect(result.binary).toBe(typeof message !== "string");
          }
          client.close();
          yield* Deferred.await(f.closed);
        }),
      ).pipe(Effect.provide(dependencies)),
    { timeout: 10_000 },
  );
});
