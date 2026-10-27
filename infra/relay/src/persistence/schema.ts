import type { RuntimeMode } from "@t3tools/contracts";
import type {
  RepositoryWorkflow,
  RepositoryWorkflowJob,
  RepositoryWorkflowJobSummary,
  RespondToWorkflowJob,
} from "@t3tools/contracts/workflows";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayJobStatus,
  RelayMachineComputeKind,
  RelayMachineRole,
  RelayManagedEndpointProviderKind,
  RelayOrgRole,
  RelayRepositoryRole,
  RelayManagedEndpointOrigin,
  RelayThreadVmRepositoryUpload,
  RelayIssueTrackerService,
  RelayJiraSite,
} from "@t3tools/contracts/relay";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// A moved VM finishes the move importer, not initial repository setup. Lifecycle
// and connection readers use the same derived receipt for either activation path.
export const relayThreadVmReady = pgView("relay_thread_vm_ready", {
  allocationId: varchar("allocation_id", { length: 64 }),
  environmentId: varchar("environment_id", { length: 191 }),
  generation: integer("generation"),
  phase: varchar("phase", { length: 16 }),
  receiptSha256: varchar("receipt_sha256", { length: 64 }),
}).as(sql`
  SELECT p.allocation_id, b.environment_id, b.generation, 'ready'::varchar(16) AS phase,
    coalesce(s.receipt_sha256, m.manifest_sha256) AS receipt_sha256
  FROM relay_thread_vm_provisions p
  JOIN relay_thread_vm_bindings b ON b.allocation_id=p.allocation_id
    AND b.generation=p.generation AND b.revoked_at IS NULL
  LEFT JOIN relay_thread_vm_setups s ON s.allocation_id=p.allocation_id
    AND s.environment_id=b.environment_id AND s.phase='ready' AND s.receipt_sha256 IS NOT NULL
  LEFT JOIN relay_thread_vm_move_destinations d ON d.allocation_id=p.allocation_id
    AND d.operation_id=p.operation_id
  LEFT JOIN relay_thread_moves m ON m.operation_id=d.operation_id AND m.thread_id=b.thread_id
    AND m.destination_environment_id=b.environment_id AND m.expected_generation+1=b.generation
    AND m.phase='completed'
  WHERE p.phase='created' AND (s.receipt_sha256 IS NOT NULL OR m.manifest_sha256 IS NOT NULL)
`);

export const relayOrganizations = pgTable("relay_organizations", {
  organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
  name: text("name").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayOrganizationMembers = pgTable(
  "relay_organization_members",
  {
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    role: varchar("role", { length: 16 }).notNull().$type<RelayOrgRole>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    // A user belongs to exactly one organization. The database says so rather
    // than the service, because "which organization is this subject in" is
    // resolved on every authorized path and must not have two answers.
    uniqueIndex("idx_relay_organization_members_user").on(table.userId),
    index("idx_relay_organization_members_role").on(table.organizationId, table.role),
  ],
);

export const relayOrganizationInvitations = pgTable(
  "relay_organization_invitations",
  {
    invitationId: varchar("invitation_id", { length: 64 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    // Lowercased on write; the address is matched against the accepting
    // subject's verified Clerk address, never trusted from the client.
    email: text("email").notNull(),
    role: varchar("role", { length: 16 }).notNull().$type<RelayOrgRole>(),
    invitedByUserId: varchar("invited_by_user_id", { length: 191 }).notNull(),
    // Only the hash is stored: the token is a bearer secret and the relay has
    // no reason to be able to reproduce one it already handed out.
    tokenHash: varchar("token_hash", { length: 191 }).notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    acceptedAt: varchar("accepted_at", { length: 64 }),
    acceptedByUserId: varchar("accepted_by_user_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_organization_invitations_token").on(table.tokenHash),
    index("idx_relay_organization_invitations_organization").on(
      table.organizationId,
      table.createdAt,
    ),
    index("idx_relay_organization_invitations_email").on(table.email),
  ],
);

/**
 * The relay's own GitHub App, when it was created from Organization settings
 * rather than configured through `GITHUB_APP_*`. One relay has one App; the
 * environment configuration wins when both exist.
 *
 * The private key is stored sealed (AES-GCM under a key derived from the
 * relay's cloud mint key, see `auth/SecretBox.ts`), so a copy of this table
 * on its own is inert.
 */
export const relayGithubApps = pgTable("relay_github_apps", {
  appId: varchar("app_id", { length: 64 }).primaryKey(),
  appSlug: text("app_slug").notNull(),
  privateKeySealed: text("private_key_sealed").notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 191 }).notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
});

/**
 * An organization's account for one provider: the provider CLI's own auth
 * store or an API-style token, captured once by an admin and handed to the
 * organization's agent executors so nobody signs in on a machine (ADR-0003,
 * "organization provider accounts" amendment).
 *
 * The payload is stored sealed (AES-GCM under a key derived from the relay's
 * cloud mint key, see `auth/SecretBox.ts`), so a copy of this table on its
 * own is inert. One row per provider per organization; `version` changes on
 * every save so executors can tell a re-sign-in from a repeat.
 */
export const relayOrganizationProviderAccounts = pgTable(
  "relay_organization_provider_accounts",
  {
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    label: text("label").notNull(),
    payloadSealed: text("payload_sealed").notNull(),
    version: varchar("version", { length: 64 }).notNull(),
    createdByUserId: varchar("created_by_user_id", { length: 191 }).notNull(),
    updatedByUserId: varchar("updated_by_user_id", { length: 191 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.provider] })],
);

export interface LinearReplacementRecord {
  readonly id: string;
  readonly payloadSealed: string;
  readonly workspaceId: string;
  readonly currentWorkspaceId: string;
  readonly accountLabel: string;
  readonly currentAccountLabel: string;
  readonly expectedVersion: string;
  readonly createdByUserId: string;
  readonly expiresAt: string;
}

export interface JiraSelectionRecord {
  readonly payloadSealed: string;
  readonly sites: ReadonlyArray<RelayJiraSite>;
}

/** Credentials stay at the relay; executors receive only bounded issue results. */
export const relayIssueTrackerConnections = pgTable(
  "relay_issue_tracker_connections",
  {
    organizationId: varchar("organization_id", { length: 64 })
      .notNull()
      .references(() => relayOrganizations.organizationId, { onDelete: "cascade" }),
    service: varchar("service", { length: 16 }).notNull().$type<RelayIssueTrackerService>(),
    version: varchar("version", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 })
      .notNull()
      .$type<"connecting" | "connected" | "reconnect_required">(),
    accountLabel: text("account_label"),
    payloadSealed: text("payload_sealed"),
    authorizationId: varchar("authorization_id", { length: 64 }),
    replacement: jsonb("replacement").$type<LinearReplacementRecord>(),
    jiraSelection: jsonb("jira_selection").$type<JiraSelectionRecord>(),
    pendingOAuthSealed: text("pending_oauth_sealed"),
    pendingStateHash: text("pending_state_hash"),
    pendingExpiresAt: varchar("pending_expires_at", { length: 64 }),
    updatedByUserId: varchar("updated_by_user_id", { length: 191 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.service] }),
    uniqueIndex("idx_relay_issue_tracker_pending_state").on(table.pendingStateHash),
  ],
);

/** Personal grants are separate from legacy organization grants; ownership is never inferred. */
export const relayUserIssueTrackerConnections = pgTable(
  "relay_user_issue_tracker_connections",
  {
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    service: varchar("service", { length: 16 }).notNull().$type<RelayIssueTrackerService>(),
    version: varchar("version", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 })
      .notNull()
      .$type<"connecting" | "connected" | "reconnect_required">(),
    accountLabel: text("account_label"),
    payloadSealed: text("payload_sealed"),
    writesEnabled: boolean("writes_enabled").notNull().default(false),
    writeGeneration: integer("write_generation").notNull().default(0),
    authorizationId: varchar("authorization_id", { length: 64 }),
    replacement: jsonb("replacement").$type<LinearReplacementRecord>(),
    jiraSelection: jsonb("jira_selection").$type<JiraSelectionRecord>(),
    pendingOAuthSealed: text("pending_oauth_sealed"),
    pendingStateHash: text("pending_state_hash"),
    pendingExpiresAt: varchar("pending_expires_at", { length: 64 }),
    updatedByUserId: varchar("updated_by_user_id", { length: 191 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.service] }),
    uniqueIndex("idx_relay_user_issue_tracker_pending_state").on(table.pendingStateHash),
  ],
);

export const relayIssueTrackerWriteOperations = pgTable(
  "relay_issue_tracker_write_operations",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    service: varchar("service", { length: 16 }).notNull().$type<RelayIssueTrackerService>(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
    commandId: varchar("command_id", { length: 191 }).notNull(),
    providerSessionId: varchar("provider_session_id", { length: 191 }).notNull(),
    invocationId: varchar("invocation_id", { length: 191 }).notNull(),
    connectionVersion: varchar("connection_version", { length: 64 }).notNull(),
    writeGeneration: integer("write_generation").notNull(),
    runtimeMode: varchar("runtime_mode", { length: 32 }).notNull().$type<RuntimeMode>(),
    action: varchar("action", { length: 32 }).notNull(),
    target: varchar("target", { length: 512 }).notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    payloadSealed: text("payload_sealed"),
    baselineSealed: text("baseline_sealed"),
    state: varchar("state", { length: 32 })
      .notNull()
      .$type<
        | "awaiting_approval"
        | "ready"
        | "executing"
        | "succeeded"
        | "rejected"
        | "cancelled"
        | "outcome_unknown"
        | "superseded"
      >(),
    approvedByUserId: varchar("approved_by_user_id", { length: 191 }),
    approvedAt: varchar("approved_at", { length: 64 }),
    claimedAt: varchar("claimed_at", { length: 64 }),
    claimFence: varchar("claim_fence", { length: 64 }),
    resultResourceId: varchar("result_resource_id", { length: 191 }),
    resultUrl: text("result_url"),
    safeError: text("safe_error"),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_issue_tracker_write_invocation").on(
      table.environmentId,
      table.providerSessionId,
      table.invocationId,
    ),
    index("idx_relay_issue_tracker_write_fingerprint").on(
      table.ownerUserId,
      table.service,
      table.threadId,
      table.action,
      table.target,
      table.payloadDigest,
    ),
    index("idx_relay_issue_tracker_write_expiry").on(table.expiresAt, table.state),
  ],
);

