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
   * Saved setup ownership requires full-unit proof; ordinary captured PID fences
   * may use confirmed absence. A fresh authorized creation supplies a cleanup
   * command ID to retry a failed stop. Startup/status drains reuse saved proof or
   * pending work and cannot turn a failed cleanup into an implicit retry.
   */
  readonly drainThrough: (
    sequence: number,
    threadId?: ThreadId,
    cleanupCommandId?: string,
  ) => Effect.Effect<void, ThreadCleanupError>;
}

/**
 * ThreadDeletionReactor - Service tag for thread deletion cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}
