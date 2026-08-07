import { createClerkClient } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as Invitations from "../tenancy/Invitations.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import * as Repositories from "../tenancy/Repositories.ts";
import {
  acceptInvitationRecord,
  requireAdmin,
  requireMaintainableRepository,
  requireVisibleRepository,
  resolveMembership,
} from "./TenancyApi.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

// The same WebCrypto-backed shape the worker builds.
const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const membership = (input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: "member" | "admin";
}): Organizations.OrganizationMembershipRecord => ({
  organization: {
    organizationId: input.organizationId,
    name: "Acme",
    createdAt: "2026-08-05T00:00:00.000Z",
  },
  userId: input.userId,
  role: input.role,
  joinedAt: "2026-08-05T00:00:00.000Z",
});

const repository: Repositories.RepositoryRecord = {
  repositoryId: "repository-1",
  organizationId: "organization-1",
  name: "app",
  canonicalKeys: ["github.com/acme/app"],
  createdAt: "2026-08-05T00:00:00.000Z",
};

function organizationsLayer(overrides: Partial<Organizations.Organizations["Service"]>) {
  return Layer.succeed(
    Organizations.Organizations,
    Organizations.Organizations.of({
      ensureForUser: () => Effect.die("unused ensureForUser"),
      getMembershipForUser: () => Effect.die("unused getMembershipForUser"),
      listMembers: () => Effect.die("unused listMembers"),
      countAdmins: () => Effect.die("unused countAdmins"),
      countMembers: () => Effect.die("unused countMembers"),
      updateMemberRole: () => Effect.die("unused updateMemberRole"),
      removeMember: () => Effect.die("unused removeMember"),
      addMember: () => Effect.die("unused addMember"),
      rename: () => Effect.die("unused rename"),
      deleteOrganization: () => Effect.die("unused deleteOrganization"),
      ...overrides,
    }),
  );
}

function repositoriesLayer(overrides: Partial<Repositories.Repositories["Service"]>) {
  return Layer.succeed(
    Repositories.Repositories,
    Repositories.Repositories.of({
      register: () => Effect.die("unused register"),
      getById: () => Effect.die("unused getById"),
      findByCanonicalKey: () => Effect.die("unused findByCanonicalKey"),
      listForOrganization: () => Effect.die("unused listForOrganization"),
      deleteRepository: () => Effect.die("unused deleteRepository"),
      addAlias: () => Effect.die("unused addAlias"),
      removeAlias: () => Effect.die("unused removeAlias"),
      listAccess: () => Effect.die("unused listAccess"),
      getAccess: () => Effect.die("unused getAccess"),
      listAccessForUser: () => Effect.die("unused listAccessForUser"),
      grantAccess: () => Effect.die("unused grantAccess"),
      revokeAccess: () => Effect.die("unused revokeAccess"),
      revokeAllAccessForUser: () => Effect.die("unused revokeAllAccessForUser"),
      ...overrides,
    }),
  );
}

function invitationsLayer(overrides: Partial<Invitations.Invitations["Service"]>) {
  return Layer.succeed(
    Invitations.Invitations,
    Invitations.Invitations.of({
      create: () => Effect.die("unused create"),
      listPending: () => Effect.die("unused listPending"),
      getPendingByTokenHash: () => Effect.die("unused getPendingByTokenHash"),
      revoke: () => Effect.die("unused revoke"),
      markAccepted: () => Effect.die("unused markAccepted"),
      ...overrides,
    }),
  );
}

// Transactions in these tests are pass-through: the point under test is which
// writes happen and in what order, not that Postgres rolls them back.
const transactionsLayer = Layer.succeed(
  RelayDb.RelayTransactions,
  RelayDb.RelayTransactions.of({
    withTransaction: ((effect: unknown) =>
      effect) as RelayDb.RelayTransactions["Service"]["withTransaction"],
  }),
);

