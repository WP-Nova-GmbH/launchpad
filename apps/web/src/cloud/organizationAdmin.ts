import { useAuth } from "@clerk/react";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import type {
  RelayInvitation,
  RelayInvitationId,
  RelayOrgRole,
  RelayOrganizationMember,
  RelayOrganizationMembership,
  RelayRepositoryId,
  RelayRepositoryRole,
  RelayRepositorySummary,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState } from "react";

import { runtime } from "../lib/runtime";
import { decodedRelayClientError } from "./linkEnvironment";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

type TenancyClient = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

export interface OrganizationAdminSnapshot {
  readonly membership: RelayOrganizationMembership;
  readonly members: ReadonlyArray<RelayOrganizationMember>;
  readonly invitations: ReadonlyArray<RelayInvitation>;
  readonly repositories: ReadonlyArray<RelayRepositorySummary>;
}

/**
 * The token an admin has to deliver by hand. It exists only in the response
 * that created it, so it lives in component state until the page is left —
 * there is no way to ask the relay for it again.
 */
export interface IssuedInvitation {
  readonly invitation: RelayInvitation;
  readonly token: string;
}

export interface OrganizationAdminState {
  readonly relayConfigured: boolean;
  readonly isSignedIn: boolean;
  readonly snapshot: OrganizationAdminSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly issuedInvitations: ReadonlyArray<IssuedInvitation>;
  readonly refresh: () => Promise<void>;
  readonly renameOrganization: (name: string) => Promise<boolean>;
  readonly updateMemberRole: (input: {
    readonly userId: string;
    readonly role: RelayOrgRole;
  }) => Promise<boolean>;
  readonly removeMember: (userId: string) => Promise<boolean>;
  readonly inviteMember: (input: {
    readonly email: string;
    readonly role: RelayOrgRole;
  }) => Promise<boolean>;
  readonly revokeInvitation: (invitationId: RelayInvitationId) => Promise<boolean>;
  readonly acceptInvitation: (token: string) => Promise<boolean>;
  readonly registerRepository: (input: {
    readonly name: string;
    readonly canonicalKey: string;
  }) => Promise<boolean>;
  readonly deleteRepository: (repositoryId: RelayRepositoryId) => Promise<boolean>;
  readonly addAlias: (input: {
    readonly repositoryId: RelayRepositoryId;
    readonly canonicalKey: string;
  }) => Promise<boolean>;
  readonly removeAlias: (input: {
    readonly repositoryId: RelayRepositoryId;
    readonly canonicalKey: string;
  }) => Promise<boolean>;
  readonly grantAccess: (input: {
    readonly repositoryId: RelayRepositoryId;
    readonly userId: string;
    readonly role: RelayRepositoryRole;
  }) => Promise<boolean>;
  readonly revokeAccess: (input: {
    readonly repositoryId: RelayRepositoryId;
    readonly userId: string;
  }) => Promise<boolean>;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The relay request failed.";
}

/**
 * Drives the organization settings surface. Every call carries a fresh Clerk
 * token: tenancy lives in the relay, so the token proves who is asking and
 * nothing more.
 */
