import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import {
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  ThreadId,
  TerminalHistoryError,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  CleanupProcessProbe,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("ThreadDeletionReactor drain", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-deletion-reactor-drain");
  const deletedEvent = (
    sequence: number,
  ): Extract<OrchestrationEvent, { type: "thread.deleted" }> => ({
    sequence,
    eventId: EventId.make(`evt-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${sequence}`),
    metadata: {},
    payload: { threadId, deletedAt: now },
  });
  effectIt.effect(
    "startup never acknowledges a buffered deletion before installing its cleanup fence",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const stopping = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let heads = 0;
        let captures = 0;
        const layer = ThreadDeletionReactorLive.pipe(
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(WorktreeSetupTracker.layer),
          Layer.provide(
            Layer.mock(OrchestrationEngineService, {
              latestSequence: Effect.gen(function* () {
                if (++heads === 1) return 0;
                yield* sql`INSERT INTO thread_cleanup_fences (thread_id, deletion_sequence) VALUES (${threadId}, 1)`;
                yield* PubSub.publish(events, deletedEvent(1));
                return 1;
              }).pipe(Effect.orDie),
              subscribeDomainEvents: PubSub.subscribe(events).pipe(
                Effect.map(Stream.fromSubscription),
              ),
            }),
          ),
          Layer.provide(Layer.mock(ProviderService, { stopSession: () => Effect.void })),
          Layer.provide(
            Layer.mock(TerminalManager.TerminalManager, {
              captureCleanup: () =>
                Effect.sync(() => {
                  captures++;
                  return {
                    processIds: [123],
                    stop: Deferred.succeed(stopping, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  };
                }),
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* Deferred.await(stopping);
            const drain = yield* reactor
              .drainThrough(1, threadId)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            expect(drain.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(drain);
            expect(captures).toBe(1);
            expect(yield* sql`SELECT * FROM thread_cleanup_fences`).toEqual([]);
          }).pipe(Effect.provide(layer)),
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect(
    "retains restart fences until captured PIDs are absent; unknown ownership stays blocked",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thread_cleanup_fences (thread_id, deletion_sequence, process_ids_json) VALUES (${threadId}, 10, '[123]'), ('unknown', 9, NULL)`;
        let absent = false;
        let probes = 0;
        const purged: string[] = [];
        let historyFailure = true;
        const layer = ThreadDeletionReactorLive.pipe(
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(WorktreeSetupTracker.layer),
          Layer.provide(
            Layer.mock(OrchestrationEngineService, {
              latestSequence: Effect.succeed(10),
              subscribeDomainEvents: Effect.succeed(Stream.never),
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderService, {
              stopSession: () => Effect.die("must not stop recovered resources by ID"),
            }),
          ),
          Layer.provide(
            Layer.mock(TerminalManager.TerminalManager, {
              captureCleanup: () => Effect.die("must not capture replacement handles"),
              deleteHistory: (id) =>
                Effect.suspend(() => {
                  if (historyFailure)
                    return Effect.fail(
                      new TerminalHistoryError({
                        operation: "delete",
                        threadId: id,
                        terminalId: "default",
                        cause: "disk unavailable",
                      }),
                    );
                  purged.push(id);
                  return Effect.void;
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(CleanupProcessProbe, {
              absent: () =>
                Effect.sync(() => {
                  probes++;
                  return absent;
                }),
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            expect(yield* reactor.drainThrough(10, threadId).pipe(Effect.isFailure)).toBe(true);
            expect(
              (yield* sql`SELECT * FROM thread_cleanup_fences WHERE thread_id = ${threadId}`)
                .length,
            ).toBe(1);
          }).pipe(Effect.provide(layer)),
        );
        expect(purged).toEqual([]);
        absent = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            expect(yield* reactor.drainThrough(10, threadId).pipe(Effect.isFailure)).toBe(true);
            expect(
              (yield* sql`SELECT * FROM thread_cleanup_fences WHERE thread_id = ${threadId}`)
                .length,
            ).toBe(1);
          }).pipe(Effect.provide(layer)),
        );
        historyFailure = false;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* reactor.drainThrough(10, threadId);
            expect(
              (yield* sql`SELECT * FROM thread_cleanup_fences WHERE thread_id = ${threadId}`)
                .length,
            ).toBe(0);
            expect(
              yield* reactor.drainThrough(10, ThreadId.make("unknown")).pipe(Effect.isFailure),
            ).toBe(true);
          }).pipe(Effect.provide(layer)),
        );
        expect(probes).toBeGreaterThan(0);
        expect(purged).toEqual([threadId]);
        expect((yield* sql`SELECT * FROM thread_cleanup_fences`).length).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect(
    "failed capture persistence cannot release cleanup and concurrent drains retry captured handles once",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const captured = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        let captures = 0;
        let stops = 0;
        yield* sql`CREATE TRIGGER deny_cleanup_capture BEFORE UPDATE ON thread_cleanup_fences BEGIN SELECT RAISE(ABORT, 'capture denied'); END`;
        const layer = ThreadDeletionReactorLive.pipe(
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(WorktreeSetupTracker.layer),
          Layer.provide(
            Layer.mock(OrchestrationEngineService, {
              latestSequence: Effect.succeed(0),
              subscribeDomainEvents: PubSub.subscribe(events).pipe(
                Effect.map(Stream.fromSubscription),
              ),
            }),
          ),
          Layer.provide(Layer.mock(ProviderService, { stopSession: () => Effect.void })),
          Layer.provide(
            Layer.mock(TerminalManager.TerminalManager, {
              captureCleanup: () =>
                Effect.gen(function* () {
                  captures++;
                  yield* Deferred.succeed(captured, undefined);
                  return {
                    processIds: [123],
                    stop: Effect.gen(function* () {
                      stops++;
                      yield* Deferred.succeed(stopping, undefined);
                      yield* Deferred.await(stopped);
                    }),
                  };
                }),
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* ThreadDeletionReactor;
            yield* reactor.start();
            yield* PubSub.publish(events, deletedEvent(1));
            yield* Deferred.await(captured);
            expect(yield* reactor.drainThrough(1, threadId).pipe(Effect.isFailure)).toBe(true);
            expect(stops).toBe(0);
            expect(yield* sql`SELECT process_ids_json FROM thread_cleanup_fences`).toEqual([
              { process_ids_json: null },
            ]);
            yield* sql`DROP TRIGGER deny_cleanup_capture`;
            const first = yield* reactor.drainThrough(1, threadId).pipe(Effect.forkScoped);
            yield* Deferred.await(stopping);
            const second = yield* reactor.drainThrough(1, threadId).pipe(Effect.forkScoped);
            yield* Deferred.succeed(stopped, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            expect(captures).toBe(1);
            expect(stops).toBe(1);
            expect(yield* sql`SELECT * FROM thread_cleanup_fences`).toEqual([]);
          }).pipe(Effect.provide(layer)),
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("retains a failed strict-stop fence without blocking another task", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const closeStarted = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      const otherId = ThreadId.make("unrelated-thread");
      const closes: ThreadId[] = [];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(WorktreeSetupTracker.layer),
        Layer.provide(
          Layer.mock(OrchestrationEngineService, {
            latestSequence: Effect.succeed(0),
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
        Layer.provide(Layer.mock(ProviderService, { stopSession: () => Effect.void })),
        Layer.provide(
          Layer.mock(TerminalManager.TerminalManager, {
            captureCleanup: (capturedThreadId) =>
              Effect.succeed({
                processIds: [123],
                stop: Effect.gen(function* () {
                  closes.push(ThreadId.make(capturedThreadId));
                  if (capturedThreadId !== threadId) return;
                  yield* Deferred.succeed(closeStarted, undefined);
                  yield* Deferred.await(releaseClose);
                  return yield* Effect.die(new Error("Signal denied"));
                }),
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* PubSub.publish(events, deletedEvent(1));
        yield* Deferred.await(closeStarted);
        yield* PubSub.publish(events, {
          ...deletedEvent(2),
          aggregateId: otherId,
          payload: { threadId: otherId, deletedAt: now },
        });
        yield* reactor.drainThrough(2, otherId);
        expect(closes).toEqual([threadId, otherId]);
        yield* Deferred.succeed(releaseClose, undefined);
        const failed = yield* Effect.exit(reactor.drainThrough(2, threadId));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(reactor.drainThrough(2, threadId)))).toBe(true);
        yield* reactor.drainThrough(2, otherId);
        // Retries use the captured stop closure; no replacement lookup occurs.
        expect(closes).toEqual([threadId, otherId, threadId, threadId]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  effectIt.effect("waits for a published deletion the subscriber has not consumed yet", () =>
    Effect.gen(function* () {
      const stops: Array<number> = [];
      const firstCleanupDone = yield* Deferred.make<void>();
      // The engine has already committed and published sequence 2, but the
      // subscriber has not received it yet: the stream releases it on demand.
      const releaseSecondEvent = yield* Deferred.make<void>();
      const latestSequence = yield* Ref.make(0);
      const events = Stream.concat(
        Stream.make(deletedEvent(1)),
        Stream.fromEffect(Deferred.await(releaseSecondEvent)).pipe(
          Stream.map(() => deletedEvent(2)),
        ),
      );
      const engine = {
        latestSequence: Ref.get(latestSequence),
        streamDomainEvents: events,
        subscribeDomainEvents: Effect.succeed(events),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () =>
          Effect.gen(function* () {
            stops.push(stops.length + 1);
            if (stops.length === 1) {
              yield* Deferred.succeed(firstCleanupDone, undefined);
            }
          }),
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        captureCleanup: () => Effect.succeed({ processIds: [], stop: Effect.void }),
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(WorktreeSetupTracker.layer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(firstCleanupDone);

          // Sequence 1 is fully cleaned and the worker queue is idle. Sequence
          // 2 is committed and published but still in flight to the subscriber.
          yield* Ref.set(latestSequence, 2);
          const drained = yield* Effect.forkChild(reactor.drainThrough(2));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(stops).toEqual([1]);
          expect(drained.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseSecondEvent, undefined);
          yield* Fiber.join(drained);
          expect(stops).toEqual([1, 2]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
