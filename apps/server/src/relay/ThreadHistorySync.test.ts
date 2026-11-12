import { assert, describe, it } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadHistorySync, ThreadHistorySyncError } from "./ThreadHistorySync.ts";

const enrollment = {
  threadId: "thread",
  projectId: "project",
  environmentId: "environment",
  relayUrl: "https://relay.test",
  generation: 1,
  operationId: "enroll",
};
const historyEvent = (sequence: number): OrchestrationEvent => ({
  type: "thread.archived",
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread"),
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  occurredAt: "2026-10-02T06:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread"),
    archivedAt: "2026-10-02T06:00:00.000Z",
    updatedAt: "2026-10-02T06:00:00.000Z",
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fences = makeThreadExecutionFence(sql);
  yield* fences.prepare(enrollment);
  yield* fences.activate(enrollment);
  const events = [historyEvent(2), historyEvent(8), historyEvent(11)];
  const engine = {
    latestSequence: Effect.succeed(8),
    readThreadEvents: (range: { fromSequenceExclusive: number; toSequenceInclusive: number }) =>
      Stream.fromIterable(
        events.filter(
          (event) =>
            event.sequence > range.fromSequenceExclusive &&
            event.sequence <= range.toSequenceInclusive,
        ),
      ),
  };
  const cursor = sql<{
    sequence: number;
  }>`SELECT source_sequence AS sequence FROM thread_relay_history_cursors WHERE thread_id = 'thread'`;
  return { sql, fences, events, engine, cursor };
});
describe("portable thread history sync", () => {
  it.effect(
    "retries the same immutable event after a lost reply and resumes from the durable cursor",
    () =>
      Effect.gen(function* () {
        const { sql, engine, cursor } = yield* fixture;
        const remote = new Map<number, OrchestrationEvent>();
        const attempts: number[] = [];
        const scans: number[] = [];
        let loseReply = true;
        const transport = {
          append: (_owner: unknown, event: OrchestrationEvent) =>
            Effect.gen(function* () {
              attempts.push(event.sequence);
              const prior = remote.get(event.sequence);
              if (prior) assert.deepEqual(prior, event);
              remote.set(event.sequence, event);
              if (event.sequence === 8 && loseReply) {
                loseReply = false;
                return yield* new ThreadHistorySyncError({
                  threadId: "thread",
                  detail: "Lost reply",
                });
              }
            }),
          confirmThrough: (_owner: unknown, sourceSequence: number) =>
            Effect.sync(() => {
              scans.push(sourceSequence);
            }),
        };
        const sync = makeThreadHistorySync(sql, engine, transport);
        yield* Effect.flip(sync.synchronize("thread"));
        assert.deepEqual(yield* cursor, [{ sequence: 2 }]);
        yield* makeThreadHistorySync(sql, engine, transport).synchronize("thread");
        assert.deepEqual(yield* cursor, [{ sequence: 8 }]);
        assert.deepEqual(attempts, [2, 8, 8]);
        assert.deepEqual(scans, [8]);
        assert.equal(remote.size, 2);
        yield* sync.synchronize("ordinary");
        assert.lengthOf(attempts, 3);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "never advances an old generation's cursor after an ownership change during upload",
    () =>
      Effect.gen(function* () {
        const { sql, engine, cursor } = yield* fixture;
        const sync = makeThreadHistorySync(sql, engine, {
          append: () =>
            sql`UPDATE thread_execution_fences SET generation = 2 WHERE thread_id = 'thread'`.pipe(
              Effect.orDie,
              Effect.asVoid,
            ),
          confirmThrough: () => Effect.void,
        });
        assert.equal(
          (yield* Effect.flip(sync.synchronize("thread")))._tag,
          "ThreadHistorySyncError",
        );
        assert.deepEqual(yield* cursor, []);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("confirms a scan through gaps created by other threads", () =>
    Effect.gen(function* () {
      const { sql, engine, cursor } = yield* fixture;
      const uploaded: number[] = [];
      const scans: number[] = [];
      const sync = makeThreadHistorySync(
        sql,
        { ...engine, latestSequence: Effect.succeed(30) },
        {
          append: (_owner, event) =>
            Effect.sync(() => {
              uploaded.push(event.sequence);
            }),
          confirmThrough: (_owner, through) =>
            Effect.sync(() => {
              scans.push(through);
            }),
        },
      );
      yield* sync.synchronize("thread");
      assert.deepEqual(uploaded, [2, 8, 11]);
      assert.deepEqual(scans, [30]);
      assert.deepEqual(yield* cursor, [{ sequence: 30 }]);
      yield* sync.synchronize("thread");
      assert.deepEqual(uploaded, [2, 8, 11]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("retries a lost scan confirmation without replaying already acknowledged events", () =>
    Effect.gen(function* () {
      const { sql, engine, cursor } = yield* fixture;
      const uploaded: number[] = [];
      let loseReply = true;
      const sync = makeThreadHistorySync(
        sql,
        { ...engine, latestSequence: Effect.succeed(30) },
        {
          append: (_owner, event) =>
            Effect.sync(() => {
              uploaded.push(event.sequence);
            }),
          confirmThrough: () =>
            Effect.gen(function* () {
              if (loseReply) {
                loseReply = false;
                return yield* new ThreadHistorySyncError({
                  threadId: "thread",
                  detail: "Lost scan acknowledgement",
                });
              }
            }),
        },
      );
      assert.equal((yield* Effect.flip(sync.synchronize("thread")))._tag, "ThreadHistorySyncError");
      assert.deepEqual(yield* cursor, [{ sequence: 11 }]);
      yield* sync.synchronize("thread");
      assert.deepEqual(uploaded, [2, 8, 11]);
      assert.deepEqual(yield* cursor, [{ sequence: 30 }]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("stops a frozen source at its captured thread head", () =>
    Effect.gen(function* () {
      const { sql, engine, cursor } = yield* fixture;
      yield* sql`UPDATE thread_execution_fences SET phase = 'frozen', frozen_sequence = 8
        WHERE thread_id = 'thread'`;
      const uploaded: number[] = [];
      const scans: number[] = [];
      const sync = makeThreadHistorySync(
        sql,
        { ...engine, latestSequence: Effect.succeed(30) },
        {
          append: (_owner, event) =>
            Effect.sync(() => {
              uploaded.push(event.sequence);
            }),
          confirmThrough: (_owner, through) =>
            Effect.sync(() => {
              scans.push(through);
            }),
        },
      );
      yield* sync.synchronize("thread");
      assert.deepEqual(uploaded, [2, 8]);
      assert.deepEqual(scans, [8]);
      assert.deepEqual(yield* cursor, [{ sequence: 8 }]);
      yield* sync.synchronize("thread");
      assert.deepEqual(uploaded, [2, 8]);
      assert.deepEqual(scans, [8, 8]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "does not upload a different thread or reinterpret an earlier generation's cursor",
    () =>
      Effect.gen(function* () {
        const { sql, engine } = yield* fixture;
        let uploads = 0;
        const transport = {
          append: () =>
            Effect.sync(() => {
              uploads++;
            }),
          confirmThrough: () => Effect.void,
        };
        const wrong = { ...historyEvent(2), aggregateId: ThreadId.make("other") };
        const sync = makeThreadHistorySync(
          sql,
          { ...engine, readThreadEvents: () => Stream.make(wrong) },
          transport,
        );
        assert.equal(
          (yield* Effect.flip(sync.synchronize("thread")))._tag,
          "ThreadHistorySyncError",
        );
        yield* sql`INSERT INTO thread_relay_history_cursors VALUES ('thread', 2, 2)`;
        assert.equal(
          (yield* Effect.flip(makeThreadHistorySync(sql, engine, transport).synchronize("thread")))
            ._tag,
          "ThreadHistorySyncError",
        );
        assert.equal(uploads, 0);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
