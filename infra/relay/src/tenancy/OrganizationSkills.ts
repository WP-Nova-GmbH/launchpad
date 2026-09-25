import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayOrganizationSkills } from "../persistence/schema.ts";

export interface OrganizationSkillRecord {
  readonly organizationId: string;
  readonly name: string;
  readonly description: string;
  /** The skill's files as JSON; decoded by the API layer, never here. */
  readonly filesJson: string;
  readonly version: string;
  readonly createdByUserId: string;
  readonly updatedByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class OrganizationSkillPersistenceError extends Schema.TaggedError<OrganizationSkillPersistenceError>()(
  "OrganizationSkillPersistenceError",
  {
    operation: Schema.Literals(["list", "save", "delete"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Organization skill record '${this.operation}' failed`;
  }
}

const columns = {
  organizationId: relayOrganizationSkills.organizationId,
  name: relayOrganizationSkills.name,
  description: relayOrganizationSkills.description,
  filesJson: relayOrganizationSkills.filesJson,
  version: relayOrganizationSkills.version,
  createdByUserId: relayOrganizationSkills.createdByUserId,
  updatedByUserId: relayOrganizationSkills.updatedByUserId,
  createdAt: relayOrganizationSkills.createdAt,
  updatedAt: relayOrganizationSkills.updatedAt,
};

/** An organization's skills: one row per name, replaced on every save. */
export class OrganizationSkills extends Context.Service<
  OrganizationSkills,
  {
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<OrganizationSkillRecord>, OrganizationSkillPersistenceError>;
    readonly save: (input: {
      readonly organizationId: string;
      readonly name: string;
      readonly description: string;
      readonly filesJson: string;
      readonly userId: string;
    }) => Effect.Effect<OrganizationSkillRecord, OrganizationSkillPersistenceError>;
    readonly delete: (input: {
      readonly organizationId: string;
      readonly name: string;
    }) => Effect.Effect<boolean, OrganizationSkillPersistenceError>;
  }
>()("t3code-relay/tenancy/OrganizationSkills") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;

  return OrganizationSkills.of({
    listForOrganization: Effect.fn("relay.organization_skills.list")(function* (input) {
      return yield* db
        .select(columns)
        .from(relayOrganizationSkills)
        .where(eq(relayOrganizationSkills.organizationId, input.organizationId))
        .orderBy(relayOrganizationSkills.name)
        .pipe(
          Effect.mapError(
            (cause) => new OrganizationSkillPersistenceError({ operation: "list", cause }),
          ),
        );
    }),

    save: Effect.fn("relay.organization_skills.save")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const version = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) => new OrganizationSkillPersistenceError({ operation: "save", cause }),
        ),
      );
      const rows = yield* db
        .insert(relayOrganizationSkills)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          filesJson: input.filesJson,
          version,
          createdByUserId: input.userId,
          updatedByUserId: input.userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayOrganizationSkills.organizationId, relayOrganizationSkills.name],
          set: {
            description: input.description,
            filesJson: input.filesJson,
            version,
            updatedByUserId: input.userId,
            updatedAt: now,
          },
        })
        .returning(columns)
        .pipe(
          Effect.mapError(
            (cause) => new OrganizationSkillPersistenceError({ operation: "save", cause }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new OrganizationSkillPersistenceError({
          operation: "save",
          cause: "save returned no row",
        });
      }
      return row;
    }),

    delete: Effect.fn("relay.organization_skills.delete")(function* (input) {
      const rows = yield* db
        .delete(relayOrganizationSkills)
        .where(
          and(
            eq(relayOrganizationSkills.organizationId, input.organizationId),
            eq(relayOrganizationSkills.name, input.name),
          ),
        )
        .returning({ name: relayOrganizationSkills.name })
        .pipe(
          Effect.mapError(
            (cause) => new OrganizationSkillPersistenceError({ operation: "delete", cause }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(OrganizationSkills, make);
