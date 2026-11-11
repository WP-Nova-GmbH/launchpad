import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import { HttpRouter, HttpServer, HttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayRepositoryId,
  RelayOrganizationId,
} from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { workflowSourcesApi } from "./WorkflowSourcesApi.ts";
import { databaseUrl, withDatabase, createConnection } from "../workflowSources/test-fixture.ts";
import * as Store from "../workflowSources/Store.ts";
const api = HttpApi.make("RelayApi").add(RelayApi.groups.workflowSources);
const organization = { organizationId: RelayOrganizationId.make("org") };
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
  it.effect("separates admin, maintainer and read-only projections through the typed API", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        const admin = (yield* clientFor("admin")).workflowSources;
        const headers = { authorization: "Bearer owner-token" };
        const params = { repositoryId: RelayRepositoryId.make("repo") };
        const initial = yield* admin.owner({ headers, params: organization });
        expect(initial.configured).toBe(true);
        expect(initial.connections[0]).not.toHaveProperty("payload_sealed");
        const allowed = yield* admin.allow({
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
        ).toMatchObject({ code: "forbidden" });
        expect(
          yield* maintainer
            .disconnect({
              headers,
              params: organization,
              payload: { connectionId: "connection", expectedEpoch: 1 },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "forbidden" });
        yield* maintainer.withdraw({ headers, params, payload: { grantId: "grant" } });
        expect((yield* reader.health({ headers, params })).sources).toHaveLength(0);
        expect((yield* Store.connection("connection"))?.status).toBe("connected");
      }),
    ),
  );
  it.effect("keeps installation and new grants inside the configured organization", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        const admin = (yield* clientFor("admin")).workflowSources;
        const otherAdmin = (yield* clientFor("admin-2")).workflowSources;
        const outsider = (yield* clientFor("outsider")).workflowSources;
        const maintainer = (yield* clientFor("maintainer")).workflowSources;
        const headers = { authorization: "Bearer test-token" };
        const params = { repositoryId: RelayRepositoryId.make("repo") };
        expect(yield* maintainer.repository({ headers, params })).toMatchObject({
          canManage: true,
          canAllow: false,
          eligible: [],
          sources: [],
        });
        expect(yield* admin.repository({ headers, params })).toMatchObject({
          canManage: true,
          canAllow: true,
          eligible: [{ source: { organizationId: "org" } }],
        });
        expect(
          yield* outsider.owner({ headers, params: organization }).pipe(Effect.flip),
        ).toMatchObject({ code: "forbidden" });
        expect(
          yield* outsider
            .begin({
              headers,
              params: { organizationId: RelayOrganizationId.make("other-org") },
              payload: { attemptId: "outside", expectedVersion: 0, connectionId: null },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "service_configuration" });
        yield* admin.allow({
          headers,
          params,
          payload: { grantId: "grant", connectionId: "connection", previousGrantId: null },
        });
        yield* otherAdmin.withdrawOwner({
          headers,
          params: organization,
          payload: { grantId: "grant" },
        });
        expect((yield* maintainer.repository({ headers, params })).sources).toHaveLength(0);
        expect((yield* Store.connection("connection"))?.status).toBe("connected");
      }),
    ),
  );
  it.effect(
    "keeps Begin A's link identity when its refreshed owner snapshot already contains B",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const box = yield* RelaySecretBox;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const gated = RelaySecretBox.of({
            seal: box.seal,
            open: (sealed) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* box.open(sealed);
              }),
          });
          const aClient = (yield* clientFor("admin").pipe(
            Effect.provideService(RelaySecretBox, gated),
          )).workflowSources;
          const bClient = (yield* clientFor("admin")).workflowSources;
          const headers = { authorization: "Bearer owner-token" };
          const first = yield* aClient
            .begin({
              headers,
              params: organization,
              payload: { attemptId: "attempt-A", expectedVersion: 0, connectionId: null },
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const savedA = (yield* Store.attempt("org", "native-app"))!;
          const second = yield* bClient.begin({
            headers,
            params: organization,
            payload: {
              attemptId: "attempt-B",
              expectedVersion: savedA.version,
              connectionId: null,
            },
          });
          yield* Deferred.succeed(release, undefined);
          const returnedA = yield* Fiber.join(first);
          expect(returnedA.authorization).toMatchObject({
            applicationId: "native-app",
            attemptId: "attempt-A",
          });
          expect(returnedA.owner.attempt?.attemptId).toBe("attempt-B");
          expect(second.authorization?.attemptId).toBe("attempt-B");
          const pendingA = yield* box.open(savedA.pending_sealed!);
          expect(pendingA).toContain(
            new URL(returnedA.authorization!.url).searchParams.get("state"),
          );
          expect(returnedA.authorization?.url).not.toBe(second.authorization?.url);
          const resumed = yield* bClient.begin({
            headers,
            params: organization,
            payload: {
              attemptId: "attempt-B",
              expectedVersion: savedA.version,
              connectionId: null,
            },
          });
          expect(resumed.authorization).toEqual(second.authorization);
          const sql = (yield* RelayDb).$client;
          for (const status of ["exchanging", "connected", "failed"] as const) {
            yield* sql`UPDATE relay_workflow_authorizations SET status=${status} WHERE organization_id='org'`;
            expect(
              (yield* bClient.begin({
                headers,
                params: organization,
                payload: { attemptId: "attempt-B", expectedVersion: 0, connectionId: null },
              })).authorization,
            ).toBeNull();
          }
          yield* sql`UPDATE relay_workflow_authorizations SET status='pending' WHERE organization_id='org'`;
          yield* bClient.cancel({
            headers,
            params: organization,
            payload: { attemptId: "attempt-B" },
          });
          expect(
            (yield* bClient.begin({
              headers,
              params: organization,
              payload: { attemptId: "attempt-B", expectedVersion: 0, connectionId: null },
            })).authorization,
          ).toBeNull();
        }),
      ),
  );
});
