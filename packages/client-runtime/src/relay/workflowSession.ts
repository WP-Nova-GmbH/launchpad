import type {
  RepositoryWorkflow,
  WorkflowSavedResult,
  WorkflowAutomation,
  RepositoryWorkflowJob,
  WorkflowDefinition,
  WorkflowJobPage,
  RepositoryWorkflowJobSummary,
  WorkflowVmTarget,
} from "@t3tools/contracts/workflows";
import type { EnvironmentId, ThreadId, OrchestrationGetTurnDiffResult } from "@t3tools/contracts";
import {
  WorkflowDefinition as WorkflowDefinitionSchema,
  WorkflowAutomation as WorkflowAutomationSchema,
  WorkflowStep as WorkflowStepSchema,
  workflowDefinitionError,
  workflowPublishingPrerequisites,
} from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  clearAcknowledgedWorkflowDraft,
  type WorkflowManualSubmission,
  type WorkflowDraftSubmission,
} from "./workflowResponses.ts";
import {
  RelayAuthInvalidError,
  RelayTenancyForbiddenError,
  RelayTenancyNotFoundError,
  type RelayRepositoryId,
} from "@t3tools/contracts/relay";
import {
  sameWorkflowResultCheckpoint,
  workflowResultCheckpoint,
  type WorkflowResultCheckpoint,
  type WorkflowResultOrigin,
} from "./workflowResult.ts";
import { isCompleteWorkflowReviewDiff } from "../state/checkpointDiff.ts";

export interface WorkflowScope {
  readonly accountId: string;
  readonly organizationId: string;
  readonly repositoryId: RelayRepositoryId;
}

export interface WorkflowEditorDraft {
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly automation?: WorkflowAutomation;
  /** False when an older relay omitted the saved rule; a display default is not Save intent. */
  readonly automationResolved?: boolean;
  readonly triggerSetup?: boolean;
  readonly baseline: RepositoryWorkflow | null;
  readonly selectedStepId: string;
  readonly targetConfirmed: boolean;
  /** Editor-only VM choice while Machine is selected. Retained until the draft is reset or VM is selected again. */
  readonly lastVmTarget?: typeof WorkflowVmTarget.Type;
  readonly saveRecovery?: "retryable" | "conflict" | "check-failed" | undefined;
  readonly operation: {
    readonly requestId: string;
    readonly state: "pending" | "uncertain";
    readonly definition: WorkflowDefinition;
    readonly automation?: WorkflowAutomation;
    /** Absent only on a retained operation captured before wire intent was tracked. */
    readonly includesAutomation?: boolean;
    readonly archived: boolean;
    readonly expectedRevision: number;
  } | null;
  readonly error: string | null;
}

export interface WorkflowRunDraft {
  readonly instruction: string;
  readonly operation: {
    readonly requestId: string;
    readonly state: "pending" | "uncertain";
    readonly instruction: string;
    /** VM requests replay the captured payload. Machine submissions retain their existing retry flow. */
    readonly targetKind?: "vm";
  } | null;
  readonly startedJobId: string | null;
  readonly error: string | null;
}

interface WorkflowSessionSubmission extends WorkflowDraftSubmission {
  readonly requestEpoch?: number;
  readonly acceptedPending?: true;
}

export interface WorkflowDraftState {
  readonly accountId: string | null;
  readonly editors: Record<string, WorkflowEditorDraft>;
  readonly newWorkflowIds: Record<string, string>;
  readonly runs: Record<string, WorkflowRunDraft>;
  readonly responses: Record<string, Record<string, string>>;
  readonly manual: Record<string, WorkflowManualSubmission>;
  readonly submitted: Record<string, Record<string, WorkflowSessionSubmission>>;
  readonly reviews: Record<string, WorkflowReviewVisit>;
}

interface WorkflowReviewPlacement {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly generation: number;
}

interface WorkflowReviewVisit {
  readonly id: string;
  readonly checkpoint: WorkflowResultCheckpoint;
  readonly placement: WorkflowReviewPlacement | null;
  readonly verified: boolean;
  readonly readAfterEpoch: number;
}

