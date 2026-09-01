import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";

export const RelayAgentAwarenessPlatform = Schema.Literal("ios");
export type RelayAgentAwarenessPlatform = typeof RelayAgentAwarenessPlatform.Type;

export const RelayAgentAwarenessPhase = Schema.Literals([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type RelayAgentAwarenessPhase = typeof RelayAgentAwarenessPhase.Type;

export const RelayAgentAwarenessPreferences = Schema.Struct({
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type RelayAgentAwarenessPreferences = typeof RelayAgentAwarenessPreferences.Type;

export const RelayApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type RelayApnsEnvironment = typeof RelayApnsEnvironment.Type;

export const RelayDeviceRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(18)),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  // APNs routing for this install: the topic must match the app's bundle id
  // (dev/preview/prod variants differ) and development-signed builds receive
  // sandbox tokens. Optional so older app builds keep registering; the relay
  // falls back to its configured defaults.
  bundleId: Schema.optional(TrimmedNonEmptyString),
  apsEnvironment: Schema.optional(RelayApnsEnvironment),
  pushToken: Schema.optional(TrimmedNonEmptyString),
  pushToStartToken: Schema.optional(TrimmedNonEmptyString),
  preferences: RelayAgentAwarenessPreferences,
});
export type RelayDeviceRegistrationRequest = typeof RelayDeviceRegistrationRequest.Type;

export const RelayClientDeviceRecord = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(18)),
  appVersion: Schema.NullOr(TrimmedNonEmptyString),
  notifications: Schema.Struct({
    enabled: Schema.Boolean,
    notifyOnApproval: Schema.Boolean,
    notifyOnInput: Schema.Boolean,
    notifyOnCompletion: Schema.Boolean,
    notifyOnFailure: Schema.Boolean,
  }),
  liveActivities: Schema.Struct({
    enabled: Schema.Boolean,
  }),
  updatedAt: TrimmedNonEmptyString,
});
export type RelayClientDeviceRecord = typeof RelayClientDeviceRecord.Type;

export const RelayListDevicesResponse = Schema.Struct({
  devices: Schema.Array(RelayClientDeviceRecord),
});
export type RelayListDevicesResponse = typeof RelayListDevicesResponse.Type;

export const RelayLiveActivityRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  activityPushToken: TrimmedNonEmptyString,
});
export type RelayLiveActivityRegistrationRequest = typeof RelayLiveActivityRegistrationRequest.Type;

export const RelayDeviceUnregistrationParams = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type RelayDeviceUnregistrationParams = typeof RelayDeviceUnregistrationParams.Type;

export const RelayAgentActivityState = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  headline: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  modelTitle: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityState = typeof RelayAgentActivityState.Type;

export const RelayAgentActivityAggregateRow = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  modelTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  status: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityAggregateRow = typeof RelayAgentActivityAggregateRow.Type;

export const RelayAgentActivityAggregateState = Schema.Struct({
  title: TrimmedNonEmptyString,
  subtitle: TrimmedNonEmptyString,
  activeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: TrimmedNonEmptyString,
  activities: Schema.Array(RelayAgentActivityAggregateRow),
});
export type RelayAgentActivityAggregateState = typeof RelayAgentActivityAggregateState.Type;

export const RelayManagedEndpointProviderKind = Schema.Literals([
  "manual",
  "cloudflare_tunnel",
  "t3_relay",
]);
export type RelayManagedEndpointProviderKind = typeof RelayManagedEndpointProviderKind.Type;

export const RelayManagedEndpoint = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  providerKind: RelayManagedEndpointProviderKind,
});
export type RelayManagedEndpoint = typeof RelayManagedEndpoint.Type;

export const RelayManagedEndpointOrigin = Schema.Struct({
  localHttpHost: TrimmedNonEmptyString,
  localHttpPort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
});
export type RelayManagedEndpointOrigin = typeof RelayManagedEndpointOrigin.Type;

export const RelayManagedEndpointRuntimeConfig = Schema.Struct({
  providerKind: RelayManagedEndpointProviderKind,
  connectorToken: TrimmedNonEmptyString,
  tunnelId: Schema.optional(TrimmedNonEmptyString),
  tunnelName: Schema.optional(TrimmedNonEmptyString),
});
export type RelayManagedEndpointRuntimeConfig = typeof RelayManagedEndpointRuntimeConfig.Type;

export const RelayLinkProofRequest = Schema.Struct({
  challenge: Schema.String,
  relayIssuer: Schema.String,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
});
export type RelayLinkProofRequest = typeof RelayLinkProofRequest.Type;

export const RelayEnvironmentConfigRequest = Schema.Struct({
  relayUrl: Schema.String,
  relayIssuer: Schema.optional(Schema.String),
  cloudUserId: Schema.String,
  environmentCredential: Schema.String,
  cloudMintPublicKey: Schema.String,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
});
export type RelayEnvironmentConfigRequest = typeof RelayEnvironmentConfigRequest.Type;

const RelaySignedJwtRegisteredClaims = {
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
} as const;

export const RelayAgentActivityPublishProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: Schema.NullOr(RelayAgentActivityState),
});
export type RelayAgentActivityPublishProofPayload =
  typeof RelayAgentActivityPublishProofPayload.Type;
export type RelayAgentActivityPublishProof = string;

export const RelayAgentActivityPublishRequest = Schema.Struct({
  state: Schema.NullOr(RelayAgentActivityState).annotate({
    description: "Current agent-awareness state, or null to remove the published state.",
  }),
  proof: TrimmedNonEmptyString.annotate({
    description: "Environment-signed JWT covering this published activity state.",
  }),
}).annotate({ description: "Publishes a signed agent-awareness update from an environment." });
export type RelayAgentActivityPublishRequest = typeof RelayAgentActivityPublishRequest.Type;

export const RelayEnvironmentLinkScope = Schema.Literals([
  "agent_activity_notifications",
  "managed_tunnels",
]);
export type RelayEnvironmentLinkScope = typeof RelayEnvironmentLinkScope.Type;

export const RelayEnvironmentLinkProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  challenge: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
  scopes: Schema.Array(RelayEnvironmentLinkScope),
});
export type RelayEnvironmentLinkProofPayload = typeof RelayEnvironmentLinkProofPayload.Type;

export const RelayEnvironmentLinkProof = TrimmedNonEmptyString;
export type RelayEnvironmentLinkProof = typeof RelayEnvironmentLinkProof.Type;

export const RelayEnvironmentLinkChallengeRequest = Schema.Struct({
  notificationsEnabled: Schema.Boolean.annotate({
    description: "Whether this link may deliver push notifications.",
  }),
  liveActivitiesEnabled: Schema.Boolean.annotate({
    description: "Whether this link may update Live Activities.",
  }),
  managedTunnelsEnabled: Schema.Boolean.annotate({
    description: "Whether the relay should provision a managed tunnel for this environment.",
  }),
}).annotate({ description: "Requested capabilities for a new environment-link challenge." });
export type RelayEnvironmentLinkChallengeRequest = typeof RelayEnvironmentLinkChallengeRequest.Type;

export const RelayEnvironmentLinkChallengeResponse = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkChallengeResponse =
  typeof RelayEnvironmentLinkChallengeResponse.Type;

export const RelayEnvironmentLinkRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier associated with this link.",
    }),
  ),
  proof: RelayEnvironmentLinkProof.annotate({
    description: "Environment-signed proof bound to a previously issued link challenge.",
  }),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
}).annotate({ description: "Links an authenticated cloud user to a Launchpad environment." });
export type RelayEnvironmentLinkRequest = typeof RelayEnvironmentLinkRequest.Type;

