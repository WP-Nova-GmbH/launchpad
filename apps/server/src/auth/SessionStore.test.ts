import { currentSessionChanges } from "./currentSession.ts";
import type { AuthCurrentSessionPresentation } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as ThreadPresence from "../orchestration/ThreadPresence.ts";
import { makeSessionPresenceReporter } from "../orchestration/sessionPresence.ts";
import * as Ref from "effect/Ref";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const makeServerEnvironmentLayer = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });

const makeSessionStoreLayer = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
  environmentId = EnvironmentId.make("test-environment"),
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerEnvironmentLayer(environmentId)),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const relaySessionInput = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

const makeDiskSessionStoreLayer = Effect.fn("makeDiskSessionStoreLayer")(function* (
  baseDir: string,
  token?: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  const persistence = makeSqlitePersistenceLive(paths.dbPath);
  return SessionStore.layer.pipe(
    Layer.provide(persistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerEnvironmentLayer(EnvironmentId.make(baseDir))),
    Layer.provide(
      makeServerConfigLayer({
        ...paths,
        baseDir,
        mode: "web",
        devUrl,
        ...(token === undefined ? {} : { devAuthToken: Redacted.make(token) }),
      }),
    ),
  );
});

const repositoryFailure = new PersistenceSqlError({
  operation: "AuthSessionRepository.getById:query",
  detail: "sqlite is unavailable",
});

const failingSessionLookupRepositoryLayer = Layer.succeed(AuthSessions.AuthSessionRepository, {
  create: () => Effect.void,
  createReplacingActive: () => Effect.succeed([]),
  createIfAbsent: () => Effect.void,
  getById: () => Effect.fail(repositoryFailure),
  listActive: () => Effect.succeed([]),
  revoke: () => Effect.fail(repositoryFailure),
  revokeAllExcept: () => Effect.fail(repositoryFailure),
  setLastConnectedAt: () => Effect.void,
  setClientConnection: () => Effect.void,
  setLabel: () => Effect.fail(repositoryFailure),
});

