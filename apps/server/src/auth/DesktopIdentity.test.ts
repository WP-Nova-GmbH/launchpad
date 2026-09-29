import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { verifyDesktopIdentity } from "./DesktopIdentity.ts";

const identity = { accountId: "alice", token: "clerk-token" };
const provideRelay = (userId: string, status = 200) =>
  Effect.provide(
    Layer.mergeAll(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_RELAY_URL: "https://configured-relay.test" } }),
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.url).toBe("https://configured-relay.test/v1/client/identity");
          expect(request.headers.authorization).toBe("Bearer clerk-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ userId, displayName: null, imageUrl: null }, { status }),
            ),
          );
        }),
      ),
    ),
  );

it.effect("uses only the configured relay and accepts a verified identity without a profile", () =>
  Effect.gen(function* () {
    expect(yield* verifyDesktopIdentity(identity)).toEqual({
      userId: "alice",
      displayName: null,
      imageUrl: null,
    });
  }).pipe(provideRelay("alice")),
);
it.effect("rejects a token from another account", () =>
  Effect.gen(function* () {
    expect(yield* verifyDesktopIdentity(identity).pipe(Effect.flip)).toBe("account_changed");
  }).pipe(provideRelay("bob")),
);
it.effect("does not accept an identity from a failed relay response", () =>
  verifyDesktopIdentity(identity).pipe(Effect.flip, provideRelay("alice", 401)),
);
