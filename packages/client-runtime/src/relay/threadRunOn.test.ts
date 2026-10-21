import {
  CommandId,
  MessageId,
  ThreadId,
  EnvironmentId,
  type ThreadMoveQueueEntry,
  type ThreadPromptQueue,
  type ThreadPromptQueueEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadRunOnStatus } from "./threadRunOn.ts";
import type { ThreadMoveSubmission } from "./threadMoveSubmission.ts";

const move: ThreadMoveQueueEntry = {
  kind: "move",
  messageId: MessageId.make("move"),
  destination: { kind: "vm" },
  revision: 0,
  acceptedSequence: 1,
  createdAt: "2026-10-21T00:00:00.000Z",
  state: "pending",
};
const queue = {
  entries: [move],
  enabled: true,
  pauseReason: null,
} satisfies Pick<ThreadPromptQueue, "entries" | "enabled" | "pauseReason">;
const saved: ThreadMoveSubmission = {
  originEnvironmentId: EnvironmentId.make("source"),
  command: {
    type: "thread.move.enqueue",
    commandId: CommandId.make("command"),
    messageId: move.messageId,
    threadId: ThreadId.make("thread"),
    destination: move.destination,
    position: "last",
    createdAt: move.createdAt,
  },
};

describe("threadRunOnStatus", () => {
  it("uses actual queue order after a move is reordered", () => {
    expect(threadRunOnStatus({ queue, saved: null })?.detail).toContain("Moves next");
    const prompt: ThreadPromptQueueEntry = {
      kind: "prompt",
      messageId: MessageId.make("earlier"),
      text: "First",
      revision: 0,
      acceptedSequence: 0,
      createdAt: move.createdAt,
      state: "pending",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const later = threadRunOnStatus({ queue: { ...queue, entries: [prompt, move] }, saved: null });
    expect(later?.phase).toBe("queued");
    expect(later?.detail).toBe("Waiting behind earlier queue entries.");
  });

  it.each(["moving", "blocked", "cancelling"] as const)(
    "preserves %s and the server detail",
    (state) => {
      const status = threadRunOnStatus({
        queue: { ...queue, entries: [{ ...move, state, detail: "Exact server reason" }] },
        saved,
      });
      expect(status?.phase).toBe(state);
      expect(status?.detail).toBe("Exact server reason");
    },
  );

  it("keeps paused moves paused without claiming they run next", () => {
    const status = threadRunOnStatus({
      queue: {
        ...queue,
        enabled: false,
        pauseReason: { code: "stopped", detail: "Paused by Vali" },
      },
      saved: null,
    });
    expect(status?.phase).toBe("paused");
    expect(status?.detail).toBe("Paused by Vali");
  });

  it("distinguishes unknown replies, accepted awaiting projection and rejected requests", () => {
    expect(threadRunOnStatus({ queue: null, saved })?.phase).toBe("unknown");
    expect(threadRunOnStatus({ queue: null, saved: { ...saved, accepted: true } })?.phase).toBe(
      "accepted",
    );
    expect(
      threadRunOnStatus({ queue: null, saved: { ...saved, rejection: "Host offline" } }),
    ).toMatchObject({ phase: "rejected", detail: "Host offline" });
    expect(threadRunOnStatus({ queue: null, saved: null })).toBeNull();
  });
});