const failingSessionLookupCredentialLayer = Layer.effect(
  SessionStore.SessionStore,
  SessionStore.make,
).pipe(
  Layer.provide(failingSessionLookupRepositoryLayer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(makeServerEnvironmentLayer(EnvironmentId.make("test-environment"))),
  Layer.provide(makeServerConfigLayer()),
);

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect("keys remote cookies by environment identity instead of state directory", () =>
    Effect.gen(function* () {
      const cookieName = (stateDir: string, environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return sessions.cookieName;
        }).pipe(
          Effect.provide(
            makeSessionStoreLayer({ mode: "web", host: "192.168.1.50", stateDir }, environmentId),
          ),
        );

      const original = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-one"));
      const moved = yield* cookieName("/srv/t3-moved", EnvironmentId.make("environment-one"));
      const other = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-two"));

      expect(moved).toBe(original);
      expect(other).not.toBe(original);
    }),
  );

  it.effect("keeps reusable dev auth local across disk-backed stores and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-a-" });
      const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-b-" });
      const layerA = yield* makeDiskSessionStoreLayer(baseA, token);
      const fromA = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        const local = yield* sessions.issue({ subject: "environment-a" });
        const ticket = yield* sessions.issueWebSocketToken(local.sessionId);
        yield* sessions.revoke(dev.sessionId);
        return { dev, local, ticket };
      }).pipe(Effect.provide(layerA), Effect.scoped);

      const layerB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        expect((yield* Effect.flip(sessions.verify(fromA.local.token)))._tag).toBe(
          "InvalidSessionTokenSignatureError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(fromA.ticket.token)))._tag).toBe(
          "InvalidWebSocketTokenSignatureError",
        );
      }).pipe(Effect.provide(layerB), Effect.scoped);

      const reopenedB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(dev.sessionId);
      }).pipe(Effect.provide(reopenedB), Effect.scoped);

      const reopenedA = yield* makeDiskSessionStoreLayer(baseA, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(reopenedA), Effect.scoped);
    }),
  );

  it.effect("invalidates old dev credentials and tickets after rotation or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-rotation-" });
      const oldToken = "old-reusable-dev-auth-token-that-is-long-enough";
      const newToken = "new-reusable-dev-auth-token-that-is-long-enough";
      const initialLayer = yield* makeDiskSessionStoreLayer(baseDir, oldToken);
      const old = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(oldToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(initialLayer), Effect.scoped);

      const rotatedLayer = yield* makeDiskSessionStoreLayer(baseDir, newToken);
      const rotated = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(oldToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(old.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === old.dev.sessionId),
        ).toBe(true);
        const dev = yield* sessions.verify(newToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(rotatedLayer), Effect.scoped);

      const removedLayer = yield* makeDiskSessionStoreLayer(baseDir);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(newToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(rotated.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === rotated.dev.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(removedLayer), Effect.scoped);
    }),
  );

  it.effect("keeps the reusable token active after normal sessions expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const normal = yield* sessions.issue({ subject: "normal-session" });

      yield* TestClock.adjust(Duration.days(31));

      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
      expect((yield* Effect.flip(sessions.verify(normal.token)))._tag).toBe(
        "SessionTokenExpiredError",
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeSessionStoreLayer({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.scopes).toEqual(["orchestration:read", "access:write"]);
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("remembers the signed-in user on every verification path", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const user = { userId: "user_alice", displayName: "Alice", imageUrl: "https://img/a.png" };
      const issued = yield* sessions.issue({ subject: "cloud-connect", user });
      const verified = yield* sessions.verify(issued.token);
      expect(verified.user).toEqual(user);

      const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
      const socketSession = yield* sessions.verifyWebSocketToken(ticket.token);
      expect(socketSession.user).toEqual(user);

      const listed = yield* sessions.listActive();
      expect(listed.find((entry) => entry.sessionId === issued.sessionId)?.user).toEqual(user);

      const anonymous = yield* sessions.issue({ subject: "one-time-token" });
      expect((yield* sessions.verify(anonymous.token)).user).toBeUndefined();
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("MalformedSessionTokenError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("preserves repository failures while verifying session and websocket credentials", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "repository-failure",
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      const revokeError = yield* Effect.flip(sessions.revoke(issued.sessionId));
      const revokeOthersError = yield* Effect.flip(sessions.revokeAllExcept(issued.sessionId));

      expect(sessionError._tag).toBe("SessionCredentialVerificationError");
      expect(websocketError._tag).toBe("WebSocketTokenVerificationError");
      expect(sessionError.cause).toBe(repositoryFailure);
      expect(websocketError.cause).toBe(repositoryFailure);
      if (sessionError._tag === "SessionCredentialVerificationError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
      }
      if (websocketError._tag === "WebSocketTokenVerificationError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
      }
      expect(revokeError).toMatchObject({
        _tag: "SessionRevocationError",
        sessionId: issued.sessionId,
        cause: repositoryFailure,
      });
      expect(revokeOthersError).toMatchObject({
        _tag: "OtherSessionsRevocationError",
        currentSessionId: issued.sessionId,
        cause: repositoryFailure,
      });
    }).pipe(Effect.provide(failingSessionLookupCredentialLayer)),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-access-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ]);
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });
      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const active = yield* sessions.listActive();
      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      expect(active).toHaveLength(2);
      expect(active.find((entry) => entry.sessionId === browser.sessionId)).toBeDefined();
      expect(
        active.filter(
          (entry) =>
            entry.subject === "desktop-bootstrap" && entry.method === "bearer-access-token",
        ),
      ).toHaveLength(1);
      expect(bearerVerification.filter(Option.isSome)).toHaveLength(1);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect(
    "replaces only the expected desktop session, preserving scopes and retiring its sockets",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const original = yield* sessions.issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          scopes: ["access:write", "orchestration:operate"],
          client: { deviceType: "desktop", label: "My desktop" },
        });
        const unrelated = yield* sessions.issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
        });
        const closing = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        yield* sessions.registerConnection(
          original.sessionId,
          Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(drained))),
        );
        const user = { userId: "user-a", displayName: "Alice", imageUrl: null };
        const replacement = yield* sessions
          .replaceDesktopIdentity(original.sessionId, user)
          .pipe(Effect.forkChild);
        yield* Deferred.await(closing);
        expect(yield* sessions.verify(original.token).pipe(Effect.flip)).toMatchObject({
          _tag: "SessionTokenRevokedError",
        });
        yield* Deferred.succeed(drained, undefined);
        const next = yield* Fiber.join(replacement);
        expect(yield* sessions.verify(next.token)).toMatchObject({
          user,
          scopes: original.scopes,
          client: original.client,
        });
        expect((yield* sessions.verify(unrelated.token)).sessionId).toBe(unrelated.sessionId);
        expect(
          yield* sessions.replaceDesktopIdentity(original.sessionId, user).pipe(Effect.flip),
        ).toMatchObject({ _tag: "SessionTokenRevokedError" });
        expect(
          yield* sessions.registerConnection(original.sessionId, Effect.void).pipe(Effect.flip),
        ).toMatchObject({ _tag: "SessionTokenRevokedError" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_identity_replace BEFORE INSERT ON auth_sessions
          BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`;
        expect(
          yield* sessions.replaceDesktopIdentity(next.sessionId, null).pipe(Effect.flip),
        ).toMatchObject({ _tag: "SessionCredentialIssueError" });
        expect((yield* sessions.verify(next.token)).user).toEqual(user);
        yield* sql`DROP TRIGGER reject_identity_replace`;
        const anonymous = yield* sessions.replaceDesktopIdentity(next.sessionId, null);
        expect((yield* sessions.verify(anonymous.token)).user).toBeUndefined();
      }).pipe(Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), SqlitePersistenceMemory))),
  );

  it.effect(
    "permits only one concurrent identity replacement and rejects ordinary paired sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const original = yield* sessions.issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
        });
        const results = yield* Effect.forEach(
          ["alice", "bob"],
          (userId) =>
            sessions
              .replaceDesktopIdentity(original.sessionId, {
                userId,
                displayName: userId,
                imageUrl: null,
              })
              .pipe(Effect.option),
          { concurrency: "unbounded" },
        );
        expect(results.filter(Option.isSome)).toHaveLength(1);
        expect(yield* sessions.listActive()).toHaveLength(1);
        const paired = yield* sessions.issue({
          subject: "one-time-token",
          method: "bearer-access-token",
        });
        expect(
          yield* sessions.replaceDesktopIdentity(paired.sessionId, null).pipe(Effect.flip),
        ).toMatchObject({ _tag: "UnknownSessionTokenError" });
      }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SessionCredentialIssueError");
      expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        previous.sessionId,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), SqlitePersistenceMemory))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("includes expiry context when session and websocket tokens expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived-token",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId, {
        ttl: Duration.seconds(1),
      });

      yield* TestClock.adjust(Duration.seconds(2));

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));

      expect(sessionError._tag).toBe("SessionTokenExpiredError");
      if (sessionError._tag === "SessionTokenExpiredError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
        expect(sessionError.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(sessionError.observedAt.epochMilliseconds).toBeGreaterThan(
          sessionError.expiresAt.epochMilliseconds,
        );
      }
      expect(websocketError._tag).toBe("WebSocketTokenExpiredError");
      if (websocketError._tag === "WebSocketTokenExpiredError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
        expect(websocketError.expiresAt.epochMilliseconds).toBe(
          websocket.expiresAt.epochMilliseconds,
        );
        expect(websocketError.observedAt.epochMilliseconds).toBeGreaterThan(
          websocketError.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-access-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("keeps connected relay sessions visible through expiry and HTTP renewal", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const original = yield* sessions.issue(relaySessionInput);
      const websocket = yield* sessions.issueWebSocketToken(original.sessionId, {
        ttl: Duration.hours(2),
      });
      yield* sessions.verifyWebSocketToken(websocket.token);
      yield* sessions.markConnected(original.sessionId);
      const beforeExpiry = yield* sessions.listActive();
      expect(beforeExpiry).toHaveLength(1);
      expect(beforeExpiry[0]?.connected).toBe(true);

      yield* TestClock.adjust(Duration.minutes(61));

      expect(yield* sessions.listActive()).toEqual(beforeExpiry);
      expect(yield* Effect.flip(sessions.verify(original.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
      expect(yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token))).toMatchObject({
        _tag: "WebSocketSessionExpiredError",
      });

      const renewed = yield* sessions.issue(relaySessionInput);
      const afterRenewal = yield* sessions.listActive();
      expect(renewed.sessionId).not.toBe(original.sessionId);
      expect(afterRenewal).toHaveLength(2);
      expect(afterRenewal).toEqual(
        expect.arrayContaining([
          beforeExpiry[0],
          expect.objectContaining({
            sessionId: renewed.sessionId,
            connected: false,
            lastConnectedAt: null,
          }),
        ]),
      );
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect.each([1, 2])(
    "removes an expired session from listings and updates after its last of %s sockets closes",
    (socketCount) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue(relaySessionInput);
        const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
        yield* sessions.streamChanges.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        for (let index = 0; index < socketCount; index += 1) {
          yield* sessions.markConnected(issued.sessionId);
          expect(yield* Queue.take(changes)).toMatchObject({
            type: "clientUpserted",
            clientSession: { sessionId: issued.sessionId, connected: true },
          });
        }

        yield* TestClock.adjust(Duration.minutes(61));

        for (let remaining = socketCount - 1; remaining >= 0; remaining -= 1) {
          yield* sessions.markDisconnected(issued.sessionId);
          const change = yield* Queue.take(changes);
          const listed = yield* sessions.listActive();
          if (remaining > 0) {
            expect(change).toMatchObject({
              type: "clientUpserted",
              clientSession: { sessionId: issued.sessionId, connected: true },
            });
            expect(listed).toHaveLength(1);
            expect(listed[0]?.connected).toBe(true);
          } else {
            expect(change).toEqual({ type: "clientRemoved", sessionId: issued.sessionId });
            expect(listed).toEqual([]);
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer())),
      ),
  );

  it.effect.each(["revoke", "revokeAllExcept"] as const)(
    "removes expired connected sessions with %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const administrative = yield* sessions.issue({ subject: "desktop-bootstrap" });
        const client = yield* sessions.issue(relaySessionInput);
        yield* sessions.markConnected(client.sessionId);
        yield* TestClock.adjust(Duration.minutes(61));
        const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
        yield* sessions.streamChanges.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );

        if (operation === "revoke") {
          expect(yield* sessions.revoke(client.sessionId)).toBe(true);
        } else {
          expect(yield* sessions.revokeAllExcept(administrative.sessionId)).toBe(1);
        }

        expect(yield* Queue.take(changes)).toEqual({
          type: "clientRemoved",
          sessionId: client.sessionId,
        });
        const listed = yield* sessions.listActive();
        expect(listed).toHaveLength(1);
        expect(listed[0]?.sessionId).toBe(administrative.sessionId);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer())),
      ),
  );

  it.effect("records client connection metadata without clearing prior values", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const issued = yield* sessions.issue({
        subject: "client-connection-test",
        method: "bearer-access-token",
      });
      const readRow = sql<{
        readonly surface: string | null;
        readonly appVersion: string | null;
      }>`
        SELECT client_surface AS "surface", client_app_version AS "appVersion"
        FROM auth_sessions
        WHERE session_id = ${issued.sessionId}
      `;

      yield* sessions.recordClientConnection(issued.sessionId, {
        surface: "mobile",
        appVersion: "1.2.0",
      });
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.2.0" });

      // A partial report (old or minimal client) must not null out stored data.
      yield* sessions.recordClientConnection(issued.sessionId, { appVersion: "1.3.0" });
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.3.0" });

      yield* sessions.recordClientConnection(issued.sessionId, {});
      expect((yield* readRow)[0]).toEqual({ surface: "mobile", appVersion: "1.3.0" });
    }).pipe(Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), SqlitePersistenceMemory))),
  );
  it.effect("publishes only the current session's live name and clears revoked presentation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const own = yield* sessions.issue({
        subject: "one-time-token",
        client: { deviceType: "desktop", label: "Original" },
      });
      const other = yield* sessions.issue({
        client: { deviceType: "desktop", label: "Other client" },
      });
      const updates = yield* Queue.unbounded<AuthCurrentSessionPresentation | null>();
      yield* currentSessionChanges(own.sessionId).pipe(
        Stream.runForEach((value) => Queue.offer(updates, value)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(updates)).toMatchObject({
        sessionId: own.sessionId,
        client: { label: "Original" },
        needsClientLabel: false,
      });
      yield* sessions.rename(other.sessionId, "Other renamed");
      yield* sessions.rename(own.sessionId, "New name");
      expect(yield* Queue.take(updates)).toMatchObject({
        sessionId: own.sessionId,
        client: { label: "New name" },
      });
      yield* sessions.revoke(own.sessionId);
      expect(yield* Queue.take(updates)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(makeSessionStoreLayer())),
  );

  it.effect.each(["rename", "revoke"] as const)(
    "retains current presentation when %s races its initial snapshot",
    (change) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const own = yield* sessions.issue({ client: { deviceType: "desktop", label: "Original" } });
        const initialRead = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const updates = yield* Queue.unbounded<AuthCurrentSessionPresentation | null>();
        let firstRead = true;
        const delayed = {
          ...sessions,
          getActive: (id: Parameters<typeof sessions.getActive>[0]) =>
            Effect.gen(function* () {
              const value = yield* sessions.getActive(id);
              if (firstRead) {
                firstRead = false;
                yield* Deferred.succeed(initialRead, undefined);
                yield* Deferred.await(releaseRead);
              }
              return value;
            }),
        };
        yield* currentSessionChanges(own.sessionId).pipe(
          Stream.provideService(SessionStore.SessionStore, delayed),
          Stream.runForEach((value) => Queue.offer(updates, value)),
          Effect.forkScoped,
        );
        yield* Deferred.await(initialRead);
        yield* sessions.rename(own.sessionId, "First rename");
        yield* sessions.rename(own.sessionId, "Latest name");
        if (change === "revoke") yield* sessions.revoke(own.sessionId);
        yield* Deferred.succeed(releaseRead, undefined);
        expect(yield* Queue.take(updates)).toMatchObject({ client: { label: "Original" } });
        const current = yield* Queue.take(updates);
        if (change === "revoke") expect(current).toBeNull();
        else expect(current).toMatchObject({ client: { label: "Latest name" } });
      }).pipe(Effect.scoped, Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("renames only presentation without rotating access or reconnecting the client", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
        client: { deviceType: "mobile", label: "Old" },
        user: {
          userId: "verified",
          displayName: "Alice",
          imageUrl: null,
          email: "alice@example.com",
        },
      });
      const before = yield* sessions.verify(issued.token);
      const unregister = yield* sessions.registerConnection(
        issued.sessionId,
        Effect.die("Rename must not disconnect the socket"),
      );
      yield* sessions.markConnected(issued.sessionId);
      const renamed = yield* sessions.rename(issued.sessionId, "My phone");
      const after = yield* sessions.verify(issued.token);
      expect(after).toEqual({ ...before, client: { ...before.client, label: "My phone" } });
      expect(renamed.client.label).toBe("My phone");
      expect(renamed.user?.email).toBe("alice@example.com");
      expect(renamed.connected).toBe(true);
      yield* Effect.sync(unregister);
      yield* sessions.revoke(issued.sessionId);
      expect((yield* sessions.rename(issued.sessionId, "No revival").pipe(Effect.flip))._tag).toBe(
        "UnknownSessionTokenError",
      );
      expect(Option.isNone(yield* sessions.getActive(issued.sessionId))).toBe(true);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("a queued old report cannot undo a rename after the refreshed name publishes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        client: { deviceType: "mobile", label: "Old phone" },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let blockReport = true;
      const report = yield* makeSessionPresenceReporter("socket", issued.sessionId).pipe(
        Effect.provideService(ThreadPresence.ThreadPresenceService, {
          ...presence,
          report: (input) =>
            Effect.gen(function* () {
              if (blockReport) {
                blockReport = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              yield* presence.report(input);
            }),
        }),
      );
      const { changes } = yield* presence.subscribe;
      const renamedSnapshot = yield* changes.pipe(
        Stream.filter((snapshot) => snapshot.participants[0]?.clientLabel === "New phone"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const first = yield* report({ threadId: ThreadId.make("thread"), typing: true }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* sessions.rename(issued.sessionId, "New phone");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(renamedSnapshot);
      expect((yield* presence.snapshot).participants[0]).toMatchObject({
        clientLabel: "New phone",
        typing: true,
        threadId: "thread",
      });
      yield* report({ threadId: ThreadId.make("thread"), typing: false });
      expect((yield* presence.snapshot).participants[0]).toMatchObject({
        clientLabel: "New phone",
        typing: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), ThreadPresence.layer)),
    ),
  );

  it.effect("a report waiting behind a rename refresh reads the newest presentation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        client: { deviceType: "mobile", label: "Old" },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pause = yield* Ref.make(false);
      const report = yield* makeSessionPresenceReporter("socket", issued.sessionId).pipe(
        Effect.provideService(SessionStore.SessionStore, {
          ...sessions,
          getActive: (id) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(pause, false)) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* sessions.getActive(id);
            }),
        }),
      );
      yield* report({ threadId: ThreadId.make("thread"), typing: true });
      yield* Ref.set(pause, true);
      yield* sessions.rename(issued.sessionId, "New");
      yield* Deferred.await(entered);
      const queued = yield* report({ threadId: ThreadId.make("thread"), typing: false }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(queued);
      expect((yield* presence.snapshot).participants[0]).toMatchObject({
        clientLabel: "New",
        typing: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), ThreadPresence.layer)),
    ),
  );

  it.effect("stale upserts refresh from storage and cannot resurrect a revoked participant", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        client: { deviceType: "mobile", label: "Old" },
      });
      const stale = Option.getOrThrow(yield* sessions.getActive(issued.sessionId));
      const queue = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
      const report = yield* makeSessionPresenceReporter("socket", issued.sessionId).pipe(
        Effect.provideService(SessionStore.SessionStore, {
          ...sessions,
          subscribeChanges: Effect.succeed(Stream.fromQueue(queue)),
        }),
      );
      yield* report({ threadId: ThreadId.make("thread"), typing: true });
      const { changes } = yield* presence.subscribe;
      const renamed = yield* changes.pipe(
        Stream.filter((snapshot) => snapshot.participants[0]?.clientLabel === "New"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* sessions.rename(issued.sessionId, "New");
      yield* Queue.offer(queue, { type: "clientUpserted", clientSession: stale });
      yield* Fiber.join(renamed);
      expect((yield* presence.snapshot).participants[0]?.typing).toBe(true);
      const removed = yield* changes.pipe(
        Stream.filter((snapshot) => snapshot.participants.length === 0),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* sessions.revoke(issued.sessionId);
      yield* Queue.offer(queue, { type: "clientUpserted", clientSession: stale });
      yield* Fiber.join(removed);
      yield* report({ threadId: ThreadId.make("thread"), typing: true });
      expect((yield* presence.snapshot).participants).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), ThreadPresence.layer)),
    ),
  );
  it.effect("persists a renamed client's credential and name across a server restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "launchpad-client-rename-" });
      const firstLayer = yield* makeDiskSessionStoreLayer(baseDir);
      const issued = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({
          subject: "one-time-token",
          method: "bearer-access-token",
          client: { deviceType: "mobile", label: "Old" },
        });
        yield* sessions.rename(issued.sessionId, "My phone");
        return issued;
      }).pipe(Effect.provide(firstLayer), Effect.scoped);
      const nextLayer = yield* makeDiskSessionStoreLayer(baseDir);
      const restored = yield* SessionStore.SessionStore.pipe(
        Effect.flatMap((sessions) => sessions.verify(issued.token)),
        Effect.provide(nextLayer),
        Effect.scoped,
      );
      expect(restored).toMatchObject({
        sessionId: issued.sessionId,
        client: { label: "My phone" },
      });
    }),
  );

  it.effect("a presentation-only rename keeps the original typing lease", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const issued = yield* sessions.issue({
        subject: "one-time-token",
        method: "bearer-access-token",
        client: { deviceType: "mobile", label: "Old" },
      });
      const report = yield* makeSessionPresenceReporter("socket", issued.sessionId);
      yield* report({ threadId: ThreadId.make("thread"), typing: true });
      yield* TestClock.adjust(6_000);
      const { changes } = yield* presence.subscribe;
      const renamed = yield* changes.pipe(
        Stream.filter((snapshot) => snapshot.participants[0]?.clientLabel === "New"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* sessions.rename(issued.sessionId, "New");
      yield* Fiber.join(renamed);
      const expired = yield* changes.pipe(
        Stream.filter((snapshot) => snapshot.participants[0]?.typing === false),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust(4_000);
      yield* Fiber.join(expired);
      expect((yield* presence.snapshot).participants[0]).toMatchObject({
        clientLabel: "New",
        threadId: "thread",
        typing: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(makeSessionStoreLayer(), ThreadPresence.layer)),
    ),
  );
});
