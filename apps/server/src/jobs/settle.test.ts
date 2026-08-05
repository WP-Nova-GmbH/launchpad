import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { attachTurnSettleWatch } from "./settle.ts";

const THREAD_ID = ThreadId.make("thread-settle");
const OTHER_THREAD_ID = ThreadId.make("thread-other");
const NOW = "2026-05-01T00:00:00.000Z";

let nextEventSequence = 0;

function sessionSetEvent(input: {
  readonly threadId?: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId?: string | null;
  readonly lastError?: string | null;
}): OrchestrationEvent {
  nextEventSequence += 1;
  const threadId = input.threadId ?? THREAD_ID;
  return {
    sequence: nextEventSequence,
    eventId: EventId.make(`evt-${nextEventSequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        threadId,
        status: input.status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId:
          input.activeTurnId === undefined || input.activeTurnId === null
            ? null
            : TurnId.make(input.activeTurnId),
        lastError: input.lastError ?? null,
        updatedAt: NOW,
      },
    },
  };
}

/**
 * Drives `streamDomainEvents` from a PubSub so every branch of the settle
 * state machine can be exercised without a provider subprocess. Only the two
 * members the settle watch reads are implemented; the rest die loudly.
 */
const makeEngineHarness = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const engine: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    dispatch: () => Effect.die("dispatch should not be called by the settle watch"),
    get streamDomainEvents() {
      return Stream.fromPubSub(pubSub);
    },
    latestSequence: Effect.succeed(0),
  };
  const emit = (event: OrchestrationEvent) => PubSub.publish(pubSub, event).pipe(Effect.asVoid);
  return { engine, emit };
});

function withWatch(
  use: (input: {
    readonly emit: (event: OrchestrationEvent) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { engine, emit } = yield* makeEngineHarness;
      const watch = yield* attachTurnSettleWatch({ engine, threadId: THREAD_ID });
      yield* use({ emit });
      return yield* watch.await;
    }),
  );
}

it.effect("settles as completed when the session leaves running", () =>
  Effect.gen(function* () {
    const outcome = yield* withWatch(({ emit }) =>
      Effect.gen(function* () {
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-1" }));
        yield* emit(sessionSetEvent({ status: "ready" }));
      }),
    );

    assert.deepEqual(outcome, { kind: "completed", turnId: TurnId.make("turn-1") });
  }),
);

it.effect("ignores a warm session reporting ready before the turn is acknowledged", () =>
  Effect.gen(function* () {
    // A thread's second turn starts with the session already settled, and the
    // provider can report ready again before it picks the turn up. Returning
    // there would settle a turn the agent never ran.
    const outcome = yield* withWatch(({ emit }) =>
      Effect.gen(function* () {
        yield* emit(sessionSetEvent({ status: "ready" }));
        yield* emit(sessionSetEvent({ status: "idle" }));
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-2" }));
        yield* emit(sessionSetEvent({ status: "ready" }));
      }),
    );

    assert.deepEqual(outcome, { kind: "completed", turnId: TurnId.make("turn-2") });
  }),
);

it.effect("reports failed when a turn errors", () =>
  Effect.gen(function* () {
    const outcome = yield* withWatch(({ emit }) =>
      Effect.gen(function* () {
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-1" }));
        yield* emit(sessionSetEvent({ status: "error", lastError: "Turn failed" }));
      }),
    );

    assert.deepEqual(outcome, { kind: "failed", detail: "Turn failed" });
  }),
);

it.effect("reports failed when the turn never starts", () =>
  Effect.gen(function* () {
    // A turn-start failure sets the session to error without ever creating a
    // turn. Requiring a running turn first would deadlock here.
    const outcome = yield* withWatch(({ emit }) =>
      emit(sessionSetEvent({ status: "error", lastError: "Provider session error" })),
    );

    assert.deepEqual(outcome, { kind: "failed", detail: "Provider session error" });
  }),
);

it.effect("reports interrupted when the session exits", () =>
  Effect.gen(function* () {
    const outcome = yield* withWatch(({ emit }) =>
      Effect.gen(function* () {
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-1" }));
        yield* emit(sessionSetEvent({ status: "stopped" }));
      }),
    );

    assert.deepEqual(outcome, { kind: "interrupted", detail: null });
  }),
);

it.effect("ignores sessions belonging to other threads", () =>
  Effect.gen(function* () {
    const outcome = yield* withWatch(({ emit }) =>
      Effect.gen(function* () {
        yield* emit(
          sessionSetEvent({
            threadId: OTHER_THREAD_ID,
            status: "error",
            lastError: "someone else's failure",
          }),
        );
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-1" }));
        yield* emit(sessionSetEvent({ threadId: OTHER_THREAD_ID, status: "stopped" }));
        yield* emit(sessionSetEvent({ status: "ready" }));
      }),
    );

    assert.deepEqual(outcome, { kind: "completed", turnId: TurnId.make("turn-1") });
  }),
);

it.effect("loses no settle published before the watch is awaited", () =>
  Effect.gen(function* () {
    // Every case above emits before awaiting, so they all depend on the
    // subscription being live the moment attachTurnSettleWatch returns. This
    // one states it directly: the whole turn happens first, and the outcome is
    // still observed.
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const { engine, emit } = yield* makeEngineHarness;
        const watch = yield* attachTurnSettleWatch({ engine, threadId: THREAD_ID });
        yield* emit(sessionSetEvent({ status: "running", activeTurnId: "turn-9" }));
        yield* emit(sessionSetEvent({ status: "ready" }));
        return yield* watch.await;
      }),
    );

    assert.deepEqual(outcome, { kind: "completed", turnId: TurnId.make("turn-9") });
  }),
);
