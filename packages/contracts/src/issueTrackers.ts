import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RELAY_LINEAR_CALLBACK_PATH = "/v1/organization/issue-trackers/linear/callback";

export const RelayIssueTrackerService = Schema.Literals(["linear", "jira"]);
export type RelayIssueTrackerService = typeof RelayIssueTrackerService.Type;

export const RelayLinearAuthorization = Schema.Struct({
  id: Schema.String,
  phase: Schema.Literals(["pending", "exchanging"]),
  expiresAt: Schema.String,
});
export const RelayLinearReplacement = Schema.Struct({
  id: Schema.String,
  currentWorkspaceId: Schema.String,
  workspaceId: Schema.String,
  currentAccountLabel: Schema.String,
  accountLabel: Schema.String,
  expiresAt: Schema.String,
});
export const RelayLinearReplacementRequest = Schema.Struct({
  proposalId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type RelayLinearReplacementRequest = typeof RelayLinearReplacementRequest.Type;

export const RelayIssueTrackerConnection = Schema.Struct({
  service: RelayIssueTrackerService,
  status: Schema.Literals(["connecting", "connected", "reconnect_required"]),
  accountLabel: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  authorization: Schema.optionalKey(RelayLinearAuthorization),
  replacement: Schema.optionalKey(RelayLinearReplacement),
});
export type RelayIssueTrackerConnection = typeof RelayIssueTrackerConnection.Type;

export const RelayIssueTrackerConnections = Schema.Struct({
  connections: Schema.Array(RelayIssueTrackerConnection),
  linearAvailable: Schema.Boolean,
});
export type RelayIssueTrackerConnections = typeof RelayIssueTrackerConnections.Type;

export const RelayConnectJiraRequest = Schema.Struct({
  siteUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  issue: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
export type RelayConnectJiraRequest = typeof RelayConnectJiraRequest.Type;

export const RelayStartLinearResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  authorizationId: Schema.String,
  connection: RelayIssueTrackerConnection,
});
export type RelayStartLinearResponse = typeof RelayStartLinearResponse.Type;

export const RelayIssueDetails = Schema.Struct({
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.String,
  url: Schema.String,
  status: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.String),
});
export type RelayIssueDetails = typeof RelayIssueDetails.Type;

export const RelayReadIssueRequest = Schema.Struct({
  issue: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
});
const LinearReference = TrimmedNonEmptyString.check(Schema.isMaxLength(16_384));
export const RelayLinearImageReference = Schema.Struct({
  reference: LinearReference,
  url: Schema.String,
});
export const RelayLinearComment = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  body: Schema.String,
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  editedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
  bodyTruncated: Schema.Boolean,
  images: Schema.Array(RelayLinearImageReference),
  imagesTruncated: Schema.Boolean,
  imagesContinuation: Schema.NullOr(LinearReference),
});
export const RelayLinearDiscussion = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    comments: Schema.Array(RelayLinearComment),
    continuation: Schema.NullOr(LinearReference),
    hasMore: Schema.Boolean,
    contentTruncated: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type RelayLinearDiscussion = typeof RelayLinearDiscussion.Type;
export const RelayLinearContext = Schema.Struct({
  source: LinearReference,
  workspaceId: Schema.String,
  issueId: Schema.String,
  discussion: RelayLinearDiscussion,
  images: Schema.Array(RelayLinearImageReference),
  imagesTruncated: Schema.Boolean,
  imagesContinuation: Schema.NullOr(LinearReference),
});
export const RelayLinearReferenceRequest = Schema.Struct({ reference: LinearReference });
export type RelayLinearReferenceRequest = typeof RelayLinearReferenceRequest.Type;
export const RelayLinearCommentsResponse = Schema.Struct({
  service: Schema.Literal("linear"),
  accountLabel: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  ...RelayLinearContext.fields,
});
export const RelayLinearImagesResponse = Schema.Struct({
  service: Schema.Literal("linear"),
  accountLabel: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  workspaceId: Schema.String,
  issueId: Schema.String,
  images: Schema.Array(RelayLinearImageReference),
  imagesTruncated: Schema.Boolean,
  imagesContinuation: Schema.NullOr(LinearReference),
});
export const RelayLinearImageResponse = Schema.Struct({
  service: Schema.Literal("linear"),
  accountLabel: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  workspaceId: Schema.String,
  issueId: Schema.String,
  image: Schema.Struct({
    mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: Schema.String,
  }),
});

export const RelayReadIssueResponse = Schema.Struct({
  ...RelayIssueDetails.fields,
  linear: Schema.optionalKey(RelayLinearContext),
  service: RelayIssueTrackerService,
  accountLabel: Schema.String,
});
export type RelayReadIssueResponse = typeof RelayReadIssueResponse.Type;

export class RelayIssueTrackerError extends Schema.TaggedError<RelayIssueTrackerError>()(
  "RelayIssueTrackerError",
  {
    code: Schema.Literals([
      "auth_required",
      "forbidden",
      "not_found",
      "invalid_input",
      "unavailable",
      "image_too_large",
      "unsupported_image",
      "conflict",
      "not_configured",
    ]),
    message: Schema.String,
    traceId: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}
