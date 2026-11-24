import { afterEach, describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { RelayTenancyForbiddenError, RelayRepositoryId } from "@t3tools/contracts/relay";
import {
  WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT,
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  type RepositoryWorkflowJob,
  type WorkflowDefinition,
} from "@t3tools/contracts/workflows";
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
  hasUnsavedWorkflowWork,
  discardWorkflowEditor,
  workflowSessionKey,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  clearWorkflowScope,
  workflowDraftIssue,
  workflowStepState,
  startNewWorkflowDraft,
  workflowJobAccessLost,
  emptyWorkflowJobPageRead,
  beginWorkflowJobPage,
  settleWorkflowJobPage,
  beginWorkflowReview,
  bindWorkflowReviewPlacement,
  recordWorkflowReviewDiff,
  recordSavedWorkflowReviewDiff,
  requireFreshWorkflowReviewRead,
  setWorkflowResponseDraft,
  summarizeWorkflowClose,
  workflowReviewApprovalState,
} from "./workflowSession.ts";

const scope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const definition: WorkflowDefinition = {
  name: "Implementation",
  target: {
    kind: "machine" as const,
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
  },
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
  runtime: definition.target.kind === "machine" ? definition.target : null,
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

describe("workflow window close details", () => {
  it("keeps unsaved work separate from the contents of pending or unconfirmed requests", () => {
    const registry = setup();
    const baseline = {
      workflowId: "workflow",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      archived: false,
      revision: 1,
      definition,
      createdAt: "2026-10-13T00:00:00Z",
      updatedAt: "2026-10-13T00:00:00Z",
    };
    const editor = {
      workflowId: baseline.workflowId,
      definition,
      baseline,
      selectedStepId: "",
      targetConfirmed: true,
      operation: null,
      error: null,
    };
    const captured = { ...definition, name: "Captured Save" };
    const save = {
      requestId: "save",
      definition: captured,
      archived: false,
      expectedRevision: baseline.revision,
    };
    const pendingSave = workflowSessionKey(scope, "pending-save");
    const uncertainSave = workflowSessionKey(scope, "uncertain-save");
    const failedSave = workflowSessionKey(scope, "failed-save");
    const archive = workflowSessionKey(scope, "archive");
    const restore = workflowSessionKey(scope, "restore");
    const pendingRun = workflowSessionKey(scope, "pending-run");
    const uncertainRun = workflowSessionKey(scope, "uncertain-run");
    const retryRun = workflowSessionKey(scope, "retry-run");
    const repeatedRun = workflowSessionKey(scope, "repeated-run");
    const localRun = workflowSessionKey(scope, "local-run");
    const run = { startedJobId: null, error: null };
    const originalRun = {
      requestId: "original-run",
      state: "uncertain" as const,
      instruction: "previous captured instruction",
      targetKind: "vm" as const,
    };
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      editors: {
        [workflowSessionKey(scope, "clean")]: editor,
        [pendingSave]: {
          ...editor,
          definition: captured,
          operation: { ...save, state: "pending" },
        },
        [uncertainSave]: {
          ...editor,
          definition: { ...definition, name: "Later edit" },
          operation: { ...save, state: "uncertain" },
        },
        [failedSave]: {
          ...editor,
          definition: captured,
          operation: { ...save, state: "uncertain" },
          saveRecovery: "retryable",
        },
        [archive]: {
          ...editor,
          operation: {
            ...save,
            requestId: "archive",
            definition,
            state: "pending",
            archived: true,
          },
        },
        [restore]: {
          ...editor,
          baseline: { ...baseline, archived: true },
          operation: { ...save, requestId: "restore", definition, state: "uncertain" },
        },
      },
      runs: {
        [pendingRun]: {
          ...run,
          workflowName: "Weekly publish",
          instruction: "same captured instruction",
          recovery: { kind: "additional", previous: originalRun },
          operation: {
            requestId: "pending-run",
            state: "pending",
            instruction: "same captured instruction",
          },
        },
        [uncertainRun]: {
          ...run,
          instruction: "private unsent edit",
          operation: {
            requestId: "uncertain-run",
            state: "uncertain",
            instruction: "private submitted instruction",
          },
        },
        [retryRun]: {
          ...run,
          instruction: originalRun.instruction,
          operation: { ...originalRun, state: "pending" },
          recovery: { kind: "retry", previous: originalRun, replayOnly: true },
        },
        [repeatedRun]: {
          ...run,
          instruction: "current instructions",
          operation: {
            ...originalRun,
            requestId: "latest",
            instruction: "current instructions",
          },
          earlierUnconfirmedRuns: [
            originalRun,
            originalRun,
            { ...originalRun, requestId: "second" },
            { ...originalRun, requestId: "latest" },
          ],
        },
        [localRun]: { ...run, instruction: "private local instruction", operation: null },
      },
    }));

    expect(
      summarizeWorkflowClose(registry.get(workflowDraftAtom), registry.get(workflowJobReadAtom)),
    ).toEqual({
      edits: [
        { key: uncertainSave, name: "Later edit" },
        { key: failedSave, name: "Captured Save" },
      ],
      runDrafts: [
        { key: uncertainRun, workflowName: null },
        { key: localRun, workflowName: null },
      ],
      requests: [
        {
          key: pendingSave,
          requestId: "save",
          workflowName: "Captured Save",
          kind: "save",
          state: "pending",
        },
        {
          key: uncertainSave,
          requestId: "save",
          workflowName: "Captured Save",
          kind: "save",
          state: "uncertain",
        },
        {
          key: archive,
          requestId: "archive",
          workflowName: "Implementation",
          kind: "archive",
          state: "pending",
        },
        {
          key: restore,
          requestId: "restore",
          workflowName: "Implementation",
          kind: "restore",
          state: "uncertain",
        },
        {
          key: pendingRun,
          requestId: "original-run",
          workflowName: "Weekly publish",
          kind: "run",
          state: "uncertain",
          runPosition: { number: 1, total: 2 },
        },
        {
          key: pendingRun,
          requestId: "pending-run",
          workflowName: "Weekly publish",
          kind: "run",
          state: "pending",
          runPosition: { number: 2, total: 2 },
        },
        {
          key: uncertainRun,
          requestId: "uncertain-run",
          workflowName: null,
          kind: "run",
          state: "uncertain",
        },
        {
          key: retryRun,
          requestId: "original-run",
          workflowName: null,
          kind: "run",
          state: "pending",
        },
        {
          key: repeatedRun,
          requestId: "original-run",
          workflowName: null,
          kind: "run",
          state: "uncertain",
          runPosition: { number: 1, total: 3 },
        },
        {
          key: repeatedRun,
          requestId: "second",
          workflowName: null,
          kind: "run",
          state: "uncertain",
          runPosition: { number: 2, total: 3 },
        },
        {
          key: repeatedRun,
          requestId: "latest",
          workflowName: null,
          kind: "run",
          state: "uncertain",
          runPosition: { number: 3, total: 3 },
        },
      ],
      responses: [],
    });
  });

  it.each([false, true])(
    "does not guard a known failed archive or restore with no local edits (was archived: %s)",
    (archived) => {
      const registry = setup();
      const workflowId = "workflow";
      const key = workflowSessionKey(scope, workflowId);
      const baseline = {
        workflowId,
        repositoryId: scope.repositoryId,
        organizationId: scope.organizationId,
        definition,
        archived,
        revision: 1,
        createdAt: "2026-10-13T00:00:00Z",
        updatedAt: "2026-10-13T00:00:00Z",
      };
      const editor = {
        workflowId,
        definition,
        baseline,
        selectedStepId: "",
        targetConfirmed: true,
        operation: {
          requestId: "change",
          state: "uncertain" as const,
          definition,
          archived: !archived,
          expectedRevision: baseline.revision,
        },
        saveRecovery: "conflict" as const,
        error: null,
      };
      const update = (nextDefinition: WorkflowDefinition) =>
        updateWorkflowDrafts(registry, scope.accountId, (drafts) => ({
          ...drafts,
          editors: { [key]: { ...editor, definition: nextDefinition } },
        }));
      const state = () => registry.get(workflowDraftAtom);
      const reads = () => registry.get(workflowJobReadAtom);
      update(definition);
      expect(hasUnsavedWorkflowWork(state(), reads())).toBe(false);
      expect(summarizeWorkflowClose(state(), reads())).toEqual({
        edits: [],
        runDrafts: [],
        responses: [],
        requests: [],
      });

      update({ ...definition, name: "Retained edit" });
      expect(hasUnsavedWorkflowWork(state(), reads())).toBe(true);
      expect(summarizeWorkflowClose(state(), reads()).edits).toEqual([
        { key, name: "Retained edit" },
      ]);
    },
  );

  it("identifies retained checkpoint drafts without revealing their text or using another account's context", () => {
    const registry = setup();
    const jobKey = workflowSessionKey(scope, "job");
    const current = job();
    const workflow = {
      workflowId: current.workflowId,
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      archived: false,
      revision: 1,
      definition,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, current.jobId)!, {
      ...current,
      workflow,
      progress: {
        ...current.progress!,
        checkpoint: {
          checkpointId: "review",
          stepId: "review",
          turnId: "turn",
          checkpointRef: "ref",
          checkpointTurnCount: 1,
        },
      },
    });
    const draftText = "Private response";
    updateWorkflowDrafts(registry, scope.accountId, (state) => ({
      ...state,
      responses: { [jobKey]: { review: draftText, blank: " ", previous: "Edited input" } },
    }));
    recordWorkflowResponse(registry, scope, current.jobId, {
      checkpointId: "review",
      operation: "request_changes",
      userId: scope.accountId,
      text: draftText,
    });
    recordWorkflowResponse(registry, scope, current.jobId, {
      checkpointId: "previous",
      operation: "input",
      userId: scope.accountId,
      text: "Earlier input",
    });
    const state = registry.get(workflowDraftAtom);
    const reads = registry.get(workflowJobReadAtom);
    expect(summarizeWorkflowClose(state, reads).responses).toEqual([
      {
        jobKey,
        checkpointId: "review",
        workflowName: "Implementation",
        stepTitle: "Review",
        kind: "review",
        deliveryUnconfirmed: true,
      },
      {
        jobKey,
        checkpointId: "previous",
        workflowName: "Implementation",
        stepTitle: null,
        kind: "input",
        deliveryUnconfirmed: false,
      },
    ]);
    expect(
      summarizeWorkflowClose(state, { ...reads, accountId: "different" }).responses[0],
    ).toEqual({
      jobKey,
      checkpointId: "review",
      workflowName: null,
      stepTitle: null,
      kind: "review",
      deliveryUnconfirmed: true,
    });

    const context = {
      workflowName: "Implementation",
      stepTitle: "Review",
      kind: "review",
    } as const;
    setWorkflowResponseDraft(registry, scope, current.jobId, "review", draftText, context);
    activateWorkflowJobView(registry, scope, "another-job");
    expect(registry.get(workflowJobReadAtom).jobs[jobKey]?.job).toBeNull();
    expect(
      summarizeWorkflowClose(registry.get(workflowDraftAtom), registry.get(workflowJobReadAtom))
        .responses[0],
    ).toMatchObject(context);

    setWorkflowResponseDraft(registry, scope, current.jobId, "review", " ", context);
    expect(registry.get(workflowDraftAtom).responses[jobKey]?.review).toBe(" ");
    expect(registry.get(workflowDraftAtom).responseContexts?.[jobKey]?.review).toBeUndefined();
    setWorkflowResponseDraft(registry, scope, current.jobId, "review", "", context);
    expect(registry.get(workflowDraftAtom).responses[jobKey]?.review).toBe("");
    setWorkflowResponseDraft(registry, scope, current.jobId, "review", draftText, context);
    clearWorkflowScope(registry, scope);
    expect(registry.get(workflowDraftAtom).responseContexts?.[jobKey]).toBeUndefined();
  });

  it.each([
    ["machine", "same operation"],
    ["machine", "cancelling"],
    ["machine", "cancelled"],
    ["vm", "cancelling"],
    ["vm", "restored after cancellation"],
    ["vm", "cancelled"],
    ["vm", "access lost"],
    ["vm", "queue withdrawn"],
    ["vm", "replacement"],
    ["vm", "hidden replacement"],
    ["vm", "advanced to another author's response"],
    ["vm", "advanced to changed response"],
    ["vm", "truncated history"],
    ["vm", "evicted history"],
    ["vm", "applied"],
  ] as const)("protects exact response content when a %s receipt is %s", (kind, event) => {
    const registry = setup();
    const current = job();
    const draftText =
      event === "truncated history"
        ? "x".repeat(WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT + 1)
        : "Private response";
    const checkpointId = "review";
    const context = {
      workflowName: "Implementation",
      stepTitle: "Review",
      kind: "review",
    } as const;
    const state = () => registry.get(workflowDraftAtom);
    const reads = () => registry.get(workflowJobReadAtom);
    setWorkflowResponseDraft(registry, scope, current.jobId, checkpointId, draftText, context);
    const request = beginWorkflowJobRequest(registry, scope, current.jobId, "request_changes")!;
    recordWorkflowResponse(registry, scope, current.jobId, {
      checkpointId,
      operation: "request_changes",
      userId: scope.accountId,
      text: draftText,
      requestEpoch: request.epoch,
    });
    expect(hasUnsavedWorkflowWork(state(), reads())).toBe(true);
    expect(summarizeWorkflowClose(state(), reads()).responses[0]?.deliveryUnconfirmed).toBe(true);

    const accepted = {
      ...current,
      status: "awaiting_review",
      runtime: kind === "vm" ? { kind, threadId: ThreadId.make("thread") } : current.runtime,
      responsePending: true,
      pendingResponseOperation: "request_changes",
      ...(kind === "vm" ? { pendingResponseId: "queued" } : {}),
      progress: {
        ...current.progress!,
        status: "awaiting_review",
        checkpoint: {
          checkpointId,
          turnId: "turn",
          checkpointRef: "ref",
          checkpointTurnCount: 1,
        },
      },
    } satisfies RepositoryWorkflowJob;
    expect(settleWorkflowJobRequest(registry, request, accepted)).toBe(true);
    if (kind === "machine")
      expect(
        state().submitted[workflowSessionKey(scope, current.jobId)]?.[checkpointId]
          ?.acceptedPending,
      ).toBe(true);
    expect(hasUnsavedWorkflowWork(state(), reads())).toBe(kind === "machine");
    expect(summarizeWorkflowClose(state(), reads()).responses).toHaveLength(
      kind === "machine" ? 1 : 0,
    );

    activateWorkflowJobView(registry, scope, "another-job");
    expect(hasUnsavedWorkflowWork(state(), reads())).toBe(kind === "machine");
    activateWorkflowJobView(registry, scope, current.jobId);
    const {
      pendingResponseId: _identity,
      pendingResponseOperation: _operation,
      ...withoutReceipt
    } = accepted;
    const applied = {
      checkpointId,
      stepId: "review",
      generation: 1,
      operation: "request_changes" as const,
      userId: scope.accountId,
      text: draftText,
      createdAt: current.updatedAt,
    };
    const next = beginWorkflowJobRequest(registry, scope, current.jobId)!;
    if (event === "access lost") {
      expect(settleWorkflowJobRequest(registry, next, "Access lost", true)).toBe(false);
    } else if (event === "applied") {
      expect(
        settleWorkflowJobRequest(registry, next, {
          ...withoutReceipt,
          status: "done",
          responsePending: false,
          progress: {
            ...accepted.progress,
            status: "done",
            checkpoint: null,
            responses: [applied],
          },
        }),
      ).toBe(true);
      expect(hasUnsavedWorkflowWork(state(), reads())).toBe(false);
      expect(
        state().responses[workflowSessionKey(scope, current.jobId)]?.[checkpointId],
      ).toBeUndefined();
      return;
    } else if (
      event === "advanced to another author's response" ||
      event === "advanced to changed response" ||
      event === "truncated history" ||
      event === "evicted history"
    ) {
      const otherResponse =
        event === "advanced to another author's response"
          ? { ...applied, userId: "another-member" }
          : {
              ...applied,
              text:
                event === "truncated history"
                  ? draftText.slice(0, WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT)
                  : "Changed by this account",
            };
      expect(
        settleWorkflowJobRequest(registry, next, {
          ...withoutReceipt,
          responsePending: false,
          progress: {
            ...accepted.progress,
            revision: accepted.progress.revision + 1,
            checkpoint: { ...accepted.progress.checkpoint, checkpointId: "next-checkpoint" },
            responses:
              event === "evicted history"
                ? Array.from({ length: WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT }, (_, index) => ({
                    ...otherResponse,
                    checkpointId: `later-checkpoint-${index}`,
                  }))
                : [otherResponse],
          },
        }),
      ).toBe(true);
    } else {
      const result =
        event === "same operation"
          ? accepted
          : event === "cancelling" || event === "restored after cancellation"
            ? { ...withoutReceipt, status: "cancelling" as const }
            : event === "cancelled"
              ? {
                  ...withoutReceipt,
                  status: "cancelled" as const,
                  progress: null,
                  responsePending: false,
                }
              : event === "replacement"
                ? { ...accepted, pendingResponseId: "different-response" }
                : event === "hidden replacement"
                  ? { ...withoutReceipt, pendingResponseOperation: "request_changes" as const }
                  : { ...withoutReceipt, responsePending: false };
      expect(settleWorkflowJobRequest(registry, next, result)).toBe(true);
    }

    expect(hasUnsavedWorkflowWork(state(), reads())).toBe(true);
    activateWorkflowJobView(registry, scope, "another-job");
    expect(summarizeWorkflowClose(state(), reads()).responses[0]?.deliveryUnconfirmed).toBe(true);
    expect(state().responses[workflowSessionKey(scope, current.jobId)]?.[checkpointId]).toBe(
      draftText,
    );

    if (event === "restored after cancellation") {
      activateWorkflowJobView(registry, scope, current.jobId);
      const read = beginWorkflowJobRequest(registry, scope, current.jobId)!;
      expect(settleWorkflowJobRequest(registry, read, accepted)).toBe(true);
      expect(hasUnsavedWorkflowWork(state(), reads())).toBe(false);
      activateWorkflowJobView(registry, scope, "another-job");
      expect(hasUnsavedWorkflowWork(state(), reads())).toBe(false);
      expect(summarizeWorkflowClose(state(), reads()).responses).toEqual([]);
    }

    setWorkflowResponseDraft(
      registry,
      scope,
      current.jobId,
      checkpointId,
      "Edited response",
      context,
    );
    expect(hasUnsavedWorkflowWork(state(), reads())).toBe(true);
    expect(summarizeWorkflowClose(state(), reads()).responses).toEqual([
      {
        ...context,
        jobKey: workflowSessionKey(scope, current.jobId),
        checkpointId,
        deliveryUnconfirmed: false,
      },
    ]);
  });
});

