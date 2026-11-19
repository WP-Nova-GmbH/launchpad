import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import {
  queuedPromptMessage,
  threadPromptQueuePresentation,
} from "@t3tools/client-runtime/state/threads";

export type InlineThreadPrompt = NonNullable<
  ReturnType<typeof threadPromptQueuePresentation>["inline"]
>;

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
  readonly queuedPrompt?: InlineThreadPrompt;
};

export function pendingThreadFeedVisibility(
  feed: ReadonlyArray<PendingThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  inline: InlineThreadPrompt | null,
) {
  const messageIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  for (const message of queuedMessages) messageIds.add(message.messageId);
  if (inline) messageIds.add(inline.prompt.messageId);
  return {
    messageIds,
    hasPending:
      queuedMessages.length > 0 ||
      inline !== null ||
      feed.some((entry) => entry.acknowledged === true),
  };
}

/** Keep one message identity as local outbox ownership hands over to the queue and transcript. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  inline: InlineThreadPrompt | null = null,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0 && inline === null) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  const queued: ReadonlyArray<PendingThreadFeedEntry> = inline
    ? [
        {
          type: "message",
          id: inline.prompt.messageId,
          createdAt: inline.prompt.createdAt,
          message: queuedPromptMessage(inline.prompt),
          queuedPrompt: inline,
        },
      ]
    : [];
  if (inline) deliveredIds.add(inline.prompt.messageId);
  return [
    ...presentedFeed.filter(
      (entry) =>
        !inline || entry.type !== "message" || entry.message.id !== inline.prompt.messageId,
    ),
    ...queued,
    ...queuedMessages
      .filter((message) => !deliveredIds.has(message.messageId))
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          context: pendingMessage.context,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ];
}
