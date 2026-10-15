import type {
  RepositoryWorkflow,
  RepositoryWorkflowJob,
  WorkflowDefinition,
} from "@t3tools/contracts/workflows";
import {
  WorkflowDefinition as WorkflowDefinitionSchema,
  WorkflowStep as WorkflowStepSchema,
  workflowDefinitionError,
} from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  clearAcknowledgedWorkflowDraft,
  type WorkflowManualSubmission,
  type WorkflowDraftSubmission,
} from "./workflowResponses.ts";
import type { RelayRepositoryId } from "@t3tools/contracts/relay";

export interface WorkflowScope {
  readonly accountId: string;
  readonly organizationId: string;
  readonly repositoryId: RelayRepositoryId;
}

export interface WorkflowEditorDraft {
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly baseline: RepositoryWorkflow | null;
  readonly selectedStepId: string;
  readonly targetConfirmed: boolean;
  readonly operation: {
    readonly requestId: string;
    readonly state: "pending" | "uncertain";
    readonly definition: WorkflowDefinition;
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
  } | null;
  readonly startedJobId: string | null;
  readonly error: string | null;
}

export interface WorkflowDraftState {
  readonly accountId: string | null;
  readonly editors: Record<string, WorkflowEditorDraft>;
  readonly newWorkflowIds: Record<string, string>;
  readonly runs: Record<string, WorkflowRunDraft>;
  readonly responses: Record<string, Record<string, string>>;
  readonly manual: Record<string, WorkflowManualSubmission>;
  readonly submitted: Record<string, Record<string, WorkflowDraftSubmission>>;
}

export interface WorkflowJobRead {
  readonly job: RepositoryWorkflowJob | null;
  readonly highestRevision: number;
  readonly epoch: number;
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
  }));
  const reads = registry.get(workflowJobReadAtom);
  if (reads.accountId === scope.accountId)
    registry.set(workflowJobReadAtom, { ...reads, jobs: remove(reads.jobs) });
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
  return !draft.baseline || !sameWorkflowDefinition(draft.definition, draft.baseline.definition);
}

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
    const index = definition.steps.findIndex(
      (step, index) =>
        step.kind === "review" &&
        !definition.steps
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.kind === "agent" && (!step.reworkStepId || earlier.id === step.reworkStepId),
          ),
    );
    return { message: structural, stepId: definition.steps[index]?.id ?? null, field: "rework" };
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
export const recentWorkflowJobs = <A extends { status: string; createdAt: string }>(
  jobs: ReadonlyArray<A>,
) =>
  [...jobs].sort((left, right) => {
    const priority = (status: string) =>
      ["awaiting_review", "awaiting_input"].includes(status)
        ? 0
        : ["done", "cancelled", "failed"].includes(status)
          ? 2
          : 1;
    return (
      priority(left.status) - priority(right.status) ||
      right.createdAt.localeCompare(left.createdAt)
    );
  });

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
) {
  const state = registry.get(workflowJobReadAtom);
  const previous = state.jobs[request.key];
  if (state.accountId !== request.accountId || previous?.epoch !== request.epoch) return false;
  const lowerRevision =
    typeof result !== "string" &&
    result.progress !== null &&
    result.progress.revision < previous.highestRevision;
  registry.set(workflowJobReadAtom, {
    ...state,
    jobs: {
      ...state.jobs,
      [request.key]: {
        ...previous,
        reading: false,
        mutation: null,
        error: typeof result === "string" ? result : null,
        highestRevision:
          typeof result === "string"
            ? previous.highestRevision
            : Math.max(previous.highestRevision, result.progress?.revision ?? -1),
        job:
          state.activeKey !== request.key
            ? null
            : typeof result === "string" || lowerRevision
              ? previous.job
              : result,
      },
    },
  });
  const accepted = typeof result !== "string" && !lowerRevision;
  if (accepted)
    updateWorkflowDrafts(registry, request.accountId, (drafts) => {
      let responses = drafts.responses[request.key] ?? {};
      for (const submission of Object.values(drafts.submitted[request.key] ?? {}))
        responses = clearAcknowledgedWorkflowDraft(responses, submission, result.progress);
      return responses === drafts.responses[request.key] || !drafts.responses[request.key]
        ? drafts
        : { ...drafts, responses: { ...drafts.responses, [request.key]: responses } };
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
  submission: WorkflowDraftSubmission,
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
