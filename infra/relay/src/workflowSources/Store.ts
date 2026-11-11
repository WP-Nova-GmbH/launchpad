import * as EventFence from "../workflowEvents/Fence.ts";
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
import * as Option from "effect/Option";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";

export const fail = (code: WorkflowSourceError["code"], message: string, retryAt?: number) =>
  new WorkflowSourceError({ code, message, ...(retryAt === undefined ? {} : { retryAt }) });
export const now = DateTime.now.pipe(Effect.map((d) => d.epochMilliseconds));
export const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const iso = (value: number) => DateTime.formatIso(DateTime.makeUnsafe(value));
export const healthy: WorkflowSourceHealth = { code: "healthy", retryAt: null };
export interface Connection {
  connection_id: string;
  organization_id: string;
  application_id: string;
  workspace_id: string;
  workspace_name: string;
  viewer_name: string;
  status: WorkflowSource["status"];
  authorization_epoch: number;
  activated_at: string;
  authorization_started_at: string | null;
  delivery_evidence: unknown;
  credential_version: number;
  payload_sealed: string | null;
  health: WorkflowSourceHealth;
  lease_id: string | null;
  lease_until: string | null;
  refresh_started_at: string | null;
}
export interface Attempt {
  organization_id: string;
  application_id: string;
  initiating_user_id: string | null;
  exchange_lease_until: string | null;
  version: number;
  attempt_id: string | null;
  started_at: string | null;
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
  generation: number;
  revoked: boolean;
}
const source = (
  c: Connection,
  app: string | null,
  config: Effect.Success<typeof EventFence.configuration>,
  exchanging = false,
): WorkflowSource => ({
  connectionId: c.connection_id,
  organizationId: c.organization_id,
  applicationId: c.application_id,
  workspaceId: c.workspace_id,
  workspaceName: c.workspace_name,
  viewerName: c.viewer_name,
  status: c.status,
  authorizationEpoch: c.authorization_epoch,
  health:
    c.status === "connected" && c.application_id !== app
      ? { code: "service_configuration", retryAt: null }
      : exchanging && c.status === "connected"
        ? { code: "unavailable", retryAt: null }
        : c.health,
  delivery:
    !exchanging &&
    c.status === "connected" &&
    c.application_id === app &&
    config?.applicationId === app &&
    config.organizationId === c.organization_id &&
    Object.values(EventFence.evidence(c, config.generation)?.teams ?? {}).some(
      (t) => t.created && t.entered,
    )
      ? "verified"
      : "unverified",
});
export const grant = (g: Grant): WorkflowSourceGrant => ({
  grantId: g.grant_id,
  connectionId: g.connection_id,
  organizationId: g.organization_id,
  repositoryId: g.repository_id,
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
export const installed = Effect.fn("workflowSources.installed")(function* (
  org: string,
  app: string,
  lock = false,
) {
  const sql = (yield* RelayDb).$client;
  const rows = lock
    ? yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE organization_id=${org} AND application_id=${app} FOR UPDATE`
    : yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE organization_id=${org} AND application_id=${app} FOR SHARE`;
  return rows[0] ?? null;
});
export const attempt = Effect.fn("workflowSources.attempt")(function* (
  org: string,
  app: string,
  lock = false,
) {
  const sql = (yield* RelayDb).$client;
  const rows = lock
    ? yield* sql<Attempt>`SELECT * FROM relay_workflow_authorizations WHERE organization_id=${org} AND application_id=${app} FOR UPDATE`
    : yield* sql<Attempt>`SELECT * FROM relay_workflow_authorizations WHERE organization_id=${org} AND application_id=${app} FOR SHARE`;
  return rows[0] ?? null;
});
export const organizationAdmin = Effect.fn("workflowSources.organizationAdmin")(function* (
  organizationId: string,
  userId: string,
) {
  const sql = (yield* RelayDb).$client;
  const [member] = yield* sql<{ role: string }>`SELECT m.role FROM relay_organization_members m
    JOIN relay_organizations o USING(organization_id)
    WHERE m.organization_id=${organizationId} AND m.user_id=${userId} FOR SHARE OF m`;
  if (member?.role !== "admin")
    return yield* fail("forbidden", "Organization admin access is required.");
});
export const configuredFor = Effect.fn("workflowSources.configuredFor")(function* (org: string) {
  const config = Option.getOrUndefined(
    yield* Effect.serviceOption(RelayConfiguration),
  )?.linearWorkflow;
  if (!config?.clientId.trim() || config.organizationId !== org) return null;
  const sql = (yield* RelayDb).$client;
  const bindings = yield* sql<{
    organization_id: string;
    application_id: string;
  }>`SELECT organization_id,application_id
    FROM relay_workflow_authorizations WHERE application_id=${config.clientId} OR organization_id=${org}`;
  if (bindings.some((row) => row.organization_id !== org || row.application_id !== config.clientId))
    return null;
  return config.clientId;
});
export const exchangeInProgress = (lease: string) =>
  fail(
    "refresh_in_progress",
    "Linear authorization is being verified. Refresh its status.",
    Date.parse(lease),
  );

/** Caller owns the transaction and holds authority through the associated write. */
export const repositoryAuthority = Effect.fn("workflowSources.repositoryAuthority")(function* (
  repo: string,
  caller: string | null,
  maintain: boolean,
) {
  const sql = (yield* RelayDb).$client;
  const [hint] = yield* sql<{
    organization_id: string;
  }>`SELECT organization_id FROM relay_repositories WHERE repository_id=${repo}`;
  if (!hint) return yield* fail("not_found", "Repository not found.");
  const member = caller
    ? (yield* sql<{
        role: string;
      }>`SELECT role FROM relay_organization_members WHERE organization_id=${hint.organization_id} AND user_id=${caller} FOR SHARE`)[0]
    : undefined;
  if (caller && !member) return yield* fail("not_found", "Repository not found.");
  const access = caller
    ? (yield* sql<{
        role: string;
      }>`SELECT role FROM relay_repository_access WHERE repository_id=${repo} AND organization_id=${hint.organization_id} AND user_id=${caller} FOR SHARE`)[0]
    : undefined;
  const canAllow = member?.role === "admin";
  if (caller && !canAllow && (!access || (maintain && access.role !== "maintainer")))
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
  return { repository, canAllow, canManage: canAllow || access?.role === "maintainer" };
});

/** Pure database authority, with no provider I/O under these locks. */
export const authority = Effect.fn("workflowSources.authority")(function* (
  repo: string,
  grantId: string,
  caller: string | null = null,
  maintain = true,
) {
  const sql = (yield* RelayDb).$client;
  const { repository } = yield* repositoryAuthority(repo, caller, maintain);
  const app = yield* configuredFor(repository.organization_id);
  if (!app)
    return yield* fail(
      "service_configuration",
      "Linear workflow authorization is unavailable for this organization.",
    );
  const a = yield* attempt(repository.organization_id, app);
  if (a?.exchange_lease_until) return yield* exchangeInProgress(a.exchange_lease_until);
  const c = yield* installed(repository.organization_id, app);
  const [g] =
    yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${grantId} AND repository_id=${repo} AND organization_id=${repository.organization_id} FOR SHARE`;
  if (!g || g.revoked || !c || g.connection_id !== c.connection_id)
    return yield* fail("forbidden", "Repository source use was withdrawn.");
  if (!a || c.status !== "connected" || !c.payload_sealed)
    return yield* fail("reconnect_required", "An organization admin must reconnect Linear.");
  return { connection: c, grant: g };
});

export const allow = Effect.fn("workflowSources.allow")(function* (
  repo: string,
  user: string,
  input: { connectionId: string; grantId: string; previousGrantId: string | null },
  applicationId: string,
) {
  const sql = (yield* RelayDb).$client;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { repository, canAllow } = yield* repositoryAuthority(repo, user, true);
      if (!canAllow)
        return yield* fail(
          "forbidden",
          "Organization admin access is required to allow repository use.",
        );
      const app = yield* configuredFor(repository.organization_id);
      if (!app || app !== applicationId)
        return yield* fail(
          "service_configuration",
          "Linear workflow authorization is unavailable for this organization.",
        );
      const a = yield* attempt(repository.organization_id, app);
      if (a?.exchange_lease_until) return yield* exchangeInProgress(a.exchange_lease_until);
      const c = yield* installed(repository.organization_id, app, true);
      if (!c || c.connection_id !== input.connectionId)
        return yield* fail("not_found", "Organization source not found.");
      const [existing] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${input.grantId}`;
      if (existing) {
        if (
          existing.repository_id !== repo ||
          existing.connection_id !== c.connection_id ||
          existing.organization_id !== repository.organization_id
        )
          return yield* fail("conflict", "This consent identity belongs to another request.");
        return grant(existing);
      }
      if (!a || c.status !== "connected" || !c.payload_sealed)
        return yield* fail(
          "reconnect_required",
          "Reconnect this source before allowing repository use.",
        );
      const [previous] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE connection_id=${c.connection_id} AND repository_id=${repo} AND organization_id=${repository.organization_id} ORDER BY generation DESC LIMIT 1 FOR UPDATE`;
      if ((previous?.grant_id ?? null) !== input.previousGrantId || (previous && !previous.revoked))
        return yield* fail("conflict", "Source consent changed. Refresh before allowing use.");
      const [created] =
        yield* sql<Grant>`INSERT INTO relay_workflow_repository_grants (grant_id,connection_id,organization_id,repository_id,generation,created_at) VALUES (${input.grantId},${c.connection_id},${repository.organization_id},${repo},${(previous?.generation ?? 0) + 1},${iso(yield* now)}) RETURNING *`;
      return grant(created!);
    }),
  );
});

export const withdraw = Effect.fn("workflowSources.withdraw")(function* (
  user: string,
  id: string,
  repo?: string,
  organizationId?: string,
) {
  const sql = (yield* RelayDb).$client;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [g] =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${id}`;
      if (
        !g ||
        (repo && repo !== g.repository_id) ||
        (organizationId && organizationId !== g.organization_id)
      )
        return yield* fail("not_found", "Source grant not found.");
      if (repo) {
        const { repository } = yield* repositoryAuthority(repo, user, true);
        if (g.organization_id !== repository.organization_id)
          return yield* fail("not_found", "Source grant not found.");
      } else yield* organizationAdmin(g.organization_id, user);
      yield* sql`UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,${iso(yield* now)}),revoked_reason=COALESCE(revoked_reason,'withdrawn') WHERE grant_id=${id}`;
    }),
  );
});

