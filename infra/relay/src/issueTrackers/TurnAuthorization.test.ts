import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayIssueTrackerTurnPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { ConnectionStore, type ConnectionRecord } from "./ConnectionStore.ts";
import { authorizeRead, authorizeTurn, openTurn } from "./TurnAuthorization.ts";

const row: ConnectionRecord = {
  ownerUserId: "alice",
  service: "linear",
  version: "version-a",
  status: "connected",
  accountLabel: "Alice",
  payloadSealed: "provider-secret",
  authorizationId: null,
  replacement: null,
  jiraSelection: null,
  pendingOAuthSealed: null,
  pendingStateHash: null,
  pendingExpiresAt: null,
  updatedByUserId: "alice",
  updatedAt: "2026-10-02T00:00:00Z",
};
const request = {
  environmentId: EnvironmentId.make("personal-or-managed-environment"),
  threadId: "thread",
  commandId: "command",
  commandDigest: "a".repeat(64),
};
const fixture = () => {
  let active: ConnectionRecord | null = row;
  const sealed = new Map<string, string>();
  const deps = Layer.mergeAll(
    Layer.mock(ConnectionStore, {
      list: (ownerUserId) => Effect.succeed(active?.ownerUserId === ownerUserId ? [active] : []),
      get: ({ ownerUserId, service }) =>
        Effect.succeed(
          active?.ownerUserId === ownerUserId && active.service === service ? active : null,
        ),
    }),
    Layer.mock(RelaySecretBox, {
      seal: (value) =>
        Effect.sync(() => {
          const token = `opaque-${sealed.size}`;
          sealed.set(token, value);
          return token;
        }),
      open: (token) => Effect.succeed(sealed.get(token) ?? "invalid"),
    }),
  );
  return {
    deps,
    set: (value: ConnectionRecord | null) => {
      active = value;
    },
  };
};

describe("personal issue read authorization", () => {
  it.effect(
    "allows a user's connection on either local or managed compute, without organization lookup",
    () => {
      const h = fixture();
      return Effect.gen(function* () {
        const { authorization } = yield* authorizeTurn("alice", request);
        expect(authorization).not.toContain("alice");
        const claims = yield* openTurn(authorization!);
        expect(claims).toMatchObject({
          ...request,
          ownerUserId: "alice",
          connections: { linear: "version-a" },
        });
        expect(
          yield* authorizeRead(request.environmentId, "linear").pipe(
            Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
          ),
        ).toEqual({ ownerUserId: "alice", connectionVersion: "version-a" });
        expect(yield* authorizeTurn("bob", request)).toEqual({ authorization: null });
      }).pipe(Effect.provide(h.deps));
    },
  );

  it.effect(
    "rejects environment credentials, wrong environments, expired grants, and another user",
    () => {
      const h = fixture();
      return Effect.gen(function* () {
        expect(yield* openTurn("old-managed-executor-credential").pipe(Effect.flip)).toMatchObject({
          code: "auth_invalid",
        });
        const { authorization } = yield* authorizeTurn("alice", request);
        const claims = yield* openTurn(authorization!);
        for (const principal of [
          { ...claims, environmentId: EnvironmentId.make("another-environment") },
          { ...claims, expiresAt: 0 },
          { ...claims, ownerUserId: "bob" },
        ]) {
          expect(
            yield* authorizeRead(request.environmentId, "linear").pipe(
              Effect.provideService(RelayIssueTrackerTurnPrincipal, principal),
              Effect.flip,
            ),
          ).toMatchObject({ code: "auth_invalid" });
        }
      }).pipe(Effect.provide(h.deps));
    },
  );

  it.effect("disconnect and reconnect cannot reuse a prior grant", () => {
    const h = fixture();
    return Effect.gen(function* () {
      const { authorization } = yield* authorizeTurn("alice", request);
      const claims = yield* openTurn(authorization!);
      for (const value of [null, { ...row, version: "version-b" }]) {
        h.set(value);
        expect(
          yield* authorizeRead(request.environmentId, "linear").pipe(
            Effect.provideService(RelayIssueTrackerTurnPrincipal, claims),
            Effect.flip,
          ),
        ).toMatchObject({ code: "auth_invalid" });
      }
    }).pipe(Effect.provide(h.deps));
  });
});
