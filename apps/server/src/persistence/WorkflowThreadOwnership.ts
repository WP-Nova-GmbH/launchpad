import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
import {
  WorkflowVmDispatchBinding,
  type WorkflowVmPublishingRestore,
} from "@t3tools/contracts/workflows";
import { WorkflowRun, WorkflowRunRecovery } from "../jobs/WorkflowRunStore.ts";
import { ownershipReleased } from "../jobs/workflowOwnership.ts";
import { activeWorkflowStep } from "../jobs/workflowSequence.ts";

export class WorkflowThreadOwnershipError extends Schema.TaggedError<WorkflowThreadOwnershipError>()(
  "WorkflowThreadOwnershipError",
  { threadId: Schema.String, message: Schema.String },
) {}
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRun));
const decodeRecovery = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRunRecovery));
const sameRun = Schema.toEquivalence(WorkflowRun);
const sameBinding = Schema.toEquivalence(WorkflowVmDispatchBinding);

export function matchesWorkflowVmLifecycleCheckpoint(
  run: WorkflowRun,
  expected: RelayThreadVmWorkflowCheckpoint,
  publishing?: WorkflowVmPublishingRestore,
) {
  if (expected.finishedWorkspaceRevision !== undefined)
    return (
      run.runtime.kind === "vm" &&
      run.jobId === expected.jobId &&
      expected.checkpointId === expected.publicationId &&
      expected.checkpointGeneration === 0 &&
      ownershipReleased(run)
    );
  const checkpoint = run.progress.checkpoint;
  const step = activeWorkflowStep(run);
  return (
    run.runtime.kind === "vm" &&
    run.jobId === expected.jobId &&
    !run.executionReserved &&
    !run.manualPause &&
    !run.approvalAttempt &&
    !run.cancellationAttempt &&
    !run.pendingQueueDismissal &&
    !run.pendingPreparationRetry &&
    !run.actions?.some((action) => action.commands.some((command) => !command.stopped)) &&
    (publishing
      ? step?.kind === "action" &&
        step.id === publishing.action.stepId &&
        run.sequence?.generation === publishing.action.stepGeneration &&
        run.progress.status === "paused" &&
        run.progress.revision === publishing.expectedRevision &&
        run.actions?.some(
          (action) =>
            action.actionId === publishing.action.actionId &&
            action.state === "uncertain" &&
            action.checkpointTurnId === publishing.action.resultTurnId &&
            action.checkpointRef === publishing.action.checkpointRef &&
            action.tree === publishing.action.tree,
        )
      : checkpoint?.checkpointId === expected.checkpointId &&
        checkpoint.generation === expected.checkpointGeneration &&
        checkpoint.stepId === step?.id &&
        ((checkpoint.kind === "review" &&
          step?.kind === "review" &&
          run.progress.status === "awaiting_review") ||
          (checkpoint.kind === "input" &&
            step?.kind === "input" &&
            run.progress.status === "awaiting_input")))
  );
}