export const ownerSnapshot = Effect.fn("workflowSources.ownerSnapshot")(function* (
  org: string,
  user: string,
) {
  const sql = (yield* RelayDb).$client;
  const eventConfig = yield* EventFence.configuration;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* organizationAdmin(org, user);
      const app = yield* configuredFor(org);
      const a = app ? yield* attempt(org, app) : null;
      const exchangeInProgress = !!a?.exchange_lease_until;
      const connections =
        yield* sql<Connection>`SELECT * FROM relay_workflow_connections WHERE organization_id=${org} ORDER BY workspace_name,connection_id`;
      const repositories = yield* sql<WorkflowSourceOwner["repositories"][number]>`
      SELECT repository_id AS "repositoryId",organization_id AS "organizationId",name FROM relay_repositories WHERE organization_id=${org} ORDER BY name,repository_id`;
      const grants = yield* sql<Grant>`SELECT g.* FROM relay_workflow_repository_grants g
      JOIN relay_repositories r ON r.repository_id=g.repository_id AND r.organization_id=g.organization_id
      JOIN relay_workflow_connections c ON c.connection_id=g.connection_id AND c.organization_id=g.organization_id
      WHERE g.organization_id=${org} ORDER BY g.generation`;
      const time = yield* now;
      return {
        configured: app !== null,
        applicationId: app,
        version: a?.version ?? 0,
        exchangeInProgress,
        attempt:
          a?.attempt_id && a.expires_at && a.status
            ? {
                attemptId: a.attempt_id,
                connectionId: a.connection_id,
                expiresAt: Date.parse(a.expires_at),
                status:
                  (a.status === "pending" || a.status === "exchanging") &&
                  Date.parse(a.expires_at) <= time
                    ? ("failed" as const)
                    : a.status,
                error: a.error,
                canResume:
                  a.status === "pending" &&
                  a.initiating_user_id === user &&
                  Date.parse(a.expires_at) > time &&
                  !exchangeInProgress,
              }
            : null,
        connections: connections.map((c) => source(c, app, eventConfig, exchangeInProgress)),
        repositories,
        grants: grants.map(grant),
        withdrawableGrants: grants
          .filter((g) => !g.revoked)
          .map((g) => ({
            grantId: g.grant_id,
            connectionId: g.connection_id,
            repositoryName:
              repositories.find((r) => r.repositoryId === g.repository_id)?.name ?? null,
          })),
      } satisfies WorkflowSourceOwner;
    }),
  );
});

