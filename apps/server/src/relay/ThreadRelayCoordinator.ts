import { activateRestoredThreadVm } from "./ThreadVmRestoreActivation.ts";
import { makeThreadPauseWorker } from "./ThreadPauseWorker.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeThreadFinalSaveWorker } from "./ThreadFinalSaveWorker.ts";
import { makeThreadLocalEnrollmentWorker } from "./ThreadLocalEnrollmentWorker.ts";
import { makeThreadMoveWorker } from "./ThreadMoveWorker.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { activateInitialThreadVm } from "./ThreadVmActivation.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeThreadCommandSync } from "./ThreadCommandSync.ts";
import { ThreadExecution } from "./ThreadExecution.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { makeThreadExecutionAuthority } from "./ThreadExecutionAuthority.ts";
import { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import {
  makeThreadVmGitRefresh,
  refreshInstalledThreadVmRepository,
} from "./ThreadVmGitRefresh.ts";

export class ThreadRelayCoordinator extends Context.Service<
  ThreadRelayCoordinator,
  {
    readonly history: ReturnType<typeof makeThreadHistorySync>;
    readonly commands: ReturnType<typeof makeThreadCommandSync>;
    readonly checkpoints: ReturnType<typeof makeThreadCheckpointPublisher>;
    readonly moves: Effect.Success<ReturnType<typeof makeThreadMoveWorker>>;
  }
>()("t3/relay/ThreadRelayCoordinator") {}

/** Reconcile each move independently so one broken transfer cannot strand other threads. */
export const makeThreadMoveSweep = Effect.fn("ThreadRelayCoordinator.makeMoveSweep")(function* (
  authority: Pick<Effect.Success<typeof makeThreadExecutionAuthority>, "discoveryOwner"> & {
    readonly moves: Pick<Effect.Success<typeof makeThreadExecutionAuthority>["moves"], "pending">;
  },
  enrollment: Effect.Success<ReturnType<typeof makeThreadLocalEnrollmentWorker>>,
  moves: Pick<Effect.Success<ReturnType<typeof makeThreadMoveWorker>>, "source" | "destination">,
) {
  const sql = yield* SqlClient.SqlClient;
  // Incoming moves may not have a local thread yet. Discover them through
  // this environment's configured credential, then reconcile local frozen
  // destinations too (a lost activation/abort reply drops them from pending).
  // The parked worker repeats this pass; constructing it must not start reconciliation.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    const discovery = yield* authority.discoveryOwner;
    if (!discovery) return;
    const incoming = new Map<string, import("./ThreadMoveTransport.ts").ThreadMoveOwner>();
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const pending: {
        entries: ReadonlyArray<import("@t3tools/contracts/relay").RelayThreadMove>;
        next: string | null;
      } = yield* authority.moves.pending(discovery, after);
      for (const move of pending.entries)
        if (move.destinationEnvironmentId === discovery.environmentId)
          incoming.set(move.operationId, {
            threadId: move.threadId,
            operationId: move.operationId,
            environmentId: discovery.environmentId,
            generation: move.expectedGeneration + 1,
            relayUrl: discovery.relayUrl,
          });
      if (pending.next === null) break;
      after = pending.next;
    }
    const candidates = yield* sql<{
      threadId: string;
    }>`SELECT q.thread_id AS "threadId" FROM projection_thread_prompt_queues q
      LEFT JOIN thread_execution_fences f USING(thread_id) WHERE (f.phase IS NULL OR f.phase!='retired')
      AND (json_extract(q.state_json,'$.entries[0].kind')='move' OR EXISTS
        (SELECT 1 FROM thread_local_enrollments e WHERE e.thread_id=q.thread_id AND e.phase='pending'))`;
    yield* Effect.forEach(
      candidates,
      ({ threadId }) =>
        enrollment.synchronize(threadId, discovery).pipe(
          Effect.flatMap((ready) => (ready ? moves.source(threadId) : Effect.void)),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Cause.hasDies(cause)
                ? Effect.logWarning("Thread move source reconciliation failed; will retry", {
                    threadId,
                    cause,
                  })
                : Effect.logDebug("Thread move awaiting source confirmation", { threadId }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const local = yield* sql<{
      threadId: string;
    }>`SELECT thread_id AS "threadId" FROM thread_execution_fences
      WHERE phase='frozen' AND generation>1`;
    for (const { threadId } of local) {
      const owner = yield* makeThreadExecutionFence(sql).get(threadId);
      if (
        owner &&
        owner.environmentId === discovery.environmentId &&
        owner.relayUrl === discovery.relayUrl
      )
        incoming.set(owner.operationId, owner);
    }
    yield* Effect.forEach(
      incoming.values(),
      (owner) =>
        moves.destination(owner).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Cause.hasDies(cause)
                ? Effect.logWarning("Thread move destination reconciliation failed; will retry", {
                    threadId: owner.threadId,
                    cause,
                  })
                : Effect.logDebug("Thread move awaiting destination confirmation", {
                    threadId: owner.threadId,
                  }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Cause.hasDies(cause)
          ? Effect.logWarning("Thread move discovery failed; will retry", { cause })
          : Effect.logDebug("Thread move discovery will retry"),
    ),
  );
});

export const layer = Layer.effect(
  ThreadRelayCoordinator,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestrationEngineService;
    const authority = yield* makeThreadExecutionAuthority;
    const history = makeThreadHistorySync(sql, engine, authority.history);
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const checkpointContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const checkpoints = makeThreadCheckpointPublisher(
      sql,
      authority.checkpoints,
      path.join(config.stateDir, "checkpoint-transfers"),
      yield* OrchestrationEventStore,
    );
    const receipts = yield* OrchestrationCommandReceiptRepository;
    const normalizerContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof normalizeDispatchCommand>>>();
    const restoreActivationContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof activateRestoredThreadVm>>>();
    const activationContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof activateInitialThreadVm>>>();
    const gitContext =
      yield* Effect.context<Effect.Services<typeof refreshInstalledThreadVmRepository>>();
    const execution = yield* ThreadExecution;
    const commands = makeThreadCommandSync(
      sql,
      engine,
      receipts,
      execution,
      authority.commands,
      (command, authenticatedUserId) =>
        normalizeDispatchCommand(command, authenticatedUserId).pipe(
          Effect.provideContext(normalizerContext),
        ),
    );

    const moves = yield* makeThreadMoveWorker(authority.moves, history, commands);
    const enrollment = yield* makeThreadLocalEnrollmentWorker(authority.enrollment, history);
    const pauses = yield* makeThreadPauseWorker(authority.pauses, history, checkpoints);
    const finalSaves = yield* makeThreadFinalSaveWorker(authority.finalSaves, history, checkpoints);
    // The durable cursor is the retry queue. Each pass is bounded by an engine head;
    // a disconnected relay neither discards history nor blocks another thread.
    const sweep = Effect.gen(function* () {
      yield* execution
        .flushCompletions()
        .pipe(
          Effect.catch(() =>
            Effect.logDebug("Portable execution completions awaiting relay acknowledgement"),
          ),
        );
      const owners = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
      FROM thread_execution_fences WHERE phase != 'retired'`;
      yield* Effect.forEach(
        owners,
        (owner) =>
          history.synchronize(owner.threadId).pipe(
            Effect.catch(() =>
              Effect.logDebug("Portable thread history awaiting relay acknowledgement", {
                threadId: owner.threadId,
              }),
            ),
            Effect.andThen(
              activateRestoredThreadVm(owner.threadId).pipe(
                Effect.provideContext(restoreActivationContext),
                Effect.catch(() =>
                  Effect.logDebug("Restored VM awaiting setup or relay confirmation", {
                    threadId: owner.threadId,
                  }),
                ),
              ),
            ),
            Effect.andThen(
              activateInitialThreadVm(owner.threadId).pipe(
                Effect.provideContext(activationContext),
                Effect.catch(() =>
                  Effect.logDebug("VM execution awaiting relay confirmation", {
                    threadId: owner.threadId,
                  }),
                ),
              ),
            ),
            Effect.andThen(
              commands.synchronize(owner.threadId).pipe(
                Effect.catch(() =>
                  Effect.logDebug("Portable command delivery will retry", {
                    threadId: owner.threadId,
                  }),
                ),
              ),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }).pipe(Effect.catch(() => Effect.logDebug("Portable thread history sweep will retry")));
    // A checkpoint can transfer hundreds of megabytes. Its own parked worker
    // keeps inbox delivery and execution acknowledgements independent of storage.
    const checkpointSweep = Effect.gen(function* () {
      const owners = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
        FROM thread_execution_fences WHERE phase != 'retired'`;
      yield* Effect.forEach(
        owners,
        (owner) =>
          checkpoints.synchronize(owner.threadId).pipe(
            Effect.provideContext(checkpointContext),
            Effect.catch(() =>
              Effect.logDebug("Portable checkpoints awaiting relay acknowledgement", {
                threadId: owner.threadId,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.catch(() => Effect.logDebug("Portable checkpoint sweep will retry")));
    const moveSweep = yield* makeThreadMoveSweep(authority, enrollment, moves);
    const gitSweep = makeThreadVmGitRefresh(
      refreshInstalledThreadVmRepository.pipe(Effect.provideContext(gitContext)),
    );
    const finalSaveSweep = Effect.gen(function* () {
      const vm = yield* readInstalledThreadVm();
      if (!vm) return;
      const owners = yield* sql<{
        threadId: string;
      }>`SELECT thread_id AS "threadId" FROM thread_execution_fences
        WHERE phase!='retired' AND thread_id=${vm.scope.threadId} AND generation=${vm.scope.generation}`;
      yield* Effect.forEach(
        owners,
        ({ threadId }) =>
          pauses.synchronize(threadId).pipe(
            Effect.andThen(finalSaves.synchronize(threadId)),
            Effect.provideContext(checkpointContext),
            Effect.catch(() =>
              Effect.logDebug("Final VM save awaiting stopped source and retained recovery", {
                threadId,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.catch(() => Effect.logDebug("Final VM save discovery will retry")));
    yield* forkParked(finalSaveSweep.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
    yield* forkParked(gitSweep.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
    yield* forkParked(moveSweep.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
    yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
    yield* forkParked(checkpointSweep.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
    return { history, commands, checkpoints, moves };
  }),
);
