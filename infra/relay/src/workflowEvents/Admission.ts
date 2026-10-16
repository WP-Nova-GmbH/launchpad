import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { RepositoryWorkflow, RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { RelayDb } from "../db.ts";
import { relayWorkflowJobs, relayWorkflowAdmissions } from "../persistence/schema.ts";
import * as Sources from "../workflowSources/Store.ts";
import * as Fence from "./Fence.ts";
import { FRESHNESS_MS, WebhookError, matches, type NormalizedEvent } from "./Linear.ts";

const decodeWorkflow = Schema.decodeUnknownEffect(RepositoryWorkflow);
const decodeJob = Schema.decodeUnknownEffect(RepositoryWorkflowJob);
const isWebhookError = Schema.is(WebhookError);
interface Rule {
  workflow_id: string;
  repository_id: string;
  routing_generation: number;
  effective_after: string | null;
  record: RepositoryWorkflow;
}
/** One source fence precedes every tenancy, connection, grant and workflow row lock. */
export const admit = Effect.fn("workflowEvents.admit")(function* (event: NormalizedEvent) {
  const config = yield* Fence.configuration;
  if (!config) return yield* new WebhookError({ status: 503, code: "not_configured" });
  const db = yield* RelayDb;
  const sql = db.$client;
  const received = (yield* DateTime.now).epochMilliseconds;
  if (event.kind === "ignored") {
    if (Math.abs(received - event.deliveredAt) > FRESHNESS_MS)
      return yield* new WebhookError({ status: 401, code: "stale_event" });
    return { duplicate: false, jobs: 0 };
  }
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* Fence.lock(config.applicationId, event.workspaceId);
        const prior = yield* sql<{
          job_count: number;
        }>`SELECT job_count FROM relay_workflow_occurrences WHERE application_id=${config.applicationId} AND workspace_id=${event.workspaceId} AND event_key=${event.eventKey}`;
        if (prior.length) return { duplicate: true, jobs: prior[0]!.job_count };
        if (
          Math.abs(received - event.deliveredAt) > FRESHNESS_MS ||
          Date.parse(event.occurredAt) > received + FRESHNESS_MS
        )
          return yield* new WebhookError({ status: 401, code: "stale_event" });
        const stamp = yield* Fence.timestamp;
        const occurrenceId = `linear:${event.eventKey}`;
        yield* sql`INSERT INTO relay_workflow_occurrences (occurrence_id,application_id,workspace_id,event_key,event_type,occurred_at,received_at,facts)
      VALUES (${occurrenceId},${config.applicationId},${event.workspaceId},${event.eventKey},${event.kind},${event.occurredAt},${stamp},${sql.json(event.kind === "issue" ? event.facts : {})})`;
        if (event.kind === "revocation") {
          const cutoff = (yield* Fence.revocationCutoff(config.applicationId, event.workspaceId))!;
          // Begin, disconnect and callback all take the attempt before its connection.
          // Insert in the same owner order as the locks, including when attempts were not retained.
          yield* sql`INSERT INTO relay_workflow_authorizations (owner_user_id,application_id)
            SELECT owner_user_id,application_id FROM relay_workflow_connections
            WHERE application_id=${config.applicationId} AND workspace_id=${event.workspaceId}
            ORDER BY owner_user_id,application_id ON CONFLICT DO NOTHING`;
          const attempts = yield* sql<Sources.Attempt>`SELECT * FROM relay_workflow_authorizations
            WHERE application_id=${config.applicationId} AND owner_user_id IN
              (SELECT owner_user_id FROM relay_workflow_connections WHERE application_id=${config.applicationId} AND workspace_id=${event.workspaceId})
            ORDER BY owner_user_id,application_id FOR UPDATE`;
          const byOwner = new Map(attempts.map((a) => [a.owner_user_id, a]));
          const connections =
            yield* sql<Sources.Connection>`SELECT * FROM relay_workflow_connections WHERE application_id=${config.applicationId} AND workspace_id=${event.workspaceId} ORDER BY connection_id FOR UPDATE`;
          const now = Date.parse(yield* Fence.timestamp);
          const revoked = connections.filter(
            (c) =>
              c.status === "connected" &&
              (!c.authorization_started_at ||
                Date.parse(c.authorization_started_at) <= Date.parse(event.occurredAt)),
          );
          // Carry only genuinely later reconnects across this invalidation of their old credentials.
          const forwarded = revoked.filter((c) => {
            const attempt = byOwner.get(c.owner_user_id);
            return (
              attempt?.connection_id === c.connection_id &&
              attempt.expected_epoch === c.authorization_epoch &&
              (attempt.status === "pending" || attempt.status === "exchanging") &&
              attempt.started_at &&
              Date.parse(attempt.started_at) > Date.parse(cutoff) &&
              attempt.expires_at &&
              Date.parse(attempt.expires_at) > now
            );
          });
          if (revoked.length)
            yield* sql`UPDATE relay_workflow_connections SET status='reconnect_required',authorization_epoch=authorization_epoch+1,
              credential_version=credential_version+1,payload_sealed=NULL,delivery_evidence=NULL,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL,
              health='{"code":"reconnect_required","retryAt":null}'::jsonb WHERE connection_id IN ${sql.in(revoked.map((c) => c.connection_id))}`;
          if (forwarded.length)
            yield* sql`UPDATE relay_workflow_authorizations a SET expected_epoch=c.authorization_epoch,version=a.version+1
              FROM relay_workflow_connections c WHERE a.application_id=${config.applicationId} AND a.connection_id=c.connection_id
              AND a.owner_user_id=c.owner_user_id AND a.expected_epoch=c.authorization_epoch-1
              AND c.connection_id IN ${sql.in(forwarded.map((c) => c.connection_id))}`;
          return { duplicate: false, jobs: 0 };
        }
        const triggerEvent =
          event.action === "create" ? "issue_created" : event.entered ? "entered_status" : null;
        const hints = !triggerEvent
          ? []
          : yield* sql<Rule>`SELECT workflow_id,repository_id,record,routing_generation,effective_after FROM relay_repository_workflows
      WHERE automation_enabled AND source_application_id=${config.applicationId} AND source_workspace_id=${event.workspaceId} AND trigger_team_id=${event.facts.teamId} AND trigger_event=${triggerEvent} ORDER BY workflow_id`;
        const records = yield* Effect.forEach(hints, (r) =>
          decodeWorkflow(r.record).pipe(Effect.map((record) => ({ ...r, record }))),
        );
        const orgs = [...new Set(records.map((r) => r.record.organizationId))].sort();
        const repos = [...new Set(records.map((r) => r.repository_id))].sort();
        const grantIds = [
          ...new Set(records.flatMap((r) => r.record.automation?.trigger?.grantId ?? [])),
        ].sort();
        const grantHints = grantIds.length
          ? yield* sql<Sources.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id IN ${sql.in(grantIds)}`
          : [];
        const owners = [...new Set(grantHints.map((g) => g.owner_user_id))].sort();
        const members =
          orgs.length && owners.length
            ? yield* sql<{
                organization_id: string;
                user_id: string;
              }>`SELECT organization_id,user_id FROM relay_organization_members WHERE organization_id IN ${sql.in(orgs)} AND user_id IN ${sql.in(owners)} ORDER BY organization_id,user_id FOR SHARE`
            : [];
        const repositories = repos.length
          ? yield* sql<{
              repository_id: string;
              organization_id: string;
            }>`SELECT repository_id,organization_id FROM relay_repositories WHERE repository_id IN ${sql.in(repos)} ORDER BY repository_id FOR SHARE`
          : [];
        const organizations = orgs.length
          ? yield* sql<{
              organization_id: string;
            }>`SELECT organization_id FROM relay_organizations WHERE organization_id IN ${sql.in(orgs)} ORDER BY organization_id FOR SHARE`
          : [];
        const connections =
          yield* sql<Sources.Connection>`SELECT * FROM relay_workflow_connections WHERE application_id=${config.applicationId} AND workspace_id=${event.workspaceId} ORDER BY connection_id FOR UPDATE`;
        const grants = grantIds.length
          ? yield* sql<
              Sources.Grant & { created_at: string }
            >`SELECT * FROM relay_workflow_repository_grants WHERE grant_id IN ${sql.in(grantIds)} ORDER BY grant_id FOR SHARE`
          : [];
        const ids = records.map((r) => r.workflow_id);
        const current = ids.length
          ? yield* sql<Rule>`SELECT workflow_id,repository_id,record,routing_generation,effective_after FROM relay_repository_workflows WHERE workflow_id IN ${sql.in(ids)} ORDER BY workflow_id FOR UPDATE`
          : [];
        const occurrenceTime = Date.parse(event.occurredAt);
        for (const c of connections) {
          if (
            !event.eligible ||
            c.status !== "connected" ||
            !c.payload_sealed ||
            occurrenceTime <= Date.parse(c.activated_at)
          )
            continue;
          const proof = Fence.evidence(c, config.generation) ?? {
            generation: config.generation,
            epoch: c.authorization_epoch,
            teams: {},
          };
          if (!proof.teams[event.facts.teamId] && Object.keys(proof.teams).length >= 256) continue;
          const old = proof.teams[event.facts.teamId] ?? { created: false, entered: false };
          const next = {
            ...old,
            created: old.created || event.action === "create",
            entered: old.entered || event.entered,
          };
          if (old.created === next.created && old.entered === next.entered) continue;
          const evidence = { ...proof, teams: { ...proof.teams, [event.facts.teamId]: next } };
          yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=${sql.json(evidence)} WHERE connection_id=${c.connection_id} AND authorization_epoch=${c.authorization_epoch}`;
          c.delivery_evidence = evidence;
        }
        const jobs: Array<typeof relayWorkflowJobs.$inferInsert> = [];
        const admissions: Array<typeof relayWorkflowAdmissions.$inferInsert> = [];
        for (const row of current) {
          const flow = yield* decodeWorkflow(row.record);
          const automation = flow.automation;
          const trigger = automation?.trigger;
          if (
            !config.admissionEnabled ||
            !automation?.enabled ||
            !trigger ||
            flow.archived ||
            !matches(trigger, event)
          )
            continue;
          const grant = grants.find(
            (g) =>
              g.grant_id === trigger.grantId &&
              g.connection_id === trigger.connectionId &&
              g.repository_id === row.repository_id &&
              g.organization_id === flow.organizationId &&
              !g.revoked,
          );
          const c = connections.find((c) => c.connection_id === trigger.connectionId);
          if (
            !grant ||
            !c ||
            c.owner_user_id !== grant.owner_user_id ||
            c.status !== "connected" ||
            !c.payload_sealed ||
            !members.some(
              (m) => m.organization_id === flow.organizationId && m.user_id === grant.owner_user_id,
            ) ||
            !repositories.some(
              (r) =>
                r.repository_id === row.repository_id && r.organization_id === flow.organizationId,
            ) ||
            !organizations.some((o) => o.organization_id === flow.organizationId) ||
            !Fence.covers(c, config.generation, trigger.teamId) ||
            !row.effective_after ||
            occurrenceTime <=
              Math.max(
                Date.parse(row.effective_after),
                Date.parse(c.activated_at),
                Date.parse(grant.created_at),
              )
          )
            continue;
          const jobId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
            Effect.mapError(() => new WebhookError({ status: 500, code: "identity_failed" })),
          );
          const record = yield* decodeJob({
            jobId,
            repositoryId: row.repository_id,
            workflowId: flow.workflowId,
            environmentId: flow.definition.environmentId,
            origin: {
              kind: "automation",
              organizationId: flow.organizationId,
              repositoryId: row.repository_id,
              workflowId: flow.workflowId,
              source: {
                provider: "linear",
                applicationId: config.applicationId,
                workspaceId: event.workspaceId,
                connectionId: c.connection_id,
                grantId: grant.grant_id,
              },
              occurrenceId,
            },
            event: event.facts,
            requiredProtocol: 8,
            instruction: `${event.facts.identifier}: ${event.facts.title}\nAwaiting issue context before starting.`,
            status: "queued",
            detail: "Automatic starts await event context and source validation.",
            workflow: null,
            progress: null,
            createdAt: stamp,
            updatedAt: stamp,
          });
          jobs.push({
            jobId,
            repositoryId: row.repository_id,
            organizationId: flow.organizationId,
            submitterUserId: null,
            repositoryCanonicalKey: null,
            status: "queued",
            record,
            revision: 0,
            leaseUntil: null,
            pendingControl: null,
            createdAt: stamp,
            checkedAt: stamp,
          });
          admissions.push({
            occurrenceId,
            workflowId: flow.workflowId,
            jobId,
            organizationId: flow.organizationId,
            repositoryId: row.repository_id,
            connectionId: c.connection_id,
            grantId: grant.grant_id,
            grantGeneration: grant.generation,
            authorizationEpoch: c.authorization_epoch,
            workflowRevision: flow.revision,
            routingGeneration: row.routing_generation,
          });
        }
        if (jobs.length) {
          yield* db.insert(relayWorkflowJobs).values(jobs);
          yield* db.insert(relayWorkflowAdmissions).values(admissions);
        }
        yield* sql`UPDATE relay_workflow_occurrences SET job_count=${jobs.length} WHERE occurrence_id=${occurrenceId}`;
        return { duplicate: false, jobs: jobs.length };
      }),
    )
    .pipe(
      Effect.mapError((e) =>
        isWebhookError(e) ? e : new WebhookError({ status: 500, code: "admission_failed" }),
      ),
    );
});