export interface WorkflowJobRead {
  readonly job: RepositoryWorkflowJob | null;
  readonly highestRevision: number;
  readonly epoch: number;
  readonly acceptedReadEpoch: number;
  readonly reading: boolean;
  readonly mutation: string | null;
  readonly error: string | null;
}
export interface WorkflowReadState {
  readonly accountId: string | null;
  readonly sequence: number;
  readonly activeKey: string | null;
  readonly jobs: Record<string, WorkflowJobRead>;
}

const emptyDrafts = (accountId: string | null): WorkflowDraftState => ({
  accountId,
  editors: {},
  newWorkflowIds: {},
  runs: {},
  responses: {},
  manual: {},
  submitted: {},
  reviews: {},
});
export const workflowDraftAtom = Atom.make(emptyDrafts(null)).pipe(Atom.keepAlive);
export const workflowJobReadAtom = Atom.make<WorkflowReadState>({
  accountId: null,
  sequence: 0,
  activeKey: null,
  jobs: {},
}).pipe(Atom.keepAlive);
export const emptyWorkflowRun: WorkflowRunDraft = {
  instruction: "",
  operation: null,
  startedJobId: null,
  error: null,
};
export const emptyWorkflowJobRead: WorkflowJobRead = {
  job: null,
  highestRevision: -1,
  epoch: 0,
  acceptedReadEpoch: 0,
  reading: false,
  mutation: null,
  error: null,
};

/** Keys never cross account, organization or repository boundaries. */
export const workflowSessionKey = (scope: WorkflowScope, id: string) =>
  JSON.stringify([scope.accountId, scope.organizationId, scope.repositoryId, id]);

/** Auth providers own session reset; view unmounts leave drafts and pending writes alive. */
export function setWorkflowSessionAccount(
  registry: AtomRegistry.AtomRegistry,
  accountId: string | null,
) {
  if (registry.get(workflowDraftAtom).accountId === accountId) return;
  registry.set(workflowDraftAtom, emptyDrafts(accountId));
  registry.set(workflowJobReadAtom, {
    accountId,
    sequence: registry.get(workflowJobReadAtom).sequence + 1,
    activeKey: null,
    jobs: {},
  });
}

export function updateWorkflowDrafts(
  registry: AtomRegistry.AtomRegistry,
  accountId: string,
  update: (state: WorkflowDraftState) => WorkflowDraftState,
) {
  const previous = registry.get(workflowDraftAtom);
  if (previous.accountId !== accountId) return false;
  registry.set(workflowDraftAtom, update(previous));
  return true;
}

export function clearWorkflowScope(registry: AtomRegistry.AtomRegistry, scope: WorkflowScope) {
  const prefix =
    JSON.stringify([scope.accountId, scope.organizationId, scope.repositoryId]).slice(0, -1) + ",";
  const remove = <A>(entries: Record<string, A>) =>
    Object.fromEntries(Object.entries(entries).filter(([key]) => !key.startsWith(prefix)));
  updateWorkflowDrafts(registry, scope.accountId, (state) => ({
    ...state,
    editors: remove(state.editors),
    newWorkflowIds: remove(state.newWorkflowIds),
    runs: remove(state.runs),
    responses: remove(state.responses),
    manual: remove(state.manual),
    submitted: remove(state.submitted),
    reviews: remove(state.reviews),
  }));
  const reads = registry.get(workflowJobReadAtom);
  if (reads.accountId === scope.accountId)
    registry.set(workflowJobReadAtom, { ...reads, jobs: remove(reads.jobs) });
}

/** A failed or abandoned diff visit must still prevent approving without its result. */
export function beginWorkflowReview(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
  id: string,
  checkpoint: WorkflowResultCheckpoint,
) {
  const key = workflowSessionKey(scope, jobId);
  updateWorkflowDrafts(registry, scope.accountId, (state) => ({
    ...state,
    reviews: {
      ...state.reviews,
      [key]: {
        id,
        checkpoint,
        placement: null,
        verified: false,
        readAfterEpoch: registry.get(workflowJobReadAtom).sequence,
      },
    },
  }));
}

