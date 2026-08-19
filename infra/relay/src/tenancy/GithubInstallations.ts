import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayGithubInstallations } from "../persistence/schema.ts";

export interface GithubInstallationRecord {
  readonly organizationId: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly connectedByUserId: string;
  readonly createdAt: string;
}

export class GithubInstallationPersistenceError extends Schema.TaggedErrorClass<GithubInstallationPersistenceError>()(
  "GithubInstallationPersistenceError",
  {
    operation: Schema.Literals(["load", "claim", "release"]),
    organizationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub installation '${this.operation}' failed`;
  }
}

/** Another organization already claimed this installation. */
export class GithubInstallationAlreadyClaimed extends Schema.TaggedErrorClass<GithubInstallationAlreadyClaimed>()(
  "GithubInstallationAlreadyClaimed",
  { installationId: Schema.String },
) {
  override get message(): string {
    return `GitHub installation '${this.installationId}' belongs to another organization`;
  }
}

const columns = {
  organizationId: relayGithubInstallations.organizationId,
  installationId: relayGithubInstallations.installationId,
  accountLogin: relayGithubInstallations.accountLogin,
  accountType: relayGithubInstallations.accountType,
  connectedByUserId: relayGithubInstallations.connectedByUserId,
  createdAt: relayGithubInstallations.createdAt,
};

export class GithubInstallations extends Context.Service<
  GithubInstallations,
  {
    readonly getForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<GithubInstallationRecord | null, GithubInstallationPersistenceError>;
    readonly claim: (input: {
      readonly organizationId: string;
      readonly installationId: string;
      readonly accountLogin: string;
      readonly accountType: string;
      readonly connectedByUserId: string;
    }) => Effect.Effect<
      GithubInstallationRecord,
      GithubInstallationPersistenceError | GithubInstallationAlreadyClaimed
    >;
    readonly release: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<boolean, GithubInstallationPersistenceError>;
  }
>()("t3code-relay/tenancy/GithubInstallations") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return GithubInstallations.of({
    getForOrganization: Effect.fn("relay.github_installations.get")(function* (input) {
      const rows = yield* db
        .select(columns)
        .from(relayGithubInstallations)
        .where(eq(relayGithubInstallations.organizationId, input.organizationId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new GithubInstallationPersistenceError({
                operation: "load",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows[0] ?? null;
    }),

    claim: Effect.fn("relay.github_installations.claim")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      // Reconnecting the same organization replaces its row; a different
      // organization hits the unique index on installation_id and is refused.
      const rows = yield* db
        .insert(relayGithubInstallations)
        .values({
          organizationId: input.organizationId,
          installationId: input.installationId,
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          connectedByUserId: input.connectedByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: relayGithubInstallations.organizationId,
          set: {
            installationId: input.installationId,
            accountLogin: input.accountLogin,
            accountType: input.accountType,
            connectedByUserId: input.connectedByUserId,
            updatedAt: now,
          },
        })
        .returning(columns)
        .pipe(
          Effect.mapError(
            (cause): GithubInstallationAlreadyClaimed | GithubInstallationPersistenceError =>
              String(cause).includes("idx_relay_github_installations_installation")
                ? new GithubInstallationAlreadyClaimed({
                    installationId: input.installationId,
                  })
                : new GithubInstallationPersistenceError({
                    operation: "claim",
                    organizationId: input.organizationId,
                    cause,
                  }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new GithubInstallationPersistenceError({
          operation: "claim",
          organizationId: input.organizationId,
          cause: "claim returned no row",
        });
      }
      return row;
    }),

    release: Effect.fn("relay.github_installations.release")(function* (input) {
      const rows = yield* db
        .delete(relayGithubInstallations)
        .where(eq(relayGithubInstallations.organizationId, input.organizationId))
        .returning({ organizationId: relayGithubInstallations.organizationId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GithubInstallationPersistenceError({
                operation: "release",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(GithubInstallations, make);
