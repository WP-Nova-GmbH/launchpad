import { type ChatAttachment, type OrchestrationEvent } from "@t3tools/contracts";
import { UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
export class ThreadAttachmentReferencesError extends Schema.TaggedError<ThreadAttachmentReferencesError>()(
  "ThreadAttachmentReferencesError",
  { message: Schema.String },
) {}

const decodeAnswer = Schema.decodeUnknownEffect(UserInputAttachmentAnswerPayload);

/** Read the complete retained event stream, including edited prompts and resolved questions. */
export const collectThreadAttachmentReferences = Effect.fn("collectThreadAttachmentReferences")(
  function* <E, R>(threadId: string, events: Stream.Stream<OrchestrationEvent, E, R>) {
    const attachments: ChatAttachment[] = [];
    yield* events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (
            event.aggregateKind !== "thread" ||
            event.aggregateId !== threadId ||
            !("threadId" in event.payload) ||
            event.payload.threadId !== threadId
          )
            return yield* new ThreadAttachmentReferencesError({
              message: "Attachment history contains another thread's events.",
            });
          switch (event.type) {
            case "thread.message-sent":
              attachments.push(...(event.payload.attachments ?? []));
              break;
            case "thread.prompt-queue-changed":
              attachments.push(
                ...((event.payload.entry?.kind === "move"
                  ? undefined
                  : event.payload.entry?.attachments) ?? []),
              );
              attachments.push(...(event.payload.admission?.prompt?.attachments ?? []));
              break;
            case "thread.user-input-response-requested":
              attachments.push(
                ...Object.values(event.payload.attachmentsByQuestionId ?? {}).flat(),
              );
              break;
            case "thread.activity-appended": {
              const activity = event.payload.activity;
              if (
                (activity.kind === "user-input.resolved" ||
                  activity.kind === "user-input.answer-submitted") &&
                Predicate.hasProperty(activity.payload, "attachmentsByQuestionId")
              ) {
                const answer = yield* decodeAnswer(activity.payload).pipe(
                  Effect.mapError(
                    () =>
                      new ThreadAttachmentReferencesError({
                        message:
                          "Question attachment history is malformed; it cannot be safely transferred.",
                      }),
                  ),
                );
                attachments.push(...Object.values(answer.attachmentsByQuestionId).flat());
              }
              break;
            }
          }
        }),
      ),
    );
    return attachments;
  },
);