export function bindWorkflowReviewPlacement(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
  id: string,
  placement: WorkflowReviewPlacement,
) {
  const key = workflowSessionKey(scope, jobId);
  const state = registry.get(workflowDraftAtom);
  const review = state.reviews[key];
  if (state.accountId !== scope.accountId || review?.id !== id || review.placement) return;
  registry.set(workflowDraftAtom, {
    ...state,
    reviews: { ...state.reviews, [key]: { ...review, placement } },
  });
}

/** Called only by the current visible diff query, never by result navigation alone. */
export function recordWorkflowReviewDiff(
  registry: AtomRegistry.AtomRegistry,
  origin: WorkflowResultOrigin,
  placement: WorkflowReviewPlacement,
  diff: OrchestrationGetTurnDiffResult,
) {
  const key = workflowSessionKey(origin, origin.jobId);
  const state = registry.get(workflowDraftAtom);
  const review = state.reviews[key];
  if (
    state.accountId !== origin.accountId ||
    !review ||
    review.id !== origin.reviewVisitId ||
    !origin.reviewCheckpoint ||
    !sameWorkflowResultCheckpoint(review.checkpoint, origin.reviewCheckpoint) ||
    origin.threadId !== placement.threadId ||
    review.verified ||
    review.placement?.environmentId !== placement.environmentId ||
    review.placement.threadId !== placement.threadId ||
    review.placement.generation !== placement.generation ||
    !isCompleteWorkflowReviewDiff(diff, review.checkpoint.turnId) ||
    diff.threadId !== placement.threadId ||
    diff.toTurnCount !== review.checkpoint.checkpointTurnCount ||
    diff.fromTurnCount !== diff.toTurnCount - 1
  )
    return false;
  registry.set(workflowDraftAtom, {
    ...state,
    reviews: {
      ...state.reviews,
      [key]: {
        ...review,
        verified: true,
        readAfterEpoch: registry.get(workflowJobReadAtom).sequence,
      },
    },
  });
  return true;
}

export function requireFreshWorkflowReviewRead(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
) {
  const key = workflowSessionKey(scope, jobId);
  const state = registry.get(workflowDraftAtom);
  const review = state.reviews[key];
  if (state.accountId !== scope.accountId || !review) return;
  invalidateWorkflowJobRead(registry, scope, jobId);
  registry.set(workflowDraftAtom, {
    ...state,
    reviews: {
      ...state.reviews,
      [key]: { ...review, readAfterEpoch: registry.get(workflowJobReadAtom).sequence },
    },
  });
}

/** Evidence comes from the visible immutable saved diff, without a VM placement. */
export function recordSavedWorkflowReviewDiff(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
  visitId: string,
  result: WorkflowSavedResult,
) {
  const key = workflowSessionKey(scope, jobId);
  const state = registry.get(workflowDraftAtom);
  const review = state.reviews[key];
  const read = registry.get(workflowJobReadAtom).jobs[key];
  const current = workflowResultCheckpoint(read?.job?.progress?.checkpoint);
  if (
    state.accountId !== scope.accountId ||
    !review ||
    review.id !== visitId ||
    !current ||
    !sameWorkflowResultCheckpoint(current, review.checkpoint) ||
    result.outcome !== "completed" ||
    result.turnId !== current.turnId ||
    result.turnCount !== current.checkpointTurnCount ||
    read?.job?.progress?.checkpoint?.kind === "input" ||
    result.checkpointRef !== read?.job?.progress?.checkpoint?.checkpointRef
  )
    return false;
  registry.set(workflowDraftAtom, {
    ...state,
    reviews: {
      ...state.reviews,
      [key]: {
        ...review,
        verified: true,
        readAfterEpoch: registry.get(workflowJobReadAtom).sequence,
      },
    },
  });
  return true;
}

