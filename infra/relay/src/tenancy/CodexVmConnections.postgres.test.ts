import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  databaseUrl,
  organizationId,
  userId,
  identity,
  future,
  past,
  withDatabase,
  begin,
  install,
  connect,
} from "./CodexVmConnections.test-fixture.ts";

describe.skipIf(!databaseUrl)("Codex VM connection fencing (PostgreSQL)", () => {
  it.effect(
    "does not erase a concurrent refresh failure while acknowledging old-session retirement",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const snapshot = yield* connect(request, past);
          const claim = yield* request((s) => s.claimRefresh({ organizationId }));
          if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
          yield* request((s) => s.failRefresh(claim.fence, "invalid_grant"));
          expect(
            yield* request((s) => s.withConnectionRevocation(snapshot, Effect.succeed(true))),
          ).toBe(true);
          expect(yield* request((s) => s.get(organizationId))).toMatchObject({
            status: "reconnect_required",
            errorCode: "invalid_grant",
          });
        }),
      ),
  );

  it.effect("serializes explicit remote retirement with a new sign-in", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        yield* connect(request);
        yield* request((s) => s.disconnect({ organizationId, userId }));
        const snapshot = (yield* request((s) => s.get(organizationId)))!;
        expect(snapshot.errorCode).toBe("revocation_unconfirmed");
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<boolean>();
        const retiring = yield* request((s) =>
          s.withConnectionRevocation(
            snapshot,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const locked = yield* request(
          (_s, sql) =>
            sql`SELECT 1 FROM relay_codex_vm_connections WHERE organization_id=${organizationId} FOR UPDATE NOWAIT`,
        ).pipe(Effect.flip);
        expect(locked).toMatchObject({ _tag: "SqlError", reason: { cause: { code: "55P03" } } });
        const signingIn = yield* request((s) => begin(s, "after-retirement", "reconnect")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, true);
        expect(yield* Fiber.join(retiring)).toBe(true);
        const next = yield* Fiber.join(signingIn);
        yield* request((s) =>
          s.claimCallback({
            organizationId,
            userId,
            attemptId: next.attemptId,
            stateHash: "after-retirement",
          }),
        );
        expect((yield* request((s) => install(s, next.attemptId)))?.connection.status).toBe(
          "connected",
        );
      }),
    ),
  );

  it.effect("skips old cleanup after a newer action without cancelling the newer sign-in", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        yield* connect(request);
        yield* request((s) => s.disconnect({ organizationId, userId }));
        const snapshot = (yield* request((s) => s.get(organizationId)))!;
        const newer = yield* request((s) => begin(s, "newer-than-cleanup", "reconnect"));
        let revokes = 0;
        expect(
          yield* request((s) =>
            s.withConnectionRevocation(
              snapshot,
              Effect.sync(() => {
                revokes++;
                return true;
              }),
            ),
          ),
        ).toBe(false);
        expect(revokes).toBe(0);
        expect((yield* request((s) => s.getAttempt(newer.attemptId)))?.phase).toBe("pending");
        expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
          "revocation_unconfirmed",
        );
        yield* request((s) => s.disconnect({ organizationId, userId }));
        expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
          "revocation_unconfirmed",
        );
      }),
    ),
  );

  it.effect(
    "keeps a previous retirement warning through access-token renewal until confirmed",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request);
          const attempt = yield* request((s) => begin(s, "warning-replacement", "replace"));
          const other = { ...identity, subject: "other-subject", clientId: "other-client" };
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: attempt.attemptId,
              stateHash: "warning-replacement",
              issuedClientId: other.clientId,
            }),
          );
          const installed = (yield* request((s) => install(s, attempt.attemptId, past, other)))!;
          expect(installed.connection.errorCode).toBe("revocation_unconfirmed");
          const preflight = yield* request((s) => s.claimRefresh({ organizationId }));
          if (preflight.kind !== "refresh") throw new Error("Expected a refresh claim");
          yield* request((s) => s.releaseRefreshClaim(preflight.fence));
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
            "revocation_unconfirmed",
          );
          const claim = yield* request((s) => s.claimRefresh({ organizationId }));
          if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
          yield* request((s) =>
            s.completeRefresh({
              fence: claim.fence,
              payloadSealed: "new-access-token",
              expiresAt: future,
              earliestRefreshAt: null,
            }),
          );
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
            "revocation_unconfirmed",
          );
          expect(
            yield* request((s) =>
              s.withConnectionRevocation(installed.connection, Effect.succeed(true)),
            ),
          ).toBe(true);
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(null);
        }),
      ),
  );

  it.effect("acknowledges only an exact known OAuth install after a lost persistence reply", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const attempt = yield* request((s) => begin(s, "install-receipt"));
        yield* request((s) =>
          s.claimCallback({
            organizationId,
            userId,
            attemptId: attempt.attemptId,
            stateHash: "install-receipt",
            issuedClientId: identity.clientId,
          }),
        );
        const first = (yield* request((s) => install(s, attempt.attemptId)))!;
        const repeated = (yield* request((s) => install(s, attempt.attemptId)))!;
        expect(repeated.connection).toEqual(first.connection);
        expect(repeated.previous).toBe(null);
        expect(repeated.retirementUnconfirmed).toBe(false);
        expect(
          yield* request((s) =>
            s.install({
              organizationId,
              userId,
              attemptId: attempt.attemptId,
              ...identity,
              payloadSealed: "different-ciphertext",
              expiresAt: future,
              earliestRefreshAt: null,
            }),
          ),
        ).toBe(null);
        yield* request((s) => s.disconnect({ organizationId, userId }));
        expect(yield* request((s) => install(s, attempt.attemptId))).toBe(null);
      }),
    ),
  );

  it.effect(
    "reports unavailable prior retirement after an acknowledged replacement and fences newer authorization",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request);
          const attempt = yield* request((s) => begin(s, "replacement-receipt", "replace"));
          const other = { ...identity, subject: "other-subject", clientId: "other-client" };
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: attempt.attemptId,
              stateHash: "replacement-receipt",
              issuedClientId: other.clientId,
            }),
          );
          const first = (yield* request((s) => install(s, attempt.attemptId, future, other)))!;
          expect(first.previous?.subject).toBe(identity.subject);
          expect(first.retirementUnconfirmed).toBe(false);
          const repeated = (yield* request((s) => install(s, attempt.attemptId, future, other)))!;
          expect(repeated.connection.epoch).toBe(first.connection.epoch);
          expect(repeated.retirementUnconfirmed).toBe(true);
          yield* request((s) => begin(s, "newer-authorization", "reconnect"));
          expect(yield* request((s) => install(s, attempt.attemptId, future, other))).toBe(null);
        }),
      ),
  );

  it.effect("recognizes only the exact committed refresh result when persistence is retried", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        yield* connect(request, past);
        const claim = yield* request((s) => s.claimRefresh({ organizationId }));
        if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
        const result = {
          fence: claim.fence,
          payloadSealed: "exact-known-ciphertext",
          expiresAt: future,
          earliestRefreshAt: null,
        };
        expect(yield* request((s) => s.completeRefresh(result))).toBe(true);
        expect(yield* request((s) => s.completeRefresh(result))).toBe(true);
        for (const changed of [
          { ...result, payloadSealed: "different-ciphertext" },
          { ...result, expiresAt: "2098-01-01T00:00:00.000Z" },
          { ...result, earliestRefreshAt: past },
          { ...result, fence: { ...claim.fence, attemptId: "unrelated-attempt" } },
          { ...result, fence: { ...claim.fence, epoch: claim.fence.epoch + 1 } },
          { ...result, fence: { ...claim.fence, tokenRevision: claim.fence.tokenRevision + 1 } },
        ])
          expect(yield* request((s) => s.completeRefresh(changed))).toBe(false);
        yield* request(
          (_s, sql) =>
            sql`UPDATE relay_codex_vm_connections SET expires_at=${past} WHERE organization_id=${organizationId}`,
        );
        const next = yield* request((s) => s.claimRefresh({ organizationId }));
        if (next.kind !== "refresh") throw new Error("Expected the next refresh claim");
        expect(
          yield* request((s) =>
            s.completeRefresh({ ...result, fence: next.fence, payloadSealed: "next-revision" }),
          ),
        ).toBe(true);
        expect(yield* request((s) => s.completeRefresh(result))).toBe(false);
      }),
    ),
  );

  it.effect(
    "retains an initially issued client ID for an explicit failed-code retry, fenced against later actions",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const original = yield* request((s) => begin(s, "issued-registration"));
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: original.attemptId,
              stateHash: "issued-registration",
              issuedClientId: identity.clientId,
            }),
          );
          yield* request((s) =>
            s.markOAuthFailure({ organizationId, userId, attemptId: original.attemptId }),
          );
          expect((yield* request((s) => s.get(organizationId)))?.status).toBe("disconnected");
          const retry = (stateHash: string) =>
            request((s) =>
              Effect.gen(function* () {
                const expected = yield* s.get(organizationId);
                return yield* s.beginOAuthAttempt({
                  organizationId,
                  userId,
                  intent: "connect",
                  redirectUri: original.redirectUri,
                  stateHash,
                  pendingSealed: "new-pkce-and-nonce",
                  expiresAt: future,
                  expected,
                  retryAttemptId: original.attemptId,
                });
              }),
            );
          const next = yield* retry("new-code");
          expect(next.issuedClientId).toBe(identity.clientId);
          expect((yield* request((s) => s.get(organizationId)))?.payloadSealed).toBe(null);
          expect(
            (yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: next.attemptId,
                stateHash: "new-code",
              }),
            )).issuedClientId,
          ).toBe(identity.clientId);
          expect(yield* retry("replay-after-new-start").pipe(Effect.flip)).toMatchObject({
            code: "stale_attempt",
          });
          yield* request((s) => s.disconnect({ organizationId, userId }));
          expect(yield* retry("replay-after-disconnect").pipe(Effect.flip)).toMatchObject({
            code: "stale_attempt",
          });
        }),
      ),
  );

  it.effect("fences OAuth preparation against a newer connection action", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        yield* connect(request);
        const expected = (yield* request((s) => s.get(organizationId)))!;
        yield* request((s) => s.disconnect({ organizationId, userId }));
        expect(
          yield* request((s) =>
            s.beginOAuthAttempt({
              organizationId,
              userId,
              intent: "reconnect",
              redirectUri: "http://127.0.0.1:43210/auth/callback",
              stateHash: "old-registration",
              pendingSealed: "old-pkce",
              expiresAt: future,
              expected,
            }),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "stale_attempt" });
        expect((yield* request((s) => s.get(organizationId)))?.latestAttemptId).toBe(null);
      }),
    ),
  );

  it.effect(
    "releases only known undispatched refresh claims and never retries a definite invalid grant",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request, past);
          const first = yield* request((s) => s.claimRefresh({ organizationId }));
          if (first.kind !== "refresh") throw new Error("Expected a refresh claim");
          expect(yield* request((s) => s.releaseRefreshClaim(first.fence))).toBe(true);
          const next = yield* request((s) => s.claimRefresh({ organizationId }));
          if (next.kind !== "refresh") throw new Error("Expected a fresh preflight");
          expect(next.fence.attemptId).not.toBe(first.fence.attemptId);
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: first.fence,
                payloadSealed: "stale",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(false);
          expect(yield* request((s) => s.failRefresh(next.fence, "invalid_grant"))).toBe(true);
          expect(yield* request((s) => s.releaseRefreshClaim(next.fence))).toBe(false);
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: next.fence,
                payloadSealed: "invalid-result",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(false);
          expect((yield* request((s) => s.claimRefresh({ organizationId }))).kind).toBe(
            "unavailable",
          );
        }),
      ),
  );

  it.effect(
    "does not deliver expired access tokens before a contradictory refresh-not-before time",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request, past);
          yield* request(
            (_s, sql) =>
              sql`UPDATE relay_codex_vm_connections SET earliest_refresh_at=${future} WHERE organization_id=${organizationId}`,
          );
          expect((yield* request((s) => s.claimRefresh({ organizationId }))).kind).toBe(
            "unavailable",
          );
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
            "configuration_error",
          );
        }),
      ),
  );

  it.effect(
    "shares one installation identity and one refresh claim across separate request scopes",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const hosts = yield* Effect.all(
            [request((s) => s.getHostId()), request((s) => s.getHostId())],
            { concurrency: "unbounded" },
          );
          expect(hosts[0]).toBe(hosts[1]);
          const original = yield* connect(request, past);
          const claims = yield* Effect.all(
            [
              request((s) => s.claimRefresh({ organizationId })),
              request((s) => s.claimRefresh({ organizationId })),
            ],
            { concurrency: "unbounded" },
          );
          expect(claims.map((c) => c.kind).sort()).toEqual(["pending", "refresh"]);
          const claim = claims.find((c) => c.kind === "refresh")!;
          if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: claim.fence,
                payloadSealed: "rotated-session",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(true);
          const current = yield* request((s) => s.claimRefresh({ organizationId }));
          expect(current.kind).toBe("ready");
          if (current.kind !== "ready") throw new Error("Expected committed credentials");
          expect(current.connection.tokenRevision).toBe(original.tokenRevision + 1);
          expect(current.connection.payloadSealed).toBe("rotated-session");
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: claim.fence,
                payloadSealed: "replayed-session",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(false);
        }),
      ),
  );

  it.effect("keeps a working connection while newer admin sign-ins supersede older attempts", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const original = yield* connect(request);
        const old = yield* request((s) => begin(s, "old", "reconnect"));
        yield* request((s) =>
          s.claimCallback({ organizationId, userId, attemptId: old.attemptId, stateHash: "old" }),
        );
        const newer = yield* request((s) => begin(s, "newer", "reconnect", "second-admin"));
        expect(
          yield* request((s) => s.cancel({ organizationId, userId, attemptId: old.attemptId })),
        ).toBe(false);
        expect(yield* request((s) => install(s, old.attemptId))).toBe(null);
        const active = (yield* request((s) => s.get(organizationId)))!;
        expect(active.status).toBe("connected");
        expect(active.epoch).toBe(original.epoch);
        expect(active.latestAttemptId).toBe(newer.attemptId);
        expect((yield* request((s) => s.getAttempt(old.attemptId)))?.pendingSealed).toBe(null);
      }),
    ),
  );

  it.effect(
    "requires state and initial issued client ID, claims codes once and checks reauthorization IDs",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const pending = yield* request((s) => begin(s, "one"));
          expect(
            yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: pending.attemptId,
                stateHash: "wrong",
                issuedClientId: identity.clientId,
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "invalid_state" });
          expect(
            yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: pending.attemptId,
                stateHash: "one",
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "identity_mismatch" });
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: pending.attemptId,
              stateHash: "one",
              issuedClientId: identity.clientId,
            }),
          );
          expect(
            yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: pending.attemptId,
                stateHash: "one",
                issuedClientId: identity.clientId,
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "stale_attempt" });
          yield* request((s) => install(s, pending.attemptId));
          const reconnect = yield* request((s) => begin(s, "two", "reconnect"));
          expect(
            yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: reconnect.attemptId,
                stateHash: "two",
                issuedClientId: "another-client",
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "identity_mismatch" });
          const claimed = yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: reconnect.attemptId,
              stateHash: "two",
            }),
          );
          expect(claimed.issuedClientId).toBe(identity.clientId);
        }),
      ),
  );

  it.effect(
    "rechecks admin authority after exchange and preserves the prior account on identity mismatch",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const original = yield* connect(request);
          const pending = yield* request((s) => begin(s, "reconnect", "reconnect"));
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: pending.attemptId,
              stateHash: "reconnect",
            }),
          );
          const changed = { ...identity, subject: "another-account" };
          expect(
            yield* request((s) => install(s, pending.attemptId, future, changed)).pipe(Effect.flip),
          ).toMatchObject({ code: "identity_mismatch" });
          yield* request(
            (_s, sql) =>
              sql`UPDATE relay_organization_members SET role='member' WHERE user_id=${userId}`,
          );
          expect(
            yield* request((s) => install(s, pending.attemptId)).pipe(Effect.flip),
          ).toMatchObject({ code: "not_admin" });
          expect((yield* request((s) => s.get(organizationId)))?.epoch).toBe(original.epoch);
        }),
      ),
  );

  it.effect(
    "prevents an absent→connected→disconnected ABA callback from reconnecting the account",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const old = yield* request((s) => begin(s, "old"));
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: old.attemptId,
              stateHash: "old",
              issuedClientId: identity.clientId,
            }),
          );
          const latest = yield* request((s) => begin(s, "latest"));
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: latest.attemptId,
              stateHash: "latest",
              issuedClientId: identity.clientId,
            }),
          );
          yield* request((s) => install(s, latest.attemptId));
          const removed = (yield* request((s) => s.disconnect({ organizationId, userId })))!;
          expect(yield* request((s) => install(s, old.attemptId))).toBe(null);
          expect((yield* request((s) => s.get(organizationId)))?.status).toBe("disconnected");
          yield* request((s) =>
            s.markRevocation({ organizationId, epoch: removed.epoch, confirmed: true }),
          );
          const again = yield* request((s) => begin(s, "again", "reconnect"));
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: again.attemptId,
              stateHash: "again",
            }),
          );
          yield* request((s) => install(s, again.attemptId));
          expect(
            yield* request((s) =>
              s.markRevocation({ organizationId, epoch: removed.epoch, confirmed: false }),
            ),
          ).toBe(false);
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(null);
        }),
      ),
  );

  it.effect(
    "does not retry an abandoned grant and can persist its late known result through the original fence",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request, past);
          const claim = yield* request((s) => s.claimRefresh({ organizationId }));
          if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
          yield* request(
            (_s, sql) =>
              sql`UPDATE relay_codex_vm_connections SET refresh_started_at=${past} WHERE organization_id=${organizationId}`,
          );
          expect((yield* request((s) => s.claimRefresh({ organizationId }))).kind).toBe(
            "unavailable",
          );
          expect((yield* request((s) => s.get(organizationId)))?.errorCode).toBe(
            "refresh_uncertain",
          );
          expect((yield* request((s) => s.claimRefresh({ organizationId }))).kind).toBe(
            "unavailable",
          );
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: claim.fence,
                payloadSealed: "known-late-result",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(true);
          expect((yield* request((s) => s.claimRefresh({ organizationId }))).kind).toBe("ready");
        }),
      ),
  );

  it.effect(
    "fences refresh success/failure after disconnect, and replacement invalidates old VM selections",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const original = yield* connect(request, past);
          const claim = yield* request((s) => s.claimRefresh({ organizationId }));
          if (claim.kind !== "refresh") throw new Error("Expected a refresh claim");
          yield* request((s) => s.disconnect({ organizationId, userId }));
          expect(
            yield* request((s) =>
              s.completeRefresh({
                fence: claim.fence,
                payloadSealed: "late-replacement",
                expiresAt: future,
                earliestRefreshAt: null,
              }),
            ),
          ).toBe(false);
          expect(yield* request((s) => s.failRefresh(claim.fence, "refresh_uncertain"))).toBe(
            false,
          );
          const replacement = yield* request((s) => begin(s, "replacement", "replace"));
          const other = { ...identity, subject: "other-account", clientId: "other-client" };
          yield* request((s) =>
            s.claimCallback({
              organizationId,
              userId,
              attemptId: replacement.attemptId,
              stateHash: "replacement",
              issuedClientId: other.clientId,
            }),
          );
          const installed = (yield* request((s) =>
            install(s, replacement.attemptId, future, other),
          ))!;
          expect(installed.connection.connectionId).not.toBe(original.connectionId);
          expect(
            (yield* request((s) =>
              s.claimRefresh({ organizationId, connectionId: original.connectionId }),
            )).kind,
          ).toBe("unavailable");
        }),
      ),
  );

  it.effect(
    "handles denied, cancelled and expired attempts without destroying active credentials",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const original = yield* connect(request);
          const denied = yield* request((s) => begin(s, "denied", "reconnect"));
          expect(
            yield* request((s) =>
              s.markOAuthFailure({
                organizationId,
                userId,
                attemptId: denied.attemptId,
                stateHash: "wrong",
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "invalid_state" });
          expect(
            yield* request((s) =>
              s.markOAuthFailure({
                organizationId,
                userId,
                attemptId: denied.attemptId,
                stateHash: "denied",
              }),
            ),
          ).toBe(true);
          const cancelled = yield* request((s) => begin(s, "cancelled", "reconnect"));
          expect(
            yield* request((s) =>
              s.cancel({ organizationId, userId, attemptId: cancelled.attemptId }),
            ),
          ).toBe(true);
          const expired = yield* request((s) => begin(s, "expired", "reconnect"));
          yield* request(
            (_s, sql) =>
              sql`UPDATE relay_codex_vm_oauth_attempts SET expires_at=${past} WHERE attempt_id=${expired.attemptId}`,
          );
          expect(
            yield* request((s) =>
              s.claimCallback({
                organizationId,
                userId,
                attemptId: expired.attemptId,
                stateHash: "expired",
              }),
            ).pipe(Effect.flip),
          ).toMatchObject({ code: "stale_attempt" });
          expect(
            yield* request((s) =>
              s.markOAuthFailure({
                organizationId,
                userId,
                attemptId: expired.attemptId,
                phase: "expired",
              }),
            ),
          ).toBe(true);
          expect((yield* request((s) => s.get(organizationId)))?.epoch).toBe(original.epoch);
          expect((yield* request((s) => s.get(organizationId)))?.status).toBe("connected");
        }),
      ),
  );
});
