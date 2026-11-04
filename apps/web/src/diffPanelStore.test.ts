import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { workflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import { environmentRpcKey } from "@t3tools/client-runtime/state/runtime";
import { buildCheckpointDiffTargets } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveDiffPanelSelection,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";
import { buildDiffPanelCheckpointTarget } from "./lib/checkpointDiffState";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const reviewRoute = (turnId: TurnId, checkpointTurnCount: number, reviewVisitId = "visit-1") => ({
  workflowOrigin: {
    accountId: "account-1",
    organizationId: "organization-1",
    repositoryId: "repository-1",
    jobId: "workflow-job",
    threadId: THREAD_REF.threadId,
    reviewCheckpoint: { checkpointId: "reviewed", turnId, checkpointTurnCount },
    reviewVisitId,
  },
});

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    }),
  );

  it("defaults each thread to working tree changes without requiring git status", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
  });

  it("defaults to working tree changes before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "unstaged",
    });
  });

  it("preserves an explicit branch selection", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("clears a thread's turn and file when selecting working tree without changing another thread's branch base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"), "src/app.ts");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");

    store.selectGitScope(THREAD_REF, "unstaged");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({ kind: "unstaged" });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = TurnId.make("turn-missing");
    const latestTurnId = TurnId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });

  it("keeps a workflow checkpoint selection while only other turns are available", () => {
    const turnId = TurnId.make("workflow-turn");
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, turnId, undefined, 3);
    store.reconcileTurnSelection(THREAD_REF, [TurnId.make("latest-turn")]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ kind: "turn", turnId, checkpointTurnCount: 3 });
  });

  it("opens a read-only result on the latest checkpoint without changing the live checkout default", () => {
    const turnId = TurnId.make("latest-turn");
    const selection = { kind: "unstaged" } as const;
    const result = resolveDiffPanelSelection(selection, [turnId], null, undefined, true);
    expect(result.selection).toMatchObject({ kind: "turn", turnId });
    expect(result.workflowReview).toBeNull();
    expect(resolveDiffPanelSelection(selection, [turnId], null).selection).toBe(selection);
  });

  it("recovers the exact reviewed checkpoint if a read-only result opens from a saved Git scope", () => {
    const turnId = TurnId.make("workflow-turn");
    const latest = TurnId.make("latest-turn");
    const origin = workflowResultOrigin(reviewRoute(turnId, 3), "account-1", THREAD_REF.threadId);
    const result = resolveDiffPanelSelection(
      { kind: "branch", baseRef: "main" },
      [latest],
      origin,
      "visit-1",
      true,
    );
    expect(result.selection).toMatchObject({ kind: "turn", turnId, checkpointTurnCount: 3 });
    expect(result.workflowReview).toEqual({
      visitId: "visit-1",
      expectedTurnId: turnId,
      checkpointTurnCount: 3,
    });
  });

  it("restores strict workflow review when reselecting its turn without a stored count", () => {
    const turnId = TurnId.make("workflow-turn");
    const otherTurnId = TurnId.make("other-turn");
    const origin = workflowResultOrigin(reviewRoute(turnId, 3), "account-1", THREAD_REF.threadId);
    const store = useDiffPanelStore.getState();
    const selection = () =>
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF);
    const review = () => resolveDiffPanelSelection(selection(), [], origin).workflowReview;
    const expectedReview = { visitId: "visit-1", expectedTurnId: turnId, checkpointTurnCount: 3 };

    store.selectTurn(THREAD_REF, turnId, undefined, 3);
    expect(review()).toEqual(expectedReview);

    store.selectGitScope(THREAD_REF, "branch");
    expect(review()).toBeNull();
    store.selectTurn(THREAD_REF, otherTurnId);
    expect(review()).toBeNull();

    store.selectTurn(THREAD_REF, turnId);
    store.reconcileTurnSelection(THREAD_REF, [otherTurnId], origin, origin?.reviewVisitId);
    expect(review()).toEqual(expectedReview);

    store.selectTurn(THREAD_REF, turnId, "src/app.ts");
    expect(selection()).toMatchObject({ filePath: "src/app.ts" });
    expect(review()).toEqual(expectedReview);
  });

  it.each([1, 2])(
    "requests the strict fallback checkpoint before reconciliation at count %s",
    (count) => {
      const turnId = TurnId.make("review-turn");
      const staleTurnId = TurnId.make("stale-turn");
      const store = useDiffPanelStore.getState();
      store.selectTurn(THREAD_REF, staleTurnId);
      const selection = () =>
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF);
      const route = reviewRoute(turnId, count);
      const origin = workflowResultOrigin(route, "account-1", THREAD_REF.threadId);
      const declared = route.workflowOrigin.reviewVisitId;
      const scope = resolveDiffPanelSelection(selection(), [turnId], origin, declared);
      expect(scope.selection).toMatchObject({ kind: "turn", turnId });
      expect(selection()).toMatchObject({ kind: "turn", turnId: staleTurnId });

      const input = {
        ...THREAD_REF,
        checkpointTurnCount: count,
        ignoreWhitespace: count === 1,
      };
      const target = buildCheckpointDiffTargets(
        buildDiffPanelCheckpointTarget(input, scope, "panel"),
      );
      expect(target).toEqual({
        fullThread: null,
        turn: {
          environmentId: THREAD_REF.environmentId,
          cacheScope: "visit-1:panel",
          input: {
            threadId: THREAD_REF.threadId,
            fromTurnCount: count - 1,
            toTurnCount: count,
            ignoreWhitespace: false,
            strictWorkflowReview: true,
            expectedTurnId: turnId,
          },
        },
      });

      const ordinary = resolveDiffPanelSelection(selection(), [turnId], null);
      expect(ordinary.selection).toEqual(scope.selection);
      const ordinaryTarget = buildCheckpointDiffTargets(
        buildDiffPanelCheckpointTarget(input, ordinary, "panel"),
      );
      if (count === 2) {
        const earlierRoute = reviewRoute(turnId, count, "prior-visit");
        const earlierOrigin = workflowResultOrigin(earlierRoute, "account-1", THREAD_REF.threadId);
        const earlierScope = resolveDiffPanelSelection(
          selection(),
          [turnId],
          earlierOrigin,
          "prior-visit",
        );
        const earlierTarget = buildCheckpointDiffTargets(
          buildDiffPanelCheckpointTarget(input, earlierScope, "panel"),
        );
        expect(target.turn).not.toBeNull();
        expect(ordinaryTarget.turn).not.toBeNull();
        expect(earlierTarget.turn).not.toBeNull();
        expect(environmentRpcKey(target.turn!)).not.toBe(environmentRpcKey(ordinaryTarget.turn!));
        expect(environmentRpcKey(target.turn!)).not.toBe(environmentRpcKey(earlierTarget.turn!));
      } else {
        expect(ordinaryTarget.fullThread?.input.toTurnCount).toBe(count);
      }
    },
  );

  it("waits for a declared review visit to validate before selecting or requesting a checkpoint", () => {
    const turnId = TurnId.make("review-turn");
    const staleTurnId = TurnId.make("stale-turn");
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, staleTurnId);
    const selection = () =>
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF);
    const route = reviewRoute(turnId, 2);
    const declared = route.workflowOrigin.reviewVisitId;
    const unvalidated = workflowResultOrigin(route, undefined, THREAD_REF.threadId);
    const blocked = resolveDiffPanelSelection(selection(), [turnId], unvalidated, declared);
    expect(blocked).toMatchObject({ reviewBlocked: true, workflowReview: null });
    store.reconcileTurnSelection(THREAD_REF, [turnId], unvalidated, declared);
    expect(selection()).toMatchObject({ kind: "turn", turnId: staleTurnId });

    const input = { ...THREAD_REF, checkpointTurnCount: 2, ignoreWhitespace: false };
    expect(
      buildCheckpointDiffTargets(buildDiffPanelCheckpointTarget(input, blocked, "panel")),
    ).toEqual({ fullThread: null, turn: null });

    const origin = workflowResultOrigin(route, "account-1", THREAD_REF.threadId);
    const validated = resolveDiffPanelSelection(selection(), [turnId], origin, declared);
    expect(
      buildCheckpointDiffTargets(buildDiffPanelCheckpointTarget(input, validated, "panel")).turn,
    ).toMatchObject({
      input: { strictWorkflowReview: true, expectedTurnId: turnId },
    });
  });
});
