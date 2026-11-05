import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import { TurnId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | {
      kind: "turn";
      turnId: TurnId;
      filePath: string | null;
      revealRequestId: number;
      checkpointTurnCount?: number;
    };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "unstaged" };
type WorkflowReviewOrigin = Pick<WorkflowResultOrigin, "reviewCheckpoint" | "reviewVisitId">;

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (
    ref: ScopedThreadRef,
    turnId: TurnId,
    filePath?: string,
    checkpointTurnCount?: number,
  ) => void;
  reconcileTurnSelection: (
    ref: ScopedThreadRef,
    availableTurnIds: ReadonlyArray<TurnId>,
    origin?: WorkflowReviewOrigin | null,
    declaredReviewVisitId?: string,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath, checkpointTurnCount) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
                ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds, origin, declaredReviewVisitId) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          if (!previous) return state;
          const { selection } = resolveDiffPanelSelection(
            previous,
            availableTurnIds,
            origin,
            declaredReviewVisitId,
          );
          if (selection === previous) return state;
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: selection,
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

function resolveDiffPanelWorkflowReview(
  selection: DiffPanelSelection,
  origin: WorkflowReviewOrigin | null | undefined,
) {
  const checkpoint = origin?.reviewCheckpoint;
  if (
    selection.kind !== "turn" ||
    !origin?.reviewVisitId ||
    checkpoint?.turnId !== selection.turnId
  )
    return null;
  return {
    visitId: origin.reviewVisitId,
    expectedTurnId: selection.turnId,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
  };
}

export function resolveDiffPanelSelection(
  storedSelection: DiffPanelSelection,
  availableTurnIds: ReadonlyArray<TurnId>,
  origin: WorkflowReviewOrigin | null | undefined,
  declaredReviewVisitId?: string,
  checkpointOnly = false,
) {
  const reviewBlocked =
    declaredReviewVisitId !== undefined &&
    (!origin?.reviewVisitId ||
      origin.reviewVisitId !== declaredReviewVisitId ||
      !origin.reviewCheckpoint);
  const latestTurnId = availableTurnIds[0];
  const checkpoint = origin?.reviewCheckpoint;
  const fallbackTurnId = checkpoint ? TurnId.make(checkpoint.turnId) : latestTurnId;
  const selection: DiffPanelSelection =
    checkpointOnly && !reviewBlocked && storedSelection.kind !== "turn" && fallbackTurnId
      ? {
          kind: "turn",
          turnId: fallbackTurnId,
          filePath: null,
          revealRequestId: 0,
          ...(checkpoint ? { checkpointTurnCount: checkpoint.checkpointTurnCount } : {}),
        }
      : storedSelection;
  const workflowReview = reviewBlocked ? null : resolveDiffPanelWorkflowReview(selection, origin);
  if (
    reviewBlocked ||
    workflowReview ||
    selection.kind !== "turn" ||
    selection.checkpointTurnCount !== undefined ||
    latestTurnId === undefined ||
    availableTurnIds.includes(selection.turnId)
  )
    return { selection, workflowReview, reviewBlocked };

  const latest = { ...selection, turnId: latestTurnId };
  return {
    selection: latest,
    workflowReview: resolveDiffPanelWorkflowReview(latest, origin),
    reviewBlocked,
  };
}
