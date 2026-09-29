import * as Schema from "effect/Schema";

/** A complete policy: newer revisions replace, rather than patch, older grants. */
export const OrganizationRepositoryPolicy = Schema.Struct({
  organizationId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  members: Schema.Array(
    Schema.Struct({ userId: Schema.String, role: Schema.Literals(["admin", "member"]) }),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      repositoryId: Schema.String,
      canonicalKeys: Schema.Array(Schema.String),
      userIds: Schema.Array(Schema.String),
    }),
  ),
});
export type OrganizationRepositoryPolicy = typeof OrganizationRepositoryPolicy.Type;

export const RepositoryAccessRemovalStatus = Schema.Struct({
  revision: Schema.Int,
  status: Schema.Literals(["pending", "completed"]),
  pendingEnvironmentIds: Schema.Array(Schema.String),
});
export type RepositoryAccessRemovalStatus = typeof RepositoryAccessRemovalStatus.Type;

export const RepositoryPolicyProof = Schema.Struct({ proof: Schema.String });
export const RepositoryPolicyAcknowledgement = Schema.Struct({
  revision: Schema.Int,
  proof: Schema.String,
});
export const RepositoryPolicyProofClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  environmentId: Schema.String,
  policy: OrganizationRepositoryPolicy,
});

export const REPOSITORY_POLICY_PROOF_TYPE = "t3-repository-policy+jwt";

export const REPOSITORY_POLICY_ACK_TYPE = "t3-repository-policy-ack+jwt";
export const RepositoryPolicyAcknowledgementClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  organizationId: Schema.String,
  environmentId: Schema.String,
  revision: Schema.Int,
});
