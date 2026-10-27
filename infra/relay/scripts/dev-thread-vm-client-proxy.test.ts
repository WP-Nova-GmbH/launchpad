// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  verifyDpopProof,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  makeDevThreadVmClientProxy,
  localVmClientConnectionsEnabled,
} from "./dev-thread-vm-client-proxy.ts";
import {
  ThreadVmConnectionUnavailable,
  type ThreadVmConnectionTarget,
} from "../src/threads/ThreadVmConnection.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = keys.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
const credential = "normal-client-access-token";
function proof(url: string, jti: string, method = "GET") {
  const header = Buffer.from(encodeJson({ typ: "dpop+jwt", alg: "ES256", jwk })).toString(
    "base64url",
  );
  const body = Buffer.from(
    encodeJson({
      htm: method,
      htu: normalizeDpopHtu(url),
      jti,
      iat: 0,
      ath: computeDpopAccessTokenHash(credential),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${body}`), {
    key: keys.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${body}.${signature}`;
}
const target: ThreadVmConnectionTarget & { state: "running" | "paused" } = {
  state: "running",
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  environmentPublicKey: "guest-public-key",
  credentialId: "credential-id",
  sandboxId: "sandbox1",
  identity: {
    operationId: "operation",
    scope: {
      allocationId: "allocation",
      threadId: ThreadId.make("thread"),
      repositoryId: "repository",
      generation: 1,
    },
  },
};
const nativeInfo = {
  sandboxID: target.sandboxId,
  templateID: "template",
  state: "running",
  envdVersion: "test",
  envdAccessToken: "envd-secret",
  trafficAccessToken: "traffic-secret",
  network: { allowPublicTraffic: false },
  lifecycle: { autoResume: false },
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": target.identity.scope.allocationId,
    "launchpad.operation_id": target.identity.operationId,
    "launchpad.thread_id": target.identity.scope.threadId,
    "launchpad.generation": "1",
  },
};
const compute = {
  apiUrl: "http://127.0.0.1:1",
  sandboxUrl: "http://127.0.0.1:1",
  apiKey: Redacted.make("management-secret"),
  templateId: "template:pinned",
  hostAddresses: [],
  timeoutMs: 60_000,
};
const listen = (server: NodeHttp.Server) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("No test listener");
          resolve(address.port);
        }),
      ),
  );
