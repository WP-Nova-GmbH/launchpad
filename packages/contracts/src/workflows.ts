import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Instruction = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT = 500;

export const WorkflowAgentStep = Schema.Struct({
  id: Label,
  kind: Schema.Literal("agent"),
  title: Label,
  instruction: Instruction,
  runtimeMode: Schema.optional(Schema.Literal("approval-required")),
  modelSelection: Schema.NullOr(ModelSelection),
});
export const WorkflowReviewStep = Schema.Struct({
  id: Label,
  kind: Schema.Literal("review"),
  title: Label,
  role: Schema.Literals(["maintainer", "member"]),
  reworkStepId: Schema.optional(Label),
});
export const WorkflowInputStep = Schema.Struct({
  id: Label,
  kind: Schema.Literal("input"),
  title: Label,
  question: Instruction,
  role: Schema.Literals(["maintainer", "member"]),
});
export const WorkflowStep = Schema.Union([
  WorkflowAgentStep,
  WorkflowReviewStep,
  WorkflowInputStep,
]);
export type WorkflowStep = typeof WorkflowStep.Type;

/** Sequential workflows use stable IDs; reviews can send work to an earlier Agent. */
export function workflowDefinitionError(steps: ReadonlyArray<WorkflowStep>): string | null {
  if (!steps.some((step) => step.kind === "agent")) return "A workflow needs an Agent step.";
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) return "Each workflow step needs a unique ID.";
    ids.add(step.id);
    if (step.kind !== "review") continue;
    const earlier = steps.slice(0, index).filter((candidate) => candidate.kind === "agent");
    if (!earlier.length) return "Review must follow an Agent step.";
    if (step.reworkStepId && !earlier.some((candidate) => candidate.id === step.reworkStepId))
      return "Request changes must return to an earlier Agent step.";
  }
  return null;
}
export const WorkflowDefinition = Schema.Struct({
  name: Label,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  steps: Schema.Array(WorkflowStep).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(Schema.makeFilter((definition) => workflowDefinitionError(definition.steps) ?? true));
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

export const WorkflowReviewCheckpoint = Schema.Struct({
  kind: Schema.optional(Schema.Literal("review")),
  stepId: Schema.optional(Label),
  generation: Schema.optional(Revision),
  role: Schema.optional(Schema.Literals(["maintainer", "member"])),
  checkpointId: TrimmedNonEmptyString,
  turnId: TrimmedNonEmptyString,
  checkpointRef: TrimmedNonEmptyString,
  checkpointTurnCount: Revision,
});
export const WorkflowInputCheckpoint = Schema.Struct({
  checkpointId: TrimmedNonEmptyString,
  kind: Schema.Literal("input"),
  stepId: Label,
  generation: Revision,
  role: Schema.Literals(["maintainer", "member"]),
  question: Instruction,
});
export const WorkflowCheckpoint = Schema.Union([WorkflowReviewCheckpoint, WorkflowInputCheckpoint]);
export type WorkflowCheckpoint = typeof WorkflowCheckpoint.Type;
export const WorkflowResponseSummary = Schema.Struct({
  checkpointId: TrimmedNonEmptyString,
  stepId: Label,
  generation: Revision,
  operation: Schema.Literals(["approve", "input", "request_changes"]),
  userId: TrimmedNonEmptyString,
  text: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export const WorkflowStepProgress = Schema.Struct({
  stepId: Label,
  generation: Revision,
  status: Schema.Literals(["completed", "waiting", "running", "pending"]),
});
export const WorkflowJobProgress = Schema.Struct({
  revision: Revision,
  status: Schema.Literals([
    "preparing",
    "running",
    "awaiting_review",
    "awaiting_input",
    "waiting_capacity",
    "finishing",
    "paused",
    "cancelling",
    "cancelled",
    "done",
    "failed",
  ]),
  threadId: ThreadId,
  detail: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(WorkflowCheckpoint),
  stepId: Schema.optional(Label),
  generation: Schema.optional(Revision),
  hasThread: Schema.optional(Schema.Boolean),
  steps: Schema.optional(Schema.Array(WorkflowStepProgress)),
  responses: Schema.optional(Schema.Array(WorkflowResponseSummary)),
  retryablePreparation: Schema.optional(Schema.Boolean),
  retryableCancellation: Schema.optional(Schema.Boolean),
  approvalPending: Schema.optional(Schema.Boolean),
  retryableApproval: Schema.optional(Schema.Boolean),
});
export type WorkflowJobProgress = typeof WorkflowJobProgress.Type;

export const RepositoryWorkflowJob = Schema.Struct({
  /** Pinned with the offer so a downgrade cannot acknowledge newer lifecycle semantics. */
  requiredProtocol: Schema.optional(Schema.Literals([2, 3, 4, 5])),
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
    "awaiting_input",
    "waiting_capacity",
    "finishing",
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
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("input"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("request_changes"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  }),
]);
export type WorkflowControl = typeof WorkflowControl.Type;
export const WorkflowControlResult = Schema.Struct({
  protocol: Schema.Literals([1, 2, 3, 4, 5]),
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
  Schema.Struct({
    operation: Schema.Literal("input"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("request_changes"),
    checkpointId: TrimmedNonEmptyString,
    expectedRevision: Revision,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
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

/** Automatic zones are consecutive Agent steps; each human step forms a boundary. */
export function workflowZones(
  steps: ReadonlyArray<WorkflowStep>,
): ReadonlyArray<ReadonlyArray<WorkflowStep>> {
  const zones: Array<Array<WorkflowStep>> = [];
  for (const step of steps) {
    const previous = zones.at(-1);
    if (step.kind === "agent" && previous?.[0]?.kind === "agent") previous.push(step);
    else zones.push([step]);
  }
  return zones;
}
