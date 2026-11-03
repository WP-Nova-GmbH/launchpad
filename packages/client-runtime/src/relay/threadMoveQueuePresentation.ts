import type { ThreadMoveQueueEntry, ThreadQueueEntry } from "@t3tools/contracts";
import type {
  RelayPortableThreadPlacement,
  RelayThreadVmProviderAuth,
  RelayThreadVmStatus,
  ThreadMoveWaitingForAuth,
} from "@t3tools/contracts/relay";
import {
  threadMoveProgressPresentation,
  threadVmPresentation,
  threadVmWorkerAuthState,
} from "./threadVmControls.ts";

export function activeThreadMove(placement: RelayPortableThreadPlacement | null | undefined) {
  const move = placement?.activeMove;
  if (!move || !placement || move.phase === "aborted") return null;
  const destinationOwns = move.phase === "committed" || move.phase === "completed";
  if (
    (placement.operationId !== move.operationId &&
      !(placement.operationId === null && move.phase === "reopening")) ||
    placement.generation !== move.sourceGeneration + (destinationOwns ? 1 : 0) ||
    placement.environmentId !==
      (destinationOwns ? move.destinationEnvironmentId : move.sourceEnvironmentId)
  )
    return null;
  return move;
}

/** A retired environment may still project a queue that predates the current move. */
export function threadMoveQueueRows(input: {
  entries?: ReadonlyArray<ThreadQueueEntry> | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  queueEnvironmentId?: string | undefined;
  queueGeneration?: number | undefined;
}) {
  const { placement, queueEnvironmentId, queueGeneration } = input;
  const activeMove = activeThreadMove(placement);
  const cancelledMove =
    placement?.activeMove?.phase === "aborted" &&
    placement.activeMove.sourceGeneration === placement.generation &&
    placement.activeMove.sourceEnvironmentId === placement.environmentId
      ? placement.activeMove
      : null;
  const staleQueue =
    placement &&
    ((queueEnvironmentId !== undefined && placement.environmentId !== queueEnvironmentId) ||
      (queueGeneration !== undefined && placement.generation !== queueGeneration));
  const entries = (input.entries ?? []).filter((entry, index) => {
    if (entry.kind !== "move") return true;
    if (staleQueue) return false;
    if (
      cancelledMove &&
      (entry.operationId === cancelledMove.operationId ||
        entry.messageId === cancelledMove.sourceMessageId)
    )
      return false;
    if (!activeMove || entry.operationId === activeMove.operationId) return true;
    if (entry.state !== "pending") return false;
    if (activeMove.sourceMessageId !== undefined)
      return entry.messageId !== activeMove.sourceMessageId;
    // Older sources can publish admission before the claim is mirrored. Hide
    // the ambiguous head while the exact active move has its own Cancel action.
    return !(
      index === 0 &&
      (entry.destination.kind === "vm"
        ? activeMove.destinationKind === "vm"
        : activeMove.destinationKind === "environment" &&
          entry.destination.environmentId === activeMove.destinationEnvironmentId &&
          entry.destination.projectId === activeMove.destinationProjectId)
    );
  });
  return { entries, fallback: threadMoveQueueOwnership({ entries, placement }).fallback };
}

function currentMoveSnapshots(placement: RelayPortableThreadPlacement | null | undefined) {
  return placement?.operationId
    ? (placement.moveProgress?.filter(
        (snapshot) =>
          snapshot.operationId === placement.operationId &&
          snapshot.threadId === placement.threadId &&
          snapshot.generation ===
            placement.generation +
              (snapshot.environmentId === placement.environmentId
                ? 0
                : snapshot.participant === "destination"
                  ? 1
                  : -1),
      ) ?? [])
    : [];
}