/** A lifecycle operation may hold an unfinished VM only at its acknowledged human checkpoint. */
export const requireWorkflowVmLifecycleCheckpoint = Effect.fn(
  "WorkflowThreadOwnership.lifecycleCheckpoint",
)(function* (
  sql: SqlClient.SqlClient,
  input: {
    threadId: string;
    generation: number;
    workflowCheckpoint: RelayThreadVmWorkflowCheckpoint;
    publishing?: WorkflowVmPublishingRestore;
  },
) {
  const expected = input.workflowCheckpoint;
  const [row] = yield* sql<{ run: string; saved: string; sourceSequence: number }>`
      SELECT j.record_json AS run, o.record_json AS saved, o.source_sequence AS "sourceSequence"
      FROM repository_workflow_jobs j JOIN workflow_result_outbox o USING(job_id)
      WHERE j.job_id=${expected.jobId} AND j.thread_id=${input.threadId}
        AND o.thread_id=j.thread_id AND o.publication_id=${expected.publicationId}
        AND o.revision=${expected.publicationRevision} AND o.status='acknowledged'
        AND NOT EXISTS(SELECT 1 FROM workflow_result_outbox x WHERE x.job_id=j.job_id
          AND (x.revision>o.revision OR x.status!='acknowledged'))`;
  const run = row && Option.getOrUndefined(decode(row.run));
  const saved = row && Option.getOrUndefined(decodeRecovery(row.saved));
  if (
    !row ||
    !run ||
    !saved ||
    run.runtime.kind !== "vm" ||
    saved.run.runtime.kind !== "vm" ||
    run.runtime.threadId !== input.threadId ||
    run.runtime.generation !== input.generation ||
    !matchesWorkflowVmLifecycleCheckpoint(run, expected, input.publishing) ||
    !sameBinding(saved.run.runtime, run.runtime) ||
    !sameRun(saved.run, run) ||
    saved.frozenConfiguration.jobId !== run.jobId ||
    saved.frozenConfiguration.repositoryId !== run.runtime.repositoryId
  )
    return yield* new WorkflowThreadOwnershipError({
      threadId: input.threadId,
      message: "The workflow VM recovery point does not match its current human checkpoint.",
    });
  const [hasConversation] =
    expected.finishedWorkspaceRevision !== undefined
      ? yield* sql`SELECT 1 FROM provider_session_runtime WHERE thread_id=${input.threadId}
      UNION ALL SELECT 1 FROM projection_turns WHERE thread_id=${input.threadId} LIMIT 1`
      : [true];
  const cancelledWithoutNativeCheckpoint =
    expected.finishedWorkspaceRevision !== undefined &&
    run.progress.status === "cancelled" &&
    saved.checkpointPins.every((pin) => pin.turnId === "") &&
    !run.sequence?.completed.some((step) => step.checkpoint !== null) &&
    !(yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${input.threadId} AND turn_id IS NOT NULL
      UNION ALL SELECT 1 FROM thread_native_checkpoints WHERE thread_id=${input.threadId}
      UNION ALL SELECT 1 FROM workflow_result_outbox WHERE job_id=${run.jobId} AND native_operation_id IS NOT NULL
      LIMIT 1`).length;
  const cancelledBeforeNativeTurn =
    cancelledWithoutNativeCheckpoint &&
    !(yield* sql`SELECT 1 FROM checkout_work_admissions WHERE thread_id=${input.threadId}
      AND kind='provider' AND (turn_id IS NOT NULL OR (work_id LIKE 'send-turn:%' AND rejected=0))
      LIMIT 1`).length;
  return {
    binding: run.runtime,
    status: run.progress.status,
    sourceSequence: row.sourceSequence,
    cancelledWithoutNativeCheckpoint,
    cancelledBeforeNativeTurn,
    beforeAgent:
      !hasConversation ||
      cancelledBeforeNativeTurn ||
      (run.progress.checkpoint?.kind === "input" &&
        run.sequence?.completed.every((step) => step.checkpoint === null) === true),
  };
});

/** Call under the placement transaction before accepting any transfer side effects. */
export const assertWorkflowThreadReleased = Effect.fn("assertWorkflowThreadReleased")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const rows = yield* sql<{ status: string; record_json: string }>`SELECT status, record_json
    FROM repository_workflow_jobs WHERE thread_id = ${threadId}`;
  for (const row of rows) {
    const run = decode(row.record_json);
    if (
      Option.isNone(run) ||
      run.value.progress.threadId !== threadId ||
      run.value.progress.status !== row.status ||
      !ownershipReleased(run.value)
    )
      return yield* new WorkflowThreadOwnershipError({
        threadId,
        message:
          "This thread belongs to a workflow. Finish or cancel its run and confirm cleanup before moving it.",
      });
  }
  if (
    (yield* sql`SELECT 1 FROM workflow_result_outbox WHERE thread_id=${threadId} AND status!='acknowledged' LIMIT 1`)
      .length
  )
    return yield* new WorkflowThreadOwnershipError({
      threadId,
      message: "Save this workflow's pending result before moving or discarding its workspace.",
    });
});

/** Follow-up requires a known released workflow, not merely an unowned thread. */
export const requireReleasedWorkflowVmRun = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  scope: { threadId: string; allocationId: string; generation: number; environmentId: string },
) {
  const [row] = yield* sql<{
    record: string;
  }>`SELECT record_json AS record FROM repository_workflow_jobs
    WHERE thread_id=${scope.threadId} AND status IN ('done','failed','cancelled')`;
  const run = row && Option.getOrUndefined(decode(row.record));
  if (
    !run ||
    run.runtime.kind !== "vm" ||
    run.runtime.threadId !== scope.threadId ||
    run.runtime.allocationId !== scope.allocationId ||
    run.runtime.generation !== scope.generation ||
    run.runtime.environmentId !== scope.environmentId
  )
    return yield* new WorkflowThreadOwnershipError({
      threadId: scope.threadId,
      message: "The released workflow does not match the current VM workspace.",
    });
  yield* assertWorkflowThreadReleased(sql, scope.threadId);
  return run;
});
