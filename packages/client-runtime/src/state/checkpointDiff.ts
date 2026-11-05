import type {
  EnvironmentId,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

export type CheckpointDiffResult =
  | OrchestrationGetTurnDiffResult
  | OrchestrationGetFullThreadDiffResult;

export interface CheckpointDiffState {
  readonly data: CheckpointDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly strictWorkflowReview?: boolean;
  readonly expectedTurnId?: TurnId | undefined;
  /** Isolates a live workflow inspection from ordinary cached reads of the same range. */
  readonly requestKey?: string | undefined;
}

export function buildCheckpointDiffTargets(target: CheckpointDiffTarget) {
  const {
    environmentId,
    threadId,
    fromTurnCount,
    toTurnCount,
    requestKey,
    strictWorkflowReview,
    expectedTurnId,
  } = target;
  if (environmentId === null || threadId === null || fromTurnCount === null || toTurnCount === null)
    return { fullThread: null, turn: null } as const;
  if (strictWorkflowReview && !expectedTurnId) return { fullThread: null, turn: null } as const;

  const query = { environmentId, ...(requestKey ? { cacheScope: requestKey } : {}) };
  if (fromTurnCount === 0 && !strictWorkflowReview)
    return {
      fullThread: {
        ...query,
        input: { threadId, toTurnCount, ignoreWhitespace: target.ignoreWhitespace },
      },
      turn: null,
    } as const;

  return {
    fullThread: null,
    turn: {
      ...query,
      input: {
        threadId,
        fromTurnCount,
        toTurnCount,
        ignoreWhitespace: strictWorkflowReview ? false : target.ignoreWhitespace,
        ...(strictWorkflowReview && expectedTurnId
          ? { strictWorkflowReview: true, expectedTurnId }
          : {}),
      },
    },
  } as const;
}

export function isCompleteWorkflowReviewDiff(
  diff: CheckpointDiffResult | null | undefined,
  expectedTurnId: string | null | undefined,
): diff is OrchestrationGetTurnDiffResult & {
  readonly completeWorkflowReview: true;
  readonly targetTurnId: TurnId;
} {
  return (
    !!diff &&
    !!expectedTurnId &&
    "completeWorkflowReview" in diff &&
    diff.completeWorkflowReview === true &&
    diff.targetTurnId === expectedTurnId
  );
}
