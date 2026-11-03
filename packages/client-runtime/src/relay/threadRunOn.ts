import {
  EnvironmentId,
  ProjectId,
  type ThreadMoveDestination,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import {
  activeThreadMove,
  threadMoveQueuePresentation,
  threadMoveQueueRows,
} from "./threadMoveQueuePresentation.ts";
import type { ThreadMoveSubmission } from "./threadMoveSubmission.ts";

/** Relay placement owns an admitted move. Before admission the queue controls order and status. */
export function threadRunOnStatus({
  queue,
  saved,
  placement,
  queueEnvironmentId,
  queueGeneration,
}: {
  queue: Pick<ThreadPromptQueue, "entries" | "enabled" | "pauseReason"> | null | undefined;
  saved: ThreadMoveSubmission | null | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  queueEnvironmentId?: string | undefined;
  queueGeneration?: number | undefined;
}) {
  const { entries } = threadMoveQueueRows({
    entries: queue?.entries,
    placement,
    queueEnvironmentId,
    queueGeneration,
  });
  const active = activeThreadMove(placement);
  if (active) {
    const entry = entries.find(
      (entry) => entry.kind === "move" && entry.operationId === active.operationId,
    );
    const status = threadMoveQueuePresentation({
      placement,
      entry: entry?.kind === "move" ? entry : undefined,
    });
    const destination: ThreadMoveDestination =
      active.destinationKind === "vm"
        ? { kind: "vm" }
        : {
            kind: "environment",
            environmentId: EnvironmentId.make(active.destinationEnvironmentId),
            projectId: ProjectId.make(active.destinationProjectId),
          };
    return {
      source: "relay",
      phase: status?.cancelling ? "cancelling" : "moving",
      title: status?.label ?? "Moving thread…",
      detail: status?.detail,
      warning: status?.tone === "attention" || status?.tone === "danger",
      destination,
    } as const;
  }
  const index = entries.findIndex((entry) => entry.kind === "move");
  const move = entries[index];
  if (move?.kind === "move") {
    const common = {
      source: "queue",
      destination: move.destination,
      messageId: move.messageId,
    } as const;
    if (move.state === "cancelling")
      return {
        ...common,
        phase: "cancelling",
        title: "Cancelling move",
        detail: move.detail ?? "Waiting for cancellation to finish.",
        warning: false,
      } as const;
    if (move.state === "moving")
      return {
        ...common,
        phase: "moving",
        title: "Moving",
        detail: move.detail ?? "The conversation, queued prompts and files are moving together.",
        warning: false,
      } as const;
    if (move.state === "blocked")
      return {
        ...common,
        phase: "blocked",
        title: "Move blocked",
        detail: move.detail ?? "Resolve the blocker in the queue to continue.",
        warning: true,
      } as const;
    if (!queue?.enabled || queue.pauseReason !== null)
      return {
        ...common,
        phase: "paused",
        title: "Queue paused",
        detail:
          move.detail ??
          queue?.pauseReason?.detail ??
          "Resume the queue when you are ready to move.",
        warning: true,
      } as const;
    return {
      ...common,
      phase: "queued",
      title: "Move queued",
      detail:
        move.detail ??
        (index === 0
          ? "Moves next, after any current turn finishes. Reorder it in the queue to move later."
          : "Waiting behind earlier queue entries."),
      warning: false,
    } as const;
  }
  if (
    !saved ||
    (placement &&
      (saved.originEnvironmentId !== placement.environmentId ||
        (saved.sourceGeneration !== undefined && saved.sourceGeneration !== placement.generation)))
  )
    return null;
  const common = {
    source: "saved",
    destination: saved.command.destination,
    messageId: saved.command.messageId,
  } as const;
  if (saved.rejection)
    return {
      ...common,
      phase: "rejected",
      title: "Move rejected",
      detail: saved.rejection,
      warning: true,
    } as const;
  if (saved.accepted)
    return {
      ...common,
      phase: "accepted",
      title: "Move accepted",
      detail: "Waiting for the queue to confirm the move. Do not submit another destination.",
      warning: false,
    } as const;
  return {
    ...common,
    phase: "unknown",
    title: "Checking move",
    detail:
      "The reply is unknown. Check its outcome or retry the saved move; its destination stays unchanged.",
    warning: true,
  } as const;
}

/** An unconnected machine can be checked; confirmed offline or denied hosts cannot be selected. */
export function threadRunOnTargetAvailability(input: {
  readonly phase: import("../connection/presentation.ts").EnvironmentConnectionPhase | undefined;
  readonly failureReason?:
    | import("../connection/model.ts").ConnectionAttemptError["reason"]
    | null
    | undefined;
}) {
  if (input.failureReason === "permission" || input.failureReason === "authentication")
    return { action: null, detail: "Access required" } as const;
  switch (input.phase) {
    case "connected":
      return { action: "select", detail: null } as const;
    case "connecting":
    case "reconnecting":
      return { action: null, detail: "Connecting…" } as const;
    case "offline":
      return { action: null, detail: "Offline" } as const;
    case "unsupported":
      return { action: null, detail: "Update this environment before moving a thread" } as const;
    case "available":
      return { action: "check", detail: "Not connected · Check connection" } as const;
    default:
      return { action: "check", detail: "Connection unknown · Check connection" } as const;
  }
}
