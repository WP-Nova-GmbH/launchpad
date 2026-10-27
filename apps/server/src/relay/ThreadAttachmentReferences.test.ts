import { expect, it } from "@effect/vitest";
import { ChatAttachment, OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";

const at = "2026-10-05T10:00:00.000Z";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const attachment: ChatAttachment = {
  type: "file",
  id: "thread-1-00000000-0000-4000-8000-000000000001-txt",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};
const event = (type: string, payload: unknown) =>
  decodeEvent({
    type,
    sequence: 1,
    eventId: "event",
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  });
const prompt = {
  messageId: "message",
  text: "queued",
  attachments: [attachment],
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 0,
  acceptedSequence: 1,
  createdAt: at,
  state: "pending",
};

it.effect("retains files referenced by historical messages and removed queue entries", () =>
  Effect.gen(function* () {
    const events = [
      event("thread.message-sent", {
        threadId: "thread-1",
        messageId: "message",
        role: "user",
        text: "",
        attachments: [attachment],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      }),
      event("thread.prompt-queue-changed", { threadId: "thread-1", entry: prompt, updatedAt: at }),
      event("thread.prompt-queue-changed", {
        threadId: "thread-1",
        removedMessageId: "message",
        updatedAt: at,
      }),
    ];
    expect(
      yield* collectThreadAttachmentReferences("thread-1", Stream.fromIterable(events)),
    ).toEqual([attachment, attachment]);
  }),
);
it.effect("includes an admitted prompt's files after it leaves the pending queue", () =>
  Effect.gen(function* () {
    const admitted = event("thread.prompt-queue-changed", {
      threadId: "thread-1",
      admission: {
        prompt,
        attemptId: "attempt",
        messageId: "message",
        turnId: "turn",
        evidence: "provider-ack",
      },
      updatedAt: at,
    });
    expect(yield* collectThreadAttachmentReferences("thread-1", Stream.succeed(admitted))).toEqual([
      attachment,
    ]);
  }),
);
it.effect("retains question attachments from the response and both persisted activity forms", () =>
  Effect.gen(function* () {
    const payload = {
      requestId: "request",
      answers: { question: ["yes"] },
      attachmentsByQuestionId: { question: [attachment] },
    };
    const events = [
      event("thread.user-input-response-requested", {
        threadId: "thread-1",
        ...payload,
        createdAt: at,
      }),
      ...["user-input.resolved", "user-input.answer-submitted"].map((kind) =>
        event("thread.activity-appended", {
          threadId: "thread-1",
          activity: {
            id: "activity",
            kind,
            tone: "info",
            summary: "Answered",
            payload,
            turnId: null,
            createdAt: at,
          },
        }),
      ),
    ];
    expect(
      yield* collectThreadAttachmentReferences("thread-1", Stream.fromIterable(events)),
    ).toEqual([attachment, attachment, attachment]);
  }),
);
it.effect("fails closed on malformed persisted answer attachments", () =>
  Effect.gen(function* () {
    const invalid = event("thread.activity-appended", {
      threadId: "thread-1",
      activity: {
        id: "activity",
        kind: "user-input.answer-submitted",
        tone: "info",
        summary: "Answered",
        payload: {
          requestId: "request",
          answers: {},
          attachmentsByQuestionId: { question: [{ ...attachment, sizeBytes: -1 }] },
        },
        turnId: null,
        createdAt: at,
      },
    });
    const error = yield* collectThreadAttachmentReferences(
      "thread-1",
      Stream.succeed(invalid),
    ).pipe(Effect.flip);
    expect(error.message).toContain("malformed");
  }),
);
it.effect("does not interpret unrelated activity payloads as files to copy", () =>
  Effect.gen(function* () {
    const unrelated = event("thread.activity-appended", {
      threadId: "thread-1",
      activity: {
        id: "activity",
        kind: "tool-result",
        tone: "info",
        summary: "Tool",
        payload: { attachmentsByQuestionId: { question: [attachment] } },
        turnId: null,
        createdAt: at,
      },
    });
    expect(yield* collectThreadAttachmentReferences("thread-1", Stream.succeed(unrelated))).toEqual(
      [],
    );
  }),
);
it.effect("rejects events from another thread rather than exporting its files", () =>
  Effect.gen(function* () {
    const other = event("thread.user-input-response-requested", {
      threadId: "other",
      requestId: "request",
      answers: {},
      attachmentsByQuestionId: { question: [attachment] },
      createdAt: at,
    });
    const error = yield* collectThreadAttachmentReferences("thread-1", Stream.succeed(other)).pipe(
      Effect.flip,
    );
    expect(error.message).toContain("another thread");
  }),
);
