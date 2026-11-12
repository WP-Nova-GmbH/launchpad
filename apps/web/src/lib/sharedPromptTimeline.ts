import {
  queuedPromptMessage,
  type threadPromptQueuePresentation,
} from "@t3tools/client-runtime/state/threads";
import type { SharedPromptSubmission } from "../sharedPromptSubmissionStore";
import { isImageAttachment, type ChatMessage } from "../types";

/** Each prompt has one visible owner: transport, accepted queue, or transcript. */
export function projectSharedPromptTimeline({
  messages,
  optimistic,
  submissions,
  activeCommandIds,
  queueMessageIds,
  presentation,
  shared,
}: {
  messages: ReadonlyArray<ChatMessage>;
  optimistic: ReadonlyArray<ChatMessage>;
  submissions: ReadonlyArray<SharedPromptSubmission>;
  activeCommandIds: ReadonlyArray<string>;
  queueMessageIds: ReadonlyArray<string>;
  presentation: ReturnType<typeof threadPromptQueuePresentation>;
  shared: boolean;
}): ReadonlyArray<ChatMessage> {
  const queued = new Set(queueMessageIds);
  const unqueuedMessages =
    queued.size > 0 ? messages.filter((message) => !queued.has(message.id)) : messages;
  const transcript = unqueuedMessages.length === messages.length ? messages : unqueuedMessages;
  const owned = new Set([...messages.map((message) => message.id), ...queueMessageIds]);
  const active = new Set(activeCommandIds);
  const recovered = new Set<string>();
  const sending = submissions.flatMap((entry): ChatMessage[] => {
    if (entry.command.type !== "thread.turn.start") return [];
    const command = entry.command;
    if (owned.has(command.message.messageId)) return [];
    if (!active.has(command.commandId) || entry.rejection || entry.awaitingSend) {
      recovered.add(command.message.messageId);
      return [];
    }
    const local = optimistic.find((message) => message.id === command.message.messageId);
    return [
      {
        ...(local ?? {
          ...command.message,
          attachments: command.message.attachments.map((attachment, index) => ({
            ...attachment,
            id: attachment.id ?? `${command.message.messageId}:attachment:${index}`,
            ...("dataUrl" in attachment ? { previewUrl: attachment.dataUrl } : {}),
          })),
          id: command.message.messageId,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          turnId: null,
          streaming: false,
        }),
        pendingStatus: "Sending…",
      },
    ];
  });
  for (const message of sending) owned.add(message.id);
  const local = optimistic.filter(
    (message) => !owned.has(message.id) && !recovered.has(message.id),
  );
  const inline = presentation.inline;
  const queueMessage = inline ? queuedPromptMessage(inline.prompt) : null;
  const optimisticImages = inline
    ? (optimistic
        .find((message) => message.id === inline.prompt.messageId)
        ?.attachments?.filter(isImageAttachment) ?? [])
    : [];
  let imageIndex = 0;
  const additions: ChatMessage[] = [
    ...(inline
      ? [
          {
            ...queueMessage!,
            attachments: queueMessage!.attachments?.map((attachment) => {
              if (!isImageAttachment(attachment)) return attachment;
              const preview = optimisticImages[imageIndex++];
              return preview?.previewUrl &&
                preview.name === attachment.name &&
                preview.mimeType === attachment.mimeType &&
                preview.sizeBytes === attachment.sizeBytes
                ? { ...attachment, previewUrl: preview.previewUrl }
                : attachment;
            }),
            pendingStatus: inline.status,
            pendingPrompt: inline.prompt,
          },
        ]
      : []),
    ...sending,
    ...local.map((message) =>
      shared ? { ...message, pendingStatus: "Sending…" as const } : message,
    ),
  ];
  return additions.length === 0 ? transcript : [...transcript, ...additions];
}
