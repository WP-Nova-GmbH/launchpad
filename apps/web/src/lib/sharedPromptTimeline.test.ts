import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type ThreadPromptQueueEntry,
} from "@t3tools/contracts";
import {
  threadPromptQueuePresentation,
  queuedPromptMessage,
} from "@t3tools/client-runtime/state/threads";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { projectSharedPromptTimeline } from "./sharedPromptTimeline";
import type { SharedPromptSubmission } from "../sharedPromptSubmissionStore";

const prompt: ThreadPromptQueueEntry = {
  messageId: MessageId.make("pending"),
  text: "Keep this visible",
  attachments: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  acceptedSequence: 1,
  createdAt: "2026-10-30T10:00:00Z",
  state: "pending",
};
const commandId = CommandId.make("command");
const submission: SharedPromptSubmission = {
  environmentId: EnvironmentId.make("environment"),
  command: {
    type: "thread.turn.start",
    commandId,
    threadId: ThreadId.make("thread"),
    message: { messageId: prompt.messageId, role: "user", text: prompt.text, attachments: [] },
    runtimeMode: prompt.runtimeMode,
    interactionMode: prompt.interactionMode,
    createdAt: prompt.createdAt,
  },
};
const empty = emptyThreadPromptQueue();
const project = (overrides: Partial<Parameters<typeof projectSharedPromptTimeline>[0]> = {}) =>
  projectSharedPromptTimeline({
    messages: [],
    optimistic: [],
    submissions: [],
    activeCommandIds: [],
    queueMessageIds: [],
    presentation: threadPromptQueuePresentation({ queue: empty, messages: [] }),
    shared: true,
    ...overrides,
  });

