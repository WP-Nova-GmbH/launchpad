import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
import {
  WorkflowConflictError,
  WorkflowInvalidError,
  WorkflowManualControl,
  isTerminalWorkflowJob,
  type RespondToWorkflowJob,
} from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Workflows } from "../jobs/Workflows.ts";
import { refreshWorkflowJob, validateWorkflowTarget } from "../jobs/WorkflowDispatcher.ts";
import {
  resolveMembership,
  requireVisibleRepository,
  requireMaintainableRepository,
} from "./TenancyApi.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";

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
        return (yield* refreshWorkflowJob(params.jobId)) ?? row.record;
      }
    }
    const receipt = row.record.progress?.lastManualControl;
    if (receipt?.controlId === payload.controlId && !row.pendingControl) {
      if (!sameManualControl(receipt, payload))
        return yield* new WorkflowConflictError({
          message: "This control identity belongs to another request.",
        });
      return (yield* refreshWorkflowJob(params.jobId)) ?? row.record;
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
  if (isTerminalWorkflowJob(row.status)) return row.record;
  if (payload.operation === "cancel" && row.status === "cancelling") return row.record;
  if (
    (row.pendingControl &&
      !(payload.operation === "cancel" && row.pendingControl.response.operation !== "cancel")) ||
    (row.status === "cancelling" && payload.operation !== "retry_cancellation")
  )
    return yield* new WorkflowConflictError({
      message: "A response is already waiting for acknowledgement. Refresh the job.",
    });
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
  yield* store.updateJob(
    row,
    {
      ...row.record,
      ...(manual
        ? { requiredProtocol: 6 as const, pendingManualControl: payload }
        : payload.operation === "cancel"
          ? { pendingManualControl: null }
          : {}),
      ...(payload.operation === "input" || payload.operation === "request_changes"
        ? { requiredProtocol: row.record.requiredProtocol === 6 ? (6 as const) : (5 as const) }
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
  return (yield* refreshWorkflowJob(params.jobId)) ?? row.record;
});
const errors = mapRelayCommonApiErrors("not_authorized");
export const workflowsApi = HttpApiBuilder.group(RelayApi, "workflows", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        return { workflows: yield* (yield* Workflows).list(params.repositoryId) };
      }).pipe(errors),
    )
    .handle("save", ({ params, payload }) =>
      Effect.gen(function* () {
        const membership = yield* authorizeWorkflowRepository(params.repositoryId, true);
        if (!payload.archived)
          yield* validateWorkflowTarget(
            membership.organization.organizationId,
            params.repositoryId,
            payload.definition,
          );
        return yield* (yield* Workflows).save(
          membership.organization.organizationId,
          params.repositoryId,
          payload,
        );
      }).pipe(errors),
    )
    .handle("listJobs", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        return {
          jobs: (yield* (yield* Workflows).listJobs(params.repositoryId)).map(({ record }) => ({
            jobId: record.jobId,
            repositoryId: record.repositoryId,
            workflowId: record.workflowId,
            environmentId: record.environmentId,
            instruction: record.instruction.slice(0, 280),
            status: record.status,
            detail: record.detail?.slice(0, 500) ?? null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })),
        };
      }).pipe(errors),
    )
    .handle("run", ({ params, payload }) =>
      Effect.gen(function* () {
        const membership = yield* authorizeWorkflowRepository(params.repositoryId);
        const store = yield* Workflows;
        const workflow = yield* store.get(payload.workflowId);
        if (!workflow || workflow.repositoryId !== params.repositoryId)
          return yield* tenancyNotFound("repository_not_found");
        if (workflow.archived)
          return yield* new WorkflowInvalidError({
            message: "Restore this workflow before running it.",
          });
        yield* validateWorkflowTarget(
          membership.organization.organizationId,
          params.repositoryId,
          workflow.definition,
        );
        const jobId = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
          Effect.catch(() => relayInternalErrorResponse("internal_error")),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        const job = {
          jobId,
          repositoryId: params.repositoryId,
          workflowId: workflow.workflowId,
          environmentId: workflow.definition.environmentId,
          instruction: payload.instruction,
          status: "queued" as const,
          detail: null,
          workflow: null,
          progress: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.createJob({
          jobId,
          repositoryId: params.repositoryId,
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
        });
        return (yield* refreshWorkflowJob(jobId)) ?? job;
      }).pipe(errors),
    )
    .handle("getJob", ({ params }) =>
      Effect.gen(function* () {
        yield* authorizeWorkflowRepository(params.repositoryId);
        const row = yield* (yield* Workflows).getJob(params.jobId);
        if (!row || row.repositoryId !== params.repositoryId)
          return yield* tenancyNotFound("repository_not_found");
        return (yield* refreshWorkflowJob(params.jobId)) ?? row.record;
      }).pipe(errors),
    )
    .handle("respond", ({ params, payload }) => respondToWorkflowJob(params, payload).pipe(errors)),
);
