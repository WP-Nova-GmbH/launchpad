import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkflowRun } from "../jobs/WorkflowRunStore.ts";
import { ownershipReleased } from "../jobs/workflowOwnership.ts";

export class WorkflowThreadOwnershipError extends Schema.TaggedError<WorkflowThreadOwnershipError>()(
  "WorkflowThreadOwnershipError",
  { threadId: Schema.String, message: Schema.String },
) {}
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRun));

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
});
