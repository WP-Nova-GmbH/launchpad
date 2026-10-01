import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { RelayDb } from "../db.ts";
import { relayIssueTrackerConnections, relayOrganizations } from "../persistence/schema.ts";
import { ConnectionPersistenceError, make as makeStore, metadata } from "./ConnectionStore.ts";
import {
  cancelLinearReplacement,
  completeLinear,
  confirmLinearReplacement,
  disconnect,
  listConnections,
  readComments,
  readIssue,
  viewImage,
  startLinear,
} from "./Connections.ts";
import {
  encodeJson,
  fixture,
  identityResponse,
  issueInput,
  issueResponse,
  key,
  linearRow,
  membership,
  tokenResponse,
} from "./Connections.test-fixture.ts";

// Opt in with an isolated, migrated database. No default URL or live relay config.
const databaseUrl = process.env.LINEAR_REPLACEMENT_TEST_DATABASE_URL;
const databaseLayer = databaseUrl
  ? Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
    )
  : Layer.empty;
const testDatabase = Effect.serviceOption(RelayDb).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die("PostgreSQL replacement tests need their isolated database layer."),
      onSome: Effect.succeed,
    }),
  ),
);
const testStore = makeStore.pipe(Effect.provideServiceEffect(RelayDb, testDatabase));
const bodyHas = (request: HttpClientRequest.HttpClientRequest, text: string) =>
  request.body._tag === "Uint8Array" && new TextDecoder().decode(request.body.body).includes(text);
const respond = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(
    request.url.endsWith("/oauth/token")
      ? tokenResponse()
      : bodyHas(request, "LaunchpadIdentity")
        ? identityResponse("workspace-b", "Company B")
        : bodyHas(request, "LaunchpadComments")
          ? Response.json({
              data: {
                organization: { id: "workspace" },
                issue: { id: "issue-id" },
                comments: { edges: [], pageInfo: { hasNextPage: false } },
              },
            })
          : issueResponse(),
  );
const authorize = Effect.gen(function* () {
  const started = yield* startLinear({ organizationId: "org", userId: "admin" });
  return { state: new URL(started.authorizationUrl).searchParams.get("state")!, code: "code" };
});
const propose = authorize.pipe(Effect.flatMap(completeLinear));
const actor = { organizationId: "org", userId: "another-admin" };