describe("shared prompt transcript ownership", () => {
  it("preserves the settled transcript reference when there is no pending work", () => {
    const messages = [queuedPromptMessage(prompt)];
    expect(project({ messages })).toBe(messages);
  });

  it("keeps the optimistic image preview during acceptance while using authoritative text", () => {
    const attachment = {
      type: "image" as const,
      id: "uploaded-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const accepted = { ...prompt, text: "Authoritative edit", attachments: [attachment] };
    const optimistic = {
      ...queuedPromptMessage(prompt),
      attachments: [{ ...attachment, id: "local-image", previewUrl: "blob:preview" }],
    };
    const result = project({
      optimistic: [optimistic],
      queueMessageIds: [prompt.messageId],
      presentation: threadPromptQueuePresentation({
        queue: { ...empty, entries: [accepted] },
        messages: [],
      }),
    });
    expect(result[0]?.text).toBe("Authoritative edit");
    expect(result[0]?.attachments?.[0]).toMatchObject({
      id: "uploaded-image",
      previewUrl: "blob:preview",
    });
  });

  it("keeps one identity through transport, acceptance, handoff and admission", () => {
    const optimistic = queuedPromptMessage(prompt);
    const sending = project({
      optimistic: [optimistic],
      submissions: [submission],
      activeCommandIds: [commandId],
    });
    expect(sending).toHaveLength(1);
    expect(sending[0]).toMatchObject({
      id: prompt.messageId,
      text: prompt.text,
      pendingStatus: "Sending…",
    });
    let queue = { ...empty, entries: [prompt] };
    const pending = project({
      optimistic: [optimistic],
      submissions: [submission],
      activeCommandIds: [commandId],
      queueMessageIds: [prompt.messageId],
      presentation: threadPromptQueuePresentation({ queue, messages: [] }),
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: prompt.messageId, pendingStatus: "Waiting to start…" });
    const delivering = { ...prompt, state: "delivering" as const };
    const handedOff = {
      ...queue,
      entries: [delivering],
      handoff: {
        attemptId: commandId,
        messageId: prompt.messageId,
        revision: prompt.revision,
        controlRevision: queue.revision,
        mode: "next-turn" as const,
      },
    };
    const inFlight = project({
      queueMessageIds: [prompt.messageId],
      presentation: threadPromptQueuePresentation({
        queue: handedOff,
        messages: [],
        sessionStatus: "starting",
      }),
    });
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({ id: prompt.messageId, pendingStatus: "Sending…" });
    const admissionOverlap = project({
      messages: [optimistic],
      submissions: [submission],
      activeCommandIds: [commandId],
      queueMessageIds: [prompt.messageId],
      presentation: threadPromptQueuePresentation({ queue: handedOff, messages: [optimistic] }),
    });
    expect(admissionOverlap).toHaveLength(1);
    expect(admissionOverlap[0]).toMatchObject({ id: prompt.messageId, pendingStatus: "Sending…" });
    expect(project({ messages: [optimistic] })).toEqual([optimistic]);
  });

  it("keeps retried work visible when the transcript contains a historical same-ID admission", () => {
    const historical = { ...queuedPromptMessage(prompt), turnId: TurnId.make("old-turn") };
    const paused = {
      ...empty,
      enabled: false,
      entries: [prompt],
      pauseReason: { code: "stopped" as const, detail: "Resume after reviewing delivery" },
    };
    const replay = (queue: typeof empty) =>
      project({
        messages: [historical],
        queueMessageIds: queue.entries.map((entry) => entry.messageId),
        presentation: threadPromptQueuePresentation({
          queue,
          messages: [historical],
          sessionStatus: "ready",
        }),
      });
    expect(replay(paused)).toEqual([]);
    const resumed = { ...paused, enabled: true, pauseReason: null };
    const pending = replay(resumed);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: prompt.messageId,
      pendingStatus: "Waiting to start…",
      turnId: null,
    });
    const delivering = replay({
      ...resumed,
      entries: [{ ...prompt, state: "delivering" }],
      handoff: {
        attemptId: commandId,
        messageId: prompt.messageId,
        revision: prompt.revision,
        controlRevision: resumed.revision,
        mode: "next-turn",
      },
    });
    expect(delivering).toHaveLength(1);
    expect(delivering[0]).toMatchObject({
      id: prompt.messageId,
      pendingStatus: "Sending…",
      turnId: null,
    });
    expect(replay(empty)).toEqual([historical]);
    expect(project({ messages: [historical] })).toEqual([historical]);
  });

  it("leaves paused and uncertain submissions to queue/recovery, including after reload", () => {
    const queue = { ...empty, enabled: false, entries: [prompt] };
    expect(
      project({
        optimistic: [queuedPromptMessage(prompt)],
        queueMessageIds: [prompt.messageId],
        presentation: threadPromptQueuePresentation({ queue, messages: [] }),
      }),
    ).toEqual([]);
    expect(
      project({ optimistic: [queuedPromptMessage(prompt)], submissions: [submission] }),
    ).toEqual([]);
    expect(
      project({
        optimistic: [queuedPromptMessage(prompt)],
        submissions: [{ ...submission, rejection: "Access denied" }],
        activeCommandIds: [commandId],
      }),
    ).toEqual([]);
  });

  it("uses authoritative edits and removes a remote-deleted queue bubble", () => {
    const revised = { ...prompt, text: "Teammate edit", revision: 2 };
    expect(
      project({
        queueMessageIds: [prompt.messageId],
        presentation: threadPromptQueuePresentation({
          queue: { ...empty, entries: [revised] },
          messages: [],
        }),
      })[0]?.text,
    ).toBe("Teammate edit");
    expect(project()).toEqual([]);
  });

  it("keeps data URL previews before acceptance when the optimistic row is no longer mounted", () => {
    const imageSubmission = {
      ...submission,
      command: {
        ...submission.command,
        message: {
          messageId: prompt.messageId,
          role: "user" as const,
          text: "Image",
          attachments: [
            {
              type: "image" as const,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "data:image/png;base64,AA==",
            },
          ],
        },
      },
    };
    expect(
      project({ submissions: [imageSubmission], activeCommandIds: [commandId] })[0]
        ?.attachments?.[0],
    ).toMatchObject({ previewUrl: "data:image/png;base64,AA==" });
  });
});
