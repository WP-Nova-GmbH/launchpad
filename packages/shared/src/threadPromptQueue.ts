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

/** Queued work prevents lifecycle idleness; archive/pause suppresses only waiting entries. */
export function threadPromptQueueHasWork(
  queue: {
    readonly enabled: boolean;
    readonly handoff: unknown | null;
    readonly awaitingTurnId: unknown | null;
    readonly preparation?: { readonly state: string; readonly settled: boolean } | undefined;
    readonly entries: ReadonlyArray<{ readonly state: string }>;
  },
  archived: boolean,
): boolean {
  return (
    queue.handoff !== null ||
    queue.awaitingTurnId !== null ||
    (queue.preparation !== undefined && !queue.preparation.settled) ||
    queue.entries.some((entry) =>
      ["delivering", "unknown", "moving", "cancelling"].includes(entry.state),
    ) ||
    (!archived && queue.enabled && queue.entries.length > 0)
  );
}

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
    const index = entries.findIndex((item) => item.messageId === entry.messageId);
    entries =
      index < 0
        ? [...entries, entry]
        : entries.map((item, position) => (position === index ? entry : item));
  }
  if (change.order) {
    const positions = new Map(change.order.map((id, index) => [id, index]));
    entries = [...entries].sort(
      (left, right) =>
        (positions.get(left.messageId) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.messageId) ?? Number.MAX_SAFE_INTEGER),
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
