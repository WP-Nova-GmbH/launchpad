import { WorkflowOrigin } from "@t3tools/contracts";
import { RelayJobId } from "@t3tools/contracts/relay";
import {
  WorkflowInvalidError,
  WorkflowManualControl,
  isTerminalWorkflowJob,
  type WorkflowControl,
  type WorkflowDefinition,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Machines } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { requireMaintainableRepository, requireVisibleRepository } from "../http/TenancyApi.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { Workflows } from "./Workflows.ts";

const decodeOrigin = Schema.decodeUnknownEffect(WorkflowOrigin);

const sameManualControl = Schema.toEquivalence(WorkflowManualControl);
const isWorkflowInvalidError = Schema.is(WorkflowInvalidError);

export const validateWorkflowTarget = Effect.fn("WorkflowDispatcher.validateTarget")(function* (
  organizationId: string,
  repositoryId: string,
  definition: WorkflowDefinition,
) {
  const machine = yield* (yield* Machines).getActiveByEnvironmentId({
    environmentId: definition.environmentId,
  });
  const repository = yield* (yield* Repositories).getById({ repositoryId });
  const catalog = yield* (yield* OrganizationProjectCatalog).listForOrganization({
    organizationId,
  });
  const project = catalog.find(
    (entry) =>
      entry.environmentId === definition.environmentId && entry.projectId === definition.projectId,
  );
  if (
    !machine ||
    machine.organizationId !== organizationId ||
    machine.enrolledAt === null ||
    !repository ||
    repository.organizationId !== organizationId ||
    !project?.repositoryCanonicalKey ||
    !repository.canonicalKeys.includes(project.repositoryCanonicalKey)
  ) {
    return yield* new WorkflowInvalidError({
      message: "Choose an enrolled organization environment and a checkout of this repository.",
    });
  }
  return project.repositoryCanonicalKey;
});

