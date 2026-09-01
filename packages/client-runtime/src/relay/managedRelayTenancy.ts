/**
 * Organization, invitation, and repository calls against the relay.
 *
 * Separate from `ManagedRelayClient` on purpose: that service exists to reach
 * an environment, and it authenticates with DPoP-bound tokens to do it. These
 * calls only ever read and write relay-owned records with a plain Clerk
 * bearer, and they are used by administrative surfaces rather than by the
 * connection machinery.
 */
import {
  RelayApi,
  type RelayConnectMachineResponse,
  type RelayCreateInvitationRequest,
  type RelayCreateInvitationResponse,
  type RelayGithubAppSetupResponse,
  type RelayGithubConnection,
  type RelayGithubConnectionResponse,
  type RelayGithubRepository,
  type RelayGrantRepositoryAccessRequest,
  type RelayInvitation,
  type RelayInvitationId,
  type RelayLookupRepositoryResponse,
  type RelayMachine,
  type RelayMachineId,
  type RelayOkResponse,
  type RelayOrgRole,
  type RelayOrganization,
  type RelayOrganizationMember,
  type RelayOrganizationMembership,
  type RelayOrganizationProject,
  type RelayProvisionMachineRequest,
  type RelayRegisterRepositoryRequest,
  type RelayRepository,
  type RelayStartGithubAppSetupRequest,
  type RelayRepositoryAccessEntry,
  type RelayRepositoryId,
  type RelayRepositorySummary,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import {
  bearerHeaders,
  ManagedRelayUrlInvalidError,
  relayRequestError,
  timeoutRelayRequest,
  type ManagedRelayClientError,
} from "./managedRelay.ts";

export interface ManagedRelayTenancyClientOptions {
  readonly relayUrl: string;
}

export class ManagedRelayTenancyClient extends Context.Service<
  ManagedRelayTenancyClient,
  {
    readonly relayUrl: string;
    /** Also what creates the caller's organization the first time they ask. */
    readonly getOrganization: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<RelayOrganizationMembership, ManagedRelayClientError>;
    readonly renameOrganization: (input: {
      readonly clerkToken: string;
      readonly name: string;
    }) => Effect.Effect<RelayOrganization, ManagedRelayClientError>;
    readonly listMembers: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayOrganizationMember>, ManagedRelayClientError>;
    readonly updateMemberRole: (input: {
      readonly clerkToken: string;
      readonly userId: string;
      readonly role: RelayOrgRole;
    }) => Effect.Effect<RelayOrganizationMember, ManagedRelayClientError>;
    readonly removeMember: (input: {
      readonly clerkToken: string;
      readonly userId: string;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly listInvitations: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayInvitation>, ManagedRelayClientError>;
    readonly createInvitation: (input: {
      readonly clerkToken: string;
      readonly payload: RelayCreateInvitationRequest;
    }) => Effect.Effect<RelayCreateInvitationResponse, ManagedRelayClientError>;
    readonly revokeInvitation: (input: {
      readonly clerkToken: string;
      readonly invitationId: RelayInvitationId;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly acceptInvitation: (input: {
      readonly clerkToken: string;
      readonly token: string;
    }) => Effect.Effect<RelayOrganizationMembership, ManagedRelayClientError>;
    readonly listRepositories: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayRepositorySummary>, ManagedRelayClientError>;
    readonly listOrganizationProjects: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayOrganizationProject>, ManagedRelayClientError>;
    readonly registerRepository: (input: {
      readonly clerkToken: string;
      readonly payload: RelayRegisterRepositoryRequest;
    }) => Effect.Effect<RelayRepository, ManagedRelayClientError>;
    readonly lookupRepository: (input: {
      readonly clerkToken: string;
      readonly canonicalKey: string;
    }) => Effect.Effect<RelayLookupRepositoryResponse, ManagedRelayClientError>;
    readonly deleteRepository: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly addAlias: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
      readonly canonicalKey: string;
    }) => Effect.Effect<RelayRepository, ManagedRelayClientError>;
    readonly removeAlias: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
      readonly canonicalKey: string;
    }) => Effect.Effect<RelayRepository, ManagedRelayClientError>;
    readonly listAccess: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
    }) => Effect.Effect<ReadonlyArray<RelayRepositoryAccessEntry>, ManagedRelayClientError>;
    readonly grantAccess: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
      readonly payload: RelayGrantRepositoryAccessRequest;
    }) => Effect.Effect<RelayRepositoryAccessEntry, ManagedRelayClientError>;
    readonly revokeAccess: (input: {
      readonly clerkToken: string;
      readonly repositoryId: RelayRepositoryId;
      readonly userId: string;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly listMachines: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayMachine>, ManagedRelayClientError>;
    readonly provisionMachine: (input: {
      readonly clerkToken: string;
      readonly payload: RelayProvisionMachineRequest;
    }) => Effect.Effect<RelayMachine, ManagedRelayClientError>;
    readonly connectMachine: (input: {
      readonly clerkToken: string;
      readonly payload: RelayProvisionMachineRequest;
    }) => Effect.Effect<RelayConnectMachineResponse, ManagedRelayClientError>;
    readonly deprovisionMachine: (input: {
      readonly clerkToken: string;
      readonly machineId: RelayMachineId;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getGithubConnection: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<RelayGithubConnectionResponse, ManagedRelayClientError>;
    readonly connectGithub: (input: {
      readonly clerkToken: string;
      readonly installationId: string;
    }) => Effect.Effect<RelayGithubConnection, ManagedRelayClientError>;
    readonly startGithubAppSetup: (input: {
      readonly clerkToken: string;
      readonly payload: RelayStartGithubAppSetupRequest;
    }) => Effect.Effect<RelayGithubAppSetupResponse, ManagedRelayClientError>;
    readonly disconnectGithub: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly listGithubRepositories: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayGithubRepository>, ManagedRelayClientError>;
  }
>()("@t3tools/client-runtime/relay/managedRelayTenancy/ManagedRelayTenancyClient") {}

function disabledTenancyClient(relayUrl: string): ManagedRelayTenancyClient["Service"] {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* new ManagedRelayUrlInvalidError({ relayUrl });
    });
  return ManagedRelayTenancyClient.of({
    relayUrl,
    getOrganization: unavailable("clientRuntime.managedRelayTenancy.getOrganization"),
    renameOrganization: unavailable("clientRuntime.managedRelayTenancy.renameOrganization"),
    listMembers: unavailable("clientRuntime.managedRelayTenancy.listMembers"),
    updateMemberRole: unavailable("clientRuntime.managedRelayTenancy.updateMemberRole"),
    removeMember: unavailable("clientRuntime.managedRelayTenancy.removeMember"),
    listInvitations: unavailable("clientRuntime.managedRelayTenancy.listInvitations"),
    createInvitation: unavailable("clientRuntime.managedRelayTenancy.createInvitation"),
    revokeInvitation: unavailable("clientRuntime.managedRelayTenancy.revokeInvitation"),
    acceptInvitation: unavailable("clientRuntime.managedRelayTenancy.acceptInvitation"),
    listRepositories: unavailable("clientRuntime.managedRelayTenancy.listRepositories"),
    listOrganizationProjects: unavailable(
      "clientRuntime.managedRelayTenancy.listOrganizationProjects",
    ),
    registerRepository: unavailable("clientRuntime.managedRelayTenancy.registerRepository"),
    lookupRepository: unavailable("clientRuntime.managedRelayTenancy.lookupRepository"),
    deleteRepository: unavailable("clientRuntime.managedRelayTenancy.deleteRepository"),
    addAlias: unavailable("clientRuntime.managedRelayTenancy.addAlias"),
    removeAlias: unavailable("clientRuntime.managedRelayTenancy.removeAlias"),
    listAccess: unavailable("clientRuntime.managedRelayTenancy.listAccess"),
    grantAccess: unavailable("clientRuntime.managedRelayTenancy.grantAccess"),
    revokeAccess: unavailable("clientRuntime.managedRelayTenancy.revokeAccess"),
    listMachines: unavailable("clientRuntime.managedRelayTenancy.listMachines"),
    provisionMachine: unavailable("clientRuntime.managedRelayTenancy.provisionMachine"),
    connectMachine: unavailable("clientRuntime.managedRelayTenancy.connectMachine"),
    deprovisionMachine: unavailable("clientRuntime.managedRelayTenancy.deprovisionMachine"),
    getGithubConnection: unavailable("clientRuntime.managedRelayTenancy.getGithubConnection"),
    connectGithub: unavailable("clientRuntime.managedRelayTenancy.connectGithub"),
    startGithubAppSetup: unavailable("clientRuntime.managedRelayTenancy.startGithubAppSetup"),
    disconnectGithub: unavailable("clientRuntime.managedRelayTenancy.disconnectGithub"),
    listGithubRepositories: unavailable("clientRuntime.managedRelayTenancy.listGithubRepositories"),
  });
}

export const make = Effect.fn("ManagedRelayTenancyClient.make")(function* (
  options: ManagedRelayTenancyClientOptions,
) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  if (relayUrl === null) {
    return disabledTenancyClient(options.relayUrl);
  }
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl: relayUrl });

  return ManagedRelayTenancyClient.of({
    relayUrl,
    getOrganization: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .getOrganization({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.mapError(relayRequestError("read relay organization")),
            timeoutRelayRequest("Relay organization read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getOrganization"),
      withRelayClientTracing,
    ),
    renameOrganization: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .renameOrganization({
            headers: bearerHeaders(input.clerkToken),
            payload: { name: input.name },
          })
          .pipe(
            Effect.mapError(relayRequestError("rename relay organization")),
            timeoutRelayRequest("Relay organization rename"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.renameOrganization"),
      withRelayClientTracing,
    ),
    listMembers: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .listOrganizationMembers({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.members),
            Effect.mapError(relayRequestError("list relay organization members")),
            timeoutRelayRequest("Relay organization member listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listMembers"),
      withRelayClientTracing,
    ),
    updateMemberRole: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .updateOrganizationMember({
            headers: bearerHeaders(input.clerkToken),
            params: { userId: input.userId },
            payload: { role: input.role },
          })
          .pipe(
            Effect.mapError(relayRequestError("update relay organization member")),
            timeoutRelayRequest("Relay organization member update"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.updateMemberRole"),
      withRelayClientTracing,
    ),
    removeMember: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .removeOrganizationMember({
            headers: bearerHeaders(input.clerkToken),
            params: { userId: input.userId },
          })
          .pipe(
            Effect.mapError(relayRequestError("remove relay organization member")),
            timeoutRelayRequest("Relay organization member removal"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.removeMember"),
      withRelayClientTracing,
    ),
    listInvitations: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .listInvitations({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.invitations),
            Effect.mapError(relayRequestError("list relay invitations")),
            timeoutRelayRequest("Relay invitation listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listInvitations"),
      withRelayClientTracing,
    ),
    createInvitation: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .createInvitation({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("create relay invitation")),
            timeoutRelayRequest("Relay invitation creation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.createInvitation"),
      withRelayClientTracing,
    ),
    revokeInvitation: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .revokeInvitation({
            headers: bearerHeaders(input.clerkToken),
            params: { invitationId: input.invitationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("revoke relay invitation")),
            timeoutRelayRequest("Relay invitation revocation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.revokeInvitation"),
      withRelayClientTracing,
    ),
    acceptInvitation: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .acceptInvitation({
            headers: bearerHeaders(input.clerkToken),
            payload: { token: input.token },
          })
          .pipe(
            Effect.mapError(relayRequestError("accept relay invitation")),
            timeoutRelayRequest("Relay invitation acceptance"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.acceptInvitation"),
      withRelayClientTracing,
    ),
    listRepositories: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .listRepositories({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.repositories),
            Effect.mapError(relayRequestError("list relay repositories")),
            timeoutRelayRequest("Relay repository listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listRepositories"),
      withRelayClientTracing,
    ),
    listOrganizationProjects: Effect.fnUntraced(
      function* (input) {
        return yield* client.organizationProjects
          .listOrganizationProjects({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.projects),
            Effect.mapError(relayRequestError("list relay organization projects")),
            timeoutRelayRequest("Relay organization project listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listOrganizationProjects"),
      withRelayClientTracing,
    ),
    registerRepository: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .registerRepository({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("register relay repository")),
            timeoutRelayRequest("Relay repository registration"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.registerRepository"),
      withRelayClientTracing,
    ),
    lookupRepository: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .lookupRepository({
            headers: bearerHeaders(input.clerkToken),
            payload: { canonicalKey: input.canonicalKey },
          })
          .pipe(
            Effect.mapError(relayRequestError("look up relay repository")),
            timeoutRelayRequest("Relay repository lookup"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.lookupRepository"),
      withRelayClientTracing,
    ),
    deleteRepository: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .deleteRepository({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId },
          })
          .pipe(
            Effect.mapError(relayRequestError("delete relay repository")),
            timeoutRelayRequest("Relay repository removal"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.deleteRepository"),
      withRelayClientTracing,
    ),
    addAlias: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .addRepositoryAlias({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId },
            payload: { canonicalKey: input.canonicalKey },
          })
          .pipe(
            Effect.mapError(relayRequestError("add relay repository alias")),
            timeoutRelayRequest("Relay repository alias addition"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.addAlias"),
      withRelayClientTracing,
    ),
    removeAlias: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .removeRepositoryAlias({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId },
            payload: { canonicalKey: input.canonicalKey },
          })
          .pipe(
            Effect.mapError(relayRequestError("remove relay repository alias")),
            timeoutRelayRequest("Relay repository alias removal"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.removeAlias"),
      withRelayClientTracing,
    ),
    listAccess: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .listRepositoryAccess({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId },
          })
          .pipe(
            Effect.map((response) => response.access),
            Effect.mapError(relayRequestError("list relay repository access")),
            timeoutRelayRequest("Relay repository access listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listAccess"),
      withRelayClientTracing,
    ),
    grantAccess: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .grantRepositoryAccess({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("grant relay repository access")),
            timeoutRelayRequest("Relay repository access grant"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.grantAccess"),
      withRelayClientTracing,
    ),
    revokeAccess: Effect.fnUntraced(
      function* (input) {
        return yield* client.repositories
          .revokeRepositoryAccess({
            headers: bearerHeaders(input.clerkToken),
            params: { repositoryId: input.repositoryId, userId: input.userId },
          })
          .pipe(
            Effect.mapError(relayRequestError("revoke relay repository access")),
            timeoutRelayRequest("Relay repository access revocation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.revokeAccess"),
      withRelayClientTracing,
    ),
    listMachines: Effect.fnUntraced(
      function* (input) {
        return yield* client.machines
          .listMachines({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.machines),
            Effect.mapError(relayRequestError("list relay machines")),
            timeoutRelayRequest("Relay machine listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listMachines"),
      withRelayClientTracing,
    ),
    provisionMachine: Effect.fnUntraced(
      function* (input) {
        return yield* client.machines
          .provisionMachine({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("provision relay machine")),
            timeoutRelayRequest("Relay machine provisioning"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.provisionMachine"),
      withRelayClientTracing,
    ),
    connectMachine: Effect.fnUntraced(
      function* (input) {
        return yield* client.machines
          .connectMachine({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("connect relay machine")),
            timeoutRelayRequest("Relay machine connection"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.connectMachine"),
      withRelayClientTracing,
    ),
    deprovisionMachine: Effect.fnUntraced(
      function* (input) {
        return yield* client.machines
          .deprovisionMachine({
            headers: bearerHeaders(input.clerkToken),
            params: { machineId: input.machineId },
          })
          .pipe(
            Effect.mapError(relayRequestError("deprovision relay machine")),
            timeoutRelayRequest("Relay machine deprovisioning"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.deprovisionMachine"),
      withRelayClientTracing,
    ),
    getGithubConnection: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .getGithubConnection({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.mapError(relayRequestError("read relay GitHub connection")),
            timeoutRelayRequest("Relay GitHub connection read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getGithubConnection"),
      withRelayClientTracing,
    ),
    connectGithub: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .connectGithub({
            headers: bearerHeaders(input.clerkToken),
            payload: { installationId: input.installationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("connect relay GitHub")),
            timeoutRelayRequest("Relay GitHub connection"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.connectGithub"),
      withRelayClientTracing,
    ),
    startGithubAppSetup: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .startGithubAppSetup({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("start relay GitHub App setup")),
            timeoutRelayRequest("Relay GitHub App setup"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.startGithubAppSetup"),
      withRelayClientTracing,
    ),
    disconnectGithub: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .disconnectGithub({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.mapError(relayRequestError("disconnect relay GitHub")),
            timeoutRelayRequest("Relay GitHub disconnection"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.disconnectGithub"),
      withRelayClientTracing,
    ),
    listGithubRepositories: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .listGithubRepositories({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.repositories),
            Effect.mapError(relayRequestError("list relay GitHub repositories")),
            timeoutRelayRequest("Relay GitHub repository listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listGithubRepositories"),
      withRelayClientTracing,
    ),
  });
});

export const layer = (options: ManagedRelayTenancyClientOptions) =>
  Layer.effect(ManagedRelayTenancyClient, make(options));
