import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import * as Store from "./Store.ts";
import * as Sources from "./Sources.ts";
import {
  databaseUrl,
  withDatabase,
  createConnection,
  config,
  transport,
  tokenReply,
  identityReply,
} from "./test-fixture.ts";

const allow = (
  id = "grant",
  repo = "repo",
  connectionId = "connection",
  owner = "owner",
  previousGrantId: string | null = null,
) => Store.allow(repo, owner, { grantId: id, connectionId, previousGrantId }, "native-app");
describe.skipIf(!databaseUrl)("native workflow sources (PostgreSQL)", () => {
  it.effect(
    "migrates separate native credentials, enforces owner consent and supplies bounded reader health",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          yield* allow("grant-2", "repo-2");
          expect(c.payload_sealed).not.toContain("old-refresh");
          expect(
            yield* allow("borrowed", "repo", "connection", "maintainer").pipe(Effect.flip),
          ).toMatchObject({ code: "not_found" });
          const listed = yield* Store.repositorySnapshot("repo", "maintainer", "native-app");
          expect(listed.sources.map((s) => s.grant.grantId)).toEqual(["grant"]);
          expect(
            yield* Store.repositorySnapshot("repo", "reader", "native-app").pipe(Effect.flip),
          ).toMatchObject({ code: "forbidden" });
          const health = yield* Store.repositoryHealth("repo", "reader");
          expect(health.sources[0]).not.toHaveProperty("grantId");
          expect(health.sources[0]).not.toHaveProperty("workspaceId");
          expect(yield* Store.repositoryHealth("repo", "outsider").pipe(Effect.flip)).toMatchObject(
            { code: "not_found" },
          );
          yield* Store.withdraw("maintainer", "grant", "repo");
          expect(
            (yield* Store.repositorySnapshot("repo-2", "owner", "native-app")).sources,
          ).toHaveLength(1);
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources,
          ).toHaveLength(0);
        }),
      ),
  );
  it.effect("never resurrects withdrawn consent through old Allow/Withdraw retries", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        yield* allow();
        expect(yield* allow("loser").pipe(Effect.flip)).toMatchObject({ code: "conflict" });
        yield* Store.withdraw("maintainer", "grant", "repo");
        expect((yield* allow()).revoked).toBe(true);
        expect(yield* allow("loser").pipe(Effect.flip)).toMatchObject({ code: "conflict" });
        yield* allow("replacement", "repo", "connection", "owner", "grant");
        yield* Store.withdraw("maintainer", "grant", "repo");
        expect(
          (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources[0]?.grant
            .grantId,
        ).toBe("replacement");
      }),
    ),
  );
  it.effect(
    "membership removal/re-add, reassignment and repository/organization deletion revoke at commit",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = (yield* RelayDb).$client;
          yield* createConnection();
          yield* allow();
          yield* allow("grant-2", "repo-2");
          yield* sql`DELETE FROM relay_organization_members WHERE user_id='owner'`;
          yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role) VALUES ('org','owner','member')`;
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources,
          ).toHaveLength(0);
          yield* allow("again", "repo", "connection", "owner", "grant");
          yield* sql`UPDATE relay_organization_members SET organization_id='other-org' WHERE user_id='owner'`;
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources,
          ).toHaveLength(0);
          yield* sql`UPDATE relay_organization_members SET organization_id='org' WHERE user_id='owner'`;
          yield* allow("repository-delete", "repo", "connection", "owner", "again");
          yield* sql`DELETE FROM relay_repositories WHERE repository_id='repo'`;
          expect(
            (yield* sql<Store.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id='repository-delete'`)[0]
              ?.revoked,
          ).toBe(true);
          yield* allow("org-delete", "repo-2", "connection", "owner", "grant-2");
          yield* sql`DELETE FROM relay_organizations WHERE organization_id='org'`;
          expect(
            (yield* sql<Store.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id='org-delete'`)[0]
              ?.revoked,
          ).toBe(true);
        }),
      ),
  );
  it.effect(
    "cancel/failure/workspace mismatch preserve existing authorization and stale disconnect cannot erase reconnect",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          const first = yield* Sources.begin("owner", {
            attemptId: "first",
            expectedVersion: 0,
            connectionId: c.connection_id,
          });
          expect(first.owner.attempt?.status).toBe("pending");
          expect(yield* Sources.callback("wrong-state", "code").pipe(Effect.flip)).toMatchObject({
            code: "conflict",
          });
          const cancelled = yield* Sources.cancel("owner", "first");
          expect((yield* Store.connection(c.connection_id))?.payload_sealed).toBe(c.payload_sealed);
          const second = yield* Sources.begin("owner", {
            attemptId: "second",
            expectedVersion: cancelled.version,
            connectionId: c.connection_id,
          });
          const state = new URL(second.authorizationUrl!).searchParams.get("state")!;
          expect(
            yield* Sources.callback(state, "code").pipe(
              Effect.provide(
                transport((req) =>
                  Response.json(
                    req.url.endsWith("/oauth/token")
                      ? tokenReply
                      : {
                          data: {
                            ...identityReply.data,
                            organization: { id: "different", name: "Other" },
                          },
                        },
                  ),
                ),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "workspace_mismatch" });
          expect((yield* Store.connection(c.connection_id))?.payload_sealed).toBe(c.payload_sealed);
          const third = yield* Sources.begin("owner", {
            attemptId: "third",
            expectedVersion: (yield* Sources.owner("owner")).version,
            connectionId: c.connection_id,
          });
          const thirdState = new URL(third.authorizationUrl!).searchParams.get("state")!;
          yield* Sources.callback(thirdState, "code");
          expect(yield* Sources.callback(thirdState, "code").pipe(Effect.flip)).toMatchObject({
            code: "conflict",
          });
          expect(
            yield* Sources.disconnect("owner", c.connection_id, c.authorization_epoch).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ code: "conflict" });
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources[0]?.grant
              .grantId,
          ).toBe("grant");
        }),
      ),
  );
  it.effect(
    "retries Begin idempotently, fences superseded callbacks, and expires pending consent",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          const first = yield* Sources.begin("owner", {
            attemptId: "first",
            expectedVersion: 0,
            connectionId: null,
          });
          expect(
            (yield* Sources.begin("owner", {
              attemptId: "first",
              expectedVersion: 0,
              connectionId: null,
            })).authorizationUrl,
          ).toBe(first.authorizationUrl);
          const next = yield* Sources.begin("owner", {
            attemptId: "next",
            expectedVersion: first.owner.version,
            connectionId: null,
          });
          expect(
            yield* Sources.begin("owner", {
              attemptId: "first",
              expectedVersion: 0,
              connectionId: null,
            }).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          yield* Sources.cancel("owner", "first");
          expect((yield* Sources.owner("owner")).attempt?.attemptId).toBe("next");
          expect(
            yield* Sources.callback(
              new URL(first.authorizationUrl!).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          yield* Sources.disconnect("owner", c.connection_id, c.authorization_epoch);
          expect(
            yield* Sources.callback(
              new URL(next.authorizationUrl!).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          const fresh = yield* Sources.begin("owner", {
            attemptId: "expired",
            expectedVersion: (yield* Sources.owner("owner")).version,
            connectionId: null,
          });
          yield* TestClock.adjust("11 minutes");
          expect(
            yield* Sources.callback(
              new URL(fresh.authorizationUrl!).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          expect((yield* Sources.owner("owner")).attempt?.status).toBe("failed");
          expect((yield* Store.connection(c.connection_id))?.status).toBe("disconnected");
        }),
      ),
  );
  it.effect("a grant insertion waiting behind member removal cannot survive the removal", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        const sql = (yield* RelayDb).$client;
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const deletion = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT user_id FROM relay_organization_members WHERE user_id='owner' FOR UPDATE`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
              yield* sql`DELETE FROM relay_organization_members WHERE user_id='owner'`;
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const insertion = yield* allow().pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(deletion);
        const result = yield* Fiber.join(insertion);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* sql`SELECT * FROM relay_workflow_repository_grants`).toHaveLength(0);
      }),
    ),
  );
  it.effect(
    "stalled refresh permits authority/withdrawal/disconnect; one lease wins and late credentials cannot restore it",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection("connection", "owner", true);
          yield* allow();
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let calls = 0;
          const http = HttpClient.make((req) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return HttpClientResponse.fromWeb(req, Response.json(tokenReply));
            }),
          );
          const fiber = yield* Sources.credentials(c).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.exit,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          expect(
            yield* Sources.credentials(c).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.flip,
            ),
          ).toMatchObject({ code: "refresh_in_progress" });
          const sql = (yield* RelayDb).$client;
          yield* sql.withTransaction(Store.authority("repo", "grant", "maintainer"));
          yield* Store.withdraw("maintainer", "grant", "repo");
          yield* Sources.disconnect("owner", c.connection_id, c.authorization_epoch);
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(fiber);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.squash(result.cause)).toMatchObject({ code: "conflict" });
          expect(calls).toBe(1);
          expect((yield* Store.connection(c.connection_id))?.payload_sealed).toBeNull();
        }),
      ),
  );
  it.effect(
    "service credential failure preserves consent and operator repair refreshes without reauthorization",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection("connection", "owner");
          yield* allow();
          expect(
            yield* Sources.credentials(c, true).pipe(
              Effect.provide(
                transport(() => Response.json({ error: "invalid_client" }, { status: 401 })),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "service_configuration" });
          const failed = (yield* Store.connection(c.connection_id))!;
          expect(failed.status).toBe("connected");
          expect(failed.authorization_epoch).toBe(c.authorization_epoch);
          expect(failed.payload_sealed).toBe(c.payload_sealed);
          expect(failed.refresh_started_at).toBeNull();
          yield* Sources.refresh(failed);
          const fixed = (yield* Store.connection(c.connection_id))!;
          expect(fixed.health.code).toBe("healthy");
          expect(fixed.authorization_epoch).toBe(c.authorization_epoch);
          expect(fixed.activated_at).toBe(c.activated_at);
          const box = yield* RelaySecretBox;
          expect(yield* box.open(fixed.payload_sealed!)).toContain("new-refresh");
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer", "native-app")).sources,
          ).toHaveLength(1);
          expect(
            yield* Sources.credentials(fixed, true).pipe(
              Effect.provide(
                transport(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "reconnect_required" });
          expect((yield* Store.connection(c.connection_id))?.status).toBe("reconnect_required");
        }),
      ),
  );
  it.effect(
    "keeps independent owners' credentials separate and binds metadata pages to grant and epoch",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const first = yield* createConnection();
          const second = yield* createConnection("second", "maintainer");
          yield* allow();
          const pageHttp = transport(() =>
            Response.json({
              data: {
                organization: { id: "workspace" },
                page: {
                  nodes: [{ id: "team", name: "Team", archivedAt: null }],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            }),
          );
          const page = yield* Sources.metadata("repo", "maintainer", {
            grantId: "grant",
            kind: "teams",
          }).pipe(Effect.provide(pageHttp));
          expect(page.items).toEqual([{ id: "team", name: "Team" }]);
          expect(page.nextCursor).toBeTruthy();
          yield* Sources.credentials(first, true);
          expect((yield* Store.connection(second.connection_id))?.payload_sealed).toBe(
            second.payload_sealed,
          );
          yield* Sources.metadata("repo", "maintainer", {
            grantId: "grant",
            kind: "teams",
            cursor: page.nextCursor!,
          }).pipe(Effect.provide(pageHttp));
          expect(
            yield* Sources.metadata("repo", "maintainer", {
              grantId: "grant",
              kind: "labels",
              teamId: "team",
              cursor: page.nextCursor!,
            }).pipe(Effect.provide(pageHttp), Effect.flip),
          ).toMatchObject({ code: "invalid_input" });
          yield* Store.withdraw("maintainer", "grant", "repo");
          expect(
            yield* Sources.metadata("repo", "maintainer", {
              grantId: "grant",
              kind: "teams",
              cursor: page.nextCursor!,
            }).pipe(Effect.provide(pageHttp), Effect.flip),
          ).toMatchObject({ code: "forbidden" });
        }),
      ),
  );
  it.effect(
    "missing native configuration leaves setup unavailable and preserves manual/source records",
    () =>
      withDatabase(
        Effect.gen(function* () {
          yield* createConnection();
          const { linearWorkflow: _, ...withoutNative } = config;
          yield* Effect.gen(function* () {
            expect((yield* Sources.owner("owner")).configured).toBe(false);
            expect(
              yield* Sources.begin("owner", {
                attemptId: "blocked",
                expectedVersion: 0,
                connectionId: null,
              }).pipe(Effect.flip),
            ).toMatchObject({ code: "not_configured" });
            expect((yield* Store.connection("connection"))?.status).toBe("connected");
          }).pipe(Effect.provideService(RelayConfiguration, withoutNative));
        }),
      ),
  );
  it.effect("recovers a lost refresh reply only within the original rotation window", () =>
    withDatabase(
      Effect.gen(function* () {
        const within = yield* createConnection("within", "owner", true);
        const beyond = yield* createConnection("beyond", "maintainer", true);
        const unavailable = transport(() => new Response("lost reply", { status: 503 }));
        for (const c of [within, beyond])
          expect(
            yield* Sources.credentials(c).pipe(Effect.provide(unavailable), Effect.flip),
          ).toMatchObject({ code: "unavailable" });
        const original = (yield* Store.connection("beyond"))!;
        yield* TestClock.adjust("5 seconds");
        yield* Sources.credentials((yield* Store.connection("within"))!);
        expect((yield* Store.connection("within"))?.refresh_started_at).toBeNull();
        expect(
          yield* Sources.credentials(original).pipe(Effect.provide(unavailable), Effect.flip),
        ).toMatchObject({ code: "unavailable" });
        expect((yield* Store.connection("beyond"))?.refresh_started_at).toBe(
          original.refresh_started_at,
        );
        yield* TestClock.adjust("30 minutes");
        expect(
          yield* Sources.credentials((yield* Store.connection("beyond"))!).pipe(Effect.flip),
        ).toMatchObject({ code: "reconnect_required" });
        expect((yield* Store.connection("beyond"))?.status).toBe("reconnect_required");
      }),
    ),
  );
  it.effect("discards metadata returned after its repository consent was withdrawn", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        yield* allow();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: {
                  organization: { id: "workspace" },
                  page: {
                    nodes: [{ id: "team", name: "Team", archivedAt: null }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }),
            );
          }),
        );
        const read = yield* Sources.metadata("repo", "maintainer", {
          grantId: "grant",
          kind: "teams",
        }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.exit, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Store.withdraw("maintainer", "grant", "repo");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(read);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ code: "forbidden" });
      }),
    ),
  );
});
