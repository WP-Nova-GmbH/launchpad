import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
import {
  WorkflowDefinition,
  WorkflowConflictError,
  WorkflowInvalidError,
  WorkflowManualControl,
  isTerminalWorkflowJob,
  type RespondToWorkflowJob,
  type RunRepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { summaries as automationSummaries } from "../workflowEvents/Summaries.ts";
import { targetKey } from "../workflowEvents/Routing.ts";
import { prepare as prepareAutomationSave } from "../workflowEvents/Preparation.ts";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import { Workflows, WorkflowPersistenceError, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import { refreshWorkflowJob } from "../jobs/WorkflowDispatcher.ts";
import {
  validateWorkflowTarget,
  vmWorkflowDefinitionIssue,
  vmWorkflowExecutionUnavailable,
  workflowRunTargetChanged,
} from "../jobs/WorkflowTarget.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import {
  resolveMembership,
  requireVisibleRepository,
  requireMaintainableRepository,
} from "./TenancyApi.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";

const jobForClient = (row: WorkflowJobRecord) => ({
  ...row.record,
  responsePending: row.pendingControl !== null && !isTerminalWorkflowJob(row.record.status),
});

export const refreshWorkflowJobForClient = Effect.fn("WorkflowsApi.refreshForClient")(function* (
  jobId: string,
) {
  const store = yield* Workflows;
  let row = yield* store.getJob(jobId);
  if (!row) return null;
  if (row.record.origin?.kind === "automation") {
    yield* wakeWorkflows({ occurrenceId: row.record.origin.occurrenceId });
  } else {
    yield* refreshWorkflowJob(jobId);
    row = yield* store.getJob(jobId);
  }
  return row ? jobForClient(row) : null;
});

export const authorizeWorkflowRepository = Effect.fn("WorkflowsApi.authorize")(function* (
  repositoryId: string,
  maintain = false,
) {
  const { userId } = yield* RelayClientPrincipal;
  const membership = yield* resolveMembership({ userId });
  if (maintain) yield* requireMaintainableRepository({ membership, repositoryId });
  else yield* requireVisibleRepository({ membership, repositoryId });
  return membership;
});
const isInvalid = Schema.is(WorkflowInvalidError);
const sameManualControl = Schema.toEquivalence(WorkflowManualControl);
export const respondToWorkflowJob = Effect.fn("WorkflowsApi.respond")(function* (
  params: { readonly repositoryId: string; readonly jobId: string },
  payload: typeof RespondToWorkflowJob.Type,
) {
  const membership = yield* authorizeWorkflowRepository(params.repositoryId);
  const store = yield* Workflows;
  const row = yield* store.getJob(params.jobId);
  if (!row || row.repositoryId !== params.repositoryId)
    return yield* tenancyNotFound("repository_not_found");
  const checkpointResponse =
    payload.operation === "approve" ||
    payload.operation === "input" ||
    payload.operation === "request_changes";
  if (!checkpointResponse || row.record.progress?.checkpoint?.role !== "member")
    yield* requireMaintainableRepository({ membership, repositoryId: params.repositoryId });
  if (payload.operation === "retry_action") {
    const pending = row.pendingControl;
    if (
      pending?.response.operation === "retry_action" &&
      pending.response.actionId === payload.actionId &&
      pending.response.expectedRevision === payload.expectedRevision
    ) {
      if (pending.userId !== membership.userId)
        return yield* new WorkflowConflictError({
          message: "This retry belongs to another request.",
        });
      return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
    }
    const receipt = row.record.progress?.actions?.find(
      (action) => action.actionId === payload.actionId,
    );
    if (!pending && receipt?.retryRevision === payload.expectedRevision)
      return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
  }
  const manual = payload.operation === "pause" || payload.operation === "resume";
  if (manual) {
    const pending = row.pendingControl?.response;
    if (pending?.operation === "pause" || pending?.operation === "resume") {
      if (pending.controlId === payload.controlId) {
        if (
          !sameManualControl(pending, payload) ||
          row.pendingControl?.userId !== membership.userId
        )
          return yield* new WorkflowConflictError({
            message: "This control identity belongs to another request.",
          });
        return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
      }
    }
    const receipt = row.record.progress?.lastManualControl;
    if (receipt?.controlId === payload.controlId && !row.pendingControl) {
      if (!sameManualControl(receipt, payload))
        return yield* new WorkflowConflictError({
          message: "This control identity belongs to another request.",
        });
      return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
    }
    const progress = row.record.progress;
    if (!progress?.manualPauseSupported)
      return yield* new WorkflowInvalidError({
        message: "Pause/Resume requires an accepted ordered job on an updated environment.",
      });
    if (progress.revision !== payload.expectedRevision)
      return yield* new WorkflowConflictError({
        message: "This job changed. Refresh before changing its pause state.",
      });
    if (
      row.status === "cancelling" ||
      isTerminalWorkflowJob(row.status) ||
      (payload.operation === "pause" &&
        (progress.manualPause ||
          ![
            "preparing",
            "running",
            "awaiting_review",
            "awaiting_input",
            "waiting_capacity",
          ].includes(progress.underlyingStatus ?? progress.status))) ||
      (payload.operation === "resume" && !progress.manualPause)
    )
      return yield* new WorkflowConflictError({
        message: "This job cannot change its manual pause in the current state.",
      });
  }
  if (row.record.progress?.manualPause && !manual && payload.operation !== "cancel")
    return yield* new WorkflowConflictError({
      message: "Resume the manual pause before responding or retrying.",
    });
  if (isTerminalWorkflowJob(row.status)) return jobForClient(row);
  if (payload.operation === "cancel" && row.status === "cancelling") return jobForClient(row);
  if (
    (row.pendingControl &&
      !(payload.operation === "cancel" && row.pendingControl.response.operation !== "cancel")) ||
    (row.status === "cancelling" && payload.operation !== "retry_cancellation")
  )
    return yield* new WorkflowConflictError({
      message: "A response is already waiting for acknowledgement. Refresh the job.",
    });
  if (payload.operation === "retry_action") {
    const progress = row.record.progress;
    const action = progress?.actions?.findLast((entry) => entry.actionId === payload.actionId);
    if (
      !progress ||
      progress.revision !== payload.expectedRevision ||
      !action?.retryable ||
      action.stepId !== progress.stepId ||
      action.generation !== progress.generation
    )
      return yield* new WorkflowConflictError({
        message: "This publishing action changed. Refresh before retrying.",
      });
  }
  if (
    payload.operation === "retry_cancellation" &&
    (row.record.progress?.status !== "cancelling" ||
      !row.record.progress.retryableCancellation ||
      payload.expectedRevision !== row.record.progress?.revision)
  )
    return yield* new WorkflowConflictError({
      message: "This cancellation changed. Refresh before retrying.",
    });
  if (
    payload.operation === "retry_preparation" &&
    (row.record.progress?.status !== "paused" ||
      !row.record.progress.retryablePreparation ||
      payload.expectedRevision !== row.record.progress?.revision)
  )
    return yield* new WorkflowConflictError({
      message: "This preparation changed. Refresh before retrying.",
    });
  if (
    (payload.operation === "approve" ||
      payload.operation === "input" ||
      payload.operation === "request_changes") &&
    (!(payload.operation === "input"
      ? row.record.progress?.status === "awaiting_input"
      : row.record.progress?.status === "awaiting_review" ||
        (payload.operation === "approve" &&
          row.record.progress?.status === "finishing" &&
          row.record.progress.retryableApproval)) ||
      (row.record.progress?.approvalPending && !row.record.progress?.retryableApproval) ||
      payload.expectedRevision !== row.record.progress?.revision ||
      payload.checkpointId !== row.record.progress?.checkpoint?.checkpointId)
  )
    return yield* new WorkflowConflictError({
      message: "This review changed. Refresh before approving.",
    });
  const requiredProtocol = row.record.requiredProtocol ?? 2;
  yield* store.updateJob(
    row,
    {
      ...row.record,
      ...(manual
        ? {
            requiredProtocol: requiredProtocol >= 6 ? requiredProtocol : 6,
            pendingManualControl: payload,
          }
        : payload.operation === "cancel"
          ? { pendingManualControl: null }
          : {}),
      ...(payload.operation === "input" || payload.operation === "request_changes"
        ? {
            requiredProtocol: requiredProtocol >= 5 ? requiredProtocol : 5,
          }
        : {}),
      ...(payload.operation === "cancel"
        ? {
            status: "cancelling" as const,
            detail: "Cancellation requested; waiting for the environment.",
            progress: row.record.progress
              ? { ...row.record.progress, approvalPending: false, retryableApproval: false }
              : null,
          }
        : {
            detail: manual
              ? "Pause/Resume request saved; waiting for the environment."
              : "Response saved; waiting for the environment.",
          }),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    },
    { userId: membership.userId, response: payload },
  );
  return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
});
const errors = mapRelayCommonApiErrors("not_authorized");
const sameDefinition = Schema.toEquivalence(WorkflowDefinition);
const vmModels = ThreadVmRuntimeConfiguration.pipe(
  Effect.map(({ settings }) => settings?.workflowModelCatalog ?? null),
);
export const saveRepositoryWorkflow = Effect.fn("WorkflowsApi.save")(function* (
  repositoryId: string,
  payload: typeof import("@t3tools/contracts/workflows").SaveRepositoryWorkflow.Type,
) {
  const membership = yield* authorizeWorkflowRepository(repositoryId, true);
  const store = yield* Workflows;
  const previous = yield* store.get(payload.workflowId);
  if (
    payload.definition.target.kind === "vm" &&
    ((previous && previous.repositoryId !== repositoryId) ||
      (previous?.revision ?? 0) !== payload.expectedRevision)
  ) {
    return yield* new WorkflowConflictError({
      message: "This workflow changed. Reload it before saving; your draft has been retained.",
    });
  }
  const saveContext = yield* prepareAutomationSave(
    membership.organization.organizationId,
    repositoryId,
    membership.userId,
    payload,
    previous,
  ).pipe(
    Effect.mapError((cause) =>
      isInvalid(cause) ? cause : new WorkflowPersistenceError({ cause }),
    ),
  );
  if (payload.definition.target.kind === "vm") {
    const lifecycleOnly =
      previous?.repositoryId === repositoryId &&
      previous.archived !== payload.archived &&
      sameDefinition(previous.definition, payload.definition);
    if (!lifecycleOnly) {
      const issue = vmWorkflowDefinitionIssue(
        payload.definition.target.baseBranch,
        payload.definition.steps,
        yield* vmModels,
      );
      if (issue) return yield* new WorkflowInvalidError({ message: issue });
    }
  } else if (
    !payload.archived &&
    !payload.automation?.enabled &&
    (!previous ||
      previous.repositoryId !== repositoryId ||
      previous.archived ||
      targetKey(previous.definition) !== targetKey(payload.definition) ||
      !previous.automation?.trigger)
  )
    yield* validateWorkflowTarget(
      membership.organization.organizationId,
      repositoryId,
      payload.definition,
    );
  return yield* store.save(
    membership.organization.organizationId,
    repositoryId,
    payload,
    saveContext,
  );
});

export const runRepositoryWorkflow = Effect.fn("WorkflowsApi.run")(function* (
  repositoryId: string,
  payload: typeof RunRepositoryWorkflow.Type,
) {
  const membership = yield* authorizeWorkflowRepository(repositoryId);
  const store = yield* Workflows;
  const workflow = yield* store.get(payload.workflowId);
  if (!workflow || workflow.repositoryId !== repositoryId)
    return yield* tenancyNotFound("repository_not_found");
  if (workflow.archived)
    return yield* new WorkflowInvalidError({ message: "Restore this workflow before running it." });
  if (workflow.definition.target.kind !== payload.expectedTargetKind)
    return yield* workflowRunTargetChanged();
  if (workflow.definition.target.kind === "vm") return yield* vmWorkflowExecutionUnavailable();
  yield* validateWorkflowTarget(
    membership.organization.organizationId,
    repositoryId,
    workflow.definition,
  );
  const jobId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
    Effect.catch(() => relayInternalErrorResponse("internal_error")),
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  const job = {
    origin: { kind: "manual" as const, userId: membership.userId },
    jobId,
    repositoryId,
    workflowId: workflow.workflowId,
    runtime: null,
    instruction: payload.instruction,
    status: "queued" as const,
    detail: null,
    workflow: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* store.createManualJob(
    {
      jobId,
      repositoryId,
      organizationId: membership.organization.organizationId,
      submitterUserId: membership.userId,
      repositoryCanonicalKey: null,
      status: "queued",
      record: job,
      revision: 0,
      leaseUntil: null,
      pendingControl: null,
      createdAt: now,
      checkedAt: now,
    },
    { expectedRevision: workflow.revision, expectedTargetKind: payload.expectedTargetKind },
  );
  return (yield* refreshWorkflowJobForClient(jobId)) ?? job;
});

export const workflowsApi = HttpApiBuilder.group(RelayApi, "workflows", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        return {
          workflows: yield* (yield* Workflows).list(params.repositoryId),
          automationSupported: true,
          automationSummaries: yield* automationSummaries(params.repositoryId).pipe(
            Effect.mapError((cause) => new WorkflowPersistenceError({ cause })),
          ),
          vmAuthoring: { models: yield* vmModels },
        };
      }).pipe(errors),
    )
    .handle("save", ({ params, payload }) =>
      saveRepositoryWorkflow(params.repositoryId, payload).pipe(errors),
    )
    .handle("listJobs", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        return {
          jobs: (yield* (yield* Workflows).listJobs(params.repositoryId)).map(({ record }) => ({
            jobId: record.jobId,
            repositoryId: record.repositoryId,
            workflowId: record.workflowId,
            runtime: record.runtime,
            instruction: record.instruction.slice(0, 280),
            status: record.status,
            detail: record.detail?.slice(0, 500) ?? null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })),
        };
      }).pipe(errors),
    )
    .handle("pageJobs", ({ params, query }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        return yield* (yield* Workflows).pageJobs(params.repositoryId, query);
      }).pipe(errors),
    )
    .handle("run", ({ params, payload }) =>
      runRepositoryWorkflow(params.repositoryId, payload).pipe(errors),
    )
    .handle("getJob", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        const row = yield* (yield* Workflows).getJob(params.jobId);
        if (!row || row.repositoryId !== params.repositoryId)
          return yield* tenancyNotFound("repository_not_found");
        return (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
      }).pipe(errors),
    )
    .handle("respond", ({ params, payload }) => respondToWorkflowJob(params, payload).pipe(errors)),
);
