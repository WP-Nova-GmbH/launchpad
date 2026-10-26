import {
  OrganizationRepositoryPolicy,
  RepositoryPolicyAcknowledgement,
  RepositoryPolicyAcknowledgementClaims,
  REPOSITORY_POLICY_ACK_TYPE,
  REPOSITORY_POLICY_PROOF_TYPE,
  type RepositoryAccessRemovalStatus,
} from "@t3tools/contracts";
import { signRelayJwt, verifyRelayJwt, normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";

/** The revision row serializes policy mutations, full snapshots, and activation. */
export const snapshot = Effect.fn("relay.repository_policy.snapshot")(function* (
  organizationId: string,
) {
  const db = yield* RelayDb;
  const sql = db.$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [head] = yield* sql<{
        revision: number;
      }>`SELECT revision FROM relay_repository_policy_revisions WHERE organization_id = ${organizationId} FOR SHARE`;
      const members = yield* sql<{
        userId: string;
        role: "admin" | "member";
      }>`SELECT user_id AS "userId", role FROM relay_organization_members WHERE organization_id = ${organizationId}`;
      const repos = yield* sql<{
        repositoryId: string;
      }>`SELECT repository_id AS "repositoryId" FROM relay_repositories WHERE organization_id = ${organizationId}`;
      const aliases = yield* sql<{
        repositoryId: string;
        canonicalKey: string;
      }>`SELECT repository_id AS "repositoryId", canonical_key AS "canonicalKey" FROM relay_repository_aliases WHERE organization_id = ${organizationId}`;
      const grants = yield* sql<{
        repositoryId: string;
        userId: string;
      }>`SELECT repository_id AS "repositoryId", user_id AS "userId" FROM relay_repository_access WHERE organization_id = ${organizationId}`;
      return {
        organizationId,
        revision: head?.revision ?? 0,
        members,
        repositories: repos.map((repo) => ({
          repositoryId: repo.repositoryId,
          canonicalKeys: aliases
            .filter((alias) => alias.repositoryId === repo.repositoryId)
            .map((alias) => alias.canonicalKey),
          userIds: grants
            .filter((grant) => grant.repositoryId === repo.repositoryId)
            .map((grant) => grant.userId),
        })),
      } satisfies OrganizationRepositoryPolicy;
    }),
  );
});

export const proof = Effect.fn("relay.repository_policy.proof")(function* (
  organizationId: string,
  environmentId: string,
) {
  const policy = yield* snapshot(organizationId);
  const config = yield* RelayConfiguration;
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  return {
    proof: yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: REPOSITORY_POLICY_PROOF_TYPE,
      payload: {
        iss: normalizeRelayIssuer(config.relayIssuer),
        aud: `t3-env:${environmentId}`,
        sub: organizationId,
        jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        iat: now,
        exp: now + 120,
        environmentId,
        policy,
      },
    }),
  };
});

export const acknowledge = Effect.fn("relay.repository_policy.acknowledge")(function* (input: {
  environmentId: string;
  organizationId: string;
  publicKey: string;
  ack: typeof RepositoryPolicyAcknowledgement.Type;
}) {
  const db = yield* RelayDb;
  const config = yield* RelayConfiguration;
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  const claims = yield* verifyRelayJwt({
    publicKey: input.publicKey,
    token: input.ack.proof,
    typ: REPOSITORY_POLICY_ACK_TYPE,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(config.relayIssuer),
    nowEpochSeconds: now,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RepositoryPolicyAcknowledgementClaims)));
  if (
    claims.environmentId !== input.environmentId ||
    claims.sub !== input.environmentId ||
    claims.organizationId !== input.organizationId ||
    claims.revision !== input.ack.revision ||
    claims.exp - claims.iat > 120
  )
    return false;
  const sql = db.$client;
  // ACKs can advance only to an issued revision in this same organization's generation.
  const updated =
    yield* sql`UPDATE relay_repository_policy_acknowledgements SET applied_revision = GREATEST(applied_revision, ${claims.revision}) WHERE environment_id = ${input.environmentId} AND organization_id = ${input.organizationId} AND environment_public_key = ${input.publicKey} AND ${claims.revision} <= (SELECT revision FROM relay_repository_policy_revisions WHERE organization_id = ${input.organizationId}) RETURNING environment_id`;
  return updated.length === 1;
});