export function useOrganizationAdmin(): OrganizationAdminState {
  const { getToken, isSignedIn } = useAuth();
  const relayConfigured = resolveCloudPublicConfig().relayUrl !== null;
  const [snapshot, setSnapshot] = useState<OrganizationAdminSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedInvitations, setIssuedInvitations] = useState<ReadonlyArray<IssuedInvitation>>([]);

  const call = useCallback(
    async <A>(
      description: string,
      run: (
        client: TenancyClient,
        clerkToken: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ): Promise<A> => {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) {
        throw new Error("Sign in to T3 Connect first.");
      }
      return runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => run(client, clerkToken)),
          Effect.mapError(decodedRelayClientError(description)),
        ),
      );
    },
    [getToken],
  );

  const load = useCallback(async () => {
    if (!relayConfigured || !isSignedIn) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const membership = await call("Could not read your organization", (client, clerkToken) =>
        client.getOrganization({ clerkToken }),
      );
      const [members, repositories] = await Promise.all([
        call("Could not list organization members", (client, clerkToken) =>
          client.listMembers({ clerkToken }),
        ),
        call("Could not list repositories", (client, clerkToken) =>
          client.listRepositories({ clerkToken }),
        ),
      ]);
      // Only admins may read invitations; a member asking would get a refusal
      // that reads like a failure rather than the absence of a permission.
      const invitations =
        membership.role === "admin"
          ? await call("Could not list invitations", (client, clerkToken) =>
              client.listInvitations({ clerkToken }),
            )
          : [];
      setSnapshot({ membership, members, invitations, repositories });
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [call, isSignedIn, relayConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (description: string, run: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await run();
        await load();
        return true;
      } catch (cause) {
        setError(failureMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return {
    relayConfigured,
    isSignedIn: isSignedIn ?? false,
    snapshot,
    loading,
    error,
    busy,
    issuedInvitations,
    refresh: load,
    renameOrganization: (name) =>
      mutate("Could not rename the organization", () =>
        call("Could not rename the organization", (client, clerkToken) =>
          client.renameOrganization({ clerkToken, name }),
        ),
      ),
    updateMemberRole: (input) =>
      mutate("Could not change the member's role", () =>
        call("Could not change the member's role", (client, clerkToken) =>
          client.updateMemberRole({ clerkToken, userId: input.userId, role: input.role }),
        ),
      ),
    removeMember: (userId) =>
      mutate("Could not remove the member", () =>
        call("Could not remove the member", (client, clerkToken) =>
          client.removeMember({ clerkToken, userId }),
        ),
      ),
    inviteMember: (input) =>
      mutate("Could not create the invitation", async () => {
        const issued = await call("Could not create the invitation", (client, clerkToken) =>
          client.createInvitation({ clerkToken, payload: input }),
        );
        setIssuedInvitations((current) => [
          { invitation: issued.invitation, token: issued.token },
          ...current.filter(
            (entry) => entry.invitation.invitationId !== issued.invitation.invitationId,
          ),
        ]);
      }),
    revokeInvitation: (invitationId) =>
      mutate("Could not revoke the invitation", async () => {
        await call("Could not revoke the invitation", (client, clerkToken) =>
          client.revokeInvitation({ clerkToken, invitationId }),
        );
        setIssuedInvitations((current) =>
          current.filter((entry) => entry.invitation.invitationId !== invitationId),
        );
      }),
    acceptInvitation: (token) =>
      mutate("Could not accept the invitation", () =>
        call("Could not accept the invitation", (client, clerkToken) =>
          client.acceptInvitation({ clerkToken, token }),
        ),
      ),
    registerRepository: (input) =>
      mutate("Could not register the repository", () =>
        call("Could not register the repository", (client, clerkToken) =>
          client.registerRepository({ clerkToken, payload: input }),
        ),
      ),
    deleteRepository: (repositoryId) =>
      mutate("Could not remove the repository", () =>
        call("Could not remove the repository", (client, clerkToken) =>
          client.deleteRepository({ clerkToken, repositoryId }),
        ),
      ),
    addAlias: (input) =>
      mutate("Could not add the key", () =>
        call("Could not add the key", (client, clerkToken) =>
          client.addAlias({ clerkToken, ...input }),
        ),
      ),
    removeAlias: (input) =>
      mutate("Could not remove the key", () =>
        call("Could not remove the key", (client, clerkToken) =>
          client.removeAlias({ clerkToken, ...input }),
        ),
      ),
    grantAccess: (input) =>
      mutate("Could not grant access", () =>
        call("Could not grant access", (client, clerkToken) =>
          client.grantAccess({
            clerkToken,
            repositoryId: input.repositoryId,
            payload: { userId: input.userId, role: input.role },
          }),
        ),
      ),
    revokeAccess: (input) =>
      mutate("Could not revoke access", () =>
        call("Could not revoke access", (client, clerkToken) =>
          client.revokeAccess({ clerkToken, ...input }),
        ),
      ),
  };
}
