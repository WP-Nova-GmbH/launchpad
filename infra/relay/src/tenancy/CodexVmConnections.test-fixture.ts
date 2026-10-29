import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";

import { makeCodexVmConnections } from "./CodexVmConnections.ts";

// The DSN is administrative only. Each case creates and drops its own database.
export const databaseUrl = process.env.CODEX_VM_AUTH_TEST_DATABASE_URL;
export const organizationId = "codex-vm-test";
export const userId = "codex-admin";
export const identity = {
  issuer: "https://auth.openai.com",
  subject: "account-one",
  clientId: "client-one",
  label: "VM account",
};
export const future = "2099-01-01T00:00:00.000Z";
export const past = "1960-01-01T00:00:00.000Z";

export const makeRequest =
  (url: string) =>
  <A, E, R>(
    use: (
      store: ReturnType<typeof makeCodexVmConnections>,
      sql: PgClient.PgClient,
    ) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      return yield* use(makeCodexVmConnections(sql), sql);
    }).pipe(
      Effect.provide([
        PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }),
        NodeCrypto.layer,
      ]),
      Effect.scoped,
    );

export const withDatabase = <A, E, R>(
  use: (request: ReturnType<typeof makeRequest>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const admin = yield* PgClient.PgClient;
    const name =
      "codex_vm_auth_" + (yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "");
    const target = new URL(databaseUrl!);
    target.pathname = "/" + name;
    return yield* Effect.acquireUseRelease(
      admin.unsafe(`CREATE DATABASE "${name}"`),
      () =>
        Effect.gen(function* () {
          const request = makeRequest(target.toString());
          yield* request((_store, sql) =>
            Effect.gen(function* () {
              const db = yield* PgDrizzle.makeWithDefaults();
              yield* migrate(db, {
                migrationsFolder: new URL("../../migrations/postgres/", import.meta.url).pathname,
                migrationsTable: "relay_migrations",
              });
              yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES(${organizationId},'Test',${past},${past})`;
              yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
            VALUES(${organizationId},${userId},'admin',${past},${past}),(${organizationId},'second-admin','admin',${past},${past})`;
            }),
          );
          // Finish child requests (including failed assertions) before dropping their database.
          return yield* use(request).pipe(Effect.forkChild, Effect.flatMap(Fiber.join));
        }),
      () => admin.unsafe(`DROP DATABASE "${name}"`).pipe(Effect.orDie),
    );
  }).pipe(
    Effect.provide([
      PgClient.layer({ url: Redacted.make(databaseUrl ?? ""), maxConnections: 1 }),
      NodeCrypto.layer,
      NodeServices.layer,
    ]),
    Effect.scoped,
  );

export const begin = (
  store: ReturnType<typeof makeCodexVmConnections>,
  stateHash: string,
  intent: "connect" | "reconnect" | "replace" = "connect",
  actor = userId,
) =>
  Effect.gen(function* () {
    const expected = yield* store.get(organizationId);
    return yield* store.beginOAuthAttempt({
      organizationId,
      userId: actor,
      intent,
      redirectUri: "http://127.0.0.1:43210/auth/callback",
      stateHash,
      pendingSealed: "sealed-pkce-and-nonce",
      expiresAt: future,
      expected,
    });
  });
export const install = (
  store: ReturnType<typeof makeCodexVmConnections>,
  attemptId: string,
  expiresAt = future,
  account = identity,
) =>
  store.install({
    organizationId,
    userId,
    attemptId,
    ...account,
    payloadSealed: "sealed-renewable-session",
    expiresAt,
    earliestRefreshAt: null,
  });
export const connect = (request: ReturnType<typeof makeRequest>, expiresAt = future) =>
  request((store) =>
    Effect.gen(function* () {
      const attempt = yield* begin(store, "initial");
      yield* store.claimCallback({
        organizationId,
        userId,
        attemptId: attempt.attemptId,
        stateHash: "initial",
        issuedClientId: identity.clientId,
      });
      return (yield* install(store, attempt.attemptId, expiresAt))!.connection;
    }),
  );
