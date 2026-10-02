import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RelayDb } from "../db.ts";
import { relayIssueTrackerConnections, relayOrganizations } from "../persistence/schema.ts";
import { make as makeStore } from "./ConnectionStore.ts";
import { encodeJson, fixture, jiraRow, jiraOAuth, membership } from "./Connections.test-fixture.ts";
import { cancelJiraSelection, jiraCredentials, selectJiraSite } from "./JiraAuthorization.ts";

// Explicitly opt in with an isolated, migrated database; never load live relay configuration.
const databaseUrl = process.env.JIRA_SELECTION_TEST_DATABASE_URL;
const databaseLayer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "") })),
  Layer.provideMerge(NodeCrypto.layer),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(databaseLayer), Effect.scoped);
const actor = { organizationId: "jira-site-picker-test", userId: "admin" };
const key = { organizationId: actor.organizationId, service: "jira" as const };
const sites = [
  { cloudId: "a", siteUrl: "https://a.atlassian.net", accountLabel: "Site A" },
  { cloudId: "b", siteUrl: "https://b.atlassian.net", accountLabel: "Site B" },
];
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, id: Schema.optionalKey(Schema.Number) }),
  ),
);
const setup = Effect.gen(function* () {
  const db = yield* RelayDb;
  const original = { ...jiraRow(), ...key };
  yield* db
    .insert(relayOrganizations)
    .values({
      organizationId: actor.organizationId,
      name: "Test",
      createdAt: original.updatedAt,
      updatedAt: original.updatedAt,
    })
    .onConflictDoNothing();
  yield* db
    .delete(relayIssueTrackerConnections)
    .where(eq(relayIssueTrackerConnections.organizationId, actor.organizationId));
  yield* db.insert(relayIssueTrackerConnections).values(original);
  const store = yield* makeStore;
  const pending = yield* store.begin({
    ...key,
    userId: actor.userId,
    stateHash: "test-state",
    pendingOAuthSealed: "sealed:pending-sdk-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  expect((yield* store.get(key))?.pendingOAuthSealed).toBe("sealed:pending-sdk-session");
  yield* store.claimAuthorization({
    ...pending,
    authorizationId: pending.authorizationId!,
    stateHash: "test-state",
  });
  expect((yield* store.get(key))?.pendingOAuthSealed).toBe("sealed:pending-sdk-session");
  expect(
    yield* store.awaitJiraSelection({
      ...pending,
      authorizationId: pending.authorizationId!,
      expiresAt: "2099-01-01T00:00:00.000Z",
      selection: {
        sites,
        payloadSealed: `sealed:${encodeJson({ service: "jira", authType: "oauth", oauth: jiraOAuth, accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.parse("2099-01-01") })}`,
      },
    }),
  ).toBe(true);
  expect((yield* store.get(key))?.pendingOAuthSealed).toBeNull();
  const test = yield* fixture({
    store,
    membership: Effect.succeed({
      ...membership,
      organization: { ...membership.organization, organizationId: actor.organizationId },
    }),
    respond: (request) => {
      if (request.method === "DELETE") return Effect.succeed(new Response(null, { status: 204 }));
      if (request.body._tag !== "Uint8Array") return Effect.die("Expected MCP request");
      const rpc = decodeRpc(new TextDecoder().decode(request.body.body));
      if (rpc.method === "notifications/initialized")
        return Effect.succeed(new Response(null, { status: 202 }));
      return Effect.succeed(
        Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result:
            rpc.method === "initialize"
              ? { protocolVersion: "2025-11-25" }
              : {
                  structuredContent: sites.map((site) => ({
                    id: site.cloudId,
                    url: site.siteUrl,
                    name: site.accountLabel,
                    scopes: ["read:jira:agent-interface"],
                  })),
                },
        }),
      );
    },
  });
  return { ...test, original, authorizationId: pending.authorizationId! };
});

describe.skipIf(!databaseUrl)("Jira site selection (PostgreSQL)", () => {
  it.effect("keeps the existing grant until the selected site is activated atomically", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        expect((yield* test.store.get(key))?.payloadSealed).toBe(test.original.payloadSealed);
        yield* selectJiraSite({
          ...actor,
          authorizationId: test.authorizationId,
          cloudId: "b",
        }).pipe(test.provide);
        const active = yield* jiraCredentials(key).pipe(test.provide);
        expect(active.credentials).toMatchObject({
          cloudId: "b",
          siteUrl: "https://b.atlassian.net",
          accessToken: "new-access",
        });
        expect(active.row.jiraSelection).toBeNull();
        expect(active.row.authorizationId).toBeNull();
        expect(active.row.version).not.toBe(test.original.version);
      }),
    ),
  );

  it.effect("cancels only the matching choice and preserves the active grant", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* cancelJiraSelection({ ...actor, authorizationId: test.authorizationId }).pipe(
          test.provide,
        );
        const cancelled = (yield* test.store.get(key))!;
        expect(cancelled.payloadSealed).toBe(test.original.payloadSealed);
        expect(cancelled.jiraSelection).toBeNull();
        const newer = yield* test.store.begin({
          ...key,
          userId: actor.userId,
          stateHash: "new-state",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
        yield* test.store.cancelAuthorization({ ...key, authorizationId: test.authorizationId });
        expect((yield* test.store.get(key))?.authorizationId).toBe(newer.authorizationId);
        expect(
          yield* test.store.awaitJiraSelection({
            ...key,
            version: newer.version,
            authorizationId: test.authorizationId,
            expiresAt: "2099-01-01T00:00:00.000Z",
            selection: { sites, payloadSealed: "stale" },
          }),
        ).toBe(false);
      }),
    ),
  );
  it.effect("does not let stale OAuth expiry cleanup discard a newer site-selection deadline", () =>
    run(
      Effect.gen(function* () {
        const test = yield* setup;
        const row = (yield* test.store.get(key))!;
        yield* test.store.cancelAuthorization({
          ...key,
          authorizationId: test.authorizationId,
          expiresAt: "2098-01-01T00:00:00.000Z",
        });
        expect(yield* test.store.get(key)).toEqual(row);
        yield* test.store.cancelAuthorization({
          ...key,
          authorizationId: test.authorizationId,
          expiresAt: row.pendingExpiresAt!,
        });
        expect((yield* test.store.get(key))?.jiraSelection).toBeNull();
        expect((yield* test.store.get(key))?.payloadSealed).toBe(test.original.payloadSealed);
      }),
    ),
  );
});
