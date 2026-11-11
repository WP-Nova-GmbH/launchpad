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
  actor = "admin",
  previousGrantId: string | null = null,
) => Store.allow(repo, actor, { grantId: id, connectionId, previousGrantId }, "native-app");
describe.skipIf(!databaseUrl)("native workflow sources (PostgreSQL)", () => {
  it.effect(
    "stores organization credentials, enforces admin consent and supplies bounded reader health",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          yield* allow("grant-2", "repo-2");
          expect(c.payload_sealed).not.toContain("old-refresh");
          expect(
            yield* allow("borrowed", "repo", "connection", "maintainer").pipe(Effect.flip),
          ).toMatchObject({ code: "forbidden" });
          const listed = yield* Store.repositorySnapshot("repo", "maintainer");
          expect(listed.sources.map((s) => s.grant.grantId)).toEqual(["grant"]);
          expect(yield* Store.repositorySnapshot("repo", "reader").pipe(Effect.flip)).toMatchObject(
            { code: "forbidden" },
          );
          const health = yield* Store.repositoryHealth("repo", "reader");
          expect(health.sources[0]).not.toHaveProperty("grantId");
          expect(health.sources[0]).not.toHaveProperty("workspaceId");
          expect(yield* Store.repositoryHealth("repo", "outsider").pipe(Effect.flip)).toMatchObject(
            { code: "not_found" },
          );
          yield* Store.withdraw("maintainer", "grant", "repo");
          expect((yield* Store.repositorySnapshot("repo-2", "owner")).sources).toHaveLength(1);
          expect((yield* Store.repositorySnapshot("repo", "maintainer")).sources).toHaveLength(0);
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
        yield* allow("replacement", "repo", "connection", "admin", "grant");
        yield* Store.withdraw("maintainer", "grant", "repo");
        expect(
          (yield* Store.repositorySnapshot("repo", "maintainer")).sources[0]?.grant.grantId,
        ).toBe("replacement");
      }),
    ),
  );
  it.effect(
    "installer departure preserves organization consent; repository and organization deletion revoke it",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = (yield* RelayDb).$client;
          const first = yield* Sources.begin("org", "admin", {
            attemptId: "install",
            expectedVersion: 0,
            connectionId: null,
          });
          const connectionId = yield* Sources.callback(
            new URL(first.authorization!.url).searchParams.get("state")!,
            "code",
          );
          yield* allow("grant", "repo", connectionId);
          yield* allow("grant-2", "repo-2", connectionId);
          yield* sql`DELETE FROM relay_organization_members WHERE user_id='admin'`;
          const retained = yield* Store.repositorySnapshot("repo", "maintainer");
          expect(retained.sources[0]?.grant.grantId).toBe("grant");
          expect(retained.canAllow).toBe(false);
          expect(retained.canManage).toBe(true);
          expect((yield* Sources.owner("org", "admin-2")).withdrawableGrants).toHaveLength(2);
          expect(yield* Sources.owner("org", "admin").pipe(Effect.flip)).toMatchObject({
            code: "forbidden",
          });
          yield* sql`DELETE FROM relay_repositories WHERE repository_id='repo'`;
          expect(
            (yield* sql<Store.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id='grant'`)[0]
              ?.revoked,
          ).toBe(true);
          yield* sql`DELETE FROM relay_organizations WHERE organization_id='org'`;
          expect((yield* Store.connection(connectionId))?.status).toBe("disconnected");
          expect(
            (yield* sql<Store.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id='grant-2'`)[0]
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
          const first = yield* Sources.begin("org", "admin", {
            attemptId: "first",
            expectedVersion: 0,
            connectionId: c.connection_id,
          });
          expect(first.owner.attempt?.status).toBe("pending");
          expect(yield* Sources.callback("wrong-state", "code").pipe(Effect.flip)).toMatchObject({
            code: "conflict",
          });
          const cancelled = yield* Sources.cancel("org", "admin", "first");
          expect((yield* Store.connection(c.connection_id))?.payload_sealed).toBe(c.payload_sealed);
          const second = yield* Sources.begin("org", "admin", {
            attemptId: "second",
            expectedVersion: cancelled.version,
            connectionId: c.connection_id,
          });
          const state = new URL(second.authorization!.url).searchParams.get("state")!;
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
          const third = yield* Sources.begin("org", "admin", {
            attemptId: "third",
            expectedVersion: (yield* Sources.owner("org", "admin")).version,
            connectionId: c.connection_id,
          });
          const thirdState = new URL(third.authorization!.url).searchParams.get("state")!;
          yield* Sources.callback(thirdState, "code");
          expect(yield* Sources.callback(thirdState, "code").pipe(Effect.flip)).toMatchObject({
            code: "conflict",
          });
          expect(
            yield* Sources.disconnect("org", "admin", c.connection_id, c.authorization_epoch).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ code: "conflict" });
          expect(
            (yield* Store.repositorySnapshot("repo", "maintainer")).sources[0]?.grant.grantId,
          ).toBe("grant");
        }),
      ),
  );
  for (const app of [false, undefined]) {
    it.effect(`does not install or replace credentials for a viewer with app=${app}`, () =>
      withDatabase(
        Effect.gen(function* () {
          const wrongActor = transport((request) =>
            Response.json(
              request.url.endsWith("/oauth/token")
                ? tokenReply
                : {
                    data: {
                      ...identityReply.data,
                      viewer: { ...identityReply.data.viewer, app },
                    },
                  },
            ),
          );
          const attempt = (connectionId: string | null, attemptId: string) =>
            Effect.gen(function* () {
              const owner = yield* Sources.owner("org", "admin");
              const begun = yield* Sources.begin("org", "admin", {
                attemptId,
                expectedVersion: owner.version,
                connectionId,
              });
              return new URL(begun.authorization!.url).searchParams.get("state")!;
            });
          const rejected = yield* attempt(null, "wrong-actor");
          expect(
            yield* Sources.callback(rejected, "code").pipe(Effect.provide(wrongActor), Effect.flip),
          ).toMatchObject({ code: "invalid_input" });
          expect((yield* Sources.owner("org", "admin")).connections).toEqual([]);

          const installed = yield* Sources.callback(yield* attempt(null, "install-app"), "code");
          yield* allow("grant", "repo", installed);
          const reconnect = yield* attempt(installed, "wrong-reconnect-actor");
          expect(
            yield* Sources.callback(reconnect, "code").pipe(
              Effect.provide(wrongActor),
              Effect.flip,
            ),
          ).toMatchObject({ code: "invalid_input" });
          expect(yield* Store.connection(installed)).toMatchObject({
            status: "reconnect_required",
            payload_sealed: null,
          });
          expect((yield* Sources.owner("org", "admin")).grants[0]?.revoked).toBe(false);
        }),
      ),
    );
  }
  it.effect("a definitively rejected reconnect code preserves the current credentials", () =>
    withDatabase(
      Effect.gen(function* () {
        const c = yield* createConnection();
        yield* allow();
        const sql = (yield* RelayDb).$client;
        const evidence = { generation: "coverage", epoch: c.authorization_epoch, teams: {} };
        yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=${sql.json(evidence)} WHERE connection_id=${c.connection_id}`;
        const original = (yield* Store.connection(c.connection_id))!;
        const priorCredentials = (yield* Sources.credentials(original)).credentials;
        const begun = yield* Sources.begin("org", "admin", {
          attemptId: "rejected-code",
          expectedVersion: 0,
          connectionId: c.connection_id,
        });
        expect(
          yield* Sources.callback(
            new URL(begun.authorization!.url).searchParams.get("state")!,
            "expired-code",
          ).pipe(
            Effect.provide(
              transport(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
            ),
            Effect.flip,
          ),
        ).toMatchObject({ code: "invalid_input" });
        expect(yield* Store.connection(c.connection_id)).toEqual(original);
        expect((yield* Sources.credentials(original)).credentials).toEqual(priorCredentials);
        expect(yield* Store.attempt("org", "native-app")).toMatchObject({
          status: "failed",
          error: "invalid_input",
          exchange_lease_until: null,
        });
        expect(
          (yield* Store.repositorySnapshot("repo", "maintainer")).sources[0]?.grant.grantId,
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
          const first = yield* Sources.begin("org", "admin", {
            attemptId: "first",
            expectedVersion: 0,
            connectionId: c.connection_id,
          });
          expect(
            (yield* Sources.begin("org", "admin", {
              attemptId: "first",
              expectedVersion: 0,
              connectionId: c.connection_id,
            })).authorization?.url,
          ).toBe(first.authorization?.url);
          const next = yield* Sources.begin("org", "admin", {
            attemptId: "next",
            expectedVersion: first.owner.version,
            connectionId: c.connection_id,
          });
          expect(
            yield* Sources.begin("org", "admin", {
              attemptId: "first",
              expectedVersion: 0,
              connectionId: c.connection_id,
            }).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          yield* Sources.cancel("org", "admin", "first");
          expect((yield* Sources.owner("org", "admin")).attempt?.attemptId).toBe("next");
          expect(
            yield* Sources.callback(
              new URL(first.authorization!.url).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          yield* Sources.disconnect("org", "admin", c.connection_id, c.authorization_epoch);
          expect(
            yield* Sources.callback(
              new URL(next.authorization!.url).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          const fresh = yield* Sources.begin("org", "admin", {
            attemptId: "expired",
            expectedVersion: (yield* Sources.owner("org", "admin")).version,
            connectionId: c.connection_id,
          });
          yield* TestClock.adjust("11 minutes");
          expect(
            yield* Sources.callback(
              new URL(fresh.authorization!.url).searchParams.get("state")!,
              "code",
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          expect((yield* Sources.owner("org", "admin")).attempt?.status).toBe("failed");
          expect(
            (yield* Sources.begin("org", "admin", {
              attemptId: "expired",
              expectedVersion: 0,
              connectionId: c.connection_id,
            })).authorization,
          ).toBeNull();
          expect((yield* Store.connection(c.connection_id))?.status).toBe("disconnected");
        }),
      ),
  );
  it.effect("a grant insertion waiting behind admin removal cannot survive the removal", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* createConnection();
        const sql = (yield* RelayDb).$client;
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const deletion = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT user_id FROM relay_organization_members WHERE user_id='admin' FOR UPDATE`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
              yield* sql`DELETE FROM relay_organization_members WHERE user_id='admin'`;
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
          const c = yield* createConnection("connection", "org", true);
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
          const reconnect = yield* Sources.begin("org", "admin", {
            attemptId: "wait-refresh",
            expectedVersion: 0,
            connectionId: c.connection_id,
          });
          expect(
            yield* Sources.callback(
              new URL(reconnect.authorization!.url).searchParams.get("state")!,
              "code",
            ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip),
          ).toMatchObject({ code: "refresh_in_progress" });
          const sql = (yield* RelayDb).$client;
          yield* sql.withTransaction(Store.authority("repo", "grant", "maintainer"));
          yield* Store.withdraw("maintainer", "grant", "repo");
          yield* Sources.disconnect("org", "admin", c.connection_id, c.authorization_epoch);
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
  for (const change of ["demotion", "cancel", "disconnect"] as const) {
    it.effect(
      `fences a completed exchange after ${change} without reviving stale credentials`,
      () =>
        withDatabase(
          Effect.gen(function* () {
            const c = yield* createConnection();
            yield* allow();
            const begun = yield* Sources.begin("org", "admin", {
              attemptId: "reconnect",
              expectedVersion: 0,
              connectionId: c.connection_id,
            });
            const state = new URL(begun.authorization!.url).searchParams.get("state")!;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const http = HttpClient.make((req) =>
              Effect.gen(function* () {
                if (!req.url.endsWith("/oauth/token"))
                  return HttpClientResponse.fromWeb(req, Response.json(identityReply));
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return HttpClientResponse.fromWeb(req, Response.json(tokenReply));
              }),
            );
            const callback = yield* Sources.callback(state, "code").pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.exit,
              Effect.forkChild,
            );
            yield* Deferred.await(entered);
            expect((yield* Sources.owner("org", "admin-2")).exchangeInProgress).toBe(true);
            expect((yield* Sources.repository("repo", "maintainer")).exchangeInProgress).toBe(true);
            expect((yield* Sources.repository("repo-2", "admin-2")).exchangeInProgress).toBe(true);
            expect((yield* Sources.repository("repo-2", "owner")).exchangeInProgress).toBe(false);
            const sql = (yield* RelayDb).$client;
            expect(
              yield* sql.withTransaction(Store.authority("repo", "grant")).pipe(Effect.flip),
            ).toMatchObject({ code: "refresh_in_progress" });
            expect(yield* Sources.credentials(c, true).pipe(Effect.flip)).toMatchObject({
              code: "refresh_in_progress",
            });
            if (change === "demotion")
              yield* sql`UPDATE relay_organization_members SET role='member' WHERE user_id='admin'`;
            else if (change === "cancel") {
              const cancelled = yield* Sources.cancel("org", "admin-2", "reconnect");
              expect(cancelled.attempt?.status).toBe("cancelled");
              expect(cancelled.exchangeInProgress).toBe(true);
              expect((yield* Sources.repository("repo", "maintainer")).exchangeInProgress).toBe(
                true,
              );
            } else
              yield* Sources.disconnect("org", "admin-2", c.connection_id, c.authorization_epoch);
            yield* Deferred.succeed(release, undefined);
            expect(Exit.isFailure(yield* Fiber.join(callback))).toBe(true);
            const failed = (yield* Store.connection(c.connection_id))!;
            expect(failed.status).toBe(
              change === "disconnect" ? "disconnected" : "reconnect_required",
            );
            expect(failed.payload_sealed).toBeNull();
            expect((yield* Store.attempt("org", "native-app"))?.exchange_lease_until).toBeNull();
            expect((yield* Sources.owner("org", "admin-2")).exchangeInProgress).toBe(false);
            expect((yield* Sources.repository("repo", "maintainer")).exchangeInProgress).toBe(
              false,
            );
            const recovered = yield* Sources.begin("org", "admin-2", {
              attemptId: "recover",
              expectedVersion: (yield* Sources.owner("org", "admin-2")).version,
              connectionId: c.connection_id,
            });
            yield* Sources.callback(
              new URL(recovered.authorization!.url).searchParams.get("state")!,
              "code",
            );
            const snapshot = yield* Store.repositorySnapshot("repo", "maintainer");
            expect(snapshot.sources[0]?.grant.grantId).toBe("grant");
            expect(snapshot.exchangeInProgress).toBe(false);
            expect((yield* Store.connection(c.connection_id))?.status).toBe("connected");
          }),
        ),
    );
  }
  it.effect(
    "treats a lost exchange reply as a reconnect and rejects a changed app before issuing consent",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          const begun = yield* Sources.begin("org", "admin", {
            attemptId: "reconnect",
            expectedVersion: 0,
            connectionId: c.connection_id,
          });
          const state = new URL(begun.authorization!.url).searchParams.get("state")!;
          expect(
            yield* Sources.callback(state, "code").pipe(
              Effect.provide(transport(() => new Response("lost reply", { status: 503 }))),
              Effect.flip,
            ),
          ).toMatchObject({ code: "unavailable" });
          expect((yield* Store.connection(c.connection_id))?.status).toBe("reconnect_required");
          expect((yield* Store.connection(c.connection_id))?.payload_sealed).toBeNull();
          const changedApp = {
            ...config,
            linearWorkflow: { organizationId: "org", clientId: "different-app" },
          };
          expect(
            yield* Sources.begin("org", "admin", {
              attemptId: "wrong-app",
              expectedVersion: 0,
              connectionId: null,
            }).pipe(Effect.provideService(RelayConfiguration, changedApp), Effect.flip),
          ).toMatchObject({ code: "service_configuration" });
          expect((yield* Store.attempt("org", "native-app"))?.attempt_id).toBe("reconnect");
        }),
      ),
  );
  it.effect(
    "service credential failure preserves consent and operator repair refreshes without reauthorization",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection("connection", "org");
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
          expect((yield* Store.repositorySnapshot("repo", "maintainer")).sources).toHaveLength(1);
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
  it.effect("binds metadata pages to the grant and current authorization epoch", () =>
    withDatabase(
      Effect.gen(function* () {
        const first = yield* createConnection();
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
          yield* allow();
          const { linearWorkflow: _, ...withoutNative } = config;
          yield* Effect.gen(function* () {
            expect((yield* Sources.owner("org", "admin")).configured).toBe(false);
            expect((yield* Store.repositoryHealth("repo", "reader")).sources).toMatchObject([
              { health: { code: "service_configuration" }, delivery: "unverified" },
            ]);
            expect(
              (yield* Store.repositorySnapshot("repo", "maintainer")).sources[0]?.source.health
                .code,
            ).toBe("service_configuration");
            expect(
              yield* Sources.begin("org", "admin", {
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
        const c = yield* createConnection("connection", "org", true);
        const unavailable = transport(() => new Response("lost reply", { status: 503 }));
        const failRefresh = () =>
          Sources.credentials(c, true).pipe(Effect.provide(unavailable), Effect.flip);
        expect(yield* failRefresh()).toMatchObject({ code: "unavailable" });
        yield* TestClock.adjust("5 seconds");
        yield* Sources.credentials((yield* Store.connection(c.connection_id))!);
        expect((yield* Store.connection(c.connection_id))?.refresh_started_at).toBeNull();
        expect(yield* failRefresh()).toMatchObject({ code: "unavailable" });
        const original = (yield* Store.connection(c.connection_id))!;
        yield* TestClock.adjust("5 seconds");
        expect(yield* failRefresh()).toMatchObject({ code: "unavailable" });
        expect((yield* Store.connection(c.connection_id))?.refresh_started_at).toBe(
          original.refresh_started_at,
        );
        yield* TestClock.adjust("30 minutes");
        expect(yield* Sources.credentials(original, true).pipe(Effect.flip)).toMatchObject({
          code: "reconnect_required",
        });
        expect((yield* Store.connection(c.connection_id))?.status).toBe("reconnect_required");
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
  for (const outcome of ["unavailable", "healthy", "reconnect_required"] as const) {
    it.effect(`preserves a refresh-client fault against a late ${outcome} read`, () =>
      withDatabase(
        Effect.gen(function* () {
          const initial = yield* createConnection();
          yield* allow();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let reads = 0;
          const http = HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.url.endsWith("/oauth/token"))
                return HttpClientResponse.fromWeb(request, Response.json(tokenReply));
              reads++;
              if (outcome === "reconnect_required" && reads === 1)
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }));
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return HttpClientResponse.fromWeb(
                request,
                outcome === "healthy"
                  ? Response.json(identityReply)
                  : Response.json({}, { status: outcome === "unavailable" ? 503 : 401 }),
              );
            }),
          );
          const reader = yield* (
            outcome === "healthy"
              ? Sources.refresh(initial)
              : Sources.metadata("repo", "maintainer", { grantId: "grant", kind: "teams" })
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Deferred.await(entered);
          const current = (yield* Store.connection(initial.connection_id))!;
          const brokenClient = transport(() =>
            Response.json({ error: "invalid_client" }, { status: 401 }),
          );
          expect(
            yield* Sources.credentials(current, true).pipe(
              Effect.provide(brokenClient),
              Effect.flip,
            ),
          ).toMatchObject({ code: "service_configuration" });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(reader);
          const failed = (yield* Store.connection(current.connection_id))!;
          expect(failed).toMatchObject({
            status: "connected",
            authorization_epoch: current.authorization_epoch,
            credential_version: current.credential_version,
            activated_at: current.activated_at,
            payload_sealed: current.payload_sealed,
            lease_id: null,
            lease_until: null,
            health: { code: "service_configuration" },
          });
          if (outcome === "unavailable") yield* TestClock.adjust("5 seconds");
          let tokenCalls = 0;
          expect(
            yield* Sources.refresh((yield* Store.connection(current.connection_id))!).pipe(
              Effect.provide(
                transport(() => {
                  tokenCalls++;
                  return Response.json({ error: "invalid_client" }, { status: 401 });
                }),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "service_configuration" });
          expect(tokenCalls).toBe(1);
          yield* Sources.refresh((yield* Store.connection(current.connection_id))!);
          const recovered = (yield* Store.connection(current.connection_id))!;
          expect(recovered.health.code).toBe("healthy");
          expect(recovered.authorization_epoch).toBe(current.authorization_epoch);
          expect(recovered.activated_at).toBe(current.activated_at);
          expect((yield* Store.repositorySnapshot("repo", "maintainer")).sources).toHaveLength(1);
        }),
      ),
    );
  }
  it.effect(
    "retains a service fault and retry deadline while releasing the failed refresh lease",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          yield* Sources.credentials(c, true).pipe(
            Effect.provide(
              transport(() => Response.json({ error: "invalid_client" }, { status: 401 })),
            ),
            Effect.ignore,
          );
          expect(
            yield* Sources.credentials((yield* Store.connection(c.connection_id))!).pipe(
              Effect.provide(
                transport(() =>
                  Response.json({}, { status: 429, headers: { "retry-after": "4" } }),
                ),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "rate_limited" });
          const failed = (yield* Store.connection(c.connection_id))!;
          expect(failed.health).toEqual({
            code: "service_configuration",
            retryAt: (yield* Store.now) + 4000,
          });
          expect(failed.lease_id).toBeNull();
          expect(failed.refresh_started_at).toBeNull();
          let calls = 0;
          yield* Sources.credentials(failed).pipe(
            Effect.provide(
              transport(() => {
                calls++;
                return Response.json(tokenReply);
              }),
            ),
            Effect.ignore,
          );
          yield* Sources.credentials(c, true).pipe(
            Effect.provide(
              transport(() => {
                calls++;
                return Response.json(tokenReply);
              }),
            ),
            Effect.ignore,
          );
          expect(calls).toBe(0);
          yield* TestClock.adjust("4 seconds");
          yield* Sources.refresh((yield* Store.connection(c.connection_id))!);
          expect((yield* Store.connection(c.connection_id))?.health).toEqual(Store.healthy);
          expect((yield* Store.connection(c.connection_id))?.authorization_epoch).toBe(
            c.authorization_epoch,
          );
          expect((yield* Store.repositorySnapshot("repo", "maintainer")).sources).toHaveLength(1);
        }),
      ),
  );
  it.effect("keeps a newer retry deadline when an in-flight token exchange succeeds", () =>
    withDatabase(
      Effect.gen(function* () {
        const c = yield* createConnection();
        yield* allow();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(request, Response.json(tokenReply));
          }),
        );
        const refresh = yield* Sources.credentials(c, true).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        yield* Sources.metadata("repo", "maintainer", { grantId: "grant", kind: "teams" }).pipe(
          Effect.provide(
            transport(() => Response.json({}, { status: 429, headers: { "retry-after": "10" } })),
          ),
          Effect.ignore,
        );
        const retryAt = (yield* Store.connection(c.connection_id))!.health.retryAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refresh);
        const updated = (yield* Store.connection(c.connection_id))!;
        expect(updated.credential_version).toBe(c.credential_version + 1);
        expect(updated.health).toEqual({ code: "rate_limited", retryAt });
        let calls = 0;
        yield* Sources.credentials(updated, true).pipe(
          Effect.provide(
            transport(() => {
              calls++;
              return Response.json(tokenReply);
            }),
          ),
          Effect.ignore,
        );
        expect(calls).toBe(0);
        yield* TestClock.adjust("10 seconds");
        yield* Sources.refresh((yield* Store.connection(c.connection_id))!);
        expect((yield* Store.connection(c.connection_id))?.health).toEqual(Store.healthy);
      }),
    ),
  );
  it.effect(
    "ignores old-generation read failures and lets a current refresh confirm grant loss",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const c = yield* createConnection();
          yield* allow();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const http = HttpClient.make((request) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }));
            }),
          );
          const reader = yield* Sources.metadata("repo", "maintainer", {
            grantId: "grant",
            kind: "teams",
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Deferred.await(entered);
          yield* Sources.credentials(c, true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(reader);
          const rotated = (yield* Store.connection(c.connection_id))!;
          expect(rotated.health).toEqual(Store.healthy);
          expect(rotated.credential_version).toBe(c.credential_version + 1);
          yield* Sources.credentials(rotated, true).pipe(
            Effect.provide(
              transport(() => Response.json({ error: "invalid_client" }, { status: 401 })),
            ),
            Effect.ignore,
          );
          expect(
            yield* Sources.credentials((yield* Store.connection(c.connection_id))!).pipe(
              Effect.provide(
                transport(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "reconnect_required" });
          const lost = (yield* Store.connection(c.connection_id))!;
          expect(lost.status).toBe("reconnect_required");
          expect(lost.authorization_epoch).toBe(c.authorization_epoch + 1);
          expect(lost.lease_id).toBeNull();
        }),
      ),
  );
  it.effect(
    "preserves the original ambiguous-refresh window when a stale caller records a known fault",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const original = yield* createConnection();
          yield* Sources.credentials(original, true).pipe(
            Effect.provide(transport(() => Response.json({}, { status: 503 }))),
            Effect.ignore,
          );
          const started = (yield* Store.connection(original.connection_id))!.refresh_started_at;
          yield* TestClock.adjust("5 seconds");
          yield* Sources.credentials(original, true).pipe(
            Effect.provide(
              transport(() => Response.json({ error: "invalid_client" }, { status: 401 })),
            ),
            Effect.ignore,
          );
          const faulted = (yield* Store.connection(original.connection_id))!;
          expect(faulted.health.code).toBe("service_configuration");
          expect(faulted.refresh_started_at).toBe(started);
          yield* TestClock.adjust("30 minutes");
          let calls = 0;
          expect(
            yield* Sources.credentials(original, true).pipe(
              Effect.provide(
                transport(() => {
                  calls++;
                  return Response.json(tokenReply);
                }),
              ),
              Effect.flip,
            ),
          ).toMatchObject({ code: "reconnect_required" });
          expect(calls).toBe(0);
          expect((yield* Store.connection(original.connection_id))?.status).toBe(
            "reconnect_required",
          );
        }),
      ),
  );
});