export function workflowReviewApprovalState(
  review: WorkflowReviewVisit | undefined,
  read: WorkflowJobRead,
) {
  if (!review)
    return read.job?.runtime?.kind === "vm" && read.job.progress?.checkpoint?.kind !== "input"
      ? "inspect"
      : "allowed";
  if (read.acceptedReadEpoch <= review.readAfterEpoch) return "checking";
  const checkpoint = workflowResultCheckpoint(read.job?.progress?.checkpoint);
  return review.verified &&
    checkpoint &&
    sameWorkflowResultCheckpoint(review.checkpoint, checkpoint)
    ? "allowed"
    : "inspect";
}

/** The new route and the saved route share one editor from its first allocation. */
export function startNewWorkflowDraft(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  create: () => WorkflowEditorDraft | null,
  fresh = false,
) {
  let id: string | null = null;
  const slot = workflowSessionKey(scope, "new");
  updateWorkflowDrafts(registry, scope.accountId, (state) => {
    const previousId = state.newWorkflowIds[slot];
    const previous = previousId ? state.editors[workflowSessionKey(scope, previousId)] : undefined;
    if (previous && (!fresh || !previous.baseline)) {
      id = previous.workflowId;
      return state;
    }
    const draft = create();
    const slots = { ...state.newWorkflowIds };
    if (!draft) {
      if (!fresh || !previousId) return state;
      if (fresh) delete slots[slot];
      return { ...state, newWorkflowIds: slots };
    }
    id = draft.workflowId;
    return {
      ...state,
      newWorkflowIds: { ...slots, [slot]: id },
      editors: { ...state.editors, [workflowSessionKey(scope, id)]: draft },
    };
  });
  return id;
}

/** Compare the retained draft before installing a replacement approved by the caller. */
export function replaceNewWorkflowDraft(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  expected: WorkflowEditorDraft | undefined,
  draft: WorkflowEditorDraft,
) {
  let installed = false;
  updateWorkflowDrafts(registry, scope.accountId, (state) => {
    const slot = workflowSessionKey(scope, "new");
    const previousId = state.newWorkflowIds[slot];
    const previous = previousId ? state.editors[workflowSessionKey(scope, previousId)] : undefined;
    if (previous !== expected || previous?.operation || draft.baseline || draft.operation)
      return state;
    const editors = { ...state.editors };
    if (previous && !previous.baseline)
      delete editors[workflowSessionKey(scope, previous.workflowId)];
    editors[workflowSessionKey(scope, draft.workflowId)] = draft;
    installed = true;
    return {
      ...state,
      editors,
      newWorkflowIds: { ...state.newWorkflowIds, [slot]: draft.workflowId },
    };
  });
  return installed;
}

export function workflowEditorDirty(draft: WorkflowEditorDraft) {
  return (
    !draft.baseline ||
    !sameWorkflowDefinition(draft.definition, draft.baseline.definition) ||
    !sameWorkflowAutomation(workflowDraftAutomation(draft), draft.baseline.automation)
  );
}

export const normalizeWorkflowAutomation = (
  value?: WorkflowAutomation | null,
): WorkflowAutomation => ({
  enabled: value?.enabled ?? false,
  trigger: value?.trigger
    ? { ...value.trigger, labelIds: [...new Set(value.trigger.labelIds)].sort() }
    : null,
});
export const workflowDraftAutomationResolved = (
  draft: Pick<WorkflowEditorDraft, "automationResolved" | "baseline">,
) => draft.automationResolved ?? (!draft.baseline || draft.baseline.automation !== undefined);

export const workflowDraftAutomation = (
  draft: Pick<WorkflowEditorDraft, "automation" | "baseline">,
) => normalizeWorkflowAutomation(draft.automation ?? draft.baseline?.automation);
const equivalentAutomation = Schema.toEquivalence(WorkflowAutomationSchema);
export const sameWorkflowAutomation = (
  a?: WorkflowAutomation | null,
  b?: WorkflowAutomation | null,
) => equivalentAutomation(normalizeWorkflowAutomation(a), normalizeWorkflowAutomation(b));

