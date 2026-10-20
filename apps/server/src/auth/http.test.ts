import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentAuthenticatedAuth, EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { RepositoryAccess } from "./RepositoryAccess.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const makeRoutesLayer = (clientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer) =>
  HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(authHttpApiLayer),
    Layer.provide(clientLayer),
    Layer.provide(environmentAuthenticatedAuthLayer),
    Layer.provideMerge(environmentAuthLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
const routesLayer = makeRoutesLayer();

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("verifies a paired browser profile without exposing or widening its credential", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used"),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, secretStore),
    );
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        expect(request.url).toBe("https://relay.test/v1/client/identity");
        expect(request.headers.authorization).toBe("Bearer verified-profile-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ userId: "alice", displayName: "Alice", imageUrl: null }),
          ),
        );
      }),
    );
    const layer = makeRoutesLayer(clientLayer).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_RELAY_URL: "https://relay.test" } }),
        ),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
      (api) =>
        Effect.tryPromise(async () => {
          const dev = await api.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          const devCookie =
            dev.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          const forbidden = await api.handler(
            postJson("/api/auth/browser-identity", { identity: null }, { cookie: devCookie }),
            requestContext,
          );
          expect(forbidden.status).toBe(403);
          expect(await forbidden.json()).toMatchObject({
            reason: "personal_browser_session_required",
          });
          const pairingResponse = await api.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookie },
            ),
            requestContext,
          );
          const pairing = (await pairingResponse.json()) as { credential: string };
          const paired = await api.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          const cookie = paired.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          const identityResponse = await api.handler(
            postJson(
              "/api/auth/browser-identity",
              {
                identity: { accountId: "alice", token: "verified-profile-token" },
              },
              { cookie },
            ),
            requestContext,
          );
          expect(identityResponse.status).toBe(200);
          expect(await identityResponse.json()).toEqual({
            user: { userId: "alice", displayName: "Alice", imageUrl: null },
          });
          const replacementCookie =
            identityResponse.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          expect(replacementCookie).not.toBe(cookie);
          expect(identityResponse.headers.getSetCookie()[0]).toContain("HttpOnly");
          const readSession = (value: string) =>
            api.handler(
              new Request("http://127.0.0.1/api/auth/session", { headers: { cookie: value } }),
              requestContext,
            );
          expect(await (await readSession(cookie)).json()).toMatchObject({ authenticated: false });
          expect(await (await readSession(replacementCookie)).json()).toMatchObject({
            authenticated: true,
            scopes: ["orchestration:read"],
            user: { userId: "alice" },
          });
          const mismatch = await api.handler(
            postJson(
              "/api/auth/browser-identity",
              {
                identity: { accountId: "bob", token: "verified-profile-token" },
              },
              { cookie: replacementCookie },
            ),
            requestContext,
          );
          expect(mismatch.status).toBe(500);
          expect(await mismatch.json()).toMatchObject({ reason: "identity_verification_failed" });
          expect(await (await readSession(replacementCookie)).json()).toMatchObject({
            authenticated: true,
            user: { userId: "alice" },
          });
          const cleared = await api.handler(
            postJson(
              "/api/auth/browser-identity",
              { identity: null },
              { cookie: replacementCookie },
            ),
            requestContext,
          );
          const clearedCookie = cleared.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          expect(cleared.status).toBe(200);
          const clearedSession = await (await readSession(clearedCookie)).json();
          expect(clearedSession).toMatchObject({
            authenticated: true,
            scopes: ["orchestration:read"],
          });
          expect(clearedSession).not.toHaveProperty("user");
        }),
      (api) => Effect.promise(() => api.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository revocation drains an authenticated response body before acknowledgement",
  () =>
    Effect.gen(function* () {
      const middleware = yield* EnvironmentAuthenticatedAuth;
      const personalAccess = yield* RepositoryAccess;
      const closing = yield* Deferred.make<Effect.Effect<void>>();
      const bodyStarted = yield* Deferred.make<void>();
      let unregistered = false;
      let bodyDrained = false;
      const access = RepositoryAccess.of({
        ...personalAccess,
        status: Effect.succeed({ enabled: true, ready: true, revision: 1 }),
        registerConnection: (close) =>
          Deferred.succeed(closing, close).pipe(
            Effect.as(() => {
              unregistered = true;
            }),
          ),
      });
      const response = HttpServerResponse.stream(
        Stream.fromEffect(
          Deferred.succeed(bodyStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          Stream.onExit(() =>
            Effect.sync(() => {
              bodyDrained = true;
            }),
          ),
        ),
      );
      const app = yield* HttpRouter.toHttpEffect(
        HttpRouter.add(
          "GET",
          "/protected",
          middleware(Effect.succeed(response), {
            // Match HttpApiBuilder's erased group metadata at the middleware boundary.
            group: EnvironmentHttpApi.groups.auth as unknown as HttpApiGroup.Top,
            endpoint: EnvironmentHttpApi.groups.auth.endpoints.webSocketTicket,
          }),
        ),
      );
      yield* HttpEffect.toHandled(app, (_request, result) =>
        result.body._tag === "Stream"
          ? Stream.runDrain(Stream.orDie(result.body.stream)).pipe(Effect.interruptible)
          : Effect.void,
      ).pipe(
        Effect.provideService(RepositoryAccess, access),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/protected", {
              headers: { authorization: `Bearer ${DEV_TOKEN}` },
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(bodyStarted);
      expect(unregistered).toBe(false);
      const close = yield* Deferred.await(closing);
      yield* close;
      expect(bodyDrained).toBe(true);
      expect(unregistered).toBe(true);
    }).pipe(
      Effect.provide(
        environmentAuthenticatedAuthLayer.pipe(
          Layer.provide(environmentAuthLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