export const status = Effect.fn("relay.repository_policy.status")(function* (
  organizationId: string,
  requestedRevision?: number,
) {
  const db = yield* RelayDb;
  const sql = db.$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [head] = yield* sql<{
        revision: number;
      }>`SELECT revision FROM relay_repository_policy_revisions WHERE organization_id = ${organizationId} FOR SHARE`;
      const revision = requestedRevision ?? head?.revision ?? 0;
      const pending = yield* sql<{
        environmentId: string;
      }>`SELECT DISTINCT environment_id AS "environmentId" FROM relay_repository_policy_acknowledgements WHERE organization_id = ${organizationId} AND applied_revision < ${revision} ORDER BY environment_id`;
      return {
        revision,
        status: pending.length === 0 ? "completed" : "pending",
        pendingEnvironmentIds: pending.map((row) => row.environmentId),
      } satisfies RepositoryAccessRemovalStatus;
    }),
  );
});

/** Durable retry state is the desired revision minus each environment's ACK. */
export const deliverPending = Effect.fn("relay.repository_policy.deliver_pending")(function* (
  organizationId?: string,
) {
  const db = yield* RelayDb;
  const sql = db.$client;
  const targets = yield* sql<{
    environmentId: string;
    organizationId: string;
    publicKey: string | null;
    url: string | null;
  }>`SELECT a.environment_id AS "environmentId",a.organization_id AS "organizationId",a.environment_public_key AS "publicKey",COALESCE(m.endpoint_http_base_url,a.endpoint_http_base_url) AS url FROM relay_repository_policy_acknowledgements a JOIN relay_repository_policy_revisions p ON p.organization_id=a.organization_id LEFT JOIN relay_machines m ON m.environment_id=a.environment_id AND m.organization_id=a.organization_id AND m.environment_public_key=a.environment_public_key WHERE a.applied_revision < p.revision AND (${organizationId ?? null}::text IS NULL OR a.organization_id=${organizationId ?? null})`;
  const client = yield* HttpClient.HttpClient;
  yield* Effect.forEach(
    targets,
    (target) =>
      Effect.gen(function* () {
        if (!target.url || !target.publicKey) return;
        const payload = yield* proof(target.organizationId, target.environmentId);
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(
            `${target.url.replace(/\/$/, "")}/api/t3-connect/repository-policy`,
          ),
          payload,
        );
        const ack = yield* client
          .execute(request)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RepositoryPolicyAcknowledgement)));
        yield* acknowledge({ ...target, publicKey: target.publicKey, ack });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause((cause) =>
          Effect.logDebug("repository policy delivery remains pending", {
            environmentId: target.environmentId,
            cause,
          }),
        ),
      ),
    { concurrency: 8, discard: true },
  );
});

export class RepositoryPolicySyncError extends Schema.TaggedError<RepositoryPolicySyncError>()(
  "RepositoryPolicySyncError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface RepositoryPolicyControlShape {
  readonly synchronize: (input: {
    organizationId: string;
    environmentId: string;
    publicKey: string;
    url: string;
  }) => Effect.Effect<void, RepositoryPolicySyncError>;
}
export class RepositoryPolicyControl extends Context.Reference<RepositoryPolicyControlShape>(
  "relay/RepositoryPolicyControl",
  {
    defaultValue: () => ({
      synchronize: () =>
        Effect.fail(
          new RepositoryPolicySyncError({
            detail: "Repository policy control is unavailable.",
            cause: null,
          }),
        ),
    }),
  },
) {}
export const controlLayer = Layer.effect(
  RepositoryPolicyControl,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      RelayDb | RelayConfiguration | Crypto.Crypto | HttpClient.HttpClient
    >();
    return RepositoryPolicyControl.of({
      synchronize: (input) =>
        Effect.gen(function* () {
          const payload = yield* proof(input.organizationId, input.environmentId);
          const client = yield* HttpClient.HttpClient;
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(
              `${input.url.replace(/\/$/, "")}/api/t3-connect/repository-policy`,
            ),
            payload,
          );
          const ack = yield* client
            .execute(request)
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(RepositoryPolicyAcknowledgement)),
            );
          const accepted = yield* acknowledge({ ...input, ack });
          if (!accepted)
            return yield* new RepositoryPolicySyncError({
              detail: "Policy acknowledgement did not match this environment.",
              cause: null,
            });
        }).pipe(
          Effect.provide(context),
          Effect.mapError(
            (cause) =>
              new RepositoryPolicySyncError({
                detail: "Could not synchronize repository access.",
                cause,
              }),
          ),
        ),
    });
  }),
);