describe("workflow session and request ownership", () => {
  it("requires a current exact VM diff and a job read started after returning", () => {
    const registry = setup();
    const key = workflowSessionKey(scope, "job");
    const state = () =>
      workflowReviewApprovalState(
        registry.get(workflowDraftAtom).reviews[key],
        registry.get(workflowJobReadAtom).jobs[key]!,
      );
    const threadId = ThreadId.make("thread");
    const placement = { environmentId: EnvironmentId.make("vm"), threadId, generation: 2 };
    const checkpoint = { checkpointId: "current", turnId: "turn-2", checkpointTurnCount: 2 };
    const current = {
      ...job(2),
      runtime: { kind: "vm", threadId },
      progress: { ...job(2).progress!, checkpoint: { ...checkpoint, checkpointRef: "ref" } },
    } satisfies RepositoryWorkflowJob;
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, current);
    expect(state()).toBe("inspect");

    beginWorkflowReview(registry, scope, "job", "old", checkpoint);
    bindWorkflowReviewPlacement(registry, scope, "job", "old", placement);
    beginWorkflowReview(registry, scope, "job", "new", checkpoint);
    bindWorkflowReviewPlacement(registry, scope, "job", "new", placement);
    const origin = {
      ...scope,
      jobId: "job",
      threadId,
      reviewVisitId: "new",
      reviewCheckpoint: checkpoint,
    };
    const diff = { threadId, fromTurnCount: 1, toTurnCount: 2, diff: "" };
    const oldDiff = { ...diff, completeWorkflowReview: true } as const;
    const completeDiff = { ...oldDiff, targetTurnId: TurnId.make(checkpoint.turnId) };
    expect(recordWorkflowReviewDiff(registry, origin, placement, diff)).toBe(false);
    expect(recordWorkflowReviewDiff(registry, origin, placement, oldDiff)).toBe(false);
    expect(
      recordWorkflowReviewDiff(registry, origin, placement, {
        ...completeDiff,
        targetTurnId: TurnId.make("reused-count"),
      }),
    ).toBe(false);
    expect(
      recordWorkflowReviewDiff(
        registry,
        { ...origin, reviewVisitId: "old" },
        placement,
        completeDiff,
      ),
    ).toBe(false);
    expect(
      recordWorkflowReviewDiff(registry, origin, { ...placement, generation: 1 }, completeDiff),
    ).toBe(false);
    expect(
      recordWorkflowReviewDiff(registry, origin, placement, { ...completeDiff, fromTurnCount: 0 }),
    ).toBe(false);
    expect(recordWorkflowReviewDiff(registry, origin, placement, completeDiff)).toBe(true);

    const previousRead = beginWorkflowJobRequest(registry, scope, "job")!;
    requireFreshWorkflowReviewRead(registry, scope, "job");
    expect(settleWorkflowJobRequest(registry, previousRead, current)).toBe(false);
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, "offline");
    expect(state()).toBe("checking");
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, current);
    expect(state()).toBe("allowed");
    clearWorkflowScope(registry, scope);
    expect(registry.get(workflowDraftAtom).reviews[key]).toBeUndefined();
  });

  it("accepts only the current complete saved Agent result and requires a fresh job read", () => {
    const registry = setup();
    const checkpoint = {
      kind: "review" as const,
      checkpointId: "current",
      turnId: "turn-2",
      checkpointTurnCount: 2,
      checkpointRef: "ref-2",
    };
    const current: RepositoryWorkflowJob = {
      ...job(2),
      status: "awaiting_review",
      runtime: { kind: "vm", threadId: ThreadId.make("thread") },
      progress: { ...job(2).progress!, status: "awaiting_review", checkpoint },
    };
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, current);
    const key = workflowSessionKey(scope, "job");
    const state = () =>
      workflowReviewApprovalState(
        registry.get(workflowDraftAtom).reviews[key],
        registry.get(workflowJobReadAtom).jobs[key]!,
      );
    expect(state()).toBe("inspect");
    beginWorkflowReview(registry, scope, "job", "visit", checkpoint);
    const result = {
      resultId: "11111111-1111-4111-8111-111111111111",
      stepId: "agent",
      turnId: "turn-2",
      turnCount: 2,
      outcome: "completed" as const,
      createdAt: "now",
      checkpointRef: "ref-2",
      baselineCommitId: "base",
      commitId: "commit",
      treeId: "tree",
      patch: {
        artifactId: "22222222-2222-4222-8222-222222222222",
        sha256: "a".repeat(64),
        sizeBytes: 0,
      },
    };
    for (const other of [
      { ...result, turnId: "turn-1" },
      { ...result, checkpointRef: "old-ref" },
      { ...result, outcome: "cancelled" as const },
    ])
      expect(recordSavedWorkflowReviewDiff(registry, scope, "job", "visit", other)).toBe(false);
    expect(recordSavedWorkflowReviewDiff(registry, scope, "job", "visit", result)).toBe(true);
    expect(state()).toBe("checking");
    requireFreshWorkflowReviewRead(registry, scope, "job");
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, current);
    expect(state()).toBe("allowed");
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, {
      ...current,
      progress: {
        ...current.progress!,
        revision: 3,
        checkpoint: {
          ...checkpoint,
          checkpointId: "new",
          turnId: "turn-3",
          checkpointTurnCount: 3,
        },
      },
    });
    expect(state()).toBe("inspect");
  });

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
  it("drops a cached run on an authoritative access loss", () => {
    const registry = setup();
    const key = workflowSessionKey(scope, "job");
    settleWorkflowJobRequest(registry, beginWorkflowJobRequest(registry, scope, "job")!, job(4));
    settleWorkflowJobRequest(
      registry,
      beginWorkflowJobRequest(registry, scope, "job")!,
      "Repository access revoked",
      true,
    );
    expect(registry.get(workflowJobReadAtom).jobs[key]).toMatchObject({
      job: null,
      error: "Repository access revoked",
    });
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
  it("points Save validation to Open PR when the latest Agent has no Push branch", () => {
    const agent = definition.steps[0]!;
    const push = { id: "push", kind: "action", title: "Push branch", action: "push" } as const;
    const laterAgent = { ...agent, id: "later-agent" };
    const openPr = {
      id: "open-pr",
      kind: "action",
      title: "Open PR",
      action: "open_pull_request",
    } as const;
    expect(workflowDraftIssue({ ...definition, steps: [agent, push, laterAgent, openPr] })).toEqual(
      {
        message: "Open PR needs a Push branch step after the latest Agent.",
        stepId: openPr.id,
        field: "title",
        publishing: true,
      },
    );
    expect(
      workflowDraftIssue({ ...definition, steps: [agent, laterAgent, push, openPr] }),
    ).toBeNull();
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
  expect(workflowJobAccessLost(cause)).toBe(true);
  expect(workflowJobAccessLost(new Error("Offline"))).toBe(false);
  read = settleWorkflowJobPage(
    beginWorkflowJobPage(read, refresh),
    refresh,
    "Access removed",
    workflowJobAccessLost(cause),
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