for (const postgres of [false, true]) {
  describe.skipIf(postgres && !databaseUrl)(
    `Linear workspace replacement (${postgres ? "PostgreSQL" : "memory"})`,
    () => {
      const setup = (options: Parameters<typeof fixture>[0] = {}) =>
        Effect.gen(function* () {
          if (!postgres) return yield* fixture({ rows: [linearRow()], respond, ...options });
          const db = yield* testDatabase;
          yield* db
            .insert(relayOrganizations)
            .values({
              organizationId: "org",
              name: "Launchpad",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            })
            .onConflictDoNothing();
          yield* db
            .delete(relayIssueTrackerConnections)
            .where(eq(relayIssueTrackerConnections.organizationId, "org"));
          const rows = options.rows ?? [linearRow()];
          if (rows.length) yield* db.insert(relayIssueTrackerConnections).values([...rows]);
          const store = yield* testStore;
          return yield* fixture({ respond, ...options, store });
        });
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(Layer.mergeAll(postgres ? databaseLayer : Layer.empty, NodeCrypto.layer)),
          Effect.scoped,
        );

      it.effect("keeps A active until another admin confirms B, with safe metadata", () =>
        run(
          Effect.gen(function* () {
            const test = yield* setup();
            const original = yield* test.store.get(key);
            expect(yield* propose.pipe(test.provide)).toMatchObject({
              status: "awaiting_confirmation",
            });
            const pending = (yield* test.store.get(key))!;
            expect(pending.version).toBe(original!.version);
            expect(pending.payloadSealed).toBe(original!.payloadSealed);
            expect(pending.replacement?.workspaceId).toBe("workspace-b");
            const visible = encodeJson(metadata(pending));
            for (const secret of ["secret", "sealed:", "expectedVersion", "createdByUserId"])
              expect(visible).not.toContain(secret);
            const read = yield* readIssue(issueInput).pipe(test.provide);
            expect(read.accountLabel).toBe("Launchpad app");
            const result = yield* confirmLinearReplacement({
              ...actor,
              proposalId: pending.replacement!.id,
            }).pipe(test.provide);
            expect(result.connections[0]).toMatchObject({
              status: "connected",
              accountLabel: "Company B · Launchpad app",
            });
            expect(result.connections[0]?.replacement).toBeUndefined();
            const active = (yield* test.store.get(key))!;
            expect(active.version).not.toBe(original!.version);
            expect(active.payloadSealed).toContain("workspace-b");
            expect(
              yield* readComments({ organizationId: "org", reference: read.linear!.source }).pipe(
                test.provide,
                Effect.flip,
              ),
            ).toMatchObject({ code: "conflict" });
            expect(
              yield* confirmLinearReplacement({
                ...actor,
                proposalId: pending.replacement!.id,
              }).pipe(test.provide, Effect.flip),
            ).toMatchObject({ code: "conflict" });
          }),
        ),
      );

      it.effect.each(["cancel", "expire", "supersede"] as const)(
        "%s preserves A and invalidates the old proposal",
        (action) =>
          run(
            Effect.gen(function* () {
              const test = yield* setup();
              yield* propose.pipe(test.provide);
              const pending = (yield* test.store.get(key))!;
              const input = { ...actor, proposalId: pending.replacement!.id };
              if (action === "cancel") {
                yield* cancelLinearReplacement(input).pipe(test.provide);
                yield* cancelLinearReplacement(input).pipe(test.provide);
              } else if (action === "expire") {
                yield* TestClock.adjust("15 minutes");
                expect(
                  yield* confirmLinearReplacement(input).pipe(test.provide, Effect.flip),
                ).toMatchObject({ code: "conflict" });
                yield* listConnections("org").pipe(test.provide);
              } else {
                yield* propose.pipe(test.provide);
                expect(
                  yield* cancelLinearReplacement(input).pipe(test.provide, Effect.flip),
                ).toMatchObject({ code: "conflict" });
              }
              expect(
                yield* confirmLinearReplacement(input).pipe(test.provide, Effect.flip),
              ).toMatchObject({ code: "conflict" });
              const current = (yield* test.store.get(key))!;
              expect(current.version).toBe(pending.version);
              expect(current.payloadSealed).toBe(pending.payloadSealed);
              expect(current.replacement?.id).not.toBe(input.proposalId);
            }),
          ),
      );

      it.effect("renews the same immutable workspace immediately and keeps source references", () =>
        run(
          Effect.gen(function* () {
            const test = yield* setup({
              respond: (request) =>
                bodyHas(request, "LaunchpadIdentity")
                  ? Effect.succeed(identityResponse("workspace", "Renamed company"))
                  : respond(request),
            });
            const read = yield* readIssue(issueInput).pipe(test.provide);
            const original = (yield* test.store.get(key))!;
            expect(yield* propose.pipe(test.provide)).toMatchObject({ status: "connected" });
            const active = (yield* test.store.get(key))!;
            expect(active.version).not.toBe(original.version);
            expect(active.replacement).toBeNull();
            expect(active.payloadSealed).toContain('"generation":"workspace"');
            yield* readComments({ organizationId: "org", reference: read.linear!.source }).pipe(
              test.provide,
            );
          }),
        ),
      );

      it.effect("serves reads while OAuth HTTP is paused and exchanges a code only once", () =>
        run(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const test = yield* setup({
              respond: (request) =>
                request.url.endsWith("/oauth/token")
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as(tokenResponse()),
                    )
                  : respond(request),
            });
            const input = yield* authorize.pipe(test.provide);
            const callback = yield* completeLinear(input).pipe(test.provide, Effect.forkChild);
            yield* Deferred.await(started);
            expect(yield* completeLinear(input).pipe(test.provide, Effect.flip)).toMatchObject({
              code: "conflict",
            });
            // Joining the read before releasing OAuth proves there is no row lock held by HTTP.
            expect((yield* readIssue(issueInput).pipe(test.provide)).accountLabel).toBe(
              "Launchpad app",
            );
            expect(
              test.requests.filter((request) => request.url.endsWith("/oauth/token")),
            ).toHaveLength(1);
            yield* Deferred.succeed(release, undefined);
            expect(yield* Fiber.join(callback)).toMatchObject({ status: "awaiting_confirmation" });
          }),
        ),
      );

      it.effect.each(["disconnect", "supersede", "remove-admin", "expire"] as const)(
        "rejects a late callback after %s",
        (action) =>
          run(
            Effect.gen(function* () {
              const started = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const member = yield* Ref.make<typeof membership | null>(membership);
              const test = yield* setup({
                membership: Ref.get(member),
                respond: (request) =>
                  request.url.endsWith("/oauth/token")
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as(tokenResponse()),
                      )
                    : respond(request),
              });
              const input = yield* authorize.pipe(test.provide);
              // Put the attempt near expiry without spending the callback's HTTP budget.
              if (action === "expire") yield* TestClock.adjust("899 seconds");
              const callback = yield* completeLinear(input).pipe(
                test.provide,
                Effect.flip,
                Effect.forkChild,
              );
              yield* Deferred.await(started);
              let nextAttempt: string | undefined;
              if (action === "disconnect") yield* disconnect(key).pipe(test.provide);
              if (action === "supersede")
                nextAttempt = (yield* startLinear({ ...actor }).pipe(test.provide)).authorizationId;
              if (action === "remove-admin") yield* Ref.set(member, null);
              if (action === "expire") yield* TestClock.adjust("2 seconds");
              yield* Deferred.succeed(release, undefined);
              expect(yield* Fiber.join(callback)).toMatchObject({
                code: action === "remove-admin" ? "forbidden" : "conflict",
              });
              const row = yield* test.store.get(key);
              if (action === "disconnect") expect(row).toBeNull();
              else {
                expect(row?.payloadSealed).toBe(linearRow().payloadSealed);
                expect(row?.replacement).toBeNull();
                if (nextAttempt) expect(row?.authorizationId).toBe(nextAttempt);
              }
            }),
          ),
      );

      for (const readKind of ["issue", "comments", "image"] as const) {
        it.effect.each(["cancel", "expire", "confirm", "disconnect"] as const)(
          `handles %s while an A ${readKind} read is in flight`,
          (action) =>
            run(
              Effect.gen(function* () {
                const started = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let holdRead = false;
                const description = "![Screenshot](https://uploads.linear.app/test.png)";
                const test = yield* setup({
                  respond: (request) => {
                    if (bodyHas(request, "LaunchpadIssue"))
                      return (
                        holdRead
                          ? Deferred.succeed(started, undefined).pipe(
                              Effect.andThen(Deferred.await(release)),
                            )
                          : Effect.void
                      ).pipe(Effect.as(issueResponse(description)));
                    if (request.url === "https://uploads.linear.app/test.png")
                      return Effect.succeed(
                        new Response(new Uint8Array([137, 80, 78, 71]), {
                          headers: { "content-type": "image/png" },
                        }),
                      );
                    return respond(request);
                  },
                });
                const initial = yield* readIssue(issueInput).pipe(test.provide);
                if (action === "expire") {
                  yield* propose.pipe(test.provide);
                  yield* TestClock.adjust("899 seconds");
                }
                holdRead = true;
                const operation =
                  readKind === "issue"
                    ? readIssue(issueInput).pipe(Effect.asVoid)
                    : readKind === "comments"
                      ? readComments({
                          organizationId: "org",
                          reference: initial.linear!.source,
                        }).pipe(Effect.asVoid)
                      : viewImage({
                          organizationId: "org",
                          reference: initial.linear!.images[0]!.reference,
                        }).pipe(Effect.asVoid);
                const read = yield* operation.pipe(test.provide, Effect.result, Effect.forkChild);
                yield* Deferred.await(started);
                if (action === "expire") {
                  yield* TestClock.adjust("2 seconds");
                  yield* listConnections("org").pipe(test.provide);
                  expect((yield* test.store.get(key))?.replacement).toBeNull();
                } else {
                  yield* propose.pipe(test.provide);
                  const row = (yield* test.store.get(key))!;
                  if (action === "cancel")
                    yield* cancelLinearReplacement({
                      ...actor,
                      proposalId: row.replacement!.id,
                    }).pipe(test.provide);
                  if (action === "confirm")
                    yield* confirmLinearReplacement({
                      ...actor,
                      proposalId: row.replacement!.id,
                    }).pipe(test.provide);
                  if (action === "disconnect") yield* disconnect(key).pipe(test.provide);
                }
                yield* Deferred.succeed(release, undefined);
                const result = yield* Fiber.join(read);
                expect(result._tag).toBe(
                  action === "confirm" || action === "disconnect" ? "Failure" : "Success",
                );
              }),
            ),
        );
      }

      it.effect.each(["member", "other-org"] as const)(
        "rejects %s confirmation and cancellation",
        (access) =>
          run(
            Effect.gen(function* () {
              const member = yield* Ref.make(membership);
              const test = yield* setup({ membership: Ref.get(member) });
              yield* propose.pipe(test.provide);
              const row = (yield* test.store.get(key))!;
              yield* Ref.set<typeof membership>(
                member,
                access === "member"
                  ? { ...membership, role: "member" }
                  : {
                      ...membership,
                      organization: { ...membership.organization, organizationId: "other-org" },
                    },
              );
              const input = { ...actor, proposalId: row.replacement!.id };
              expect(
                yield* confirmLinearReplacement(input).pipe(test.provide, Effect.flip),
              ).toMatchObject({ code: "forbidden" });
              expect(
                yield* cancelLinearReplacement(input).pipe(test.provide, Effect.flip),
              ).toMatchObject({ code: "forbidden" });
              expect((yield* test.store.get(key))?.replacement?.id).toBe(input.proposalId);
            }),
          ),
      );

      it.effect("refreshes A tokens without discarding the pending B proposal", () =>
        run(
          Effect.gen(function* () {
            const test = yield* setup({ rows: [linearRow(0)] });
            yield* propose.pipe(test.provide);
            const pending = (yield* test.store.get(key))!;
            yield* readIssue(issueInput).pipe(test.provide);
            const refreshed = (yield* test.store.get(key))!;
            expect(refreshed.version).toBe(pending.version);
            expect(refreshed.replacement).toEqual(pending.replacement);
            expect(refreshed.payloadSealed).not.toBe(pending.payloadSealed);
            yield* confirmLinearReplacement({ ...actor, proposalId: pending.replacement!.id }).pipe(
              test.provide,
            );
          }),
        ),
      );

      it.effect("a losing duplicate callback cannot cancel the winning claim", () =>
        run(
          Effect.gen(function* () {
            const arrived = yield* Deferred.make<void>();
            const allowMembership = yield* Deferred.make<void>();
            const httpStarted = yield* Deferred.make<void>();
            const allowHttp = yield* Deferred.make<void>();
            let members = 0;
            const test = yield* setup({
              membership: Effect.gen(function* () {
                if (++members === 2) yield* Deferred.succeed(arrived, undefined);
                yield* Deferred.await(allowMembership);
                return membership;
              }),
              respond: (request) =>
                request.url.endsWith("/oauth/token")
                  ? Deferred.succeed(httpStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(allowHttp)),
                      Effect.as(tokenResponse()),
                    )
                  : respond(request),
            });
            const input = yield* authorize.pipe(test.provide);
            const callbacks = yield* Effect.all(
              [
                completeLinear(input).pipe(Effect.result),
                completeLinear(input).pipe(Effect.result),
              ],
              { concurrency: "unbounded" },
            ).pipe(test.provide, Effect.forkChild);
            yield* Deferred.await(arrived);
            yield* Deferred.succeed(allowMembership, undefined);
            yield* Deferred.await(httpStarted);
            yield* Deferred.succeed(allowHttp, undefined);
            const results = yield* Fiber.join(callbacks);
            expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
            expect((yield* test.store.get(key))?.replacement).not.toBeNull();
            expect(
              test.requests.filter((request) => request.url.endsWith("/oauth/token")),
            ).toHaveLength(1);
          }),
        ),
      );

      it.effect("provider rejection preserves A and clears only the failed attempt", () =>
        run(
          Effect.gen(function* () {
            const test = yield* setup({
              respond: () => Effect.succeed(new Response(null, { status: 400 })),
            });
            const old = (yield* test.store.get(key))!;
            expect(yield* propose.pipe(test.provide, Effect.result)).toMatchObject({
              _tag: "Failure",
            });
            const current = (yield* test.store.get(key))!;
            expect(current.payloadSealed).toBe(old.payloadSealed);
            expect(current.version).toBe(old.version);
            expect(current.authorizationId).toBeNull();
            expect(current.replacement).toBeNull();
          }),
        ),
      );

      if (postgres) {
        it.effect(
          "persists a proposal across store recreation and rolls back a failed transaction",
          () =>
            run(
              Effect.gen(function* () {
                const test = yield* setup();
                yield* propose.pipe(test.provide);
                const original = (yield* test.store.get(key))!;
                const restarted = yield* testStore;
                expect(yield* restarted.get(key)).toEqual(original);
                yield* restarted
                  .withLock(key, (row) =>
                    restarted
                      .complete({ ...row!, payloadSealed: "never-commit", accountLabel: "Never" })
                      .pipe(Effect.andThen(Effect.fail("rollback"))),
                  )
                  .pipe(Effect.flip);
                expect(yield* restarted.get(key)).toEqual(original);
                const resumed = yield* fixture({ store: restarted, respond });
                yield* confirmLinearReplacement({
                  ...actor,
                  proposalId: original.replacement!.id,
                }).pipe(resumed.provide);
              }),
            ),
        );

        it.effect(
          "a failed proposal transaction leaves A intact and removes the claimed attempt",
          () =>
            run(
              Effect.gen(function* () {
                const test = yield* setup();
                const original = (yield* test.store.get(key))!;
                const failing = yield* fixture({
                  store: {
                    ...test.store,
                    proposeReplacement: (input) =>
                      test.store
                        .proposeReplacement(input)
                        .pipe(
                          Effect.andThen(
                            Effect.fail(
                              new ConnectionPersistenceError({ cause: "Simulated failed save" }),
                            ),
                          ),
                        ),
                  },
                  respond,
                });
                expect(yield* propose.pipe(failing.provide, Effect.result)).toMatchObject({
                  _tag: "Failure",
                });
                const current = (yield* test.store.get(key))!;
                expect(current.payloadSealed).toBe(original.payloadSealed);
                expect(current.version).toBe(original.version);
                expect(current.replacement).toBeNull();
                expect(current.authorizationId).toBeNull();
              }),
            ),
        );

        it.effect(
          "a claimed callback cannot replay after store recreation and can be superseded",
          () =>
            run(
              Effect.gen(function* () {
                const test = yield* setup();
                const input = yield* authorize.pipe(test.provide);
                const row = (yield* test.store.get(key))!;
                yield* test.store.claimAuthorization({
                  ...row,
                  authorizationId: row.authorizationId!,
                  stateHash: row.pendingStateHash!,
                });
                const restarted = yield* testStore;
                const resumed = yield* fixture({ store: restarted, respond });
                expect(
                  yield* completeLinear(input).pipe(resumed.provide, Effect.flip),
                ).toMatchObject({ code: "conflict" });
                expect(resumed.requests).toHaveLength(0);
                yield* authorize.pipe(resumed.provide);
                const current = (yield* restarted.get(key))!;
                expect(current.authorizationId).not.toBe(row.authorizationId);
                expect(current.version).toBe(row.version);
                expect(current.payloadSealed).toBe(row.payloadSealed);
              }),
            ),
        );

        it.effect.each(["confirm", "cancel", "disconnect"] as const)(
          "serializes confirmation with a concurrent %s",
          (action) =>
            run(
              Effect.gen(function* () {
                const test = yield* setup();
                yield* propose.pipe(test.provide);
                const row = (yield* test.store.get(key))!;
                const input = { ...actor, proposalId: row.replacement!.id };
                const locked = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const bothRequested = yield* Deferred.make<void>();
                const holder = yield* test.store
                  .withLock(key, () =>
                    Deferred.succeed(locked, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  )
                  .pipe(Effect.forkChild);
                yield* Deferred.await(locked);
                let requests = 0;
                const requested = Effect.suspend(() =>
                  ++requests === 2
                    ? Deferred.succeed(bothRequested, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                );
                const contenders = yield* fixture({
                  store: {
                    ...test.store,
                    withLock: (key, use) =>
                      requested.pipe(Effect.andThen(test.store.withLock(key, use))),
                    remove: (key) => requested.pipe(Effect.andThen(test.store.remove(key))),
                  },
                  respond,
                });
                const racing = yield* Effect.all(
                  [
                    confirmLinearReplacement(input).pipe(Effect.result),
                    action === "confirm"
                      ? confirmLinearReplacement(input).pipe(Effect.result)
                      : action === "cancel"
                        ? cancelLinearReplacement(input).pipe(Effect.result)
                        : disconnect(key).pipe(Effect.result),
                  ],
                  { concurrency: "unbounded" },
                ).pipe(contenders.provide, Effect.forkChild);
                yield* Deferred.await(bothRequested);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(holder);
                const results = yield* Fiber.join(racing);
                const current = yield* test.store.get(key);
                expect(current?.replacement).toBeFalsy();
                if (action === "confirm")
                  expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
                if (action === "disconnect") expect(current).toBeNull();
              }),
            ),
        );
      }
    },
  );
}
