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
} from "@t3tools/contracts/relay";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

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

export const relayMobileDevices = pgTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios">(),
    iosMajorVersion: integer("ios_major_version").notNull(),
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

export const relayAgentActivityRows = pgTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
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
    threadId: varchar("thread_id", { length: 191 }),
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
