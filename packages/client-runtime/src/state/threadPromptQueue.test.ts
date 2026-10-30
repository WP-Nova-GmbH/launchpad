import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  MessageId,
  TurnId,
  type ThreadPromptQueue,
  type ThreadPromptQueueEntry,
} from "@t3tools/contracts";
import {
  promptAttributionLabel,
  queuedPromptEditConflict,
  acceptedThreadMessageIds,
  queuedPromptMessage,
  threadPromptQueuePresentation,
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
  it("labels automatic prompts and keeps human editing attribution", () => {
    expect(
      promptAttributionLabel({
        workflowOrigin: {
          kind: "automation",
          jobId: "job",
          workflowId: "flow",
          workflowName: "Frozen name",
        },
        editedBy: { userId: "bob", displayName: "Bob", imageUrl: null },
      }),
    ).toBe("Started by workflow · Frozen name · Edited by Bob");
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

describe("inline prompt delivery", () => {
  const next = { ...entry, messageId: MessageId.make("next"), text: "Next task" };
  const handoff = {
    attemptId: CommandId.make("delivery"),
    messageId: entry.messageId,
    revision: entry.revision,
    controlRevision: 0,
    mode: "next-turn" as const,
  };
  const present = (queue: ThreadPromptQueue, sessionStatus: string | null = null) =>
    threadPromptQueuePresentation({ queue, sessionStatus, messages: [] });

  it("keeps an idle send inline through delivery and a second enqueue", () => {
    const accepted = { ...emptyThreadPromptQueue(), entries: [entry] };
    const before = structuredClone(accepted);
    expect(present(accepted)).toEqual({
      inline: { prompt: entry, status: "Waiting to start…" },
      queuedEntries: [],
    });
    expect(present({ ...accepted, entries: [entry, next] })).toEqual({
      inline: { prompt: entry, status: "Waiting to start…" },
      queuedEntries: [next],
    });
    const delivering = { ...entry, state: "delivering" as const };
    for (const sessionStatus of [null, "starting", "running"]) {
      expect(present({ ...accepted, entries: [delivering, next], handoff }, sessionStatus)).toEqual(
        {
          inline: { prompt: delivering, status: "Sending…" },
          queuedEntries: [next],
        },
      );
    }
    expect(accepted).toEqual(before);
  });

  it("keeps new prompts queued during startup, an active turn, or checkpoint settlement", () => {
    const queue = { ...emptyThreadPromptQueue(), entries: [entry] };
    for (const sessionStatus of ["starting", "running"]) {
      expect(present(queue, sessionStatus)).toEqual({ inline: null, queuedEntries: [entry] });
    }
    expect(present({ ...queue, awaitingTurnId: TurnId.make("checkpoint") }, "idle")).toEqual({
      inline: null,
      queuedEntries: [entry],
    });
  });

  it("requires a matching next-turn handoff before calling a delivery Sending", () => {
    const queue = {
      ...emptyThreadPromptQueue(),
      entries: [{ ...entry, state: "delivering" as const }],
    };
    for (const proof of [
      null,
      { ...handoff, mode: "steer" as const },
      { ...handoff, messageId: next.messageId },
      { ...handoff, revision: entry.revision + 1 },
      { ...handoff, controlRevision: handoff.controlRevision + 1 },
    ]) {
      expect(present({ ...queue, handoff: proof }).inline).toBeNull();
    }
    expect(present({ ...queue, entries: [entry], handoff }).inline).toBeNull();
  });

  it("keeps paused, unknown, setup and controlled queues available for recovery", () => {
    const queue = { ...emptyThreadPromptQueue(), entries: [entry] };
    const preparation = {
      originalCommandId: CommandId.make("original"),
      attemptId: CommandId.make("setup"),
      revision: 1,
      state: "ready" as const,
      settled: true,
      recipe: null,
    };
    for (const blocked of [
      { ...queue, enabled: false },
      { ...queue, pauseReason: { code: "stopped" as const, detail: "Paused" } },
      { ...queue, entries: [{ ...entry, state: "unknown" as const }] },
      { ...queue, preparation: { ...preparation, settled: false } },
      ...(["pending", "running", "failed"] as const).map((state) => ({
        ...queue,
        preparation: { ...preparation, state },
      })),
    ]) {
      expect(present(blocked)).toEqual({ inline: null, queuedEntries: blocked.entries });
    }
    for (const blocked of [{ unavailable: true }, { workflowControlled: true }, { moving: true }]) {
      expect(threadPromptQueuePresentation({ queue, messages: [], ...blocked })).toEqual({
        inline: null,
        queuedEntries: [entry],
      });
    }
    expect(present({ ...queue, preparation }).inline?.prompt).toBe(entry);
  });

  it("keeps move entries in their canonical position without replacing the active prompt", () => {
    const move = {
      kind: "move" as const,
      messageId: MessageId.make("move"),
      destination: { kind: "vm" as const },
      revision: 1,
      acceptedSequence: 10,
      createdAt: entry.createdAt,
      state: "pending" as const,
    };
    const queue = { ...emptyThreadPromptQueue(), entries: [entry, move, next] };
    expect(present(queue)).toEqual({
      inline: { prompt: entry, status: "Waiting to start…" },
      queuedEntries: [move, next],
    });
    expect(present({ ...queue, entries: [move, entry] })).toEqual({
      inline: null,
      queuedEntries: [move, entry],
    });
    expect(queue.entries).toEqual([entry, move, next]);
  });

  it("keeps queue ownership until removal despite an overlapping transcript admission", () => {
    const queue = {
      ...emptyThreadPromptQueue(),
      entries: [{ ...entry, state: "delivering" as const }, next],
      handoff,
    };
    expect(threadPromptQueuePresentation({ queue, messages: [{ id: entry.messageId }] })).toEqual({
      inline: { prompt: queue.entries[0], status: "Sending…" },
      queuedEntries: [next],
    });
    const unknown = { ...entry, state: "unknown" as const };
    expect(
      threadPromptQueuePresentation({
        queue: { ...queue, entries: [unknown, next] },
        messages: [{ id: entry.messageId }],
      }),
    ).toEqual({ inline: null, queuedEntries: [unknown, next] });
    expect(threadPromptQueuePresentation({ messages: [{ id: entry.messageId }] })).toEqual({
      inline: null,
      queuedEntries: [],
    });
  });

  it("keeps a historical admission from hiding an explicitly retried queue entry", () => {
    const historical = [{ id: entry.messageId }];
    const paused = {
      ...emptyThreadPromptQueue(),
      enabled: false,
      pauseReason: { code: "stopped" as const, detail: "Resume the retry" },
      entries: [entry],
    };
    expect(threadPromptQueuePresentation({ queue: paused, messages: historical })).toEqual({
      inline: null,
      queuedEntries: [entry],
    });
    const resumed = { ...paused, enabled: true, pauseReason: null };
    expect(threadPromptQueuePresentation({ queue: resumed, messages: historical })).toEqual({
      inline: { prompt: entry, status: "Waiting to start…" },
      queuedEntries: [],
    });
    const delivering = { ...entry, state: "delivering" as const };
    expect(
      threadPromptQueuePresentation({
        queue: { ...resumed, entries: [delivering], handoff },
        messages: historical,
      }),
    ).toEqual({ inline: { prompt: delivering, status: "Sending…" }, queuedEntries: [] });
  });

  it("keeps archived work queued instead of implying that it will start", () => {
    const queue = { ...emptyThreadPromptQueue(), entries: [entry] };
    expect(threadPromptQueuePresentation({ queue, messages: [], archived: true })).toEqual({
      inline: null,
      queuedEntries: [entry],
    });
  });

  it("projects authoritative edits, attribution, attachments and context with one identity", () => {
    const prompt = {
      ...entry,
      text: "Edited remotely",
      revision: 2,
      author: { userId: "alice", displayName: "Alice", imageUrl: null },
      editedBy: { userId: "bob", displayName: "Bob", imageUrl: null },
      steeredBy: { userId: "carol", displayName: "Carol", imageUrl: null },
      workflowOrigin: {
        kind: "automation" as const,
        jobId: "job",
        workflowId: "flow",
        workflowName: "Workflow",
      },
      attachments: [
        {
          type: "image" as const,
          id: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 12,
        },
      ],
      context: {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "file" as const,
            contextId: ComposerContextId.make("file"),
            attachmentId: "image",
            label: "Image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ],
      },
    };
    expect(queuedPromptMessage(prompt)).toEqual({
      id: prompt.messageId,
      role: "user",
      text: prompt.text,
      attachments: prompt.attachments,
      context: prompt.context,
      author: prompt.author,
      editedBy: prompt.editedBy,
      steeredBy: prompt.steeredBy,
      workflowOrigin: prompt.workflowOrigin,
      turnId: null,
      streaming: false,
      createdAt: prompt.createdAt,
      updatedAt: prompt.createdAt,
    });
    expect(present({ ...emptyThreadPromptQueue(), entries: [prompt] }).inline?.prompt).toBe(prompt);
    expect(present(emptyThreadPromptQueue()).inline).toBeNull();
  });
});
