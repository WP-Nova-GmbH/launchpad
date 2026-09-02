import type { RelayOrgRole } from "@t3tools/contracts/relay";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayOrganizationInvitations } from "../persistence/schema.ts";

/**
 * Long enough that a link forwarded over chat still works the next morning,
 * short enough that a leaked one stops being a way into an organization.
 */
export const INVITATION_LIFETIME = Duration.days(7);

export interface InvitationRecord {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: RelayOrgRole;
  readonly invitedByUserId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class InvitationPersistenceError extends Schema.TaggedErrorClass<InvitationPersistenceError>()(
  "InvitationPersistenceError",
  {
    operation: Schema.Literals([
      "create-invitation",
      "list-invitations",
      "load-invitation",
      "revoke-invitation",
      "accept-invitation",
    ]),
    organizationId: Schema.optionalKey(Schema.String),
    invitationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invitation '${this.operation}' failed`;
  }
}

/** Lowercased so `Ada@Example.com` and `ada@example.com` are one invitation. */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

const invitationColumns = {
  invitationId: relayOrganizationInvitations.invitationId,
  organizationId: relayOrganizationInvitations.organizationId,
  email: relayOrganizationInvitations.email,
  role: relayOrganizationInvitations.role,
  invitedByUserId: relayOrganizationInvitations.invitedByUserId,
  createdAt: relayOrganizationInvitations.createdAt,
  expiresAt: relayOrganizationInvitations.expiresAt,
};

const pendingCondition = and(
  isNull(relayOrganizationInvitations.acceptedAt),
  isNull(relayOrganizationInvitations.revokedAt),
);

export class Invitations extends Context.Service<
  Invitations,
  {
    /**
     * Creating an invitation for an address supersedes any pending one for the
     * same address, so a re-invite cannot leave two live tokens behind.
     */
    readonly create: (input: {
      readonly invitationId: string;
      readonly organizationId: string;
      readonly email: string;
      readonly role: RelayOrgRole;
      readonly invitedByUserId: string;
      readonly tokenHash: string;
    }) => Effect.Effect<InvitationRecord, InvitationPersistenceError>;
    readonly listPending: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<ReadonlyArray<InvitationRecord>, InvitationPersistenceError>;
    readonly getPendingByTokenHash: (input: {
      readonly tokenHash: string;
    }) => Effect.Effect<InvitationRecord | null, InvitationPersistenceError>;
    /** Pending invitations addressed to any of the given (normalized) addresses, newest first. */
    readonly getPendingByEmails: (input: {
      readonly emails: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<InvitationRecord>, InvitationPersistenceError>;
    readonly revoke: (input: {
      readonly organizationId: string;
      readonly invitationId: string;
    }) => Effect.Effect<boolean, InvitationPersistenceError>;
    /**
     * Marks the invitation used. Returns false when another request got there
     * first, which is what makes a token single-use under concurrency.
     */
    readonly markAccepted: (input: {
      readonly invitationId: string;
      readonly acceptedByUserId: string;
    }) => Effect.Effect<boolean, InvitationPersistenceError>;
  }
>()("t3code-relay/tenancy/Invitations") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return Invitations.of({
    create: Effect.fn("relay.invitations.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.invitation_id": input.invitationId,
      });
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(DateTime.addDuration(now, INVITATION_LIFETIME));
      const email = normalizeInvitationEmail(input.email);

      yield* db
        .update(relayOrganizationInvitations)
        .set({ revokedAt: createdAt, updatedAt: createdAt })
        .where(
          and(
            eq(relayOrganizationInvitations.organizationId, input.organizationId),
            eq(relayOrganizationInvitations.email, email),
            pendingCondition,
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new InvitationPersistenceError({
                operation: "create-invitation",
                organizationId: input.organizationId,
                invitationId: input.invitationId,
                cause,
              }),
          ),
        );

      const rows = yield* db
        .insert(relayOrganizationInvitations)
        .values({
          invitationId: input.invitationId,
          organizationId: input.organizationId,
          email,
          role: input.role,
          invitedByUserId: input.invitedByUserId,
          tokenHash: input.tokenHash,
          expiresAt,
          acceptedAt: null,
          acceptedByUserId: null,
          revokedAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning(invitationColumns)
        .pipe(
          Effect.mapError(
            (cause) =>
              new InvitationPersistenceError({
                operation: "create-invitation",
                organizationId: input.organizationId,
                invitationId: input.invitationId,
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (!row) {
        return yield* new InvitationPersistenceError({
          operation: "create-invitation",
          organizationId: input.organizationId,
          invitationId: input.invitationId,
          cause: "insert returned no row",
        });
      }
      return row;
    }),

    listPending: Effect.fn("relay.invitations.list_pending")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      return yield* db
        .select(invitationColumns)
        .from(relayOrganizationInvitations)
        .where(
          and(
            eq(relayOrganizationInvitations.organizationId, input.organizationId),
            pendingCondition,
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new InvitationPersistenceError({
                operation: "list-invitations",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
    }),

    getPendingByTokenHash: Effect.fn("relay.invitations.get_pending_by_token_hash")(
      function* (input) {
        const rows = yield* db
          .select(invitationColumns)
          .from(relayOrganizationInvitations)
          .where(and(eq(relayOrganizationInvitations.tokenHash, input.tokenHash), pendingCondition))
          .limit(1)
          .pipe(
            Effect.mapError(
              (cause) =>
                new InvitationPersistenceError({
                  operation: "load-invitation",
                  cause,
                }),
            ),
          );
        return rows[0] ?? null;
      },
    ),

    getPendingByEmails: Effect.fn("relay.invitations.get_pending_by_emails")(function* (input) {
      if (input.emails.length === 0) return [];
      return yield* db
        .select(invitationColumns)
        .from(relayOrganizationInvitations)
        .where(
          and(inArray(relayOrganizationInvitations.email, [...input.emails]), pendingCondition),
        )
        .orderBy(desc(relayOrganizationInvitations.createdAt))
        .pipe(
          Effect.mapError(
            (cause) => new InvitationPersistenceError({ operation: "load-invitation", cause }),
          ),
        );
    }),

    revoke: Effect.fn("relay.invitations.revoke")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.invitation_id": input.invitationId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayOrganizationInvitations)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(
          and(
            eq(relayOrganizationInvitations.invitationId, input.invitationId),
            eq(relayOrganizationInvitations.organizationId, input.organizationId),
            pendingCondition,
          ),
        )
        .returning({ invitationId: relayOrganizationInvitations.invitationId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new InvitationPersistenceError({
                operation: "revoke-invitation",
                organizationId: input.organizationId,
                invitationId: input.invitationId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),

    markAccepted: Effect.fn("relay.invitations.mark_accepted")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.invitation_id": input.invitationId });
      const acceptedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayOrganizationInvitations)
        .set({
          acceptedAt,
          acceptedByUserId: input.acceptedByUserId,
          updatedAt: acceptedAt,
        })
        .where(
          and(eq(relayOrganizationInvitations.invitationId, input.invitationId), pendingCondition),
        )
        .returning({ invitationId: relayOrganizationInvitations.invitationId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new InvitationPersistenceError({
                operation: "accept-invitation",
                invitationId: input.invitationId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(Invitations, make);
