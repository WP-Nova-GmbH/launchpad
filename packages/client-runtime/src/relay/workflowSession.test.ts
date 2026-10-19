import { afterEach, describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayTenancyForbiddenError, RelayRepositoryId } from "@t3tools/contracts/relay";
import type { RepositoryWorkflowJob, WorkflowDefinition } from "@t3tools/contracts/workflows";
import {
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  recordWorkflowResponse,
  settleWorkflowJobRequest,
  invalidateWorkflowJobRead,
  workflowJobReadAtom,
  workflowDraftAtom,
  sameWorkflowAutomation,
  workflowEditorDirty,
  discardWorkflowEditor,
  workflowSessionKey,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  clearWorkflowScope,
  workflowDraftIssue,
  workflowStepState,
  startNewWorkflowDraft,
  workflowJobPageAccessLost,
  emptyWorkflowJobPageRead,
  beginWorkflowJobPage,
  settleWorkflowJobPage,
} from "./workflowSession.ts";

const scope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const definition: WorkflowDefinition = {
  name: "Implementation",
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  steps: [
    {
      id: "agent",
      kind: "agent",
      title: "Implement",
      instruction: "Do the work",
      modelSelection: null,
    },
    { id: "review", kind: "review", title: "Review", role: "maintainer", reworkStepId: "agent" },
  ],
};
const job = (revision = 1): RepositoryWorkflowJob => ({
  jobId: "job",
  repositoryId: scope.repositoryId,
  workflowId: "workflow",
  environmentId: definition.environmentId,
  instruction: "Task",
  status: "running",
  detail: null,
  workflow: null,
  progress: {
    revision,
    status: "running",
    threadId: ThreadId.make("thread"),
    detail: null,
    checkpoint: null,
    stepId: "agent",
  },
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
});
const registries: AtomRegistry.AtomRegistry[] = [];
const setup = () => {
  const registry = AtomRegistry.make();
  registries.push(registry);
  setWorkflowSessionAccount(registry, scope.accountId);
  activateWorkflowJobView(registry, scope, "job");
  return registry;
};
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe("workflow session and request ownership", () => {
  it("resumes one new workflow slot without allocating another editor", () => {
    const registry = setup();
    let allocations = 0;
    const create = () => ({
      workflowId: `draft-${++allocations}`,
      definition,
      baseline: null,
      selectedStepId: "agent",
      targetConfirmed: true,
      operation: null,
      error: null,
    });
    const id = startNewWorkflowDraft(registry, scope, create)!;
    expect(startNewWorkflowDraft(registry, scope, create, true)).toBe(id);
    expect(allocations).toBe(1);
    expect(registry.get(workflowDraftAtom).newWorkflowIds[workflowSessionKey(scope, "new")]).toBe(
      id,
    );
    expect(Object.keys(registry.get(workflowDraftAtom).editors)).toEqual([
      workflowSessionKey(scope, id),
    ]);
  });
  it("preserves pending edits to a saved workflow when allocating another new workflow", () => {
    const registry = setup();
    let allocations = 0;
    const create = () => ({
      workflowId: `draft-${++allocations}`,
      definition,
      baseline: null,
      selectedStepId: "agent",
      targetConfirmed: true,
      operation: null,
      error: null,
    });
    const id = startNewWorkflowDraft(registry, scope, create)!;
    const key = workflowSessionKey(scope, id);
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      editors: {
        ...state.editors,
        [key]: {
          ...state.editors[key]!,
          baseline: {
            workflowId: id,
            organizationId: scope.organizationId,
            repositoryId: scope.repositoryId,
            revision: 1,
            definition,
            archived: false,
            createdAt: "now",
            updatedAt: "now",
          },
          definition: { ...definition, name: "Later edit" },
          operation: {
            requestId: "save",
            state: "pending",
            definition,
            archived: false,
            expectedRevision: 1,
          },
        },
      },
    }));
    const previous = registry.get(workflowDraftAtom).editors[key];
    expect(startNewWorkflowDraft(registry, scope, create, true)).not.toBe(id);
    expect(registry.get(workflowDraftAtom).editors[key]).toBe(previous);
  });
  it("clears new workflow slots with account and repository boundaries", () => {
    const registry = setup();
    const create = () => ({
      workflowId: "draft",
      definition,
      baseline: null,
      selectedStepId: "agent",
      targetConfirmed: true,
      operation: null,
      error: null,
    });
    startNewWorkflowDraft(registry, scope, create);
    clearWorkflowScope(registry, scope);
    expect(registry.get(workflowDraftAtom).newWorkflowIds).toEqual({});
    expect(registry.get(workflowDraftAtom).editors).toEqual({});
    startNewWorkflowDraft(registry, scope, create);
    setWorkflowSessionAccount(registry, null);
    expect(registry.get(workflowDraftAtom).newWorkflowIds).toEqual({});
    expect(startNewWorkflowDraft(registry, scope, create)).toBeNull();
  });
  it("releases inactive frozen snapshots while retaining their revision fence", () => {
    const registry = setup();
    const key = workflowSessionKey(scope, "job");
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(4));
    activateWorkflowJobView(registry, scope, "other-job");
    expect(registry.get(workflowJobReadAtom).jobs[key]).toMatchObject({
      job: null,
      highestRevision: 4,
    });
    activateWorkflowJobView(registry, scope, "job");
    expect(
      settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(3)),
    ).toBe(false);
  });
  it("settles an inactive mutation without caching another full snapshot", () => {
    const registry = setup();
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job());
    const pending = beginWorkflowJobRequest(registry, scope, "job", "approve")!;
    activateWorkflowJobView(registry, scope, "other-job");
    expect(settleWorkflowJobRequest(registry, pending, job(2))).toBe(true);
    expect(registry.get(workflowJobReadAtom).jobs[workflowSessionKey(scope, "job")]).toMatchObject({
      job: null,
      mutation: null,
      highestRevision: 2,
    });
  });
  it("accepts authoritative terminal states that have no executor progress", () => {
    const registry = setup();
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(4));
    const terminal = { ...job(), status: "cancelled" as const, progress: null };
    expect(
      settleWorkflowJobRequest(
        registry,
        beginWorkflowJobRequest(registry, scope, "job")!,
        terminal,
      ),
    ).toBe(true);
    expect(
      registry.get(workflowJobReadAtom).jobs[workflowSessionKey(scope, "job")]?.job?.status,
    ).toBe("cancelled");
  });
  it("clears a lost-reply response only after a later read proves exact acceptance", () => {
    const registry = setup();
    const key = workflowSessionKey(scope, "job");
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { checkpoint: "Feedback" } },
    }));
    recordWorkflowResponse(registry, scope, "job", {
      checkpointId: "checkpoint",
      operation: "request_changes",
      userId: scope.accountId,
      text: "Feedback",
    });
    const next = {
      ...job(2),
      progress: {
        ...job(2).progress!,
        responses: [
          {
            checkpointId: "checkpoint",
            stepId: "review",
            generation: 0,
            operation: "request_changes" as const,
            userId: scope.accountId,
            text: "Feedback",
            createdAt: "2026-10-13",
          },
        ],
      },
    };
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, next);
    expect(registry.get(workflowDraftAtom).responses[key]).toEqual({});
  });
  it("retains text edited during delivery when polling acknowledges the older submission", () => {
    const registry = setup();
    const key = workflowSessionKey(scope, "job");
    recordWorkflowResponse(registry, scope, "job", {
      checkpointId: "checkpoint",
      operation: "input",
      userId: scope.accountId,
      text: "Original",
    });
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { checkpoint: "Edited" } },
    }));
    const next = {
      ...job(2),
      progress: {
        ...job(2).progress!,
        responses: [
          {
            checkpointId: "checkpoint",
            stepId: "input",
            generation: 0,
            operation: "input" as const,
            userId: scope.accountId,
            text: "Original",
            createdAt: "2026-10-13",
          },
        ],
      },
    };
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, next);
    expect(registry.get(workflowDraftAtom).responses[key]?.checkpoint).toBe("Edited");
  });
  it("invalidates an older poll when a same-revision relay control is acknowledged", () => {
    const registry = setup();
    const poll = beginWorkflowJobRequest(registry, scope, "job")!;
    const mutation = beginWorkflowJobRequest(registry, scope, "job", "pause-request")!;
    const next = {
      ...job(),
      pendingManualControl: {
        operation: "pause" as const,
        expectedRevision: 1,
        controlId: "pause",
      },
    };
    expect(settleWorkflowJobRequest(registry, mutation, next)).toBe(true);
    expect(settleWorkflowJobRequest(registry, poll, job())).toBe(false);
    expect(
      registry.get(workflowJobReadAtom).jobs[workflowSessionKey(scope, "job")]?.job
        ?.pendingManualControl,
    ).toEqual(next.pendingManualControl);
  });
  it("keeps a mutation alive across view unmount and prevents duplicate controls", () => {
    const registry = setup();
    const request = beginWorkflowJobRequest(registry, scope, "job", "approve")!;
    invalidateWorkflowJobRead(registry, scope, "job");
    expect(beginWorkflowJobRequest(registry, scope, "job", "second-approve")).toBeNull();
    expect(beginWorkflowJobRequest(registry, scope, "job")).toBeNull();
    expect(settleWorkflowJobRequest(registry, request, job(2))).toBe(true);
  });
  it("never reuses a read token after signing out and returning to the same account", () => {
    const registry = setup();
    const old = beginWorkflowJobRequest(registry, scope, "job")!;
    setWorkflowSessionAccount(registry, null);
    setWorkflowSessionAccount(registry, scope.accountId);
    const current = beginWorkflowJobRequest(registry, scope, "job")!;
    expect(settleWorkflowJobRequest(registry, old, job(9))).toBe(false);
    expect(settleWorkflowJobRequest(registry, current, job(1))).toBe(true);
  });
  it("does not let cleared repository reads reappear after access is restored", () => {
    const registry = setup();
    const old = beginWorkflowJobRequest(registry, scope, "job")!;
    clearWorkflowScope(registry, scope);
    const current = beginWorkflowJobRequest(registry, scope, "job")!;
    expect(settleWorkflowJobRequest(registry, old, job())).toBe(false);
    expect(settleWorkflowJobRequest(registry, current, job(2))).toBe(true);
  });
  it("retains acknowledged progress through disconnects and rejects lower revisions", () => {
    const registry = setup();
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(4));
    expect(
      settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(3)),
    ).toBe(false);
    settleWorkflowJobRequest(
      registry,
      beginWorkflowJobRequest(registry, scope, "job")!,
      "Disconnected",
    );
    const read = registry.get(workflowJobReadAtom).jobs[workflowSessionKey(scope, "job")]!;
    expect(read.job?.progress?.revision).toBe(4);
    expect(read.error).toBe("Disconnected");
  });
  it("isolates response text by repository, job and checkpoint and clears it on sign-out", () => {
    const registry = setup();
    const other = { ...scope, repositoryId: RelayRepositoryId.make("other") };
    const key = workflowSessionKey(scope, "job");
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { checkpoint: "Feedback" } },
    }));
    expect(
      registry.get(workflowDraftAtom).responses[workflowSessionKey(other, "job")],
    ).toBeUndefined();
    setWorkflowSessionAccount(registry, null);
    expect(registry.get(workflowDraftAtom).responses).toEqual({});
  });
});

