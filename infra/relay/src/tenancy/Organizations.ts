import type { RelayOrgRole } from "@t3tools/contracts/relay";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayOrganizationMembers, relayOrganizations } from "../persistence/schema.ts";

/**
 * What a brand new organization is called before anyone renames it. Every user
 * gets one at first sight, so this name is common and deliberately plain.
 */
export const DEFAULT_ORGANIZATION_NAME = "My organization";

export interface OrganizationRecord {
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface OrganizationMemberRecord {
  readonly userId: string;
  readonly role: RelayOrgRole;
  readonly joinedAt: string;
}

export interface OrganizationMembershipRecord extends OrganizationMemberRecord {
  readonly organization: OrganizationRecord;
}

export class OrganizationPersistenceError extends Schema.TaggedErrorClass<OrganizationPersistenceError>()(
  "OrganizationPersistenceError",
  {
    operation: Schema.Literals([
      "load-membership",
      "create-organization",
      "create-membership",
      "list-members",
      "count-admins",
      "update-member-role",
      "remove-member",
      "rename-organization",
      "delete-organization",
    ]),
    userId: Schema.optionalKey(Schema.String),
    organizationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Organization '${this.operation}' failed`;
  }
}

const organizationColumns = {
  organizationId: relayOrganizations.organizationId,
  name: relayOrganizations.name,
  createdAt: relayOrganizations.createdAt,
};

const membershipColumns = {
  ...organizationColumns,
  userId: relayOrganizationMembers.userId,
  role: relayOrganizationMembers.role,
  joinedAt: relayOrganizationMembers.createdAt,
};

interface MembershipRow {
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly userId: string;
  readonly role: RelayOrgRole;
  readonly joinedAt: string;
}

function toMembership(row: MembershipRow): OrganizationMembershipRecord {
  return {
    organization: {
      organizationId: row.organizationId,
      name: row.name,
      createdAt: row.createdAt,
    },
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
  };
}

export class Organizations extends Context.Service<
  Organizations,
  {
    /**
     * The caller's organization and role, created on first sight if they have
     * none. Signup is not an event the relay observes — Clerk owns that — so
     * "first authorized request" is where an organization comes into being.
     */
    readonly ensureForUser: (input: {
      readonly userId: string;
      readonly organizationId: string;
      readonly name?: string;
    }) => Effect.Effect<OrganizationMembershipRecord, OrganizationPersistenceError>;
    readonly getMembershipForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<OrganizationMembershipRecord | null, OrganizationPersistenceError>;
    readonly listMembers: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<OrganizationMemberRecord>, OrganizationPersistenceError>;
    readonly countAdmins: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<number, OrganizationPersistenceError>;
    readonly countMembers: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<number, OrganizationPersistenceError>;
    readonly updateMemberRole: (input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly role: RelayOrgRole;
    }) => Effect.Effect<OrganizationMemberRecord | null, OrganizationPersistenceError>;
    readonly removeMember: (input: {
      readonly organizationId: string;
      readonly userId: string;
    }) => Effect.Effect<boolean, OrganizationPersistenceError>;
    /** Used by invitation acceptance; the caller has already vacated their old organization. */
    readonly addMember: (input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly role: RelayOrgRole;
    }) => Effect.Effect<OrganizationMemberRecord, OrganizationPersistenceError>;
    readonly rename: (input: {
      readonly organizationId: string;
      readonly name: string;
    }) => Effect.Effect<OrganizationRecord | null, OrganizationPersistenceError>;
    readonly deleteOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<void, OrganizationPersistenceError>;
  }
>()("t3code-relay/tenancy/Organizations") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const loadMembership = Effect.fn("relay.organizations.load_membership")(function* (input: {
    readonly userId: string;
  }) {
    const rows = yield* db
      .select(membershipColumns)
      .from(relayOrganizationMembers)
      .innerJoin(
        relayOrganizations,
        eq(relayOrganizations.organizationId, relayOrganizationMembers.organizationId),
      )
      .where(eq(relayOrganizationMembers.userId, input.userId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrganizationPersistenceError({
              operation: "load-membership",
              userId: input.userId,
              cause,
            }),
        ),
      );
    const row = rows[0];
    return row ? toMembership(row) : null;
  });

  return Organizations.of({
    getMembershipForUser: loadMembership,

    ensureForUser: Effect.fn("relay.organizations.ensure_for_user")(function* (input) {
      const existing = yield* loadMembership({ userId: input.userId });
      if (existing) {
        return existing;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .insert(relayOrganizations)
        .values({
          organizationId: input.organizationId,
          name: input.name ?? DEFAULT_ORGANIZATION_NAME,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "create-organization",
                userId: input.userId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      // Two concurrent first requests both reach here. The unique index on
      // user_id decides which one wins, and the loser drops the organization
      // it speculatively created rather than leaving an unreachable row.
      yield* db
        .insert(relayOrganizationMembers)
        .values({
          organizationId: input.organizationId,
          userId: input.userId,
          role: "admin",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "create-membership",
                userId: input.userId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      const settled = yield* loadMembership({ userId: input.userId });
      if (!settled) {
        return yield* new OrganizationPersistenceError({
          operation: "create-membership",
          userId: input.userId,
          organizationId: input.organizationId,
          cause: "membership insert left no row",
        });
      }
      if (settled.organization.organizationId !== input.organizationId) {
        yield* db
          .delete(relayOrganizations)
          .where(eq(relayOrganizations.organizationId, input.organizationId))
          .pipe(Effect.ignore);
      }
      return settled;
    }),

    listMembers: Effect.fn("relay.organizations.list_members")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      return yield* db
        .select({
          userId: relayOrganizationMembers.userId,
          role: relayOrganizationMembers.role,
          joinedAt: relayOrganizationMembers.createdAt,
        })
        .from(relayOrganizationMembers)
        .where(eq(relayOrganizationMembers.organizationId, input.organizationId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "list-members",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
    }),

    countAdmins: Effect.fn("relay.organizations.count_admins")(function* (input) {
      const rows = yield* db
        .select({ total: drizzleSql<number>`count(*)::int` })
        .from(relayOrganizationMembers)
        .where(
          and(
            eq(relayOrganizationMembers.organizationId, input.organizationId),
            eq(relayOrganizationMembers.role, "admin"),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "count-admins",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows[0]?.total ?? 0;
    }),

    countMembers: Effect.fn("relay.organizations.count_members")(function* (input) {
      const rows = yield* db
        .select({ total: drizzleSql<number>`count(*)::int` })
        .from(relayOrganizationMembers)
        .where(eq(relayOrganizationMembers.organizationId, input.organizationId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "list-members",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows[0]?.total ?? 0;
    }),

    updateMemberRole: Effect.fn("relay.organizations.update_member_role")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.organization.role": input.role,
      });
      const rows = yield* db
        .update(relayOrganizationMembers)
        .set({ role: input.role, updatedAt: DateTime.formatIso(yield* DateTime.now) })
        .where(
          and(
            eq(relayOrganizationMembers.organizationId, input.organizationId),
            eq(relayOrganizationMembers.userId, input.userId),
          ),
        )
        .returning({
          userId: relayOrganizationMembers.userId,
          role: relayOrganizationMembers.role,
          joinedAt: relayOrganizationMembers.createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "update-member-role",
                userId: input.userId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows[0] ?? null;
    }),

    removeMember: Effect.fn("relay.organizations.remove_member")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const rows = yield* db
        .delete(relayOrganizationMembers)
        .where(
          and(
            eq(relayOrganizationMembers.organizationId, input.organizationId),
            eq(relayOrganizationMembers.userId, input.userId),
          ),
        )
        .returning({ userId: relayOrganizationMembers.userId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "remove-member",
                userId: input.userId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    addMember: Effect.fn("relay.organizations.add_member")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .insert(relayOrganizationMembers)
        .values({
          organizationId: input.organizationId,
          userId: input.userId,
          role: input.role,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          userId: relayOrganizationMembers.userId,
          role: relayOrganizationMembers.role,
          joinedAt: relayOrganizationMembers.createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "create-membership",
                userId: input.userId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new OrganizationPersistenceError({
          operation: "create-membership",
          userId: input.userId,
          organizationId: input.organizationId,
          cause: "membership insert returned no row",
        });
      }
      return row;
    }),

    rename: Effect.fn("relay.organizations.rename")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      const rows = yield* db
        .update(relayOrganizations)
        .set({ name: input.name, updatedAt: DateTime.formatIso(yield* DateTime.now) })
        .where(eq(relayOrganizations.organizationId, input.organizationId))
        .returning(organizationColumns)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "rename-organization",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
      return rows[0] ?? null;
    }),

    deleteOrganization: Effect.fn("relay.organizations.delete")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      yield* db
        .delete(relayOrganizations)
        .where(eq(relayOrganizations.organizationId, input.organizationId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationPersistenceError({
                operation: "delete-organization",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(Organizations, make);
