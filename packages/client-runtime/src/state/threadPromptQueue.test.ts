import { describe, expect, it } from "vite-plus/test";
import { MessageId, type ThreadPromptQueueEntry } from "@t3tools/contracts";
import {
  promptAttributionLabel,
  queuedPromptEditConflict,
  acceptedThreadMessageIds,
} from "./threadPromptQueue.ts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";

const entry: ThreadPromptQueueEntry = {
  messageId: MessageId.make("message"),
  text: "Original",
  attachments: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  acceptedSequence: 9,
  createdAt: "2026-09-28T00:00:00Z",
  state: "pending",
};

describe("shared prompt presentation", () => {
  it("preserves the edit text while rejecting a stale or already delivering entry", () => {
    const draft = { messageId: entry.messageId, revision: 1, text: "My unsaved edit" };
    expect(queuedPromptEditConflict(draft, entry)).toBeNull();
    expect(queuedPromptEditConflict(draft, { ...entry, revision: 2 })).toContain(
      "teammate changed",
    );
    expect(queuedPromptEditConflict(draft, { ...entry, state: "delivering" })).toContain(
      "begun delivery",
    );
    expect(queuedPromptEditConflict(draft, undefined)).toContain("draft is preserved");
    expect(draft.text).toBe("My unsaved edit");
  });
  it("keeps submitter, editor and steerer distinct", () => {
    expect(
      promptAttributionLabel({
        author: { userId: "alice", displayName: "Alice", imageUrl: null },
        editedBy: { userId: "bob", displayName: "Bob", imageUrl: null },
        steeredBy: { userId: "carol", displayName: null, imageUrl: null },
      }),
    ).toBe("Submitted by Alice · Edited by Bob · Steered by Teammate");
    expect(promptAttributionLabel({})).toBeNull();
  });
  it("reconciles one transport identity whether acceptance or admission arrives first", () => {
    const queue = { ...emptyThreadPromptQueue(), entries: [entry] };
    const message = {
      id: entry.messageId,
      role: "user" as const,
      text: entry.text,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      turnId: null,
      streaming: false,
    };
    expect([...acceptedThreadMessageIds({ messages: [], promptQueue: queue })]).toEqual([
      entry.messageId,
    ]);
    expect([...acceptedThreadMessageIds({ messages: [message], promptQueue: queue })]).toEqual([
      entry.messageId,
    ]);
    expect([...acceptedThreadMessageIds({ messages: [message] })]).toEqual([entry.messageId]);
  });
});
