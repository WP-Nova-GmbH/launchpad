import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadPromptQueueEntry,
} from "@t3tools/contracts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { appendPendingThreadMessages, pendingThreadFeedVisibility } from "./pending-thread-feed";

const pending = (id: string): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(id),
  commandId: CommandId.make(id),
  text: id,
  attachments: [],
  createdAt: "2026-09-06T10:00:00.000Z",
});

const acceptedPrompt: ThreadPromptQueueEntry = {
  messageId: MessageId.make("accepted"),
  text: "Inspect the uploaded image",
  attachments: [
    { type: "image", id: "server-image", name: "proof.png", mimeType: "image/png", sizeBytes: 4 },
  ],
  context: {
    version: 1,
    records: [
      {
        version: 1,
        kind: "mention",
        contextId: ComposerContextId.make("file"),
        label: "file.ts",
        path: "file.ts",
      },
    ],
  },
  author: { userId: "teammate", displayName: "Teammate", imageUrl: null },
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  acceptedSequence: 9,
  createdAt: "2026-09-06T10:00:00.000Z",
  state: "pending",
};

describe("pending timeline messages", () => {
  it("retains context records while a message is waiting for delivery", () => {
    const record = {
      version: 1 as const,
      kind: "mention" as const,
      contextId: ComposerContextId.make("setup-file"),
      label: "Checkout.tsx",
      path: "src/Checkout.tsx",
    };
    const context = { version: 1 as const, records: [record] };
    const text = "[Checkout.tsx](t3-context://v1/mention/setup-file)";
    const entries = appendPendingThreadMessages([], [], [{ ...pending("context"), text, context }]);
    const entry = entries[0];
    expect(entry?.type).toBe("message");
    if (entry?.type !== "message") throw new Error("Expected a pending message");
    expect(entry.message.text).toBe(text);
    expect(entry.message.context).toEqual(context);
  });

  it("keeps pending messages after newer agent activity in queue order", () => {
    const activity = {
      type: "thinking",
      turnId: null,
      id: "thinking",
      createdAt: "2026-09-06T11:00:00.000Z",
    } as const;
    const entries = appendPendingThreadMessages(
      [activity],
      [],
      [pending("first"), pending("second")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["thinking", "first", "second"]);
    expect(entries[1]?.pendingMessage?.text).toBe("first");
  });

  it("reuses the message id and suppresses the pending copy when delivery appears", () => {
    const queued = pending("sent");
    const optimistic = appendPendingThreadMessages([], [], [queued])[0]!;
    const delivered = { ...optimistic, pendingMessage: undefined };
    expect(appendPendingThreadMessages([delivered], [delivered], [queued])).toEqual([delivered]);
    // Folded messages still count as delivered even when absent from the presented rows.
    expect(appendPendingThreadMessages([], [delivered], [queued])).toEqual([]);
  });

  it("keeps one message through outbox, accepted queue, delivery and authoritative transcript", () => {
    const local = pending(acceptedPrompt.messageId);
    const submitting = appendPendingThreadMessages([], [], [local]);
    const queued = appendPendingThreadMessages([], [], [local], {
      prompt: acceptedPrompt,
      status: "Waiting to start…",
    });
    expect(queued.map((entry) => entry.id)).toEqual(submitting.map((entry) => entry.id));
    expect(queued).toHaveLength(1);
    const entry = queued[0];
    if (entry?.type !== "message") throw new Error("Expected the accepted queue message");
    expect(entry.pendingMessage).toBeUndefined();
    expect(entry.queuedPrompt?.status).toBe("Waiting to start…");
    expect(entry.message.attachments).toEqual(acceptedPrompt.attachments);
    expect(entry.message.context).toEqual(acceptedPrompt.context);
    expect(entry.message.author).toEqual(acceptedPrompt.author);

    const delivering = appendPendingThreadMessages([], [], [], {
      prompt: { ...acceptedPrompt, state: "delivering" },
      status: "Sending…",
    });
    expect(delivering[0]?.id).toBe(entry.id);
    expect(delivering[0]?.queuedPrompt?.status).toBe("Sending…");
    const historical = {
      ...entry,
      queuedPrompt: undefined,
      message: { ...entry.message, text: "Server echo" },
    };
    expect(
      appendPendingThreadMessages([historical], [historical], [local], {
        prompt: acceptedPrompt,
        status: "Waiting to start…",
      }),
    ).toEqual(queued);
    expect(
      appendPendingThreadMessages([], [historical], [local], {
        prompt: acceptedPrompt,
        status: "Waiting to start…",
      }),
    ).toEqual(queued);
    expect(appendPendingThreadMessages([historical], [historical], [local], null)).toEqual([
      historical,
    ]);
    expect(appendPendingThreadMessages([], [historical], [local], null)).toEqual([]);
  });

  it("projects teammate edits and removal without creating an editable local outbox record", () => {
    const edited = { ...acceptedPrompt, revision: 2, text: "Updated by teammate" };
    const entries = appendPendingThreadMessages([], [], [], {
      prompt: edited,
      status: "Waiting to start…",
    });
    const entry = entries[0];
    if (entry?.type !== "message") throw new Error("Expected the accepted queue message");
    expect(entry.message.text).toBe(edited.text);
    expect(entry.queuedPrompt?.prompt.revision).toBe(2);
    expect(entry.pendingMessage).toBeUndefined();
    expect(appendPendingThreadMessages([], [], [], null)).toEqual([]);
  });

  it("retains submission anchoring and pending inset coverage through accepted queue delivery", () => {
    const local = pending(acceptedPrompt.messageId);
    const waiting = { prompt: acceptedPrompt, status: "Waiting to start…" as const };
    const sending = {
      prompt: { ...acceptedPrompt, state: "delivering" as const },
      status: "Sending…" as const,
    };
    const echoed = appendPendingThreadMessages([], [], [], waiting)[0];
    if (echoed?.type !== "message") throw new Error("Expected queued message");
    const authoritative = { ...echoed, queuedPrompt: undefined };
    for (const visibility of [
      pendingThreadFeedVisibility([], [local], null),
      pendingThreadFeedVisibility([], [], waiting),
      pendingThreadFeedVisibility([], [], sending),
      pendingThreadFeedVisibility([{ ...authoritative, acknowledged: true }], [], null),
    ]) {
      expect(visibility.messageIds.has(acceptedPrompt.messageId)).toBe(true);
      expect(visibility.hasPending).toBe(true);
    }
    const admitted = pendingThreadFeedVisibility([authoritative], [], null);
    expect(admitted.messageIds.has(acceptedPrompt.messageId)).toBe(true);
    expect(admitted.hasPending).toBe(false);
    expect(pendingThreadFeedVisibility([], [], null).messageIds.has(acceptedPrompt.messageId)).toBe(
      false,
    );
  });
});
