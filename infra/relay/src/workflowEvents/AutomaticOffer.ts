import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  WORKFLOW_PROTOCOL,
  RepositoryWorkflow,
  WorkflowVmDispatchBinding,
} from "@t3tools/contracts/workflows";
import { RelayJobId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Workflows, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import { validateWorkflowTarget, lockWorkflowTarget } from "../jobs/WorkflowTarget.ts";
import * as Store from "../workflowSources/Store.ts";
import { readWorkflowVmBinding } from "../jobs/WorkflowVmBinding.ts";
import {
  blocked,
  originalAuthority,
  lockOriginalAuthority,
  readAdmittedIssue,
} from "./OriginalAuthority.ts";
export { WorkflowQueued } from "./OriginalAuthority.ts";
import * as Fence from "./Fence.ts";

const decodeWorkflow = Schema.decodeUnknownEffect(RepositoryWorkflow);

export const prepareAutomaticOffer = Effect.fn("workflowEvents.prepareAutomaticOffer")(function* (
  row: WorkflowJobRecord,
  leaseUntil: string,
) {
  const store = yield* Workflows;
  const sql = (yield* RelayDb).$client;
  const bound = yield* sql.withTransaction(originalAuthority(row));
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
  if (workflow.definition.target.kind !== "machine") return yield* blocked("target_invalid");
  const machineTarget = workflow.definition.target;
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
      environmentId: machineTarget.environmentId,
      jobId: RelayJobId.make(row.jobId),
      repositoryCanonicalKey: canonicalKey,
      baseBranch: "HEAD",
      instruction: row.record.instruction,
      workflowControl: {
        operation: "status",
        organizationId: row.organizationId,
        repositoryId: row.repositoryId,
        projectId: machineTarget.projectId,
      },
    })
    .pipe(Effect.mapError(() => blocked("environment_offline")));
  const capability = probe.workflowResult;
  if (
    !capability ||
    capability.protocol < WORKFLOW_PROTOCOL ||
    workflow.definition.steps.some(
      (s) => s.kind === "action" && !capability.actions?.includes(s.action),
    )
  )
    return yield* blocked("environment_update");
  if (capability.progress !== null || capability.outcome !== "missing")
    return yield* blocked("target_invalid");
  const context = yield* readAdmittedIssue(bound.connection, row.record.event!.issueId);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (origin.kind !== "automation") return yield* blocked("issue_context_invalid");
      const current = yield* lockOriginalAuthority(row);
      if (current.connection.authorization_epoch !== context.snapshot.authorizationEpoch)
        return yield* blocked("source_unavailable");
      const [saved] = yield* sql<{
        record: unknown;
      }>`SELECT record FROM relay_repository_workflows WHERE workflow_id=${workflow.workflowId} FOR UPDATE`;
      if (!saved) return yield* blocked("workflow_unavailable");
      const latest = yield* decodeWorkflow(saved.record);
      if (latest.definition.target.kind !== "machine") return yield* blocked("target_invalid");
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
          runtime: latest.definition.target,
          requiredProtocol: WORKFLOW_PROTOCOL,
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

const beginStart = Effect.fn("workflowEvents.beginStart")(function* (
  row: WorkflowJobRecord,
  leaseUntil: string,
  updatedAt: string,
) {
  const { origin, workflow, runtime, offerAuthority, issueSnapshot } = row.record;
  if (
    origin?.kind !== "automation" ||
    row.record.status !== "dispatching" ||
    row.record.startAttempted !== false ||
    row.record.progress ||
    row.pendingControl ||
    !offerAuthority ||
    !issueSnapshot
  )
    return yield* blocked("source_withdrawn");
  if (
    !workflow ||
    workflow.definition.target.kind !== "machine" ||
    runtime?.kind !== "machine" ||
    workflow.definition.target.environmentId !== runtime.environmentId ||
    workflow.definition.target.projectId !== runtime.projectId
  )
    return yield* blocked("target_invalid");
  const sql = (yield* RelayDb).$client;
  const store = yield* Workflows;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* lockOriginalAuthority(row);
      if (
        current.connection.authorization_epoch !== offerAuthority.authorizationEpoch ||
        current.connection.authorization_epoch !== issueSnapshot.authorizationEpoch ||
        current.grant.generation !== offerAuthority.grantGeneration
      )
        return yield* blocked("source_unavailable");
      const [saved] = yield* sql<{ record: unknown }>`SELECT record FROM relay_repository_workflows
        WHERE workflow_id=${workflow.workflowId} AND repository_id=${row.repositoryId} FOR SHARE`;
      if (!saved || (yield* decodeWorkflow(saved.record)).archived)
        return yield* blocked("workflow_unavailable");
      const target = yield* lockWorkflowTarget(
        row.organizationId,
        row.repositoryId,
        workflow.definition,
      ).pipe(Effect.mapError(() => blocked("target_invalid")));
      if (target !== row.repositoryCanonicalKey) return yield* blocked("target_invalid");
      // An Off or criteria-only Save changes future admission, not this offer's source.
      // The job revision and active lease also fence a cancellation recorded during the probe.
      return yield* store.updateJob(
        row,
        { ...row.record, startAttempted: true, updatedAt },
        row.pendingControl,
        false,
        leaseUntil,
      );
    }),
  );
});