describe("whole workflow validation and presentation", () => {
  it("finds an invalid Agent regardless of which inspector is mounted", () => {
    const steps = definition.steps.map((step) =>
      step.kind === "agent" ? { ...step, instruction: "  " } : step,
    );
    expect(workflowDraftIssue({ ...definition, steps })).toMatchObject({
      stepId: "agent",
      field: "instruction",
    });
  });
  it("finds missing Input questions and excessive text", () => {
    expect(
      workflowDraftIssue({
        ...definition,
        steps: [
          ...definition.steps,
          { id: "input", kind: "input", title: "Question", role: "member", question: "" },
        ],
      }),
    ).toMatchObject({ stepId: "input", field: "question" });
    expect(
      workflowDraftIssue({
        ...definition,
        steps: [{ ...definition.steps[0]!, title: "a".repeat(121) }],
      }),
    ).toMatchObject({ stepId: "agent", field: "title" });
  });
  it("enforces the schema limit and leaves an invalid rework target visible", () => {
    expect(
      workflowDraftIssue({
        ...definition,
        steps: Array.from({ length: 33 }, (_, i) => ({ ...definition.steps[0]!, id: String(i) })),
      }),
    ).not.toBeNull();
    expect(
      workflowDraftIssue({
        ...definition,
        steps: [
          { ...definition.steps[1]!, reworkStepId: "missing", kind: "review", role: "maintainer" },
          definition.steps[0]!,
        ],
      }),
    ).toMatchObject({ stepId: "review", field: "rework" });
    expect(workflowDraftIssue(definition)).toBeNull();
  });
  it("does not infer completion from the position of a reworked step", () => {
    const current = {
      ...job(),
      progress: {
        ...job().progress!,
        stepId: "review",
        steps: [{ stepId: "agent", generation: 1, status: "pending" as const }],
      },
    };
    expect(workflowStepState(current, "agent")).toBe("pending");
  });
});