function request(
  endpoint: string,
  path: string,
  headers: NodeHttp.OutgoingHttpHeaders = {},
  body?: string,
) {
  return Effect.promise(
    () =>
      new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const url = new URL(endpoint);
          const req = NodeHttp.request(
            {
              hostname: "127.0.0.1",
              port: url.port,
              path,
              method: body === undefined ? "GET" : "POST",
              headers: { host: url.host, ...headers },
            },
            (response) => {
              let text = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => (text += chunk));
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  body: text,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end(body);
        },
      ),
  );
}
const fixture = Effect.gen(function* () {
  const app = NodeHttp.createServer();
  const appWs = new NodeSocket.NodeWS.WebSocketServer({ noServer: true });
  const upstreamHeaders: NodeHttp.IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const usedProofs = new Set<string>();
  const usedTickets = new Set<string>();
  let current = target,
    allowed = true,
    inspections = 0;
  let afterInspect: (() => void) | undefined;
  const firstCheck = yield* Deferred.make<void>();
  const upstreamClosed = yield* Deferred.make<void>();
  app.on("request", (req, res) => {
    upstreamHeaders.push(req.headers);
    paths.push(req.url ?? "");
    const checked = verifyDpopProof({
      proof: req.headers.dpop as string | undefined,
      method: req.method ?? "GET",
      url: `http://${req.headers.host}${req.url}`,
      nowEpochSeconds: 0,
      expectedThumbprint: computeDpopJwkThumbprint(jwk),
      expectedAccessToken: credential,
    });
    if (
      req.headers.authorization !== `DPoP ${credential}` ||
      !checked.ok ||
      usedProofs.has(checked.jti)
    ) {
      res.writeHead(401).end();
      return;
    }
    usedProofs.add(checked.jti);
    req.resume();
    req.on("end", () =>
      res
        .writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "vm-cookie=private; Domain=localhost",
          "e2b-traffic-access-token": "traffic-secret",
          "x-e2b-private": "private-secret",
        })
        .end('{"ok":true}'),
    );
  });
  app.on("upgrade", (req, socket, head) => {
    upstreamHeaders.push(req.headers);
    paths.push(req.url ?? "");
    const ticket = new URL(req.url ?? "/", `http://${req.headers.host}`).searchParams.get("ticket");
    if (ticket !== "one-use-ticket" || usedTickets.has(ticket)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    usedTickets.add(ticket);
    appWs.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.on("message", (data, binary) => ws.send(data, { binary }));
      ws.once("close", () => Deferred.doneUnsafe(upstreamClosed, Effect.void));
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const socket of appWs.clients) socket.terminate();
      appWs.close();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }),
  );
  const appPort = yield* listen(app);
  const resolve = yield* makeDevThreadVmClientProxy({
    compute,
    authorize: (userId, threadId) =>
      Effect.gen(function* () {
        const snapshot = current;
        expect(userId).toBe("owner");
        expect(threadId).toBe(target.identity.scope.threadId);
        if (!allowed || snapshot.state !== "running")
          return yield* new ThreadVmConnectionUnavailable();
        yield* Deferred.succeed(firstCheck, undefined);
        return snapshot;
      }),
    inspect: async (_settings, sandboxId, identity) => {
      inspections++;
      expect(sandboxId).toBe(target.sandboxId);
      expect(identity).toEqual(target.identity);
      afterInspect?.();
      return {
        origin: `http://127.0.0.1:${appPort}`,
        sandboxId,
        trafficAccessToken: Redacted.make("traffic-secret"),
      };
    },
  });
  const connected = yield* resolve({
    userId: "owner",
    threadId: target.identity.scope.threadId,
    target,
  });
  yield* Deferred.await(firstCheck);
  return {
    ...connected,
    resolve,
    paths,
    upstreamHeaders,
    upstreamClosed,
    inspections: () => inspections,
    change: (value: typeof target) => (current = value),
    revoke: () => (allowed = false),
    afterInspect: (action: () => void) => (afterInspect = action),
  };
});