/** Explicit departure detaches a pending Save without cancelling its captured request. */
export function discardWorkflowEditor(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  id: string,
) {
  updateWorkflowDrafts(registry, scope.accountId, (state) => {
    const editors = { ...state.editors };
    const newWorkflowIds = { ...state.newWorkflowIds };
    delete editors[workflowSessionKey(scope, id)];
    const slot = workflowSessionKey(scope, "new");
    if (newWorkflowIds[slot] === id) delete newWorkflowIds[slot];
    return { ...state, editors, newWorkflowIds };
  });
}

export const workflowCatalogRevisionAtom = Atom.make(0).pipe(Atom.keepAlive);
export const sameWorkflowDefinition = Schema.toEquivalence(WorkflowDefinitionSchema);
const decodeWorkflowDefinition = Schema.decodeExit(WorkflowDefinitionSchema);
const decodeWorkflowStep = Schema.decodeExit(WorkflowStepSchema);

export function hasUnsavedWorkflowWork(state: WorkflowDraftState) {
  return (
    Object.values(state.editors).some((draft) => workflowEditorDirty(draft) || !!draft.operation) ||
    Object.values(state.runs).some((draft) => !!draft.instruction || !!draft.operation) ||
    Object.values(state.responses).some((drafts) =>
      Object.values(drafts).some((text) => !!text.trim()),
    )
  );
}

/** Validate unmounted steps too; the selected inspector's DOM is not the definition. */
export function workflowDraftIssue(definition: WorkflowDefinition) {
  const publishing =
    definition.target.kind === "vm"
      ? definition.steps.find((step) => step.kind === "action")
      : undefined;
  if (publishing)
    return {
      message:
        "Publishing requires a Machine target. Remove Push branch and Open PR steps to use VM.",
      stepId: publishing.id,
      field: "title",
      publishing: true,
    };
  if (Exit.isSuccess(decodeWorkflowDefinition(definition))) return null;
  if (!definition.name.trim())
    return { message: "Give this workflow a name.", stepId: null, field: "name" };
  for (const step of definition.steps) {
    if (Exit.isSuccess(decodeWorkflowStep(step))) continue;
    const field =
      !step.title.trim() || step.title.length > 120
        ? "title"
        : step.kind === "agent"
          ? "instruction"
          : step.kind === "input"
            ? "question"
            : "rework";
    return {
      message: `Check ${step.title || "this step"}: a name and valid required text are needed.`,
      stepId: step.id,
      field,
    };
  }
  const structural = workflowDefinitionError(definition.steps);
  if (structural) {
    const step = definition.steps.find((step, index) => {
      if (step.kind === "action") {
        const { agent, push } = workflowPublishingPrerequisites(definition.steps, index);
        return !agent || (step.action === "open_pull_request" && !push);
      }
      return (
        step.kind === "review" &&
        !definition.steps
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.kind === "agent" && (!step.reworkStepId || earlier.id === step.reworkStepId),
          )
      );
    });
    return {
      message: structural,
      stepId: step?.id ?? null,
      field: step?.kind === "action" ? "title" : "rework",
      ...(step?.kind === "action" ? { publishing: true } : {}),
    };
  }
  return {
    message: "Check the workflow name, execution target and the limit of 32 steps.",
    stepId: null,
    field: "name",
  };
}

export function workflowStepState(job: RepositoryWorkflowJob | null | undefined, stepId: string) {
  const progress = job?.progress;
  let entry = progress?.steps?.find((step) => step.stepId === stepId);
  for (const next of progress?.steps ?? []) {
    if (next.stepId === stepId && (!entry || next.generation > entry.generation)) entry = next;
  }
  if (entry) return entry.status;
  return progress?.checkpoint?.stepId === stepId || progress?.stepId === stepId
    ? "running"
    : "pending";
}

export const workflowStatusLabel = (status: string) =>
  ({
    awaiting_review: "Needs review",
    awaiting_input: "Needs input",
    waiting_capacity: "Waiting for capacity",
    done: "Completed",
    queued: "Queued",
    dispatching: "Starting",
    preparing: "Preparing",
    running: "Running",
    finishing: "Finishing",
    paused: "Paused",
    cancelling: "Cancelling",
    cancelled: "Cancelled",
    failed: "Failed",
  })[status] ?? status.replaceAll("_", " ");
