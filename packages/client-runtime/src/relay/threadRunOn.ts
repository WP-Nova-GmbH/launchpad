import type { ThreadPromptQueue } from "@t3tools/contracts";
import type { ThreadMoveSubmission } from "./threadMoveSubmission.ts";

/** Queue state stays authoritative after the user reorders or cancels a move. */
export function threadRunOnStatus({
  queue,
  saved,
}: {
  queue: Pick<ThreadPromptQueue, "entries" | "enabled" | "pauseReason"> | null | undefined;
  saved: ThreadMoveSubmission | null | undefined;
}) {
  const index = queue?.entries.findIndex((entry) => entry.kind === "move") ?? -1;
  const move = index >= 0 ? queue?.entries[index] : undefined;
  if (move?.kind === "move") {
    const common = { destination: move.destination, messageId: move.messageId };
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
  if (!saved) return null;
  const common = { destination: saved.command.destination, messageId: saved.command.messageId };
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