/** An operation ID is also used by restore/reset/save; it alone never proves a move. */
export function threadMoveQueueOwnership(input: {
  entries?: ReadonlyArray<ThreadQueueEntry> | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  status?: RelayThreadVmStatus | null | undefined;
}) {
  const { placement, status } = input;
  const activeMove = activeThreadMove(placement);
  const staleStatus =
    !!status &&
    (status.threadId !== placement?.threadId || status.generation !== placement?.generation);
  const currentStatus =
    status?.threadId === placement?.threadId && status?.generation === placement?.generation
      ? status
      : null;
  const lifecycle =
    placement?.operationId != null &&
    [currentStatus?.restore, currentStatus?.reset, currentStatus?.finalSave].some(
      (operation) => operation?.operationId === placement.operationId,
    );
  const entry = input.entries?.find(
    (candidate) =>
      candidate.kind === "move" &&
      candidate.state !== "pending" &&
      candidate.operationId !== undefined &&
      candidate.operationId === (activeMove?.operationId ?? placement?.operationId),
  );
  if (activeMove) return { fallback: !entry, ownsNotice: true, lifecycle: false };
  const fallback =
    !lifecycle && !staleStatus && !entry && currentMoveSnapshots(placement).length > 0;
  return { fallback, ownsNotice: !lifecycle && !staleStatus && (!!entry || fallback), lifecycle };
}