interface JobRequest {
  readonly accountId: string;
  readonly key: string;
  readonly epoch: number;
}

/** A mutation invalidates earlier reads even when executor progress has not advanced. */
export function beginWorkflowJobRequest(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
  mutation?: string,
) {
  const state = registry.get(workflowJobReadAtom);
  if (state.accountId !== scope.accountId) return null;
  const key = workflowSessionKey(scope, jobId);
  const previous = state.jobs[key] ?? emptyWorkflowJobRead;
  if (previous.mutation || (!mutation && previous.reading)) return null;
  const epoch = state.sequence + 1;
  registry.set(workflowJobReadAtom, {
    ...state,
    sequence: epoch,
    jobs: {
      ...state.jobs,
      [key]: { ...previous, epoch, reading: !mutation, mutation: mutation ?? null },
    },
  });
  return { accountId: scope.accountId, key, epoch } satisfies JobRequest;
}

export function settleWorkflowJobRequest(
  registry: AtomRegistry.AtomRegistry,
  request: JobRequest,
  result: RepositoryWorkflowJob | string,
  accessLost = false,
) {
  const state = registry.get(workflowJobReadAtom);
  const previous = state.jobs[request.key];
  if (state.accountId !== request.accountId || previous?.epoch !== request.epoch) return false;
  const lowerRevision =
    typeof result !== "string" &&
    result.progress !== null &&
    result.progress.revision < previous.highestRevision;
  const accepted = typeof result !== "string" && !lowerRevision;
  registry.set(workflowJobReadAtom, {
    ...state,
    jobs: {
      ...state.jobs,
      [request.key]: {
        ...previous,
        reading: false,
        mutation: null,
        acceptedReadEpoch:
          accepted && previous.reading && state.activeKey === request.key
            ? request.epoch
            : previous.acceptedReadEpoch,
        error: typeof result === "string" ? result : null,
        highestRevision:
          typeof result === "string"
            ? previous.highestRevision
            : Math.max(previous.highestRevision, result.progress?.revision ?? -1),
        job:
          state.activeKey !== request.key || accessLost
            ? null
            : typeof result === "string" || lowerRevision
              ? previous.job
              : result,
      },
    },
  });
  if (accepted)
    updateWorkflowDrafts(registry, request.accountId, (drafts) => {
      const previousResponses = drafts.responses[request.key] ?? {};
      let responses = previousResponses;
      const submissions = drafts.submitted[request.key];
      for (const submission of Object.values(submissions ?? {}))
        responses = clearAcknowledgedWorkflowDraft(responses, submission, result.progress);

      const pendingId = result.responsePending
        ? result.progress?.checkpoint?.checkpointId
        : undefined;
      const submission = pendingId ? submissions?.[pendingId] : undefined;
      // Only the reply to this send can attribute the queued response to this viewer.
      const acceptedPending =
        pendingId &&
        previous.mutation &&
        submission?.requestEpoch === request.epoch &&
        submission.operation === result.pendingResponseOperation
          ? { ...submissions, [pendingId]: { ...submission, acceptedPending: true as const } }
          : null;
      if (responses === previousResponses && !acceptedPending) return drafts;
      return {
        ...drafts,
        responses:
          responses === previousResponses
            ? drafts.responses
            : { ...drafts.responses, [request.key]: responses },
        submitted: acceptedPending
          ? { ...drafts.submitted, [request.key]: acceptedPending }
          : drafts.submitted,
      };
    });
  return accepted;
}

/** Keep the visible/last-inspected snapshot, rather than every opened run's frozen prompts. */
export function activateWorkflowJobView(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
) {
  const state = registry.get(workflowJobReadAtom);
  if (state.accountId !== scope.accountId) return;
  const key = workflowSessionKey(scope, jobId);
  if (state.activeKey === key) return;
  const jobs = Object.fromEntries(
    Object.entries(state.jobs).map(([id, read]) => [
      id,
      id !== key && !read.mutation ? { ...read, job: null } : read,
    ]),
  );
  registry.set(workflowJobReadAtom, { ...state, activeKey: key, jobs });
}