export const RelayEnvironmentLinkResponse = Schema.Struct({
  ok: Schema.Boolean,
  cloudUserId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  relayIssuer: TrimmedNonEmptyString,
  environmentCredential: TrimmedNonEmptyString,
  cloudMintPublicKey: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkResponse = typeof RelayEnvironmentLinkResponse.Type;

export const RelayEnvironmentLinkProofInvalidReason = Schema.Literals([
  "invalid_signature_or_scope",
  "descriptor_mismatch",
  "replayed_nonce",
  "challenge_invalid",
  "origin_not_allowed",
  "endpoint_not_secure",
  // The environment is an enrolled machine. Machines are org-owned and
  // single-tenant (ADR-0002); linking one as a personal environment would give
  // one member a private door into org compute, so the two trust paths stay
  // disjoint in both directions.
  "environment_is_machine",
]);
export type RelayEnvironmentLinkProofInvalidReason =
  typeof RelayEnvironmentLinkProofInvalidReason.Type;

export const RelayEnvironmentLinkFailedReason = Schema.Literals([
  "link_persistence_failed",
  "credential_persistence_failed",
  "replay_persistence_failed",
  "internal_error",
]);
export type RelayEnvironmentLinkFailedReason = typeof RelayEnvironmentLinkFailedReason.Type;

export const RelayEnvironmentLinkUnavailableReason = Schema.Literals([
  "managed_endpoint_not_configured",
  "managed_endpoint_provisioning_failed",
]);
export type RelayEnvironmentLinkUnavailableReason =
  typeof RelayEnvironmentLinkUnavailableReason.Type;

export const RelayEnvironmentEndpointUnavailableReason = Schema.Literals([
  "endpoint_request_failed",
  "endpoint_response_invalid",
]);
export type RelayEnvironmentEndpointUnavailableReason =
  typeof RelayEnvironmentEndpointUnavailableReason.Type;

export const RelayAgentActivityPublishProofInvalidReason = Schema.Literals([
  "invalid_signature_or_payload",
  "replayed_nonce",
]);
export type RelayAgentActivityPublishProofInvalidReason =
  typeof RelayAgentActivityPublishProofInvalidReason.Type;

export const RelayProjectCatalogPublishProofInvalidReason = Schema.Literals([
  "invalid_signature_or_payload",
  "replayed_nonce",
]);
export type RelayProjectCatalogPublishProofInvalidReason =
  typeof RelayProjectCatalogPublishProofInvalidReason.Type;

export const RelayAuthInvalidReason = Schema.Literals([
  "missing_bearer",
  "invalid_bearer",
  "invalid_dpop",
  "not_authorized",
]);
export type RelayAuthInvalidReason = typeof RelayAuthInvalidReason.Type;

export const RelayInternalErrorReason = Schema.Literals([
  "database_unavailable",
  "persistence_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type RelayInternalErrorReason = typeof RelayInternalErrorReason.Type;

export class RelayAuthInvalidError extends Schema.TaggedErrorClass<RelayAuthInvalidError>()(
  "RelayAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: RelayAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay authentication failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkProofExpiredError extends Schema.TaggedErrorClass<RelayEnvironmentLinkProofExpiredError>()(
  "RelayEnvironmentLinkProofExpiredError",
  {
    code: Schema.Literal("environment_link_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay environment link proof expired";
  }
}

export class RelayEnvironmentLinkProofInvalidError extends Schema.TaggedErrorClass<RelayEnvironmentLinkProofInvalidError>()(
  "RelayEnvironmentLinkProofInvalidError",
  {
    code: Schema.Literal("environment_link_proof_invalid"),
    reason: RelayEnvironmentLinkProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `Relay environment link proof is invalid: ${this.reason}`;
  }
}

export const RelayEnvironmentConnectNotAuthorizedReason = Schema.Literals([
  "client_proof_key_thumbprint_missing",
  "environment_link_not_found",
  "endpoint_provider_not_managed",
  "managed_endpoint_allocation_not_found",
  "managed_endpoint_base_domain_not_configured",
  "managed_endpoint_allocation_not_ready",
  "managed_endpoint_hostname_invalid",
  "managed_endpoint_mismatch",
]);
export type RelayEnvironmentConnectNotAuthorizedReason =
  typeof RelayEnvironmentConnectNotAuthorizedReason.Type;

export class RelayEnvironmentConnectNotAuthorizedError extends Schema.TaggedErrorClass<RelayEnvironmentConnectNotAuthorizedError>()(
  "RelayEnvironmentConnectNotAuthorizedError",
  {
    code: Schema.Literal("environment_connect_not_authorized"),
    // Optional so responses from relays deployed before the reason was
    // threaded through still decode.
    reason: Schema.optional(RelayEnvironmentConnectNotAuthorizedReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return this.reason
      ? `Relay environment connection is not authorized: ${this.reason}`
      : "Relay environment connection is not authorized";
  }
}

export class RelayEnvironmentEndpointUnavailableError extends Schema.TaggedErrorClass<RelayEnvironmentEndpointUnavailableError>()(
  "RelayEnvironmentEndpointUnavailableError",
  {
    code: Schema.Literal("environment_endpoint_unavailable"),
    reason: RelayEnvironmentEndpointUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay environment endpoint is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentEndpointTimedOutError extends Schema.TaggedErrorClass<RelayEnvironmentEndpointTimedOutError>()(
  "RelayEnvironmentEndpointTimedOutError",
  {
    code: Schema.Literal("environment_endpoint_timed_out"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  override get message(): string {
    return "Relay environment endpoint request timed out";
  }
}

export class RelayEnvironmentLinkFailedError extends Schema.TaggedErrorClass<RelayEnvironmentLinkFailedError>()(
  "RelayEnvironmentLinkFailedError",
  {
    code: Schema.Literal("environment_link_failed"),
    reason: RelayEnvironmentLinkFailedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay environment link failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkUnavailableError extends Schema.TaggedErrorClass<RelayEnvironmentLinkUnavailableError>()(
  "RelayEnvironmentLinkUnavailableError",
  {
    code: Schema.Literal("environment_link_unavailable"),
    reason: RelayEnvironmentLinkUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Relay environment link is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkLimitExceededError extends Schema.TaggedErrorClass<RelayEnvironmentLinkLimitExceededError>()(
  "RelayEnvironmentLinkLimitExceededError",
  {
    code: Schema.Literal("environment_link_limit_exceeded"),
    maxTunnels: Schema.Number,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `Relay managed tunnel limit reached: this account allows at most ${this.maxTunnels} tunnels`;
  }
}

export class RelayAgentActivityPublishProofExpiredError extends Schema.TaggedErrorClass<RelayAgentActivityPublishProofExpiredError>()(
  "RelayAgentActivityPublishProofExpiredError",
  {
    code: Schema.Literal("agent_activity_publish_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay agent activity publish proof expired";
  }
}

export class RelayAgentActivityPublishProofInvalidError extends Schema.TaggedErrorClass<RelayAgentActivityPublishProofInvalidError>()(
  "RelayAgentActivityPublishProofInvalidError",
  {
    code: Schema.Literal("agent_activity_publish_proof_invalid"),
    reason: RelayAgentActivityPublishProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay agent activity publish proof is invalid: ${this.reason}`;
  }
}

export class RelayProjectCatalogPublishProofExpiredError extends Schema.TaggedErrorClass<RelayProjectCatalogPublishProofExpiredError>()(
  "RelayProjectCatalogPublishProofExpiredError",
  {
    code: Schema.Literal("project_catalog_publish_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay project catalog publish proof expired";
  }
}

export class RelayProjectCatalogPublishProofInvalidError extends Schema.TaggedErrorClass<RelayProjectCatalogPublishProofInvalidError>()(
  "RelayProjectCatalogPublishProofInvalidError",
  {
    code: Schema.Literal("project_catalog_publish_proof_invalid"),
    reason: RelayProjectCatalogPublishProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay project catalog publish proof is invalid: ${this.reason}`;
  }
}

export const RelayTenancyForbiddenReason = Schema.Literals([
  "not_an_admin",
  "not_a_maintainer",
  "no_repository_access",
  "last_admin",
  "organization_not_empty",
  "cannot_change_own_role",
]);
export type RelayTenancyForbiddenReason = typeof RelayTenancyForbiddenReason.Type;

export const RelayTenancyNotFoundReason = Schema.Literals([
  "member_not_found",
  "repository_not_found",
  "alias_not_found",
  "invitation_not_found",
  "github_installation_not_found",
  "github_not_connected",
  "machine_not_found",
]);
export type RelayTenancyNotFoundReason = typeof RelayTenancyNotFoundReason.Type;

export const RelayTenancyConflictReason = Schema.Literals([
  "canonical_key_taken",
  "last_alias",
  "github_installation_claimed",
  "already_a_member",
  "invitation_not_pending",
  "invitation_email_mismatch",
  "machine_limit_reached",
  "machine_deprovisioned",
]);
export type RelayTenancyConflictReason = typeof RelayTenancyConflictReason.Type;

export class RelayTenancyForbiddenError extends Schema.TaggedErrorClass<RelayTenancyForbiddenError>()(
  "RelayTenancyForbiddenError",
  {
    code: Schema.Literal("tenancy_forbidden"),
    reason: RelayTenancyForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `Relay tenancy operation is forbidden: ${this.reason}`;
  }
}

export class RelayTenancyNotFoundError extends Schema.TaggedErrorClass<RelayTenancyNotFoundError>()(
  "RelayTenancyNotFoundError",
  {
    code: Schema.Literal("tenancy_not_found"),
    reason: RelayTenancyNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Relay tenancy record was not found: ${this.reason}`;
  }
}

export class RelayTenancyConflictError extends Schema.TaggedErrorClass<RelayTenancyConflictError>()(
  "RelayTenancyConflictError",
  {
    code: Schema.Literal("tenancy_conflict"),
    reason: RelayTenancyConflictReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `Relay tenancy operation conflicts with existing state: ${this.reason}`;
  }
}

export const RelayMachineEnrollProofInvalidReason = Schema.Literals([
  "invalid_signature_or_scope",
  // Covers an unknown seed, an expired seed, and a seed that was already
  // consumed alike: an unauthenticated caller learns nothing about which.
  "seed_invalid",
  "replayed_nonce",
  "origin_not_allowed",
  "endpoint_not_secure",
  "environment_already_linked",
]);
export type RelayMachineEnrollProofInvalidReason = typeof RelayMachineEnrollProofInvalidReason.Type;

export class RelayMachineEnrollProofInvalidError extends Schema.TaggedErrorClass<RelayMachineEnrollProofInvalidError>()(
  "RelayMachineEnrollProofInvalidError",
  {
    code: Schema.Literal("machine_enroll_proof_invalid"),
    reason: RelayMachineEnrollProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `Relay machine enrollment proof is invalid: ${this.reason}`;
  }
}

export const RelayMachineEnrollFailedReason = Schema.Literals([
  "enrollment_persistence_failed",
  "credential_persistence_failed",
  "replay_persistence_failed",
  "internal_error",
]);
export type RelayMachineEnrollFailedReason = typeof RelayMachineEnrollFailedReason.Type;

export class RelayMachineEnrollFailedError extends Schema.TaggedErrorClass<RelayMachineEnrollFailedError>()(
  "RelayMachineEnrollFailedError",
  {
    code: Schema.Literal("machine_enroll_failed"),
    reason: RelayMachineEnrollFailedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay machine enrollment failed: ${this.reason}`;
  }
}

export class RelayMachineEnrollUnavailableError extends Schema.TaggedErrorClass<RelayMachineEnrollUnavailableError>()(
  "RelayMachineEnrollUnavailableError",
  {
    code: Schema.Literal("machine_enroll_unavailable"),
    reason: Schema.Literals(["managed_endpoint_provisioning_failed"]),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Relay machine enrollment is unavailable: ${this.reason}`;
  }
}

export const RelayMachineComputeUnavailableReason = Schema.Literals([
  "not_configured",
  "request_failed",
]);
export type RelayMachineComputeUnavailableReason = typeof RelayMachineComputeUnavailableReason.Type;

/** The compute driver could not create or destroy the machine's compute. */
export class RelayMachineComputeUnavailableError extends Schema.TaggedErrorClass<RelayMachineComputeUnavailableError>()(
  "RelayMachineComputeUnavailableError",
  {
    code: Schema.Literal("machine_compute_unavailable"),
    reason: RelayMachineComputeUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay machine compute provider is unavailable: ${this.reason}`;
  }
}

export class RelayInternalError extends Schema.TaggedErrorClass<RelayInternalError>()(
  "RelayInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: RelayInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay internal error: ${this.reason}`;
  }
}

export const RelayProtectedError = Schema.Union([
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayProjectCatalogPublishProofExpiredError,
  RelayProjectCatalogPublishProofInvalidError,
  RelayTenancyForbiddenError,
  RelayTenancyNotFoundError,
  RelayTenancyConflictError,
  RelayMachineEnrollProofInvalidError,
  RelayMachineEnrollFailedError,
  RelayMachineEnrollUnavailableError,
  RelayMachineComputeUnavailableError,
  RelayInternalError,
]);
export type RelayProtectedError = typeof RelayProtectedError.Type;

const RelayAuthAndInternalErrors = [RelayAuthInvalidError, RelayInternalError] as const;

const RelayEnvironmentLinkErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayEnvironmentLinkFailedError,
  RelayInternalError,
] as const;

const RelayEnvironmentConnectErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayInternalError,
] as const;

const RelayAgentActivityPublishErrors = [
  RelayAuthInvalidError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
] as const;

const RelayProjectCatalogPublishErrors = [
  RelayAuthInvalidError,
  RelayProjectCatalogPublishProofExpiredError,
  RelayProjectCatalogPublishProofInvalidError,
  RelayInternalError,
] as const;

export class RelayClientPrincipal extends Context.Service<
  RelayClientPrincipal,
  {
    readonly userId: string;
    readonly token: string;
    readonly proofKeyThumbprint?: string;
    readonly dpopScopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
  }
>()("@t3tools/contracts/relay/RelayClientPrincipal") {}

export class RelayEnvironmentPrincipal extends Context.Service<
  RelayEnvironmentPrincipal,
  {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
  }
>()("@t3tools/contracts/relay/RelayEnvironmentPrincipal") {}

const RelayClientBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Clerk session or OAuth bearer token for the signed-in Launchpad Connect user.",
  ),
);

export class RelayClientAuth extends HttpApiMiddleware.Service<
  RelayClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayClientAuth", {
  error: RelayAuthInvalidError,
  security: { clientBearer: RelayClientBearerAuthorization },
}) {}

const RelayEnvironmentBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Relay-issued environment credential installed when the environment is linked.",
  ),
);

export class RelayEnvironmentAuth extends HttpApiMiddleware.Service<
  RelayEnvironmentAuth,
  { provides: RelayEnvironmentPrincipal }
>()("RelayEnvironmentAuth", {
  error: [RelayAuthInvalidError, RelayInternalError],
  security: { environmentBearer: RelayEnvironmentBearerAuthorization },
}) {}

const RelayDpopAuthorization = HttpApiSecurity.http({ scheme: "DPoP" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
  ),
);

export class RelayDpopClientAuth extends HttpApiMiddleware.Service<
  RelayDpopClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayDpopClientAuth", {
  error: RelayAuthInvalidError,
  security: { relayDpop: RelayDpopAuthorization },
}) {}

export const RelayClientEnvironmentRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  linkedAt: TrimmedNonEmptyString,
});
export type RelayClientEnvironmentRecord = typeof RelayClientEnvironmentRecord.Type;

export const RelayListEnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(RelayClientEnvironmentRecord),
});
export type RelayListEnvironmentsResponse = typeof RelayListEnvironmentsResponse.Type;

export const RelayEnvironmentConnectRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier requesting the connection.",
    }),
  ),
  clientKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Deprecated alias for clientProofKeyThumbprint.",
    }),
  ),
  clientProofKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "JWK thumbprint that the minted environment credential must be bound to.",
    }),
  ),
}).annotate({ description: "Requests a short-lived credential for connecting to an environment." });
export type RelayEnvironmentConnectRequest = typeof RelayEnvironmentConnectRequest.Type;

export const RelayEnvironmentConnectScope = "environment:connect" as const;
export const RelayEnvironmentStatusScope = "environment:status" as const;
export const RelayMobileRegistrationScope = "mobile:registration" as const;
/**
 * Dispatching a job runs work on the user's machine, which neither connecting
 * nor reading status does. It is its own scope so a token minted for a client
 * that only mirrors state cannot start an agent.
 */
export const RelayJobDispatchScope = "jobs:dispatch" as const;
export const RelayDpopAccessTokenScope = Schema.Literals([
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
  RelayJobDispatchScope,
]);
export type RelayDpopAccessTokenScope = typeof RelayDpopAccessTokenScope.Type;

export const RelayDpopTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const RelayJwtSubjectTokenType = "urn:ietf:params:oauth:token-type:jwt" as const;
export const RelayAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const RelayPublicClientId = Schema.Literals(["t3-mobile", "t3-web"]);
export type RelayPublicClientId = typeof RelayPublicClientId.Type;
export const RelayMobileClientId = "t3-mobile" as const;
export const RelayWebClientId = "t3-web" as const;

export const RelayDpopAccessTokenRequest = Schema.Struct({
  grant_type: Schema.Literal(RelayDpopTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString.annotate({
    description: "Clerk bearer token for the signed-in cloud user.",
  }),
  subject_token_type: Schema.Literal(RelayJwtSubjectTokenType),
  requested_token_type: Schema.Literal(RelayAccessTokenType),
  resource: TrimmedNonEmptyString.annotate({
    description: "Relay issuer URL that will receive the DPoP-bound access token.",
  }),
  scope: TrimmedNonEmptyString.annotate({
    description: "Space-separated relay scopes requested by the client.",
  }),
  client_id: RelayPublicClientId,
})
  .annotate({ description: "OAuth token exchange request for a DPoP-bound relay access token." })
  .pipe(HttpApiSchema.asFormUrlEncoded());
export type RelayDpopAccessTokenRequest = typeof RelayDpopAccessTokenRequest.Type;

export const RelayDpopAccessTokenResponse = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(RelayAccessTokenType),
  token_type: Schema.Literal("DPoP"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: TrimmedNonEmptyString,
});
export type RelayDpopAccessTokenResponse = typeof RelayDpopAccessTokenResponse.Type;

export const RelayBearerRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
});

export const RelayDpopProofRequestHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString,
});

export const RelayDpopRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
  dpop: TrimmedNonEmptyString,
});

export const RelayAuthorizationServerMetadata = Schema.Struct({
  issuer: TrimmedNonEmptyString,
  token_endpoint: TrimmedNonEmptyString,
  grant_types_supported: Schema.Array(Schema.Literal(RelayDpopTokenExchangeGrantType)),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
});

export const RelayProtectedResourceMetadata = Schema.Struct({
  resource: TrimmedNonEmptyString,
  authorization_servers: Schema.Array(TrimmedNonEmptyString),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
  dpop_bound_access_tokens_required: Schema.Boolean,
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
});

export const RelayEnvironmentUnlinkParams = Schema.Struct({
  environmentId: EnvironmentId,
});
export type RelayEnvironmentUnlinkParams = typeof RelayEnvironmentUnlinkParams.Type;

export const RelayEnvironmentConnectResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentConnectResponse = typeof RelayEnvironmentConnectResponse.Type;

export const RelayEnvironmentStatusValue = Schema.Literals(["online", "offline"]);
export type RelayEnvironmentStatusValue = typeof RelayEnvironmentStatusValue.Type;

export const RelayEnvironmentStatusResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  status: RelayEnvironmentStatusValue,
  checkedAt: TrimmedNonEmptyString,
  descriptor: Schema.optional(ExecutionEnvironmentDescriptor),
  error: Schema.optional(TrimmedNonEmptyString),
  traceId: Schema.optional(TrimmedNonEmptyString),
});
export type RelayEnvironmentStatusResponse = typeof RelayEnvironmentStatusResponse.Type;

export const RelayCloudMintCredentialProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  cnf: Schema.Struct({
    jkt: TrimmedNonEmptyString,
  }),
  deviceId: Schema.optional(TrimmedNonEmptyString),
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:connect")),
});
export type RelayCloudMintCredentialProofPayload = typeof RelayCloudMintCredentialProofPayload.Type;

export const RelayCloudMintCredentialProof = TrimmedNonEmptyString;
export type RelayCloudMintCredentialProof = typeof RelayCloudMintCredentialProof.Type;

export const RelayCloudMintCredentialRequest = Schema.Struct({
  proof: RelayCloudMintCredentialProof,
});
export type RelayCloudMintCredentialRequest = typeof RelayCloudMintCredentialRequest.Type;

export const RelayCloudEnvironmentHealthProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:status")),
});
export type RelayCloudEnvironmentHealthProofPayload =
  typeof RelayCloudEnvironmentHealthProofPayload.Type;

export const RelayCloudEnvironmentHealthProof = TrimmedNonEmptyString;
export type RelayCloudEnvironmentHealthProof = typeof RelayCloudEnvironmentHealthProof.Type;

export const RelayCloudEnvironmentHealthRequest = Schema.Struct({
  proof: RelayCloudEnvironmentHealthProof,
});
export type RelayCloudEnvironmentHealthRequest = typeof RelayCloudEnvironmentHealthRequest.Type;

export const RelayEnvironmentHealthResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  requestNonce: TrimmedNonEmptyString,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponseProofPayload =
  typeof RelayEnvironmentHealthResponseProofPayload.Type;

export const RelayEnvironmentHealthResponse = Schema.Struct({
  environmentId: EnvironmentId,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponse = typeof RelayEnvironmentHealthResponse.Type;

export const RelayEnvironmentMintResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  requestNonce: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponseProofPayload =
  typeof RelayEnvironmentMintResponseProofPayload.Type;

export const RelayEnvironmentMintResponse = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponse = typeof RelayEnvironmentMintResponse.Type;

// ---------------------------------------------------------------------------
// Tenancy: organizations, members, invitations, repositories
//
// Clerk authenticates and nothing more. Membership, roles, and invitations are
// relay-owned, so `subject -> organization -> role` is a local query on every
// path — including ones that hold no user token at all.
// ---------------------------------------------------------------------------

export const RelayOrganizationId = TrimmedNonEmptyString.pipe(Schema.brand("RelayOrganizationId"));
export type RelayOrganizationId = typeof RelayOrganizationId.Type;

export const RelayRepositoryId = TrimmedNonEmptyString.pipe(Schema.brand("RelayRepositoryId"));
export type RelayRepositoryId = typeof RelayRepositoryId.Type;

export const RelayMachineId = TrimmedNonEmptyString.pipe(Schema.brand("RelayMachineId"));
export type RelayMachineId = typeof RelayMachineId.Type;

export const RelayInvitationId = TrimmedNonEmptyString.pipe(Schema.brand("RelayInvitationId"));
export type RelayInvitationId = typeof RelayInvitationId.Type;

/** A member's standing in an organization. Admins own members and repositories. */
export const RelayOrgRole = Schema.Literals(["member", "admin"]);
export type RelayOrgRole = typeof RelayOrgRole.Type;

/**
 * A member's standing on one repository. Maintainers configure it, developers
 * work in it, and having no role at all means having no access.
 */
export const RelayRepositoryRole = Schema.Literals(["maintainer", "developer"]);
export type RelayRepositoryRole = typeof RelayRepositoryRole.Type;

export const RELAY_ORGANIZATION_NAME_MAX_LENGTH = 128;
export const RELAY_CANONICAL_KEY_MAX_LENGTH = 512;
export const RELAY_EMAIL_MAX_LENGTH = 320;

export const RelayOrganizationName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(RELAY_ORGANIZATION_NAME_MAX_LENGTH),
);

/**
 * `host/owner/repo` exactly as `normalizeGitRemoteUrl` produces it: lowercased,
 * no scheme, no `.git`, no trailing slash. Anything else is a key the deriving
 * side would never generate, so it could never match a checkout.
 */
export const RelayRepositoryCanonicalKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(RELAY_CANONICAL_KEY_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9.-]+(?::\d+)?(?:\/[^\s/]+){2,}$/),
);

export const RelayEmailAddress = TrimmedNonEmptyString.check(
  Schema.isMaxLength(RELAY_EMAIL_MAX_LENGTH),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

export const RelayOrganization = Schema.Struct({
  organizationId: RelayOrganizationId,
  name: RelayOrganizationName,
  createdAt: TrimmedNonEmptyString,
});
export type RelayOrganization = typeof RelayOrganization.Type;

/** The caller's own standing: which organization they are in, and as what. */
export const RelayOrganizationMembership = Schema.Struct({
  organization: RelayOrganization,
  /** The subject the relay resolved the caller to; clients match it against the roster. */
  userId: TrimmedNonEmptyString,
  role: RelayOrgRole,
  joinedAt: TrimmedNonEmptyString,
});
export type RelayOrganizationMembership = typeof RelayOrganizationMembership.Type;

/**
 * Who a subject is, as far as the relay can tell. Resolved from the identity
 * provider on read and never stored: the relay owns tenancy, not people, and a
 * copied name goes stale the moment someone edits their profile. Null whenever
 * the lookup is unavailable — a roster that renders subject ids is worse than
 * a roster, but far better than an error.
 */
export const RelayUserIdentity = Schema.Struct({
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  email: Schema.NullOr(TrimmedNonEmptyString),
  imageUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type RelayUserIdentity = typeof RelayUserIdentity.Type;

export const RelayOrganizationMember = Schema.Struct({
  userId: TrimmedNonEmptyString,
  role: RelayOrgRole,
  joinedAt: TrimmedNonEmptyString,
  identity: Schema.NullOr(RelayUserIdentity),
});
export type RelayOrganizationMember = typeof RelayOrganizationMember.Type;

export const RelayListOrganizationMembersResponse = Schema.Struct({
  members: Schema.Array(RelayOrganizationMember),
});
export type RelayListOrganizationMembersResponse = typeof RelayListOrganizationMembersResponse.Type;

export const RelayRenameOrganizationRequest = Schema.Struct({
  name: RelayOrganizationName,
});
export type RelayRenameOrganizationRequest = typeof RelayRenameOrganizationRequest.Type;

export const RelayUpdateOrganizationMemberRequest = Schema.Struct({
  role: RelayOrgRole,
});
export type RelayUpdateOrganizationMemberRequest = typeof RelayUpdateOrganizationMemberRequest.Type;

export const RelayInvitation = Schema.Struct({
  invitationId: RelayInvitationId,
  email: RelayEmailAddress,
  role: RelayOrgRole,
  invitedByUserId: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayInvitation = typeof RelayInvitation.Type;

export const RelayListInvitationsResponse = Schema.Struct({
  invitations: Schema.Array(RelayInvitation),
});
export type RelayListInvitationsResponse = typeof RelayListInvitationsResponse.Type;

export const RelayCreateInvitationRequest = Schema.Struct({
  email: RelayEmailAddress,
  role: RelayOrgRole,
});
export type RelayCreateInvitationRequest = typeof RelayCreateInvitationRequest.Type;

/**
 * The token comes back exactly once, at creation. There is no transactional
 * email provider yet, so the admin delivers the link themselves; when one
 * exists this field is what it sends, and nothing else about the flow changes.
 */
export const RelayCreateInvitationResponse = Schema.Struct({
  invitation: RelayInvitation,
  token: TrimmedNonEmptyString,
});
export type RelayCreateInvitationResponse = typeof RelayCreateInvitationResponse.Type;

export const RelayAcceptInvitationRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export type RelayAcceptInvitationRequest = typeof RelayAcceptInvitationRequest.Type;

export const RelayRepository = Schema.Struct({
  repositoryId: RelayRepositoryId,
  organizationId: RelayOrganizationId,
  name: TrimmedNonEmptyString,
  /** Every key this repository answers to; mirrors and forks add to it (ADR-0006). */
  canonicalKeys: Schema.Array(RelayRepositoryCanonicalKey),
  createdAt: TrimmedNonEmptyString,
});
export type RelayRepository = typeof RelayRepository.Type;

/** A repository plus the caller's own role on it; `null` for an admin with no grant. */
export const RelayRepositorySummary = Schema.Struct({
  repository: RelayRepository,
  role: Schema.NullOr(RelayRepositoryRole),
});
export type RelayRepositorySummary = typeof RelayRepositorySummary.Type;

export const RelayListRepositoriesResponse = Schema.Struct({
  repositories: Schema.Array(RelayRepositorySummary),
});
export type RelayListRepositoriesResponse = typeof RelayListRepositoriesResponse.Type;

/**
 * The non-sensitive part of one environment-local project that an organization
 * may retain while the machine is offline. Workspace paths and thread content
 * deliberately never enter this catalog.
 */
export const RelayProjectCatalogEntry = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  repositoryCanonicalKey: Schema.NullOr(RelayRepositoryCanonicalKey),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type RelayProjectCatalogEntry = typeof RelayProjectCatalogEntry.Type;

export const RelayProjectCatalogRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RelayProjectCatalogPublishProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  revision: RelayProjectCatalogRevision,
  projects: Schema.Array(RelayProjectCatalogEntry),
});
export type RelayProjectCatalogPublishProofPayload =
  typeof RelayProjectCatalogPublishProofPayload.Type;

export const RelayProjectCatalogPublishRequest = Schema.Struct({
  revision: RelayProjectCatalogRevision,
  projects: Schema.Array(RelayProjectCatalogEntry),
  proof: TrimmedNonEmptyString.annotate({
    description: "Environment-signed JWT covering this redacted project catalog snapshot.",
  }),
});
export type RelayProjectCatalogPublishRequest = typeof RelayProjectCatalogPublishRequest.Type;

export const RelayOrganizationProject = Schema.Struct({
  environmentId: EnvironmentId,
  machineId: RelayMachineId,
  machineLabel: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  repositoryCanonicalKey: Schema.NullOr(RelayRepositoryCanonicalKey),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  catalogUpdatedAt: TrimmedNonEmptyString,
});
export type RelayOrganizationProject = typeof RelayOrganizationProject.Type;

export const RelayListOrganizationProjectsResponse = Schema.Struct({
  projects: Schema.Array(RelayOrganizationProject),
});
export type RelayListOrganizationProjectsResponse =
  typeof RelayListOrganizationProjectsResponse.Type;

export const RelayProjectCatalogPublishResponse = Schema.Struct({
  ok: Schema.Boolean,
  acceptedRevision: RelayProjectCatalogRevision,
});
export type RelayProjectCatalogPublishResponse = typeof RelayProjectCatalogPublishResponse.Type;

export const RelayRegisterRepositoryRequest = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(RELAY_ORGANIZATION_NAME_MAX_LENGTH)),
  canonicalKey: RelayRepositoryCanonicalKey,
});
export type RelayRegisterRepositoryRequest = typeof RelayRegisterRepositoryRequest.Type;