/** Relay ownership controls active moves; the source queue still controls pre-admission moves. */
export function threadMoveQueuePresentation(input: {
  entry?: ThreadMoveQueueEntry | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  status?: RelayThreadVmStatus | null | undefined;
  providerAuth?: RelayThreadVmProviderAuth | null | undefined;
  providerAuthError?: string | null | undefined;
  workerAuth?: ThreadMoveWaitingForAuth | null | undefined;
  cancellation?: "sending" | "requested" | "unknown" | undefined;
  queuePaused?: boolean | undefined;
  error?: string | null | undefined;
}) {
  const { entry, cancellation } = input;
  const placement = input.placement;
  const currentMove = activeThreadMove(placement);
  const activeMove =
    currentMove && (!entry || currentMove.operationId === entry.operationId) ? currentMove : null;
  const ownership = threadMoveQueueOwnership({
    entries: entry ? [entry] : [],
    placement,
    status: input.status,
  });
  if (!entry && !ownership.fallback) return null;
  const outbound = activeMove
    ? activeMove.destinationKind === "vm"
    : entry?.destination.kind === "vm";
  const steps = outbound
    ? ["Upload", "Prepare VM", "Switch"]
    : ["Save", entry ? "Restore" : "Prepare", "Switch"];
  const waiting = entry?.state === "pending";
  const matching =
    !ownership.lifecycle &&
    !waiting &&
    placement?.operationId &&
    (!entry || entry.operationId === placement.operationId)
      ? placement
      : null;
  const status =
    matching &&
    input.status?.threadId === matching.threadId &&
    input.status.generation === matching.generation
      ? input.status
      : null;
  const binding = status?.pendingProviderAuth;
  const auth =
    matching &&
    binding?.operationId === matching.operationId &&
    (binding.generation === matching.generation + 1 ||
      binding.generation === matching.generation) &&
    input.providerAuth?.operationId === binding.operationId &&
    input.providerAuth.generation === binding.generation &&
    input.providerAuth.allocationId === binding.allocationId
      ? input.providerAuth
      : null;
  const currentStatus =
    (outbound || !entry) && status && (!binding || binding.operationId === matching?.operationId)
      ? status
      : null;
  const workerAuth =
    matching && currentStatus
      ? input.workerAuth !== undefined
        ? input.workerAuth
        : threadVmWorkerAuthState(matching, currentStatus)
      : undefined;
  const vm = currentStatus
    ? threadVmPresentation({
        status: currentStatus,
        providerAuth: auth,
        providerAuthError: input.providerAuthError ?? null,
        workerAuth,
      })
    : null;
  const snapshots = currentMoveSnapshots(matching);
  const progress = matching
    ? threadMoveProgressPresentation({
        ...matching,
        moveProgress:
          workerAuth === null
            ? snapshots.map((snapshot) =>
                snapshot.participant === "destination"
                  ? { ...snapshot, waitingForAuth: null }
                  : snapshot,
              )
            : snapshots,
      })
    : null;
  const uploadVerified = snapshots.some(
    (snapshot) =>
      snapshot.stage === "uploading" &&
      snapshot.totalBytes !== null &&
      snapshot.completedBytes === snapshot.totalBytes &&
      snapshot.totalArtifacts !== null &&
      snapshot.completedArtifacts === snapshot.totalArtifacts,
  );
  let label = "Moving thread…";
  let detail: string | null = null;
  let step: number | null = null;
  let tone: "neutral" | "attention" | "danger" = "neutral";
  const relayCancelling = activeMove?.phase === "aborting" || activeMove?.phase === "reopening";
  if (activeMove?.phase === "reopening") {
    label = "Reopening source…";
    detail =
      activeMove.cancellationBlocker === "capture_stop_unconfirmed"
        ? "Waiting to confirm the save stopped. If this persists, restart the source machine."
        : activeMove.cancellationBlocker === "source_reopen_failed"
          ? "Could not reopen the source. Waiting for it to retry."
          : activeMove.cancellationBlocker === "legacy_cancel_rejected"
            ? "The source could not clear this move from its queue."
            : "Waiting for the source to reopen the chat.";
  } else if (activeMove?.phase === "aborting") {
    label = "Cancelling move…";
    detail = "Waiting for the destination to confirm cleanup.";
  } else if (
    entry?.state === "cancelling" ||
    cancellation === "sending" ||
    cancellation === "requested"
  ) {
    label = cancellation === "sending" ? "Requesting cancellation…" : "Cancelling move…";
    detail = "Waiting for both locations to confirm cancellation.";
  } else if (waiting) {
    label = input.queuePaused
      ? "Waiting for the queue to resume"
      : entry?.waitingForCheckout
        ? "Waiting for shared checkout"
        : "Waiting in queue";
    detail = entry?.detail ?? null;
  } else if (entry?.state === "blocked" || matching?.moveFailureDetail) {
    label = "Move needs attention";
    detail = matching?.moveFailureDetail ?? entry?.detail ?? null;
    tone = "danger";
  } else if (matching && input.error) {
    label = "Could not check move status";
    detail = input.error;
    tone = "attention";
  } else if (vm && (vm.tone === "danger" || vm.tone === "attention" || workerAuth != null)) {
    label = vm.label;
    detail = vm.detail;
    tone = vm.tone === "success" ? "neutral" : vm.tone;
    step = 1;
  } else if (entry?.waitingForCheckout) {
    label = "Waiting for shared checkout";
    detail = entry.detail ?? null;
  } else if (progress) {
    label = progress.label;
    detail = progress.detail;
    step = ["capturing", "packing", "uploading"].includes(progress.stage)
      ? 0
      : progress.stage === "activating"
        ? 2
        : 1;
    // A finished source upload is not proof that the destination is ready.
    if (
      outbound &&
      progress.stage === "uploading" &&
      currentStatus &&
      vm?.label === "Preparing VM" &&
      uploadVerified
    ) {
      label = "Preparing VM";
      step = 1;
    }
  } else if (vm?.label === "Preparing VM" && outbound) {
    label = "Preparing VM";
    step = 1;
  } else {
    detail = entry?.detail ?? null;
  }
  if (cancellation === "unknown" && entry?.state !== "cancelling" && !relayCancelling) {
    label = "Could not confirm cancellation";
    detail = "Retry cancellation to send the same request.";
    tone = "attention";
    step = null;
  }
  return {
    previousErrors: matching?.moveFailures?.filter((failure) => !failure.active).slice(0, 2) ?? [],
    ownsNotice: ownership.ownsNotice,
    label,
    detail,
    tone,
    steps,
    step,
    completedSteps:
      step === null
        ? []
        : progress?.stage === "activating"
          ? [0, 1]
          : uploadVerified ||
              (progress && ["downloading", "installing", "setup"].includes(progress.stage))
            ? [0]
            : [],
    waiting,
    outbound,
    activeMove,
    sourceIsVm: activeMove ? activeMove.sourceKind === "vm" : undefined,
    sourceEnvironmentId:
      activeMove?.sourceEnvironmentId ??
      snapshots.find((snapshot) => snapshot.participant === "source")?.environmentId,
    cancelling:
      relayCancelling ||
      entry?.state === "cancelling" ||
      cancellation === "sending" ||
      cancellation === "requested",
  };
}

export type ThreadMoveQueuePresentation = NonNullable<
  ReturnType<typeof threadMoveQueuePresentation>
>;
