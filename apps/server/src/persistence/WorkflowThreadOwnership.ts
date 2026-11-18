import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
import { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
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
) {
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
    checkpoint?.checkpointId === expected.checkpointId &&
    checkpoint.generation === expected.checkpointGeneration &&
    checkpoint.stepId === step?.id &&
    ((checkpoint.kind === "review" &&
      step?.kind === "review" &&
      run.progress.status === "awaiting_review") ||
      (checkpoint.kind === "input" &&
        step?.kind === "input" &&
        run.progress.status === "awaiting_input"))
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
    !matchesWorkflowVmLifecycleCheckpoint(run, expected) ||
    !sameBinding(saved.run.runtime, run.runtime) ||
    !sameRun(saved.run, run) ||
    saved.frozenConfiguration.jobId !== run.jobId ||
    saved.frozenConfiguration.repositoryId !== run.runtime.repositoryId
  )
    return yield* new WorkflowThreadOwnershipError({
      threadId: input.threadId,
      message: "The workflow VM recovery point does not match its current human checkpoint.",
    });
  return {
    binding: run.runtime,
    sourceSequence: row.sourceSequence,
    beforeAgent:
      run.progress.checkpoint?.kind === "input" &&
      run.sequence?.completed.every((step) => step.checkpoint === null) === true,
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
