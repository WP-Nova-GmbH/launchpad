import type {
  RelayIssueTrackerConnection,
  RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayDb } from "../db.ts";
import { relayUserIssueTrackerConnections as connections } from "../persistence/schema.ts";

export type ConnectionRecord = typeof connections.$inferSelect;
export type ConnectionKey = {
  readonly ownerUserId: string;
  readonly service: RelayIssueTrackerService;
};

export class ConnectionPersistenceError extends Schema.TaggedError<ConnectionPersistenceError>()(
  "IssueTrackerConnectionPersistenceError",
  { cause: Schema.Defect() },
) {}

export class ConnectionStore extends Context.Service<
  ConnectionStore,
  {
    readonly list: (
      ownerUserId: string,
    ) => Effect.Effect<ReadonlyArray<ConnectionRecord>, ConnectionPersistenceError>;
    readonly get: (
      key: ConnectionKey,
    ) => Effect.Effect<ConnectionRecord | null, ConnectionPersistenceError>;
    readonly findPending: (
      stateHash: string,
    ) => Effect.Effect<ConnectionRecord | null, ConnectionPersistenceError>;
    readonly begin: (
      input: ConnectionKey & {
        readonly userId: string;
        readonly stateHash: string;
        readonly pendingOAuthSealed?: string;
        readonly expiresAt: string;
      },
    ) => Effect.Effect<ConnectionRecord, ConnectionPersistenceError>;
    readonly claimAuthorization: (
      input: ConnectionKey & {
        readonly version: string;
        readonly authorizationId: string;
        readonly stateHash: string;
      },
    ) => Effect.Effect<boolean, ConnectionPersistenceError>;
    readonly cancelAuthorization: (
      input: ConnectionKey & { readonly authorizationId: string; readonly expiresAt?: string },
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly awaitJiraSelection: (
      input: ConnectionKey & {
        readonly version: string;
        readonly authorizationId: string;
        readonly expiresAt: string;
        readonly selection: NonNullable<ConnectionRecord["jiraSelection"]>;
      },
    ) => Effect.Effect<boolean, ConnectionPersistenceError>;
    readonly proposeReplacement: (
      input: ConnectionKey & {
        readonly version: string;
        readonly authorizationId: string;
        readonly replacement: NonNullable<ConnectionRecord["replacement"]>;
      },
    ) => Effect.Effect<boolean, ConnectionPersistenceError>;
    readonly cancelReplacement: (
      input: ConnectionKey & { readonly version: string; readonly proposalId: string },
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly complete: (
      input: ConnectionKey & {
        readonly version: string;
        readonly payloadSealed: string;
        readonly accountLabel: string;
        readonly userId?: string;
      },
    ) => Effect.Effect<boolean, ConnectionPersistenceError>;
    readonly refresh: (
      input: ConnectionKey & { readonly version: string; readonly payloadSealed: string },
    ) => Effect.Effect<boolean, ConnectionPersistenceError>;
    readonly requireReconnect: (
      input: ConnectionKey & { readonly version: string; readonly payloadSealed: string | null },
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (key: ConnectionKey) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly withLock: <A, E, R>(
      key: ConnectionKey,
      use: (record: ConnectionRecord | null) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ConnectionPersistenceError, R>;
  }
>()("launchpad-relay/issueTrackers/ConnectionStore") {}

export const metadata = (
  row: ConnectionRecord,
  includeJiraSites = false,
): RelayIssueTrackerConnection => ({
  service: row.service,
  status: row.status,
  accountLabel: row.accountLabel,
  updatedAt: row.updatedAt,
  ...(row.authorizationId && row.pendingExpiresAt
    ? {
        authorization: {
          id: row.authorizationId,
          phase: row.jiraSelection
            ? ("selecting_site" as const)
            : row.pendingStateHash
              ? ("pending" as const)
              : ("exchanging" as const),
          expiresAt: row.pendingExpiresAt,
        },
      }
    : {}),
  ...(includeJiraSites && row.service === "jira" && row.jiraSelection
    ? { jiraSites: row.jiraSelection.sites }
    : {}),
  ...(row.service === "linear" && row.replacement
    ? {
        replacement: {
          id: row.replacement.id,
          workspaceId: row.replacement.workspaceId,
          currentWorkspaceId: row.replacement.currentWorkspaceId,
          accountLabel: row.replacement.accountLabel,
          currentAccountLabel: row.replacement.currentAccountLabel,
          expiresAt: row.replacement.expiresAt,
        },
      }
    : {}),
});

export const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const crypto = yield* Crypto.Crypto;
  const where = (key: ConnectionKey) =>
    and(eq(connections.ownerUserId, key.ownerUserId), eq(connections.service, key.service));
  const current = (key: ConnectionKey & { readonly version: string }) =>
    and(where(key), eq(connections.version, key.version));
  const fail = (cause: unknown) => new ConnectionPersistenceError({ cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(fail));
  const get = (key: ConnectionKey) =>
    db
      .select()
      .from(connections)
      .where(where(key))
      .pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(fail),
      );

  return ConnectionStore.of({
    list: (ownerUserId) =>
      db
        .select()
        .from(connections)
        .where(eq(connections.ownerUserId, ownerUserId))
        .pipe(Effect.mapError(fail)),
    get,
    findPending: (stateHash) =>
      db
        .select()
        .from(connections)
        .where(eq(connections.pendingStateHash, stateHash))
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(fail),
        ),
    begin: Effect.fn("issueTrackers.begin")(function* (input) {
      const version = yield* uuid;
      const updatedAt = yield* now;
      // Pending OAuth must not invalidate reads using the active connection.
      const pending = {
        authorizationId: yield* uuid,
        replacement: null,
        jiraSelection: null,
        pendingOAuthSealed: input.pendingOAuthSealed ?? null,
        pendingStateHash: input.stateHash,
        pendingExpiresAt: input.expiresAt,
        updatedByUserId: input.userId,
        updatedAt,
      };
      const rows = yield* db
        .insert(connections)
        .values({
          ownerUserId: input.ownerUserId,
          service: input.service,
          status: "connecting",
          version,
          ...pending,
        })
        .onConflictDoUpdate({
          target: [connections.ownerUserId, connections.service],
          set: pending,
        })
        .returning()
        .pipe(Effect.mapError(fail));
      return rows[0]!;
    }),
    claimAuthorization: (input) =>
      db
        .update(connections)
        .set({ pendingStateHash: null })
        .where(
          and(
            current(input),
            eq(connections.authorizationId, input.authorizationId),
            eq(connections.pendingStateHash, input.stateHash),
          ),
        )
        .returning({ version: connections.version })
        .pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(fail),
        ),
    cancelAuthorization: (input) =>
      db.$client
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* get(input);
            if (!row || row.authorizationId !== input.authorizationId) return;
            const match = and(
              where(input),
              eq(connections.authorizationId, input.authorizationId),
              input.expiresAt ? eq(connections.pendingExpiresAt, input.expiresAt) : undefined,
            );
            if (row.payloadSealed === null) {
              yield* db.delete(connections).where(match).pipe(Effect.mapError(fail));
            } else {
              yield* db
                .update(connections)
                .set({
                  authorizationId: null,
                  pendingOAuthSealed: null,
                  pendingStateHash: null,
                  pendingExpiresAt: null,
                  jiraSelection: null,
                })
                .where(match)
                .pipe(Effect.mapError(fail));
            }
          }),
        )
        .pipe(Effect.mapError(fail)),
    awaitJiraSelection: (input) =>
      db
        .update(connections)
        .set({
          jiraSelection: input.selection,
          pendingExpiresAt: input.expiresAt,
          pendingOAuthSealed: null,
        })
        .where(
          and(
            current(input),
            eq(connections.authorizationId, input.authorizationId),
            isNull(connections.pendingStateHash),
          ),
        )
        .returning({ version: connections.version })
        .pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(fail),
        ),
    proposeReplacement: (input) =>
      db
        .update(connections)
        .set({
          replacement: input.replacement,
          authorizationId: null,
          pendingOAuthSealed: null,
          pendingStateHash: null,
          pendingExpiresAt: null,
        })
        .where(
          and(
            current(input),
            eq(connections.authorizationId, input.authorizationId),
            isNull(connections.pendingStateHash),
          ),
        )
        .returning({ version: connections.version })
        .pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(fail),
        ),
    cancelReplacement: (input) =>
      db
        .update(connections)
        .set({ replacement: null })
        .where(and(current(input), sql`${connections.replacement}->>'id' = ${input.proposalId}`))
        .pipe(Effect.asVoid, Effect.mapError(fail)),
    complete: Effect.fn("issueTrackers.complete")(function* (input) {
      const rows = yield* db
        .update(connections)
        .set({
          version: yield* uuid,
          status: "connected",
          payloadSealed: input.payloadSealed,
          accountLabel: input.accountLabel,
          ...(input.userId ? { updatedByUserId: input.userId } : {}),
          authorizationId: null,
          replacement: null,
          jiraSelection: null,
          pendingOAuthSealed: null,
          pendingStateHash: null,
          pendingExpiresAt: null,
          updatedAt: yield* now,
        })
        .where(current(input))
        .returning({ version: connections.version })
        .pipe(Effect.mapError(fail));
      return rows.length === 1;
    }),
    refresh: Effect.fn("issueTrackers.refresh")(function* (input) {
      const rows = yield* db
        .update(connections)
        .set({ payloadSealed: input.payloadSealed })
        .where(current(input))
        .returning({ version: connections.version })
        .pipe(Effect.mapError(fail));
      return rows.length === 1;
    }),
    requireReconnect: (input) =>
      db
        .update(connections)
        .set({ status: "reconnect_required" })
        .where(
          and(
            current(input),
            input.payloadSealed === null
              ? isNull(connections.payloadSealed)
              : eq(connections.payloadSealed, input.payloadSealed),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(fail)),
    remove: (key) =>
      db.delete(connections).where(where(key)).pipe(Effect.asVoid, Effect.mapError(fail)),
    withLock: (key, use) =>
      db.$client
        .withTransaction(
          db
            .select()
            .from(connections)
            .where(where(key))
            .for("update")
            .pipe(
              Effect.mapError(fail),
              Effect.flatMap((rows) => use(rows[0] ?? null)),
            ),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(fail(cause)))),
  });
});

export const layer = Layer.effect(ConnectionStore, make);
