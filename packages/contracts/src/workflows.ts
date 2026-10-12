import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Instruction = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WorkflowAgentStep = Schema.Struct({
  id: Schema.Literal("agent"),
  kind: Schema.Literal("agent"),
  title: Label,
  instruction: Instruction,
  modelSelection: Schema.NullOr(ModelSelection),
});
export const WorkflowReviewStep = Schema.Struct({
  id: Schema.Literal("review"),
  kind: Schema.Literal("review"),
  title: Label,
  role: Schema.Literal("maintainer"),
});
/** The first catalog is deliberately an Agent followed by a human Review. */
export const WorkflowDefinition = Schema.Struct({
  name: Label,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  steps: Schema.Tuple([WorkflowAgentStep, WorkflowReviewStep]),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const RepositoryWorkflow = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  organizationId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  revision: Revision,
  definition: WorkflowDefinition,
  archived: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RepositoryWorkflow = typeof RepositoryWorkflow.Type;

export const WorkflowCheckpoint = Schema.Struct({
  checkpointId: TrimmedNonEmptyString,
  turnId: TrimmedNonEmptyString,
  checkpointRef: TrimmedNonEmptyString,
  checkpointTurnCount: Revision,
});
export const WorkflowJobProgress = Schema.Struct({
  revision: Revision,
  status: Schema.Literals([
    "preparing",
    "running",
    "awaiting_review",
    "paused",
    "cancelling",
    "cancelled",
    "done",
    "failed",
  ]),
  threadId: ThreadId,
  detail: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(WorkflowCheckpoint),
  retryablePreparation: Schema.optional(Schema.Boolean),
  retryableCancellation: Schema.optional(Schema.Boolean),
  approvalPending: Schema.optional(Schema.Boolean),
  retryableApproval: Schema.optional(Schema.Boolean),
});
export type WorkflowJobProgress = typeof WorkflowJobProgress.Type;

export const RepositoryWorkflowJob = Schema.Struct({
  /** Pinned with the offer so a downgrade cannot acknowledge newer lifecycle semantics. */
  requiredProtocol: Schema.optional(Schema.Literals([2, 3, 4])),
  jobId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  workflowId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  instruction: Instruction,
  status: Schema.Literals([
    "queued",
    "dispatching",
    "preparing",
    "running",
    "awaiting_review",
    "paused",
    "cancelling",
    "cancelled",
    "done",
    "failed",
  ]),
  detail: Schema.NullOr(Schema.String),
  /** Null until a definition is offered. An uncertain offer remains pinned. */
  workflow: Schema.NullOr(RepositoryWorkflow),
  progress: Schema.NullOr(WorkflowJobProgress),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RepositoryWorkflowJob = typeof RepositoryWorkflowJob.Type;
/** Lists carry a short context preview; the frozen definition/result is detail-only. */
export const RepositoryWorkflowJobSummary = Schema.Struct({
  jobId: RepositoryWorkflowJob.fields.jobId,
  repositoryId: RepositoryWorkflowJob.fields.repositoryId,
  workflowId: RepositoryWorkflowJob.fields.workflowId,
  environmentId: RepositoryWorkflowJob.fields.environmentId,
  instruction: RepositoryWorkflowJob.fields.instruction,
  status: RepositoryWorkflowJob.fields.status,
  detail: RepositoryWorkflowJob.fields.detail,
  createdAt: RepositoryWorkflowJob.fields.createdAt,
  updatedAt: RepositoryWorkflowJob.fields.updatedAt,
});
export type RepositoryWorkflowJobSummary = typeof RepositoryWorkflowJobSummary.Type;

const ControlBinding = {
  organizationId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  projectId: ProjectId,
};
export const WorkflowControl = Schema.Union([
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("start"),
    workflow: RepositoryWorkflow,
  }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literals(["status", "cancel"]),
  }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literals(["retry_preparation", "retry_cancellation"]),
    expectedRevision: Revision,
  }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("approve"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
  }),
]);
export type WorkflowControl = typeof WorkflowControl.Type;
export const WorkflowControlResult = Schema.Struct({
  protocol: Schema.Literals([1, 2, 3, 4]),
  outcome: Schema.Literals(["accepted", "cancelled", "missing", "busy", "unavailable", "conflict"]),
  detail: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(WorkflowJobProgress),
});
export type WorkflowControlResult = typeof WorkflowControlResult.Type;

export const SaveRepositoryWorkflow = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  expectedRevision: Revision,
  definition: WorkflowDefinition,
  archived: Schema.Boolean,
});
export const RunRepositoryWorkflow = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  instruction: Instruction,
});
export const RespondToWorkflowJob = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("cancel") }),
  Schema.Struct({ operation: Schema.Literal("retry_preparation"), expectedRevision: Revision }),
  Schema.Struct({ operation: Schema.Literal("retry_cancellation"), expectedRevision: Revision }),
  Schema.Struct({
    operation: Schema.Literal("approve"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
  }),
]);
export class WorkflowConflictError extends Schema.TaggedError<WorkflowConflictError>()(
  "WorkflowConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}
export class WorkflowInvalidError extends Schema.TaggedError<WorkflowInvalidError>()(
  "WorkflowInvalidError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export function isTerminalWorkflowJob(status: RepositoryWorkflowJob["status"]): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}
