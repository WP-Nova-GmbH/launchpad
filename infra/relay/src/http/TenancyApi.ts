import { createClerkClient } from "@clerk/backend";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  RelayApi,
  RelayClientPrincipal,
  RelayInvitationId,
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayOrgRole,
  type RelayOrganization,
  type RelayOrganizationMembership,
  type RelayRepository,
  type RelayRepositorySummary,
  type RelayRepositoryRole,
} from "@t3tools/contracts/relay";

import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict, tenancyForbidden, tenancyNotFound } from "./tenancyErrors.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as Invitations from "../tenancy/Invitations.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import * as Repositories from "../tenancy/Repositories.ts";

function toApiOrganization(record: Organizations.OrganizationRecord): RelayOrganization {
  return {
    organizationId: RelayOrganizationId.make(record.organizationId),
    name: record.name,
    createdAt: record.createdAt,
  };
}

function toApiMembership(
  record: Organizations.OrganizationMembershipRecord,
): RelayOrganizationMembership {
  return {
    organization: toApiOrganization(record.organization),
    role: record.role,
    joinedAt: record.joinedAt,
  };
}

function toApiRepository(record: Repositories.RepositoryRecord): RelayRepository {
  return {
    repositoryId: RelayRepositoryId.make(record.repositoryId),
    organizationId: RelayOrganizationId.make(record.organizationId),
    name: record.name,
    canonicalKeys: record.canonicalKeys,
    createdAt: record.createdAt,
  };
}

function toApiRepositorySummary(
  record: Repositories.RepositoryRecord,
  role: RelayRepositoryRole | null,
): RelayRepositorySummary {
  return { repository: toApiRepository(record), role };
}

/**
 * The caller's organization, created on first sight. Clerk never tells the
 * relay that someone signed up, so the first authorized request is where an
 * organization comes into being.
 */
export const resolveMembership = Effect.fn("relay.api.tenancy.resolve_membership")(
  function* (input: { readonly userId: string }) {
    const { userId } = input;
    const organizations = yield* Organizations.Organizations;
    const existing = yield* organizations.getMembershipForUser({ userId });
    if (existing) {
      return existing;
    }
    const crypto = yield* Crypto.Crypto;
    const organizationId = yield* crypto.randomUUIDv4.pipe(
      Effect.catch(() => relayInternalErrorResponse("internal_error")),
    );
    return yield* organizations.ensureForUser({ userId, organizationId });
  },
);

export const requireAdmin = Effect.fn("relay.api.tenancy.require_admin")(function* (input: {
  readonly userId: string;
}) {
  const membership = yield* resolveMembership(input);
  if (membership.role !== "admin") {
    return yield* tenancyForbidden("not_an_admin");
  }
  return membership;
});

/** The caller's own organization and role, from the authenticated principal. */
const requireMembership = Effect.fn("relay.api.tenancy.require_membership")(function* () {
  const { userId } = yield* RelayClientPrincipal;
  return yield* resolveMembership({ userId });
});

const requireCallerIsAdmin = Effect.fn("relay.api.tenancy.require_caller_is_admin")(function* () {
  const { userId } = yield* RelayClientPrincipal;
  return yield* requireAdmin({ userId });
});

/** The member's organization, or a not-found when they are in a different one. */
const requireMemberOfSameOrganization = Effect.fn(
  "relay.api.tenancy.require_member_of_same_organization",
)(function* (input: { readonly organizationId: string; readonly userId: string }) {
  const organizations = yield* Organizations.Organizations;
  const membership = yield* organizations.getMembershipForUser({ userId: input.userId });
  if (!membership || membership.organization.organizationId !== input.organizationId) {
    return yield* tenancyNotFound("member_not_found");
  }
  return membership;
});

/**
 * A repository the caller may configure: their own organization's, and either
 * theirs to maintain or theirs as an administrator.
 */
export const requireMaintainableRepository = Effect.fn(
  "relay.api.tenancy.require_maintainable_repository",
)(function* (input: {
  readonly membership: Organizations.OrganizationMembershipRecord;
  readonly repositoryId: string;
}) {
  const repositories = yield* Repositories.Repositories;
  const repository = yield* repositories.getById({ repositoryId: input.repositoryId });
  if (!repository || repository.organizationId !== input.membership.organization.organizationId) {
    return yield* tenancyNotFound("repository_not_found");
  }
  if (input.membership.role === "admin") {
    return repository;
  }
  const role = yield* repositories.getAccess({
    repositoryId: input.repositoryId,
    userId: input.membership.userId,
  });
  if (role !== "maintainer") {
    return yield* tenancyForbidden(role === null ? "no_repository_access" : "not_a_maintainer");
  }
  return repository;
});

