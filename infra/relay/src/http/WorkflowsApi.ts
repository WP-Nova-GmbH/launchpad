import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
import {
  WorkflowDefinition,
  WorkflowConflictError,
  WorkflowInvalidError,
  WorkflowManualControl,
  WorkflowSubmissionPendingError,
  isTerminalWorkflowJob,
  type RespondToWorkflowJob,
  type RunRepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
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
import { GithubApp } from "../tenancy/GithubApp.ts";
import { resolveWorkflowVmGitHub } from "../jobs/WorkflowVmGithub.ts";
import {
  readWorkflowVmBinding,
  requireWorkflowVmViewer,
  workflowVmHasSecrets,
} from "../jobs/WorkflowVmBinding.ts";
import { RelayDb } from "../db.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import {
  resolveMembership,
  requireVisibleRepository,
  requireMaintainableRepository,
} from "./TenancyApi.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";

const jobForClient = (row: WorkflowJobRecord) => {
  const operation = row.pendingControl?.response.operation;
  return {
    ...row.record,
    responsePending: row.pendingControl !== null && !isTerminalWorkflowJob(row.record.status),
    ...(operation === "approve" || operation === "input" || operation === "request_changes"
      ? { pendingResponseOperation: operation }
      : {}),
  };
};

const hasFrozenVmSecrets = Effect.fnUntraced(function* (jobId: string) {
  const db = yield* Effect.serviceOption(RelayDb);
  if (Option.isNone(db)) return true;
  return yield* workflowVmHasSecrets(db.value.$client, jobId).pipe(
    Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })),
  );
});

const mayCancelOwnVm = Effect.fnUntraced(function* (row: WorkflowJobRecord, userId: string) {
  const job = row.record;
  if (!job.vmAdmission || row.submitterUserId !== userId || job.origin?.kind !== "manual")
    return false;
  if (job.runtime?.kind === "vm") return !(yield* hasFrozenVmSecrets(row.jobId));
  return job.runtime === null && job.workflow === null && !job.vmAdmission.hasSecrets;
});

