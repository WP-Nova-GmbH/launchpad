import { type CheckpointDiffTarget } from "@t3tools/client-runtime/state/threads";
import { TurnId } from "@t3tools/contracts";

import type { resolveDiffPanelSelection } from "../diffPanelStore";
import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

export function buildDiffPanelCheckpointTarget(
  input: Pick<CheckpointDiffTarget, "environmentId" | "threadId" | "ignoreWhitespace"> & {
    readonly checkpointTurnCount: number | undefined;
  },
  scope: Pick<
    ReturnType<typeof resolveDiffPanelSelection>,
    "reviewBlocked" | "reviewCheckpoint" | "savedDiffCheckpoint" | "workflowReview"
  >,
  viewId: string,
) {
  const { reviewBlocked, reviewCheckpoint, savedDiffCheckpoint, workflowReview } = scope;
  const checkpoint = reviewCheckpoint ?? savedDiffCheckpoint;
  const turnCount = checkpoint?.checkpointTurnCount ?? input.checkpointTurnCount ?? null;
  return {
    environmentId: reviewBlocked ? null : input.environmentId,
    threadId: input.threadId,
    fromTurnCount: turnCount === null ? null : Math.max(0, turnCount - 1),
    toTurnCount: turnCount,
    ignoreWhitespace: input.ignoreWhitespace,
    strictWorkflowReview: workflowReview !== null,
    expectedTurnId: checkpoint ? TurnId.make(checkpoint.turnId) : undefined,
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