/**
 * A skill an organization gives its agents: a directory of text files with a
 * `SKILL.md` at its root, uploaded by an admin and placed by every agent
 * executor where each provider CLI looks for user-level skills (ADR-0016).
 *
 * Holds no secret, so the files are stored as plain JSON. One row per skill
 * name per organization; `version` changes on every save so executors can
 * tell a changed skill from a repeat.
 */
export const relayOrganizationSkills = pgTable(
  "relay_organization_skills",
  {
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description").notNull(),
    filesJson: text("files_json").notNull(),
    version: varchar("version", { length: 64 }).notNull(),
    createdByUserId: varchar("created_by_user_id", { length: 191 }).notNull(),
    updatedByUserId: varchar("updated_by_user_id", { length: 191 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.name] })],
);

/**
 * A GitHub App installation claimed by an organization.
 *
 * Holds no secret: the App private key lives in relay configuration and access
 * tokens are minted per request and never persisted, so this table stays
 * publishable-by-accident safe (see the "no secret in relay Postgres"
 * invariant).
 */
export const relayGithubInstallations = pgTable(
  "relay_github_installations",
  {
    organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
    installationId: varchar("installation_id", { length: 64 }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: varchar("account_type", { length: 32 }).notNull(),
    connectedByUserId: varchar("connected_by_user_id", { length: 191 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    // One installation belongs to one organization: a second claim on the same
    // installation is a mistake or an attempt, never a legitimate state.
    uniqueIndex("idx_relay_github_installations_installation").on(table.installationId),
  ],
);

/**
 * A machine the relay provisioned for one organization (ADR-0002): an agent
 * executor or a review host — a role column, not a machine kind (ADR-0010).
 *
 * Only the enrollment seed's hash is stored, like invitation tokens: the seed
 * is injected into the machine's compute at creation and the relay has no
 * reason to reproduce it. Status is derived, never stored: `deprovisioned_at`
 * set means deprovisioned, `enrolled_at` set means ready, neither means the
 * machine has not called home yet.
 */
export const relayMachines = pgTable(
  "relay_machines",
  {
    machineId: varchar("machine_id", { length: 64 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 32 }).notNull().$type<RelayMachineRole>(),
    label: text("label").notNull(),
    computeKind: varchar("compute_kind", { length: 32 }).notNull().$type<RelayMachineComputeKind>(),
    // The driver's handle on the compute (container id, Hetzner server id).
    // Null only in the window between record creation and driver success.
    computeRef: varchar("compute_ref", { length: 191 }),
    seedHash: varchar("seed_hash", { length: 191 }).notNull(),
    seedExpiresAt: varchar("seed_expires_at", { length: 64 }).notNull(),
    // The environment identity the machine generated for itself, recorded at
    // enrollment. These anchor the machine's environment credential exactly as
    // an active link row anchors a personal one.
    environmentId: varchar("environment_id", { length: 191 }),
    environmentPublicKey: text("environment_public_key"),
    endpointHttpBaseUrl: text("endpoint_http_base_url"),
    endpointWsBaseUrl: text("endpoint_ws_base_url"),
    endpointProviderKind: varchar("endpoint_provider_kind", {
      length: 32,
    }).$type<RelayManagedEndpointProviderKind>(),
    createdByUserId: varchar("created_by_user_id", { length: 191 }).notNull(),
    enrolledAt: varchar("enrolled_at", { length: 64 }),
    deprovisionedAt: varchar("deprovisioned_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_machines_seed_hash").on(table.seedHash),
    index("idx_relay_machines_organization").on(table.organizationId, table.createdAt),
    index("idx_relay_machines_environment").on(table.environmentId, table.deprovisionedAt),
  ],
);

/**
 * One shared per-organization machine quota across both roles, the billing
 * lever for "buy managed machines". A row overrides the default; splitting the
 * quota per role later is a WHERE clause, not a migration.
 */
export const relayOrganizationMachineLimits = pgTable("relay_organization_machine_limits", {
  organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
  maxMachines: integer("max_machines").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayRepositories = pgTable(
  "relay_repositories",
  {
    repositoryId: varchar("repository_id", { length: 64 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    name: text("name").notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_relay_repositories_organization").on(table.organizationId, table.name)],
);

/**
 * The canonical keys a repository answers to (ADR-0006). The key is the primary
 * key, so one key can only ever belong to one repository — mirrors and forks
 * add rows here rather than second repositories.
 */
export const relayRepositoryAliases = pgTable(
  "relay_repository_aliases",
  {
    canonicalKey: text("canonical_key").primaryKey(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    // Denormalized so a checkout can be resolved to its organization without a
    // join, including on paths that hold no user token.
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_relay_repository_aliases_repository").on(table.repositoryId)],
);

export const relayRepositoryAccess = pgTable(
  "relay_repository_access",
  {
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 16 }).notNull().$type<RelayRepositoryRole>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.userId] }),
    index("idx_relay_repository_access_user").on(table.userId),
  ],
);

/**
 * Cursor for the latest redacted project snapshot accepted from one managed
 * environment. It is separate from the rows so an empty snapshot still has a
 * revision and cannot be overwritten by a delayed older publish.
 */
export const relayOrganizationProjectCatalogs = pgTable(
  "relay_organization_project_catalogs",
  {
    environmentId: varchar("environment_id", { length: 191 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    machineId: varchar("machine_id", { length: 64 }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_relay_org_project_catalogs_organization").on(table.organizationId, table.updatedAt),
  ],
);

/**
 * Non-sensitive project discovery only. The authoritative project and its
 * workspace path remain on the environment; chat history belongs to the
 * organization event mirror rather than this table.
 */
export const relayOrganizationProjects = pgTable(
  "relay_organization_projects",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    projectId: varchar("project_id", { length: 191 }).notNull(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    machineId: varchar("machine_id", { length: 64 }).notNull(),
    title: text("title").notNull(),
    repositoryCanonicalKey: text("repository_canonical_key"),
    projectCreatedAt: varchar("project_created_at", { length: 64 }).notNull(),
    projectUpdatedAt: varchar("project_updated_at", { length: 64 }).notNull(),
    catalogUpdatedAt: varchar("catalog_updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.projectId] }),
    index("idx_relay_org_projects_organization").on(table.organizationId, table.projectUpdatedAt),
    index("idx_relay_org_projects_repository").on(table.repositoryCanonicalKey),
  ],
);

export const relayMobileDevices = pgTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios" | "android">(),
    iosMajorVersion: integer("ios_major_version"),
    androidApiLevel: integer("android_api_level"),
    appVersion: varchar("app_version", { length: 64 }),
    bundleId: varchar("bundle_id", { length: 255 }),
    apsEnvironment: varchar("aps_environment", { length: 16 }).$type<"sandbox" | "production">(),
    pushToken: text("push_token"),
    pushToStartToken: text("push_to_start_token"),
    preferencesJson: jsonb("preferences_json").notNull().$type<RelayAgentAwarenessPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = pgTable(
  "relay_live_activities",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    activityPushToken: text("activity_push_token"),
    remoteStartQueuedAt: varchar("remote_start_queued_at", { length: 64 }),
    remoteStartedAt: varchar("remote_started_at", { length: 64 }),
    endedAt: varchar("ended_at", { length: 64 }),
    lastAggregateJson: jsonb("last_aggregate_json").$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: varchar("last_live_activity_delivery_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

export const relayEnvironmentLinks = pgTable(
  "relay_environment_links",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentLabel: text("environment_label").notNull().default("T3 Environment"),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: varchar("endpoint_provider_kind", { length: 32 }).notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    liveActivitiesEnabled: boolean("live_activities_enabled").notNull().default(true),
    managedTunnelsEnabled: boolean("managed_tunnels_enabled").notNull().default(false),
    createdByDeviceId: varchar("created_by_device_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = pgTable(
  "relay_managed_endpoint_allocations",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    tunnelName: text("tunnel_name").notNull(),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    readyAt: varchar("ready_at", { length: 64 }),
    recoveryEnabledAt: varchar("recovery_enabled_at", { length: 64 }),
    recoveryEnvironmentPublicKey: text("recovery_environment_public_key"),
    origin: jsonb("origin").$type<RelayManagedEndpointOrigin>(),
    generation: integer("generation").notNull().default(0),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
  ],
);

export const relayManagedTunnelLimits = pgTable("relay_managed_tunnel_limits", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  maxTunnels: integer("max_tunnels").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayEnvironmentCredentials = pgTable(
  "relay_environment_credentials",
  {
    credentialId: varchar("credential_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialHash: varchar("credential_hash", { length: 191 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayJobs = pgTable(
  "relay_jobs",
  {
    jobId: varchar("job_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    // Denormalized from relay_environment_links so a job can be authorized
    // against its owner without a join, and still be readable once the link
    // that created it is revoked.
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    repositoryCanonicalKey: text("repository_canonical_key").notNull(),
    baseBranch: text("base_branch").notNull(),
    // Snapshotted at dispatch, never a reference (ADR-0011).
    instruction: text("instruction").notNull(),
    status: varchar("status", { length: 32 }).notNull().$type<RelayJobStatus>(),
    threadId: varchar("thread_id", { length: 191 }),
    detail: text("detail"),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_relay_jobs_owner").on(table.ownerUserId, table.createdAt),
    index("idx_relay_jobs_environment").on(table.environmentId, table.createdAt),
  ],
);

export const relayRepositoryWorkflows = pgTable(
  "relay_repository_workflows",
  {
    workflowId: varchar("workflow_id", { length: 64 }).primaryKey(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    revision: integer("revision").notNull(),
    record: jsonb("record").notNull().$type<RepositoryWorkflow>(),
    automationEnabled: boolean("automation_enabled").notNull().default(false),
    sourceApplicationId: text("source_application_id"),
    sourceWorkspaceId: text("source_workspace_id"),
    triggerTeamId: text("trigger_team_id"),
    triggerEvent: text("trigger_event"),
    triggerGrantId: text("trigger_grant_id"),
    routingGeneration: integer("routing_generation").notNull().default(0),
    effectiveAfter: text("effective_after"),
    targetCapability: jsonb("target_capability"),
  },
  (table) => [
    check(
      "workflow_routing_consistent",
      sql`automation_enabled = COALESCE((record#>>'{automation,enabled}')::boolean,false)
    AND (NOT automation_enabled OR COALESCE((record->>'archived' = 'false' AND source_application_id IS NOT NULL
    AND source_workspace_id IS NOT NULL AND effective_after IS NOT NULL AND target_capability IS NOT NULL
    AND routing_generation > 0 AND trigger_team_id IS NOT NULL AND trigger_grant_id IS NOT NULL
    AND trigger_event IN ('issue_created','entered_status') AND trigger_team_id = record#>>'{automation,trigger,teamId}'
    AND trigger_grant_id = record#>>'{automation,trigger,grantId}' AND trigger_event = record#>>'{automation,trigger,event}'),false))`,
    ),
    index("idx_repository_workflows_repository").on(table.repositoryId),
    index("idx_workflow_event_rules")
      .on(
        table.sourceApplicationId,
        table.sourceWorkspaceId,
        table.triggerTeamId,
        table.triggerEvent,
      )
      .where(sql`automation_enabled`),
  ],
);

export const relayWorkflowJobs = pgTable(
  "relay_workflow_jobs",
  {
    jobId: varchar("job_id", { length: 64 }).primaryKey(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    submitterUserId: varchar("submitter_user_id", { length: 191 }),
    repositoryCanonicalKey: text("repository_canonical_key"),
    status: varchar("status", { length: 32 }).notNull().$type<RepositoryWorkflowJob["status"]>(),
    record: jsonb("record").notNull().$type<RepositoryWorkflowJob>(),
    // A stored projection backfills legacy jobs and stays consistent across every writer.
    // jsonb_object is immutable, as PostgreSQL requires for generated columns.
    summary: jsonb("summary")
      .notNull()
      .$type<RepositoryWorkflowJobSummary>()
      .generatedAlwaysAs(
        sql`jsonb_object(
        ARRAY['jobId','repositoryId','workflowId','environmentId','instruction','status','detail','createdAt','updatedAt'],
        ARRAY["job_id"::text,"repository_id"::text,"record"->>'workflowId',"record"->>'environmentId',left(CASE WHEN "record"->'event' IS NOT NULL THEN COALESCE("record"#>>'{issueSnapshot,identifier}',"record"#>>'{event,identifier}') || ': ' || COALESCE("record"#>>'{issueSnapshot,title}',"record"#>>'{event,title}') ELSE "record"->>'instruction' END,500),"status"::text,left("record"->>'detail',500),"created_at"::text,"record"->>'updatedAt']
      ) || CASE WHEN "status" IN ('awaiting_review','awaiting_input','paused')
        OR ("status" = 'queued' AND CASE WHEN "record" ? 'queueReason' THEN COALESCE("record"#>>'{queueReason,code}' NOT IN ('environment_offline','environment_busy','source_unavailable','source_rate_limited','workflow_changed'),false) ELSE "record"->>'detail' IS NOT NULL END)
        OR ("status" = 'cancelling' AND "record"#>>'{progress,retryableCancellation}' = 'true')
        THEN '{"needsAttention":true}'::jsonb ELSE '{"needsAttention":false}'::jsonb END
      || ('{"originSummary":' || (
        jsonb_object(ARRAY['kind'], ARRAY["record"#>>'{origin,kind}'])
        || CASE WHEN "record"#>>'{workflow,definition,name}' IS NOT NULL
          THEN jsonb_object(ARRAY['workflowName'], ARRAY[left("record"#>>'{workflow,definition,name}',120)])
          ELSE '{}'::jsonb END)::text || '}')::jsonb
      || CASE WHEN "record" ? 'queueReason' THEN ('{"queueReason":' || ("record"->'queueReason')::text || '}')::jsonb ELSE '{}'::jsonb END`,
      ),
    pendingControl: jsonb("pending_control").$type<{
      userId: string;
      response: typeof RespondToWorkflowJob.Type;
    }>(),
    revision: integer("revision").notNull(),
    leaseUntil: varchar("lease_until", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    checkedAt: varchar("checked_at", { length: 64 }).notNull(),
  },
  (table) => [
    index("idx_workflow_jobs_dispatch_pending")
      .on(table.checkedAt, table.createdAt)
      .where(sql`"status" NOT IN ('done','cancelled','failed')`),
    check(
      "workflow_job_origin",
      sql`(
      ("record"#>>'{origin,kind}' = 'manual' AND "submitter_user_id" IS NOT NULL
        AND "record"#>>'{origin,userId}' = "submitter_user_id")
      OR ("record"#>>'{origin,kind}' = 'automation' AND "submitter_user_id" IS NULL
        AND "record"#>>'{origin,organizationId}' = "organization_id"
        AND "record"#>>'{origin,repositoryId}' = "repository_id"
        AND "record"#>>'{origin,workflowId}' = "record"->>'workflowId'
        AND "record"#>>'{origin,source,provider}' = 'linear'
        AND length(trim("record"#>>'{origin,source,applicationId}')) > 0
        AND length(trim("record"#>>'{origin,source,workspaceId}')) > 0
        AND length(trim("record"#>>'{origin,source,connectionId}')) > 0
        AND length(trim("record"#>>'{origin,source,grantId}')) > 0
        AND length(trim("record"#>>'{origin,occurrenceId}')) > 0
        AND "record"->'requiredProtocol' = '8'::jsonb)
    ) IS TRUE`,
    ),
    index("idx_workflow_jobs_repository").on(table.repositoryId, table.createdAt),
    index("idx_workflow_jobs_status").on(table.status, table.checkedAt),
    index("idx_workflow_jobs_active_page")
      .on(table.repositoryId, table.createdAt, table.jobId)
      .where(sql`"status" NOT IN ('done','cancelled','failed')`),
    index("idx_workflow_jobs_history_page")
      .on(table.repositoryId, table.createdAt, table.jobId)
      .where(sql`"status" IN ('done','cancelled','failed')`),
  ],
);

export const relayAgentActivityRows = pgTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: varchar("thread_id", { length: 512 }).notNull(),
    stateJson: jsonb("state_json").notNull().$type<RelayAgentActivityState>(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = pgTable(
  "relay_delivery_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 512 }),
    deviceId: varchar("device_id", { length: 255 }),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceJobId: varchar("source_job_id", { length: 64 }),
    tokenSuffix: varchar("token_suffix", { length: 16 }),
    apnsStatus: integer("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: varchar("apns_id", { length: 128 }),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_environment").on(
      table.environmentId,
      table.threadId,
      table.createdAt,
    ),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = pgTable(
  "relay_dpop_proofs",
  {
    thumbprint: varchar("thumbprint", { length: 128 }).notNull(),
    jti: varchar("jti", { length: 255 }).notNull(),
    iat: integer("iat").notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);

// Updated in the same database transaction as membership/grant/enrollment changes.
export const relayRepositoryPolicyRevisions = pgTable("relay_repository_policy_revisions", {
  organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
  revision: integer("revision").notNull(),
});
// Retained even after deprovisioning: old credentials on an offline machine are not an ACK.
export const relayRepositoryPolicyAcknowledgements = pgTable(
  "relay_repository_policy_acknowledgements",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url"),
    appliedRevision: integer("applied_revision").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.environmentId, table.environmentPublicKey],
    }),
  ],
);

/** Only enrolled portable threads live here; ordinary local threads remain independent. */
export const relayThreadPlacements = pgTable(
  "relay_thread_placements",
  {
    threadId: varchar("thread_id", { length: 191 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    projectId: varchar("project_id", { length: 191 }).notNull(),
    originalEnvironmentId: varchar("original_environment_id", { length: 191 }),
    originalProjectId: varchar("original_project_id", { length: 191 }),
    generation: integer("generation").notNull().default(1),
    operationId: varchar("operation_id", { length: 64 }),
  },
  (table) => [
    check("relay_thread_placements_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_placements_original_location",
      sql`(${table.originalEnvironmentId} IS NULL) = (${table.originalProjectId} IS NULL)`,
    ),
    index("idx_relay_thread_placements_owner").on(table.ownerUserId),
  ],
);

export const relayThreadMoves = pgTable(
  "relay_thread_moves",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    sourceEnvironmentId: varchar("source_environment_id", { length: 191 }).notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    destinationEnvironmentId: varchar("destination_environment_id", { length: 191 }).notNull(),
    destinationProjectId: varchar("destination_project_id", { length: 191 }).notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<
        "preparing" | "frozen" | "ready" | "committed" | "completed" | "aborting" | "aborted"
      >(),
    sourceCursor: integer("source_cursor"),
    manifestSha256: varchar("manifest_sha256", { length: 64 }),
    failureDetail: varchar("failure_detail", { length: 2000 }),
  },
  (table) => [
    check(
      "relay_thread_moves_phase",
      sql`${table.phase} IN ('preparing','frozen','ready','committed','completed','aborting','aborted')`,
    ),
    check("relay_thread_moves_generation", sql`${table.expectedGeneration} > 0`),
    check(
      "relay_thread_moves_manifest",
      sql`${table.phase} NOT IN ('frozen','ready','committed','completed') OR (${table.sourceCursor} IS NOT NULL AND ${table.sourceCursor} >= 0 AND ${table.manifestSha256} IS NOT NULL AND ${table.manifestSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    index("idx_relay_thread_moves_thread").on(table.threadId),
  ],
);

export const relayThreadMoveProgress = pgTable(
  "relay_thread_move_progress",
  {
    operationId: varchar("operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadMoves.operationId, { onDelete: "cascade" }),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    attempt: bigint("attempt", { mode: "number" }).notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    stage: integer("stage").notNull(),
    snapshot: jsonb("snapshot").notNull(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.environmentId] })],
);

/** Work IDs survive moves: a lost reply must never admit the same work at a new owner. */
export const relayThreadExecutionAdmissions = pgTable(
  "relay_thread_execution_admissions",
  {
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    workId: varchar("work_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    completed: boolean("completed").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.workId] }),
    check("relay_thread_execution_admissions_generation", sql`${table.generation} > 0`),
  ],
);

export const relayThreadVmPolicies = pgTable(
  "relay_thread_vm_policies",
  {
    organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
    revision: integer("revision").notNull().default(1),
    maxVmsPerUser: integer("max_vms_per_user").notNull().default(3),
    pauseAfterIdleMinutes: integer("pause_after_idle_minutes").notNull().default(30),
    deleteAfterIdleWeekdays: integer("delete_after_idle_weekdays").notNull().default(2),
    backupIntervalMinutes: integer("backup_interval_minutes").notNull().default(15),
    savedDiskRetentionDays: integer("saved_disk_retention_days").notNull().default(30),
    calendarTimeZone: text("calendar_time_zone").notNull().default("UTC"),
  },
  (table) => [
    check(
      "relay_thread_vm_policies_limits",
      sql`${table.revision} > 0 AND ${table.maxVmsPerUser} >= 0 AND ${table.pauseAfterIdleMinutes} > 0 AND ${table.deleteAfterIdleWeekdays} > 0 AND ${table.backupIntervalMinutes} > 0 AND ${table.savedDiskRetentionDays} > 0`,
    ),
  ],
);

/** A row reserves quota until absence is confirmed, including ambiguous creates/deletes. */
export const relayThreadVmAllocations = pgTable(
  "relay_thread_vm_allocations",
  {
    allocationId: varchar("allocation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    templateId: varchar("template_id", { length: 191 }).notNull(),
    computeRef: varchar("compute_ref", { length: 191 }),
    nativePausedGeneration: integer("native_paused_generation"),
    deletionStopReceipt: jsonb("deletion_stop_receipt").$type<{
      operationId: string;
      allocationId: string;
      computeRef: string;
      sourceOperationId: string;
      generation: number;
      physicallyStopped: true;
      captureAdmissionSealed: boolean;
    }>(),
    state: varchar("state", { length: 16 })
      .notNull()
      .$type<"creating" | "running" | "paused" | "deleting" | "deleted">(),
    deletedAt: varchar("deleted_at", { length: 64 }),
  },
  (table) => [
    uniqueIndex("idx_relay_thread_vm_allocations_live_thread")
      .on(table.threadId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("idx_relay_thread_vm_allocations_compute").on(table.computeRef),
    index("idx_relay_thread_vm_allocations_owner").on(table.ownerUserId, table.deletedAt),
    check(
      "relay_thread_vm_allocations_state",
      sql`${table.state} IN ('creating','running','paused','deleting','deleted')`,
    ),
    check(
      "relay_thread_vm_allocations_deletion",
      sql`(${table.state} = 'deleted') = (${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "relay_thread_vm_allocations_compute_required",
      sql`${table.state} NOT IN ('running','paused') OR ${table.computeRef} IS NOT NULL`,
    ),
    check(
      "relay_thread_vm_allocations_native_paused_generation",
      sql`${table.nativePausedGeneration} IS NULL OR ${table.nativePausedGeneration} > 0`,
    ),
  ],
);

/** A stale or failed inspection is unknown, never evidence that a VM is idle. */
export const relayThreadVmActivity = pgTable(
  "relay_thread_vm_activity",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    activity: varchar("activity", { length: 16 })
      .notNull()
      .default("unknown")
      .$type<"busy" | "idle" | "unknown">(),
    inactiveWorkIds: jsonb("inactive_work_ids")
      .notNull()
      .default([])
      .$type<ReadonlyArray<string>>(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    idleSince: timestamp("idle_since", { withTimezone: true }),
    lastWorkAt: timestamp("last_work_at", { withTimezone: true }),
    pauseDueAt: timestamp("pause_due_at", { withTimezone: true }),
    deleteDueAt: timestamp("delete_due_at", { withTimezone: true }),
    deadlineIdleSince: timestamp("deadline_idle_since", { withTimezone: true }),
    deadlinePolicyRevision: integer("deadline_policy_revision"),
    deadlineTimeZone: varchar("deadline_time_zone", { length: 128 }),
    lifecycleCheckedAt: timestamp("lifecycle_checked_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_relay_thread_vm_activity_delete_due").on(table.deleteDueAt),
    check(
      "relay_thread_vm_activity_deadline",
      sql`
      (${table.pauseDueAt} IS NULL AND ${table.deleteDueAt} IS NULL AND ${table.deadlineIdleSince} IS NULL
        AND ${table.deadlinePolicyRevision} IS NULL AND ${table.deadlineTimeZone} IS NULL)
      OR (${table.pauseDueAt} IS NOT NULL AND ${table.deleteDueAt} IS NOT NULL AND ${table.deadlineIdleSince} IS NOT NULL
        AND ${table.deadlinePolicyRevision} IS NOT NULL AND ${table.deadlinePolicyRevision}>=0
        AND ${table.deadlineTimeZone} IS NOT NULL AND ${table.pauseDueAt}>${table.deadlineIdleSince}
        AND ${table.deleteDueAt}>${table.deadlineIdleSince})`,
    ),
    check("relay_thread_vm_activity_state", sql`${table.activity} IN ('busy','idle','unknown')`),
    check(
      "relay_thread_vm_activity_idle_since",
      sql`${table.activity} <> 'idle' OR ${table.idleSince} IS NOT NULL`,
    ),
  ],
);

/** A pause claim fences new work before the relay contacts the guest or compute host. */
export const relayThreadVmPauses = pgTable(
  "relay_thread_vm_pauses",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    generation: integer("generation").notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<"pending" | "sealed" | "completed" | "cancelled">(),
    bootId: varchar("boot_id", { length: 64 }),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 }),
    sourceSequence: integer("source_sequence"),
    sourceFrozenAt: timestamp("source_frozen_at", { withTimezone: true }),
    sourceReopenedAt: timestamp("source_reopened_at", { withTimezone: true }),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("relay_thread_vm_pauses_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_pauses_phase",
      sql`${table.phase} IN ('pending','sealed','completed','cancelled')`,
    ),
    check(
      "relay_thread_vm_pauses_sealed_boot",
      sql`${table.phase} != 'sealed' OR ${table.bootId} IS NOT NULL`,
    ),
    check(
      "relay_thread_vm_pauses_source_certificate",
      sql`
      (${table.nativeCheckpointOperationId} IS NULL AND ${table.sourceSequence} IS NULL AND ${table.sourceFrozenAt} IS NULL)
      OR (${table.nativeCheckpointOperationId} IS NOT NULL AND ${table.sourceSequence} IS NOT NULL AND ${table.sourceSequence} >= 0 AND ${table.sourceFrozenAt} IS NOT NULL AND ${table.bootId} IS NOT NULL)`,
    ),
    index("idx_relay_thread_vm_pauses_retry").on(table.phase, table.retryAt),
  ],
);

/** Explicit wake requests retain FIFO host capacity while E2B's response is uncertain. */
export const relayThreadVmResumes = pgTable(
  "relay_thread_vm_resumes",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    generation: integer("generation").notNull(),
    phase: varchar("phase", { length: 16 }).notNull().$type<"waiting" | "resuming" | "completed">(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("relay_thread_vm_resumes_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_resumes_phase",
      sql`${table.phase} IN ('waiting','resuming','completed')`,
    ),
    index("idx_relay_thread_vm_resumes_retry").on(table.phase, table.retryAt),
  ],
);

/** Lease renewals keep busy VMs alive independently of their idle-pause policy. */
export const relayThreadVmLeases = pgTable("relay_thread_vm_leases", {
  allocationId: varchar("allocation_id", { length: 64 })
    .primaryKey()
    .references(() => relayThreadVmAllocations.allocationId),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  renewedAt: timestamp("renewed_at", { withTimezone: true }),
});

/** A named capture is attempted once; ambiguous replies are reconciled by name. */
export const relayThreadVmBackups = pgTable(
  "relay_thread_vm_backups",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    allocationId: varchar("allocation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmAllocations.allocationId),
    generation: integer("generation").notNull(),
    computeRef: varchar("compute_ref", { length: 191 }).notNull(),
    snapshotName: varchar("snapshot_name", { length: 191 }).notNull().unique(),
    snapshotId: varchar("snapshot_id", { length: 191 }).unique(),
    sourceTemplateId: varchar("source_template_id", { length: 191 }),
    sourceBuildId: varchar("source_build_id", { length: 64 }),
    probeReceipt:
      jsonb("probe_receipt").$type<import("../machines/E2BRestoreClient.ts").E2BBackupColdProof>(),
    failedProbeStoppedAt: timestamp("failed_probe_stopped_at", { withTimezone: true }),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<
        | "pending"
        | "creating"
        | "captured"
        | "verifying"
        | "cleanup"
        | "verified"
        | "failed"
        | "retiring"
        | "retired"
      >(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    captureStartedAt: timestamp("capture_started_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    check("relay_thread_vm_backups_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_backups_failed_probe_stop",
      sql`${table.failedProbeStoppedAt} IS NULL OR ${table.phase} IN ('failed','retiring','retired')`,
    ),
    check(
      "relay_thread_vm_backups_phase",
      sql`${table.phase} IN ('pending','creating','captured','verifying','cleanup','verified','failed','retiring','retired')`,
    ),
    uniqueIndex("idx_relay_thread_vm_backups_active")
      .on(table.allocationId)
      .where(sql`${table.phase} IN ('pending','creating','captured','verifying','cleanup')`),
    index("idx_relay_thread_vm_backups_verified").on(table.allocationId, table.verifiedAt),
  ],
);

/** Durable consumers must pin a recovery save before reading or restoring it. */
export const relayThreadVmBackupPins = pgTable(
  "relay_thread_vm_backup_pins",
  {
    backupOperationId: varchar("backup_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmBackups.operationId),
    operationId: varchar("operation_id", { length: 64 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.backupOperationId, table.operationId] })],
);

/** Disk retention is separate from conversation retention and from rolling backups. */
export const relayThreadVmSavedDisks = pgTable(
  "relay_thread_vm_saved_disks",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    backupOperationId: varchar("backup_operation_id", { length: 64 })
      .notNull()
      .unique()
      .references(() => relayThreadVmBackups.operationId),
    generation: integer("generation").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<"available" | "restoring" | "restored" | "expiring" | "expired">(),
    restoreOperationId: varchar("restore_operation_id", { length: 64 }).unique(),
    restoreAllocationId: varchar("restore_allocation_id", { length: 64 }).references(
      () => relayThreadVmAllocations.allocationId,
    ),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("relay_thread_vm_saved_disks_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_saved_disks_phase",
      sql`${table.phase} IN ('available','restoring','restored','expiring','expired')`,
    ),
    check(
      "relay_thread_vm_saved_disks_restore",
      sql`${table.phase} != 'restoring' OR (${table.restoreOperationId} IS NOT NULL AND ${table.restoreAllocationId} IS NOT NULL)`,
    ),
    uniqueIndex("idx_relay_thread_vm_saved_disks_current")
      .on(table.threadId)
      .where(sql`${table.phase} IN ('available','restoring','expiring')`),
    index("idx_relay_thread_vm_saved_disks_expiry").on(table.hostId, table.phase, table.savedAt),
  ],
);

/** Immutable bulk objects live outside the relay database and disposable VMs. */
export const relayThreadArtifacts = pgTable(
  "relay_thread_artifacts",
  {
    artifactId: varchar("artifact_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    operationId: varchar("operation_id", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 16 })
      .notNull()
      .$type<"workspace" | "native" | "attachment" | "history" | "manifest">(),
    storageKey: varchar("storage_key", { length: 191 }).notNull().unique(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    state: varchar("state", { length: 16 })
      .notNull()
      .$type<"pending" | "complete" | "deleting" | "deleted">(),
    deleteClaimId: varchar("delete_claim_id", { length: 64 }),
    deleteClaimUntil: timestamp("delete_claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
  },
  (table) => [
    check("relay_thread_artifacts_sha256", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("relay_thread_artifacts_size", sql`${table.sizeBytes} >= 0`),
    check(
      "relay_thread_artifacts_kind",
      sql`${table.kind} IN ('workspace','native','attachment','history','manifest')`,
    ),
    check(
      "relay_thread_artifacts_state",
      sql`${table.state} IN ('pending','complete','deleting','deleted')`,
    ),
    index("idx_relay_thread_artifacts_thread").on(table.threadId, table.createdAt),
    index("idx_relay_thread_artifacts_retention").on(table.state, table.retentionUntil),
  ],
);

/** A move, restore or backup pins every object it may still read. */
export const relayThreadArtifactPins = pgTable(
  "relay_thread_artifact_pins",
  {
    artifactId: varchar("artifact_id", { length: 64 })
      .notNull()
      .references(() => relayThreadArtifacts.artifactId),
    operationId: varchar("operation_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.operationId] }),
    index("idx_relay_thread_artifact_pins_operation").on(table.operationId),
  ],
);

/** A frozen move names one complete, pinned set of immutable transfer objects. */
export const relayThreadMoveArtifacts = pgTable(
  "relay_thread_move_artifacts",
  {
    operationId: varchar("operation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadMoves.operationId),
    manifestArtifactId: varchar("manifest_artifact_id", { length: 64 })
      .notNull()
      .references(() => relayThreadArtifacts.artifactId),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_relay_thread_move_artifacts_manifest").on(table.manifestArtifactId)],
);

/** A verified frozen save gates handoff and retains history independently of VM disks. */
export const relayThreadMoveCheckpoints = pgTable(
  "relay_thread_move_checkpoints",
  {
    operationId: varchar("operation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadMoves.operationId),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    manifestArtifactId: varchar("manifest_artifact_id", { length: 64 })
      .notNull()
      .references(() => relayThreadArtifacts.artifactId),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 }),
    workspaceBranch: text("workspace_branch"),
    workspaceRevision: varchar("workspace_revision", { length: 64 }),
    repositoryUpload: jsonb("repository_upload").$type<RelayThreadVmRepositoryUpload>(),
    repositoryRetained: boolean("repository_retained").notNull().default(false),
    artifactCount: integer("artifact_count").notNull(),
    retained: boolean("retained").notNull().default(true),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("relay_thread_move_checkpoints_count", sql`${table.artifactCount} > 0`),
    index("idx_relay_thread_move_checkpoints_thread").on(table.threadId, table.verifiedAt),
  ],
);

/** Native conversation retention is independent of disposable whole-disk retention. */
export const relayThreadNativeCheckpoints = pgTable(
  "relay_thread_native_checkpoints",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    turnId: varchar("turn_id", { length: 191 }).notNull(),
    captureOperationId: varchar("capture_operation_id", { length: 64 }),
    sourceEnvironmentId: varchar("source_environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    nativeThreadId: varchar("native_thread_id", { length: 64 }).notNull(),
    recoveryHistoryJson: jsonb("recovery_history_json"),
    nativeManifestSha256: varchar("native_manifest_sha256", { length: 64 }).notNull(),
    archiveSha256: varchar("archive_sha256", { length: 64 }).notNull(),
    manifestArtifactId: varchar("manifest_artifact_id", { length: 64 })
      .notNull()
      .references(() => relayThreadArtifacts.artifactId),
    manifestSha256: varchar("manifest_sha256", { length: 64 }).notNull(),
    artifactCount: integer("artifact_count").notNull(),
    retained: boolean("retained").notNull().default(true),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_relay_thread_native_checkpoints_turn")
      .on(table.threadId, table.generation, table.turnId)
      .where(sql`${table.captureOperationId} IS NULL`),
    uniqueIndex("idx_relay_thread_native_checkpoints_capture")
      .on(table.threadId, table.generation, table.captureOperationId)
      .where(sql`${table.captureOperationId} IS NOT NULL`),
    check(
      "relay_thread_native_checkpoints_capture",
      sql`${table.captureOperationId} IS NULL OR ${table.captureOperationId} ~ '^[0-9a-f-]{36}$'`,
    ),
    uniqueIndex("idx_relay_thread_native_checkpoints_manifest").on(table.manifestArtifactId),
    index("idx_relay_thread_native_checkpoints_latest").on(
      table.threadId,
      table.generation,
      table.sourceSequence,
    ),
    check(
      "relay_thread_native_checkpoints_sequence",
      sql`${table.generation} > 0 AND ${table.sourceSequence} >= 0`,
    ),
    check("relay_thread_native_checkpoints_artifact_count", sql`${table.artifactCount} > 0`),
    check(
      "relay_thread_native_checkpoints_sha256",
      sql`${table.archiveSha256} ~ '^[0-9a-f]{64}$' AND ${table.nativeManifestSha256} ~ '^[0-9a-f]{64}$' AND ${table.manifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** Attachments inherit the native point's retention rather than its VM disk's deadline. */
export const relayThreadAttachmentCheckpoints = pgTable(
  "relay_thread_attachment_checkpoints",
  {
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadNativeCheckpoints.operationId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    manifestArtifactId: varchar("manifest_artifact_id", { length: 64 })
      .notNull()
      .unique()
      .references(() => relayThreadArtifacts.artifactId),
    manifestSha256: varchar("manifest_sha256", { length: 64 }).notNull(),
    attachmentManifestSha256: varchar("attachment_manifest_sha256", { length: 64 }).notNull(),
    artifactCount: integer("artifact_count").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("relay_thread_attachment_checkpoints_artifact_count", sql`${table.artifactCount} > 0`),
    check(
      "relay_thread_attachment_checkpoints_sha256",
      sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$' AND ${table.attachmentManifestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** A durable recovery operation may keep a superseded native point alive. */
export const relayThreadNativeCheckpointOperations = pgTable(
  "relay_thread_native_checkpoint_operations",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    checkpointOperationId: varchar("checkpoint_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadNativeCheckpoints.operationId),
    phase: varchar("phase", { length: 16 }).notNull().$type<"active" | "released">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "relay_thread_native_checkpoint_operations_phase",
      sql`${table.phase} IN ('active','released')`,
    ),
    index("idx_relay_thread_native_checkpoint_operations_point").on(table.checkpointOperationId),
  ],
);

/** Creation is admitted once. An expired worker claim never authorizes a second create. */
export const relayThreadVmProvisions = pgTable(
  "relay_thread_vm_provisions",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    generation: integer("generation").notNull(),
    creationIdentityFenced: boolean("creation_identity_fenced").notNull().default(false),
    position: bigserial("position", { mode: "number" }).notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<"pending" | "creating" | "created" | "cancelled">()
      .default("pending"),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    errorCode: varchar("error_code", { length: 48 }),
  },
  (table) => [
    check("relay_thread_vm_provisions_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_provisions_phase",
      sql`${table.phase} IN ('pending', 'creating', 'created', 'cancelled')`,
    ),
    check(
      "relay_thread_vm_provisions_claim",
      sql`(${table.claimId} IS NULL) = (${table.claimUntil} IS NULL)`,
    ),
    index("idx_relay_thread_vm_provisions_pending")
      .on(table.position)
      .where(sql`${table.phase} IN ('pending', 'creating')`),
  ],
);

/** One standard VM profile per host; reservation leases never expire with a worker claim. */
export const relayThreadVmHosts = pgTable(
  "relay_thread_vm_hosts",
  {
    hostId: varchar("host_id", { length: 191 }).primaryKey(),
    maxRunningVms: integer("max_running_vms").notNull(),
  },
  (table) => [check("relay_thread_vm_hosts_limit", sql`${table.maxRunningVms} > 0`)],
);

export const relayThreadVmCapacity = pgTable(
  "relay_thread_vm_capacity",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    allocationId: varchar("allocation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmAllocations.allocationId),
    hostId: varchar("host_id", { length: 191 })
      .notNull()
      .references(() => relayThreadVmHosts.hostId),
    kind: varchar("kind", { length: 16 }).notNull().$type<"create" | "resume">(),
    position: bigserial("position", { mode: "number" }).notNull(),
    state: varchar("state", { length: 16 })
      .notNull()
      .default("waiting")
      .$type<"waiting" | "reserved" | "started" | "released">(),
    computeRef: varchar("compute_ref", { length: 191 }),
  },
  (table) => [
    check("relay_thread_vm_capacity_kind", sql`${table.kind} IN ('create', 'resume')`),
    check(
      "relay_thread_vm_capacity_state",
      sql`${table.state} IN ('waiting', 'reserved', 'started', 'released')`,
    ),
    uniqueIndex("idx_relay_thread_vm_capacity_live_allocation")
      .on(table.allocationId)
      .where(sql`${table.state} != 'released'`),
    index("idx_relay_thread_vm_capacity_waiting")
      .on(table.hostId, table.position)
      .where(sql`${table.state} = 'waiting'`),
  ],
);

/** Retained after revocation: a VM identity must never fall back to organization-wide credentials. */
export const relayThreadVmBindings = pgTable(
  "relay_thread_vm_bindings",
  {
    environmentId: varchar("environment_id", { length: 191 }).primaryKey(),
    allocationId: varchar("allocation_id", { length: 64 })
      .notNull()
      .unique()
      .references(() => relayThreadVmAllocations.allocationId),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    generation: integer("generation").notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialId: varchar("credential_id", { length: 64 })
      .notNull()
      .unique()
      .references(() => relayEnvironmentCredentials.credentialId),
    deletionEndpointRemovedAt: timestamp("deletion_endpoint_removed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [check("relay_thread_vm_bindings_generation", sql`${table.generation} > 0`)],
);

/** The setup secret claims one identity; its encrypted reply survives a lost response. */
export const relayThreadVmEnrollments = pgTable(
  "relay_thread_vm_enrollments",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    seedHash: varchar("seed_hash", { length: 64 }).notNull().unique(),
    sealedSeed: text("sealed_seed"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }),
    environmentPublicKey: text("environment_public_key"),
    sealedResponse: text("sealed_response"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    credentialId: varchar("credential_id", { length: 64 }).references(
      () => relayEnvironmentCredentials.credentialId,
    ),
  },
  (table) => [
    check(
      "relay_thread_vm_enrollments_claim",
      sql`(${table.environmentId} IS NULL AND ${table.environmentPublicKey} IS NULL AND ${table.sealedResponse} IS NULL AND ${table.credentialId} IS NULL AND ${table.sealedSeed} IS NOT NULL AND ${table.installedAt} IS NULL)
      OR (${table.environmentId} IS NOT NULL AND ${table.environmentPublicKey} IS NOT NULL AND ${table.sealedResponse} IS NOT NULL AND ${table.credentialId} IS NOT NULL AND (${table.installedAt} IS NULL OR ${table.sealedSeed} IS NULL))`,
    ),
  ],
);

export const relayThreadCommands = pgTable(
  "relay_thread_commands",
  {
    commandId: varchar("command_id", { length: 191 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    position: integer("position").notNull(),
    acceptedGeneration: integer("accepted_generation").notNull(),
    actorJson: jsonb("actor_json").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    receiptJson: jsonb("receipt_json"),
    archiveReceiptJson: jsonb("archive_receipt_json"),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_relay_thread_commands_position").on(table.threadId, table.position),
    check(
      "relay_thread_commands_position",
      sql`${table.position} > 0 AND ${table.acceptedGeneration} > 0`,
    ),
  ],
);

/** Source sequence is environment-global; the read cursor is thread-local and never imported. */
export const relayThreadHistory = pgTable(
  "relay_thread_history",
  {
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    cursor: integer("cursor").notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    eventJson: jsonb("event_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.cursor] }),
    index("idx_relay_thread_history_deleted")
      .on(table.threadId, table.sourceSequence)
      .where(sql`${table.eventJson}->>'type'='thread.deleted'`),
    uniqueIndex("idx_relay_thread_history_source").on(table.environmentId, table.sourceSequence),
    index("idx_relay_thread_history_queue_event")
      .on(table.threadId, sql`(${table.eventJson}->>'eventId')`)
      .where(sql`${table.eventJson}->>'type'='thread.prompt-queue-changed'`),
    index("idx_relay_thread_history_thread_source").on(
      table.threadId,
      table.environmentId,
      table.sourceSequence,
    ),
    check("relay_thread_history_cursor", sql`${table.cursor} > 0 AND ${table.sourceSequence} >= 0`),
  ],
);

/** The source reports a completed scan even when other threads consumed later event numbers. */
export const relayThreadHistoryWatermarks = pgTable(
  "relay_thread_history_watermarks",
  {
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.environmentId, table.generation] }),
    check(
      "relay_thread_history_watermarks_sequence",
      sql`${table.generation} > 0 AND ${table.sourceSequence} >= 0`,
    ),
  ],
);

/** Initial VM setup owns the placement hold until the guest has persisted its ready receipt. */
export const relayThreadVmSetups = pgTable(
  "relay_thread_vm_setups",
  {
    allocationId: varchar("allocation_id", { length: 64 })
      .primaryKey()
      .references(() => relayThreadVmAllocations.allocationId),
    canonicalKey: varchar("canonical_key", { length: 512 }).notNull(),
    initialState: text("initial_state"),
    branch: text("branch").notNull(),
    revision: varchar("revision", { length: 64 }).notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .default("pending")
      .$type<"pending" | "running" | "ready" | "failed">(),
    environmentId: varchar("environment_id", { length: 191 }),
    errorCode: varchar("error_code", { length: 64 }),
    receiptSha256: varchar("receipt_sha256", { length: 64 }),
  },
  (table) => [
    check(
      "relay_thread_vm_setups_phase",
      sql`${table.phase} IN ('pending', 'running', 'ready', 'failed')`,
    ),
    check(
      "relay_thread_vm_setups_revision",
      sql`${table.revision} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      "relay_thread_vm_setups_ready",
      sql`${table.phase} <> 'ready' OR (${table.environmentId} IS NOT NULL AND ${table.receiptSha256} IS NOT NULL AND ${table.receiptSha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/** A final save holds execution and quota until independent recovery and physical absence are verified. */
export const relayThreadVmFinalSaves = pgTable(
  "relay_thread_vm_final_saves",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    allocationId: varchar("allocation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmAllocations.allocationId),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    computeRef: varchar("compute_ref", { length: 191 }).notNull(),
    originalState: varchar("original_state", { length: 16 })
      .notNull()
      .$type<"running" | "paused">(),
    reason: varchar("reason", { length: 16 }).notNull().$type<"idle" | "replacement">(),
    activityRevision: integer("activity_revision").notNull(),
    idleSince: timestamp("idle_since", { withTimezone: true }).notNull(),
    sourceSequence: integer("source_sequence"),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", {
      length: 64,
    }).references(() => relayThreadNativeCheckpoints.operationId),
    backupOperationId: varchar("backup_operation_id", { length: 64 }).references(
      () => relayThreadVmBackups.operationId,
    ),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<
        "draining" | "frozen" | "saving" | "deleting" | "completed" | "aborting" | "aborted"
      >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    physicalDeleteStartedAt: timestamp("physical_delete_started_at", { withTimezone: true }),
    abortProbeStoppedAt: timestamp("abort_probe_stopped_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    errorCode: varchar("error_code", { length: 64 }),
  },
  (table) => [
    check("relay_thread_vm_final_saves_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_final_saves_phase",
      sql`${table.phase} IN ('draining','frozen','saving','deleting','completed','aborting','aborted')`,
    ),
    check(
      "relay_thread_vm_final_saves_original_state",
      sql`${table.originalState} IN ('running','paused')`,
    ),
    check("relay_thread_vm_final_saves_reason", sql`${table.reason} IN ('idle','replacement')`),
    check(
      "relay_thread_vm_final_saves_frozen",
      sql`${table.phase} NOT IN ('frozen','saving','deleting','completed') OR (${table.sourceSequence} IS NOT NULL AND ${table.sourceSequence} >= 0 AND ${table.nativeCheckpointOperationId} IS NOT NULL AND ${table.frozenAt} IS NOT NULL)`,
    ),
    check(
      "relay_thread_vm_final_saves_backup",
      sql`${table.phase} NOT IN ('saving','deleting','completed') OR ${table.backupOperationId} IS NOT NULL`,
    ),
    check(
      "relay_thread_vm_final_saves_delete_started",
      sql`${table.physicalDeleteStartedAt} IS NULL OR ${table.phase} IN ('deleting','completed')`,
    ),
    check(
      "relay_thread_vm_final_saves_abort_stopped",
      sql`${table.abortProbeStoppedAt} IS NULL OR ${table.phase} IN ('aborting','aborted')`,
    ),
    uniqueIndex("idx_relay_thread_vm_final_saves_active")
      .on(table.threadId)
      .where(sql`${table.phase} NOT IN ('completed','aborted')`),
  ],
);

/** A restore holds independent conversation/disk pins and quota until its offline
 * preparation is positively removed. Preparation alone never grants execution. */
export const relayThreadVmBackupRecoveryCancellations = pgTable(
  "relay_thread_vm_backup_recovery_cancellations",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    request: jsonb("request")
      .notNull()
      .$type<import("../threads/ThreadVmBackupRecoveryStore.ts").ThreadVmBackupRecoveryInput>(),
  },
);
export const relayThreadVmBackupRecoveries = pgTable(
  "relay_thread_vm_backup_recoveries",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    allocationId: varchar("allocation_id", { length: 64 }).notNull().unique(),
    sourceAllocationId: varchar("source_allocation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmAllocations.allocationId),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    computeRef: varchar("compute_ref", { length: 191 }).notNull(),
    sourceOperationId: varchar("source_operation_id", { length: 64 }).notNull(),
    backupOperationId: varchar("backup_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmBackups.operationId),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadNativeCheckpoints.operationId),
    nativeRelayCursor: integer("native_relay_cursor").notNull(),
    throughRelayCursor: integer("through_relay_cursor").notNull(),
    throughCommandPosition: integer("through_command_position").notNull(),
    sourceTemplateId: varchar("source_template_id", { length: 191 }).notNull(),
    sourceBuildId: varchar("source_build_id", { length: 64 }).notNull(),
    independentHistory:
      jsonb("independent_history").$type<
        import("@t3tools/contracts/relay").RelayThreadVmIndependentHistory
      >(),
    retentionCandidate:
      jsonb("retention_candidate").$type<
        import("../machines/E2BRestoreClient.ts").E2BExecutionRetentionCandidate
      >(),
    retentionReceipt: jsonb("retention_receipt").$type<unknown>(),
    retentionRetiredAt: timestamp("retention_retired_at", { withTimezone: true }),
    stopReceipt: jsonb("stop_receipt").$type<unknown>(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<
        "pending" | "retaining" | "retained" | "stopped" | "restoring" | "completed" | "cancelled"
      >(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    errorCode: varchar("error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "relay_thread_vm_backup_recoveries_phase",
      sql`${table.phase} IN ('pending','retaining','retained','stopped','restoring','completed','cancelled')`,
    ),
    check(
      "relay_thread_vm_backup_recoveries_cursors",
      sql`${table.generation}>0 AND ${table.nativeRelayCursor}>=0 AND ${table.throughRelayCursor}>=${table.nativeRelayCursor} AND ${table.throughCommandPosition}>=0`,
    ),
    check(
      "relay_thread_vm_backup_recoveries_retained",
      sql`${table.phase} NOT IN ('retained','stopped','restoring','completed') OR (${table.retentionReceipt} IS NOT NULL AND ${table.independentHistory} IS NOT NULL)`,
    ),
    check(
      "relay_thread_vm_backup_recoveries_stopped",
      sql`${table.phase} NOT IN ('stopped','restoring','completed') OR ${table.stopReceipt} IS NOT NULL`,
    ),
    uniqueIndex("idx_relay_thread_vm_backup_recoveries_active")
      .on(table.threadId)
      .where(sql`${table.phase} NOT IN ('completed','cancelled')`),
    index("idx_relay_thread_vm_backup_recoveries_worker").on(
      table.hostId,
      table.phase,
      table.retryAt,
    ),
  ],
);

export const relayThreadVmRestores = pgTable(
  "relay_thread_vm_restores",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    savedDiskOperationId: varchar("saved_disk_operation_id", { length: 64 }).references(
      () => relayThreadVmSavedDisks.operationId,
    ),
    backupRecoveryOperationId: varchar("backup_recovery_operation_id", { length: 64 })
      .unique()
      .references(() => relayThreadVmBackupRecoveries.operationId),
    probeAttempt: integer("probe_attempt").notNull().default(0),
    preparationCancellations: jsonb("preparation_cancellations")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<ReadonlyArray<unknown>>(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    allocationId: varchar("allocation_id", { length: 64 })
      .notNull()
      .unique()
      .references(() => relayThreadVmAllocations.allocationId),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadNativeCheckpoints.operationId),
    sourceTemplateId: varchar("source_template_id", { length: 191 }).notNull(),
    sourceBuildId: varchar("source_build_id", { length: 64 }).notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<
        | "pending"
        | "preparing"
        | "prepared"
        | "boot_preparing"
        | "boot_prepared"
        | "committed"
        | "booted"
        | "importing"
        | "completed"
        | "aborting"
        | "aborted"
      >(),
    servingRequested: boolean("serving_requested").notNull().default(false),
    probeRemovedAt: timestamp("probe_removed_at", { withTimezone: true }),
    bootPrepareStartedAt: timestamp("boot_prepare_started_at", { withTimezone: true }),
    bootRecoveryStartedAt: timestamp("boot_recovery_started_at", { withTimezone: true }),
    bootAttempt: integer("boot_attempt").notNull().default(0),
    retiredBootReceipts: jsonb("retired_boot_receipts")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<ReadonlyArray<unknown>>(),
    bootReceipt:
      jsonb("boot_receipt").$type<import("../machines/E2BRestoreClient.ts").E2BRestoreStatus>(),
    identityCleanedAt: timestamp("identity_cleaned_at", { withTimezone: true }),
    importReceipt:
      jsonb("import_receipt").$type<
        import("@t3tools/contracts/relay").RelayThreadVmRestoreImportReceipt
      >(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    prepareStartedAt: timestamp("prepare_started_at", { withTimezone: true }),
    preparedReceipt:
      jsonb("prepared_receipt").$type<import("../machines/E2BRestoreClient.ts").E2BRestoreStatus>(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    deletionCleanedAt: timestamp("deletion_cleaned_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "relay_thread_vm_restores_source",
      sql`(${table.savedDiskOperationId} IS NOT NULL) <> (${table.backupRecoveryOperationId} IS NOT NULL)`,
    ),
    check("relay_thread_vm_restores_probe_attempt", sql`${table.probeAttempt}>=0`),
    check("relay_thread_vm_restores_boot_attempt_check", sql`${table.bootAttempt} >= 0`),
    check(
      "relay_thread_vm_restores_retired_boot_receipts_check",
      sql`jsonb_typeof(${table.retiredBootReceipts}) = 'array'`,
    ),
    check("relay_thread_vm_restores_generation", sql`${table.generation} > 0`),
    check(
      "relay_thread_vm_restores_phase",
      sql`${table.phase} IN ('pending','preparing','prepared','boot_preparing','boot_prepared','committed','booted','importing','completed','aborting','aborted')`,
    ),
    check(
      "relay_thread_vm_restores_started",
      sql`${table.phase} NOT IN ('preparing','prepared') OR ${table.prepareStartedAt} IS NOT NULL`,
    ),
    check(
      "relay_thread_vm_restores_prepared",
      sql`${table.phase} != 'prepared' OR ${table.preparedReceipt} IS NOT NULL`,
    ),
    check(
      "relay_thread_vm_restores_boot_started",
      sql`${table.bootPrepareStartedAt} IS NULL OR (${table.servingRequested} AND ${table.probeRemovedAt} IS NOT NULL AND ${table.preparedReceipt} IS NOT NULL)`,
    ),
    check(
      "relay_thread_vm_restores_boot_prepared",
      sql`${table.phase} NOT IN ('boot_prepared','committed','booted','importing','completed') OR (${table.bootPrepareStartedAt} IS NOT NULL AND ${table.bootReceipt} IS NOT NULL) OR (${table.phase} = 'committed' AND ${table.bootReceipt} IS NULL AND ${table.bootAttempt} > 0 AND jsonb_array_length(${table.retiredBootReceipts}) = ${table.bootAttempt} AND ${table.retiredBootReceipts}->-1->>'physicallyStopped' = 'true')`,
    ),
    check(
      "relay_thread_vm_restores_committed",
      sql`(${table.committedAt} IS NOT NULL) = (${table.phase} IN ('committed','booted','importing','completed'))`,
    ),
    uniqueIndex("idx_relay_thread_vm_restores_active")
      .on(table.threadId)
      .where(sql`${table.phase} NOT IN ('aborted','completed')`),
    index("idx_relay_thread_vm_restores_worker").on(table.hostId, table.phase, table.retryAt),
  ],
);

/** A move reserves its next VM before a fresh guest identity is enrolled. */
export const relayThreadVmMoveDestinations = pgTable("relay_thread_vm_move_destinations", {
  operationId: varchar("operation_id", { length: 64 })
    .primaryKey()
    .references(() => relayThreadMoves.operationId),
  allocationId: varchar("allocation_id", { length: 64 })
    .notNull()
    .unique()
    .references(() => relayThreadVmAllocations.allocationId),
});

export const relayThreadLocalEnrollments = pgTable(
  "relay_thread_local_enrollments",
  {
    threadId: varchar("thread_id", { length: 191 })
      .primaryKey()
      .references(() => relayThreadPlacements.threadId),
    operationId: varchar("operation_id", { length: 64 }).notNull().unique(),
    phase: varchar("phase", { length: 16 }).notNull().default("preparing"),
    sourceSequence: bigint("source_sequence", { mode: "number" }),
    receiptCount: integer("receipt_count"),
  },
  (t) => [
    check(
      "relay_thread_local_enrollment_phase",
      sql`${t.phase} IN ('preparing','active','aborted')`,
    ),
  ],
);
export const relayThreadLocalReceipts = pgTable(
  "relay_thread_local_receipts",
  {
    commandId: varchar("command_id", { length: 191 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadLocalEnrollments.threadId),
    receiptJson: jsonb("receipt_json").notNull(),
  },
  (t) => [index("idx_relay_thread_local_receipts_thread").on(t.threadId)],
);

// Retained abort identities reject delayed prepare/confirm requests without deleting thread history.
export const relayThreadLocalEnrollmentAborts = pgTable("relay_thread_local_enrollment_aborts", {
  operationId: varchar("operation_id", { length: 64 }).primaryKey(),
  threadId: varchar("thread_id", { length: 191 }).notNull(),
  environmentId: varchar("environment_id", { length: 191 }).notNull(),
  projectId: varchar("project_id", { length: 191 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
  canonicalKey: text("canonical_key").notNull(),
});

/** A selected replacement owns the slot freed by its victim until the incoming allocation is admitted. */
export const relayThreadVmReplacements = pgTable(
  "relay_thread_vm_replacements",
  {
    requestId: varchar("request_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    templateId: varchar("template_id", { length: 191 }).notNull(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    intentJson: text("intent_json").notNull(),
    phase: varchar("phase", { length: 24 })
      .notNull()
      .$type<"awaiting_choice" | "waiting" | "admitted" | "cancelled">(),
    victimAllocationId: varchar("victim_allocation_id", { length: 64 }).references(
      () => relayThreadVmAllocations.allocationId,
    ),
    finalSaveOperationId: varchar("final_save_operation_id", { length: 64 }).references(
      () => relayThreadVmFinalSaves.operationId,
    ),
    position: bigserial("position", { mode: "number" }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
  },
  (table) => [
    check(
      "relay_thread_vm_replacements_phase",
      sql`${table.phase} IN ('awaiting_choice','waiting','admitted','cancelled')`,
    ),
    check(
      "relay_thread_vm_replacements_victim",
      sql`(${table.victimAllocationId} IS NULL) = (${table.finalSaveOperationId} IS NULL) AND (${table.phase} != 'waiting' OR ${table.victimAllocationId} IS NOT NULL)`,
    ),
    uniqueIndex("idx_relay_thread_vm_replacements_thread")
      .on(table.threadId)
      .where(sql`${table.phase} IN ('awaiting_choice','waiting')`),
    uniqueIndex("idx_relay_thread_vm_replacements_victim")
      .on(table.victimAllocationId)
      .where(sql`${table.phase} = 'waiting'`),
    index("idx_relay_thread_vm_replacements_work").on(
      table.hostId,
      table.phase,
      table.checkedAt,
      table.position,
    ),
  ],
);

/** Reset replaces an expired workspace while retaining the logical conversation.
 * The durable operation and recovery pins survive compute/admission retries. */
export const relayThreadVmResets = pgTable(
  "relay_thread_vm_resets",
  {
    operationId: varchar("operation_id", { length: 64 }).primaryKey(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    allocationId: varchar("allocation_id", { length: 64 }).notNull().unique(),
    actorUserId: varchar("actor_user_id", { length: 191 }).notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    savedDiskOperationId: varchar("saved_disk_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadVmSavedDisks.operationId),
    nativeCheckpointOperationId: varchar("native_checkpoint_operation_id", { length: 64 })
      .notNull()
      .references(() => relayThreadNativeCheckpoints.operationId),
    sourceEnvironmentId: varchar("source_environment_id", { length: 191 }).notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    templateId: varchar("template_id", { length: 191 }).notNull(),
    canonicalKey: varchar("canonical_key", { length: 512 }).notNull(),
    branch: text("branch").notNull(),
    revision: varchar("revision", { length: 64 }).notNull(),
    importReceipt: jsonb("import_receipt"),
    repositoryUpload: jsonb("repository_upload").$type<RelayThreadVmRepositoryUpload>(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .default("pending")
      .$type<
        | "pending"
        | "creating"
        | "committed"
        | "importing"
        | "completed"
        | "cancelling"
        | "cancelled"
      >(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
  },
  (table) => [
    uniqueIndex("relay_thread_vm_resets_active")
      .on(table.threadId)
      .where(sql`${table.phase} NOT IN ('completed','cancelled')`),
    check(
      "relay_thread_vm_resets_generation",
      sql`${table.expectedGeneration}>0 AND ${table.sourceSequence}>=0`,
    ),
    check(
      "relay_thread_vm_resets_revision",
      sql`${table.revision} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      "relay_thread_vm_resets_phase",
      sql`${table.phase} IN ('pending','creating','committed','importing','completed','cancelling','cancelled')`,
    ),
  ],
);

/** Permanent deletion keeps a tombstone so a delayed credential/operation cannot
 * resurrect the logical thread. Resources keep their existing cleanup catalogs. */
export const relayThreadDeletions = pgTable(
  "relay_thread_deletions",
  {
    threadId: varchar("thread_id", { length: 191 })
      .primaryKey()
      .references(() => relayThreadPlacements.threadId),
    operationId: varchar("operation_id", { length: 191 }).notNull().unique(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    hostId: varchar("host_id", { length: 191 }).notNull(),
    phase: varchar("phase", { length: 16 })
      .notNull()
      .$type<"stopping" | "cleaning" | "completed">(),
    claimId: varchar("claim_id", { length: 64 }),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    allowUncertainCaptureCleanup: boolean("allow_uncertain_capture_cleanup")
      .notNull()
      .default(false),
  },
  (table) => [
    check("relay_thread_deletions_generation", sql`${table.generation}>0`),
    check(
      "relay_thread_deletions_phase",
      sql`${table.phase} IN ('stopping','cleaning','completed')`,
    ),
    index("idx_relay_thread_deletions_work").on(table.hostId, table.phase, table.retryAt),
  ],
);

/** Short-lived application-origin access; raw bootstrap/session credentials never enter the catalog. */
export const relayThreadVmPreviews = pgTable(
  "relay_thread_vm_previews",
  {
    previewId: varchar("preview_id", { length: 32 }).primaryKey(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    threadId: varchar("thread_id", { length: 191 })
      .notNull()
      .references(() => relayThreadPlacements.threadId),
    allocationId: varchar("allocation_id", { length: 191 }).notNull(),
    generation: integer("generation").notNull(),
    port: integer("port").notNull(),
    ticketSha256: varchar("ticket_sha256", { length: 64 }).notNull(),
    sessionSha256: varchar("session_sha256", { length: 64 }),
    ticketExpiresAt: timestamp("ticket_expires_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()+interval '1 minute'`),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()+interval '1 hour'`),
  },
  (table) => [
    index("idx_relay_thread_vm_previews_thread").on(table.threadId, table.expiresAt),
    check("relay_thread_vm_previews_generation", sql`${table.generation}>0`),
    check(
      "relay_thread_vm_previews_port",
      sql`${table.port} BETWEEN 1024 AND 65535 AND ${table.port} NOT IN (3773,49983)`,
    ),
  ],
);

export { relayThreadCurrentQueues } from "./threadQueueSchema.ts";

/** Native workflow sources deliberately do not share personal MCP credentials. */
export const relayWorkflowConnections = pgTable(
  "relay_workflow_connections",
  {
    connectionId: text("connection_id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    applicationId: text("application_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    viewerName: text("viewer_name").notNull(),
    status: text("status").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull().default(1),
    activatedAt: text("activated_at").notNull(),
    authorizationStartedAt: text("authorization_started_at"),
    deliveryEvidence: jsonb("delivery_evidence"),
    credentialVersion: integer("credential_version").notNull().default(1),
    payloadSealed: text("payload_sealed"),
    health: jsonb("health").notNull(),
    leaseId: text("lease_id"),
    leaseUntil: text("lease_until"),
    refreshStartedAt: text("refresh_started_at"),
  },
  (t) => [
    uniqueIndex("workflow_connection_owner_workspace").on(
      t.ownerUserId,
      t.applicationId,
      t.workspaceId,
    ),
  ],
);
export const relayWorkflowAuthorizations = pgTable(
  "relay_workflow_authorizations",
  {
    ownerUserId: text("owner_user_id").notNull(),
    applicationId: text("application_id").notNull(),
    version: integer("version").notNull().default(0),
    attemptId: text("attempt_id"),
    startedAt: text("started_at"),
    connectionId: text("connection_id"),
    expectedEpoch: integer("expected_epoch"),
    stateHash: text("state_hash"),
    pendingSealed: text("pending_sealed"),
    expiresAt: text("expires_at"),
    status: text("status"),
    error: text("error"),
  },
  (t) => [
    primaryKey({ columns: [t.ownerUserId, t.applicationId] }),
    uniqueIndex("workflow_authorization_state").on(t.stateHash),
  ],
);
export const relayWorkflowRepositoryGrants = pgTable(
  "relay_workflow_repository_grants",
  {
    grantId: text("grant_id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    organizationId: text("organization_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    generation: integer("generation").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    uniqueIndex("workflow_active_repository_source")
      .on(t.repositoryId, t.connectionId)
      .where(sql`NOT ${t.revoked}`),
    uniqueIndex("workflow_grant_generation").on(t.repositoryId, t.connectionId, t.generation),
    index("workflow_grant_owner_org").on(t.ownerUserId, t.organizationId),
  ],
);

export const relayWorkflowOccurrences = pgTable(
  "relay_workflow_occurrences",
  {
    occurrenceId: text("occurrence_id").primaryKey(),
    applicationId: text("application_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
    facts: jsonb("facts").notNull(),
    jobCount: integer("job_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("workflow_occurrence_identity").on(t.applicationId, t.workspaceId, t.eventKey),
    index("workflow_revocation_cutoff").on(
      t.applicationId,
      t.workspaceId,
      t.eventType,
      t.occurredAt,
    ),
  ],
);
export const relayWorkflowAdmissions = pgTable(
  "relay_workflow_admissions",
  {
    occurrenceId: text("occurrence_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    jobId: text("job_id").notNull(),
    organizationId: text("organization_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    connectionId: text("connection_id").notNull(),
    grantId: text("grant_id").notNull(),
    grantGeneration: integer("grant_generation").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    workflowRevision: integer("workflow_revision").notNull(),
    routingGeneration: integer("routing_generation").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.occurrenceId, t.workflowId] }),
    uniqueIndex("workflow_admission_job").on(t.jobId),
    index("idx_workflow_admissions_connection").on(t.connectionId),
  ],
);