const withViewerControls = Effect.fnUntraced(function* (
  row: WorkflowJobRecord,
  membership: Effect.Success<ReturnType<typeof authorizeWorkflowRepository>>,
) {
  const job = jobForClient(row);
  if (!job.vmAdmission) return job;
  const canManage =
    membership.role === "admin" ||
    (yield* (yield* Repositories).getAccess({
      repositoryId: row.repositoryId,
      userId: membership.userId,
    })) === "maintainer";
  const memberCheckpoint = job.progress?.checkpoint?.role === "member";
  return {
    ...job,
    viewerControls: {
      canCancel: canManage || (yield* mayCancelOwnVm(row, membership.userId)),
      canApprove: canManage || memberCheckpoint,
      canRespond: canManage || (memberCheckpoint && !(yield* hasFrozenVmSecrets(row.jobId))),
    },
  };
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
  if (
    !row ||
    row.repositoryId !== params.repositoryId ||
    row.organizationId !== membership.organization.organizationId
  )
    return yield* tenancyNotFound("repository_not_found");
  const checkpointResponse =
    payload.operation === "approve" ||
    payload.operation === "input" ||
    payload.operation === "request_changes";
  const ownCancel =
    (payload.operation === "cancel" || payload.operation === "retry_cancellation") &&
    (yield* mayCancelOwnVm(row, membership.userId));
  const memberResponse =
    checkpointResponse &&
    row.record.progress?.checkpoint?.role === "member" &&
    (payload.operation === "approve" ||
      row.record.runtime?.kind !== "vm" ||
      !(yield* hasFrozenVmSecrets(row.jobId)));
  if (!ownCancel && !memberResponse)
    yield* requireMaintainableRepository({ membership, repositoryId: params.repositoryId });
  const refreshForViewer = Effect.gen(function* () {
    const job = (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
    if (!job.vmAdmission) return job;
    const latestMembership = yield* authorizeWorkflowRepository(params.repositoryId);
    const latestRow = (yield* store.getJob(params.jobId)) ?? row;
    if (latestRow.organizationId !== latestMembership.organization.organizationId)
      return yield* tenancyNotFound("repository_not_found");
    return yield* withViewerControls(latestRow, latestMembership);
  });
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
  if (isTerminalWorkflowJob(row.status)) return yield* withViewerControls(row, membership);
  if (payload.operation === "cancel" && row.status === "cancelling")
    return yield* withViewerControls(row, membership);
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
  return yield* refreshForViewer;
});
const errors = mapRelayCommonApiErrors("not_authorized");
const sameDefinition = Schema.toEquivalence(WorkflowDefinition);
const vmModels = ThreadVmRuntimeConfiguration.pipe(
  Effect.map(({ settings }) => settings?.workflowModelCatalog ?? null),
);
const encodeVmSubmissionKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      purpose: Schema.Literal("workflow-vm-run"),
      organizationId: Schema.String,
      repositoryId: Schema.String,
      submitterUserId: Schema.String,
      requestId: Schema.String,
    }),
  ),
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
  const organizationId = membership.organization.organizationId;
  const scope = { organizationId, repositoryId, submitterUserId: membership.userId };
  const vmRequest = payload.expectedTargetKind === "vm";
  const crypto = yield* Crypto.Crypto;
  let submission: Parameters<typeof store.getVmSubmission>[0] | undefined;
  if (vmRequest && payload.requestId) {
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          encodeVmSubmissionKey({
            purpose: "workflow-vm-run",
            ...scope,
            requestId: payload.requestId,
          }),
        ),
      )
      .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
    submission = {
      ...scope,
      jobId: Encoding.encodeHex(digest),
      workflowId: payload.workflowId,
      instruction: payload.instruction,
    };
    const previous = yield* store.getVmSubmission(submission);
    if (previous) return jobForClient(previous);
    if (payload.replayOnly)
      return yield* new WorkflowSubmissionPendingError({
        message: "The previous submission is still unconfirmed. Check again to recover its run.",
      });
  } else if (payload.requestId || payload.replayOnly) {
    return yield* new WorkflowInvalidError({
      message: "A VM submission ID is required to check a run.",
    });
  }
  const attempt = admitRepositoryWorkflow(scope, payload, submission?.jobId);
  if (!submission) return yield* attempt;
  const original = submission;
  return yield* attempt.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // A concurrent submission may have committed while this preflight was in flight.
        const accepted = yield* store.getVmSubmission(original);
        return accepted ? jobForClient(accepted) : yield* Effect.fail(error);
      }),
    ),
  );
});

