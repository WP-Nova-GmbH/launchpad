import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
import {
  WorkflowConflictError,
  WorkflowInvalidError,
  isTerminalWorkflowJob,
  type RespondToWorkflowJob,
} from "@t3tools/contracts/workflows";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
      ...(payload.operation === "input" || payload.operation === "request_changes"
        ? { requiredProtocol: 5 as const }
        : {}),
      ...(payload.operation === "cancel"
        ? {
            status: "cancelling" as const,
            detail: "Cancellation requested; waiting for the environment.",
            progress: row.record.progress
              ? { ...row.record.progress, approvalPending: false, retryableApproval: false }
              : null,
          }
        : { detail: "Response saved; waiting for the environment." }),
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