export const RelayAddRepositoryAliasRequest = Schema.Struct({
  canonicalKey: RelayRepositoryCanonicalKey,
});
export type RelayAddRepositoryAliasRequest = typeof RelayAddRepositoryAliasRequest.Type;

/**
 * What a checkout gets back when it asks who owns its remote. A miss is a
 * normal answer, not an error: on a personal machine an unregistered checkout
 * simply is not org-governed (ADR-0006).
 */
export const RelayLookupRepositoryResponse = Schema.Struct({
  match: Schema.NullOr(RelayRepositorySummary),
});
export type RelayLookupRepositoryResponse = typeof RelayLookupRepositoryResponse.Type;

export const RelayRepositoryAccessEntry = Schema.Struct({
  userId: TrimmedNonEmptyString,
  role: RelayRepositoryRole,
  grantedAt: TrimmedNonEmptyString,
  identity: Schema.NullOr(RelayUserIdentity),
});
export type RelayRepositoryAccessEntry = typeof RelayRepositoryAccessEntry.Type;

export const RelayListRepositoryAccessResponse = Schema.Struct({
  access: Schema.Array(RelayRepositoryAccessEntry),
});
export type RelayListRepositoryAccessResponse = typeof RelayListRepositoryAccessResponse.Type;

export const RelayGrantRepositoryAccessRequest = Schema.Struct({
  userId: TrimmedNonEmptyString,
  role: RelayRepositoryRole,
});
export type RelayGrantRepositoryAccessRequest = typeof RelayGrantRepositoryAccessRequest.Type;

// ---------------------------------------------------------------------------
// GitHub connection
//
// An organization connects GitHub by installing the relay's GitHub App. What
// is recorded is the installation id — not a secret — so access tokens can be
// minted per request and never persisted.
// ---------------------------------------------------------------------------

export const RelayGithubConnection = Schema.Struct({
  installationId: TrimmedNonEmptyString,
  /** The GitHub organization or user the App is installed on. */
  accountLogin: TrimmedNonEmptyString,
  accountType: TrimmedNonEmptyString,
  connectedByUserId: TrimmedNonEmptyString,
  connectedAt: TrimmedNonEmptyString,
});
export type RelayGithubConnection = typeof RelayGithubConnection.Type;

export const RelayGithubConnectionResponse = Schema.Struct({
  /** Null when this relay has no GitHub App; the surface hides itself. */
  installUrl: Schema.NullOr(TrimmedNonEmptyString),
  connection: Schema.NullOr(RelayGithubConnection),
});
export type RelayGithubConnectionResponse = typeof RelayGithubConnectionResponse.Type;

export const RelayConnectGithubRequest = Schema.Struct({
  /** Handed back by GitHub on the App's setup redirect. */
  installationId: TrimmedNonEmptyString,
});
export type RelayConnectGithubRequest = typeof RelayConnectGithubRequest.Type;

export const RelayGithubRepository = Schema.Struct({
  fullName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  defaultBranch: TrimmedNonEmptyString,
  isPrivate: Schema.Boolean,
  canonicalKey: RelayRepositoryCanonicalKey,
  /** True when this organization already registered the key. */
  registered: Schema.Boolean,
});
export type RelayGithubRepository = typeof RelayGithubRepository.Type;

export const RelayListGithubRepositoriesResponse = Schema.Struct({
  repositories: Schema.Array(RelayGithubRepository),
});
export type RelayListGithubRepositoriesResponse = typeof RelayListGithubRepositoriesResponse.Type;

// ---------------------------------------------------------------------------
// Machines
//
// A machine is compute the relay provisions for exactly one organization
// (ADR-0002): an agent executor or a review host — roles, not machine kinds
// (ADR-0010). A machine proves it is the one the relay just created with a
// per-instance seeded credential, exchanged once for a durable environment
// credential. Enrollment is a second, parallel trust path beside the
// human-driven link flow, never a replacement for it.
// ---------------------------------------------------------------------------

/** What a provisioned machine is for. One provisioning path, one enrollment story, two roles. */
export const RelayMachineRole = Schema.Literals(["agent_executor", "review_host"]);
export type RelayMachineRole = typeof RelayMachineRole.Type;

/**
 * Which compute driver created the machine: a Docker container in dev, a
 * Hetzner Cloud server in production. `self_hosted` means no driver at all —
 * the organization runs its own compute and the admin delivers the enrollment
 * seed by hand (ADR-0002's self-hosted case).
 */
export const RelayMachineComputeKind = Schema.Literals(["docker", "hetzner", "self_hosted"]);
export type RelayMachineComputeKind = typeof RelayMachineComputeKind.Type;

/**
 * Derived, not stored: deprovisioned when tombstoned, ready once enrolled,
 * awaiting enrollment from creation until the machine calls home.
 */
export const RelayMachineStatus = Schema.Literals([
  "awaiting_enrollment",
  "ready",
  "deprovisioned",
]);
export type RelayMachineStatus = typeof RelayMachineStatus.Type;

export const RELAY_MACHINE_LABEL_MAX_LENGTH = 128;

export const RelayMachineLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(RELAY_MACHINE_LABEL_MAX_LENGTH),
);

export const RelayMachine = Schema.Struct({
  machineId: RelayMachineId,
  organizationId: RelayOrganizationId,
  role: RelayMachineRole,
  label: RelayMachineLabel,
  status: RelayMachineStatus,
  computeKind: RelayMachineComputeKind,
  /** Set at enrollment; null while the machine has not called home. */
  environmentId: Schema.NullOr(EnvironmentId),
  endpoint: Schema.NullOr(RelayManagedEndpoint),
  createdByUserId: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  enrolledAt: Schema.NullOr(TrimmedNonEmptyString),
  /** After this instant an unenrolled machine can only be deprovisioned and recreated. */
  seedExpiresAt: TrimmedNonEmptyString,
  deprovisionedAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type RelayMachine = typeof RelayMachine.Type;

export const RelayListMachinesResponse = Schema.Struct({
  machines: Schema.Array(RelayMachine),
});
export type RelayListMachinesResponse = typeof RelayListMachinesResponse.Type;

export const RelayProvisionMachineRequest = Schema.Struct({
  label: RelayMachineLabel,
  role: RelayMachineRole,
});
export type RelayProvisionMachineRequest = typeof RelayProvisionMachineRequest.Type;

/**
 * Returns the enrollment seed exactly once, like an invitation token: the
 * relay keeps only its hash, and with no compute driver to inject it, the
 * admin carries the seed to the machine themselves.
 */
export const RelayConnectMachineResponse = Schema.Struct({
  machine: RelayMachine,
  seed: TrimmedNonEmptyString,
  /** Where the machine enrolls: the relay's own normalized origin. */
  relayUrl: TrimmedNonEmptyString,
});
export type RelayConnectMachineResponse = typeof RelayConnectMachineResponse.Type;

/**
 * Signed by the machine's own freshly generated environment key. The seed
 * authenticates the machine to the relay; the signature binds the registered
 * public key to whoever holds the seed, so the response's credential can only
 * be used by the key pair that enrolled.
 */
export const RelayMachineEnrollProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  seed: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
});
export type RelayMachineEnrollProofPayload = typeof RelayMachineEnrollProofPayload.Type;

