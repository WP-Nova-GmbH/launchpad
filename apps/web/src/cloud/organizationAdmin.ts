import { useAuth } from "@clerk/react";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import type {
  RelayGithubConnectionResponse,
  RelayGithubInstallResponse,
  RelayGithubInstallationCandidate,
  RelayGithubRepository,
  RelayInvitation,
  RelayRepositoryAccessEntry,
  RelayInvitationId,
  RelayMachine,
  RelayMachineId,
  RelayMachineRole,
  RelayOrgRole,
  RelayOrganizationMember,
  RelayOrganizationMembership,
  RelayProviderAccount,
  RelayProviderAccountProvider,
  RelayRepositoryId,
  RelaySaveProviderAccountRequest,
  RelayRepositoryRole,
  RelayRepositorySummary,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState } from "react";

import { runtime } from "../lib/runtime";
import { decodedRelayClientError } from "./linkEnvironment";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type TenancyClient = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

export interface OrganizationAdminSnapshot {
  readonly membership: RelayOrganizationMembership;
  readonly members: ReadonlyArray<RelayOrganizationMember>;
  readonly invitations: ReadonlyArray<RelayInvitation>;
  readonly repositories: ReadonlyArray<RelayRepositorySummary>;
  /** Who can work in each repository, keyed by repository id. */
  readonly access: ReadonlyMap<string, ReadonlyArray<RelayRepositoryAccessEntry>>;
  readonly machines: ReadonlyArray<RelayMachine>;
  readonly github: RelayGithubConnectionResponse;
  /** What the GitHub installation can see; empty until one is connected. */
  readonly githubRepositories: ReadonlyArray<RelayGithubRepository>;
  /** The provider sign-ins the organization shares with its executors; admins only. */
  readonly providerAccounts: ReadonlyArray<RelayProviderAccount>;
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

/**
 * The enrollment seed for a self-hosted machine, delivered by hand exactly
 * like an invitation token: it exists only in the response that created the
 * machine, so it lives in component state until the page is left.
 */
export interface IssuedMachineEnrollment {
  readonly machineId: RelayMachineId;
  readonly seed: string;
  readonly relayUrl: string;
}

export interface OrganizationAdminState {
  readonly isSignedIn: boolean;
  readonly snapshot: OrganizationAdminSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly issuedInvitations: ReadonlyArray<IssuedInvitation>;
  readonly issuedMachineEnrollments: ReadonlyArray<IssuedMachineEnrollment>;
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
  readonly connectGithub: (installationId: string) => Promise<boolean>;
  /** GitHub's install page for the App; the relay claims the installation on GitHub's callback. */
  readonly startGithubInstall: () => Promise<RelayGithubInstallResponse | null>;
  /** Installations of the App as GitHub reports them, for picking one that was installed directly. */
  readonly listGithubInstallations: () => Promise<ReadonlyArray<RelayGithubInstallationCandidate> | null>;
  readonly disconnectGithub: () => Promise<boolean>;
  readonly provisionMachine: (input: {
    readonly label: string;
    readonly role: RelayMachineRole;
  }) => Promise<boolean>;
  readonly connectMachine: (input: {
    readonly label: string;
    readonly role: RelayMachineRole;
  }) => Promise<boolean>;
  readonly deprovisionMachine: (machineId: RelayMachineId) => Promise<boolean>;
  /** Store a provider sign-in or key for the organization; replaces the previous one. */
  readonly saveProviderAccount: (input: {
    readonly provider: RelayProviderAccountProvider;
    readonly payload: RelaySaveProviderAccountRequest;
  }) => Promise<boolean>;
  readonly removeProviderAccount: (provider: RelayProviderAccountProvider) => Promise<boolean>;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The relay request failed.";
}

/**
 * Drives the organization settings surface. Every call carries a fresh Clerk
 * token: tenancy lives in the relay, so the token proves who is asking and
 * nothing more.
 *
 * Only callable under a `ClerkProvider`, which `main.tsx` mounts solely when
 * `hasCloudPublicConfig()` holds — so callers must check that first and render
 * something else when it does not.
 */
export function useOrganizationAdmin(): OrganizationAdminState {
  const { getToken, isSignedIn } = useAuth();
  const [snapshot, setSnapshot] = useState<OrganizationAdminSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedInvitations, setIssuedInvitations] = useState<ReadonlyArray<IssuedInvitation>>([]);
  const [issuedMachineEnrollments, setIssuedMachineEnrollments] = useState<
    ReadonlyArray<IssuedMachineEnrollment>
  >([]);

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
        throw new Error("Sign in to Launchpad Connect first.");
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
    if (!isSignedIn) {
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
      // Admin-only for the same reason: what the organization shares with its
      // executors is administration, not something every member reads.
      const providerAccounts =
        membership.role === "admin"
          ? await call("Could not list provider accounts", (client, clerkToken) =>
              client.listProviderAccounts({ clerkToken }),
            )
          : [];
      // One request per repository. An organization has a handful, and the
      // alternative — showing a grant form with no idea who already has access
      // — is how the first version of this page shipped.
      const access = new Map<string, ReadonlyArray<RelayRepositoryAccessEntry>>(
        await Promise.all(
          repositories.map(async (entry) => {
            const repositoryId = entry.repository.repositoryId;
            const entries = await call("Could not list repository access", (client, clerkToken) =>
              client.listAccess({ clerkToken, repositoryId }),
            );
            return [repositoryId as string, entries] as const;
          }),
        ),
      );
      const machines = await call("Could not list machines", (client, clerkToken) =>
        client.listMachines({ clerkToken }),
      );
      const github = await call("Could not read the GitHub connection", (client, clerkToken) =>
        client.getGithubConnection({ clerkToken }),
      );
      // Only meaningful once an installation exists; asking otherwise is a
      // guaranteed not-found that would read as a failure.
      const githubRepositories = github.connection
        ? await call("Could not list GitHub repositories", (client, clerkToken) =>
            client.listGithubRepositories({ clerkToken }),
          )
        : [];
      setSnapshot({
        membership,
        members,
        invitations,
        repositories,
        access,
        machines,
        github,
        githubRepositories,
        providerAccounts,
      });
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [call, isSignedIn]);

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
    isSignedIn: isSignedIn ?? false,
    snapshot,
    loading,
    error,
    busy,
    issuedInvitations,
    issuedMachineEnrollments,
    refresh: load,
    saveProviderAccount: (input) =>
      mutate("Could not store the provider account", () =>
        call("Could not store the provider account", (client, clerkToken) =>
          client.saveProviderAccount({
            clerkToken,
            provider: input.provider,
            payload: input.payload,
          }),
        ),
      ),
    removeProviderAccount: (provider) =>
      mutate("Could not remove the provider account", () =>
        call("Could not remove the provider account", (client, clerkToken) =>
          client.deleteProviderAccount({ clerkToken, provider }),
        ),
      ),
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
    connectGithub: (installationId) =>
      mutate("Could not connect GitHub", () =>
        call("Could not connect GitHub", (client, clerkToken) =>
          client.connectGithub({ clerkToken, installationId }),
        ),
      ),
    startGithubInstall: async () => {
      setBusy(true);
      setError(null);
      try {
        return await call("Could not start connecting GitHub", (client, clerkToken) =>
          client.startGithubInstall({
            clerkToken,
            payload: { returnUrl: `${window.location.origin}/settings/organization` },
          }),
        );
      } catch (cause) {
        setError(failureMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    listGithubInstallations: async () => {
      try {
        return await call("Could not list GitHub installations", (client, clerkToken) =>
          client.listGithubInstallations({ clerkToken }),
        );
      } catch (cause) {
        setError(failureMessage(cause));
        return null;
      }
    },
    disconnectGithub: () =>
      mutate("Could not disconnect GitHub", () =>
        call("Could not disconnect GitHub", (client, clerkToken) =>
          client.disconnectGithub({ clerkToken }),
        ),
      ),
    revokeAccess: (input) =>
      mutate("Could not revoke access", () =>
        call("Could not revoke access", (client, clerkToken) =>
          client.revokeAccess({ clerkToken, ...input }),
        ),
      ),
    provisionMachine: (input) =>
      mutate("Could not provision the machine", () =>
        call("Could not provision the machine", (client, clerkToken) =>
          client.provisionMachine({ clerkToken, payload: input }),
        ),
      ),
    connectMachine: (input) =>
      mutate("Could not connect the machine", async () => {
        const issued = await call("Could not connect the machine", (client, clerkToken) =>
          client.connectMachine({ clerkToken, payload: input }),
        );
        setIssuedMachineEnrollments((current) => [
          { machineId: issued.machine.machineId, seed: issued.seed, relayUrl: issued.relayUrl },
          ...current.filter((entry) => entry.machineId !== issued.machine.machineId),
        ]);
      }),
    deprovisionMachine: (machineId) =>
      mutate("Could not deprovision the machine", async () => {
        await call("Could not deprovision the machine", (client, clerkToken) =>
          client.deprovisionMachine({ clerkToken, machineId }),
        );
        setIssuedMachineEnrollments((current) =>
          current.filter((entry) => entry.machineId !== machineId),
        );
      }),
  };
}
