import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkflowOrigin, WorkflowOriginSummary } from "./workflowOrigin.ts";
import { ModelSelection } from "./orchestration.ts";
import { ServerProviderModel } from "./server.ts";

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Instruction = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT = 500;
export const WORKFLOW_VM_DEFAULT_CODEX_MODEL = "gpt-6.1-sol";
export const WORKFLOW_VM_DEFAULT_CODEX_REASONING_EFFORT = "high";

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
export const WorkflowActionStep = Schema.Struct({
  id: Label,
  kind: Schema.Literal("action"),
  title: Label,
  action: Schema.Literals(["push", "open_pull_request"]),
});
export const WorkflowStep = Schema.Union([
  WorkflowActionStep,
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
    if (step.kind === "action") {
      const earlier = steps.slice(0, index);
      const lastAgent = earlier.findLastIndex((entry) => entry.kind === "agent");
      if (lastAgent < 0) return "Publishing must follow an Agent step.";
      if (
        step.action === "open_pull_request" &&
        !earlier
          .slice(lastAgent + 1)
          .some((entry) => entry.kind === "action" && entry.action === "push")
      )
        return "Open PR needs a Push branch step after the latest Agent.";
    }
    if (step.kind !== "review") continue;
    const earlier = steps.slice(0, index).filter((candidate) => candidate.kind === "agent");
    if (!earlier.length) return "Review must follow an Agent step.";
    if (step.reworkStepId && !earlier.some((candidate) => candidate.id === step.reworkStepId))
      return "Request changes must return to an earlier Agent step.";
  }
  return null;
}
export const WorkflowMachineTarget = Schema.Struct({
  kind: Schema.Literal("machine"),
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type WorkflowMachineTarget = typeof WorkflowMachineTarget.Type;
export const WorkflowVmTarget = Schema.Struct({
  kind: Schema.Literal("vm"),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export const WorkflowTarget = Schema.Union([WorkflowMachineTarget, WorkflowVmTarget]);
export type WorkflowTarget = typeof WorkflowTarget.Type;
/** Saved intent is independent of the execution binding accepted by a job. */
export const WorkflowRuntime = Schema.Union([
  WorkflowMachineTarget,
  Schema.Struct({ kind: Schema.Literal("vm"), threadId: ThreadId }),
]);
export type WorkflowRuntime = typeof WorkflowRuntime.Type;
export const WorkflowVmDispatchBinding = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  organizationId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  threadId: ThreadId,
  allocationId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  operationId: TrimmedNonEmptyString,
  projectId: ProjectId,
});
export type WorkflowVmDispatchBinding = typeof WorkflowVmDispatchBinding.Type;
export const WORKFLOW_PROTOCOL = 9;

export const WORKFLOW_RESULT_MAX_BYTES = 10_000_000;
export const WorkflowResultObject = Schema.Struct({
  artifactId: Schema.String.check(Schema.isUUID()),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
  ),
});
export const WorkflowSavedResult = Schema.Struct({
  resultId: Schema.String.check(Schema.isUUID()),
  stepId: TrimmedNonEmptyString,
  turnId: TrimmedNonEmptyString,
  turnCount: Schema.Int.check(Schema.isGreaterThan(0)),
  outcome: Schema.Literals(["completed", "failed", "cancelled"]),
  createdAt: Schema.String,
  checkpointRef: TrimmedNonEmptyString,
  baselineCommitId: TrimmedNonEmptyString,
  commitId: TrimmedNonEmptyString,
  treeId: TrimmedNonEmptyString,
  patch: Schema.Struct({
    ...WorkflowResultObject.fields,
    sizeBytes: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(WORKFLOW_RESULT_MAX_BYTES),
    ),
  }),
});
export type WorkflowSavedResult = typeof WorkflowSavedResult.Type;
/** One current format. The runner payload remains opaque to the relay. */
export const WorkflowRecoveryManifest = Schema.Struct({
  format: Schema.Literal("workflow-recovery-v1"),
  publicationId: Schema.String.check(Schema.isUUID()),
  binding: WorkflowVmDispatchBinding,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  state: WorkflowResultObject,
  sourceSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nativeCheckpointOperationId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  result: Schema.NullOr(WorkflowSavedResult),
});
export type WorkflowRecoveryManifest = typeof WorkflowRecoveryManifest.Type;
export const WorkflowSaveReceipt = Schema.Struct({
  publicationId: Schema.String.check(Schema.isUUID()),
  jobId: TrimmedNonEmptyString,
  threadId: ThreadId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  manifest: WorkflowResultObject,
  binding: WorkflowVmDispatchBinding,
  resultId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
});
export type WorkflowSaveReceipt = typeof WorkflowSaveReceipt.Type;
export const WorkflowResultSaving = Schema.Struct({
  publicationId: Schema.String.check(Schema.isUUID()),
  resultId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  state: Schema.Literals(["saving", "failed", "saved"]),
  detail: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
});
export type WorkflowResultSaving = typeof WorkflowResultSaving.Type;

