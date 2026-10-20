import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { RepositoryWorkflow, WorkflowQueueReason } from "@t3tools/contracts/workflows";
import { RelayJobId, WorkflowSourceError } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Workflows, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import { validateWorkflowTarget, lockWorkflowTarget } from "../jobs/WorkflowTarget.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Sources from "../workflowSources/Sources.ts";
import * as Issue from "../workflowSources/IssueContext.ts";
import * as Fence from "./Fence.ts";

export class WorkflowQueued extends Schema.TaggedError<WorkflowQueued>()(
  "WorkflowQueued",
  WorkflowQueueReason.fields,
) {}
const blocked = (code: WorkflowQueueReason["code"], retryAt: number | null = null) =>
  new WorkflowQueued({ code, retryAt });
const isSourceError = Schema.is(WorkflowSourceError);
const decodeWorkflow = Schema.decodeUnknownEffect(RepositoryWorkflow);

/** This reads no provider data and holds authority only for its calling transaction. */
const authority = Effect.fn("workflowEvents.originalAuthority")(function* (row: WorkflowJobRecord) {
  const origin = row.record.origin;
  if (origin?.kind !== "automation" || !row.record.event)
    return yield* blocked("issue_context_invalid");
  const sql = (yield* RelayDb).$client;
  const [admission] = yield* sql<{
    grant_generation: number;
    connection_id: string;
    grant_id: string;
  }>`SELECT grant_generation,connection_id,grant_id FROM relay_workflow_admissions WHERE job_id=${row.jobId} AND occurrence_id=${origin.occurrenceId} AND workflow_id=${row.record.workflowId} AND organization_id=${row.organizationId} AND repository_id=${row.repositoryId}`;
  if (
    !admission ||
    admission.connection_id !== origin.source.connectionId ||
    admission.grant_id !== origin.source.grantId
  )
    return yield* blocked("source_withdrawn");
  const hint = yield* Store.connection(origin.source.connectionId);
  if (!hint) return yield* blocked("source_withdrawn");
  const [member] =
    yield* sql`SELECT user_id FROM relay_organization_members WHERE organization_id=${row.organizationId} AND user_id=${hint.owner_user_id} FOR SHARE`;
  if (!member) return yield* blocked("source_owner_ineligible");
  const bound = yield* Store.authority(row.repositoryId, origin.source.grantId).pipe(
    Effect.catchIf(isSourceError, (error) =>
      Effect.fail(
        blocked(error.code === "reconnect_required" ? "source_reconnect" : "source_withdrawn"),
      ),
    ),
  );
  if (
    bound.connection.connection_id !== origin.source.connectionId ||
    bound.connection.application_id !== origin.source.applicationId ||
    bound.connection.workspace_id !== origin.source.workspaceId ||
    bound.grant.generation !== admission.grant_generation ||
    (yield* Sources.configuredApp) !== origin.source.applicationId
  )
    return yield* blocked("source_withdrawn");
  return bound;
});

