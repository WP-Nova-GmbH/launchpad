import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";

export class ThreadExecutionRelayError extends Schema.TaggedError<ThreadExecutionRelayError>()(
  "ThreadExecutionRelayError",
  {
    threadId: Schema.String,
    operation: Schema.Literals(["admit", "complete", "history", "inbox"]),
    detail: Schema.String,
  },
) {}
export interface ThreadWorkIdentity {
  readonly threadId: string;
  readonly workId: string;
  readonly kind: "provider" | "terminal" | "setup" | "workspace";
  readonly expectedGeneration?: number;
}
type RelayWork = ThreadWorkIdentity & {
  readonly relayUrl: string;
  readonly environmentId: string;
  readonly generation: number;
};
export interface ThreadExecutionAuthority {
  readonly admit: (
    work: RelayWork,
  ) => Effect.Effect<
    { readonly completed: boolean; readonly newlyAdmitted: boolean },
    ThreadExecutionRelayError
  >;
  readonly complete: (work: RelayWork) => Effect.Effect<void, ThreadExecutionRelayError>;
}

/** Never replay an uncertain side effect. A caller must reconcile it with its provider/process receipt. */
export function makeThreadExecutionRelay(
  sql: SqlClient.SqlClient,
  authority: ThreadExecutionAuthority,
  requiredOwner?: { threadId: string; generation: number; environmentId: string; relayUrl: string },
) {
  const fence = makeThreadExecutionFence(sql);
  const getPlacement = Effect.fnUntraced(function* (threadId: string) {
    const placement = yield* fence.get(threadId);
    if (
      requiredOwner &&
      (requiredOwner.threadId !== threadId ||
        !placement ||
        placement.generation !== requiredOwner.generation ||
        placement.environmentId !== requiredOwner.environmentId ||
        placement.relayUrl !== requiredOwner.relayUrl)
    )
      return yield* new ThreadExecutionFenceError({
        threadId,
        detail: "This VM is waiting for verified ownership of its assigned thread.",
      });
    return placement;
  });
  const current = Effect.fnUntraced(function* (input: ThreadWorkIdentity) {
    const placement = yield* getPlacement(input.threadId);
    if (
      input.expectedGeneration !== undefined &&
      placement?.generation !== input.expectedGeneration
    )
      return yield* new ThreadExecutionFenceError({
        threadId: input.threadId,
        detail: "Execution belongs to a different thread generation.",
      });
    return placement ? { ...placement, ...input, workId: `${input.kind}:${input.workId}` } : null;
  });
  const begin = Effect.fn("ThreadExecutionRelay.begin")(function* (input: ThreadWorkIdentity) {
    yield* fence.assertCheckoutAvailable({ threadId: input.threadId });
    const work = yield* current(input);
    if (!work) return "ordinary" as const;
    const prior = yield* fence.reserveWork(work);
    if (prior.completed) return "completed" as const;
    if (prior.started) return "reconcile" as const;
    const grant = yield* authority.admit(work);
    if (grant.completed) {
      yield* fence.completeWork(work);
      yield* fence.acknowledgeWork(work);
      return "completed" as const;
    }
    const decision = yield* fence.startReservedWork(work);
    if (decision === "held") {
      // Drain won before any tool could start. Retain a completion report until
      // the relay acknowledges it; never leave an invisible remote reservation.
      yield* confirmStopped(input);
      return yield* new ThreadExecutionFenceError({
        threadId: input.threadId,
        detail: "The thread started moving before this work could begin.",
      });
    }
    return decision;
  });
  const confirmStopped = Effect.fn("ThreadExecutionRelay.confirmStopped")(function* (
    input: ThreadWorkIdentity,
  ) {
    const work = yield* current(input);
    if (!work) return;
    const prior = yield* fence.getWork(work);
    if (!prior)
      return yield* new ThreadExecutionFenceError({
        threadId: input.threadId,
        detail: "Cannot complete work without its local execution identity.",
      });
    // Persist positive local evidence before networking. A lost acknowledgement can
    // then be retried after restart without rerunning or re-inspecting the tool.
    yield* fence.completeWork(work);
    if (!prior.relayCompleted) {
      yield* authority.complete(work);
      yield* fence.acknowledgeWork(work);
    }
  });
  // Call only after provider shutdown/output drain. The VM boundary also requires
  // a positive empty workload inventory, including detached terminal/setup children.
  // Closing admission first prevents a new process racing this receipt.
  const confirmProcessesStopped = Effect.fn("ThreadExecutionRelay.confirmProcessesStopped")(
    function* (threadId: string, boundary: "provider" | "vm") {
      const owner = yield* getPlacement(threadId);
      if (!owner || !["draining", "frozen"].includes(owner.phase))
        return yield* new ThreadExecutionFenceError({
          threadId,
          detail: "Close thread admission before confirming process shutdown.",
        });
      const pending = yield* sql<{
        workId: string;
        kind: ThreadWorkIdentity["kind"];
      }>`SELECT work_id AS "workId",kind
        FROM thread_execution_work WHERE thread_id=${threadId} AND generation=${owner.generation}
          AND (kind='provider' OR (${boundary === "vm"} AND kind IN ('terminal','setup')))
          AND (completed=0 OR relay_completed=0) ORDER BY work_id`;
      for (const work of pending) {
        if (!work.workId.startsWith(`${work.kind}:`))
          return yield* new ThreadExecutionFenceError({
            threadId,
            detail: "Process work has an invalid execution identity.",
          });
        yield* confirmStopped({
          threadId,
          expectedGeneration: owner.generation,
          kind: work.kind,
          workId: work.workId.slice(work.kind.length + 1),
        });
      }
    },
  );
  const flushCompletions = Effect.fn("ThreadExecutionRelay.flushCompletions")(function* () {
    for (const pending of yield* fence.pendingCompletionReports()) {
      const placement = yield* getPlacement(pending.threadId);
      if (!placement || placement.generation !== pending.generation)
        return yield* new ThreadExecutionFenceError({
          threadId: pending.threadId,
          detail: "An old execution completion still needs reconciliation.",
        });
      yield* authority.complete({ ...placement, ...pending });
      yield* fence.acknowledgeWork(pending);
    }
  });
  const wasStarted = Effect.fn("ThreadExecutionRelay.wasStarted")(function* (
    input: ThreadWorkIdentity,
  ) {
    const work = yield* current(input);
    if (!work) return false;
    return (yield* fence.getWork(work))?.started === 1;
  });
  const assertAccepting = Effect.fn("ThreadExecutionRelay.assertAccepting")(function* (
    threadId: string,
  ) {
    yield* fence.assertCheckoutAvailable({ threadId });
    const placement = yield* getPlacement(threadId);
    if (placement && placement.phase !== "active")
      return yield* new ThreadExecutionFenceError({
        threadId,
        detail: "The thread is moving or no longer accepts execution on this environment.",
      });
  });
  // Input can start new subprocesses in an already-open shell. Serialize its
  // synchronous delivery against the local ownership transition as well.
  const withActiveWork = <A, E, R>(input: ThreadWorkIdentity, effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* assertAccepting(input.threadId);
        const work = yield* current(input);
        if (work) {
          const prior = yield* fence.getWork(work);
          if (!prior?.started || prior.completed)
            return yield* new ThreadExecutionFenceError({
              threadId: input.threadId,
              detail:
                "This process has no current execution permission. Reconcile it before sending input.",
            });
        }
        return yield* effect;
      }),
    );
  return {
    begin,
    confirmStopped,
    confirmProcessesStopped,
    flushCompletions,
    wasStarted,
    assertAccepting,
    withActiveWork,
  };
}