export const RelayMachineEnrollRequest = Schema.Struct({
  proof: TrimmedNonEmptyString.annotate({
    description: "Machine-signed JWT carrying the per-instance enrollment seed.",
  }),
}).annotate({
  description:
    "Exchanges a provisioned machine's single-use seed for a durable environment credential.",
});
export type RelayMachineEnrollRequest = typeof RelayMachineEnrollRequest.Type;

export const RelayMachineEnrollResponse = Schema.Struct({
  ok: Schema.Boolean,
  machineId: RelayMachineId,
  organizationId: RelayOrganizationId,
  role: RelayMachineRole,
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  relayIssuer: TrimmedNonEmptyString,
  environmentCredential: TrimmedNonEmptyString,
  cloudMintPublicKey: TrimmedNonEmptyString,
});
export type RelayMachineEnrollResponse = typeof RelayMachineEnrollResponse.Type;

// ---------------------------------------------------------------------------
// Jobs
//
// The relay owns a job's coarse state and nothing finer (ADR-0005). What the
// agent actually did inside a thread is the environment's to answer; the relay
// records only which executor, which repository, and where the run got to.
// ---------------------------------------------------------------------------

export const RelayJobId = TrimmedNonEmptyString.pipe(Schema.brand("RelayJobId"));
export type RelayJobId = typeof RelayJobId.Type;

/**
 * The whole of the relay's job model. Deliberately coarse: if the relay ever
 * needs turn-level detail, the seam is being violated.
 */
export const RelayJobStatus = Schema.Literals([
  "queued",
  "dispatched",
  "running",
  "awaiting_review",
  "paused",
  "done",
  "failed",
]);
export type RelayJobStatus = typeof RelayJobStatus.Type;

export const RelayCreateJobRequest = Schema.Struct({
  environmentId: EnvironmentId,
  /** `host/owner/repo`, as `normalizeGitRemoteUrl` produces it. */
  repositoryCanonicalKey: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  /**
   * The instruction as it stood when the job was dispatched. Snapshotted by
   * the caller rather than referenced, so editing the source afterwards cannot
   * silently change what a running agent was told (ADR-0011).
   */
  instruction: TrimmedNonEmptyString,
});
export type RelayCreateJobRequest = typeof RelayCreateJobRequest.Type;

export const RelayJob = Schema.Struct({
  jobId: RelayJobId,
  status: RelayJobStatus,
  environmentId: EnvironmentId,
  repositoryCanonicalKey: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  /** Set once the executor has a thread; the relay never reads into it. */
  threadId: Schema.NullOr(ThreadId),
  detail: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type RelayJob = typeof RelayJob.Type;

/**
 * Relay → environment. Same proof-authenticated, bearer-free shape as
 * `mint-credential`: the relay signs, the environment verifies against the
 * relay issuer, and the response is signed back.
 */
export const RelayCloudDispatchJobProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  jobId: RelayJobId,
  repositoryCanonicalKey: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
});
export type RelayCloudDispatchJobProofPayload = typeof RelayCloudDispatchJobProofPayload.Type;

export const RelayCloudDispatchJobRequest = Schema.Struct({
  proof: TrimmedNonEmptyString,
});
export type RelayCloudDispatchJobRequest = typeof RelayCloudDispatchJobRequest.Type;

export const RelayEnvironmentDispatchJobResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  jobId: RelayJobId,
  accepted: Schema.Boolean,
});
export type RelayEnvironmentDispatchJobResponseProofPayload =
  typeof RelayEnvironmentDispatchJobResponseProofPayload.Type;

/**
 * The environment answers as soon as it has accepted the job, not when the job
 * finishes: a run takes minutes and the relay's request deadline is seconds.
 */
export const RelayEnvironmentDispatchJobResponse = Schema.Struct({
  accepted: Schema.Boolean,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentDispatchJobResponse = typeof RelayEnvironmentDispatchJobResponse.Type;

export const RelayDeliveryKind = Schema.Literals([
  "live_activity_start",
  "live_activity_update",
  "live_activity_end",
  "push_notification",
]);
export type RelayDeliveryKind = typeof RelayDeliveryKind.Type;

export const RelayDeliveryResult = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  kind: RelayDeliveryKind,
  ok: Schema.Boolean,
  queued: Schema.optional(Schema.Boolean),
  apnsStatus: Schema.NullOr(Schema.Number),
  apnsReason: Schema.NullOr(Schema.String),
  apnsId: Schema.NullOr(Schema.String),
});
export type RelayDeliveryResult = typeof RelayDeliveryResult.Type;

export const RelayOkResponse = Schema.Struct({
  ok: Schema.Boolean,
});
export type RelayOkResponse = typeof RelayOkResponse.Type;

export const RelayPublishResponse = Schema.Struct({
  ok: Schema.Boolean,
  deliveries: Schema.Array(RelayDeliveryResult),
});
export type RelayPublishResponse = typeof RelayPublishResponse.Type;

export const RelayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("relay"),
});
export type RelayHealthResponse = typeof RelayHealthResponse.Type;

export const RelayHealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: RelayHealthResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Check relay health"),
  )
  .annotate(OpenApi.Description, "Service health and readiness.");

export const RelayMetadataGroup = HttpApiGroup.make("metadata")
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: RelayAuthorizationServerMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth authorization-server metadata"),
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: RelayProtectedResourceMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth protected-resource metadata"),
  )
  .annotate(OpenApi.Description, "OAuth and DPoP discovery metadata.");

