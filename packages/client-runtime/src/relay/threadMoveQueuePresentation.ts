import type { ThreadMoveQueueEntry, ThreadQueueEntry } from "@t3tools/contracts";
import type {
  RelayPortableThreadPlacement,
  RelayThreadVmProviderAuth,
  RelayThreadVmStatus,
} from "@t3tools/contracts/relay";
import { threadMoveProgressPresentation, threadVmPresentation } from "./threadVmControls.ts";

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
      candidate.operationId === placement?.operationId,
  );
  const fallback =
    !lifecycle && !staleStatus && !entry && currentMoveSnapshots(placement).length > 0;
  return { fallback, ownsNotice: !lifecycle && !staleStatus && (!!entry || fallback), lifecycle };
}

/** Queue state owns the move; transfer receipts only describe that exact operation. */
export function threadMoveQueuePresentation(input: {
  entry?: ThreadMoveQueueEntry | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  status?: RelayThreadVmStatus | null | undefined;
  providerAuth?: RelayThreadVmProviderAuth | null | undefined;
  cancellation?: "sending" | "requested" | "unknown" | undefined;
  queuePaused?: boolean | undefined;
  error?: string | null | undefined;
}) {
  const { entry, cancellation } = input;
  const placement = input.placement;
  const ownership = threadMoveQueueOwnership({
    entries: entry ? [entry] : [],
    placement,
    status: input.status,
  });
  if (!entry && !ownership.fallback) return null;
  const outbound = entry?.destination.kind === "vm";
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
  const vm = currentStatus
    ? threadVmPresentation({ status: currentStatus, providerAuth: auth })
    : null;
  const snapshots = currentMoveSnapshots(matching);
  const progress = matching
    ? threadMoveProgressPresentation({
        ...matching,
        moveProgress: snapshots,
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
  if (entry?.state === "cancelling" || cancellation === "sending" || cancellation === "requested") {
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
  } else if (vm && (vm.tone === "danger" || vm.tone === "attention")) {
    label = vm.label;
    detail = vm.detail;
    tone = vm.tone;
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
  if (cancellation === "unknown" && entry?.state !== "cancelling") {
    label = "Could not confirm cancellation";
    detail = "Retry cancellation to send the same request.";
    tone = "attention";
    step = null;
  }
  return {
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
    sourceEnvironmentId: snapshots.find((snapshot) => snapshot.participant === "source")
      ?.environmentId,
    cancelling:
      entry?.state === "cancelling" || cancellation === "sending" || cancellation === "requested",
  };
}

export type ThreadMoveQueuePresentation = NonNullable<
  ReturnType<typeof threadMoveQueuePresentation>
>;
