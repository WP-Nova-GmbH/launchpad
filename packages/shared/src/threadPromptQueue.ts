import type { ThreadPromptQueue, ThreadPromptQueueChangedPayload } from "@t3tools/contracts";

export const emptyThreadPromptQueue = (): ThreadPromptQueue => ({
  enabled: true,
  revision: 0,
  pauseReason: null,
  entries: [],
  handoff: null,
  awaitingTurnId: null,
  admissions: [],
  finalizedTurnId: null,
});

/** Apply one persisted delta; FIFO uses the enqueue event's server sequence. */
export function applyThreadPromptQueueChange(
  previous: ThreadPromptQueue | undefined,
  change: ThreadPromptQueueChangedPayload,
  sequence: number,
): ThreadPromptQueue {
  const queue = previous ?? emptyThreadPromptQueue();
  let entries = change.removedMessageId
    ? queue.entries.filter((entry) => entry.messageId !== change.removedMessageId)
    : queue.entries;
  if (change.entry) {
    const entry = {
      ...change.entry,
      acceptedSequence: change.entry.acceptedSequence || sequence,
    };
    entries = [...entries.filter((item) => item.messageId !== entry.messageId), entry].sort(
      (left, right) => left.acceptedSequence - right.acceptedSequence,
    );
  }
  return {
    ...queue,
    ...change.control,
    ...(change.preparation ? { preparation: change.preparation } : {}),
    entries,
    ...(change.handoff !== undefined ? { handoff: change.handoff } : {}),
    ...(change.awaitingTurnId !== undefined ? { awaitingTurnId: change.awaitingTurnId } : {}),
    ...(change.finalizedTurnId !== undefined ? { finalizedTurnId: change.finalizedTurnId } : {}),
    admissions: change.finalizedTurnId
      ? queue.admissions.filter((admission) => admission.turnId !== change.finalizedTurnId)
      : change.admission
        ? [
            ...queue.admissions.filter((item) => item.attemptId !== change.admission!.attemptId),
            change.admission,
          ]
        : queue.admissions,
  };
}