export const refreshWorkflowJob = Effect.fn("WorkflowDispatcher.refresh")(function* (
  jobId: string,
) {
  const store = yield* Workflows;
  let row = yield* store.claim(jobId);
  if (!row) return (yield* store.getJob(jobId))?.record ?? null;
  const leaseUntil = row.leaseUntil!;
  if (isTerminalWorkflowJob(row.record.status)) {
    yield* store.release(jobId, leaseUntil);
    return row.record;
  }
  const connector = yield* EnvironmentConnector;
  const refresh = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    let job = row!.record;
    const origin = yield* decodeOrigin(
      job.origin ??
        (row!.submitterUserId ? { kind: "manual", userId: row!.submitterUserId } : undefined),
    );
    const dispatchIdentity = () => ({
      userId: origin.kind === "manual" ? origin.userId : null,
      workflowOrigin: origin,
      ...(row!.pendingControl ? { requestedBy: row!.pendingControl.userId } : {}),
    });
    const minimumProtocol = origin.kind === "automation" ? 8 : job.workflow === null ? 6 : 4;
    if ((job.requiredProtocol ?? 2) < minimumProtocol) {
      row = yield* store.updateJob(
        row!,
        { ...job, requiredProtocol: minimumProtocol, updatedAt: now },
        row!.pendingControl,
        false,
      );
      job = row.record;
    }
    let workflow = job.workflow;
    // Queued jobs adopt the current definition. A dispatching offer stays frozen
    // through timeout and retries until the executor answers authoritatively.
    if (workflow === null) {
      if (row!.pendingControl?.response.operation === "cancel") {
        row = yield* store.updateJob(
          row!,
          { ...job, status: "cancelled", detail: "Cancelled before acceptance.", updatedAt: now },
          null,
          false,
        );
        return row.record;
      }
      if (origin.kind === "automation")
        return (yield* store.updateJob(
          row!,
          {
            ...job,
            detail: "Automatic starts await event context and source validation.",
            updatedAt: now,
          },
          row!.pendingControl,
          false,
        )).record;
      workflow = yield* store.get(job.workflowId);
      if (workflow === null || workflow.archived) {
        row = yield* store.updateJob(
          row!,
          {
            ...job,
            detail: "The workflow is archived or unavailable. Restore it or cancel this job.",
            updatedAt: now,
          },
          row!.pendingControl,
          false,
        );
        return row.record;
      }
      const canonicalKey = yield* validateWorkflowTarget(
        row!.organizationId,
        job.repositoryId,
        workflow.definition,
      );
      const publishing = workflow.definition.steps.filter((step) => step.kind === "action");
      const protocol = publishing.length ? 7 : 6;
      const binding = {
        organizationId: row!.organizationId,
        repositoryId: job.repositoryId,
        projectId: workflow.definition.projectId,
      };
      const probe = yield* connector.dispatchJob({
        ...dispatchIdentity(),
        environmentId: workflow.definition.environmentId,
        jobId: RelayJobId.make(jobId),
        repositoryCanonicalKey: canonicalKey,
        baseBranch: "HEAD",
        instruction: job.instruction,
        workflowControl: { ...binding, operation: "status" },
      });
      if (
        !probe.workflowResult ||
        probe.workflowResult.protocol < protocol ||
        publishing.some((step) => !probe.workflowResult?.actions?.includes(step.action))
      )
        return yield* new WorkflowInvalidError({
          message: "Update this environment to a version that supports repository workflows.",
        });
      if (probe.workflowResult.progress !== null)
        return yield* new WorkflowInvalidError({
          message: "Unexpected job acceptance before this workflow was offered.",
        });
      if (probe.workflowResult.outcome !== "missing")
        return yield* new WorkflowInvalidError({
          message: probe.workflowResult.detail ?? "Workflow execution is unavailable.",
        });
      job = {
        ...job,
        environmentId: workflow.definition.environmentId,
        workflow,
        requiredProtocol: protocol,
        status: "dispatching",
        detail: "Offering this workflow to its environment.",
        updatedAt: now,
      };
      row = yield* store.updateJob(
        { ...row!, repositoryCanonicalKey: canonicalKey },
        job,
        row!.pendingControl,
        false,
      );
      // Store the remote binding beside the offer, including across relay restart.
      row = { ...row, repositoryCanonicalKey: canonicalKey };
    }
    const binding = {
      organizationId: row!.organizationId,
      repositoryId: job.repositoryId,
      projectId: workflow.definition.projectId,
    };
    const canonicalKey = row!.repositoryCanonicalKey;
    if (canonicalKey === null)
      return yield* new WorkflowInvalidError({
        message: "The offered repository binding is missing.",
      });
    let control: WorkflowControl = { ...binding, operation: "status" };
    if (row!.pendingControl) {
      // A saved response is only deliverable while its author still has the checkpoint's role.
      const pending = row!.pendingControl;
      const membership = yield* (yield* Organizations).getMembershipForUser({
        userId: pending.userId,
      });
      const response = pending.response;
      const checkpointResponse =
        response.operation === "approve" ||
        response.operation === "input" ||
        response.operation === "request_changes";
      const authorized =
        membership && membership.organization.organizationId === row!.organizationId
          ? yield* (
              checkpointResponse && job.progress?.checkpoint?.role === "member"
                ? requireVisibleRepository({ membership, repositoryId: job.repositoryId }).pipe(
                    Effect.asVoid,
                  )
                : requireMaintainableRepository({
                    membership,
                    repositoryId: job.repositoryId,
                  }).pipe(Effect.asVoid)
            ).pipe(
              Effect.as(true),
              Effect.catchTags({
                RelayTenancyForbiddenError: () => Effect.succeed(false),
                RelayTenancyNotFoundError: () => Effect.succeed(false),
              }),
            )
          : false;
      if (!authorized) {
        row = yield* store.updateJob(
          row!,
          {
            ...job,
            detail:
              "The saved response author no longer has permission. A permitted repository member must respond.",
            pendingManualControl: null,
            updatedAt: now,
          },
          null,
          false,
        );
        return row.record;
      }
      control = { ...binding, ...response };
    } else if (job.progress === null) control = { ...binding, operation: "start", workflow };
    const manualControl =
      control.operation === "pause" || control.operation === "resume" ? control : null;
    const manual = manualControl !== null;
    // Status reconciles and may start an unreserved step. Use the already-confirmed job
    // capability so Pause reaches the executor before any advancing probe.
    if (manual && !job.progress?.manualPauseSupported)
      return yield* new WorkflowInvalidError({
        message: "This job has no confirmed manual Pause/Resume capability.",
      });
    if (manual && (job.requiredProtocol ?? 2) < 6) {
      row = yield* store.updateJob(
        row!,
        { ...job, requiredProtocol: 6 },
        row!.pendingControl,
        false,
      );
      job = row.record;
    }
    if (
      control.operation === "approve" ||
      control.operation === "input" ||
      control.operation === "request_changes" ||
      control.operation === "retry_action"
    ) {
      const capability = yield* connector.dispatchJob({
        ...dispatchIdentity(),
        environmentId: job.environmentId,
        jobId: RelayJobId.make(jobId),
        repositoryCanonicalKey: canonicalKey,
        baseBranch: "HEAD",
        instruction: job.instruction,
        workflowControl: { ...binding, operation: "status" },
      });
      if (
        !capability.workflowResult ||
        capability.workflowResult.protocol < (job.requiredProtocol ?? 4)
      )
        return yield* new WorkflowInvalidError({
          message: "Update this environment before responding to this workflow.",
        });
    }
    if (origin.kind === "automation" && control.operation === "start") {
      const capability = yield* connector.dispatchJob({
        ...dispatchIdentity(),
        environmentId: job.environmentId,
        jobId: RelayJobId.make(jobId),
        repositoryCanonicalKey: canonicalKey,
        baseBranch: "HEAD",
        instruction: job.instruction,
        workflowControl: { ...binding, operation: "status" },
      });
      if (!capability.workflowResult || capability.workflowResult.protocol < 8) {
        // A confirmed missing result relinquishes an unaccepted offer; unknown delivery stays pinned.
        if (
          capability.workflowResult?.outcome === "missing" &&
          capability.workflowResult.progress === null
        )
          return (yield* store.updateJob(
            row!,
            {
              ...job,
              workflow: null,
              status: "queued",
              requiredProtocol: 8,
              detail: "Update this environment before running automatic workflows.",
              updatedAt: now,
            },
            row!.pendingControl,
            false,
          )).record;
        return yield* new WorkflowInvalidError({
          message: "Update this environment to reconcile this automatic workflow.",
        });
      }
      const supported = capability.workflowResult.actions ?? [];
      if (
        workflow.definition.steps.some(
          (step) => step.kind === "action" && !supported.includes(step.action),
        )
      )
        return yield* new WorkflowInvalidError({
          message: "This environment does not support the workflow's publishing steps.",
        });
    }
    const response = yield* connector.dispatchJob({
      ...dispatchIdentity(),
      environmentId: job.environmentId,
      jobId: RelayJobId.make(jobId),
      repositoryCanonicalKey: canonicalKey,
      baseBranch: "HEAD",
      instruction: job.instruction,
      workflowControl: control,
    });
    const outcome = response.workflowResult;
    if (!outcome)
      return yield* new WorkflowInvalidError({
        message: "This environment did not answer with the workflow protocol.",
      });
    if (outcome.protocol < (job.requiredProtocol ?? 2))
      return yield* new WorkflowInvalidError({
        message:
          "Update this environment to confirm workflow cleanup. This job remains owned by its environment.",
      });
    if (outcome.progress) {
      // Monotonic executor revisions and terminal fences reject stale reports.
      if ((job.progress?.revision ?? -1) > outcome.progress.revision) return job;
      const receipt = outcome.progress.lastManualControl;
      const manualAcknowledged =
        manualControl && receipt && sameManualControl(receipt, manualControl);
      const keepPending =
        outcome.outcome === "busy" ||
        (manual && !manualAcknowledged && outcome.outcome !== "conflict");
      const next: RepositoryWorkflowJob = {
        ...job,
        progress: outcome.progress,
        pendingManualControl: keepPending ? job.pendingManualControl : null,
        status: outcome.progress.status,
        detail: outcome.detail ?? outcome.progress.detail,
        updatedAt: now,
      };
      row = yield* store.updateJob(row!, next, keepPending ? row!.pendingControl : null, false);
      return row.record;
    }
    if (outcome.protocol >= 2 && outcome.outcome === "cancelled") {
      row = yield* store.updateJob(
        row!,
        { ...job, status: "cancelled", detail: "Cancelled before acceptance.", updatedAt: now },
        null,
        false,
      );
      return row.record;
    }
    if (control.operation === "cancel" && outcome.outcome === "missing") {
      row = yield* store.updateJob(
        row!,
        {
          ...job,
          status: "cancelling",
          detail:
            "Cancellation is not confirmed. Update the environment to finish cancelling this job.",
          updatedAt: now,
        },
        row!.pendingControl,
        false,
      );
      return row.record;
    }
    if (
      control.operation === "start" &&
      ["busy", "unavailable", "missing"].includes(outcome.outcome)
    ) {
      row = yield* store.updateJob(
        row!,
        {
          ...job,
          workflow: null,
          status: "queued",
          detail: outcome.detail ?? "Waiting for the selected environment.",
          updatedAt: now,
        },
        null,
        false,
      );
      return row.record;
    }
    row = yield* store.updateJob(
      row!,
      {
        ...job,
        detail:
          outcome.detail ??
          "The accepted job could not be reconciled. Its definition remains pinned.",
        updatedAt: now,
      },
      row!.pendingControl,
      false,
    );
    return row.record;
  });
  return yield* refresh.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const latest = yield* store.getJob(jobId);
        if (!latest || isTerminalWorkflowJob(latest.record.status)) return latest?.record ?? null;
        const detail = isWorkflowInvalidError(error)
          ? error.message
          : "Waiting for the selected environment to reconnect or acknowledge the job.";
        return (yield* store.updateJob(
          latest,
          { ...latest.record, detail, updatedAt: DateTime.formatIso(yield* DateTime.now) },
          latest.pendingControl,
          false,
        )).record;
      }),
    ),
    Effect.ensuring(store.release(jobId, leaseUntil).pipe(Effect.ignoreCause({ log: true }))),
  );
});

export const deliverPendingWorkflowJobs = Effect.fn("WorkflowDispatcher.deliverPending")(
  function* () {
    const rows = yield* (yield* Workflows).pendingJobs();
    yield* Effect.forEach(
      rows,
      (row) => refreshWorkflowJob(row.jobId).pipe(Effect.ignoreCause({ log: true })),
      { concurrency: 4, discard: true },
    );
  },
);
