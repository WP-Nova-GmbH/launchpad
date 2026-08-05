import * as Schema from "effect/Schema";

/**
 * A job could not be run at all — the project is gone, or the worktree could
 * not be materialized. Distinct from a job that ran and failed a step, which is
 * an ordinary `JobOutcome` with `status: "failed"`.
 */
export class JobRunnerError extends Schema.TaggedErrorClass<JobRunnerError>()("JobRunnerError", {
  jobId: Schema.String,
  operation: Schema.Literals(["resolve-project", "prepare-worktree", "create-thread", "run-step"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Job ${this.jobId} failed during ${this.operation}: ${this.detail}`;
  }
}
