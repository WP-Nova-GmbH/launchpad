import { useCallback, useEffect, useMemo } from "react";
import * as DateTime from "effect/DateTime";

import {
  TurnId,
  type EnvironmentId,
  type OrchestrationCheckpointSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { isCompleteWorkflowReviewDiff } from "@t3tools/client-runtime/state/threads";
import type { WorkflowResultCheckpoint } from "@t3tools/client-runtime/relay/workflow-result";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  type ReviewSectionItem,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly workspaceEnabled: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
  readonly workflowCheckpoint?: WorkflowResultCheckpoint | undefined;
  readonly workflowReviewRequestKey?: string | undefined;
}) {
  const { environmentId, reviewCache, threadId, workspaceEnabled } = input;
  const workflowTurnCount = input.workflowCheckpoint?.checkpointTurnCount;
  const expectedTurnId = input.workflowCheckpoint
    ? TurnId.make(input.workflowCheckpoint.turnId)
    : undefined;
  const workflowSectionId = workflowTurnCount === undefined ? null : `turn:${workflowTurnCount}`;
  const enabled = input.enabled ?? true;
  const selectedThread = useSelectedThreadDetail();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const diffPreview = useEnvironmentQuery(
    enabled &&
      workspaceEnabled &&
      workflowSectionId === null &&
      environmentId !== undefined &&
      selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, OrchestrationCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: workspaceEnabled ? (diffPreview.data?.sources ?? reviewCache.gitSections) : [],
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: diffPreview.isPending,
      }),
    [
      diffPreview.isPending,
      diffPreview.data?.sources,
      loadingTurnIds,
      readyCheckpoints,
      reviewCache.gitSections,
      reviewCache.turnDiffById,
      workspaceEnabled,
    ],
  );
  const normalSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      workflowSectionId === null &&
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
    workflowSectionId,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (normalSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[normalSection.id] ?? activeCheckpoint;
  }
  const activeSectionId =
    workflowSectionId ??
    (activeCheckpoint ? getReviewSectionIdForCheckpoint(activeCheckpoint) : null);
  const activeTurnCount = workflowTurnCount ?? activeCheckpoint?.checkpointTurnCount;
  const strictWorkflowReview = workflowSectionId !== null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeTurnCount !== undefined ? Math.max(0, activeTurnCount - 1) : null,
    toTurnCount: enabled ? (activeTurnCount ?? null) : null,
    ignoreWhitespace: false,
    strictWorkflowReview,
    expectedTurnId,
    requestKey: input.workflowReviewRequestKey,
  });
  const workflowDiff =
    strictWorkflowReview &&
    enabled &&
    !activeTurnDiff.isPending &&
    !activeTurnDiff.error &&
    isCompleteWorkflowReviewDiff(activeTurnDiff.data, expectedTurnId)
      ? activeTurnDiff.data
      : null;
  const workflowDiffError =
    strictWorkflowReview && enabled && !activeTurnDiff.isPending && !workflowDiff
      ? (activeTurnDiff.error ?? "A complete checkpoint diff is unavailable.")
      : null;
  const workflowSections = useMemo<ReadonlyArray<ReviewSectionItem> | null>(
    () =>
      workflowSectionId
        ? [
            {
              id: workflowSectionId,
              kind: "turn",
              title: `Turn ${workflowTurnCount}`,
              subtitle: null,
              diff: workflowDiff?.diff ?? null,
              isLoading: activeTurnDiff.isPending,
            },
          ]
        : null,
    [workflowSectionId, workflowTurnCount, workflowDiff?.diff, activeTurnDiff.isPending],
  );
  const selectedSection = workflowSections?.[0] ?? normalSection;

  useEffect(() => {
    if (strictWorkflowReview || !reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey, strictWorkflowReview]);

  useEffect(() => {
    if (
      strictWorkflowReview ||
      !reviewCache.threadKey ||
      !activeSectionId ||
      !activeTurnDiff.data
    ) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey, strictWorkflowReview]);

  useEffect(() => {
    if (!strictWorkflowReview && reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey, strictWorkflowReview]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, selectedSection?.kind]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error: strictWorkflowReview
      ? workflowDiffError
      : (diffPreview.error ?? activeTurnDiff.error ?? reviewCache.asyncState.error),
    isSelectedSectionPending:
      selectedSection?.kind === "turn" ? activeTurnDiff.isPending : diffPreview.isPending,
    loadingGitDiffs: diffPreview.isPending,
    diffPreviewRevision: diffPreview.data
      ? DateTime.formatIso(diffPreview.data.generatedAt)
      : undefined,
    loadingTurnIds,
    reviewSections: workflowSections ?? reviewSections,
    selectedSection,
    workflowDiff,
    workflowDiffError,
    refreshSelectedSection,
    selectSection,
  };
}
