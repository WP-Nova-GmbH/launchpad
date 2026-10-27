// @effect-diagnostics nodeBuiltinImport:off - Native path normalization; filesystem resolution is supplied by the caller.
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";
import { CheckoutAdmission, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";

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
  options?: {
    readonly canonicalizeRoot?: (
      root: string,
    ) => Effect.Effect<string, import("effect/PlatformError").PlatformError>;
  },
) {
  const fence = makeThreadExecutionFence(sql);
  const captures = makeCheckoutCapture(sql);
  const readRoot = (threadId: string) => sql<{ root: string }>`
    SELECT COALESCE(t.worktree_path,p.workspace_root) AS root FROM projection_threads t
    JOIN projection_projects p USING(project_id) WHERE t.thread_id=${threadId}
      AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
  const prepareScope = Effect.fnUntraced(function* (threadId: string) {
    const [binding] = yield* readRoot(threadId);
    if (!binding)
      return yield* new ThreadExecutionFenceError({
        threadId,
        detail: "The thread has no current checkout binding.",
      });
    const checkoutRoot = yield* (
      options?.canonicalizeRoot?.(binding.root) ?? Effect.succeed(NodePath.resolve(binding.root))
    ).pipe(
      Effect.mapError(
        () =>
          new ThreadExecutionFenceError({
            threadId,
            detail: "The thread checkout could not be resolved.",
          }),
      ),
    );
    return { root: binding.root, checkoutRoot, gitCommonRoot: checkoutRoot };
  });
  const recheckScope = Effect.fnUntraced(function* (
    threadId: string,
    prepared: { readonly root: string },
  ) {
    const [binding] = yield* readRoot(threadId);
    if (binding?.root !== prepared.root)
      return yield* new ThreadExecutionFenceError({
        threadId,
        detail: "The thread checkout changed during execution admission.",
      });
  });
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
    const scope = yield* prepareScope(input.threadId);
    const parentAdmissionId = yield* CheckoutAdmission;
    if (!work)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* recheckScope(input.threadId, scope);
          if (yield* current(input))
            return yield* new ThreadExecutionFenceError({
              threadId: input.threadId,
              detail: "Thread ownership changed during execution admission.",
            });
          const admitted = yield* captures.admit({
            ...input,
            ...scope,
            ...(parentAdmissionId ? { parentAdmissionId } : {}),
          });
          return admitted.decision === "start" ? ("ordinary" as const) : admitted.decision;
        }),
      );
    const prior = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* recheckScope(input.threadId, scope);
        const admitted = yield* captures.admit({
          ...input,
          ...scope,
          ...(parentAdmissionId ? { parentAdmissionId } : {}),
        });
        // Enrollment cannot turn an existing ordinary receipt into another
        // execution. Only an existing portable reservation can resume its handshake.
        if (admitted.decision !== "start" && !(yield* fence.getWork(work)))
          return admitted.decision;
        const reserved = yield* fence.reserveWork(work);
        if (admitted.retrying && reserved.completed) yield* captures.complete(admitted.admissionId);
        if (admitted.retrying && reserved.started && !reserved.completed) {
          const placement = yield* getPlacement(input.threadId);
          if (placement?.phase !== "active")
            return yield* new ThreadExecutionFenceError({
              threadId: input.threadId,
              detail: "The thread is not accepting a rejected invocation retry here.",
            });
          // The relay lease remains outstanding. Only the durable negative
          // dispatch receipt permits reusing it without replaying uncertain work.
          return "start" as const;
        }
        return reserved;
      }),
    );
    if (typeof prior === "string") return prior;
    if (prior.completed) return "completed" as const;
    if (prior.started) return "reconcile" as const;
    const grant = yield* authority.admit(work);
    if (grant.completed) {
      yield* fence.completeWork(work);
      yield* captures.complete(captures.admissionId(input));
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
    if (!work) return yield* captures.complete(captures.admissionId(input));
    const prior = yield* fence.getWork(work);
    if (!prior)
      return yield* new ThreadExecutionFenceError({
        threadId: input.threadId,
        detail: "Cannot complete work without its local execution identity.",
      });
    // Persist positive local evidence before networking. A lost acknowledgement can
    // then be retried after restart without rerunning or re-inspecting the tool.
    yield* fence.completeWork(work);
    yield* captures.complete(captures.admissionId(input));
    if (!prior.relayCompleted) {
      yield* authority.complete(work);
      yield* fence.acknowledgeWork(work);
    }
  });
  // An ordinary PTY may exit after its thread enrolls. Its original local
  // admission still settles, without claiming portable workload completion.
  const confirmOrdinaryStopped = Effect.fn("ThreadExecutionRelay.confirmOrdinaryStopped")(
    function* (input: ThreadWorkIdentity) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const portable = yield* sql`SELECT 1 FROM thread_execution_work
          WHERE thread_id=${input.threadId} AND work_id=${`${input.kind}:${input.workId}`} LIMIT 1`;
          const admitted = yield* captures.getAdmission(captures.admissionId(input));
          if (portable.length || !admitted)
            return yield* new ThreadExecutionFenceError({
              threadId: input.threadId,
              detail: "This process has no ordinary execution admission to complete.",
            });
          yield* captures.complete(admitted.admissionId);
        }),
      );
    },
  );
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
    const admitted = yield* captures.getAdmission(captures.admissionId(input));
    if (admitted?.rejected) return false;
    if (!work) return admitted !== null;
    return (yield* fence.getWork(work))?.started === 1;
  });
  const assertAccepting = Effect.fn("ThreadExecutionRelay.assertAccepting")(function* (
    threadId: string,
  ) {
    const scope = yield* prepareScope(threadId);
    const parentAdmissionId = yield* CheckoutAdmission;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* recheckScope(threadId, scope);
        yield* fence.assertCheckoutAvailable({ threadId });
        const placement = yield* getPlacement(threadId);
        if (placement && placement.phase !== "active")
          return yield* new ThreadExecutionFenceError({
            threadId,
            detail: "The thread is moving or no longer accepts execution on this environment.",
          });
        yield* captures.assertAccepting(scope, parentAdmissionId ? { parentAdmissionId } : {});
      }),
    );
  });
  // Input can start new subprocesses in an already-open shell. Serialize its
  // synchronous delivery against the local ownership transition as well.
  const withActiveWork = Effect.fnUntraced(function* <A, E, R>(
    input: ThreadWorkIdentity,
    effect: Effect.Effect<A, E, R>,
  ) {
    const scope = yield* prepareScope(input.threadId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* recheckScope(input.threadId, scope);
        yield* fence.assertCheckoutAvailable({ threadId: input.threadId });
        const placement = yield* getPlacement(input.threadId);
        if (placement && placement.phase !== "active")
          return yield* new ThreadExecutionFenceError({
            threadId: input.threadId,
            detail: "This thread no longer accepts process input here.",
          });
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
        const admitted = yield* captures.getAdmission(captures.admissionId(input));
        if (!admitted || admitted.completed)
          return yield* new ThreadExecutionFenceError({
            threadId: input.threadId,
            detail: "This process has no active local execution admission.",
          });
        yield* captures.assertAccepting(scope, { parentAdmissionId: admitted.admissionId });
        return yield* effect;
      }),
    );
  });
  const bindTurn = Effect.fnUntraced(function* (input: ThreadWorkIdentity, turnId: string) {
    yield* current(input);
    yield* captures.bindTurn(captures.admissionId(input), turnId);
  });
  const completeInvocation = Effect.fnUntraced(function* (input: ThreadWorkIdentity) {
    if (input.kind !== "provider") return;
    yield* current(input);
    const admitted = yield* captures.getAdmission(captures.admissionId(input));
    if (admitted && admitted.turnId === null) yield* captures.complete(admitted.admissionId);
  });
  const rejectInvocation = Effect.fnUntraced(function* (input: ThreadWorkIdentity) {
    if (input.kind !== "provider") return;
    yield* current(input);
    yield* captures.reject(captures.admissionId(input));
  });
  return {
    begin,
    confirmStopped,
    confirmOrdinaryStopped,
    confirmProcessesStopped,
    flushCompletions,
    wasStarted,
    assertAccepting,
    withActiveWork,
    bindTurn,
    completeInvocation,
    rejectInvocation,
    completeTurn: captures.completeTurn,
    activeAdmission: captures.activeAdmission,
    admissionId: captures.admissionId,
    lookupAdmission: captures.lookupAdmission,
  };
}
