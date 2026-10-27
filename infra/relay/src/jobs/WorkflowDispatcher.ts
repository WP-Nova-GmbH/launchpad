import { WorkflowOrigin } from "@t3tools/contracts";
import { RelayJobId } from "@t3tools/contracts/relay";
import {
  WorkflowInvalidError,
  WorkflowManualControl,
  isTerminalWorkflowJob,
  type WorkflowControl,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AutomaticOffers, WorkflowQueued } from "../workflowEvents/AutomaticOffer.ts";
import { queueReasonText } from "../workflowSources/IssueContext.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { requireMaintainableRepository, requireVisibleRepository } from "../http/TenancyApi.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { Workflows, type WorkflowJobRecord, type WorkflowDispatchScope } from "./Workflows.ts";
import { validateWorkflowTarget } from "./WorkflowTarget.ts";
export { validateWorkflowTarget } from "./WorkflowTarget.ts";

const decodeOrigin = Schema.decodeUnknownEffect(WorkflowOrigin);

const sameManualControl = Schema.toEquivalence(WorkflowManualControl);
const isWorkflowInvalidError = Schema.is(WorkflowInvalidError);
const isWorkflowQueued = Schema.is(WorkflowQueued);

export const refreshWorkflowJob = Effect.fn("WorkflowDispatcher.refresh")(function* (
  jobId: string,
) {
  const store = yield* Workflows;
  let row = yield* store.claim(jobId);
  if (!row) return (yield* store.getJob(jobId))?.record ?? null;
  const leaseUntil = row.leaseUntil!;
  const update = (
    previous: WorkflowJobRecord,
    record: RepositoryWorkflowJob,
    pending = previous.pendingControl,
    release = false,
  ) => store.updateJob(previous, record, pending, release, leaseUntil);
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
      row = yield* update(
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
        row = yield* update(
          row!,
          { ...job, status: "cancelled", detail: "Cancelled before acceptance.", updatedAt: now },
          null,
          false,
        );
        return row.record;
      }
      if (origin.kind === "automation") {
        if (
          job.queueReason?.retryAt &&
          job.queueReason.retryAt > (yield* DateTime.now).epochMilliseconds
        )
          return job;
        const automatic = yield* Effect.serviceOption(AutomaticOffers);
        if (automatic._tag === "None")
          return yield* new WorkflowQueued({ code: "source_unavailable", retryAt: null });
        row = yield* automatic.value.prepare(row!, leaseUntil);
        job = row.record;
        workflow = job.workflow!;
      } else {
        workflow = yield* store.get(job.workflowId);
        if (workflow === null || workflow.archived) {
          row = yield* update(
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
        row = yield* update(
          { ...row!, repositoryCanonicalKey: canonicalKey },
          job,
          row!.pendingControl,
          false,
        );
        // Store the remote binding beside the offer, including across relay restart.
        row = { ...row, repositoryCanonicalKey: canonicalKey };
      }
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
        row = yield* update(
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
      row = yield* update(row!, { ...job, requiredProtocol: 6 }, row!.pendingControl, false);
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
    let mayRetireOffer = origin.kind !== "automation";
    if (origin.kind === "automation" && control.operation === "start") {
      mayRetireOffer = job.startAttempted === false;
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
          mayRetireOffer &&
          capability.workflowResult?.outcome === "missing" &&
          capability.workflowResult.progress === null
        )
          return (yield* update(
            { ...row!, repositoryCanonicalKey: null },
            {
              ...job,
              workflow: null,
              issueSnapshot: undefined,
              offerAuthority: undefined,
              startAttempted: undefined,
              instruction: job.event
                ? `${job.event.identifier}: ${job.event.title}`
                : job.instruction,
              queueReason: { code: "environment_update", retryAt: null },
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
      // Persist before sending: a crash or timeout leaves every later delivery frozen.
      row = yield* update(row!, { ...job, startAttempted: true }, row!.pendingControl, false);
      job = row.record;
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
      row = yield* update(row!, next, keepPending ? row!.pendingControl : null, false);
      return row.record;
    }
    if (outcome.protocol >= 2 && outcome.outcome === "cancelled") {
      row = yield* update(
        row!,
        { ...job, status: "cancelled", detail: "Cancelled before acceptance.", updatedAt: now },
        null,
        false,
      );
      return row.record;
    }
    if (control.operation === "cancel" && outcome.outcome === "missing") {
      row = yield* update(
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
      mayRetireOffer &&
      ["busy", "unavailable", "missing"].includes(outcome.outcome)
    ) {
      row = yield* update(
        { ...row!, repositoryCanonicalKey: null },
        {
          ...job,
          workflow: null,
          issueSnapshot: undefined,
          offerAuthority: undefined,
          startAttempted: undefined,
          instruction: job.event ? `${job.event.identifier}: ${job.event.title}` : job.instruction,
          ...(origin.kind === "automation"
            ? {
                queueReason: {
                  code:
                    outcome.outcome === "busy"
                      ? ("environment_busy" as const)
                      : ("target_invalid" as const),
                  retryAt: Date.parse(now) + 30_000,
                },
              }
            : {}),
          status: "queued",
          detail: outcome.detail ?? "Waiting for the selected environment.",
          updatedAt: now,
        },
        null,
        false,
      );
      return row.record;
    }
    row = yield* update(
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
        if (
          !latest ||
          isTerminalWorkflowJob(latest.record.status) ||
          latest.revision !== row!.revision ||
          latest.leaseUntil !== leaseUntil
        )
          return latest?.record ?? null;
        if (latest.record.origin?.kind === "automation" && latest.record.workflow === null) {
          const reason = isWorkflowQueued(error)
            ? error
            : { code: "source_unavailable" as const, retryAt: null };
          const queueReason = {
            code: reason.code,
            retryAt: reason.retryAt ?? (yield* DateTime.now).epochMilliseconds + 30_000,
          };
          return (yield* update(
            latest,
            {
              ...latest.record,
              queueReason,
              detail: queueReasonText[reason.code],
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
            latest.pendingControl,
            false,
          )).record;
        }
        const detail = isWorkflowInvalidError(error)
          ? error.message
          : "Waiting for the selected environment to reconnect or acknowledge the job.";
        return (yield* update(
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

// Shared by HTTP wakes and periodic recovery in this isolate; overlapping wakes are best effort.
const drainGate = Semaphore.makeUnsafe(1);
export const deliverPendingWorkflowJobs = Effect.fn("WorkflowDispatcher.deliverPending")(function* (
  scope: WorkflowDispatchScope = {},
) {
  yield* drainGate
    .withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        const rows = yield* (yield* Workflows).pendingJobs(scope);
        yield* Effect.forEach(
          rows,
          (row) => refreshWorkflowJob(row.jobId).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: 4, discard: true },
        );
      }),
    )
    .pipe(Effect.asVoid);
});