const admitRepositoryWorkflow = Effect.fn("WorkflowsApi.admitManual")(function* (
  scope: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly submitterUserId: string;
  },
  payload: typeof RunRepositoryWorkflow.Type,
  vmJobId: string | undefined,
) {
  const { organizationId, repositoryId, submitterUserId } = scope;
  const store = yield* Workflows;
  const workflow = yield* store.get(payload.workflowId);
  if (
    !workflow ||
    workflow.repositoryId !== repositoryId ||
    workflow.organizationId !== organizationId
  )
    return yield* tenancyNotFound("repository_not_found");
  if (workflow.archived)
    return yield* new WorkflowInvalidError({ message: "Restore this workflow before running it." });
  if (workflow.definition.target.kind !== payload.expectedTargetKind)
    return yield* workflowRunTargetChanged();
  let vm: NonNullable<Parameters<typeof store.createManualJob>[1]["vm"]> | undefined;
  if (workflow.definition.target.kind === "vm") {
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (settings?.workflowExecutionEnabled !== true) return yield* vmWorkflowExecutionUnavailable();
    if (!vmJobId)
      return yield* new WorkflowInvalidError({
        message: "A VM submission ID is required to run this workflow.",
      });
    if (!settings.workflowModelCatalog)
      return yield* new WorkflowInvalidError({
        message: "Verify the workflow VM build and its Codex models before running.",
      });
    if (workflow.definition.steps.some((step) => step.kind === "action"))
      return yield* new WorkflowInvalidError({
        message:
          "VM workflows do not support Push or Open PR yet. Remove those steps before running.",
      });
    const issue = vmWorkflowDefinitionIssue(
      workflow.definition.target.baseBranch,
      workflow.definition.steps,
      settings.workflowModelCatalog,
    );
    if (issue) return yield* new WorkflowInvalidError({ message: issue });
    yield* store.checkWorkflowVmSubmissionAccess(scope);
    yield* store.requireWorkflowVmLimit(organizationId);
    const codex = yield* store.getWorkflowVmCodexConnection(organizationId);
    if (codex?.status !== "connected")
      return yield* new WorkflowInvalidError({
        message: "Connect Codex for this organization before running a VM workflow.",
      });
    const githubApp = yield* Effect.serviceOption(GithubApp);
    if (Option.isNone(githubApp))
      return yield* new WorkflowInvalidError({
        message: "Configure the GitHub App for this organization before running a VM workflow.",
      });
    const github = yield* resolveWorkflowVmGitHub({
      organizationId,
      repositoryId,
      baseBranch: workflow.definition.target.baseBranch,
    }).pipe(
      Effect.provideService(GithubApp, githubApp.value),
      Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })),
    );
    vm = { codexConnectionId: codex.connectionId, github };
  } else {
    yield* validateWorkflowTarget(organizationId, repositoryId, workflow.definition);
  }
  const jobId =
    vmJobId ??
    (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
      Effect.catch(() => relayInternalErrorResponse("internal_error")),
    ));
  const now = DateTime.formatIso(yield* DateTime.now);
  const job = {
    origin: { kind: "manual" as const, userId: submitterUserId },
    jobId,
    repositoryId,
    workflowId: workflow.workflowId,
    runtime: null,
    instruction: payload.instruction,
    status: "queued" as const,
    detail: vm ? "Waiting for a VM slot." : null,
    ...(vm ? { queueReason: { code: "vm_waiting_capacity" as const, retryAt: null } } : {}),
    workflow: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
  };
  const saved = yield* store.createManualJob(
    {
      jobId,
      repositoryId,
      organizationId,
      submitterUserId,
      repositoryCanonicalKey: vm?.github.canonicalKey ?? null,
      status: "queued",
      record: job,
      revision: 0,
      leaseUntil: null,
      pendingControl: null,
      createdAt: now,
      checkedAt: now,
    },
    {
      expectedRevision: workflow.revision,
      expectedTargetKind: payload.expectedTargetKind,
      ...(vm ? { vm } : {}),
    },
  );
  if (vm) return jobForClient(saved);
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
          vmExecutionAvailable:
            (yield* ThreadVmRuntimeConfiguration).settings?.workflowExecutionEnabled === true,
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
        const membership = yield* authorizeWorkflowRepository(params.repositoryId);
        const row = yield* (yield* Workflows).getJob(params.jobId);
        if (
          !row ||
          row.repositoryId !== params.repositoryId ||
          row.organizationId !== membership.organization.organizationId
        )
          return yield* tenancyNotFound("repository_not_found");
        const job = (yield* refreshWorkflowJobForClient(params.jobId)) ?? jobForClient(row);
        if (!job.vmAdmission) return job;
        const latestMembership = yield* authorizeWorkflowRepository(params.repositoryId);
        const latestRow = (yield* (yield* Workflows).getJob(params.jobId)) ?? row;
        if (latestRow.organizationId !== latestMembership.organization.organizationId)
          return yield* tenancyNotFound("repository_not_found");
        return yield* withViewerControls(latestRow, latestMembership);
      }).pipe(errors),
    )
    .handle("getJobResult", ({ params }) =>
      Effect.gen(function* () {
        const membership = yield* authorizeWorkflowRepository(params.repositoryId);
        const sql = (yield* RelayDb).$client;
        const scope = { ...params, organizationId: membership.organization.organizationId };
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* requireWorkflowVmViewer(sql, scope, membership.userId);
              return (yield* readWorkflowVmBinding(sql, scope)).placement;
            }),
          )
          .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
      }).pipe(errors),
    )
    .handle("respond", ({ params, payload }) => respondToWorkflowJob(params, payload).pipe(errors)),
);
