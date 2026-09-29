/**
 * ThreadDeletionReactor - Thread deletion cleanup reactor service interface.
 *
 * Owns background workers that react to thread deletion domain events and
 * stop runtime resources and retain a failed process-exit fence for terminals.
 *
 * @module ThreadDeletionReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";

export class ThreadCleanupError extends Schema.TaggedError<ThreadCleanupError>()(
  "ThreadCleanupError",
  {
    threadId: ThreadId,
    message: Schema.String,
  },
) {}

/**
 * ThreadDeletionReactorShape - Service API for thread deletion cleanup.
 */
export interface ThreadDeletionReactorShape {
  /**
   * Start reacting to thread.deleted orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Waits through the supplied event sequence and confirms captured cleanup.
   * Passing a thread ID isolates failures and waiting to that thread.
   * A successful thread.create sequence is the fence callers use before the
   * new incarnation can own runtime resources. An unconfirmed exit retries
   * captured handles in this runtime. After restart, only confirmed absence of
   * captured process IDs clears the durable fence; unknown ownership stays blocked.
   * A drain never terminates a process using an ID recovered from storage.
   */
  readonly drainThrough: (
    sequence: number,
    threadId?: ThreadId,
  ) => Effect.Effect<void, ThreadCleanupError>;
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}
