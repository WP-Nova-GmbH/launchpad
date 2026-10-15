import {
  WorkflowSourceError,
  type WorkflowSource,
  type WorkflowSourceGrant,
  type WorkflowSourceHealth,
  type WorkflowSourceOwner,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { RelayDb } from "../db.ts";

export const fail = (code: WorkflowSourceError["code"], message: string, retryAt?: number) =>
  new WorkflowSourceError({ code, message, ...(retryAt === undefined ? {} : { retryAt }) });
export const now = DateTime.now.pipe(Effect.map((d) => d.epochMilliseconds));
export const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const iso = (value: number) => DateTime.formatIso(DateTime.makeUnsafe(value));
export const healthy: WorkflowSourceHealth = { code: "healthy", retryAt: null };
export interface Connection {
  connection_id: string;
  owner_user_id: string;
  application_id: string;
  workspace_id: string;
  workspace_name: string;
  viewer_name: string;
  status: WorkflowSource["status"];
  authorization_epoch: number;
  activated_at: string;
  credential_version: number;
  payload_sealed: string | null;
  health: WorkflowSourceHealth;
  lease_id: string | null;
  lease_until: string | null;
  refresh_started_at: string | null;
}
export interface Attempt {
  owner_user_id: string;
  application_id: string;
  version: number;
  attempt_id: string | null;
  connection_id: string | null;
  expected_epoch: number | null;
  state_hash: string | null;
  pending_sealed: string | null;
  expires_at: string | null;
  status: NonNullable<WorkflowSourceOwner["attempt"]>["status"] | null;
  error: WorkflowSourceError["code"] | null;
}
export interface Grant {
  grant_id: string;
  connection_id: string;
  organization_id: string;
  repository_id: string;
  owner_user_id: string;
  generation: number;
  revoked: boolean;
}
export const source = (c: Connection): WorkflowSource => ({
  connectionId: c.connection_id,
  ownerUserId: c.owner_user_id,
  applicationId: c.application_id,
  workspaceId: c.workspace_id,
  workspaceName: c.workspace_name,
  viewerName: c.viewer_name,
  status: c.status,
  authorizationEpoch: c.authorization_epoch,
  health: c.health,
  delivery: "unverified",
});
export const grant = (g: Grant): WorkflowSourceGrant => ({
  grantId: g.grant_id,
  connectionId: g.connection_id,
  organizationId: g.organization_id,
  repositoryId: g.repository_id,
  ownerUserId: g.owner_user_id,
  generation: g.generation,
  revoked: g.revoked,
});
export const connection = Effect.fn("workflowSources.connection")(function* (id: string) {
  const sql = (yield* RelayDb).$client;
  return (
    (yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE connection_id=${id}`)[0] ??
    null
  );
});
export const attempt = Effect.fn("workflowSources.attempt")(function* (
  owner: string,
  app: string,
  lock = false,
) {
  const sql = (yield* RelayDb).$client;
  const rows = lock
    ? yield* sql<Attempt>`SELECT * FROM relay_workflow_authorizations WHERE owner_user_id=${owner} AND application_id=${app} FOR UPDATE`
    : yield* sql<Attempt>`SELECT * FROM relay_workflow_authorizations WHERE owner_user_id=${owner} AND application_id=${app}`;
  return rows[0] ?? null;
});

/** Caller owns the transaction: hold these fences through its consent/admission/offer write. */
export const repositoryAuthority = Effect.fn("workflowSources.repositoryAuthority")(function* (
  repo: string,
  caller: string | null,
  owner: string | null,
  maintain: boolean,
) {
  const sql = (yield* RelayDb).$client;
  const [hint] = yield* sql<{
    organization_id: string;
  }>`SELECT organization_id FROM relay_repositories WHERE repository_id=${repo}`;
  if (!hint) return yield* fail("not_found", "Repository not found.");
  // Membership/access precede repository/organization, then connection, then grant.
  const members = yield* sql<{
    user_id: string;
    role: string;
  }>`SELECT user_id,role FROM relay_organization_members WHERE organization_id=${hint.organization_id} AND (user_id=${caller} OR user_id=${owner}) ORDER BY user_id FOR SHARE`;
  if (owner && !members.some((m) => m.user_id === owner))
    return yield* fail("forbidden", "The source owner is no longer in this organization.");
  const member = members.find((m) => m.user_id === caller);
  if (caller && !member) return yield* fail("not_found", "Repository not found.");
  const access = caller
    ? (yield* sql<{
        role: string;
      }>`SELECT role FROM relay_repository_access WHERE repository_id=${repo} AND user_id=${caller} FOR SHARE`)[0]
    : undefined;
  if (caller && member?.role !== "admin" && (!access || (maintain && access.role !== "maintainer")))
    return yield* fail(
      maintain ? "forbidden" : "not_found",
      maintain ? "Repository maintainer access is required." : "Repository not found.",
    );
  const [repository] = yield* sql<{
    repository_id: string;
    organization_id: string;
    name: string;
  }>`SELECT repository_id,organization_id,name FROM relay_repositories WHERE repository_id=${repo} AND organization_id=${hint.organization_id} FOR SHARE`;
  const [organization] =
    yield* sql`SELECT organization_id FROM relay_organizations WHERE organization_id=${hint.organization_id} FOR SHARE`;
  if (!repository || !organization) return yield* fail("not_found", "Repository not found.");
  return { repository, canManage: member?.role === "admin" || access?.role === "maintainer" };
});

/** Pure database authority; never refresh or call a provider while these locks are held. */
export const authority = Effect.fn("workflowSources.authority")(function* (
  repo: string,
  grantId: string,
  caller: string | null = null,
  maintain = true,
) {
  const sql = (yield* RelayDb).$client;
  const [hint] =
    yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${grantId} AND repository_id=${repo}`;
  if (!hint) return yield* fail("not_found", "Source grant not found.");
  yield* repositoryAuthority(repo, caller, hint.owner_user_id, maintain);
  const [c] =
    yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE connection_id=${hint.connection_id} FOR SHARE`;
  const [g] =
    yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${grantId} AND repository_id=${repo} FOR SHARE`;
  if (!g || g.revoked || !c || c.owner_user_id !== g.owner_user_id)
    return yield* fail("forbidden", "Repository source use was withdrawn.");
  if (c.status !== "connected" || !c.payload_sealed)
    return yield* fail("reconnect_required", "The source owner must reconnect Linear.");
  return { connection: c, grant: g };
});

export const allow = Effect.fn("workflowSources.allow")(function* (
  repo: string,
  owner: string,
  input: { connectionId: string; grantId: string; previousGrantId: string | null },
  applicationId: string,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { repository } = yield* repositoryAuthority(repo, owner, owner, true);
      const [c] =
        yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE connection_id=${input.connectionId} AND owner_user_id=${owner} FOR UPDATE`;
      if (!c) return yield* fail("not_found", "Owned source not found.");
      const [existing] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${input.grantId}`;
      if (existing) {
        if (
          existing.repository_id !== repo ||
          existing.connection_id !== c.connection_id ||
          existing.owner_user_id !== owner
        )
          return yield* fail("conflict", "This consent identity belongs to another request.");
        return grant(existing);
      }
      if (c.status !== "connected" || !c.payload_sealed || c.application_id !== applicationId)
        return yield* fail(
          "reconnect_required",
          "Reconnect this source before allowing repository use.",
        );
      const [previous] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE connection_id=${c.connection_id} AND repository_id=${repo} ORDER BY generation DESC LIMIT 1 FOR UPDATE`;
      if ((previous?.grant_id ?? null) !== input.previousGrantId || (previous && !previous.revoked))
        return yield* fail("conflict", "Source consent changed. Refresh before allowing use.");
      const [created] =
        yield* sql<Grant>`INSERT INTO relay_workflow_repository_grants (grant_id,connection_id,organization_id,repository_id,owner_user_id,generation,created_at) VALUES (${input.grantId},${c.connection_id},${repository.organization_id},${repo},${owner},${(previous?.generation ?? 0) + 1},${iso(yield* now)}) RETURNING *`;
      return grant(created!);
    }),
  );
});

export const withdraw = Effect.fn("workflowSources.withdraw")(function* (
  user: string,
  id: string,
  repo?: string,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [g] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${id}`;
      if (!g || (repo && repo !== g.repository_id))
        return yield* fail("not_found", "Source grant not found.");
      if (!repo && g.owner_user_id !== user)
        return yield* fail("not_found", "Source grant not found.");
      if (repo) yield* repositoryAuthority(g.repository_id, user, null, true);
      // Owner withdrawal needs no regained repository access and discloses no repository details.
      yield* sql`UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,${iso(yield* now)}),revoked_reason=COALESCE(revoked_reason,'withdrawn') WHERE grant_id=${id}`;
    }),
  );
});