describe("workflow page response ownership", () => {
  const row = (jobId: string) => ({ ...job(), jobId });
  it("rejects old view/scope responses and refresh replaces every loaded page", () => {
    const first = { key: "account:org:repo:active", cursor: null };
    let read = beginWorkflowJobPage(emptyWorkflowJobPageRead, first);
    read = settleWorkflowJobPage(read, first, { jobs: [row("a")], nextCursor: "next" });
    const next = { key: first.key, cursor: "next" };
    read = beginWorkflowJobPage(read, next);
    read = settleWorkflowJobPage(read, next, { jobs: [row("a"), row("b")], nextCursor: null });
    expect(read.jobs?.map((j) => j.jobId)).toEqual(["a", "b"]);
    const refresh = { key: first.key, cursor: null };
    read = beginWorkflowJobPage(read, refresh);
    read = settleWorkflowJobPage(read, refresh, { jobs: [row("c")], nextCursor: "new-next" });
    expect(read.jobs?.map((j) => j.jobId)).toEqual(["c"]);
    const other = { key: "other-account:org:repo:history", cursor: null };
    read = beginWorkflowJobPage(read, other);
    expect(read.jobs).toBeNull();
    expect(settleWorkflowJobPage(read, next, { jobs: [row("late")], nextCursor: null })).toBe(read);
    read = settleWorkflowJobPage(read, other, "Offline");
    expect(read.error).toBe("Offline");
    expect(read.jobs).toBeNull();
  });
  it("retains loaded rows and retry cursor after an append fails", () => {
    const first = { key: "repo:active", cursor: null };
    let read = settleWorkflowJobPage(beginWorkflowJobPage(emptyWorkflowJobPageRead, first), first, {
      jobs: [row("a")],
      nextCursor: "next",
    });
    const next = { key: first.key, cursor: "next" };
    read = settleWorkflowJobPage(beginWorkflowJobPage(read, next), next, "Offline");
    expect(read.jobs?.map((j) => j.jobId)).toEqual(["a"]);
    expect(read.nextCursor).toBe("next");
  });
});

