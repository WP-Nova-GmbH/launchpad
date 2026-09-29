import {
  OrchestrationGetSnapshotError,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./LiveStreamBudget.ts";
import type { ThreadSubscriptionAnchor } from "./Services/ProjectionSnapshotQuery.ts";

/** Raw lifecycle events fence initialization and every output buffer, before detail filtering. */
export const makeThreadSubscriptionLifetime = Effect.fn("makeThreadSubscriptionLifetime")(
  function* <E, R, AE, AR>(input: {
    readonly threadId: ThreadId;
    readonly events: Stream.Stream<OrchestrationEvent>;
    readonly readAnchor: Effect.Effect<Option.Option<ThreadSubscriptionAnchor>, E, R>;
    readonly authorize: (anchor: ThreadSubscriptionAnchor) => Effect.Effect<void, AE, AR>;
    readonly onEvent?: (
      event: OrchestrationEvent,
    ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
    readonly onInvalidate?: (error: OrchestrationGetSnapshotError) => Effect.Effect<void>;
  }) {
    const pendingBudget = yield* makeLiveStreamBudget();
    const mutex = yield* Semaphore.make(1);
    let captured: ThreadSubscriptionAnchor | undefined;
    const pending: Array<RetainedLiveItem<OrchestrationEvent>> = [];
    const ended = yield* Deferred.make<never, OrchestrationGetSnapshotError>();
    const error = new OrchestrationGetSnapshotError({
      message: `Thread ${input.threadId} changed lifetime; reload its snapshot`,
      cause: input.threadId,
    });
    let invalid = false;
    const invalidate = Effect.gen(function* () {
      invalid = true;
      yield* input.onInvalidate?.(error) ?? Effect.void;
      yield* Deferred.fail(ended, error);
    });
    const guard = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      Effect.suspend(() =>
        invalid ? Effect.fail(error) : effect.pipe(Effect.raceFirst(Deferred.await(ended))),
      );
    const consume = (event: OrchestrationEvent, anchor: ThreadSubscriptionAnchor) =>
      Effect.gen(function* () {
        if (invalid || event.sequence <= anchor.snapshotSequence) return;
        if (event.type === "thread.deleted" || event.type === "thread.created") {
          yield* invalidate;
          return;
        }
        yield* input.onEvent?.(event) ?? Effect.void;
      });
    yield* input.events.pipe(
      Stream.runForEach((event) =>
        mutex.withPermit(
          Effect.gen(function* () {
            if (invalid || event.aggregateKind !== "thread" || event.aggregateId !== input.threadId)
              return;
            if (captured) return yield* consume(event, captured);
            // Keep consuming while the database read waits; never accumulate an unbounded
            // PubSub backlog. Setup/terminal observers only need lifecycle boundaries.
            if (input.onEvent || event.type === "thread.deleted" || event.type === "thread.created")
              pending.push(yield* pendingBudget.retain(event));
          }),
        ),
      ),
      Effect.catchTag("OrchestrationGetSnapshotError", (cause) =>
        Effect.gen(function* () {
          invalid = true;
          yield* input.onInvalidate?.(cause) ?? Effect.void;
          yield* Deferred.fail(ended, cause);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const anchor = yield* guard(input.readAnchor);
    if (Option.isNone(anchor)) return yield* error;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        captured = anchor.value;
        for (const retained of pending) {
          pendingBudget.release([retained]);
          yield* consume(retained.value, anchor.value);
        }
        pending.length = 0;
      }),
    );
    yield* guard(input.authorize(anchor.value));
    return {
      anchor: anchor.value,
      guard,
      invalidate,
      stream: <A, E2, R2>(stream: Stream.Stream<A, E2, R2>) =>
        Stream.unwrap(
          guard(Effect.succeed(stream.pipe(Stream.interruptWhen(Deferred.await(ended))))),
        ),
    };
  },
);
