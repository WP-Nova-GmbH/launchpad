import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import { RelaySecretBox, SecretBoxError } from "../auth/SecretBox.ts";
import type { makeCodexVmConnections } from "../tenancy/CodexVmConnections.ts";
import {
  databaseUrl,
  identity,
  makeRequest,
  organizationId,
  userId,
  withDatabase,
} from "../tenancy/CodexVmConnections.test-fixture.ts";
import {
  CodexVmOAuth,
  CodexVmOAuthError,
  hashCodexVmState,
  type CodexVmOAuthBundle,
} from "../tenancy/CodexVmOAuth.ts";
import { makeCodexVmConnectionActions } from "./CodexVmConnectionsApi.ts";

type Store = ReturnType<typeof makeCodexVmConnections>;
type Request = ReturnType<typeof makeRequest>;
const redirectUri = "http://127.0.0.1:54321/auth/callback";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const state = (letter: string) => letter.repeat(43);
const tokenBundle = (version: string, expiresAt = 3_600_000): CodexVmOAuthBundle => ({
  accessToken: `access-${version}`,
  refreshToken: `refresh-secret-canary-${version}`,
  idToken: `id-secret-canary-${version}`,
  tokenType: "Bearer",
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    "chatgpt.tokens.use.direct",
  ],
  obtainedAt: 0,
  expiresAt,
  earliestRefreshAt: null,
});

function fixture() {
  const calls = {
    create: [] as Parameters<CodexVmOAuth["Service"]["createAttempt"]>[0][],
    revoked: [] as string[],
    exchanges: 0,
    refreshes: 0,
  };
  let authorizedBundle = tokenBundle("initial", 50_000);
  let authorizedIdentity = {
    issuer: "https://auth.openai.com" as const,
    subject: identity.subject,
    clientId: identity.clientId,
    email: identity.label,
  };
  let refresh: CodexVmOAuth["Service"]["refresh"] = () => Effect.succeed(tokenBundle("renewed"));
  let exchangeFailure: CodexVmOAuthError | null = null;
  const secrets = RelaySecretBox.of({
    // Test-only transport; real SecretBox encryption has its own focused coverage.
    seal: (plaintext) => Effect.succeed(`test-sealed:${plaintext}`),
    open: (sealed) =>
      sealed.startsWith("test-sealed:")
        ? Effect.succeed(sealed.slice("test-sealed:".length))
        : Effect.fail(new SecretBoxError({ operation: "open", cause: "Invalid test payload" })),
  });
  const oauth = CodexVmOAuth.of({
    createAttempt: (input) =>
      Effect.gen(function* () {
        calls.create.push(input);
        return {
          stateHash: yield* hashCodexVmState(input.state),
          nonce: "nonce",
          codeVerifier: "verifier",
          callbackUri: input.callbackUri,
          hostId: input.hostId,
          ...(input.registration ? { registration: input.registration } : {}),
          authorizationUrl: "https://auth.openai.com/api/accounts/authorize",
        };
      }),
    completeAuthorization: () =>
      Effect.suspend(() => {
        calls.exchanges++;
        return exchangeFailure
          ? Effect.fail(exchangeFailure)
          : Effect.succeed({
              identity: authorizedIdentity,
              bundle: authorizedBundle,
            });
      }),
    refresh: (input) =>
      Effect.suspend(() => {
        calls.refreshes++;
        return refresh(input);
      }),
    revoke: ({ refreshToken }) =>
      Effect.sync(() => {
        calls.revoked.push(refreshToken);
        return { confirmed: true };
      }),
  });
  const actions = (store: Store) => makeCodexVmConnectionActions({ store, oauth, secrets });
  const connect = (request: Request) =>
    Effect.gen(function* () {
      const started = yield* request((s) =>
        actions(s).start(organizationId, userId, {
          state: state("a"),
          redirectUri,
          intent: "connect",
        }),
      );
      const connected = yield* request((s) =>
        actions(s).complete(organizationId, userId, {
          attemptId: started.attempt.attemptId,
          state: state("a"),
          code: "initial-code",
          clientId: identity.clientId,
        }),
      );
      if (!connected.connectionId) throw new Error("Expected a connected account");
      return connected as typeof connected & { connectionId: string };
    });
  return {
    calls,
    oauth,
    secrets,
    actions,
    connect,
    setAuthorized: (bundle: CodexVmOAuthBundle) => {
      authorizedBundle = bundle;
    },
    setAccount: (account: typeof authorizedIdentity) => {
      authorizedIdentity = account;
    },
    setRefresh: (next: typeof refresh) => {
      refresh = next;
    },
    failExchange: (error: CodexVmOAuthError | null) => {
      exchangeFailure = error;
    },
  };
}

