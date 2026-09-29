import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { makeThreadSubscriptionLifetime } from "./ThreadSubscriptionLifetime.ts";
import { makeThreadLiveEventCoalescer } from "./ThreadLiveEventCoalescer.ts";

const threadId = ThreadId.make("reusable");
const anchor = { projectId: ProjectId.make("repo-a"), creationSequence: 1, snapshotSequence: 5 };
const base = (sequence: number) => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-09-28T10:00:00Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
const deleted = (sequence: number): OrchestrationEvent => ({
  ...base(sequence),
  type: "thread.deleted",
  payload: { threadId, deletedAt: "2026-09-28T10:00:00Z" },
});
const message = (sequence: number): OrchestrationEvent => ({
  ...base(sequence),
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(`m-${sequence}`),
    role: "assistant",
    text: "private",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-28T10:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
  },
});

describe("thread subscription lifetime", () => {
  it.effect("invalidates authorization in progress and drops the rest of a lifecycle batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const authorizing = yield* Deferred.make<void>();
        const delivered: OrchestrationEvent[] = [];
        const initializing = yield* makeThreadSubscriptionLifetime({
          threadId,
          events: Stream.fromPubSub(events),
          readAnchor: Effect.succeedSome(anchor),
          authorize: () =>
            Deferred.succeed(authorizing, undefined).pipe(Effect.andThen(Effect.never)),
          onEvent: (event) =>
            Effect.sync(() => {
              delivered.push(event);
            }),
        }).pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(authorizing);
        yield* PubSub.publishAll(events, [deleted(6), message(8)]);
        const result = yield* Fiber.join(initializing);
        expect(Exit.isFailure(result)).toBe(true);
        expect(delivered).toEqual([]);
      }),
    ),
  );

  it.effect("drops pre-anchor buffered events but accepts the current lifetime tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const readStarted = yield* Deferred.make<void>();
        const read = yield* Deferred.make<typeof anchor>();
        const seen = yield* Deferred.make<void>();
        const delivered: number[] = [];
        const initializing = yield* makeThreadSubscriptionLifetime({
          threadId,
          events: Stream.fromPubSub(events),
          readAnchor: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(read)),
            Effect.asSome,
          ),
          authorize: () => Effect.void,
          onEvent: (event) =>
            Effect.sync(() => {
              delivered.push(event.sequence);
            }).pipe(Effect.andThen(Deferred.succeed(seen, undefined)), Effect.asVoid),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(readStarted);
        yield* PubSub.publishAll(events, [deleted(2), message(4), message(6)]);
        yield* Deferred.succeed(read, anchor);
        yield* Fiber.join(initializing);
        yield* Deferred.await(seen);
        expect(delivered).toEqual([6]);
      }),
    ),
  );

  it.effect("cancels snapshot loading and clears queued output and synchronization markers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const buffer = yield* makeThreadLiveEventCoalescer();
        const lifetime = yield* makeThreadSubscriptionLifetime({
          threadId,
          events: Stream.fromPubSub(events),
          readAnchor: Effect.succeedSome(anchor),
          authorize: () => Effect.void,
          onInvalidate: buffer.close,
          onEvent: (event) => buffer.offer({ kind: "event", event }),
        });
        yield* buffer.offer({ kind: "event", event: message(6) });
        yield* buffer.offer({ kind: "synchronized" });
        const snapshotStarted = yield* Deferred.make<void>();
        const pending = yield* lifetime
          .guard(Deferred.succeed(snapshotStarted, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(snapshotStarted);
        yield* PubSub.publishAll(events, [deleted(7), message(9)]);
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        yield* buffer.closed;
        const delivered: unknown[] = [];
        const result = yield* lifetime.stream(buffer.stream).pipe(
          Stream.runForEach((item) =>
            Effect.sync(() => {
              delivered.push(item);
            }),
          ),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(delivered).toEqual([]);
      }),
    ),
  );
});