describe("organization membership resolution", () => {
  it.effect("creates an organization the first time a subject is seen", () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const resolved = yield* resolveMembership({ userId: "user-1" });
      expect(resolved.role).toBe("admin");
      expect(created).toHaveLength(1);
      expect(created[0]).not.toBe("");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          organizationsLayer({
            getMembershipForUser: () => Effect.succeed(null),
            ensureForUser: (input) =>
              Effect.sync(() => {
                created.push(input.organizationId);
                return membership({
                  organizationId: input.organizationId,
                  userId: input.userId,
                  role: "admin",
                });
              }),
          }),
          cryptoLayer,
        ),
      ),
    );
  });

  it.effect("reuses the organization a subject already belongs to", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveMembership({ userId: "user-1" });
      expect(resolved.organization.organizationId).toBe("organization-1");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          organizationsLayer({
            getMembershipForUser: () =>
              Effect.succeed(
                membership({ organizationId: "organization-1", userId: "user-1", role: "member" }),
              ),
            ensureForUser: () => Effect.die("must not create a second organization"),
          }),
          cryptoLayer,
        ),
      ),
    ),
  );

  it.effect("refuses an administrative action to a plain member", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(requireAdmin({ userId: "user-1" }));
      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "not_an_admin",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          organizationsLayer({
            getMembershipForUser: () =>
              Effect.succeed(
                membership({ organizationId: "organization-1", userId: "user-1", role: "member" }),
              ),
          }),
          cryptoLayer,
        ),
      ),
    ),
  );
});

describe("repository authorization", () => {
  it.effect("lets an organization admin configure a repository they hold no grant on", () =>
    Effect.gen(function* () {
      const resolved = yield* requireMaintainableRepository({
        membership: membership({
          organizationId: "organization-1",
          userId: "user-1",
          role: "admin",
        }),
        repositoryId: "repository-1",
      });
      expect(resolved.repositoryId).toBe("repository-1");
    }).pipe(
      Effect.provide(
        repositoriesLayer({
          getById: () => Effect.succeed(repository),
          getAccess: () => Effect.die("an admin needs no grant"),
        }),
      ),
    ),
  );

  it.effect("refuses configuration to a developer", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        requireMaintainableRepository({
          membership: membership({
            organizationId: "organization-1",
            userId: "user-1",
            role: "member",
          }),
          repositoryId: "repository-1",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "not_a_maintainer",
      });
    }).pipe(
      Effect.provide(
        repositoriesLayer({
          getById: () => Effect.succeed(repository),
          getAccess: () => Effect.succeed("developer"),
        }),
      ),
    ),
  );

  it.effect("hides another organization's repository behind a not-found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        requireMaintainableRepository({
          membership: membership({
            organizationId: "organization-2",
            userId: "user-1",
            role: "admin",
          }),
          repositoryId: "repository-1",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyNotFoundError",
        reason: "repository_not_found",
      });
    }).pipe(Effect.provide(repositoriesLayer({ getById: () => Effect.succeed(repository) }))),
  );

  it.effect("does not tell a member without a grant that the repository exists", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        requireVisibleRepository({
          membership: membership({
            organizationId: "organization-1",
            userId: "user-1",
            role: "member",
          }),
          repositoryId: "repository-1",
        }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyNotFoundError",
        reason: "repository_not_found",
      });
    }).pipe(
      Effect.provide(
        repositoriesLayer({
          getById: () => Effect.succeed(repository),
          getAccess: () => Effect.succeed(null),
        }),
      ),
    ),
  );
});