const transientStorageFailure = () =>
  new SqlError({
    reason: new ConnectionError({ cause: "Synthetic connection failure" }),
  });

describe.skipIf(!databaseUrl)("Codex VM connection actions (PostgreSQL)", () => {
  it.effect("serializes a new authorization with an explicit sign-out's bounded revocation", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.connect(request);
        const revoking = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const signingOut = yield* request((store) =>
          makeCodexVmConnectionActions({
            store,
            secrets: f.secrets,
            oauth: {
              ...f.oauth,
              revoke: () =>
                Deferred.succeed(revoking, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ confirmed: true }),
                ),
            },
          }).disconnect(organizationId, userId),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(revoking);
        // NOWAIT is a database receipt: the sign-out holds the connection fence
        // throughout revocation. No timing assumption about another fiber is needed.
        const fence = yield* request(
          (_store, sql) => sql`SELECT connection_id FROM relay_codex_vm_connections
        WHERE organization_id=${organizationId} FOR UPDATE NOWAIT`,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(fence)).toBe(true);
        const attempted = yield* Deferred.make<void>();
        f.setAuthorized(tokenBundle("after-sign-out"));
        const reconnecting = yield* request((store) =>
          f
            .actions({
              ...store,
              beginOAuthAttempt: (input) =>
                Deferred.succeed(attempted, undefined).pipe(
                  Effect.andThen(store.beginOAuthAttempt(input)),
                ),
            })
            .start(organizationId, userId, { state: state("b"), redirectUri, intent: "reconnect" }),
        ).pipe(
          Effect.flatMap((started) =>
            request((s) =>
              f.actions(s).complete(organizationId, userId, {
                attemptId: started.attempt.attemptId,
                state: state("b"),
                code: "fresh-code",
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(signingOut);
        const connected = yield* Fiber.join(reconnecting);
        expect(connected).toMatchObject({ status: "connected" });
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId!)),
        ).toMatchObject({ status: "ready", token: "access-after-sign-out" });
      }),
    ),
  );

  for (const replacing of [false, true]) {
    it.effect(
      `recovers a committed ${replacing ? "replacement" : "initial connection"} after a lost acknowledgement without exchanging again`,
      () =>
        withDatabase((request) =>
          Effect.gen(function* () {
            const f = fixture();
            const original = replacing ? yield* f.connect(request) : null;
            const nextState = state(replacing ? "b" : "a");
            if (replacing) {
              f.setAccount({
                issuer: "https://auth.openai.com",
                subject: "replacement-account",
                clientId: "replacement-client",
                email: "Replacement account",
              });
              f.setAuthorized(tokenBundle("replacement"));
            }
            const exchangesBefore = f.calls.exchanges;
            const initial = yield* request((s) =>
              f.actions(s).start(organizationId, userId, {
                state: nextState,
                redirectUri,
                intent: replacing ? "replace" : "connect",
              }),
            );
            let installs = 0;
            const connected = yield* request((store) =>
              f
                .actions({
                  ...store,
                  install: (input) =>
                    Effect.suspend(() => {
                      installs++;
                      return installs === 1
                        ? store
                            .install(input)
                            .pipe(Effect.andThen(Effect.fail(transientStorageFailure())))
                        : store.install(input);
                    }),
                })
                .complete(organizationId, userId, {
                  attemptId: initial.attempt.attemptId,
                  state: nextState,
                  code: "initial-code",
                  clientId: replacing ? "replacement-client" : identity.clientId,
                }),
            );
            expect(connected).toMatchObject({
              status: "connected",
              epoch: (original?.epoch ?? 0) + 1,
              tokenRevision: (original?.tokenRevision ?? 0) + 1,
            });
            if (replacing) expect(connected.revocationUnconfirmed).toBe(true);
            expect(installs).toBe(2);
            expect(f.calls.exchanges - exchangesBefore).toBe(1);
            expect((yield* request((s) => s.getAttempt(initial.attempt.attemptId)))?.phase).toBe(
              "completed",
            );
            expect(f.calls.revoked).toEqual([]);
          }),
        ),
    );
  }

  it.effect(
    "keeps the new account connected and reports unconfirmed retirement of the replaced account",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const f = fixture(),
            original = yield* f.connect(request);
          const started = yield* request((s) =>
            f.actions(s).start(organizationId, userId, {
              state: state("b"),
              redirectUri,
              intent: "replace",
            }),
          );
          f.setAccount({
            issuer: "https://auth.openai.com",
            subject: "replacement-account",
            clientId: "replacement-client",
            email: "Replacement account",
          });
          f.setAuthorized(tokenBundle("replacement"));
          const revoked: string[] = [];
          const replacement = yield* request((store) =>
            makeCodexVmConnectionActions({
              store,
              secrets: f.secrets,
              oauth: {
                ...f.oauth,
                revoke: ({ refreshToken }) =>
                  Effect.sync(() => {
                    revoked.push(refreshToken);
                    return { confirmed: false };
                  }),
              },
            }).complete(organizationId, userId, {
              attemptId: started.attempt.attemptId,
              state: state("b"),
              code: "replacement-code",
              clientId: "replacement-client",
            }),
          );
          expect(replacement).toMatchObject({ status: "connected", revocationUnconfirmed: true });
          expect(replacement.connectionId).not.toBe(original.connectionId);
          expect(revoked).toEqual(["refresh-secret-canary-initial"]);
          expect(
            yield* request((s) => f.actions(s).token(organizationId, replacement.connectionId!)),
          ).toMatchObject({ status: "ready", token: "access-replacement" });
          expect((yield* request((s) => s.get(organizationId)))?.status).toBe("connected");
        }),
      ),
  );

  for (const point of ["open", "seal", "persist"] as const) {
    it.effect(
      `ends a claimed callback after ${point} failure and permits a fresh issued-client retry`,
      () =>
        withDatabase((request) =>
          Effect.gen(function* () {
            const f = fixture();
            const initial = yield* request((s) =>
              f.actions(s).start(organizationId, userId, {
                state: state("a"),
                redirectUri,
                intent: "connect",
              }),
            );
            const result = yield* request((store) =>
              makeCodexVmConnectionActions({
                store:
                  point === "persist"
                    ? { ...store, install: () => Effect.fail(transientStorageFailure()) }
                    : store,
                oauth: f.oauth,
                secrets: {
                  ...f.secrets,
                  ...(point === "open"
                    ? {
                        open: () =>
                          Effect.fail(
                            new SecretBoxError({
                              operation: "open",
                              cause: "Synthetic secret read failure",
                            }),
                          ),
                      }
                    : {}),
                  ...(point === "seal"
                    ? {
                        seal: () =>
                          Effect.fail(
                            new SecretBoxError({
                              operation: "seal",
                              cause: "Synthetic secret write failure",
                            }),
                          ),
                      }
                    : {}),
                },
              }).complete(organizationId, userId, {
                attemptId: initial.attempt.attemptId,
                state: state("a"),
                code: "initial-code",
                clientId: identity.clientId,
              }),
            ).pipe(Effect.flip);
            expect(result).toMatchObject({
              reason: point === "open" ? "configuration" : "unavailable",
            });
            expect(f.calls.exchanges).toBe(point === "open" ? 0 : 1);
            expect(yield* request((s) => s.getAttempt(initial.attempt.attemptId))).toMatchObject({
              phase: "failed",
              pendingSealed: null,
            });
            const retried = yield* request((s) =>
              f.actions(s).start(organizationId, userId, {
                state: state("b"),
                redirectUri,
                intent: "connect",
                retryAttemptId: initial.attempt.attemptId,
              }),
            );
            expect(f.calls.create[1]?.registration).toMatchObject({ clientId: identity.clientId });
            expect(retried.attempt.attemptId).not.toBe(initial.attempt.attemptId);
            expect(
              yield* request((s) =>
                f.actions(s).complete(organizationId, userId, {
                  attemptId: retried.attempt.attemptId,
                  state: state("b"),
                  code: "fresh-code",
                }),
              ),
            ).toMatchObject({ status: "connected" });
          }),
        ),
    );
  }

  it.effect("renews once across independent requests and exposes access-token data only", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          connected = yield* f.connect(request);
        const dispatched = yield* Deferred.make<void>(),
          reply = yield* Deferred.make<CodexVmOAuthBundle>();
        f.setRefresh(() =>
          Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Deferred.await(reply))),
        );
        const first = yield* request((s) =>
          f.actions(s).token(organizationId, connected.connectionId),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(dispatched);
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)),
        ).toEqual({ status: "pending", retryAfterMs: 100 });
        expect(f.calls.refreshes).toBe(1);
        yield* Deferred.succeed(reply, tokenBundle("renewed"));
        const token = yield* Fiber.join(first);
        expect(token).toMatchObject({
          status: "ready",
          token: "access-renewed",
          tokenRevision: connected.tokenRevision + 1,
        });
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)),
        ).toEqual(token);
        const metadata = yield* request((s) => f.actions(s).metadata(organizationId));
        for (const result of [token, metadata]) {
          expect(json(result)).not.toContain("refresh-secret-canary");
          expect(json(result)).not.toContain("id-secret-canary");
        }
        expect(json(metadata)).not.toContain("access-renewed");
        expect(f.calls.refreshes).toBe(1);
        expect(f.calls.revoked).toEqual([]);
      }),
    ),
  );

  for (const committed of [false, true]) {
    it.effect(
      `persists one known response after ${committed ? "a lost commit acknowledgement" : "a transient storage failure"}`,
      () =>
        withDatabase((request) =>
          Effect.gen(function* () {
            const f = fixture(),
              connected = yield* f.connect(request);
            let writes = 0;
            const result = yield* request((store) =>
              f
                .actions({
                  ...store,
                  completeRefresh: (input) =>
                    Effect.suspend(() => {
                      writes++;
                      if (writes !== 1) return store.completeRefresh(input);
                      return (
                        committed ? store.completeRefresh(input).pipe(Effect.asVoid) : Effect.void
                      ).pipe(Effect.andThen(Effect.fail(transientStorageFailure())));
                    }),
                })
                .token(organizationId, connected.connectionId),
            );
            expect(result).toMatchObject({
              status: "ready",
              token: "access-renewed",
              tokenRevision: connected.tokenRevision + 1,
            });
            expect(writes).toBe(2);
            expect(f.calls.refreshes).toBe(1);
            expect((yield* request((s) => s.get(organizationId)))?.tokenRevision).toBe(
              connected.tokenRevision + 1,
            );
          }),
        ),
    );
  }

  it.effect("does not deliver a delayed refresh or resurrect an account after disconnect", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          connected = yield* f.connect(request);
        const dispatched = yield* Deferred.make<void>(),
          reply = yield* Deferred.make<CodexVmOAuthBundle>();
        f.setRefresh(() =>
          Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Deferred.await(reply))),
        );
        const pending = yield* request((s) =>
          f.actions(s).token(organizationId, connected.connectionId),
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(dispatched);
        expect(
          (yield* request((s) => f.actions(s).disconnect(organizationId, userId))).status,
        ).toBe("disconnected");
        yield* Deferred.succeed(reply, tokenBundle("late"));
        expect(yield* Fiber.join(pending)).toMatchObject({
          reason: "not_connected",
          revocationUnconfirmed: true,
        });
        const current = yield* request((s) => s.get(organizationId));
        expect(current).toMatchObject({
          status: "disconnected",
          payloadSealed: null,
          errorCode: "revocation_unconfirmed",
        });
        expect(current?.epoch).toBeGreaterThan(connected.epoch);
        expect(f.calls.revoked).toEqual(["refresh-secret-canary-initial"]);
        expect(f.calls.refreshes).toBe(1);
      }),
    ),
  );

  it.effect("reconnects the same account when its old encrypted credentials cannot be opened", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          original = yield* f.connect(request);
        yield* request(
          (
            _store,
            sql,
          ) => sql`UPDATE relay_codex_vm_connections SET payload_sealed='invalid-sealed-payload'
          WHERE organization_id=${organizationId}`,
        );
        f.setAuthorized(tokenBundle("recovered"));
        const started = yield* request((store) =>
          f.actions(store).start(organizationId, userId, {
            state: state("b"),
            redirectUri,
            intent: "reconnect",
          }),
        );
        expect(f.calls.create[1]?.registration).toEqual({
          issuer: identity.issuer,
          subject: identity.subject,
          clientId: identity.clientId,
        });
        const reconnected = yield* request((store) =>
          f.actions(store).complete(organizationId, userId, {
            attemptId: started.attempt.attemptId,
            state: state("b"),
            code: "fresh-recovery-code",
          }),
        );
        expect(reconnected).toMatchObject({
          connectionId: original.connectionId,
          status: "connected",
          epoch: original.epoch + 1,
        });
        expect(
          yield* request((store) => f.actions(store).token(organizationId, original.connectionId)),
        ).toMatchObject({ status: "ready", token: "access-recovered" });
        expect(f.calls.exchanges).toBe(2);
        expect(f.calls.revoked).toEqual([]);
      }),
    ),
  );

  it.effect("keeps a fresh same-account authorization when an older renewal finishes late", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          original = yield* f.connect(request);
        const dispatched = yield* Deferred.make<void>(),
          reply = yield* Deferred.make<CodexVmOAuthBundle>();
        f.setRefresh(() =>
          Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Deferred.await(reply))),
        );
        const pending = yield* request((s) =>
          f.actions(s).token(organizationId, original.connectionId),
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(dispatched);
        f.setAuthorized(tokenBundle("reauthorized"));
        const started = yield* request((s) =>
          f.actions(s).start(organizationId, userId, {
            state: state("b"),
            redirectUri,
            intent: "reconnect",
          }),
        );
        const reconnected = yield* request((s) =>
          f.actions(s).complete(organizationId, userId, {
            attemptId: started.attempt.attemptId,
            state: state("b"),
            code: "new-code",
          }),
        );
        expect(reconnected.connectionId).toBe(original.connectionId);
        expect(reconnected.epoch).toBe(original.epoch + 1);
        yield* Deferred.succeed(reply, tokenBundle("old-renewal"));
        expect(yield* Fiber.join(pending)).toMatchObject({
          reason: "not_connected",
          revocationUnconfirmed: true,
        });
        expect(
          yield* request((s) => f.actions(s).token(organizationId, original.connectionId)),
        ).toMatchObject({
          status: "ready",
          token: "access-reauthorized",
          epoch: reconnected.epoch,
        });
        expect(f.calls.revoked).toEqual([]);
      }),
    ),
  );

  it.effect("reuses an issued registration after a failed initial code exchange", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture();
        const initial = yield* request((s) =>
          f.actions(s).start(organizationId, userId, {
            state: state("a"),
            redirectUri,
            intent: "connect",
          }),
        );
        f.failExchange(new CodexVmOAuthError({ operation: "exchange", reason: "invalid_grant" }));
        expect(
          yield* request((s) =>
            f.actions(s).complete(organizationId, userId, {
              attemptId: initial.attempt.attemptId,
              state: state("a"),
              code: "expired-code",
              clientId: identity.clientId,
            }),
          ).pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid_grant" });
        const retried = yield* request((s) =>
          f.actions(s).start(organizationId, userId, {
            state: state("b"),
            redirectUri,
            intent: "connect",
            retryAttemptId: initial.attempt.attemptId,
          }),
        );
        expect(f.calls.create[1]?.registration).toMatchObject({ clientId: identity.clientId });
        expect(f.calls.create[1]?.state).not.toBe(f.calls.create[0]?.state);
        f.failExchange(null);
        expect(
          yield* request((s) =>
            f.actions(s).complete(organizationId, userId, {
              attemptId: retried.attempt.attemptId,
              state: state("b"),
              code: "fresh-code",
            }),
          ),
        ).toMatchObject({ status: "connected" });
        expect(f.calls.exchanges).toBe(2);
      }),
    ),
  );

  it.effect("releases an undispatched preflight failure so a later lookup can renew", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          connected = yield* f.connect(request);
        f.setRefresh(() =>
          Effect.fail(new CodexVmOAuthError({ operation: "refresh", reason: "unavailable" })),
        );
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ reason: "unavailable" });
        expect(yield* request((s) => s.get(organizationId))).toMatchObject({
          status: "connected",
          refreshAttemptId: null,
          errorCode: null,
        });
        f.setRefresh(() => Effect.succeed(tokenBundle("recovered")));
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)),
        ).toMatchObject({ status: "ready", token: "access-recovered" });
        expect(f.calls.refreshes).toBe(2);
      }),
    ),
  );

  it.effect("does not repeat a rejected rotating grant", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture(),
          connected = yield* f.connect(request);
        f.setRefresh(() =>
          Effect.fail(new CodexVmOAuthError({ operation: "refresh", reason: "invalid_grant" })),
        );
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ reason: "invalid_grant" });
        expect(
          yield* request((s) => f.actions(s).token(organizationId, connected.connectionId)).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ reason: "not_connected" });
        expect(f.calls.refreshes).toBe(1);
        expect(yield* request((s) => s.get(organizationId))).toMatchObject({
          status: "reconnect_required",
          errorCode: "invalid_grant",
        });
      }),
    ),
  );

  it.effect("rechecks an account epoch after opening an otherwise valid cached token", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const f = fixture();
        f.setAuthorized(tokenBundle("valid"));
        const connected = yield* f.connect(request);
        const opening = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const pending = yield* request((store) =>
          makeCodexVmConnectionActions({
            store,
            oauth: f.oauth,
            secrets: {
              ...f.secrets,
              open: (sealed) =>
                Deferred.succeed(opening, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(f.secrets.open(sealed)),
                ),
            },
          }).token(organizationId, connected.connectionId),
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(opening);
        yield* request((s) => s.disconnect({ organizationId, userId }));
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({ reason: "not_connected" });
        expect(f.calls.refreshes).toBe(0);
      }),
    ),
  );
});