export const ownerSnapshot = Effect.fn("workflowSources.ownerSnapshot")(function* (
  owner: string,
  app: string | null,
) {
  const sql = (yield* RelayDb).$client;
  const a = app ? yield* attempt(owner, app) : null;
  const connections =
    yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE owner_user_id=${owner} ORDER BY workspace_name,connection_id`;
  const repositories = yield* sql<{
    repositoryId: string;
    organizationId: string;
    name: string;
  }>`SELECT r.repository_id AS "repositoryId",r.organization_id AS "organizationId",r.name FROM relay_repositories r JOIN relay_organizations o ON o.organization_id=r.organization_id JOIN relay_organization_members m ON m.organization_id=r.organization_id AND m.user_id=${owner} LEFT JOIN relay_repository_access a ON a.repository_id=r.repository_id AND a.user_id=${owner} WHERE m.role='admin' OR a.role='maintainer' ORDER BY r.name,r.repository_id`;
  const grants =
    yield* sql<Grant>`SELECT g.* FROM relay_workflow_repository_grants g JOIN relay_repositories r ON r.repository_id=g.repository_id JOIN relay_organization_members m ON m.organization_id=r.organization_id AND m.user_id=${owner} LEFT JOIN relay_repository_access a ON a.repository_id=r.repository_id AND a.user_id=${owner} WHERE g.owner_user_id=${owner} AND (m.role='admin' OR a.user_id IS NOT NULL) ORDER BY g.generation`;
  const withdrawableGrants = yield* sql<WorkflowSourceOwner["withdrawableGrants"][number]>`
    SELECT g.grant_id AS "grantId",g.connection_id AS "connectionId",
      CASE WHEN m.role='admin' OR a.user_id IS NOT NULL THEN r.name ELSE NULL END AS "repositoryName"
    FROM relay_workflow_repository_grants g
    JOIN relay_workflow_connections c ON c.connection_id=g.connection_id AND c.owner_user_id=${owner}
    JOIN relay_repositories r ON r.repository_id=g.repository_id AND r.organization_id=g.organization_id
    JOIN relay_organizations o ON o.organization_id=g.organization_id
    JOIN relay_organization_members m ON m.organization_id=g.organization_id AND m.user_id=${owner}
    LEFT JOIN relay_repository_access a ON a.repository_id=g.repository_id AND a.user_id=${owner}
    WHERE g.owner_user_id=${owner} AND NOT g.revoked ORDER BY g.grant_id`;
  return {
    configured: app !== null,
    applicationId: app,
    version: a?.version ?? 0,
    attempt:
      a?.attempt_id && a.expires_at && a.status
        ? {
            attemptId: a.attempt_id,
            connectionId: a.connection_id,
            expiresAt: Date.parse(a.expires_at),
            status:
              (a.status === "pending" || a.status === "exchanging") &&
              Date.parse(a.expires_at) <= (yield* now)
                ? ("failed" as const)
                : a.status,
            error: a.error,
          }
        : null,
    connections: connections.map(source),
    repositories,
    grants: grants.map(grant),
    withdrawableGrants,
  } satisfies WorkflowSourceOwner;
});

export const repositorySnapshot = Effect.fn("workflowSources.repositorySnapshot")(function* (
  repo: string,
  caller: string,
  app: string | null,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { canManage } = yield* repositoryAuthority(repo, caller, null, true);
      const grants =
        yield* sql<Grant>`SELECT g.* FROM relay_workflow_repository_grants g JOIN relay_organization_members m ON m.organization_id=g.organization_id AND m.user_id=g.owner_user_id WHERE g.repository_id=${repo} AND NOT g.revoked ORDER BY g.grant_id`;
      const all =
        yield* sql<Connection>`SELECT c.* FROM relay_workflow_connections c WHERE c.owner_user_id=${caller} OR EXISTS (SELECT 1 FROM relay_workflow_repository_grants g WHERE g.connection_id=c.connection_id AND g.repository_id=${repo} AND NOT g.revoked)`;
      const previous = canManage
        ? yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE repository_id=${repo} AND owner_user_id=${caller} ORDER BY generation DESC`
        : [];
      return {
        configured: app !== null,
        canManage,
        sources: grants.flatMap((g) => {
          const c = all.find((c) => c.connection_id === g.connection_id);
          return c ? [{ source: source(c), grant: grant(g) }] : [];
        }),
        eligible: canManage
          ? all
              .filter(
                (c) =>
                  c.owner_user_id === caller &&
                  c.status === "connected" &&
                  c.application_id === app &&
                  !grants.some((g) => g.connection_id === c.connection_id),
              )
              .map((c) => ({
                source: source(c),
                previousGrantId:
                  previous.find((g) => g.connection_id === c.connection_id)?.grant_id ?? null,
              }))
          : [],
      };
    }),
  );
});

export const repositoryHealth = Effect.fn("workflowSources.repositoryHealth")(function* (
  repo: string,
  user: string,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* repositoryAuthority(repo, user, null, false);
      const rows =
        yield* sql<Connection>`SELECT c.* FROM relay_workflow_connections c JOIN relay_workflow_repository_grants g ON g.connection_id=c.connection_id JOIN relay_organization_members m ON m.organization_id=g.organization_id AND m.user_id=g.owner_user_id WHERE g.repository_id=${repo} AND NOT g.revoked ORDER BY c.workspace_name`;
      return {
        sources: rows.map((c) => ({
          connectionId: c.connection_id,
          workspaceName: c.workspace_name,
          ownerUserId: c.owner_user_id,
          status: c.status,
          health: c.health,
          delivery: "unverified" as const,
        })),
      };
    }),
  );
});