export const prepareAutomaticOffer = Effect.fn("workflowEvents.prepareAutomaticOffer")(function* (
  row: WorkflowJobRecord,
  leaseUntil: string,
) {
  const store = yield* Workflows;
  const sql = (yield* RelayDb).$client;
  const bound = yield* sql.withTransaction(authority(row));
  const retryAt = bound.connection.health.retryAt;
  if (retryAt && retryAt > (yield* Store.now))
    return yield* blocked(
      bound.connection.health.code === "rate_limited"
        ? "source_rate_limited"
        : "source_unavailable",
      retryAt,
    );
  const workflow = yield* store.get(row.record.workflowId);
  if (!workflow || workflow.archived) return yield* blocked("workflow_unavailable");
  const canonicalKey = yield* validateWorkflowTarget(
    row.organizationId,
    row.repositoryId,
    workflow.definition,
  ).pipe(Effect.mapError(() => blocked("target_invalid")));
  const origin = row.record.origin!;
  const probe = yield* (yield* EnvironmentConnector)
    .dispatchJob({
      userId: null,
      workflowOrigin: origin,
      environmentId: workflow.definition.environmentId,
      jobId: RelayJobId.make(row.jobId),
      repositoryCanonicalKey: canonicalKey,
      baseBranch: "HEAD",
      instruction: row.record.instruction,
      workflowControl: {
        operation: "status",
        organizationId: row.organizationId,
        repositoryId: row.repositoryId,
        projectId: workflow.definition.projectId,
      },
    })
    .pipe(Effect.mapError(() => blocked("environment_offline")));
  const capability = probe.workflowResult;
  if (
    !capability ||
    capability.protocol < 8 ||
    workflow.definition.steps.some(
      (s) => s.kind === "action" && !capability.actions?.includes(s.action),
    )
  )
    return yield* blocked("environment_update");
  if (capability.progress !== null || capability.outcome !== "missing")
    return yield* blocked("target_invalid");
  const context = yield* Issue.readIssue(bound.connection, row.record.event!.issueId).pipe(
    Effect.catchTag("IssueContextError", (error) => Effect.fail(blocked(error.code))),
    Effect.catchIf(isSourceError, (error) =>
      Effect.fail(
        blocked(
          error.code === "reconnect_required"
            ? "source_reconnect"
            : error.code === "service_configuration"
              ? "source_configuration"
              : error.code === "rate_limited"
                ? "source_rate_limited"
                : error.code === "forbidden" || error.code === "not_found"
                  ? "issue_unavailable"
                  : error.code === "invalid_input"
                    ? "issue_context_invalid"
                    : "source_unavailable",
          error.retryAt ?? null,
        ),
      ),
    ),
  );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (origin.kind !== "automation") return yield* blocked("issue_context_invalid");
      yield* Fence.lock(origin.source.applicationId, origin.source.workspaceId);
      const current = yield* authority(row);
      if (current.connection.authorization_epoch !== context.snapshot.authorizationEpoch)
        return yield* blocked("source_unavailable");
      const [saved] = yield* sql<{
        record: unknown;
      }>`SELECT record FROM relay_repository_workflows WHERE workflow_id=${workflow.workflowId} FOR UPDATE`;
      if (!saved) return yield* blocked("workflow_unavailable");
      const latest = yield* decodeWorkflow(saved.record);
      if (latest.archived) return yield* blocked("workflow_unavailable");
      if (latest.revision !== workflow.revision)
        return yield* blocked("workflow_changed", (yield* Store.now) + 1000);
      const target = yield* lockWorkflowTarget(
        row.organizationId,
        row.repositoryId,
        latest.definition,
      ).pipe(Effect.mapError(() => blocked("target_invalid")));
      if (target !== canonicalKey) return yield* blocked("target_invalid");
      const [job] = yield* sql<{
        revision: number;
        lease_until: string | null;
        pending_control: unknown;
        record: { workflow: unknown; status: string };
      }>`SELECT revision,lease_until,pending_control,record FROM relay_workflow_jobs WHERE job_id=${row.jobId} FOR UPDATE`;
      if (
        !job ||
        job.revision !== row.revision ||
        job.lease_until !== leaseUntil ||
        Date.parse(leaseUntil) <= (yield* Store.now) ||
        job.pending_control ||
        job.record.workflow !== null ||
        job.record.status !== "queued"
      )
        return yield* blocked("source_unavailable");
      return yield* store.updateJob(
        { ...row, repositoryCanonicalKey: canonicalKey },
        {
          ...row.record,
          workflow: latest,
          environmentId: latest.definition.environmentId,
          requiredProtocol: 8,
          issueSnapshot: context.snapshot,
          instruction: context.instruction,
          startAttempted: false,
          offerAuthority: {
            authorizationEpoch: current.connection.authorization_epoch,
            grantGeneration: current.grant.generation,
          },
          queueReason: null,
          status: "dispatching",
          detail: "Offering this workflow to its environment.",
          updatedAt: yield* Fence.timestamp,
        },
        null,
        false,
        leaseUntil,
      );
    }),
  );
});

export class AutomaticOffers extends Context.Service<
  AutomaticOffers,
  {
    readonly prepare: (
      row: WorkflowJobRecord,
      leaseUntil: string,
    ) => Effect.Effect<WorkflowJobRecord, Effect.Error<ReturnType<typeof prepareAutomaticOffer>>>;
  }
>()("launchpad-relay/workflowEvents/AutomaticOffer/AutomaticOffers") {}
export const layer = Layer.effect(
  AutomaticOffers,
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof prepareAutomaticOffer>>>();
    return AutomaticOffers.of({
      prepare: (row, lease) => prepareAutomaticOffer(row, lease).pipe(Effect.provide(context)),
    });
  }),
);
