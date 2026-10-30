import type {
  AuthSessionUser,
  WorkflowAttribution,
  OrchestrationMessage,
  OrchestrationThread,
  ThreadPromptQueue,
  ThreadPromptQueueEntry,
  ThreadQueueEntry,
} from "@t3tools/contracts";

/** Presentation never changes the canonical queue or schedules delivery. */
export function threadPromptQueuePresentation(input: {
  readonly queue?: ThreadPromptQueue | undefined;
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "id">>;
  readonly sessionStatus?: string | null | undefined;
  readonly unavailable?: boolean | undefined;
  readonly workflowControlled?: boolean | undefined;
  readonly moving?: boolean | undefined;
  readonly archived?: boolean | undefined;
}): {
  inline: { prompt: ThreadPromptQueueEntry; status: "Waiting to start…" | "Sending…" } | null;
  queuedEntries: ReadonlyArray<ThreadQueueEntry>;
} {
  const queue = input.queue;
  // A retry keeps its old transcript ID. Queue ownership lasts until removal;
  // transcript presence alone cannot prove this attempt was admitted.
  const queuedEntries = queue?.entries ?? [];
  const head = queue?.entries[0];
  if (
    !queue ||
    !head ||
    head.kind === "move" ||
    input.unavailable ||
    input.workflowControlled ||
    input.moving ||
    input.archived ||
    !queue.enabled ||
    queue.pauseReason !== null ||
    queue.awaitingTurnId !== null ||
    (queue.preparation !== undefined &&
      (queue.preparation.state !== "ready" || !queue.preparation.settled))
  )
    return { inline: null, queuedEntries };

  const handoff = queue.handoff;
  const sending =
    head.state === "delivering" &&
    handoff?.mode === "next-turn" &&
    handoff.messageId === head.messageId &&
    handoff.revision === head.revision &&
    handoff.controlRevision === queue.revision;
  const waiting =
    head.state === "pending" &&
    handoff === null &&
    input.sessionStatus !== "starting" &&
    input.sessionStatus !== "running";
  if (!sending && !waiting) return { inline: null, queuedEntries };
  return {
    inline: { prompt: head, status: sending ? "Sending…" : "Waiting to start…" },
    queuedEntries: queuedEntries.filter((entry) => entry.messageId !== head.messageId),
  };
}

export function queuedPromptMessage(prompt: ThreadPromptQueueEntry): OrchestrationMessage {
  return {
    id: prompt.messageId,
    role: "user",
    text: prompt.text,
    attachments: prompt.attachments,
    ...(prompt.context ? { context: prompt.context } : {}),
    ...(prompt.author ? { author: prompt.author } : {}),
    ...(prompt.editedBy ? { editedBy: prompt.editedBy } : {}),
    ...(prompt.steeredBy ? { steeredBy: prompt.steeredBy } : {}),
    ...(prompt.workflowOrigin ? { workflowOrigin: prompt.workflowOrigin } : {}),
    turnId: null,
    streaming: false,
    createdAt: prompt.createdAt,
    updatedAt: prompt.createdAt,
  };
}

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
  readonly workflowOrigin?: WorkflowAttribution | undefined;
  readonly author?: AuthSessionUser | undefined;
  readonly editedBy?: AuthSessionUser | undefined;
  readonly steeredBy?: AuthSessionUser | undefined;
}): string | null {
  const name = (actor: AuthSessionUser) => actor.displayName ?? "Teammate";
  const parts = [
    ...(prompt.workflowOrigin
      ? [`Started by workflow · ${prompt.workflowOrigin.workflowName}`]
      : []),
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

export function moveQueueEntryNext(
  entries: ReadonlyArray<ThreadQueueEntry>,
  id: ThreadQueueEntry["messageId"],
) {
  return [id, ...entries.filter((entry) => entry.messageId !== id).map((entry) => entry.messageId)];
}
export function moveQueueEntryLater(
  entries: ReadonlyArray<ThreadQueueEntry>,
  id: ThreadQueueEntry["messageId"],
) {
  const order = entries.map((entry) => entry.messageId);
  const index = order.indexOf(id);
  if (index >= 0 && index + 1 < order.length)
    [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
  return order;
}