describe("local VM connection configuration", () => {
  it("requires explicit local mode and refuses every tunnel configuration", () => {
    expect(localVmClientConnectionsEnabled({})).toBe(false);
    const env = {
      DEV_RELAY_LOCAL_VM_CONNECTIONS: "1",
      T3CODE_DISABLE_MANAGED_TUNNELS: "1",
      RELAY_TUNNEL_CLEANUP_MODE: "off",
    };
    expect(localVmClientConnectionsEnabled(env)).toBe(true);
    for (const changed of [
      { T3CODE_DISABLE_MANAGED_TUNNELS: "0" },
      { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
      { CLOUDFLARE_API_TOKEN: "secret" },
      { CLOUDFLARE_ACCOUNT_ID: "account" },
      { RELAY_TUNNEL_ZONE_NAME: "zone.test" },
    ]) {
      expect(() => localVmClientConnectionsEnabled({ ...env, ...changed })).toThrow(
        "Local VM client connections require",
      );
    }
  });
});
describe("private local client proxy", () => {
  it.effect(
    "preserves exact DPoP URL, Authorization, path and query while separating cookie/private headers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          expect(new URL(f.endpoint.httpBaseUrl).hostname).toBe("3773-sandbox1.localhost");
          const path = "/api/orchestration/shell?unchanged=yes";
          const url = f.endpoint.httpBaseUrl + path;
          const headers = {
            authorization: `DPoP ${credential}`,
            dpop: proof(url, "proof1"),
            cookie: "main-session=secret",
            "e2b-traffic-access-token": "spoof",
            "E2b-Sandbox-Id": "other",
            "X-E2b-Secret": "spoof",
            forwarded: "host=other",
            "x-forwarded-host": "other",
            connection: "keep-alive, x-poison",
            "x-poison": "drop",
          };
          const result = yield* request(f.endpoint.httpBaseUrl, path, headers);
          expect(result.status).toBe(200);
          expect(result.body).toBe('{"ok":true}');
          expect(f.paths).toEqual([path]);
          expect(f.upstreamHeaders[0]).toMatchObject({
            host: new URL(f.endpoint.httpBaseUrl).host,
            authorization: headers.authorization,
            dpop: headers.dpop,
            "e2b-sandbox-id": "sandbox1",
            "e2b-sandbox-port": "3773",
            "e2b-traffic-access-token": "traffic-secret",
          });
          for (const name of [
            "cookie",
            "x-e2b-secret",
            "forwarded",
            "x-forwarded-host",
            "x-poison",
          ])
            expect(f.upstreamHeaders[0]?.[name]).toBeUndefined();
          for (const name of ["set-cookie", "e2b-traffic-access-token", "x-e2b-private"])
            expect(result.headers[name]).toBeUndefined();
          expect(yield* request(f.endpoint.httpBaseUrl, path, headers)).toMatchObject({
            status: 401,
          });
          expect(
            yield* request(f.endpoint.httpBaseUrl, path, { authorization: headers.authorization }),
          ).toMatchObject({ status: 401 });
          expect(
            yield* request(f.endpoint.httpBaseUrl, path, {
              authorization: headers.authorization,
              dpop: proof("http://other.localhost/api/orchestration/shell", "wrong-url"),
            }),
          ).toMatchObject({ status: 401 });
          const tokenPath = "/oauth/token";
          expect(
            yield* request(
              f.endpoint.httpBaseUrl,
              tokenPath,
              {
                authorization: headers.authorization,
                dpop: proof(f.endpoint.httpBaseUrl + tokenPath, "token", "POST"),
                "content-type": "application/x-www-form-urlencoded",
              },
              "grant_type=urn:test",
            ),
          ).toMatchObject({ status: 200 });
        }),
      ),
  );

  it.effect("denies wrong Host, other VM origins and HTML without inspecting private ingress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const host of ["127.0.0.1", "3773-other.localhost", "3773-sandbox1.localhost"]) {
          expect(
            yield* request(f.endpoint.httpBaseUrl, "/api/auth/session", { host }),
          ).toMatchObject({ status: 403 });
        }
        expect(yield* request(f.endpoint.httpBaseUrl, "/")).toMatchObject({ status: 403 });
        expect(f.inspections()).toBe(0);
      }),
    ),
  );

  it.effect("never inspects or wakes revoked, paused, stopped or moved targets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const changes = [
          { ...target, state: "paused" as const },
          { ...target, sandboxId: "new-sandbox" },
          { ...target, credentialId: "revoked-credential" },
          {
            ...target,
            identity: { ...target.identity, scope: { ...target.identity.scope, generation: 2 } },
          },
        ];
        for (const changed of changes) {
          f.change(changed);
          expect(yield* request(f.endpoint.httpBaseUrl, "/api/auth/session")).toMatchObject({
            status: 403,
          });
        }
        f.revoke();
        expect(yield* request(f.endpoint.httpBaseUrl, "/api/auth/session")).toMatchObject({
          status: 403,
        });
        expect(f.inspections()).toBe(0);
      }),
    ),
  );

  it.effect("rechecks authority after ingress inspection before forwarding any credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.afterInspect(f.revoke);
        expect(
          yield* request(f.endpoint.httpBaseUrl, "/api/auth/session", {
            authorization: `DPoP ${credential}`,
          }),
        ).toMatchObject({ status: 403 });
        expect(f.inspections()).toBe(1);
        expect(f.paths).toEqual([]);
      }),
    ),
  );

  it.effect("reclaims two paused status entries before admitting a new thread after deletion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const targets = [1, 2, 3].map((n) => ({
          ...target,
          state: n === 3 ? ("running" as const) : ("paused" as const),
          sandboxId: `sandbox${n}`,
          identity: {
            ...target.identity,
            scope: {
              ...target.identity.scope,
              allocationId: `allocation${n}`,
              threadId: ThreadId.make(`thread${n}`),
            },
          },
        }));
        const current = new Map(targets.map((t) => [t.identity.scope.threadId, t]));
        let inspected = false;
        const resolve = yield* makeDevThreadVmClientProxy({
          compute,
          authorize: (_user, thread) =>
            Effect.gen(function* () {
              const found = current.get(thread);
              if (!found || found.state !== "running")
                return yield* new ThreadVmConnectionUnavailable();
              return found;
            }),
          inspect: async () => {
            inspected = true;
            throw new Error("must not wake or inspect paused compute");
          },
        });
        const requestFor = (t: typeof target) => ({
          userId: "owner",
          threadId: t.identity.scope.threadId,
          target: t,
        });
        const first = yield* resolve(requestFor(targets[0]!));
        const second = yield* resolve(requestFor(targets[1]!));
        current.delete(targets[0]!.identity.scope.threadId);
        const third = yield* resolve(requestFor(targets[2]!));
        expect(third.endpoint.httpBaseUrl).toContain("3773-sandbox3.localhost");
        for (const old of [first, second])
          expect(
            (yield* request(old.endpoint.httpBaseUrl, "/api/auth/session").pipe(Effect.exit))._tag,
          ).toBe("Failure");
        expect(inspected).toBe(false);
      }),
    ),
  );

  for (const operation of ["mint", "health"] as const)
    it.effect(
      `releases unused failed-${operation} listeners before the local listener cap blocks a healthy VM`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const unavailable = vi
              .spyOn(globalThis, "fetch")
              .mockResolvedValue(new Response(null, { status: 503 }));
            yield* Effect.addFinalizer(() => Effect.sync(() => unavailable.mockRestore()));
            const targets = [1, 2, 3].map((n) => ({
              ...target,
              sandboxId: `sandbox${n}`,
              identity: {
                ...target.identity,
                scope: {
                  ...target.identity.scope,
                  allocationId: `allocation${n}`,
                  threadId: ThreadId.make(`thread${n}`),
                },
              },
            }));
            const resolve = yield* makeDevThreadVmClientProxy({
              compute,
              authorize: (_user, thread) =>
                Effect.succeed(targets.find((t) => t.identity.scope.threadId === thread)!),
            });
            const requestFor = (t: typeof target) => ({
              userId: "owner",
              threadId: t.identity.scope.threadId,
              target: t,
            });
            const first = yield* resolve(requestFor(targets[0]!));
            const second = yield* resolve(requestFor(targets[1]!));
            for (const [index, entry] of [first, second].entries()) {
              const guest = targets[index]!;
              yield* (
                operation === "mint"
                  ? entry.control
                      .mintCredential(guest.sandboxId, guest.identity, "signed-proof")
                      .pipe(Effect.asVoid)
                  : entry.control.health("signed-proof").pipe(Effect.asVoid)
              ).pipe(Effect.flip);
            }
            const third = yield* resolve(requestFor(targets[2]!));
            expect(new URL(third.endpoint.httpBaseUrl).hostname).toBe("3773-sandbox3.localhost");
            for (const entry of [first, second])
              expect(
                (yield* request(entry.endpoint.httpBaseUrl, "/api/auth/session").pipe(Effect.exit))
                  ._tag,
              ).toBe("Failure");
            expect(unavailable).toHaveBeenCalledTimes(2);
          }),
        ),
    );

  it.effect(
    "keeps a successful health listener ready without treating it as an issued client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transport = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json(nativeInfo))
            .mockResolvedValueOnce(
              Response.json({ version: 1, privatePreviewHeaderBoundary: true }),
            )
            .mockResolvedValueOnce(
              Response.json({
                environmentId: target.environmentId,
                status: "online",
                checkedAt: "2099-01-01T00:00:00Z",
                proof: "signed-health",
                descriptor: {
                  environmentId: target.environmentId,
                  label: "VM",
                  platform: { os: "linux", arch: "arm64" },
                  serverVersion: "test",
                  capabilities: { repositoryIdentity: false },
                },
              }),
            )
            .mockResolvedValue(new Response(null, { status: 503 }));
          yield* Effect.addFinalizer(() => Effect.sync(() => transport.mockRestore()));
          const f = yield* fixture;
          yield* f.control.health("first-health-proof");
          expect(
            (yield* f.resolve({
              userId: "owner",
              threadId: target.identity.scope.threadId,
              target,
            })).endpoint,
          ).toEqual(f.endpoint);
          yield* f.control.health("failed-health-proof").pipe(Effect.flip);
          expect(
            (yield* request(f.endpoint.httpBaseUrl, "/api/auth/session").pipe(Effect.exit))._tag,
          ).toBe("Failure");
        }),
      ),
  );

  it.effect("preserves a previously issued listener when an independent reconnect mint fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(Response.json(nativeInfo))
          .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
          .mockResolvedValueOnce(
            Response.json({
              credential: "minted-credential",
              proof: "signed-response",
              expiresAt: "2099-01-01T00:00:00Z",
            }),
          )
          .mockResolvedValue(new Response(null, { status: 503 }));
        yield* Effect.addFinalizer(() => Effect.sync(() => transport.mockRestore()));
        const f = yield* fixture;
        yield* f.control.mintCredential(target.sandboxId, target.identity, "signed-proof");
        yield* f.control
          .mintCredential(target.sandboxId, target.identity, "another-signed-proof")
          .pipe(Effect.flip);
        yield* f.control.health("failed-health-proof").pipe(Effect.flip);
        const url = f.endpoint.httpBaseUrl + "/api/auth/session";
        expect(
          yield* request(f.endpoint.httpBaseUrl, "/api/auth/session", {
            authorization: `DPoP ${credential}`,
            dpop: proof(url, "after-reconnect-failure"),
          }),
        ).toMatchObject({ status: 200 });
        expect(
          (yield* f.resolve({ userId: "owner", threadId: target.identity.scope.threadId, target }))
            .endpoint,
        ).toEqual(f.endpoint);
      }),
    ),
  );

  it.effect("rejects a late mint on a closed listener and retries through a fresh entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(new Response(null, { status: 503 }))
          .mockResolvedValueOnce(Response.json(nativeInfo))
          .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
          .mockResolvedValueOnce(
            Response.json({
              credential: "minted-credential",
              proof: "signed-response",
              expiresAt: "2099-01-01T00:00:00Z",
            }),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => transport.mockRestore()));
        const f = yield* fixture;
        const requestFor = { userId: "owner", threadId: target.identity.scope.threadId, target };
        const late = yield* f.resolve(requestFor);
        yield* f.control
          .mintCredential(target.sandboxId, target.identity, "first-proof")
          .pipe(Effect.flip);
        const failedLate = yield* late.control
          .mintCredential(target.sandboxId, target.identity, "late-proof")
          .pipe(Effect.exit);
        expect(failedLate._tag).toBe("Failure");
        expect((yield* late.control.health("late-health-proof").pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect(transport).toHaveBeenCalledTimes(1);
        const fresh = yield* f.resolve(requestFor);
        expect(fresh.endpoint.httpBaseUrl).not.toBe(f.endpoint.httpBaseUrl);
        yield* fresh.control.mintCredential(target.sandboxId, target.identity, "retry-proof");
        const url = fresh.endpoint.httpBaseUrl + "/api/auth/session";
        expect(
          yield* request(fresh.endpoint.httpBaseUrl, "/api/auth/session", {
            authorization: `DPoP ${credential}`,
            dpop: proof(url, "fresh-entry-proof"),
          }),
        ).toMatchObject({ status: 200 });
        expect(transport).toHaveBeenCalledTimes(4);
      }),
    ),
  );

  for (const operation of ["mint", "health"] as const)
    it.effect(
      `keeps a shared listener after failed ${operation} while another initial mint can still succeed`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            let completeMint!: (response: Response) => void;
            const pending = new Promise<Response>((resolve) => {
              completeMint = resolve;
            });
            let mints = 0;
            const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
              const path = new URL(url instanceof Request ? url.url : url).pathname;
              if (path.endsWith("/capabilities"))
                return Response.json({ version: 1, privatePreviewHeaderBoundary: true });
              if (path.startsWith("/sandboxes/")) return Response.json(nativeInfo);
              if (++mints === 1) {
                Deferred.doneUnsafe(started, Effect.void);
                return pending;
              }
              return new Response(null, { status: 503 });
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => transport.mockRestore()));
            const f = yield* fixture;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => completeMint(new Response(null, { status: 503 }))),
            );
            const first = yield* f.control
              .mintCredential(target.sandboxId, target.identity, "first-proof")
              .pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            yield* (
              operation === "mint"
                ? f.control
                    .mintCredential(target.sandboxId, target.identity, "second-proof")
                    .pipe(Effect.asVoid)
                : f.control.health("failed-health-proof").pipe(Effect.asVoid)
            ).pipe(Effect.flip);
            const url = f.endpoint.httpBaseUrl + "/api/auth/session";
            expect(
              yield* request(f.endpoint.httpBaseUrl, "/api/auth/session", {
                authorization: `DPoP ${credential}`,
                dpop: proof(url, "while-first-mint-pending"),
              }),
            ).toMatchObject({ status: 200 });
            completeMint(
              Response.json({
                credential: "minted-credential",
                proof: "signed-response",
                expiresAt: "2099-01-01T00:00:00Z",
              }),
            );
            yield* Fiber.join(first);
            expect(
              (yield* f.resolve({
                userId: "owner",
                threadId: target.identity.scope.threadId,
                target,
              })).endpoint,
            ).toEqual(f.endpoint);
          }),
        ),
    );

  for (const operation of ["mint", "health"] as const)
    it.effect(
      `releases a never-issued listener after its only pending ${operation} is interrupted`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const transport = vi.spyOn(globalThis, "fetch").mockImplementation(
              (_url, options) =>
                new Promise((_resolve, reject) => {
                  Deferred.doneUnsafe(started, Effect.void);
                  options?.signal?.addEventListener(
                    "abort",
                    () => reject(new Error("cancelled fixture request")),
                    { once: true },
                  );
                }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => transport.mockRestore()));
            const f = yield* fixture;
            const mint = yield* (
              operation === "mint"
                ? f.control
                    .mintCredential(target.sandboxId, target.identity, "cancelled-proof")
                    .pipe(Effect.asVoid)
                : f.control.health("cancelled-health-proof").pipe(Effect.asVoid)
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(mint);
            expect(
              (yield* request(f.endpoint.httpBaseUrl, "/api/auth/session").pipe(Effect.exit))._tag,
            ).toBe("Failure");
          }),
        ),
    );

  it.effect(
    "bounds per-allocation listeners, reuses an exact target and closes all owned ports",
    () =>
      Effect.gen(function* () {
        const endpoints = yield* Effect.scoped(
          Effect.gen(function* () {
            const targets = [
              target,
              ...[2, 3].map((n) => ({
                ...target,
                sandboxId: `sandbox${n}`,
                identity: {
                  ...target.identity,
                  scope: {
                    ...target.identity.scope,
                    allocationId: `allocation${n}`,
                    threadId: ThreadId.make(`thread${n}`),
                  },
                },
              })),
            ];
            const resolve = yield* makeDevThreadVmClientProxy({
              compute,
              authorize: (_user, thread) =>
                Effect.succeed(targets.find((t) => t.identity.scope.threadId === thread)!),
              inspect: async () => {
                throw new Error("listener allocation must not inspect or wake compute");
              },
            });
            const requestFor = (t: typeof target) => ({
              userId: "owner",
              threadId: t.identity.scope.threadId,
              target: t,
            });
            const first = yield* resolve(requestFor(targets[0]!));
            expect((yield* resolve(requestFor(targets[0]!))).endpoint).toEqual(first.endpoint);
            const second = yield* resolve(requestFor(targets[1]!));
            yield* resolve(requestFor(targets[2]!)).pipe(Effect.flip);
            expect(new URL(second.endpoint.httpBaseUrl).hostname).not.toBe(
              new URL(first.endpoint.httpBaseUrl).hostname,
            );
            return [first.endpoint.httpBaseUrl, second.endpoint.httpBaseUrl];
          }),
        );
        for (const endpoint of endpoints) {
          const closed = yield* request(endpoint, "/api/auth/session").pipe(Effect.exit);
          expect(closed._tag).toBe("Failure");
        }
      }),
  );

  it.effect(
    "forwards normal WS tickets, subprotocol and text/binary frames, then closes on revoked placement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const origin = new URL(f.endpoint.httpBaseUrl);
          const messages = yield* Deferred.make<Array<{ text: string; binary: boolean }>>();
          const closed = yield* Deferred.make<void>();
          const socket = new NodeSocket.NodeWS.WebSocket(
            `ws://127.0.0.1:${origin.port}/ws?ticket=one-use-ticket`,
            ["t3-rpc"],
            {
              headers: {
                host: origin.host,
                origin: "http://127.0.0.1:7737",
                cookie: "main-cookie=private",
              },
            },
          );
          socket.on("error", () => {});
          yield* Effect.addFinalizer(() => Effect.sync(() => socket.terminate()));
          const received: Array<{ text: string; binary: boolean }> = [];
          socket.on("message", (data, binary) => {
            received.push({ text: data.toString(), binary });
            if (received.length === 2) Deferred.doneUnsafe(messages, Effect.succeed(received));
          });
          socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                socket.once("open", resolve);
                socket.once("error", reject);
              }),
          );
          expect(socket.protocol).toBe("t3-rpc");
          socket.send("text-frame");
          socket.send(Buffer.from("binary-frame"), { binary: true });
          expect(yield* Deferred.await(messages)).toEqual([
            { text: "text-frame", binary: false },
            { text: "binary-frame", binary: true },
          ]);
          expect(f.paths).toEqual(["/ws?ticket=one-use-ticket"]);
          expect(f.upstreamHeaders[0]?.host).toBe(origin.host);
          expect(f.upstreamHeaders[0]?.origin).toBe("http://127.0.0.1:7737");
          expect(f.upstreamHeaders[0]?.cookie).toBeUndefined();
          const rejected = new NodeSocket.NodeWS.WebSocket(
            `ws://127.0.0.1:${origin.port}/ws?ticket=one-use-ticket`,
            ["t3-rpc"],
            { headers: { host: origin.host } },
          );
          rejected.on("error", () => {});
          yield* Effect.addFinalizer(() => Effect.sync(() => rejected.terminate()));
          const rejectedStatus = yield* Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                rejected.once("unexpected-response", (_request, response) => {
                  response.resume();
                  rejected.terminate();
                  resolve(response.statusCode ?? 0);
                });
              }),
          );
          expect(rejectedStatus).toBe(502);
          f.revoke();
          yield* TestClock.adjust("5 seconds");
          yield* Deferred.await(closed);
          yield* Deferred.await(f.upstreamClosed);
        }),
      ),
  );
});