export const requireVisibleRepository = Effect.fn("relay.api.tenancy.require_visible_repository")(
  function* (input: {
    readonly membership: Organizations.OrganizationMembershipRecord;
    readonly repositoryId: string;
  }) {
    const repositories = yield* Repositories.Repositories;
    const repository = yield* repositories.getById({ repositoryId: input.repositoryId });
    if (!repository || repository.organizationId !== input.membership.organization.organizationId) {
      return yield* tenancyNotFound("repository_not_found");
    }
    const role = yield* repositories.getAccess({
      repositoryId: input.repositoryId,
      userId: input.membership.userId,
    });
    if (input.membership.role !== "admin" && role === null) {
      // Indistinguishable from a repository that does not exist: a member with
      // no grant should not learn that one does.
      return yield* tenancyNotFound("repository_not_found");
    }
    return { repository, role };
  },
);

/**
 * A URL-safe invitation token. Only its hash is stored, so this value exists
 * exactly once — in the response to the admin who created the invitation.
 */
function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const makeInvitationToken = Effect.fn("relay.api.tenancy.make_invitation_token")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const bytes = yield* crypto
      .randomBytes(32)
      .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
    return toHex(bytes);
  },
);

export const hashInvitationToken = Effect.fn("relay.api.tenancy.hash_invitation_token")(function* (
  token: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(token))
    .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
  return toHex(digest);
});

/**
 * The address Clerk holds for the accepting subject. Identity, not tenancy —
 * the relay is asking "who is this person" so an invitation addressed to one
 * mailbox cannot be redeemed from another.
 */
const fetchVerifiedEmailAddresses = Effect.fn("relay.api.tenancy.fetch_verified_emails")(function* (
  userId: string,
) {
  const config = yield* RelayConfiguration.RelayConfiguration;
  return yield* Effect.tryPromise(async () => {
    const client = createClerkClient({
      secretKey: Redacted.value(config.clerkSecretKey),
      publishableKey: config.clerkPublishableKey,
    });
    const user = await client.users.getUser(userId);
    return user.emailAddresses
      .filter((address) => address.verification?.status === "verified")
      .map((address) => address.emailAddress.trim().toLowerCase());
  });
});

/**
 * Redeeming an invitation is a move, not an addition: a person belongs to
 * exactly one organization, so joining one means leaving the other.
 */
export const acceptInvitationRecord = Effect.fn("relay.api.tenancy.accept_invitation")(
  function* (input: { readonly userId: string; readonly token: string }) {
    const organizations = yield* Organizations.Organizations;
    const invitations = yield* Invitations.Invitations;
    const repositories = yield* Repositories.Repositories;
    const transactions = yield* RelayDb.RelayTransactions;

    const membership = yield* resolveMembership({ userId: input.userId });
    const tokenHash = yield* hashInvitationToken(input.token);
    const invitation = yield* invitations.getPendingByTokenHash({ tokenHash });
    if (!invitation) {
      return yield* tenancyNotFound("invitation_not_found");
    }
    const now = yield* DateTime.now;
    if (Date.parse(invitation.expiresAt) <= now.epochMilliseconds) {
      return yield* tenancyConflict("invitation_not_pending");
    }
    const currentOrganizationId = membership.organization.organizationId;
    if (invitation.organizationId === currentOrganizationId) {
      return yield* tenancyConflict("already_a_member");
    }

    const verifiedEmails = yield* fetchVerifiedEmailAddresses(input.userId).pipe(
      Effect.catch(() => relayInternalErrorResponse("internal_error")),
    );
    if (!verifiedEmails.includes(invitation.email)) {
      return yield* tenancyConflict("invitation_email_mismatch");
    }

    // Joining means leaving. Refuse while the organization being left still holds
    // anyone or anything, rather than orphaning it.
    const remainingMembers = yield* organizations.countMembers({
      organizationId: currentOrganizationId,
    });
    const ownedRepositories = yield* repositories.listForOrganization({
      organizationId: currentOrganizationId,
    });
    if (remainingMembers > 1 || ownedRepositories.length > 0) {
      return yield* tenancyForbidden("organization_not_empty");
    }

    return yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          // Claiming the invitation first is what makes the token single use: a
          // second request finds nothing left to accept.
          const claimed = yield* invitations.markAccepted({
            invitationId: invitation.invitationId,
            acceptedByUserId: input.userId,
          });
          if (!claimed) {
            return yield* tenancyConflict("invitation_not_pending");
          }
          yield* organizations.removeMember({
            organizationId: currentOrganizationId,
            userId: input.userId,
          });
          yield* organizations.addMember({
            organizationId: invitation.organizationId,
            userId: input.userId,
            role: invitation.role satisfies RelayOrgRole,
          });
          yield* organizations.deleteOrganization({ organizationId: currentOrganizationId });
          const settled = yield* organizations.getMembershipForUser({ userId: input.userId });
          if (!settled) {
            return yield* relayInternalErrorResponse("persistence_failed");
          }
          return toApiMembership(settled);
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
  },
);

