import type { RelayRepositoryRole } from "@t3tools/contracts/relay";
import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayRepositories,
  relayRepositoryAccess,
  relayRepositoryAliases,
} from "../persistence/schema.ts";

export interface RepositoryRecord {
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly canonicalKeys: ReadonlyArray<string>;
  readonly createdAt: string;
}

export interface RepositoryAccessRecord {
  readonly userId: string;
  readonly role: RelayRepositoryRole;
  readonly grantedAt: string;
}

export class RepositoryPersistenceError extends Schema.TaggedErrorClass<RepositoryPersistenceError>()(
  "RepositoryPersistenceError",
  {
    operation: Schema.Literals([
      "register-repository",
      "load-repository",
      "list-repositories",
      "delete-repository",
      "add-alias",
      "remove-alias",
      "list-aliases",
      "load-access",
      "list-access",
      "grant-access",
      "revoke-access",
    ]),
    repositoryId: Schema.optionalKey(Schema.String),
    organizationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Repository '${this.operation}' failed`;
  }
}

/**
 * A canonical key belongs to exactly one repository, anywhere (ADR-0006). The
 * clash is a normal answer to "register this checkout", not a fault, so it is
 * its own error rather than a persistence failure.
 */
export class RepositoryCanonicalKeyTaken extends Schema.TaggedErrorClass<RepositoryCanonicalKeyTaken>()(
  "RepositoryCanonicalKeyTaken",
  {
    canonicalKey: Schema.String,
  },
) {
  override get message(): string {
    return `Canonical key '${this.canonicalKey}' already belongs to a repository`;
  }
}

const repositoryColumns = {
  repositoryId: relayRepositories.repositoryId,
  organizationId: relayRepositories.organizationId,
  name: relayRepositories.name,
  createdAt: relayRepositories.createdAt,
};

interface RepositoryRow {
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: string;
}

export class Repositories extends Context.Service<
  Repositories,
  {
    /**
     * Registers a repository from a checkout: the repository row, its first
     * canonical key, and a maintainer grant for whoever registered it — a
     * repository nobody maintains would be immediately unusable.
     */
    readonly register: (input: {
      readonly repositoryId: string;
      readonly organizationId: string;
      readonly name: string;
      readonly canonicalKey: string;
      readonly createdByUserId: string;
    }) => Effect.Effect<RepositoryRecord, RepositoryPersistenceError | RepositoryCanonicalKeyTaken>;
    readonly getById: (input: {
      readonly repositoryId: string;
    }) => Effect.Effect<RepositoryRecord | null, RepositoryPersistenceError>;
    readonly findByCanonicalKey: (input: {
      readonly canonicalKey: string;
    }) => Effect.Effect<RepositoryRecord | null, RepositoryPersistenceError>;
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<RepositoryRecord>, RepositoryPersistenceError>;
    readonly deleteRepository: (input: {
      readonly repositoryId: string;
    }) => Effect.Effect<boolean, RepositoryPersistenceError>;
    readonly addAlias: (input: {
      readonly repositoryId: string;
      readonly organizationId: string;
      readonly canonicalKey: string;
    }) => Effect.Effect<void, RepositoryPersistenceError | RepositoryCanonicalKeyTaken>;
    /** Refuses the last key: a repository no checkout can match is unreachable. */
    readonly removeAlias: (input: {
      readonly repositoryId: string;
      readonly canonicalKey: string;
    }) => Effect.Effect<"removed" | "not-found" | "last-alias", RepositoryPersistenceError>;
    readonly listAccess: (input: {
      readonly repositoryId: string;
    }) => Effect.Effect<ReadonlyArray<RepositoryAccessRecord>, RepositoryPersistenceError>;
    readonly getAccess: (input: {
      readonly repositoryId: string;
      readonly userId: string;
    }) => Effect.Effect<RelayRepositoryRole | null, RepositoryPersistenceError>;
    readonly listAccessForUser: (input: {
      readonly userId: string;
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyMap<string, RelayRepositoryRole>, RepositoryPersistenceError>;
    readonly grantAccess: (input: {
      readonly repositoryId: string;
      readonly organizationId: string;
      readonly userId: string;
      readonly role: RelayRepositoryRole;
    }) => Effect.Effect<RepositoryAccessRecord, RepositoryPersistenceError>;
    readonly revokeAccess: (input: {
      readonly repositoryId: string;
      readonly userId: string;
    }) => Effect.Effect<boolean, RepositoryPersistenceError>;
    /**
     * Clears every grant a departing member held. Leaving the rows behind would
     * silently restore their access if they were ever invited back.
     */
    readonly revokeAllAccessForUser: (input: {
      readonly organizationId: string;
      readonly userId: string;
    }) => Effect.Effect<void, RepositoryPersistenceError>;
  }
>()("t3code-relay/tenancy/Repositories") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const loadAliases = Effect.fn("relay.repositories.load_aliases")(function* (input: {
    readonly repositoryIds: ReadonlyArray<string>;
  }) {
    if (input.repositoryIds.length === 0) {
      return new Map<string, ReadonlyArray<string>>();
    }
    const rows = yield* db
      .select({
        repositoryId: relayRepositoryAliases.repositoryId,
        canonicalKey: relayRepositoryAliases.canonicalKey,
      })
      .from(relayRepositoryAliases)
      .where(inArray(relayRepositoryAliases.repositoryId, [...input.repositoryIds]))
      .orderBy(asc(relayRepositoryAliases.createdAt))
      .pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryPersistenceError({
              operation: "list-aliases",
              cause,
            }),
        ),
      );
    const byRepository = new Map<string, Array<string>>();
    for (const row of rows) {
      const keys = byRepository.get(row.repositoryId);
      if (keys) {
        keys.push(row.canonicalKey);
      } else {
        byRepository.set(row.repositoryId, [row.canonicalKey]);
      }
    }
    return byRepository as ReadonlyMap<string, ReadonlyArray<string>>;
  });

  const withAliases = Effect.fn("relay.repositories.with_aliases")(function* (
    rows: ReadonlyArray<RepositoryRow>,
  ) {
    const aliases = yield* loadAliases({ repositoryIds: rows.map((row) => row.repositoryId) });
    return rows.map(
      (row): RepositoryRecord => ({
        ...row,
        canonicalKeys: aliases.get(row.repositoryId) ?? [],
      }),
    );
  });

  const insertAlias = Effect.fn("relay.repositories.insert_alias")(function* (input: {
    readonly repositoryId: string;
    readonly organizationId: string;
    readonly canonicalKey: string;
    readonly operation: "register-repository" | "add-alias";
  }) {
    const rows = yield* db
      .insert(relayRepositoryAliases)
      .values({
        canonicalKey: input.canonicalKey,
        repositoryId: input.repositoryId,
        organizationId: input.organizationId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .onConflictDoNothing()
      .returning({ canonicalKey: relayRepositoryAliases.canonicalKey })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryPersistenceError({
              operation: input.operation,
              repositoryId: input.repositoryId,
              organizationId: input.organizationId,
              cause,
            }),
        ),
      );
    if (rows.length === 0) {
      return yield* new RepositoryCanonicalKeyTaken({ canonicalKey: input.canonicalKey });
    }
  });

  const loadById = Effect.fn("relay.repositories.load_by_id")(function* (input: {
    readonly repositoryId: string;
  }) {
    const rows = yield* db
      .select(repositoryColumns)
      .from(relayRepositories)
      .where(eq(relayRepositories.repositoryId, input.repositoryId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryPersistenceError({
              operation: "load-repository",
              repositoryId: input.repositoryId,
              cause,
            }),
        ),
      );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const [record] = yield* withAliases([row]);
    return record ?? null;
  });

  return Repositories.of({
    getById: loadById,

    register: Effect.fn("relay.repositories.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.repository_id": input.repositoryId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      // The alias goes in first: it is the only insert that can be refused, and
      // refusing it before the repository row exists leaves nothing to clean up.
      yield* insertAlias({
        repositoryId: input.repositoryId,
        organizationId: input.organizationId,
        canonicalKey: input.canonicalKey,
        operation: "register-repository",
      });
      yield* db
        .insert(relayRepositories)
        .values({
          repositoryId: input.repositoryId,
          organizationId: input.organizationId,
          name: input.name,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "register-repository",
                repositoryId: input.repositoryId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      yield* db
        .insert(relayRepositoryAccess)
        .values({
          repositoryId: input.repositoryId,
          userId: input.createdByUserId,
          organizationId: input.organizationId,
          role: "maintainer",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "register-repository",
                repositoryId: input.repositoryId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return {
        repositoryId: input.repositoryId,
        organizationId: input.organizationId,
        name: input.name,
        canonicalKeys: [input.canonicalKey],
        createdAt: now,
      };
    }),

    findByCanonicalKey: Effect.fn("relay.repositories.find_by_canonical_key")(function* (input) {
      const rows = yield* db
        .select(repositoryColumns)
        .from(relayRepositoryAliases)
        .innerJoin(
          relayRepositories,
          eq(relayRepositories.repositoryId, relayRepositoryAliases.repositoryId),
        )
        .where(eq(relayRepositoryAliases.canonicalKey, input.canonicalKey))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "load-repository",
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return null;
      }
      const [record] = yield* withAliases([row]);
      return record ?? null;
    }),

    listForOrganization: Effect.fn("relay.repositories.list_for_organization")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const rows = yield* db
        .select(repositoryColumns)
        .from(relayRepositories)
        .where(eq(relayRepositories.organizationId, input.organizationId))
        .orderBy(asc(relayRepositories.name))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "list-repositories",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return yield* withAliases(rows);
    }),

    deleteRepository: Effect.fn("relay.repositories.delete")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.repository_id": input.repositoryId });
      const failure = (cause: unknown) =>
        new RepositoryPersistenceError({
          operation: "delete-repository",
          repositoryId: input.repositoryId,
          cause,
        });
      yield* db
        .delete(relayRepositoryAliases)
        .where(eq(relayRepositoryAliases.repositoryId, input.repositoryId))
        .pipe(Effect.mapError(failure));
      yield* db
        .delete(relayRepositoryAccess)
        .where(eq(relayRepositoryAccess.repositoryId, input.repositoryId))
        .pipe(Effect.mapError(failure));
      const rows = yield* db
        .delete(relayRepositories)
        .where(eq(relayRepositories.repositoryId, input.repositoryId))
        .returning({ repositoryId: relayRepositories.repositoryId })
        .pipe(Effect.mapError(failure));
      return rows.length > 0;
    }),

    addAlias: Effect.fn("relay.repositories.add_alias")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.repository_id": input.repositoryId });
      yield* insertAlias({ ...input, operation: "add-alias" });
    }),

    removeAlias: Effect.fn("relay.repositories.remove_alias")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.repository_id": input.repositoryId });
      const counted = yield* db
        .select({ total: drizzleSql<number>`count(*)::int` })
        .from(relayRepositoryAliases)
        .where(eq(relayRepositoryAliases.repositoryId, input.repositoryId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "remove-alias",
                repositoryId: input.repositoryId,
                cause,
              }),
          ),
        );
      if ((counted[0]?.total ?? 0) <= 1) {
        return "last-alias" as const;
      }
      const rows = yield* db
        .delete(relayRepositoryAliases)
        .where(
          and(
            eq(relayRepositoryAliases.repositoryId, input.repositoryId),
            eq(relayRepositoryAliases.canonicalKey, input.canonicalKey),
          ),
        )
        .returning({ canonicalKey: relayRepositoryAliases.canonicalKey })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "remove-alias",
                repositoryId: input.repositoryId,
                cause,
              }),
          ),
        );
      return rows.length > 0 ? ("removed" as const) : ("not-found" as const);
    }),

    listAccess: Effect.fn("relay.repositories.list_access")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.repository_id": input.repositoryId });
      return yield* db
        .select({
          userId: relayRepositoryAccess.userId,
          role: relayRepositoryAccess.role,
          grantedAt: relayRepositoryAccess.createdAt,
        })
        .from(relayRepositoryAccess)
        .where(eq(relayRepositoryAccess.repositoryId, input.repositoryId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "list-access",
                repositoryId: input.repositoryId,
                cause,
              }),
          ),
        );
    }),

    getAccess: Effect.fn("relay.repositories.get_access")(function* (input) {
      const rows = yield* db
        .select({ role: relayRepositoryAccess.role })
        .from(relayRepositoryAccess)
        .where(
          and(
            eq(relayRepositoryAccess.repositoryId, input.repositoryId),
            eq(relayRepositoryAccess.userId, input.userId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "load-access",
                repositoryId: input.repositoryId,
                cause,
              }),
          ),
        );
      return rows[0]?.role ?? null;
    }),

    listAccessForUser: Effect.fn("relay.repositories.list_access_for_user")(function* (input) {
      const rows = yield* db
        .select({
          repositoryId: relayRepositoryAccess.repositoryId,
          role: relayRepositoryAccess.role,
        })
        .from(relayRepositoryAccess)
        .where(
          and(
            eq(relayRepositoryAccess.userId, input.userId),
            eq(relayRepositoryAccess.organizationId, input.organizationId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "list-access",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return new Map(rows.map((row) => [row.repositoryId, row.role]));
    }),

    grantAccess: Effect.fn("relay.repositories.grant_access")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.repository_id": input.repositoryId,
        "relay.repository.role": input.role,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayRepositoryAccess)
        .values({
          repositoryId: input.repositoryId,
          userId: input.userId,
          organizationId: input.organizationId,
          role: input.role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayRepositoryAccess.repositoryId, relayRepositoryAccess.userId],
          set: { role: input.role, updatedAt: now },
        })
        .returning({
          userId: relayRepositoryAccess.userId,
          role: relayRepositoryAccess.role,
          grantedAt: relayRepositoryAccess.createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "grant-access",
                repositoryId: input.repositoryId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new RepositoryPersistenceError({
          operation: "grant-access",
          repositoryId: input.repositoryId,
          organizationId: input.organizationId,
          cause: "grant returned no row",
        });
      }
      return row;
    }),

    revokeAccess: Effect.fn("relay.repositories.revoke_access")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.repository_id": input.repositoryId });
      const rows = yield* db
        .delete(relayRepositoryAccess)
        .where(
          and(
            eq(relayRepositoryAccess.repositoryId, input.repositoryId),
            eq(relayRepositoryAccess.userId, input.userId),
          ),
        )
        .returning({ userId: relayRepositoryAccess.userId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepositoryPersistenceError({
                operation: "revoke-access",
                repositoryId: input.repositoryId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    revokeAllAccessForUser: Effect.fn("relay.repositories.revoke_all_access_for_user")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
        yield* db
          .delete(relayRepositoryAccess)
          .where(
            and(
              eq(relayRepositoryAccess.organizationId, input.organizationId),
              eq(relayRepositoryAccess.userId, input.userId),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new RepositoryPersistenceError({
                  operation: "revoke-access",
                  organizationId: input.organizationId,
                  cause,
                }),
            ),
          );
      },
    ),
  });
});

export const layer = Layer.effect(Repositories, make);
