import type { RelayThreadDeletionRequest, RelayThreadDeletion } from "@t3tools/contracts/relay";
/**
 * Organization, repository, and retained portable-thread calls against the relay.
 *
 * Separate from `ManagedRelayClient` on purpose: that service exists to reach
 * an environment, and it authenticates with DPoP-bound tokens to do it. These
 * calls read and write relay-owned records with a plain Clerk bearer. Reading
 * retained thread history does not connect to or wake its environment.
 */
import type {
  PortableThreadCommand,
  ThreadId,
  RepositoryAccessRemovalStatus,
} from "@t3tools/contracts";
import {
  RelayApi,
  type ThreadVmPolicyRecord,
  type RelayThreadVmStatus,
  type RelayThreadVmProviderAuth,
  type RelayThreadVmProviderAuthRequest,
  type RelayThreadVmPreviewResponse,
  type RelayThreadVmCreateRequest,
  type RelayThreadVmCreateResponse,
  type RelayThreadVmSetup,
  type RelayThreadVmResumeResponse,
  type RelayThreadVmCancelSetupResponse,
  type RelayThreadVmResetRequest,
  type RelayThreadVmResetResponse,
  type RelayThreadVmReset,
  type RelayThreadVmRestoreRequest,
  type RelayThreadVmRestoreResponse,
  type RelayThreadVmRestore,
  type RelayThreadVmBackupRecoveryCandidate,
  type RelayThreadVmBackupRecoveryRequest,
  type RelayThreadVmBackupRecoveryCancellation,
  type RelayThreadVmReplacement,
  type RelayThreadVmReplacementCandidate,
  type RelayPortableThreadPlacement,
  type RelayPortableThreadPage,
  type RelayThreadHistoryPage,
  type RelayThreadCommandReceipt,
  type RelayThreadPendingCommandPage,
  type RelayConnectMachineResponse,
  type RelayCreateInvitationRequest,
  type RelayCreateInvitationResponse,
  type RelayGithubInstallResponse,
  type RelayGithubInstallationCandidate,
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
  type RelayProviderAccount,
  type RelayProviderAccountProvider,
  type RelayProvisionMachineRequest,
  type RelaySaveProviderAccountRequest,
  type RelayOrganizationSkill,
  type RelayOrganizationSkillName,
  type RelaySaveOrganizationSkillRequest,
  type RelayRegisterRepositoryRequest,
  type RelayRepository,
  type RelayStartGithubInstallRequest,
  type RelayRepositoryAccessEntry,
  type RelayRepositoryId,
  type RelayRepositorySummary,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import {
  bearerHeaders,
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
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
    readonly getAccessRemoval: (input: {
      readonly clerkToken: string;
      readonly revision?: number;
    }) => Effect.Effect<RepositoryAccessRemovalStatus, ManagedRelayClientError>;
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
    readonly stagePortableThreadCommand: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly command: PortableThreadCommand;
    }) => Effect.Effect<RelayThreadCommandReceipt, ManagedRelayClientError>;
    readonly getPendingPortableThreadCommands: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly after: number;
      readonly limit: number;
    }) => Effect.Effect<RelayThreadPendingCommandPage, ManagedRelayClientError>;
    readonly getPortableThreadCommandReceipt: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly commandId: string;
    }) => Effect.Effect<RelayThreadCommandReceipt | null, ManagedRelayClientError>;
    readonly listPortableThreads: (input: {
      readonly clerkToken: string;
      readonly after?: string;
      readonly limit: number;
    }) => Effect.Effect<RelayPortableThreadPage, ManagedRelayClientError>;
    readonly getPortableThreadPlacement: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayPortableThreadPlacement, ManagedRelayClientError>;
    readonly downloadPortableThreadAttachment: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly attachmentId: string;
    }) => Effect.Effect<Uint8Array, ManagedRelayClientError>;
    readonly getPortableThreadHistory: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly after: number;
      readonly limit: number;
    }) => Effect.Effect<RelayThreadHistoryPage, ManagedRelayClientError>;
    readonly openThreadVmPreview: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly port: number;
    }) => Effect.Effect<RelayThreadVmPreviewResponse, ManagedRelayClientError>;
    readonly getThreadVmStatus: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmStatus, ManagedRelayClientError>;
    readonly getThreadVmProviderAuth: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmProviderAuth | null, ManagedRelayClientError>;
    readonly startThreadVmProviderAuth: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmProviderAuthRequest;
    }) => Effect.Effect<RelayThreadVmProviderAuth, ManagedRelayClientError>;
    readonly cancelThreadVmProviderAuth: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmProviderAuthRequest & { readonly flowId: string };
    }) => Effect.Effect<RelayThreadVmProviderAuth, ManagedRelayClientError>;
    readonly getThreadVmSetup: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmSetup | null, ManagedRelayClientError>;
    readonly resumeThreadVm: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmResumeResponse, ManagedRelayClientError>;
    readonly cancelThreadVmSetup: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmCancelSetupResponse, ManagedRelayClientError>;
    readonly createThreadVm: (input: {
      readonly clerkToken: string;
      readonly payload: RelayThreadVmCreateRequest;
    }) => Effect.Effect<RelayThreadVmCreateResponse, ManagedRelayClientError>;
    readonly permanentlyDeleteThread: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadDeletionRequest;
    }) => Effect.Effect<RelayThreadDeletion, ManagedRelayClientError>;
    readonly getThreadDeletion: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadDeletion, ManagedRelayClientError>;
    readonly resetThreadVm: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmResetRequest;
    }) => Effect.Effect<RelayThreadVmResetResponse, ManagedRelayClientError>;
    readonly getThreadVmReset: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly operationId: string;
    }) => Effect.Effect<RelayThreadVmReset, ManagedRelayClientError>;
    readonly cancelThreadVmReset: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly operationId: string;
    }) => Effect.Effect<RelayThreadVmReset, ManagedRelayClientError>;
    readonly restoreThreadVm: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmRestoreRequest;
    }) => Effect.Effect<RelayThreadVmRestoreResponse, ManagedRelayClientError>;
    readonly getThreadVmBackupRecovery: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<RelayThreadVmBackupRecoveryCandidate | null, ManagedRelayClientError>;
    readonly restoreThreadVmBackup: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmBackupRecoveryRequest;
    }) => Effect.Effect<RelayThreadVmRestoreResponse, ManagedRelayClientError>;
    readonly cancelThreadVmBackupRecovery: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly payload: RelayThreadVmBackupRecoveryRequest;
    }) => Effect.Effect<RelayThreadVmBackupRecoveryCancellation, ManagedRelayClientError>;
    readonly getThreadVmRestore: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly operationId: string;
    }) => Effect.Effect<RelayThreadVmRestore, ManagedRelayClientError>;
    readonly cancelThreadVmRestore: (input: {
      readonly clerkToken: string;
      readonly threadId: ThreadId;
      readonly operationId: string;
    }) => Effect.Effect<RelayThreadVmRestore, ManagedRelayClientError>;
    readonly getThreadVmReplacementCandidates: (input: {
      readonly clerkToken: string;
      readonly requestId: string;
    }) => Effect.Effect<ReadonlyArray<RelayThreadVmReplacementCandidate>, ManagedRelayClientError>;
    readonly getThreadVmReplacement: (input: {
      readonly clerkToken: string;
      readonly requestId: string;
    }) => Effect.Effect<RelayThreadVmReplacement, ManagedRelayClientError>;
    readonly selectThreadVmReplacement: (input: {
      readonly clerkToken: string;
      readonly requestId: string;
      readonly victimAllocationId: string;
    }) => Effect.Effect<RelayThreadVmReplacement, ManagedRelayClientError>;
    readonly cancelThreadVmReplacement: (input: {
      readonly clerkToken: string;
      readonly requestId: string;
    }) => Effect.Effect<RelayThreadVmReplacement, ManagedRelayClientError>;
    readonly getThreadVmPolicy: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ThreadVmPolicyRecord, ManagedRelayClientError>;
    readonly updateThreadVmPolicy: (input: {
      readonly clerkToken: string;
      readonly payload: ThreadVmPolicyRecord;
    }) => Effect.Effect<ThreadVmPolicyRecord, ManagedRelayClientError>;
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
    readonly startGithubInstall: (input: {
      readonly clerkToken: string;
      readonly payload: RelayStartGithubInstallRequest;
    }) => Effect.Effect<RelayGithubInstallResponse, ManagedRelayClientError>;
    readonly listGithubInstallations: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayGithubInstallationCandidate>, ManagedRelayClientError>;
    readonly disconnectGithub: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly listGithubRepositories: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayGithubRepository>, ManagedRelayClientError>;
    readonly listProviderAccounts: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayProviderAccount>, ManagedRelayClientError>;
    readonly saveProviderAccount: (input: {
      readonly clerkToken: string;
      readonly provider: RelayProviderAccountProvider;
      readonly payload: RelaySaveProviderAccountRequest;
    }) => Effect.Effect<RelayProviderAccount, ManagedRelayClientError>;
    readonly deleteProviderAccount: (input: {
      readonly clerkToken: string;
      readonly provider: RelayProviderAccountProvider;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly listSkills: (input: {
      readonly clerkToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayOrganizationSkill>, ManagedRelayClientError>;
    readonly saveSkill: (input: {
      readonly clerkToken: string;
      readonly name: RelayOrganizationSkillName;
      readonly payload: RelaySaveOrganizationSkillRequest;
    }) => Effect.Effect<RelayOrganizationSkill, ManagedRelayClientError>;
    readonly deleteSkill: (input: {
      readonly clerkToken: string;
      readonly name: RelayOrganizationSkillName;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
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
    getAccessRemoval: unavailable("clientRuntime.managedRelayTenancy.getAccessRemoval"),
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
    stagePortableThreadCommand: unavailable(
      "clientRuntime.managedRelayTenancy.stagePortableThreadCommand",
    ),
    getPendingPortableThreadCommands: unavailable(
      "clientRuntime.managedRelayTenancy.getPendingPortableThreadCommands",
    ),
    getPortableThreadCommandReceipt: unavailable(
      "clientRuntime.managedRelayTenancy.getPortableThreadCommandReceipt",
    ),
    listPortableThreads: unavailable("clientRuntime.managedRelayTenancy.listPortableThreads"),
    getPortableThreadPlacement: unavailable(
      "clientRuntime.managedRelayTenancy.getPortableThreadPlacement",
    ),
    downloadPortableThreadAttachment: unavailable(
      "clientRuntime.managedRelayTenancy.downloadPortableThreadAttachment",
    ),
    getPortableThreadHistory: unavailable(
      "clientRuntime.managedRelayTenancy.getPortableThreadHistory",
    ),
    openThreadVmPreview: unavailable("clientRuntime.managedRelayTenancy.openThreadVmPreview"),
    getThreadVmStatus: unavailable("clientRuntime.managedRelayTenancy.getThreadVmStatus"),
    getThreadVmProviderAuth: unavailable(
      "clientRuntime.managedRelayTenancy.getThreadVmProviderAuth",
    ),
    startThreadVmProviderAuth: unavailable(
      "clientRuntime.managedRelayTenancy.startThreadVmProviderAuth",
    ),
    cancelThreadVmProviderAuth: unavailable(
      "clientRuntime.managedRelayTenancy.cancelThreadVmProviderAuth",
    ),
    getThreadVmSetup: unavailable("clientRuntime.managedRelayTenancy.getThreadVmSetup"),
    resumeThreadVm: unavailable("clientRuntime.managedRelayTenancy.resumeThreadVm"),
    cancelThreadVmSetup: unavailable("clientRuntime.managedRelayTenancy.cancelThreadVmSetup"),
    createThreadVm: unavailable("clientRuntime.managedRelayTenancy.createThreadVm"),
    permanentlyDeleteThread: unavailable(
      "clientRuntime.managedRelayTenancy.permanentlyDeleteThread",
    ),
    getThreadDeletion: unavailable("clientRuntime.managedRelayTenancy.getThreadDeletion"),
    resetThreadVm: unavailable("clientRuntime.managedRelayTenancy.resetThreadVm"),
    getThreadVmReset: unavailable("clientRuntime.managedRelayTenancy.getThreadVmReset"),
    cancelThreadVmReset: unavailable("clientRuntime.managedRelayTenancy.cancelThreadVmReset"),
    restoreThreadVm: unavailable("clientRuntime.managedRelayTenancy.restoreThreadVm"),
    getThreadVmBackupRecovery: unavailable(
      "clientRuntime.managedRelayTenancy.getThreadVmBackupRecovery",
    ),
    restoreThreadVmBackup: unavailable("clientRuntime.managedRelayTenancy.restoreThreadVmBackup"),
    cancelThreadVmBackupRecovery: unavailable(
      "clientRuntime.managedRelayTenancy.cancelThreadVmBackupRecovery",
    ),
    getThreadVmRestore: unavailable("clientRuntime.managedRelayTenancy.getThreadVmRestore"),
    cancelThreadVmRestore: unavailable("clientRuntime.managedRelayTenancy.cancelThreadVmRestore"),
    getThreadVmReplacementCandidates: unavailable(
      "clientRuntime.managedRelayTenancy.getThreadVmReplacementCandidates",
    ),
    getThreadVmReplacement: unavailable("clientRuntime.managedRelayTenancy.getThreadVmReplacement"),
    selectThreadVmReplacement: unavailable(
      "clientRuntime.managedRelayTenancy.selectThreadVmReplacement",
    ),
    cancelThreadVmReplacement: unavailable(
      "clientRuntime.managedRelayTenancy.cancelThreadVmReplacement",
    ),
    getThreadVmPolicy: unavailable("clientRuntime.managedRelayTenancy.getThreadVmPolicy"),
    updateThreadVmPolicy: unavailable("clientRuntime.managedRelayTenancy.updateThreadVmPolicy"),
    listMachines: unavailable("clientRuntime.managedRelayTenancy.listMachines"),
    provisionMachine: unavailable("clientRuntime.managedRelayTenancy.provisionMachine"),
    connectMachine: unavailable("clientRuntime.managedRelayTenancy.connectMachine"),
    deprovisionMachine: unavailable("clientRuntime.managedRelayTenancy.deprovisionMachine"),
    getGithubConnection: unavailable("clientRuntime.managedRelayTenancy.getGithubConnection"),
    connectGithub: unavailable("clientRuntime.managedRelayTenancy.connectGithub"),
    startGithubInstall: unavailable("clientRuntime.managedRelayTenancy.startGithubInstall"),
    listGithubInstallations: unavailable(
      "clientRuntime.managedRelayTenancy.listGithubInstallations",
    ),
    disconnectGithub: unavailable("clientRuntime.managedRelayTenancy.disconnectGithub"),
    listGithubRepositories: unavailable("clientRuntime.managedRelayTenancy.listGithubRepositories"),
    listProviderAccounts: unavailable("clientRuntime.managedRelayTenancy.listProviderAccounts"),
    saveProviderAccount: unavailable("clientRuntime.managedRelayTenancy.saveProviderAccount"),
    deleteProviderAccount: unavailable("clientRuntime.managedRelayTenancy.deleteProviderAccount"),
    listSkills: unavailable("clientRuntime.managedRelayTenancy.listSkills"),
    saveSkill: unavailable("clientRuntime.managedRelayTenancy.saveSkill"),
    deleteSkill: unavailable("clientRuntime.managedRelayTenancy.deleteSkill"),
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
    getAccessRemoval: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .getRepositoryAccessRemoval({
            headers: bearerHeaders(input.clerkToken),
            query: input.revision === undefined ? {} : { revision: input.revision },
          })
          .pipe(
            Effect.mapError(relayRequestError("read access removal status")),
            timeoutRelayRequest("Access removal status"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getAccessRemoval"),
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
    stagePortableThreadCommand: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadCommands
          .stage({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: { command: input.command },
          })
          .pipe(
            Effect.mapError(relayRequestError("queue portable thread command")),
            timeoutRelayRequest("Portable thread command submission"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.stagePortableThreadCommand"),
      withRelayClientTracing,
    ),
    getPendingPortableThreadCommands: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadCommands
          .pending({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            query: { after: input.after, limit: input.limit },
          })
          .pipe(
            Effect.mapError(relayRequestError("read pending portable thread commands")),
            timeoutRelayRequest("Pending portable thread commands"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getPendingPortableThreadCommands"),
      withRelayClientTracing,
    ),
    getPortableThreadCommandReceipt: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadCommands
          .receipt({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, commandId: input.commandId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read portable thread command receipt")),
            timeoutRelayRequest("Portable thread command receipt read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getPortableThreadCommandReceipt"),
      withRelayClientTracing,
    ),
    listPortableThreads: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadHistory
          .listThreads({
            headers: bearerHeaders(input.clerkToken),
            query: {
              limit: input.limit,
              ...(input.after === undefined ? {} : { after: input.after }),
            },
          })
          .pipe(
            Effect.mapError(relayRequestError("list portable threads")),
            timeoutRelayRequest("Portable thread list read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listPortableThreads"),
      withRelayClientTracing,
    ),
    getPortableThreadPlacement: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadHistory
          .getPlacement({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read portable thread placement")),
            timeoutRelayRequest("Portable thread placement read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getPortableThreadPlacement"),
      withRelayClientTracing,
    ),
    downloadPortableThreadAttachment: Effect.fnUntraced(
      function* (input) {
        const body = yield* client.threadHistory
          .getAttachment({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, attachmentId: input.attachmentId },
          })
          .pipe(Effect.mapError(relayRequestError("read saved thread attachment")));
        const parts: Uint8Array[] = [];
        let size = 0;
        yield* body.pipe(
          Stream.mapError(relayRequestError("read saved thread attachment")),
          Stream.runForEach((part) =>
            Effect.gen(function* () {
              size += part.length;
              if (size > 50 * 1024 * 1024)
                return yield* Effect.fail(
                  new ManagedRelayRequestFailedError({
                    action: "read saved thread attachment",
                    cause: new Error("Attachment exceeded the download limit."),
                  }),
                );
              parts.push(part);
            }),
          ),
        );
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return bytes;
      },
      timeoutRelayRequest("Saved thread attachment download"),
      Effect.withSpan("clientRuntime.managedRelayTenancy.downloadPortableThreadAttachment"),
      withRelayClientTracing,
    ),
    getPortableThreadHistory: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadHistory
          .getHistory({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            query: { after: input.after, limit: input.limit },
          })
          .pipe(
            Effect.mapError(relayRequestError("read portable thread history")),
            timeoutRelayRequest("Portable thread history read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getPortableThreadHistory"),
      withRelayClientTracing,
    ),
    openThreadVmPreview: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .openPreview({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: { port: input.port },
          })
          .pipe(
            Effect.mapError(relayRequestError("open private VM preview")),
            timeoutRelayRequest("Private VM preview"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.openThreadVmPreview"),
      withRelayClientTracing,
    ),
    getThreadVmStatus: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getStatus({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read thread VM status")),
            timeoutRelayRequest("Thread VM status read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmStatus"),
      withRelayClientTracing,
    ),
    getThreadVmProviderAuth: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getProviderAuth({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM Codex sign-in")),
            timeoutRelayRequest("VM Codex sign-in read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmProviderAuth"),
      withRelayClientTracing,
    ),
    startThreadVmProviderAuth: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .startProviderAuth({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("start VM Codex sign-in")),
            timeoutRelayRequest("VM Codex sign-in start"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.startThreadVmProviderAuth"),
      withRelayClientTracing,
    ),
    cancelThreadVmProviderAuth: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelProviderAuth({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel VM Codex sign-in")),
            timeoutRelayRequest("VM Codex sign-in cancellation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmProviderAuth"),
      withRelayClientTracing,
    ),
    getThreadVmSetup: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getSetup({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read thread VM setup")),
            timeoutRelayRequest("Thread VM setup read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmSetup"),
      withRelayClientTracing,
    ),
    resumeThreadVm: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .resume({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("resume thread VM")),
            timeoutRelayRequest("Thread VM resume"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.resumeThreadVm"),
      withRelayClientTracing,
    ),
    cancelThreadVmSetup: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelSetup({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel thread VM setup")),
            timeoutRelayRequest("Thread VM setup cancellation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmSetup"),
      withRelayClientTracing,
    ),
    createThreadVm: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .create({ headers: bearerHeaders(input.clerkToken), payload: input.payload })
          .pipe(
            Effect.mapError(relayRequestError("create thread VM")),
            timeoutRelayRequest("Thread VM creation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.createThreadVm"),
      withRelayClientTracing,
    ),
    permanentlyDeleteThread: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .permanentlyDelete({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("permanently delete thread")),
            timeoutRelayRequest("Thread deletion"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.permanentlyDeleteThread"),
      withRelayClientTracing,
    ),
    getThreadDeletion: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getDeletion({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read thread deletion")),
            timeoutRelayRequest("Thread deletion status"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadDeletion"),
      withRelayClientTracing,
    ),
    resetThreadVm: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .reset({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("reset thread VM")),
            timeoutRelayRequest("VM reset"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.resetThreadVm"),
      withRelayClientTracing,
    ),
    getThreadVmReset: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getReset({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, operationId: input.operationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM reset")),
            timeoutRelayRequest("VM reset status"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmReset"),
      withRelayClientTracing,
    ),
    cancelThreadVmReset: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelReset({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, operationId: input.operationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel VM reset")),
            timeoutRelayRequest("VM reset cancellation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmReset"),
      withRelayClientTracing,
    ),
    restoreThreadVm: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .restore({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("restore thread VM")),
            timeoutRelayRequest("VM restore"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.restoreThreadVm"),
      withRelayClientTracing,
    ),
    getThreadVmBackupRecovery: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getBackupRecovery({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM backup recovery")),
            timeoutRelayRequest("VM backup recovery"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmBackupRecovery"),
      withRelayClientTracing,
    ),
    restoreThreadVmBackup: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .restoreBackup({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("restore VM backup")),
            timeoutRelayRequest("VM backup recovery"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.restoreThreadVmBackup"),
      withRelayClientTracing,
    ),
    cancelThreadVmBackupRecovery: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelBackupRecovery({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel VM backup recovery")),
            timeoutRelayRequest("VM backup recovery"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmBackupRecovery"),
      withRelayClientTracing,
    ),
    getThreadVmRestore: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getRestore({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, operationId: input.operationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM restore")),
            timeoutRelayRequest("VM restore status"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmRestore"),
      withRelayClientTracing,
    ),
    cancelThreadVmRestore: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelRestore({
            headers: bearerHeaders(input.clerkToken),
            params: { threadId: input.threadId, operationId: input.operationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel VM restore")),
            timeoutRelayRequest("VM restore cancellation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmRestore"),
      withRelayClientTracing,
    ),
    getThreadVmReplacementCandidates: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getReplacementCandidates({
            headers: bearerHeaders(input.clerkToken),
            params: { requestId: input.requestId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM replacement choices")),
            timeoutRelayRequest("VM replacement choices"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmReplacementCandidates"),
      withRelayClientTracing,
    ),
    getThreadVmReplacement: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .getReplacement({
            headers: bearerHeaders(input.clerkToken),
            params: { requestId: input.requestId },
          })
          .pipe(
            Effect.mapError(relayRequestError("read VM replacement")),
            timeoutRelayRequest("VM replacement read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmReplacement"),
      withRelayClientTracing,
    ),
    selectThreadVmReplacement: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .selectReplacement({
            headers: bearerHeaders(input.clerkToken),
            params: { requestId: input.requestId },
            payload: { victimAllocationId: input.victimAllocationId },
          })
          .pipe(
            Effect.mapError(relayRequestError("select VM replacement")),
            timeoutRelayRequest("VM replacement selection"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.selectThreadVmReplacement"),
      withRelayClientTracing,
    ),
    cancelThreadVmReplacement: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVms
          .cancelReplacement({
            headers: bearerHeaders(input.clerkToken),
            params: { requestId: input.requestId },
          })
          .pipe(
            Effect.mapError(relayRequestError("cancel VM replacement")),
            timeoutRelayRequest("VM replacement cancellation"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.cancelThreadVmReplacement"),
      withRelayClientTracing,
    ),
    getThreadVmPolicy: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVmPolicy
          .getThreadVmPolicy({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.mapError(relayRequestError("read thread VM policy")),
            timeoutRelayRequest("Thread VM policy read"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.getThreadVmPolicy"),
      withRelayClientTracing,
    ),
    updateThreadVmPolicy: Effect.fnUntraced(
      function* (input) {
        return yield* client.threadVmPolicy
          .updateThreadVmPolicy({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("update thread VM policy")),
            timeoutRelayRequest("Thread VM policy update"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.updateThreadVmPolicy"),
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
    startGithubInstall: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .startGithubInstall({
            headers: bearerHeaders(input.clerkToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("start relay GitHub install")),
            timeoutRelayRequest("Relay GitHub install"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.startGithubInstall"),
      withRelayClientTracing,
    ),
    listGithubInstallations: Effect.fnUntraced(
      function* (input) {
        const response = yield* client.organization
          .listGithubInstallations({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.mapError(relayRequestError("list relay GitHub installations")),
            timeoutRelayRequest("Relay GitHub installation listing"),
          );
        return response.installations;
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listGithubInstallations"),
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
    listProviderAccounts: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .listProviderAccounts({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.accounts),
            Effect.mapError(relayRequestError("list relay provider accounts")),
            timeoutRelayRequest("Relay provider account listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listProviderAccounts"),
      withRelayClientTracing,
    ),
    saveProviderAccount: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .saveProviderAccount({
            headers: bearerHeaders(input.clerkToken),
            params: { provider: input.provider },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("save relay provider account")),
            timeoutRelayRequest("Relay provider account save"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.saveProviderAccount"),
      withRelayClientTracing,
    ),
    deleteProviderAccount: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .deleteProviderAccount({
            headers: bearerHeaders(input.clerkToken),
            params: { provider: input.provider },
          })
          .pipe(
            Effect.mapError(relayRequestError("delete relay provider account")),
            timeoutRelayRequest("Relay provider account removal"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.deleteProviderAccount"),
      withRelayClientTracing,
    ),
    listSkills: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .listSkills({ headers: bearerHeaders(input.clerkToken) })
          .pipe(
            Effect.map((response) => response.skills),
            Effect.mapError(relayRequestError("list relay organization skills")),
            timeoutRelayRequest("Relay organization skill listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.listSkills"),
      withRelayClientTracing,
    ),
    saveSkill: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .saveSkill({
            headers: bearerHeaders(input.clerkToken),
            params: { name: input.name },
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("save relay organization skill")),
            timeoutRelayRequest("Relay organization skill save"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.saveSkill"),
      withRelayClientTracing,
    ),
    deleteSkill: Effect.fnUntraced(
      function* (input) {
        return yield* client.organization
          .deleteSkill({
            headers: bearerHeaders(input.clerkToken),
            params: { name: input.name },
          })
          .pipe(
            Effect.mapError(relayRequestError("delete relay organization skill")),
            timeoutRelayRequest("Relay organization skill removal"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelayTenancy.deleteSkill"),
      withRelayClientTracing,
    ),
  });
});

export const layer = (options: ManagedRelayTenancyClientOptions) =>
  Layer.effect(ManagedRelayTenancyClient, make(options));