describe("invitation acceptance", () => {
  const pendingInvitation: Invitations.InvitationRecord = {
    invitationId: "invitation-1",
    organizationId: "organization-2",
    email: "ada@example.com",
    role: "member",
    invitedByUserId: "user-2",
    createdAt: "2026-08-05T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  const clerkUserWithEmails = (emails: ReadonlyArray<string>) => {
    vi.mocked(createClerkClient).mockReturnValue({
      users: {
        getUser: vi.fn().mockResolvedValue({
          emailAddresses: emails.map((emailAddress) => ({
            emailAddress,
            verification: { status: "verified" },
          })),
        }),
      },
    } as never);
  };

  const acceptanceLayer = (input: {
    readonly invitation?: Invitations.InvitationRecord | null;
    readonly markAccepted?: boolean;
    readonly memberCount?: number;
    readonly ownedRepositories?: ReadonlyArray<Repositories.RepositoryRecord>;
    readonly writes?: Array<string>;
  }) =>
    Layer.mergeAll(
      organizationsLayer({
        getMembershipForUser: () =>
          Effect.succeed(
            membership({ organizationId: "organization-1", userId: "user-1", role: "admin" }),
          ),
        countMembers: () => Effect.succeed(input.memberCount ?? 1),
        removeMember: () =>
          Effect.sync(() => {
            input.writes?.push("remove-member");
            return true;
          }),
        addMember: () =>
          Effect.sync(() => {
            input.writes?.push("add-member");
            return { userId: "user-1", role: "member" as const, joinedAt: "2026-08-05" };
          }),
        deleteOrganization: () =>
          Effect.sync(() => {
            input.writes?.push("delete-organization");
          }),
      }),
      invitationsLayer({
        getPendingByTokenHash: () =>
          Effect.succeed(input.invitation === undefined ? pendingInvitation : input.invitation),
        markAccepted: () =>
          Effect.sync(() => {
            input.writes?.push("mark-accepted");
            return input.markAccepted ?? true;
          }),
      }),
      repositoriesLayer({
        listForOrganization: () => Effect.succeed(input.ownedRepositories ?? []),
      }),
      transactionsLayer,
      Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
      cryptoLayer,
    );

  it.effect("refuses a token addressed to a different mailbox", () => {
    clerkUserWithEmails(["someone-else@example.com"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyConflictError",
        reason: "invitation_email_mismatch",
      });
    }).pipe(
      Effect.provide(acceptanceLayer({})),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("refuses to abandon an organization that still holds a repository", () => {
    clerkUserWithEmails(["ada@example.com"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "organization_not_empty",
      });
    }).pipe(
      Effect.provide(acceptanceLayer({ ownedRepositories: [repository] })),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("refuses to abandon an organization that still has other members", () => {
    clerkUserWithEmails(["ada@example.com"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "organization_not_empty",
      });
    }).pipe(
      Effect.provide(acceptanceLayer({ memberCount: 2 })),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("moves the member and clears the organization they left", () => {
    clerkUserWithEmails(["ADA@Example.com".toLowerCase()]);
    const writes: Array<string> = [];
    return Effect.gen(function* () {
      const joined = yield* acceptInvitationRecord({ userId: "user-1", token: "token" }).pipe(
        Effect.provideService(
          Organizations.Organizations,
          Organizations.Organizations.of({
            ensureForUser: () => Effect.die("unused ensureForUser"),
            getMembershipForUser: () =>
              Effect.succeed(
                writes.includes("add-member")
                  ? membership({
                      organizationId: "organization-2",
                      userId: "user-1",
                      role: "member",
                    })
                  : membership({
                      organizationId: "organization-1",
                      userId: "user-1",
                      role: "admin",
                    }),
              ),
            listMembers: () => Effect.die("unused listMembers"),
            countAdmins: () => Effect.die("unused countAdmins"),
            countMembers: () => Effect.succeed(1),
            updateMemberRole: () => Effect.die("unused updateMemberRole"),
            removeMember: () =>
              Effect.sync(() => {
                writes.push("remove-member");
                return true;
              }),
            addMember: () =>
              Effect.sync(() => {
                writes.push("add-member");
                return { userId: "user-1", role: "member" as const, joinedAt: "2026-08-05" };
              }),
            rename: () => Effect.die("unused rename"),
            deleteOrganization: () =>
              Effect.sync(() => {
                writes.push("delete-organization");
              }),
          }),
        ),
      );

      expect(joined.organization.organizationId).toBe("organization-2");
      expect(joined.role).toBe("member");
      // Claiming the token comes first: that is what makes it single use.
      expect(writes).toEqual([
        "mark-accepted",
        "remove-member",
        "add-member",
        "delete-organization",
      ]);
    }).pipe(
      Effect.provide(acceptanceLayer({ writes })),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("treats a token that another request already claimed as spent", () => {
    clerkUserWithEmails(["ada@example.com"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyConflictError",
        reason: "invitation_not_pending",
      });
    }).pipe(
      Effect.provide(acceptanceLayer({ markAccepted: false })),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("rejects an expired invitation", () => {
    clerkUserWithEmails(["ada@example.com"]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyConflictError",
        reason: "invitation_not_pending",
      });
    }).pipe(
      Effect.provide(
        acceptanceLayer({
          // The test clock starts at the epoch, so "already expired" is before it.
          invitation: { ...pendingInvitation, expiresAt: "1969-12-31T00:00:00.000Z" },
        }),
      ),
      Effect.ensuring(Effect.sync(() => vi.mocked(createClerkClient).mockReset())),
    );
  });

  it.effect("answers a token nobody issued with a not-found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        acceptInvitationRecord({ userId: "user-1", token: "token" }),
      );
      expect(error).toMatchObject({
        _tag: "RelayTenancyNotFoundError",
        reason: "invitation_not_found",
      });
    }).pipe(Effect.provide(acceptanceLayer({ invitation: null }))),
  );
});