export const RelayRegisterDeviceEndpoint = HttpApiEndpoint.post(
  "registerDevice",
  "/v1/mobile/devices",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayDeviceRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register or update a mobile device");

export const RelayRegisterLiveActivityEndpoint = HttpApiEndpoint.post(
  "registerLiveActivity",
  "/v1/mobile/live-activities",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayLiveActivityRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register a Live Activity push token");

export const RelayAgentActivitySnapshotResponse = Schema.Struct({
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
});
export type RelayAgentActivitySnapshotResponse = typeof RelayAgentActivitySnapshotResponse.Type;

// Lets the app decide whether arming a Live Activity is worthwhile before
// creating one (no empty lock-screen card when nothing is running) and seed
// the card with the real aggregate instead of a placeholder.
export const RelayAgentActivitySnapshotEndpoint = HttpApiEndpoint.get(
  "getAgentActivitySnapshot",
  "/v1/mobile/agent-activity",
  {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentActivitySnapshotResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Read the current Live Activity aggregate");

export const RelayUnregisterDeviceEndpoint = HttpApiEndpoint.delete(
  "unregisterDevice",
  "/v1/mobile/devices/:deviceId",
  {
    headers: RelayDpopRequestHeaders,
    params: RelayDeviceUnregistrationParams,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Unregister a mobile device");

export const RelayMobileGroup = HttpApiGroup.make("mobile")
  .add(
    RelayRegisterDeviceEndpoint,
    RelayRegisterLiveActivityEndpoint,
    RelayAgentActivitySnapshotEndpoint,
    RelayUnregisterDeviceEndpoint,
  )
  .annotate(OpenApi.Description, "Mobile push-notification and Live Activity registration.")
  .middleware(RelayDpopClientAuth);

export const RelayClientGroup = HttpApiGroup.make("client")
  .add(
    HttpApiEndpoint.get("listEnvironments", "/v1/environments", {
      headers: RelayBearerRequestHeaders,
      success: RelayListEnvironmentsResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List linked environments"),
    HttpApiEndpoint.get("listDevices", "/v1/client/devices", {
      headers: RelayBearerRequestHeaders,
      success: RelayListDevicesResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List registered mobile devices"),
    HttpApiEndpoint.post("linkEnvironment", "/v1/client/environment-links", {
      headers: RelayBearerRequestHeaders,
      payload: RelayEnvironmentLinkRequest,
      success: RelayEnvironmentLinkResponse,
      error: RelayEnvironmentLinkErrors,
    }).annotate(OpenApi.Summary, "Link an environment"),
    HttpApiEndpoint.post(
      "createEnvironmentLinkChallenge",
      "/v1/client/environment-link-challenges",
      {
        headers: RelayBearerRequestHeaders,
        payload: RelayEnvironmentLinkChallengeRequest,
        success: RelayEnvironmentLinkChallengeResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Create an environment-link challenge"),
    HttpApiEndpoint.delete("unlinkEnvironment", "/v1/client/environment-links/:environmentId", {
      headers: RelayBearerRequestHeaders,
      params: RelayEnvironmentUnlinkParams,
      success: RelayOkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Unlink an environment"),
    HttpApiEndpoint.delete(
      "releaseEnvironmentTunnel",
      "/v1/client/environment-links/:environmentId/tunnel",
      {
        headers: RelayBearerRequestHeaders,
        params: RelayEnvironmentUnlinkParams,
        success: RelayOkResponse,
        error: RelayAuthAndInternalErrors,
      },
    )
      .annotate(OpenApi.Summary, "Release an environment's managed tunnel")
      .annotate(
        OpenApi.Description,
        "Deletes the provisioned Cloudflare tunnel while keeping the environment link and its hostname reservation, so a later link re-provisions the tunnel under the same URL. Environments call this when they shut down; Cloudflare bills per provisioned tunnel, so idle tunnels should not outlive their environment.",
      ),
  )
  .annotate(OpenApi.Description, "Cloud-user environment links and registered devices.")
  .middleware(RelayClientAuth);

export const RelayExchangeDpopAccessTokenEndpoint = HttpApiEndpoint.post(
  "exchangeDpopAccessToken",
  "/v1/client/dpop-token",
  {
    headers: RelayDpopProofRequestHeaders,
    payload: RelayDpopAccessTokenRequest,
    success: RelayDpopAccessTokenResponse,
    error: RelayAuthAndInternalErrors,
  },
)
  .annotate(OpenApi.Summary, "Exchange a Clerk token for a DPoP access token")
  .annotate(
    OpenApi.Description,
    "Bootstrap endpoint. Send the DPoP proof JWT in the dpop header and the Clerk token in subject_token. The returned access token is bound to the proof key.",
  );

export const RelayTokenGroup = HttpApiGroup.make("token")
  .add(RelayExchangeDpopAccessTokenEndpoint)
  .annotate(OpenApi.Description, "OAuth token exchange for DPoP-bound client access.");

export const RelayConnectEnvironmentEndpoint = HttpApiEndpoint.post(
  "connectEnvironment",
  "/v1/environments/:environmentId/connect",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    payload: RelayEnvironmentConnectRequest,
    success: RelayEnvironmentConnectResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Connect to an environment");

export const RelayGetEnvironmentStatusEndpoint = HttpApiEndpoint.post(
  "getEnvironmentStatus",
  "/v1/environments/:environmentId/status",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    success: RelayEnvironmentStatusResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Check environment status");

const RelayJobErrors = [
  RelayAuthInvalidError,
  // A dispatch against a registered repository the caller has no role on.
  RelayTenancyForbiddenError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayInternalError,
] as const;

const RelayCreateJobEndpoint = HttpApiEndpoint.post("createJob", "/v1/jobs", {
  headers: RelayDpopRequestHeaders,
  payload: RelayCreateJobRequest,
  success: RelayJob,
  error: RelayJobErrors,
}).annotate(OpenApi.Summary, "Dispatch a job to an executor");

const RelayGetJobEndpoint = HttpApiEndpoint.get("getJob", "/v1/jobs/:jobId", {
  headers: RelayDpopRequestHeaders,
  params: Schema.Struct({ jobId: RelayJobId }),
  success: RelayJob,
  error: RelayJobErrors,
}).annotate(OpenApi.Summary, "Read a job's coarse state");

/**
 * Its own group rather than an addition to `dpopClient`, because auth is
 * declared per group and jobs need their own scope.
 */
export const RelayJobsGroup = HttpApiGroup.make("jobs")
  .add(RelayCreateJobEndpoint, RelayGetJobEndpoint)
  .annotate(OpenApi.Description, "Dispatching jobs to executors and reading their coarse state.")
  .middleware(RelayDpopClientAuth);

const RelayTenancyErrors = [
  RelayAuthInvalidError,
  RelayTenancyForbiddenError,
  RelayTenancyNotFoundError,
  RelayTenancyConflictError,
  RelayInternalError,
] as const;

const RelayOrganizationMemberParams = Schema.Struct({
  userId: TrimmedNonEmptyString,
});

const RelayRepositoryParams = Schema.Struct({
  repositoryId: RelayRepositoryId,
});

/**
 * Organizations, membership, and invitations. Everything here is relay-owned:
 * Clerk says who the caller is and this group decides what that means.
 */
export const RelayOrganizationGroup = HttpApiGroup.make("organization")
  .add(
    HttpApiEndpoint.get("getOrganization", "/v1/organization", {
      headers: RelayBearerRequestHeaders,
      success: RelayOrganizationMembership,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Read the caller's organization and role")
      .annotate(
        OpenApi.Description,
        "Creates the caller's organization on first sight. Signup is Clerk's event, not the relay's, so the first authorized request is where an organization comes into being.",
      ),
    HttpApiEndpoint.post("renameOrganization", "/v1/organization/name", {
      headers: RelayBearerRequestHeaders,
      payload: RelayRenameOrganizationRequest,
      success: RelayOrganization,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Rename the organization"),
    HttpApiEndpoint.get("listOrganizationMembers", "/v1/organization/members", {
      headers: RelayBearerRequestHeaders,
      success: RelayListOrganizationMembersResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "List organization members"),
    HttpApiEndpoint.post("updateOrganizationMember", "/v1/organization/members/:userId/role", {
      headers: RelayBearerRequestHeaders,
      params: RelayOrganizationMemberParams,
      payload: RelayUpdateOrganizationMemberRequest,
      success: RelayOrganizationMember,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Change a member's organization role"),
    HttpApiEndpoint.delete("removeOrganizationMember", "/v1/organization/members/:userId", {
      headers: RelayBearerRequestHeaders,
      params: RelayOrganizationMemberParams,
      success: RelayOkResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Remove a member from the organization")
      .annotate(
        OpenApi.Description,
        "The removed member keeps their account and lands in a fresh organization of their own on their next request.",
      ),
    HttpApiEndpoint.get("listInvitations", "/v1/organization/invitations", {
      headers: RelayBearerRequestHeaders,
      success: RelayListInvitationsResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "List pending invitations"),
    HttpApiEndpoint.post("createInvitation", "/v1/organization/invitations", {
      headers: RelayBearerRequestHeaders,
      payload: RelayCreateInvitationRequest,
      success: RelayCreateInvitationResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Invite someone to the organization")
      .annotate(
        OpenApi.Description,
        "Returns the invitation token exactly once. There is no transactional email provider yet, so whoever invites delivers the link.",
      ),
    HttpApiEndpoint.delete("revokeInvitation", "/v1/organization/invitations/:invitationId", {
      headers: RelayBearerRequestHeaders,
      params: Schema.Struct({ invitationId: RelayInvitationId }),
      success: RelayOkResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Revoke a pending invitation"),
    HttpApiEndpoint.get("getGithubConnection", "/v1/organization/github", {
      headers: RelayBearerRequestHeaders,
      success: RelayGithubConnectionResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Read the organization's GitHub connection"),
    HttpApiEndpoint.post("connectGithub", "/v1/organization/github", {
      headers: RelayBearerRequestHeaders,
      payload: RelayConnectGithubRequest,
      success: RelayGithubConnection,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Claim a GitHub App installation")
      .annotate(
        OpenApi.Description,
        "Called after GitHub redirects back from installing the App. The relay verifies the installation exists before recording its id; no GitHub credential is stored.",
      ),
    HttpApiEndpoint.delete("disconnectGithub", "/v1/organization/github", {
      headers: RelayBearerRequestHeaders,
      success: RelayOkResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Disconnect GitHub")
      .annotate(
        OpenApi.Description,
        "Forgets the installation. Uninstalling the App itself is done on GitHub.",
      ),
    HttpApiEndpoint.get("listGithubRepositories", "/v1/organization/github/repositories", {
      headers: RelayBearerRequestHeaders,
      success: RelayListGithubRepositoriesResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "List repositories the installation can see"),
    HttpApiEndpoint.post("acceptInvitation", "/v1/invitations/accept", {
      headers: RelayBearerRequestHeaders,
      payload: RelayAcceptInvitationRequest,
      success: RelayOrganizationMembership,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Accept an invitation")
      .annotate(
        OpenApi.Description,
        "Moves the caller into the inviting organization. Refused while their current organization still holds other members or repositories, because accepting would abandon them.",
      ),
  )
  .annotate(OpenApi.Description, "Relay-owned organizations, membership, and invitations.")
  .middleware(RelayClientAuth);

export const RelayRepositoriesGroup = HttpApiGroup.make("repositories")
  .add(
    HttpApiEndpoint.get("listRepositories", "/v1/repositories", {
      headers: RelayBearerRequestHeaders,
      success: RelayListRepositoriesResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "List the organization's repositories")
      .annotate(
        OpenApi.Description,
        "Admins see every repository in the organization; members see the ones they hold a repository role on.",
      ),
    HttpApiEndpoint.post("registerRepository", "/v1/repositories", {
      headers: RelayBearerRequestHeaders,
      payload: RelayRegisterRepositoryRequest,
      success: RelayRepository,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Register a repository from a checkout"),
    // A POST for a read: a canonical key contains slashes, and this stack has
    // no query-parameter declaration, so the key travels in the body rather
    // than being escaped into a path segment.
    HttpApiEndpoint.post("lookupRepository", "/v1/repositories/lookup", {
      headers: RelayBearerRequestHeaders,
      payload: RelayAddRepositoryAliasRequest,
      success: RelayLookupRepositoryResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Resolve a checkout's canonical key")
      .annotate(
        OpenApi.Description,
        "A miss is a normal answer: on a personal machine an unregistered checkout is simply not governed by the organization.",
      ),
    HttpApiEndpoint.delete("deleteRepository", "/v1/repositories/:repositoryId", {
      headers: RelayBearerRequestHeaders,
      params: RelayRepositoryParams,
      success: RelayOkResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Remove a repository and its keys"),
    HttpApiEndpoint.post("addRepositoryAlias", "/v1/repositories/:repositoryId/aliases", {
      headers: RelayBearerRequestHeaders,
      params: RelayRepositoryParams,
      payload: RelayAddRepositoryAliasRequest,
      success: RelayRepository,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Add a canonical key to a repository")
      .annotate(
        OpenApi.Description,
        "How a mirror or a fork is bound to the repository it belongs to instead of becoming a second one.",
      ),
    HttpApiEndpoint.post("removeRepositoryAlias", "/v1/repositories/:repositoryId/aliases/remove", {
      headers: RelayBearerRequestHeaders,
      params: RelayRepositoryParams,
      payload: RelayAddRepositoryAliasRequest,
      success: RelayRepository,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Remove a canonical key from a repository"),
    HttpApiEndpoint.get("listRepositoryAccess", "/v1/repositories/:repositoryId/access", {
      headers: RelayBearerRequestHeaders,
      params: RelayRepositoryParams,
      success: RelayListRepositoryAccessResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "List who can work in a repository"),
    HttpApiEndpoint.post("grantRepositoryAccess", "/v1/repositories/:repositoryId/access", {
      headers: RelayBearerRequestHeaders,
      params: RelayRepositoryParams,
      payload: RelayGrantRepositoryAccessRequest,
      success: RelayRepositoryAccessEntry,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "Grant or change repository access"),
    HttpApiEndpoint.delete(
      "revokeRepositoryAccess",
      "/v1/repositories/:repositoryId/access/:userId",
      {
        headers: RelayBearerRequestHeaders,
        params: Schema.Struct({
          repositoryId: RelayRepositoryId,
          userId: TrimmedNonEmptyString,
        }),
        success: RelayOkResponse,
        error: RelayTenancyErrors,
      },
    ).annotate(OpenApi.Summary, "Revoke repository access"),
  )
  .annotate(OpenApi.Description, "Repositories, their canonical keys, and who may work in them.")
  .middleware(RelayClientAuth);

/**
 * Read-only organization project discovery. The authoritative project remains
 * on its environment; this redacted relay projection keeps it discoverable
 * while that environment is offline.
 */
export const RelayOrganizationProjectsGroup = HttpApiGroup.make("organizationProjects")
  .add(
    HttpApiEndpoint.get("listOrganizationProjects", "/v1/organization/projects", {
      headers: RelayBearerRequestHeaders,
      success: RelayListOrganizationProjectsResponse,
      error: RelayTenancyErrors,
    }).annotate(OpenApi.Summary, "List projects visible to the organization member"),
  )
  .annotate(OpenApi.Description, "Redacted organization project discovery across machines.")
  .middleware(RelayClientAuth);

const RelayMachineParams = Schema.Struct({
  machineId: RelayMachineId,
});

/**
 * Machines the organization owns: agent executors and review hosts. Admin
 * surface — provisioning buys compute and deprovisioning destroys it, so both
 * require the organization role that owns quota and billing.
 */
export const RelayMachinesGroup = HttpApiGroup.make("machines")
  .add(
    HttpApiEndpoint.get("listMachines", "/v1/machines", {
      headers: RelayBearerRequestHeaders,
      success: RelayListMachinesResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "List the organization's machines")
      .annotate(
        OpenApi.Description,
        "Every machine the organization owns, including ones still waiting to enroll and deprovisioned tombstones.",
      ),
    HttpApiEndpoint.post("provisionMachine", "/v1/machines", {
      headers: RelayBearerRequestHeaders,
      payload: RelayProvisionMachineRequest,
      success: RelayMachine,
      error: [...RelayTenancyErrors, RelayMachineComputeUnavailableError],
    })
      .annotate(OpenApi.Summary, "Provision a machine")
      .annotate(
        OpenApi.Description,
        "Creates the machine record, seeds a single-use enrollment credential into fresh compute, and returns immediately; the machine appears as ready once it enrolls itself.",
      ),
    HttpApiEndpoint.post("connectMachine", "/v1/machines/self-hosted", {
      headers: RelayBearerRequestHeaders,
      payload: RelayProvisionMachineRequest,
      success: RelayConnectMachineResponse,
      error: RelayTenancyErrors,
    })
      .annotate(OpenApi.Summary, "Connect a self-hosted machine")
      .annotate(
        OpenApi.Description,
        "Creates the machine record and returns the enrollment seed exactly once. The organization boots its own compute with the seed; the machine appears as ready once it enrolls itself.",
      ),
    HttpApiEndpoint.delete("deprovisionMachine", "/v1/machines/:machineId", {
      headers: RelayBearerRequestHeaders,
      params: RelayMachineParams,
      success: RelayOkResponse,
      error: [...RelayTenancyErrors, RelayMachineComputeUnavailableError],
    })
      .annotate(OpenApi.Summary, "Deprovision a machine")
      .annotate(
        OpenApi.Description,
        "Revokes the machine's credentials, releases its managed endpoint, and destroys its compute. Until the event mirror exists, thread history held on the machine is destroyed with it.",
      ),
  )
  .annotate(
    OpenApi.Description,
    "Organization machines — agent executors and review hosts — provisioned by the relay or self-hosted.",
  )
  .middleware(RelayClientAuth);

const RelayMachineEnrollErrors = [
  RelayMachineEnrollProofInvalidError,
  RelayMachineEnrollFailedError,
  RelayMachineEnrollUnavailableError,
  RelayInternalError,
] as const;

/**
 * Deliberately unauthenticated as a group: the caller is a machine that owns
 * nothing but its seed, and the seed is the credential (ADR-0002). While the
 * relay runs on Cloudflare Workers this endpoint cannot be network-restricted;
 * the single-use, expiring seed plus the machine-signed proof is the control.
 */
export const RelayMachineEnrollmentGroup = HttpApiGroup.make("machineEnrollment")
  .add(
    HttpApiEndpoint.post("enrollMachine", "/v1/machines/enroll", {
      payload: RelayMachineEnrollRequest,
      success: RelayMachineEnrollResponse,
      error: RelayMachineEnrollErrors,
    })
      .annotate(OpenApi.Summary, "Enroll a provisioned machine")
      .annotate(
        OpenApi.Description,
        "A freshly provisioned machine presents its seeded credential exactly once and receives its durable environment credential and managed endpoint.",
      ),
  )
  .annotate(OpenApi.Description, "Seeded enrollment for relay-provisioned machines.");

export const RelayDpopClientGroup = HttpApiGroup.make("dpopClient")
  .add(RelayConnectEnvironmentEndpoint, RelayGetEnvironmentStatusEndpoint)
  .annotate(OpenApi.Description, "DPoP-authenticated client access to linked environments.")
  .middleware(RelayDpopClientAuth);

export const RelayServerGroup = HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.post(
      "publishAgentActivity",
      "/v1/environments/:environmentId/threads/:threadId/agent-activity",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
          threadId: ThreadId,
        }),
        payload: RelayAgentActivityPublishRequest,
        success: RelayPublishResponse,
        error: RelayAgentActivityPublishErrors,
      },
    ).annotate(OpenApi.Summary, "Publish agent activity"),
  )
  .annotate(OpenApi.Description, "Environment-authenticated activity publication.")
  .middleware(RelayEnvironmentAuth);

export const RelayProjectCatalogServerGroup = HttpApiGroup.make("projectCatalogServer")
  .add(
    HttpApiEndpoint.post(
      "publishProjectCatalog",
      "/v1/environments/:environmentId/project-catalog",
      {
        params: Schema.Struct({ environmentId: EnvironmentId }),
        payload: RelayProjectCatalogPublishRequest,
        success: RelayProjectCatalogPublishResponse,
        error: RelayProjectCatalogPublishErrors,
      },
    ).annotate(OpenApi.Summary, "Publish a managed environment's project catalog"),
  )
  .annotate(OpenApi.Description, "Environment-authenticated project catalog publication.")
  .middleware(RelayEnvironmentAuth);

export const RelayApi = HttpApi.make("RelayApi")
  .add(
    RelayHealthGroup,
    RelayMetadataGroup,
    RelayMobileGroup,
    RelayClientGroup,
    RelayOrganizationGroup,
    RelayRepositoriesGroup,
    RelayOrganizationProjectsGroup,
    RelayMachinesGroup,
    RelayMachineEnrollmentGroup,
    RelayTokenGroup,
    RelayDpopClientGroup,
    RelayJobsGroup,
    RelayServerGroup,
    RelayProjectCatalogServerGroup,
  )
  .annotate(OpenApi.Title, "Launchpad Relay API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(
    OpenApi.Description,
    "Control-plane API for linking Launchpad environments, connecting authorized clients, and publishing agent activity.",
  );
export type RelayApi = typeof RelayApi;
