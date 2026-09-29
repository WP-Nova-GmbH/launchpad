import type {
  AuthSessionUser,
  OrchestrationThread,
  ThreadPromptQueueEntry,
} from "@t3tools/contracts";

/** One identity follows a submission from transport, through the queue, into the transcript. */
export function acceptedThreadMessageIds(
  thread: Pick<OrchestrationThread, "messages" | "promptQueue">,
) {
  return new Set([
    ...thread.messages.map((message) => message.id),
    ...(thread.promptQueue?.entries.map((entry) => entry.messageId) ?? []),
  ]);
}

export function promptAttributionLabel(prompt: {
  readonly author?: AuthSessionUser | undefined;
  readonly editedBy?: AuthSessionUser | undefined;
  readonly steeredBy?: AuthSessionUser | undefined;
}): string | null {
  const name = (actor: AuthSessionUser) => actor.displayName ?? "Teammate";
  const parts = [
    ...(prompt.author ? [`Submitted by ${name(prompt.author)}`] : []),
    ...(prompt.editedBy ? [`Edited by ${name(prompt.editedBy)}`] : []),
    ...(prompt.steeredBy ? [`Steered by ${name(prompt.steeredBy)}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface QueuedPromptEdit {
  readonly messageId: ThreadPromptQueueEntry["messageId"];
  readonly revision: number;
  readonly text: string;
}

/** Editing never reserves delivery: a changed or already delivered entry requires review. */
export function queuedPromptEditConflict(
  edit: QueuedPromptEdit,
  entry: ThreadPromptQueueEntry | undefined,
): string | null {
  if (!entry) return "This prompt is no longer queued. Your draft is preserved.";
  if (entry.state !== "pending") return "This prompt has begun delivery. Your draft is preserved.";
  if (entry.revision !== edit.revision) {
    return "A teammate changed this prompt. Review the current version before replacing it.";
  }
  return null;
}
