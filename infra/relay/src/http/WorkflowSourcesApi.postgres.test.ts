import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import { HttpRouter, HttpServer, HttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayRepositoryId,
} from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { workflowSourcesApi } from "./WorkflowSourcesApi.ts";
import { databaseUrl, withDatabase, createConnection } from "../workflowSources/test-fixture.ts";
import * as Store from "../workflowSources/Store.ts";
const api = HttpApi.make("RelayApi").add(RelayApi.groups.workflowSources);
const clientFor = Effect.fn("workflowSources.test.client")(function* (userId: string) {
  const deps = Layer.succeedContext(
    yield* Effect.context<
      | RelayDb
      | RelayConfiguration
      | RelaySecretBox
      | UserDirectory
      | HttpClient.HttpClient
      | Crypto.Crypto
    >(),
  );
  const layer = workflowSourcesApi.pipe(
    HttpRouter.provideRequest(deps),
    Layer.provide(deps),
    Layer.provideMerge(
      Layer.succeed(RelayClientAuth, {
        clientBearer: (effect) =>
          Effect.provideService(effect, RelayClientPrincipal, { userId, token: "test" }),
      }),
    ),
    Layer.provideMerge(HttpServer.layerServices),
  );
  return yield* HttpApiTest.groups(api, ["workflowSources"]).pipe(Effect.provide(layer));
});
describe.skipIf(!databaseUrl)("workflow source HTTP authorization", () => {
  it.effect("separates owner, maintainer and read-only projections through the typed API", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        const owner = (yield* clientFor("owner")).workflowSources;
        const headers = { authorization: "Bearer owner-token" };
        const params = { repositoryId: RelayRepositoryId.make("repo") };
        const initial = yield* owner.owner({ headers });
        expect(initial.configured).toBe(true);
        expect(initial.connections[0]).not.toHaveProperty("payload_sealed");
        const allowed = yield* owner.allow({
          headers,
          params,
          payload: { connectionId: "connection", grantId: "grant", previousGrantId: null },
        });
        expect(allowed.sources).toHaveLength(1);
        expect(allowed.sources[0]?.source.delivery).toBe("unverified");
        const reader = (yield* clientFor("reader")).workflowSources;
        expect(yield* reader.repository({ headers, params }).pipe(Effect.flip)).toMatchObject({
          code: "forbidden",
        });
        const health = yield* reader.health({ headers, params });
        expect(health.sources).toHaveLength(1);
        expect(health.sources[0]).not.toHaveProperty("workspaceId");
        const maintainer = (yield* clientFor("maintainer")).workflowSources;
        expect(
          yield* maintainer
            .allow({
              headers,
              params,
              payload: { connectionId: "connection", grantId: "borrowed", previousGrantId: null },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        expect(
          yield* maintainer
            .disconnect({ headers, payload: { connectionId: "connection", expectedEpoch: 1 } })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        yield* maintainer.withdraw({ headers, params, payload: { grantId: "grant" } });
        expect((yield* reader.health({ headers, params })).sources).toHaveLength(0);
        expect((yield* Store.connection("connection"))?.status).toBe("connected");
      }),
    ),
  );
});