export const organizationApi = HttpApiBuilder.group(
  RelayApi,
  "organization",
  Effect.fnUntraced(function* (handlers) {
    const organizations = yield* Organizations.Organizations;
    const invitations = yield* Invitations.Invitations;
    const repositories = yield* Repositories.Repositories;
    const transactions = yield* RelayDb.RelayTransactions;
    const crypto = yield* Crypto.Crypto;

    const newId = crypto.randomUUIDv4.pipe(
      Effect.catch(() => relayInternalErrorResponse("internal_error")),
    );

    return handlers
      .handle(
        "getOrganization",
        Effect.fn("relay.api.organization.get")(function* () {
          return toApiMembership(yield* requireMembership());
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "renameOrganization",
        Effect.fn("relay.api.organization.rename")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          const renamed = yield* organizations.rename({
            organizationId: membership.organization.organizationId,
            name: args.payload.name,
          });
          if (!renamed) {
            return yield* relayInternalErrorResponse("persistence_failed");
          }
          return toApiOrganization(renamed);
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listOrganizationMembers",
        Effect.fn("relay.api.organization.list_members")(function* () {
          const membership = yield* requireMembership();
          const members = yield* organizations.listMembers({
            organizationId: membership.organization.organizationId,
          });
          return { members };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "updateOrganizationMember",
        Effect.fn("relay.api.organization.update_member")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          if (args.params.userId === membership.userId) {
            // An admin demoting themselves is how an organization ends up with
            // nobody who can administer it. Someone else has to do it.
            return yield* tenancyForbidden("cannot_change_own_role");
          }
          yield* requireMemberOfSameOrganization({
            organizationId: membership.organization.organizationId,
            userId: args.params.userId,
          });
          const updated = yield* organizations.updateMemberRole({
            organizationId: membership.organization.organizationId,
            userId: args.params.userId,
            role: args.payload.role,
          });
          if (!updated) {
            return yield* tenancyNotFound("member_not_found");
          }
          return updated;
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "removeOrganizationMember",
        Effect.fn("relay.api.organization.remove_member")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          const organizationId = membership.organization.organizationId;
          const target = yield* requireMemberOfSameOrganization({
            organizationId,
            userId: args.params.userId,
          });
          if (
            target.role === "admin" &&
            (yield* organizations.countAdmins({ organizationId })) <= 1
          ) {
            return yield* tenancyForbidden("last_admin");
          }
          yield* transactions
            .withTransaction(
              Effect.gen(function* () {
                yield* organizations.removeMember({
                  organizationId,
                  userId: args.params.userId,
                });
                yield* repositories.revokeAllAccessForUser({
                  organizationId,
                  userId: args.params.userId,
                });
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
            );
          return { ok: true };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listInvitations",
        Effect.fn("relay.api.organization.list_invitations")(function* () {
          const membership = yield* requireCallerIsAdmin();
          const pending = yield* invitations.listPending({
            organizationId: membership.organization.organizationId,
          });
          return {
            invitations: pending.map((invitation) => ({
              ...invitation,
              invitationId: RelayInvitationId.make(invitation.invitationId),
            })),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "createInvitation",
        Effect.fn("relay.api.organization.create_invitation")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          const email = Invitations.normalizeInvitationEmail(args.payload.email);
          const token = yield* makeInvitationToken();
          const created = yield* invitations.create({
            invitationId: yield* newId,
            organizationId: membership.organization.organizationId,
            email,
            role: args.payload.role,
            invitedByUserId: membership.userId,
            tokenHash: yield* hashInvitationToken(token),
          });
          return {
            invitation: {
              ...created,
              invitationId: RelayInvitationId.make(created.invitationId),
            },
            token,
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "revokeInvitation",
        Effect.fn("relay.api.organization.revoke_invitation")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          const revoked = yield* invitations.revoke({
            organizationId: membership.organization.organizationId,
            invitationId: args.params.invitationId,
          });
          if (!revoked) {
            return yield* tenancyNotFound("invitation_not_found");
          }
          return { ok: true };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "acceptInvitation",
        Effect.fn("relay.api.organization.accept_invitation")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* acceptInvitationRecord({ userId, token: args.payload.token });
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const repositoriesApi = HttpApiBuilder.group(
  RelayApi,
  "repositories",
  Effect.fnUntraced(function* (handlers) {
    const repositories = yield* Repositories.Repositories;
    const crypto = yield* Crypto.Crypto;

    const newId = crypto.randomUUIDv4.pipe(
      Effect.catch(() => relayInternalErrorResponse("internal_error")),
    );

    return handlers
      .handle(
        "listRepositories",
        Effect.fn("relay.api.repositories.list")(function* () {
          const membership = yield* requireMembership();
          const organizationId = membership.organization.organizationId;
          const owned = yield* repositories.listForOrganization({ organizationId });
          const grants = yield* repositories.listAccessForUser({
            organizationId,
            userId: membership.userId,
          });
          const visible =
            membership.role === "admin"
              ? owned
              : owned.filter((repository) => grants.has(repository.repositoryId));
          return {
            repositories: visible.map((repository) =>
              toApiRepositorySummary(repository, grants.get(repository.repositoryId) ?? null),
            ),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "registerRepository",
        Effect.fn("relay.api.repositories.register")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          const registered = yield* repositories
            .register({
              repositoryId: yield* newId,
              organizationId: membership.organization.organizationId,
              name: args.payload.name,
              canonicalKey: args.payload.canonicalKey,
              createdByUserId: membership.userId,
            })
            .pipe(
              Effect.catchTag("RepositoryCanonicalKeyTaken", () =>
                tenancyConflict("canonical_key_taken"),
              ),
            );
          return toApiRepository(registered);
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "lookupRepository",
        Effect.fn("relay.api.repositories.lookup")(function* (args) {
          const membership = yield* requireMembership();
          const match = yield* repositories.findByCanonicalKey({
            canonicalKey: args.payload.canonicalKey,
          });
          if (!match || match.organizationId !== membership.organization.organizationId) {
            return { match: null };
          }
          const role = yield* repositories.getAccess({
            repositoryId: match.repositoryId,
            userId: membership.userId,
          });
          if (membership.role !== "admin" && role === null) {
            return { match: null };
          }
          return { match: toApiRepositorySummary(match, role) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "deleteRepository",
        Effect.fn("relay.api.repositories.delete")(function* (args) {
          const membership = yield* requireCallerIsAdmin();
          yield* requireMaintainableRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          yield* repositories.deleteRepository({ repositoryId: args.params.repositoryId });
          return { ok: true };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "addRepositoryAlias",
        Effect.fn("relay.api.repositories.add_alias")(function* (args) {
          const membership = yield* requireMembership();
          const repository = yield* requireMaintainableRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          yield* repositories
            .addAlias({
              repositoryId: repository.repositoryId,
              organizationId: repository.organizationId,
              canonicalKey: args.payload.canonicalKey,
            })
            .pipe(
              Effect.catchTag("RepositoryCanonicalKeyTaken", () =>
                tenancyConflict("canonical_key_taken"),
              ),
            );
          const updated = yield* repositories.getById({
            repositoryId: repository.repositoryId,
          });
          return toApiRepository(updated ?? repository);
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "removeRepositoryAlias",
        Effect.fn("relay.api.repositories.remove_alias")(function* (args) {
          const membership = yield* requireMembership();
          const repository = yield* requireMaintainableRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          const outcome = yield* repositories.removeAlias({
            repositoryId: repository.repositoryId,
            canonicalKey: args.payload.canonicalKey,
          });
          if (outcome === "last-alias") {
            return yield* tenancyConflict("last_alias");
          }
          if (outcome === "not-found") {
            return yield* tenancyNotFound("alias_not_found");
          }
          const updated = yield* repositories.getById({
            repositoryId: repository.repositoryId,
          });
          return toApiRepository(updated ?? repository);
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listRepositoryAccess",
        Effect.fn("relay.api.repositories.list_access")(function* (args) {
          const membership = yield* requireMembership();
          const { repository } = yield* requireVisibleRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          const access = yield* repositories.listAccess({
            repositoryId: repository.repositoryId,
          });
          return { access };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "grantRepositoryAccess",
        Effect.fn("relay.api.repositories.grant_access")(function* (args) {
          const membership = yield* requireMembership();
          const repository = yield* requireMaintainableRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          yield* requireMemberOfSameOrganization({
            organizationId: repository.organizationId,
            userId: args.payload.userId,
          });
          return yield* repositories.grantAccess({
            repositoryId: repository.repositoryId,
            organizationId: repository.organizationId,
            userId: args.payload.userId,
            role: args.payload.role,
          });
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "revokeRepositoryAccess",
        Effect.fn("relay.api.repositories.revoke_access")(function* (args) {
          const membership = yield* requireMembership();
          const repository = yield* requireMaintainableRepository({
            membership,
            repositoryId: args.params.repositoryId,
          });
          const revoked = yield* repositories.revokeAccess({
            repositoryId: repository.repositoryId,
            userId: args.params.userId,
          });
          if (!revoked) {
            return yield* tenancyNotFound("member_not_found");
          }
          return { ok: true };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);
