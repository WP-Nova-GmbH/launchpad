/**
 * Turn settle detection for the job runner.
 *
 * A job step drives a thread and has to know when the agent is done. The
 * authoritative signal is the one the projector already uses: a turn ends when
 * its session leaves the `running` status
 * (`settledTurnStateForSessionStatus`), which is also what feeds the agent
 * awareness phase ladder. Receipts are deliberately not used — the production
 * `RuntimeReceiptBusLive` publish is a no-op, so they exist for tests only.
 *
 * @module jobs/settle
 */
import type { OrchestrationEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { settledTurnStateForSessionStatus } from "../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/**
 * How a turn ended. `completed` carries the turn it settled so a caller can
 * correlate it; the other two carry whatever the session recorded as its last
 * error, which is the only detail available at this layer.
 */
export type TurnSettleOutcome =
  | { readonly kind: "completed"; readonly turnId: TurnId | null }
  | { readonly kind: "interrupted"; readonly detail: string | null }
  | { readonly kind: "failed"; readonly detail: string | null };

type ThreadSessionSetEvent = Extract<OrchestrationEvent, { readonly type: "thread.session-set" }>;

export interface TurnSettleWatch {
  /**
   * Resolves once the watched thread's turn settles. Never times out: a job
   * that stalls on an escalated approval is meant to stay visible rather than
   * be failed by a clock.
   */
  readonly await: Effect.Effect<TurnSettleOutcome>;
}

/**
 * Begin watching a thread for its next turn to settle.
 *
 * Must be called **before** the turn-start command is dispatched.
 * `streamDomainEvents` is a hot stream with no replay, so a settle published
 * between dispatch and subscription would be lost forever. `startImmediately`
 * runs the forked fiber up to its first suspension — the PubSub subscribe —
 * before this returns, which is the same guarantee `ws.ts` relies on for
 * thread subscriptions.
 */
export const attachTurnSettleWatch = Effect.fn("attachTurnSettleWatch")(function* (input: {
  readonly engine: OrchestrationEngineShape;
  readonly threadId: ThreadId;
}) {
  const { engine, threadId } = input;

  const liveBuffer = yield* Queue.unbounded<ThreadSessionSetEvent>();
  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      event.type === "thread.session-set" && event.payload.threadId === threadId
        ? Queue.offer(liveBuffer, event)
        : Effect.void,
    ),
    { startImmediately: true },
  );

  return { await: awaitTurnSettle(liveBuffer) } satisfies TurnSettleWatch;
}) satisfies (input: {
  readonly engine: OrchestrationEngineShape;
  readonly threadId: ThreadId;
}) => Effect.Effect<TurnSettleWatch, never, Scope.Scope>;

/**
 * Two-phase, because "the session is settled" alone is ambiguous.
 *
 * A warm thread's second turn starts with the session already at `ready`, and
 * the provider may report `ready` again before it acknowledges the new turn.
 * Treating that as a settle returns before the agent has done anything. So a
 * `ready`/`idle` transition only counts once the turn has been observed
 * running.
 *
 * A failed turn *start* never produces a running turn at all — it sets the
 * session to `error` directly — so terminal statuses are accepted in either
 * phase. Without that, the wait would deadlock on exactly the case a job
 * runner most needs to survive.
 */
function awaitTurnSettle(liveBuffer: Queue.Queue<ThreadSessionSetEvent>) {
  return Effect.gen(function* () {
    let runningTurnId: TurnId | null = null;

    while (true) {
      const { session } = (yield* Queue.take(liveBuffer)).payload;
      const settledTurnState = settledTurnStateForSessionStatus(session.status);

      if (settledTurnState === null) {
        // starting | running — latch the turn so the settle that follows is
        // unambiguously this turn's rather than a stale warm-session report.
        if (session.status === "running" && session.activeTurnId !== null) {
          runningTurnId = session.activeTurnId;
        }
        continue;
      }

      if (settledTurnState === "error") {
        return { kind: "failed", detail: session.lastError } as const;
      }
      if (settledTurnState === "interrupted") {
        return { kind: "interrupted", detail: session.lastError } as const;
      }
      if (runningTurnId === null) {
        // ready | idle before the turn was ever acknowledged: the provider has
        // not started our work yet. Keep waiting.
        continue;
      }
      return { kind: "completed", turnId: runningTurnId } as const;
    }
  });
}
