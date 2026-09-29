import { WorktreeSetupTracker } from "../../project/WorktreeSetupTracker.ts";
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  ThreadCleanupError,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logDebug(message, {
          threadId,
          cause: Cause.pretty(cause),
        }),
    ),
  );

/** A presence probe, never a signal to terminate a PID recovered from disk. */
export const CleanupProcessProbe = Context.Reference<{
  readonly absent: (pid: number) => Effect.Effect<boolean>;
}>("t3/orchestration/CleanupProcessProbe", {
  defaultValue: () => ({
    absent: (pid) =>
      Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (cause) {
          return Schema.is(Schema.Struct({ code: Schema.Literals(["ESRCH"]) }))(cause);
        }
      }),
  }),
});

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const setups = yield* WorktreeSetupTracker;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const sql = yield* SqlClient.SqlClient;
  const probe = yield* CleanupProcessProbe;
  const scope = yield* Scope.Scope;
  const encodePids = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)));
  const decodePids = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)));
  type Fence = {
    readonly threadId: ThreadId;
    readonly sequence: number;
    readonly processIds: string | null;
  };
  type Job = {
    readonly threadId: ThreadId;
    readonly initial: Deferred.Deferred<void, ThreadCleanupError>;
    readonly retry: Effect.Effect<void, ThreadCleanupError>;
  };
  const jobs = new Map<string, Job>();
  const cleanupError = (threadId: ThreadId, cause: unknown) =>
    new ThreadCleanupError({
      threadId,
      message: `Task cleanup cannot confirm process exit. ${String(cause)}`,
    });
  const readFences = (
    threadId?: ThreadId,
  ) => sql<Fence>`SELECT thread_id AS "threadId", deletion_sequence AS "sequence", process_ids_json AS "processIds"
    FROM thread_cleanup_fences WHERE ${threadId === undefined ? sql`1 = 1` : sql`thread_id = ${threadId}`} ORDER BY deletion_sequence`;
  const clear = (fence: Fence) =>
    sql`DELETE FROM thread_cleanup_fences WHERE thread_id = ${fence.threadId} AND deletion_sequence = ${fence.sequence}`;
  const recoverStored = (fence: Fence) =>
    Effect.gen(function* () {
      if (fence.processIds === null)
        return yield* cleanupError(
          fence.threadId,
          "The previous server stopped before recording process ownership. Cleanup remains blocked; no process was stopped by an unverified PID.",
        );
      const pids = yield* decodePids(fence.processIds);
      for (const pid of pids)
        if (!(yield* probe.absent(pid)))
          return yield* cleanupError(
            fence.threadId,
            "A captured process ID is still present or could not be inspected. Cleanup remains blocked.",
          );
      yield* terminalManager.deleteHistory(fence.threadId);
      yield* clear(fence);
    }).pipe(Effect.mapError((cause) => cleanupError(fence.threadId, cause)));

  const install = Effect.fn("ThreadDeletionReactor.install")(function* (
    fence: Fence,
    live: boolean,
  ) {
    const key = `${fence.threadId}:${fence.sequence}`;
    if (jobs.has(key)) return;
    const initial = yield* Deferred.make<void, ThreadCleanupError>();
    const mutex = yield* Semaphore.make(1);
    let completed = false;
    let captured:
      | {
          readonly processIds: ReadonlyArray<number>;
          readonly stop: Effect.Effect<void, TerminalManager.TerminalError>;
        }
      | undefined;
    const retry = mutex
      .withPermit(
        Effect.gen(function* () {
          if (completed) return;
          if (!live) yield* recoverStored(fence);
          else {
            yield* sql`INSERT OR IGNORE INTO thread_cleanup_fences (thread_id, deletion_sequence) VALUES (${fence.threadId}, ${fence.sequence})`;
            // Capture once. A later drain retries these exact handles, never a replacement by ID.
            captured ??= yield* terminalManager.captureCleanup(fence.threadId);
            const encoded = yield* encodePids(captured.processIds);
            yield* sql`UPDATE thread_cleanup_fences SET process_ids_json = ${encoded}
          WHERE thread_id = ${fence.threadId} AND deletion_sequence = ${fence.sequence}`;
            yield* captured.stop;
            yield* clear(fence);
          }
          completed = true;
          jobs.delete(key);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.fail(cleanupError(fence.threadId, Cause.pretty(cause))),
        ),
      );
    jobs.set(key, { threadId: fence.threadId, initial, retry });
    yield* Effect.gen(function* () {
      if (live) {
        // New producers must pass this fence before registering another setup/session.
        yield* setups.cancel(fence.threadId);
        yield* logCleanupCauseUnlessInterrupted({
          effect: providerService.stopSession({ threadId: fence.threadId }),
          message: "thread deletion cleanup skipped provider session stop",
          threadId: fence.threadId,
        });
      }
      yield* retry;
    }).pipe(
      Effect.catchCause((cause) => Effect.fail(cleanupError(fence.threadId, Cause.pretty(cause)))),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(initial, exit)),
      Effect.forkIn(scope),
    );
  });

  const enqueue = (event: ThreadDeletedEvent) =>
    install({ threadId: event.payload.threadId, sequence: event.sequence, processIds: null }, true);
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));
  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    const startupHead = yield* orchestrationEngine.latestSequence;
    const events = yield* orchestrationEngine.subscribeDomainEvents;
    const head = yield* orchestrationEngine.latestSequence;
    // Register every durable deletion through this head before acknowledging it.
    // A commit between the first head and subscription is recovered from SQL.
    const fences = yield* readFences().pipe(Effect.orDie);
    for (const fence of fences) yield* install(fence, fence.sequence > startupHead);
    const reconciledHead = Math.max(head, ...fences.map((fence) => fence.sequence));
    yield* noteSeen(reconciledHead);
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.sequence <= reconciledHead
          ? Effect.void
          : event.type === "thread.deleted"
            ? enqueue(event)
            : Effect.void
        ).pipe(Effect.andThen(noteSeen(event.sequence))),
      ),
    );
  });
  const drainThrough: ThreadDeletionReactorShape["drainThrough"] = Effect.fn(
    "ThreadDeletionReactor.drainThrough",
  )(function* (target, threadId) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    const pending = [...jobs.values()].filter(
      (job) => threadId === undefined || job.threadId === threadId,
    );
    for (const job of pending) {
      const result = yield* Deferred.await(job.initial).pipe(Effect.result);
      if (result._tag === "Failure") yield* job.retry;
    }
  });
  return { start, drainThrough } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
