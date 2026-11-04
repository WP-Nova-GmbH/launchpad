import { type CheckpointDiffTarget } from "@t3tools/client-runtime/state/threads";

import type { resolveDiffPanelSelection } from "../diffPanelStore";
import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

export function buildDiffPanelCheckpointTarget(
  input: Pick<CheckpointDiffTarget, "environmentId" | "threadId" | "ignoreWhitespace"> & {
    readonly checkpointTurnCount: number | undefined;
  },
  scope: Pick<ReturnType<typeof resolveDiffPanelSelection>, "reviewBlocked" | "workflowReview">,
  viewId: string,
) {
  const { reviewBlocked, workflowReview } = scope;
  const turnCount = workflowReview?.checkpointTurnCount ?? input.checkpointTurnCount ?? null;
  return {
    environmentId: reviewBlocked ? null : input.environmentId,
    threadId: input.threadId,
    fromTurnCount: turnCount === null ? null : Math.max(0, turnCount - 1),
    toTurnCount: turnCount,
    ignoreWhitespace: input.ignoreWhitespace,
    strictWorkflowReview: workflowReview !== null,
    expectedTurnId: workflowReview?.expectedTurnId,
    requestKey: workflowReview ? `${workflowReview.visitId}:${viewId}` : undefined,
  };
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
) {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  };
}