/** A later read can prove a response accepted even when its original reply was lost. */
export function recordWorkflowResponse(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
  submission: WorkflowSessionSubmission,
) {
  if (
    !submission.checkpointId ||
    submission.text === null ||
    !["input", "request_changes"].includes(submission.operation)
  )
    return;
  const key = workflowSessionKey(scope, jobId);
  updateWorkflowDrafts(registry, scope.accountId, (state) => ({
    ...state,
    submitted: {
      ...state.submitted,
      [key]: { ...state.submitted[key], [submission.checkpointId!]: submission },
    },
  }));
}

export function invalidateWorkflowJobRead(
  registry: AtomRegistry.AtomRegistry,
  scope: WorkflowScope,
  jobId: string,
) {
  const state = registry.get(workflowJobReadAtom);
  const key = workflowSessionKey(scope, jobId);
  const previous = state.jobs[key];
  if (state.accountId !== scope.accountId || !previous || previous.mutation) return;
  registry.set(workflowJobReadAtom, {
    ...state,
    sequence: state.sequence + 1,
    jobs: { ...state.jobs, [key]: { ...previous, epoch: state.sequence + 1, reading: false } },
  });
}

/** Refresh the loaded window so automatic updates do not discard paginated runs. */
export async function readWorkflowJobPages(
  readPage: (cursor: string | null) => Promise<WorkflowJobPage>,
  {
    cursor = null,
    minimumCount = 0,
    isCurrent = () => true,
  }: {
    cursor?: string | null;
    minimumCount?: number;
    isCurrent?: () => boolean;
  } = {},
): Promise<WorkflowJobPage> {
  let page = await readPage(cursor);
  const jobs = [...page.jobs];
  while (page.nextCursor && page.jobs.length && jobs.length < minimumCount && isCurrent()) {
    page = await readPage(page.nextCursor);
    jobs.push(...page.jobs);
  }
  return { jobs, nextCursor: page.nextCursor };
}

/** A list request owns exactly one scope/view and cursor. Refresh replaces all loaded pages. */
export interface WorkflowJobPageRequest {
  readonly key: string;
  readonly cursor: string | null;
}
export interface WorkflowJobPageRead {
  readonly key: string;
  readonly jobs: ReadonlyArray<RepositoryWorkflowJobSummary> | null;
  readonly nextCursor: string | null;
  readonly request: WorkflowJobPageRequest | null;
  readonly error: string | null;
}
export const emptyWorkflowJobPageRead: WorkflowJobPageRead = {
  key: "",
  jobs: null,
  nextCursor: null,
  request: null,
  error: null,
};
export function beginWorkflowJobPage(
  read: WorkflowJobPageRead,
  request: WorkflowJobPageRequest,
): WorkflowJobPageRead {
  return {
    ...(read.key === request.key ? read : emptyWorkflowJobPageRead),
    key: request.key,
    request,
    error: null,
  };
}
export function settleWorkflowJobPage(
  read: WorkflowJobPageRead,
  request: WorkflowJobPageRequest,
  result: WorkflowJobPage | string,
  accessLost = false,
): WorkflowJobPageRead {
  if (read.request !== request) return read;
  if (typeof result === "string")
    return {
      ...(accessLost ? { ...emptyWorkflowJobPageRead, key: read.key } : read),
      request: null,
      error: result,
    };
  const rows = request.cursor === null ? result.jobs : [...(read.jobs ?? []), ...result.jobs];
  return {
    ...read,
    jobs: [...new Map(rows.map((job) => [job.jobId, job])).values()],
    nextCursor: result.nextCursor,
    request: null,
    error: null,
  };
}

/** A definite access rejection must not keep run data visible as offline data. */
export const workflowJobAccessLost = Schema.is(
  Schema.Struct({
    cause: Schema.Union([
      RelayAuthInvalidError,
      RelayTenancyForbiddenError,
      RelayTenancyNotFoundError,
    ]),
  }),
);
