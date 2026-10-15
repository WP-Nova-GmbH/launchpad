import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(191));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const WORKFLOW_LINEAR_CALLBACK_PATH = "/oauth/workflow-sources/linear/callback";
export const WorkflowSourceErrorCode = Schema.Literals([
  "not_configured",
  "conflict",
  "forbidden",
  "not_found",
  "invalid_input",
  "workspace_mismatch",
  "reconnect_required",
  "service_configuration",
  "refresh_in_progress",
  "rate_limited",
  "unavailable",
]);
export class WorkflowSourceError extends Schema.TaggedError<WorkflowSourceError>()(
  "WorkflowSourceError",
  {
    code: WorkflowSourceErrorCode,
    message: Schema.String,
    retryAt: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 400 },
) {}
export const WorkflowSourceHealth = Schema.Struct({
  code: Schema.Literals([
    "healthy",
    "reconnect_required",
    "service_configuration",
    "unavailable",
    "rate_limited",
  ]),
  retryAt: Schema.NullOr(Schema.Number),
});
export type WorkflowSourceHealth = typeof WorkflowSourceHealth.Type;
export const WorkflowSource = Schema.Struct({
  connectionId: Id,
  ownerUserId: Id,
  applicationId: Id,
  workspaceId: Id,
  workspaceName: Schema.String,
  viewerName: Schema.String,
  ownerLabel: Schema.optional(Schema.String),
  authorizationEpoch: Revision,
  status: Schema.Literals(["connected", "reconnect_required", "disconnected"]),
  health: WorkflowSourceHealth,
  delivery: Schema.Literal("unverified"),
});
export type WorkflowSource = typeof WorkflowSource.Type;
export const WorkflowSourceGrant = Schema.Struct({
  grantId: Id,
  connectionId: Id,
  organizationId: Id,
  repositoryId: Id,
  ownerUserId: Id,
  generation: Revision,
  revoked: Schema.Boolean,
});
export type WorkflowSourceGrant = typeof WorkflowSourceGrant.Type;
export const WorkflowSourceAttempt = Schema.Struct({
  attemptId: Id,
  connectionId: Schema.NullOr(Id),
  expiresAt: Schema.Number,
  status: Schema.Literals(["pending", "exchanging", "connected", "cancelled", "failed"]),
  error: Schema.NullOr(WorkflowSourceErrorCode),
});
export const WorkflowSourceOwner = Schema.Struct({
  configured: Schema.Boolean,
  applicationId: Schema.NullOr(Id),
  version: Revision,
  attempt: Schema.NullOr(WorkflowSourceAttempt),
  connections: Schema.Array(WorkflowSource),
  repositories: Schema.Array(
    Schema.Struct({ repositoryId: Id, organizationId: Id, name: Schema.String }),
  ),
  grants: Schema.Array(WorkflowSourceGrant),
});
export type WorkflowSourceOwner = typeof WorkflowSourceOwner.Type;
export const WorkflowRepositorySources = Schema.Struct({
  configured: Schema.Boolean,
  canManage: Schema.Boolean,
  sources: Schema.Array(Schema.Struct({ source: WorkflowSource, grant: WorkflowSourceGrant })),
  eligible: Schema.Array(
    Schema.Struct({ source: WorkflowSource, previousGrantId: Schema.NullOr(Id) }),
  ),
});
export type WorkflowRepositorySources = typeof WorkflowRepositorySources.Type;
export const BeginWorkflowSource = Schema.Struct({
  attemptId: Id,
  expectedVersion: Revision,
  connectionId: Schema.NullOr(Id),
});
export const WorkflowSourceAuthorization = Schema.Struct({
  authorizationUrl: Schema.NullOr(Schema.String),
  owner: WorkflowSourceOwner,
});
export const DisconnectWorkflowSource = Schema.Struct({
  connectionId: Id,
  expectedEpoch: Revision,
});
export const AllowWorkflowSource = Schema.Struct({
  connectionId: Id,
  grantId: Id,
  previousGrantId: Schema.NullOr(Id),
});
export const WorkflowSourceMetadataQuery = Schema.Struct({
  grantId: Id,
  kind: Schema.Literals(["teams", "states", "labels"]),
  teamId: Schema.optional(Id),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type WorkflowSourceMetadataQuery = typeof WorkflowSourceMetadataQuery.Type;
export const WorkflowSourceMetadataPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Id, name: Schema.String })),
  nextCursor: Schema.NullOr(Schema.String),
});
export type WorkflowSourceMetadataPage = typeof WorkflowSourceMetadataPage.Type;

export const WorkflowSourceHealthList = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      connectionId: Id,
      workspaceName: Schema.String,
      ownerUserId: Id,
      status: WorkflowSource.fields.status,
      health: WorkflowSourceHealth,
      delivery: Schema.Literal("unverified"),
    }),
  ),
});
export type WorkflowSourceHealthList = typeof WorkflowSourceHealthList.Type;