const beginVmStart = Effect.fn("workflowEvents.beginVmStart")(function* (
  row: WorkflowJobRecord,
  leaseUntil: string,
  binding: WorkflowVmDispatchBinding,
  executionEnabled: boolean,
) {
  const { event, workflow, runtime, vmAdmission } = row.record;
  if (!executionEnabled) return yield* blocked("vm_execution_disabled");
  if (!event || !vmAdmission || workflow?.definition.target.kind !== "vm" || runtime?.kind !== "vm")
    return yield* blocked("target_invalid");
  const sql = (yield* RelayDb).$client;
  const store = yield* Workflows;
  const checkCodex = Effect.fnUntraced(function* (lock: boolean) {
    const codex = yield* store.getWorkflowVmCodexConnection(row.organizationId, lock);
    if (codex && codex.connectionId !== vmAdmission.codexConnectionId)
      return yield* blocked("vm_codex_replaced");
    if (codex?.status !== "connected") return yield* blocked("vm_waiting_codex");
  });
  yield* checkCodex(false);
  const bound = yield* sql.withTransaction(originalAuthority(row));
  const context = yield* readAdmittedIssue(bound.connection, event.issueId);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* lockOriginalAuthority(row);
      if (current.connection.authorization_epoch !== context.snapshot.authorizationEpoch)
        return yield* blocked("source_unavailable");
      const [saved] = yield* sql<{ record: unknown }>`SELECT record FROM relay_repository_workflows
        WHERE workflow_id=${workflow.workflowId} AND repository_id=${row.repositoryId} FOR SHARE`;
      if (!saved || (yield* decodeWorkflow(saved.record)).archived)
        return yield* blocked("workflow_unavailable");
      const [job] = yield* sql`SELECT job_id FROM relay_workflow_jobs
        WHERE job_id=${row.jobId} AND revision=${row.revision} AND lease_until=${leaseUntil}
          AND lease_until::timestamptz>clock_timestamp() AND status='preparing' AND pending_control IS NULL
          AND record->>'startAttempted'='false' AND record->'progress'='null'::jsonb
          FOR NO KEY UPDATE`;
      if (!job) return yield* blocked("source_unavailable");
      const vm = yield* readWorkflowVmBinding(sql, binding, "active", true).pipe(
        Effect.catchTag("RelayTenancyNotFoundError", () =>
          Effect.fail(blocked("environment_offline")),
        ),
      );
      if (
        !Schema.toEquivalence(WorkflowVmDispatchBinding)(vm.binding, binding) ||
        vm.snapshot.canonicalKey !== row.repositoryCanonicalKey
      )
        return yield* blocked("target_invalid");
      yield* checkCodex(true);
      return yield* store.updateJob(
        row,
        {
          ...row.record,
          issueSnapshot: context.snapshot,
          instruction: context.instruction,
          offerAuthority: {
            authorizationEpoch: current.connection.authorization_epoch,
            grantGeneration: current.grant.generation,
          },
          startAttempted: true,
          queueReason: null,
          detail: "Starting the workflow in its VM.",
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
    readonly beginStart: (
      row: WorkflowJobRecord,
      leaseUntil: string,
      updatedAt: string,
    ) => Effect.Effect<WorkflowJobRecord, Effect.Error<ReturnType<typeof beginStart>>>;
    readonly beginVmStart: (
      row: WorkflowJobRecord,
      leaseUntil: string,
      binding: WorkflowVmDispatchBinding,
      executionEnabled: boolean,
    ) => Effect.Effect<WorkflowJobRecord, Effect.Error<ReturnType<typeof beginVmStart>>>;
  }
>()("launchpad-relay/workflowEvents/AutomaticOffer/AutomaticOffers") {}
export const layer = Layer.effect(
  AutomaticOffers,
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof prepareAutomaticOffer>>>();
    return AutomaticOffers.of({
      prepare: (row, lease) => prepareAutomaticOffer(row, lease).pipe(Effect.provide(context)),
      beginStart: (row, lease, updatedAt) =>
        beginStart(row, lease, updatedAt).pipe(Effect.provide(context)),
      beginVmStart: (row, lease, binding, enabled) =>
        beginVmStart(row, lease, binding, enabled).pipe(Effect.provide(context)),
    });
  }),
);
