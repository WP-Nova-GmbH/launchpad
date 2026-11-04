import { ProviderDriverKind, ThreadId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import { RelayThreadVmInitialThread } from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  type RepositoryWorkflow,
  type WorkflowQueueReason,
} from "@t3tools/contracts/workflows";
import { jobBranchName } from "@t3tools/shared/workflowStorage";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayDb } from "../db.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { makeThreadVmCapacityStore } from "../threads/ThreadVmCapacityStore.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { queueReasonText } from "../workflowSources/IssueContext.ts";
import {
  withFrozenWorkflowRunConfiguration,
  WorkflowRunConfigurationError,
} from "./WorkflowRunConfiguration.ts";
import { Workflows, WorkflowPersistenceError, type WorkflowJobRecord } from "./Workflows.ts";
import { vmWorkflowDefinitionIssue } from "./WorkflowTarget.ts";
import { recheckWorkflowVmGitHub, resolveWorkflowVmGitHub } from "./WorkflowVmGithub.ts";

const unavailable = () => new WorkflowRunConfigurationError({ reason: "unavailable" });
const encodeInitialThread = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmInitialThread));

export const advanceWorkflowVmPreparation = Effect.fn("workflowVm.advancePreparation")(
  function* (row: WorkflowJobRecord, expectedLease: string) {
    const job = row.record;
    const admission = job.vmAdmission;
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!admission || isTerminalWorkflowJob(job.status)) return job;

    const sql = (yield* RelayDb).$client;
    const store = yield* Workflows;
    const capacity = makeThreadVmCapacityStore(sql);
    const [preparation] =
      job.runtime?.kind === "vm"
        ? yield* sql<{
            capacityState: string;
            allocationState: string;
            setupPhase: string | null;
            blocker: string | null;
          }>`SELECT c.state AS "capacityState",a.state AS "allocationState",s.phase AS "setupPhase",
          COALESCE(s.error_code,p.error_code) AS blocker
        FROM relay_thread_vm_capacity c
        JOIN relay_thread_vm_provisions p ON p.operation_id=c.operation_id AND p.allocation_id=c.allocation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=p.allocation_id
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id AND t.organization_id=a.organization_id
          AND t.repository_id=${row.repositoryId} AND t.workflow_job_id=${job.jobId}
          AND t.audience='repository' AND t.generation=p.generation
        LEFT JOIN relay_thread_vm_setups s ON s.allocation_id=a.allocation_id
        WHERE c.operation_id=${job.jobId} AND a.thread_id=${job.runtime.threadId}
          AND a.allocation_id=${job.jobId} AND a.organization_id=${row.organizationId}
          AND a.resource_kind='organization_workflow'`
        : [];
    // Setup failure and its deleting fence commit together. Later cancels cannot change that outcome.
    const checkoutFailed = job.startAttempted === false && preparation?.setupPhase === "failed";
    if (
      job.status === "cancelling" &&
      job.runtime?.kind === "vm" &&
      job.startAttempted === false &&
      !checkoutFailed &&
      row.pendingControl?.response.operation === "cancel"
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const authorized =
            job.vmCancellationConfirmed === true || (yield* store.canSettleVmCancellation(row));
          const [current] = yield* sql`SELECT job_id FROM relay_workflow_jobs
          WHERE job_id=${job.jobId} AND revision=${row.revision} AND lease_until=${expectedLease}
            AND lease_until::timestamptz>clock_timestamp() FOR NO KEY UPDATE`;
          if (!current) return (yield* store.getJob(job.jobId))?.record ?? job;
          if (!authorized)
            return (yield* store.updateJob(
              row,
              {
                ...job,
                status: "preparing",
                detail:
                  "Cancellation was withdrawn because the requester no longer has permission.",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
              null,
              false,
              expectedLease,
            )).record;
          const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
          WHERE workflow_job_id=${job.jobId} AND generation=1 AND thread_id=${`workflow:${job.jobId}`} FOR NO KEY UPDATE`;
          if (!placement) return job;
          const [allocation] = yield* sql<{ state: string; computeRef: string | null }>`
          SELECT state,compute_ref AS "computeRef" FROM relay_thread_vm_allocations
          WHERE allocation_id=${job.jobId} AND thread_id=${`workflow:${job.jobId}`}
            AND resource_kind='organization_workflow' FOR UPDATE`;
          const [provision] = yield* sql<{
            phase: string;
          }>`SELECT phase FROM relay_thread_vm_provisions
          WHERE allocation_id=${job.jobId} AND operation_id=${job.jobId} AND generation=1 FOR UPDATE`;
          if (!allocation || !provision) return job;
          if (
            allocation.state !== "deleted" &&
            provision.phase === "pending" &&
            allocation.computeRef === null
          ) {
            yield* capacity.cancelUnstarted(job.jobId);
            yield* sql`UPDATE relay_thread_vm_provisions SET phase='cancelled',claim_id=NULL,claim_until=NULL
            WHERE allocation_id=${job.jobId}`;
            yield* sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp()
            WHERE allocation_id=${job.jobId}`;
          } else if (allocation.state !== "deleted") {
            yield* sql`UPDATE relay_thread_vm_allocations SET state='deleting' WHERE allocation_id=${job.jobId}`;
            if (job.vmCancellationConfirmed === true) return job;
            return (yield* store.updateJob(
              row,
              {
                ...job,
                vmCancellationConfirmed: true,
                detail: "Cleaning up the workflow VM before execution.",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
              row.pendingControl,
              false,
              expectedLease,
            )).record;
          }
          return (yield* store.updateJob(
            row,
            {
              ...job,
              status: "cancelled",
              queueReason: null,
              detail: "Cancelled before workflow execution.",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
            null,
            false,
            expectedLease,
          )).record;
        }),
      );
    }
    // Confirmed deletion settles an interrupted run even if the guest can no longer respond.
    if (preparation?.allocationState === "deleted" && preparation.capacityState === "released") {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const operation = row.pendingControl?.response.operation;
          const cancelled =
            !checkoutFailed &&
            job.status === "cancelling" &&
            (job.vmCancellationConfirmed === true ||
              job.progress?.status === "cancelling" ||
              ((operation === "cancel" || operation === "retry_cancellation") &&
                (yield* store.canSettleVmCancellation(row))));
          const status = cancelled ? "cancelled" : "failed";
          const detail = checkoutFailed
            ? "Repository checkout failed. Start a new run to try again."
            : cancelled
              ? "Cancelled after the workflow VM stopped."
              : preparation.blocker === "workflow_template_stale"
                ? "The saved workflow VM build is no longer selected. Start a new run."
                : job.startAttempted === false
                  ? "The workflow VM stopped before execution began. Start a new run to try again."
                  : "The workflow VM was lost and its result could not be confirmed. Start a new run to try again.";
          return (yield* store.updateJob(
            row,
            {
              ...job,
              status,
              detail,
              queueReason: null,
              pendingManualControl: null,
              progress: job.progress && {
                ...job.progress,
                status,
                underlyingStatus: status,
                detail,
                manualPause: null,
                approvalPending: false,
                retryableApproval: false,
                retryableCancellation: false,
                retryablePreparation: false,
              },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
            null,
            false,
            expectedLease,
          )).record;
        }),
      );
    }
    if (preparation?.allocationState === "paused" && !checkoutFailed) {
      const detail =
        "The workflow VM is paused. This run is waiting for the VM to come back online.";
      if (
        job.detail === detail &&
        job.queueReason?.code === "environment_offline" &&
        job.queueReason.retryAt === null
      )
        return job;
      return (yield* store.updateJob(
        row,
        {
          ...job,
          detail,
          queueReason: { code: "environment_offline", retryAt: null },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
        row.pendingControl,
        false,
        expectedLease,
      )).record;
    }
    if (job.status === "preparing" || checkoutFailed) {
      if (!preparation) return job;
      const status = "preparing";
      let detail = "Preparing the workflow VM.";
      let code: WorkflowQueueReason["code"] | null = null;
      if (checkoutFailed) {
        detail = "Repository checkout failed. Cleaning up the workflow VM.";
      } else if (preparation.capacityState === "waiting") {
        if (preparation.blocker === "workflow_codex_unavailable") {
          code = "vm_waiting_codex";
          detail = queueReasonText[code];
        } else if (preparation.blocker === "workflow_template_unverified") {
          code = "target_invalid";
          detail = "The saved workflow VM build could not be verified. Waiting to retry.";
        } else if (preparation.blocker === "workflow_disabled") {
          code = "target_invalid";
          detail = "Workflow VM starts are disabled. This preparation will wait.";
        } else {
          code = "vm_waiting_capacity";
          detail = queueReasonText[code];
        }
      } else if (preparation.blocker === "setup_access_denied") {
        code = "target_invalid";
        detail =
          "The VM could not access the repository. Check the GitHub App's repository access.";
      } else if (preparation.blocker === "startup_access_denied") {
        code = "target_invalid";
        detail =
          "The workflow VM no longer has access to its repository. Check the repository settings.";
      } else if (preparation.blocker === "setup_unconfirmed") {
        detail = "Repository checkout could not be confirmed. Retrying VM setup.";
      } else if (preparation.blocker === "startup_unconfirmed") {
        detail = "The workflow VM server has not confirmed startup. Retrying.";
      }
      if (
        job.status === status &&
        job.detail === detail &&
        (job.queueReason?.code ?? null) === code
      )
        return job;
      return (yield* store.updateJob(
        row,
        {
          ...job,
          status,
          detail,
          queueReason: code ? { code, retryAt: null } : null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
        null,
        false,
        expectedLease,
      )).record;
    }
    if (!settings || job.status !== "queued") return job;
    const operationId = job.jobId;
    const threadId = ThreadId.make(`workflow:${job.jobId}`);
    const identity = {
      jobId: job.jobId,
      organizationId: row.organizationId,
      repositoryId: row.repositoryId,
      threadId,
    };

    // Capacity waits need a durable position but no usable placement or guest authority.
    yield* capacity.configure(settings.hostId, settings.maxRunningVms);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [current] = yield* sql`SELECT job_id FROM relay_workflow_jobs
          WHERE job_id=${job.jobId} AND status='queued' AND pending_control IS NULL
            AND revision=${row.revision} AND lease_until=${expectedLease}
            AND lease_until::timestamptz>clock_timestamp() FOR NO KEY UPDATE`;
        if (!current) return yield* unavailable();
        yield* makeThreadPlacementStore(sql).prepareWorkflow({
          ...identity,
          workflowJobId: job.jobId,
          operationId,
          waiting: true,
        });
        yield* sql`INSERT INTO relay_thread_vm_allocations
          (allocation_id,thread_id,organization_id,resource_kind,template_id,state)
          VALUES (${job.jobId},${threadId},${row.organizationId},'organization_workflow',${settings.compute.templateId},'creating')
          ON CONFLICT DO NOTHING`;
        const [allocation] = yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
          WHERE allocation_id=${job.jobId} AND thread_id=${threadId} AND organization_id=${row.organizationId}
            AND resource_kind='organization_workflow' AND runtime_protocol='native-v1' AND state='creating'`;
        if (!allocation) return yield* unavailable();
        yield* capacity.request({
          operationId,
          allocationId: job.jobId,
          hostId: settings.hostId,
          kind: "create",
        });
      }),
    );
    if (
      settings.workflowExecutionEnabled !== true ||
      job.queueReason?.code !== "vm_waiting_capacity"
    )
      return job;

    const block = Effect.fnUntraced(function* (detail: string) {
      const timestamp = yield* DateTime.now;
      return (yield* store.updateJob(
        row,
        {
          ...job,
          queueReason: { code: "target_invalid", retryAt: timestamp.epochMilliseconds + 30_000 },
          detail,
          updatedAt: DateTime.formatIso(timestamp),
        },
        null,
        false,
        expectedLease,
      )).record;
    });
    const definition = yield* store.get(job.workflowId);
    if (!definition || definition.archived || definition.definition.target.kind !== "vm")
      return job;
    if (definition.definition.steps.some((step) => step.kind === "action"))
      return yield* block("Remove Push and Open PR before this VM workflow can start.");
    const modelIssue = vmWorkflowDefinitionIssue(
      definition.definition.target.baseBranch,
      definition.definition.steps,
      settings.workflowModelCatalog ?? null,
    );
    if (!settings.workflowModelCatalog || modelIssue)
      return yield* block(modelIssue ?? "Verify the workflow VM build before starting this run.");
    if (!(yield* capacity.hasWorkflowSlot(settings.hostId, row.organizationId))) return job;
    const app = yield* Effect.serviceOption(GithubApp);
    if (Option.isNone(app)) return yield* block("Configure the organization's GitHub App.");
    const git = yield* resolveWorkflowVmGitHub({
      ...identity,
      baseBranch: definition.definition.target.baseBranch,
    }).pipe(
      Effect.provideService(GithubApp, app.value),
      Effect.catchTag("WorkflowInvalidError", ({ message }) => block(message)),
    );
    if ("jobId" in git) return git;

    const catalog = settings.workflowModelCatalog;
    const box = yield* RelaySecretBox;
    const freeze = yield* withFrozenWorkflowRunConfiguration(
      sql,
      box,
      identity,
      Effect.gen(function* () {
        const [current] = yield* sql<{ record: RepositoryWorkflow; revision: number }>`
          SELECT record,revision FROM relay_repository_workflows WHERE workflow_id=${job.workflowId}
            AND repository_id=${row.repositoryId} FOR SHARE`;
        if (current?.revision !== definition.revision) return yield* unavailable();
        const reserved = yield* capacity.admitNext(settings.hostId, {
          workflowEnabled: true,
          workflowOperationId: operationId,
        });
        if (!reserved) return yield* unavailable();
        yield* recheckWorkflowVmGitHub(sql, identity, git);
        const codex = yield* store.getWorkflowVmCodexConnection(row.organizationId, true);
        if (codex?.status !== "connected" || codex.connectionId !== admission.codexConnectionId)
          return yield* unavailable();
        yield* sql`UPDATE relay_thread_vm_allocations SET template_id=${settings.compute.templateId}
          WHERE allocation_id=${job.jobId}`;
        yield* sql`INSERT INTO relay_thread_vm_provisions
          (allocation_id,operation_id,generation,workflow_snapshot)
          VALUES (${job.jobId},${operationId},1,${sql.json({ ...git, templateBuildId: settings.templateBuildId })})`;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        const model = definition.definition.steps.find(
          (step) => step.kind === "agent",
        )?.modelSelection;
        const initialState = yield* encodeInitialThread({
          title: definition.definition.name,
          createdAt: timestamp,
          modelSelection: model ?? {
            instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
            model: catalog.defaultModel,
          },
        });
        yield* sql`INSERT INTO relay_thread_vm_setups (allocation_id,canonical_key,branch,revision,initial_state)
          VALUES (${job.jobId},${git.canonicalKey},${jobBranchName(job.jobId)},${git.commitSha},${initialState})`;
        yield* store.updateJob(
          { ...row, repositoryCanonicalKey: git.canonicalKey },
          {
            ...job,
            workflow: definition,
            status: "preparing",
            runtime: { kind: "vm", threadId },
            startAttempted: false,
            queueReason: null,
            detail: "Preparing the workflow VM.",
            updatedAt: timestamp,
          },
          null,
          false,
          expectedLease,
        );
      }),
    ).pipe(Effect.result);
    if (freeze._tag === "Success") return (yield* store.getJob(job.jobId))?.record ?? job;
    if (freeze.failure.reason === "not_allowed") return yield* block(freeze.failure.message);
    if (freeze.failure.reason === "storage")
      return yield* new WorkflowPersistenceError({ cause: freeze.failure });
    return (yield* store.getJob(job.jobId))?.record ?? job;
  },
  Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })),
);

export class WorkflowVmPreparation extends Context.Service<
  WorkflowVmPreparation,
  {
    readonly advance: (
      ...args: Parameters<typeof advanceWorkflowVmPreparation>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof advanceWorkflowVmPreparation>>,
      Effect.Error<ReturnType<typeof advanceWorkflowVmPreparation>>
    >;
  }
>()("launchpad-relay/jobs/WorkflowVmPreparation") {}

export const workflowVmPreparationLayer = Layer.effect(
  WorkflowVmPreparation,
  Effect.gen(function* () {
    const dependencies = yield* Effect.context<
      Effect.Services<ReturnType<typeof advanceWorkflowVmPreparation>> | GithubApp
    >();
    return WorkflowVmPreparation.of({
      advance: (...args) =>
        advanceWorkflowVmPreparation(...args).pipe(Effect.provide(dependencies)),
    });
  }),
);
