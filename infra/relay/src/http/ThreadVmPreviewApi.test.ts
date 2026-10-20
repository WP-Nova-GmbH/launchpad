import * as NodeCrypto from "node:crypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { describe, expect, layer } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, RelayThreadVmPreviewPort } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { RelayDb } from "../db.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { makeThreadVmPreviewStore } from "../threads/ThreadVmPreviewStore.ts";
import { authorizeThreadVmConnection } from "../threads/ThreadVmConnectionAccess.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { openThreadVmPreview, previewSecretHash, previewOrigin } from "./ThreadVmPreviewApi.ts";
import {
  previewGrantMatches,
  previewRequestHeaders,
  PREVIEW_COOKIE,
  makeThreadVmPreviewRoutes,
  ThreadVmPreviewWebSocket,
} from "./ThreadVmPreviewProxy.ts";

import { makeRelayCors } from "./Api.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  const userId = f.input.actorUserId,
    allocationId = f.input.allocationId;
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${userId},'admin','now','now')`;
  yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,installed_at)
    VALUES(${allocationId},${allocationId},${NodeCrypto.randomBytes(32).toString("hex")},clock_timestamp()+interval '1 hour',${f.sourceEnvironmentId},'test-key','sealed',${f.credentialId},clock_timestamp())`;
  const db = yield* PgDrizzle.makeWithDefaults();
  const settings = {
    compute: {
      apiUrl: "http://e2b.test",
      sandboxUrl: "http://ingress.test",
      apiKey: Redacted.make("management-secret"),
      templateId: "template:build-verified",
      hostAddresses: ["192.0.2.1"],
      timeoutMs: 60_000,
    },
    templateBuildId: "verified",
    hostId: f.hostId,
    maxRunningVms: 3,
    publicRelayUrl: "https://relay.test",
    autoPauseEnabled: false,
    autoBackupEnabled: false,
    autoDeleteEnabled: false,
    replacementEnabled: false,
    restoreEnabled: false,
    resetEnabled: false,
    previewBaseUrl: "https://previews.example.test",
  };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(RelayClientPrincipal, { userId, token: "test-token" }),
      Effect.provideService(ThreadVmRuntimeConfiguration, { settings }),
    );
  return {
    ...f,
    userId,
    allocationId,
    provide,
    settings,
    previews: makeThreadVmPreviewStore(f.sql),
    thread: ThreadId.make(f.threadId),
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "private preview admission (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "exchanges a one-use link without retaining any bootstrap/session or compute secret",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                link = yield* f.provide(openThreadVmPreview(f.thread, 4080));
              const url = new URL(link.url),
                id = url.hostname.split(".")[0]!,
                token = url.hash.slice(1);
              expect(url.origin).toBe(previewOrigin(f.settings.previewBaseUrl, id));
              expect(url.pathname).toBe("/__launchpad_preview/");
              const ticketSha = yield* previewSecretHash(token),
                grant = yield* f.previews.ticket(id, ticketSha);
              expect(grant).toMatchObject({
                port: 4080,
                allocationId: f.allocationId,
                generation: 1,
                userId: f.userId,
              });
              const sessionSha = yield* previewSecretHash("new-session-secret");
              const results = yield* Effect.all(
                [
                  f.previews.claim(id, ticketSha, sessionSha),
                  f.previews.claim(id, ticketSha, sessionSha),
                ].map(Effect.result),
                { concurrency: 2 },
              );
              expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
              expect((yield* Effect.result(f.previews.ticket(id, ticketSha)))._tag).toBe("Failure");
              expect(yield* f.previews.session(id, sessionSha)).toEqual(grant);
              const [stored] =
                yield* f.sql`SELECT * FROM relay_thread_vm_previews WHERE preview_id=${id}`;
              const serialized = encodeJson(stored);
              for (const secret of [token, "new-session-secret", "management-secret"])
                expect(serialized).not.toContain(secret);
              expect((yield* Effect.result(f.previews.session(id, ticketSha)))._tag).toBe(
                "Failure",
              );
            }),
          ),
      );
      it.effect(
        "denies other members and closes grants after a move, freeze, credential revocation or deletion",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                link = yield* f.provide(openThreadVmPreview(f.thread, 4080));
              const id = new URL(link.url).hostname.split(".")[0]!,
                grant = yield* f.previews.ticket(
                  id,
                  yield* previewSecretHash(new URL(link.url).hash.slice(1)),
                );
              const target = yield* f.provide(authorizeThreadVmConnection(f.userId, f.thread));
              expect(previewGrantMatches(grant, target)).toBe(true);
              expect(
                previewGrantMatches(grant, {
                  ...target,
                  identity: {
                    ...target.identity,
                    scope: { ...target.identity.scope, generation: 2 },
                  },
                }),
              ).toBe(false);
              expect(
                previewGrantMatches(grant, {
                  ...target,
                  identity: {
                    ...target.identity,
                    scope: { ...target.identity.scope, allocationId: "another-vm" },
                  },
                }),
              ).toBe(false);
              const other = yield* f
                .provide(
                  Effect.provideService(openThreadVmPreview(f.thread, 4080), RelayClientPrincipal, {
                    userId: "other-admin",
                    token: "other",
                  }),
                )
                .pipe(Effect.result);
              expect(other._tag).toBe("Failure");
              yield* f.sql`UPDATE relay_thread_placements SET operation_id='move-in-progress' WHERE thread_id=${f.threadId}`;
              expect(
                (yield* f
                  .provide(authorizeThreadVmConnection(f.userId, f.thread))
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.credentialId}`;
              expect(
                (yield* f
                  .provide(authorizeThreadVmConnection(f.userId, f.thread))
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            }),
          ),
      );
      it.effect(
        "serves a private application origin without forwarding relay credentials or exposing API routes",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                link = yield* f.provide(openThreadVmPreview(f.thread, 4080));
              const url = new URL(link.url),
                secret = url.hash.slice(1);
              const calls: { url: string; headers: Record<string, string> }[] = [];
              const client = HttpClient.make((request) =>
                Effect.sync(() => {
                  calls.push({ url: request.url, headers: request.headers });
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("private app", {
                      headers: {
                        "set-cookie": "app_session=app-cookie; Domain=example.test; Path=/",
                        location: "http://ingress.test/next",
                      },
                    }),
                  );
                }),
              );
              const inspect: typeof fetch = async (input) => {
                if (String(input) === "http://e2b.test/extensions/launchpad/v1/capabilities")
                  return Response.json({ version: 1, privatePreviewHeaderBoundary: true });
                expect(String(input)).toBe(`http://e2b.test/sandboxes/${f.computeRef}`);
                return Response.json({
                  sandboxID: f.computeRef,
                  templateID: "template",
                  state: "running",
                  envdVersion: "test",
                  envdAccessToken: "envd-secret",
                  trafficAccessToken: "traffic-secret",
                  network: { allowPublicTraffic: false },
                  lifecycle: { autoResume: false },
                  metadata: {
                    "launchpad.managed": "thread-vm-v1",
                    "launchpad.allocation_id": f.allocationId,
                    "launchpad.operation_id": f.allocationId,
                    "launchpad.thread_id": f.threadId,
                    "launchpad.generation": "1",
                  },
                });
              };
              const ctx = Context.pick(
                RelayDb,
                ThreadVmRuntimeConfiguration,
                Crypto.Crypto,
              )(
                yield* f.provide(
                  Effect.context<RelayDb | ThreadVmRuntimeConfiguration | Crypto.Crypto>(),
                ),
              );
              const router = Layer.mergeAll(
                HttpRouter.add("GET", "/v1/secret", HttpServerResponse.text("relay API")),
                makeThreadVmPreviewRoutes(inspect).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeedContext(ctx),
                      Layer.succeed(HttpClient.HttpClient, client),
                      Layer.succeed(ThreadVmPreviewWebSocket, {
                        open: () => Effect.succeed(HttpServerResponse.empty()),
                      }),
                    ),
                  ),
                ),
              );
              const { handler, dispose } = HttpRouter.toWebHandler(
                router.pipe(Layer.provide(makeRelayCors(f.settings.previewBaseUrl))),
              );
              yield* Effect.addFinalizer(() => Effect.promise(dispose));
              const request = (path: string, init?: RequestInit) =>
                Effect.promise(() => handler(new Request(url.origin + path, init)));
              expect((yield* request("/__launchpad_preview/")).status).toBe(200);
              const denied = yield* request("/v1/secret");
              expect(denied.status).toBe(403);
              expect(denied.headers.has("access-control-allow-origin")).toBe(false);
              expect(
                (yield* request("/v1/secret", {
                  method: "OPTIONS",
                  headers: { origin: url.origin },
                })).status,
              ).toBe(403);
              const relayPreflight = yield* Effect.promise(() =>
                handler(new Request("https://relay.test/v1/secret", { method: "OPTIONS" })),
              );
              expect(relayPreflight.status).toBe(204);
              expect(relayPreflight.headers.get("access-control-allow-origin")).toBe("*");
              expect(yield* Effect.promise(() => denied.text())).not.toContain("relay API");
              expect(
                (yield* request("/__launchpad_preview/connect", {
                  method: "POST",
                  body: secret,
                  headers: { origin: "https://foreign.test" },
                })).status,
              ).toBe(403);
              const connected = yield* request("/__launchpad_preview/connect", {
                method: "POST",
                body: secret,
                headers: { origin: url.origin },
              });
              expect(connected.status).toBe(204);
              const cookie = connected.headers.get("set-cookie")!;
              expect(cookie).toContain("HttpOnly");
              expect(cookie).toContain("Secure");
              expect(cookie).not.toContain("Domain=");
              expect(
                (yield* request("/__launchpad_preview/connect", {
                  method: "POST",
                  body: secret,
                  headers: { origin: url.origin },
                })).status,
              ).toBe(403);
              const authenticated = {
                cookie: cookie.split(";")[0]!,
                authorization: "Bearer caller-clerk-secret",
                dpop: "caller-dpop",
              };
              const app = yield* request("/v1/secret?app=1", { headers: authenticated });
              expect(app.status).toBe(200);
              expect(app.headers.has("access-control-allow-origin")).toBe(false);
              expect(yield* Effect.promise(() => app.text())).toBe("private app");
              expect(calls).toHaveLength(1);
              expect(calls[0]?.url).toBe("http://ingress.test/v1/secret?app=1");
              expect(calls[0]?.headers).toMatchObject({
                "e2b-sandbox-id": f.computeRef,
                "e2b-sandbox-port": "4080",
                "e2b-traffic-access-token": "traffic-secret",
              });
              expect(encodeJson(calls[0]?.headers)).not.toMatch(
                /caller-clerk-secret|caller-dpop|launchpad-vm-preview/,
              );
              expect(app.headers.get("location")).toBe(url.origin + "/next");
              expect(app.headers.get("set-cookie")).toContain("app_session=app-cookie");
              expect(app.headers.get("set-cookie")).not.toContain("Domain=");
              yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id='org' AND user_id=${f.userId}`;
              expect((yield* request("/", { headers: authenticated })).status).toBe(403);
              expect(calls).toHaveLength(1);
            }),
          ),
      );
      it.effect("rejects expired bootstrap/session access and bounds forgotten previews", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              link = yield* f.provide(openThreadVmPreview(f.thread, 4080));
            const url = new URL(link.url),
              id = url.hostname.split(".")[0]!,
              sha = yield* previewSecretHash(url.hash.slice(1));
            yield* f.sql`UPDATE relay_thread_vm_previews SET ticket_expires_at=clock_timestamp()-interval '1 second' WHERE preview_id=${id}`;
            expect((yield* Effect.result(f.previews.claim(id, sha, "b".repeat(64))))._tag).toBe(
              "Failure",
            );
            yield* f.sql`UPDATE relay_thread_vm_previews SET ticket_expires_at=clock_timestamp()+interval '1 minute' WHERE preview_id=${id}`;
            yield* f.previews.claim(id, sha, "b".repeat(64));
            yield* f.sql`UPDATE relay_thread_vm_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE preview_id=${id}`;
            expect((yield* Effect.result(f.previews.session(id, "b".repeat(64))))._tag).toBe(
              "Failure",
            );
            for (let n = 0; n < 24; n++) yield* f.provide(openThreadVmPreview(f.thread, 4080));
            expect(
              (yield* f.provide(openThreadVmPreview(f.thread, 4080)).pipe(Effect.result))._tag,
            ).toBe("Failure");
            const [count] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_vm_previews WHERE thread_id=${f.threadId}`;
            expect(count?.count).toBe(24);
          }),
        ),
      );
    });
  },
);
// These are contract and credential-boundary checks, independent of compute availability.
import { it } from "@effect/vitest";
it("allows only explicit application ports", () => {
  const decode = Schema.decodeUnknownSync(RelayThreadVmPreviewPort);
  for (const port of [80, 443, 3773, 49983, 0, 65536, 4080.5]) expect(() => decode(port)).toThrow();
  for (const port of [1024, 3000, 4080, 65535]) expect(decode(port)).toBe(port);
});
it("strips caller credentials and routing overrides while retaining application cookies", () => {
  const request = HttpServerRequest.fromWeb(
    new Request("https://preview.test/", {
      headers: {
        authorization: "Bearer clerk-secret",
        dpop: "dpop-secret",
        cookie: `${PREVIEW_COOKIE}=preview-secret; __session=clerk-secret; __clerk_db_jwt=clerk-secret; app_session=app-cookie`,
        "e2b-traffic-access-token": "caller-token",
        "E2b-Sandbox-Id": "other-vm",
        "E2b-Sandbox-Port": "3773",
        "x-forwarded-host": "relay.test",
        connection: "keep-alive, x-extra-secret",
        "x-extra-secret": "private",
        origin: "https://preview.test",
      },
    }),
  );
  const headers = previewRequestHeaders(request, "http://private-ingress.test");
  expect(headers).toEqual({
    cookie: "app_session=app-cookie",
    origin: "http://private-ingress.test",
  });
});