it("clears list rows and cursors after a definite repository access rejection", () => {
  const request = { key: "repo:active", cursor: null };
  let read = settleWorkflowJobPage(
    beginWorkflowJobPage(emptyWorkflowJobPageRead, request),
    request,
    { jobs: [job()], nextCursor: "next" },
  );
  const refresh = { key: request.key, cursor: null };
  const cause = {
    cause: new RelayTenancyForbiddenError({
      code: "tenancy_forbidden",
      reason: "no_repository_access",
      traceId: "trace",
    }),
  };
  expect(workflowJobPageAccessLost(cause)).toBe(true);
  expect(workflowJobPageAccessLost(new Error("Offline"))).toBe(false);
  read = settleWorkflowJobPage(
    beginWorkflowJobPage(read, refresh),
    refresh,
    "Access removed",
    workflowJobPageAccessLost(cause),
  );
  expect(read.jobs).toBeNull();
  expect(read.nextCursor).toBeNull();
});

const triggerRule = {
  provider: "linear",
  connectionId: "connection",
  grantId: "grant",
  teamId: "team",
  event: "issue_created",
  labelIds: ["a", "b"],
} as const;
it("treats automation edits as dirty, compares labels as a set and discards only that editor", () => {
  expect(sameWorkflowAutomation(undefined, { enabled: false, trigger: null })).toBe(true);
  const automation = { enabled: true, trigger: triggerRule };
  expect(
    sameWorkflowAutomation(automation, {
      ...automation,
      trigger: { ...triggerRule, labelIds: ["b", "a", "a"] },
    }),
  ).toBe(true);
  const baseline = {
    workflowId: "flow",
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    definition,
    automation,
    revision: 1,
    archived: false,
    createdAt: "2026",
    updatedAt: "2026",
  };
  const draft = {
    workflowId: "flow",
    definition,
    automation,
    baseline,
    selectedStepId: "",
    targetConfirmed: true,
    operation: null,
    error: null,
  };
  expect(workflowEditorDirty(draft)).toBe(false);
  expect(workflowEditorDirty({ ...draft, automation: { ...automation, enabled: false } })).toBe(
    true,
  );
  const registry = setup();
  startNewWorkflowDraft(registry, scope, () => ({ ...draft, baseline: null }));
  updateWorkflowDrafts(registry, scope.accountId, (state) => ({
    ...state,
    responses: { response: { input: "Keep this" } },
  }));
  discardWorkflowEditor(registry, scope, "flow");
  expect(registry.get(workflowDraftAtom).editors).toEqual({});
  expect(registry.get(workflowDraftAtom).newWorkflowIds).toEqual({});
  expect(registry.get(workflowDraftAtom).responses).toEqual({ response: { input: "Keep this" } });
});