export const WorkflowDefinition = Schema.Struct({
  name: Label,
  target: WorkflowTarget,
  steps: Schema.Array(WorkflowStep).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(Schema.makeFilter((definition) => workflowDefinitionError(definition.steps) ?? true));
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

const TriggerId = TrimmedNonEmptyString.check(Schema.isMaxLength(191));
const TriggerBase = {
  provider: Schema.Literal("linear"),
  connectionId: TriggerId,
  grantId: TriggerId,
  teamId: TriggerId,
  labelIds: Schema.Array(TriggerId).check(Schema.isMaxLength(100)),
};
export const WorkflowTrigger = Schema.Union([
  Schema.Struct({ ...TriggerBase, event: Schema.Literal("issue_created") }),
  Schema.Struct({ ...TriggerBase, event: Schema.Literal("entered_status"), stateId: TriggerId }),
]);
export type WorkflowTrigger = typeof WorkflowTrigger.Type;
export const WorkflowAutomation = Schema.Struct({
  enabled: Schema.Boolean,
  trigger: Schema.NullOr(WorkflowTrigger),
});
export type WorkflowAutomation = typeof WorkflowAutomation.Type;
export const WorkflowEventFacts = Schema.Struct({
  issueId: TriggerId,
  teamId: TriggerId,
  stateId: TriggerId,
  labelIds: Schema.Array(TriggerId).check(Schema.isMaxLength(100)),
  identifier: Label,
  title: Label,
  url: Schema.String.check(Schema.isMaxLength(2048)),
  occurredAt: Schema.String,
  issueUpdatedAt: Schema.String,
  previousStateId: Schema.optional(Schema.NullOr(TriggerId)),
});
export type WorkflowEventFacts = typeof WorkflowEventFacts.Type;

const IssueName = Schema.Struct({
  id: TriggerId,
  name: Schema.String.check(Schema.isMaxLength(1024)),
});
export const WorkflowIssueSnapshot = Schema.Struct({
  workspaceId: TriggerId,
  issueId: TriggerId,
  identifier: Schema.String.check(Schema.isMaxLength(1024)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  description: Schema.String.check(Schema.isMaxLength(32_000)),
  team: IssueName,
  status: IssueName,
  labels: Schema.Array(IssueName).check(Schema.isMaxLength(100)),
  issueUpdatedAt: Schema.String,
  retrievedAt: Schema.String,
  authorizationEpoch: Revision,
  credentialVersion: Revision,
});
export type WorkflowIssueSnapshot = typeof WorkflowIssueSnapshot.Type;
export const WorkflowQueueReason = Schema.Struct({
  code: Schema.Literals([
    "environment_offline",
    "environment_busy",
    "environment_update",
    "workflow_unavailable",
    "target_invalid",
    "workflow_changed",
    "source_unavailable",
    "source_rate_limited",
    "source_reconnect",
    "source_configuration",
    "source_withdrawn",
    "source_owner_ineligible",
    "issue_unavailable",
    "issue_context_invalid",
    "issue_context_too_large",
    "vm_waiting_capacity",
    "vm_limit_disabled",
    "vm_execution_disabled",
    "vm_waiting_codex",
    "vm_codex_replaced",
    "vm_target_changed",
  ]),
  retryAt: Schema.NullOr(Schema.Number),
});
export type WorkflowQueueReason = typeof WorkflowQueueReason.Type;
export function workflowIssueUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "https://linear.app" &&
      !url.username &&
      !url.password &&
      /^\/[^/]+\/issue\/[^/]+(?:\/[^/]*)?\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const RepositoryWorkflow = Schema.Struct({
  automation: Schema.optional(WorkflowAutomation),
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
export const WorkflowManualControl = Schema.Struct({
  operation: Schema.Literals(["pause", "resume"]),
  controlId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  expectedRevision: Revision,
});
export type WorkflowManualControl = typeof WorkflowManualControl.Type;
export const WorkflowManualPause = Schema.Struct({
  state: Schema.Literals(["requested", "paused"]),
});
const WorkflowExecutionStatus = Schema.Literals([
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
]);
export const WorkflowActionProgress = Schema.Struct({
  retryRevision: Schema.optional(Revision),
  actionId: TrimmedNonEmptyString,
  stepId: Label,
  generation: Revision,
  operation: Schema.Literals(["push", "open_pull_request"]),
  state: Schema.Literals(["running", "uncertain", "failed", "completed"]),
  detail: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
});
export const WorkflowJobProgress = Schema.Struct({
  resultSaving: Schema.optional(WorkflowResultSaving),
  executionReleased: Schema.optional(Schema.Boolean),
  /** Set by relay deletion admission, independently of whether an Agent ever started. */
  threadDeletionRequested: Schema.optional(Schema.Boolean),
  pullRequestUrl: Schema.optional(Schema.NullOr(Schema.String)),
  actions: Schema.optional(Schema.Array(WorkflowActionProgress)),
  revision: Revision,
  status: WorkflowExecutionStatus,
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
  manualPauseSupported: Schema.optional(Schema.Boolean),
  manualPause: Schema.optional(Schema.NullOr(WorkflowManualPause)),
  underlyingStatus: Schema.optional(WorkflowExecutionStatus),
  lastManualControl: Schema.optional(Schema.NullOr(WorkflowManualControl)),
});
export type WorkflowJobProgress = typeof WorkflowJobProgress.Type;

export const RepositoryWorkflowJob = Schema.Struct({
  issueSnapshot: Schema.optional(WorkflowIssueSnapshot),
  queueReason: Schema.optional(Schema.NullOr(WorkflowQueueReason)),
  vmAdmission: Schema.optional(
    Schema.Struct({ codexConnectionId: TrimmedNonEmptyString, hasSecrets: Schema.Boolean }),
  ),
  /** Marked before sending: absent on legacy offers means delivery may already have happened. */
  startAttempted: Schema.optional(Schema.Boolean),
  vmCancellationConfirmed: Schema.optional(Schema.Boolean),
  offerAuthority: Schema.optional(
    Schema.Struct({ authorizationEpoch: Revision, grantGeneration: Revision }),
  ),
  event: Schema.optional(WorkflowEventFacts),
  origin: Schema.optional(WorkflowOrigin),
  originSummary: Schema.optional(WorkflowOriginSummary),
  /** Pinned with the offer so a downgrade cannot acknowledge newer lifecycle semantics. */
  requiredProtocol: Schema.optional(Schema.Literals([2, 3, 4, 5, 6, 7, 8, 9])),
  jobId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  workflowId: TrimmedNonEmptyString,
  runtime: Schema.NullOr(WorkflowRuntime),
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
  /** Relay response awaiting executor acknowledgement; derived from the durable pending control. */
  responsePending: Schema.optional(Schema.Boolean),
  pendingResponseOperation: Schema.optional(
    Schema.Literals(["approve", "input", "request_changes"]),
  ),
  viewerControls: Schema.optional(
    Schema.Struct({
      canCancel: Schema.Boolean,
      canApprove: Schema.Boolean,
      canRespond: Schema.Boolean,
    }),
  ),
  pendingManualControl: Schema.optional(Schema.NullOr(WorkflowManualControl)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RepositoryWorkflowJob = typeof RepositoryWorkflowJob.Type;
/** Lists carry a short context preview; the frozen definition/result is detail-only. */
export const RepositoryWorkflowJobSummary = Schema.Struct({
  queueReason: Schema.optional(Schema.NullOr(WorkflowQueueReason)),
  originSummary: Schema.optional(WorkflowOriginSummary),
  targetKind: Schema.optional(Schema.Literals(["machine", "vm"])),
  jobId: RepositoryWorkflowJob.fields.jobId,
  repositoryId: RepositoryWorkflowJob.fields.repositoryId,
  workflowId: RepositoryWorkflowJob.fields.workflowId,
  runtime: RepositoryWorkflowJob.fields.runtime,
  instruction: RepositoryWorkflowJob.fields.instruction,
  status: RepositoryWorkflowJob.fields.status,
  detail: RepositoryWorkflowJob.fields.detail,
  createdAt: RepositoryWorkflowJob.fields.createdAt,
  updatedAt: RepositoryWorkflowJob.fields.updatedAt,
  needsAttention: Schema.optional(Schema.Boolean),
});
export type RepositoryWorkflowJobSummary = typeof RepositoryWorkflowJobSummary.Type;

export const WorkflowJobListView = Schema.Literals(["active", "attention", "history"]);
export type WorkflowJobListView = typeof WorkflowJobListView.Type;
export const WorkflowJobPageQuery = Schema.Struct({
  view: WorkflowJobListView,
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});
export type WorkflowJobPageQuery = typeof WorkflowJobPageQuery.Type;
export const WorkflowJobPage = Schema.Struct({
  jobs: Schema.Array(RepositoryWorkflowJobSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type WorkflowJobPage = typeof WorkflowJobPage.Type;

const ControlBinding = {
  organizationId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  projectId: ProjectId,
};
export const WorkflowControl = Schema.Union([
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("retry_saving"),
    publicationId: Schema.String.check(Schema.isUUID()),
    expectedRevision: Revision,
  }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("retry_action"),
    actionId: TrimmedNonEmptyString,
    expectedRevision: Revision,
  }),
  Schema.Struct({ ...ControlBinding, ...WorkflowManualControl.fields }),
  Schema.Struct({
    ...ControlBinding,
    operation: Schema.Literal("start"),
    workflow: RepositoryWorkflow,
    runtime: WorkflowRuntime,
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
  actions: Schema.optional(Schema.Array(Schema.Literals(["push", "open_pull_request"]))),
  protocol: Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  outcome: Schema.Literals(["accepted", "cancelled", "missing", "busy", "unavailable", "conflict"]),
  detail: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(WorkflowJobProgress),
});
export type WorkflowControlResult = typeof WorkflowControlResult.Type;

export const SaveRepositoryWorkflow = Schema.Struct({
  automation: Schema.optional(Schema.NullOr(WorkflowAutomation)),
  workflowId: TrimmedNonEmptyString,
  expectedRevision: Revision,
  definition: WorkflowDefinition,
  archived: Schema.Boolean,
});
export const RunRepositoryWorkflow = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  expectedTargetKind: Schema.Literals(["machine", "vm"]),
  instruction: Instruction,
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  replayOnly: Schema.optional(Schema.Boolean),
});
export const RespondToWorkflowJob = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("retry_saving"),
    publicationId: Schema.String.check(Schema.isUUID()),
    expectedRevision: Revision,
  }),
  Schema.Struct({
    operation: Schema.Literal("retry_action"),
    actionId: TrimmedNonEmptyString,
    expectedRevision: Revision,
  }),
  WorkflowManualControl,
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
export class WorkflowSubmissionPendingError extends Schema.TaggedError<WorkflowSubmissionPendingError>()(
  "WorkflowSubmissionPendingError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export function isTerminalWorkflowJob(status: RepositoryWorkflowJob["status"]): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}

/** Automatic zones are consecutive Agent and action steps; each human step forms a boundary. */
export function workflowZones(
  steps: ReadonlyArray<WorkflowStep>,
): ReadonlyArray<ReadonlyArray<WorkflowStep>> {
  const zones: Array<Array<WorkflowStep>> = [];
  for (const step of steps) {
    const previous = zones.at(-1);
    if (isAutomaticWorkflowStep(step) && previous?.[0] && isAutomaticWorkflowStep(previous[0]))
      previous.push(step);
    else zones.push([step]);
  }
  return zones;
}

export const isAutomaticWorkflowStep = (step: WorkflowStep) =>
  step.kind === "agent" || step.kind === "action";

/** Derived readiness is separate from the saved rule; absence means an older relay. */
export const WorkflowAutomationSummary = Schema.Struct({
  workflowId: Schema.String,
  revision: Schema.Int,
  state: Schema.Literals(["off", "on", "needs_attention"]),
  reason: Schema.NullOr(Schema.String),
});
export type WorkflowAutomationSummary = typeof WorkflowAutomationSummary.Type;

export const WorkflowVmModelCatalog = Schema.Struct({
  defaultModel: TrimmedNonEmptyString,
  models: Schema.Array(ServerProviderModel),
});
export type WorkflowVmModelCatalog = typeof WorkflowVmModelCatalog.Type;

export const WorkflowCatalog = Schema.Struct({
  workflows: Schema.Array(RepositoryWorkflow),
  automationSupported: Schema.optional(Schema.Boolean),
  vmExecutionAvailable: Schema.optional(Schema.Boolean),
  vmAutomationAvailable: Schema.optional(Schema.Boolean),
  automationSummaries: Schema.optional(Schema.Array(WorkflowAutomationSummary)),
  vmAuthoring: Schema.optional(Schema.Struct({ models: Schema.NullOr(WorkflowVmModelCatalog) })),
});
export type WorkflowCatalog = typeof WorkflowCatalog.Type;
