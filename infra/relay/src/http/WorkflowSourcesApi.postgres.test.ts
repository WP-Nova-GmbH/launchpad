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
  it.effect(
    "lists hidden owner consent safely and withdraws only that exact grant through HTTP",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* createConnection();
          const sql = (yield* RelayDb).$client;
          const owner = (yield* clientFor("owner")).workflowSources;
          const maintainer = (yield* clientFor("maintainer")).workflowSources;
          const headers = { authorization: "Bearer test-token" };
          for (const repositoryId of ["repo", "repo-2"])
            yield* owner.allow({
              headers,
              params: { repositoryId: RelayRepositoryId.make(repositoryId) },
              payload: {
                connectionId: "connection",
                grantId: "grant-" + repositoryId,
                previousGrantId: null,
              },
            });
          yield* sql`DELETE FROM relay_repository_access WHERE repository_id='repo' AND user_id='owner'`;
          const hidden = yield* owner.owner({ headers });
          expect(hidden).toHaveProperty("withdrawableGrants", [
            { grantId: "grant-repo", connectionId: "connection", repositoryName: null },
            { grantId: "grant-repo-2", connectionId: "connection", repositoryName: "Second" },
          ]);
          expect(hidden.grants.map((g) => g.repositoryId)).toEqual(["repo-2"]);
          expect(hidden.repositories.map((r) => r.repositoryId)).toEqual(["repo-2"]);
          const params = { repositoryId: RelayRepositoryId.make("repo") };
          expect((yield* maintainer.repository({ headers, params })).sources).toHaveLength(1);
          const other = (yield* clientFor("outsider")).workflowSources;
          expect(yield* other.owner({ headers })).toHaveProperty("withdrawableGrants", []);
          expect(
            yield* other
              .withdrawOwner({ headers, payload: { grantId: "grant-repo" } })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "not_found" });
          yield* owner.withdrawOwner({ headers, payload: { grantId: "grant-repo" } });
          expect((yield* maintainer.repository({ headers, params })).sources).toHaveLength(0);
          expect(yield* owner.owner({ headers })).toHaveProperty("withdrawableGrants", [
            { grantId: "grant-repo-2", connectionId: "connection", repositoryName: "Second" },
          ]);
          yield* sql`INSERT INTO relay_repository_access(repository_id,user_id,organization_id,role) VALUES ('repo','owner','org','developer')`;
          expect(yield* owner.owner({ headers })).toHaveProperty("withdrawableGrants", [
            { grantId: "grant-repo-2", connectionId: "connection", repositoryName: "Second" },
          ]);
          expect(
            yield* owner
              .allow({
                headers,
                params,
                payload: {
                  connectionId: "connection",
                  grantId: "new",
                  previousGrantId: "grant-repo",
                },
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "forbidden" });
          yield* sql`UPDATE relay_repository_access SET role='developer' WHERE repository_id='repo-2' AND user_id='owner'`;
          const readOnly = yield* owner.owner({ headers });
          expect(readOnly.repositories).toHaveLength(0);
          expect(readOnly).toHaveProperty("withdrawableGrants", [
            { grantId: "grant-repo-2", connectionId: "connection", repositoryName: "Second" },
          ]);
          yield* owner.withdrawOwner({ headers, payload: { grantId: "grant-repo-2" } });
          expect(yield* owner.owner({ headers })).toHaveProperty("withdrawableGrants", []);
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
          const aClient = (yield* clientFor("owner").pipe(
            Effect.provideService(RelaySecretBox, gated),
          )).workflowSources;
          const bClient = (yield* clientFor("owner")).workflowSources;
          const headers = { authorization: "Bearer owner-token" };
          const first = yield* aClient
            .begin({
              headers,
              payload: { attemptId: "attempt-A", expectedVersion: 0, connectionId: null },
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const savedA = (yield* Store.attempt("owner", "native-app"))!;
          const second = yield* bClient.begin({
            headers,
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
            payload: {
              attemptId: "attempt-B",
              expectedVersion: savedA.version,
              connectionId: null,
            },
          });
          expect(resumed.authorization).toEqual(second.authorization);
          const sql = (yield* RelayDb).$client;
          for (const status of ["exchanging", "connected", "failed"] as const) {
            yield* sql`UPDATE relay_workflow_authorizations SET status=${status} WHERE owner_user_id='owner'`;
            expect(
              (yield* bClient.begin({
                headers,
                payload: { attemptId: "attempt-B", expectedVersion: 0, connectionId: null },
              })).authorization,
            ).toBeNull();
          }
          yield* sql`UPDATE relay_workflow_authorizations SET status='pending' WHERE owner_user_id='owner'`;
          yield* bClient.cancel({ headers, payload: { attemptId: "attempt-B" } });
          expect(
            (yield* bClient.begin({
              headers,
              payload: { attemptId: "attempt-B", expectedVersion: 0, connectionId: null },
            })).authorization,
          ).toBeNull();
        }),
      ),
  );
});