export const repositorySnapshot = Effect.fn("workflowSources.repositorySnapshot")(function* (
  repo: string,
  caller: string,
) {
  const sql = (yield* RelayDb).$client;
  const eventConfig = yield* EventFence.configuration;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { repository, canManage, canAllow } = yield* repositoryAuthority(repo, caller, true);
      const org = repository.organization_id;
      const app = yield* configuredFor(org);
      const a = app ? yield* attempt(org, app) : null;
      const grants =
        yield* sql<Grant>`SELECT * FROM relay_workflow_repository_grants WHERE repository_id=${repo} AND organization_id=${org} ORDER BY generation DESC`;
      const all =
        yield* sql<Connection>`SELECT c.* FROM relay_workflow_connections c WHERE c.organization_id=${org}
      AND (${canAllow} OR EXISTS (SELECT 1 FROM relay_workflow_repository_grants g WHERE g.connection_id=c.connection_id AND g.organization_id=c.organization_id AND g.repository_id=${repo} AND NOT g.revoked))`;
      const sources = grants
        .filter((g) => !g.revoked)
        .flatMap((g) => {
          const c = all.find((c) => c.connection_id === g.connection_id);
          return c
            ? [
                {
                  source: source(c, app, eventConfig, !!a?.exchange_lease_until),
                  grant: grant(g),
                },
              ]
            : [];
        });
      const eligible =
        canAllow && a && !a.exchange_lease_until
          ? all
              .filter(
                (c) =>
                  c.application_id === app &&
                  c.status === "connected" &&
                  !!c.payload_sealed &&
                  !sources.some((s) => s.source.connectionId === c.connection_id),
              )
              .map((c) => ({
                source: source(c, app, eventConfig),
                previousGrantId:
                  grants.find((g) => g.connection_id === c.connection_id)?.grant_id ?? null,
              }))
          : [];
      return { configured: app !== null, canAllow, canManage, sources, eligible };
    }),
  );
});

export const repositoryHealth = Effect.fn("workflowSources.repositoryHealth")(function* (
  repo: string,
  user: string,
) {
  const sql = (yield* RelayDb).$client;
  const eventConfig = yield* EventFence.configuration;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { repository } = yield* repositoryAuthority(repo, user, false);
      const app = yield* configuredFor(repository.organization_id);
      const a = app ? yield* attempt(repository.organization_id, app) : null;
      const rows = yield* sql<Connection>`SELECT c.* FROM relay_workflow_connections c
      JOIN relay_workflow_repository_grants g ON g.connection_id=c.connection_id AND g.organization_id=c.organization_id
      WHERE g.repository_id=${repo} AND g.organization_id=${repository.organization_id} AND NOT g.revoked ORDER BY c.workspace_name`;
      return {
        sources: rows.map((c) => {
          const { connectionId, workspaceName, status, health, delivery } = source(
            c,
            app,
            eventConfig,
            !!a?.exchange_lease_until,
          );
          return { connectionId, workspaceName, status, health, delivery };
        }),
      };
    }),
  );
});
