import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, AuthDesktopIdentityRequest } from "@t3tools/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeedSome(config),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );
});

const decodeIdentityRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthDesktopIdentityRequest),
);
const makeIdentityHarness = Effect.fnUntraced(function* (
  beforeAttach: Effect.Effect<void> = Effect.void,
) {
  const requests: string[] = [];
  let failAttachment = false;
  let unavailable = false;
  let sequence = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(`${request.url} ${request.headers.authorization ?? ""}`);
      let user = null;
      if (request.url.endsWith("/desktop-identity")) {
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Unexpected body");
        const { identity } = yield* decodeIdentityRequest(
          new TextDecoder().decode(request.body.body),
        ).pipe(Effect.orDie);
        if (identity !== null) {
          yield* beforeAttach;
          user = { userId: identity.accountId, displayName: identity.accountId, imageUrl: null };
          if (failAttachment)
            return HttpClientResponse.fromWeb(request, Response.json({}, { status: 500 }));
          if (unavailable)
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  _tag: "EnvironmentInternalError",
                  code: "internal_error",
                  reason: "identity_verification_failed",
                  traceId: "test-trace",
                },
                { status: 500 },
              ),
            );
        }
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: `${user?.userId ?? "anonymous"}-${++sequence}`,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
          user,
        }),
      );
    }),
  );
  const backendConfig = yield* Ref.make(config);
  const pool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed(
      [PRIMARY_LOCAL_ENVIRONMENT_ID, "wsl:Ubuntu"].map((id) => ({
        id,
        currentConfig: Ref.get(backendConfig).pipe(Effect.asSome),
      })),
    ),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const auth = yield* DesktopLocalEnvironmentAuth.make.pipe(
    Effect.provide(pool),
    Effect.provideService(HttpClient.HttpClient, client),
  );
  return {
    auth,
    requests,
    backendConfig,
    fail: (value: boolean) => {
      failAttachment = value;
    },
    unavailable: () => {
      unavailable = true;
    },
  };
});

it.effect(
  "attaches and detaches identity on the primary and WSL, retaining verified sessions during an outage",
  () =>
    Effect.gen(function* () {
      const { auth, requests, fail } = yield* makeIdentityHarness();
      yield* auth.setAccount("alice");
      for (const backendId of [PRIMARY_LOCAL_ENVIRONMENT_ID, "wsl:Ubuntu"]) {
        const anonymous = yield* auth.getSession(backendId);
        const attached = yield* auth.attachIdentity({
          backendId,
          generation: anonymous.generation,
          token: "clerk",
        });
        assert.equal(attached?.user?.userId, "alice");
        fail(true);
        const count = requests.length;
        const same = yield* auth.attachIdentity({
          backendId,
          generation: anonymous.generation,
          token: "unavailable",
        });
        assert.equal(same?.token, attached?.token);
        assert.equal(requests.length, count);
        fail(false);
      }
      yield* auth.setAccount(null);
      for (const backendId of [PRIMARY_LOCAL_ENVIRONMENT_ID, "wsl:Ubuntu"]) {
        const anonymous = yield* auth.getSession(backendId);
        assert.isNull(anonymous.user);
        assert.isNull(anonymous.accountId);
      }
    }),
);

it.effect("signs out without waiting for verification and discards its late result", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { auth } = yield* makeIdentityHarness(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    yield* auth.setAccount("alice");
    const before = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
    const attachment = yield* auth
      .attachIdentity({
        backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
        generation: before.generation,
        token: "alice-token",
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* auth.setAccount(null);
    const detached = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
    assert.isNull(detached.user);
    assert.notEqual(detached.token, before.token);
    yield* Deferred.succeed(release, undefined);
    assert.isNull(yield* Fiber.join(attachment));
    yield* auth.setAccount("bob");
    const current = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
    assert.isNull(
      yield* auth.attachIdentity({
        backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
        generation: before.generation,
        token: "stale-alice",
      }),
    );
    assert.equal(
      (yield* auth.attachIdentity({
        backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
        generation: current.generation,
        token: "bob-token",
      }))?.user?.userId,
      "bob",
    );
  }),
);

it.effect(
  "recovers from an ambiguous replacement and reboots anonymous credentials after backend restart",
  () =>
    Effect.gen(function* () {
      const { auth, fail, backendConfig } = yield* makeIdentityHarness();
      yield* auth.setAccount("alice");
      const original = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
      fail(true);
      yield* auth
        .attachIdentity({
          backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
          generation: original.generation,
          token: "clerk",
        })
        .pipe(Effect.flip);
      const recovered = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
      assert.isNull(recovered.user);
      assert.notEqual(recovered.token, original.token);
      fail(false);
      const identified = yield* auth.attachIdentity({
        backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
        generation: recovered.generation,
        token: "clerk",
      });
      yield* Ref.update(backendConfig, (current) => ({
        ...current,
        bootstrap: { ...current.bootstrap, desktopBootstrapToken: "restarted" },
      }));
      const restarted = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
      assert.isNull(restarted.user);
      assert.notEqual(restarted.token, identified?.token);
    }),
);

it.effect(
  "keeps the anonymous credential stable when the relay explicitly rejects verification",
  () =>
    Effect.gen(function* () {
      const { auth, requests, unavailable } = yield* makeIdentityHarness();
      yield* auth.setAccount("alice");
      const original = yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
      unavailable();
      yield* auth
        .attachIdentity({
          backendId: PRIMARY_LOCAL_ENVIRONMENT_ID,
          generation: original.generation,
          token: "clerk",
        })
        .pipe(Effect.flip);
      assert.equal((yield* auth.getSession(PRIMARY_LOCAL_ENVIRONMENT_ID)).token, original.token);
      assert.equal(requests.filter((url) => url.includes("/oauth/token")).length, 1);
    }),
);
