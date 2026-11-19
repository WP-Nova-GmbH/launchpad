import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

export class ThreadHistorySyncError extends Schema.TaggedError<ThreadHistorySyncError>()(
  "ThreadHistorySyncError",
  { threadId: Schema.String, detail: Schema.String },
) {}
export interface ThreadHistoryOwner {
  readonly threadId: string;
  readonly environmentId: string;
  readonly relayUrl: string;
  readonly generation: number;
}
export interface ThreadHistoryTransport {
  readonly append: (
    owner: ThreadHistoryOwner,
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ThreadHistorySyncError>;
  readonly confirmThrough: (
    owner: ThreadHistoryOwner,
    sourceSequence: number,
  ) => Effect.Effect<void, ThreadHistorySyncError>;
}

/** Upload immutable events before advancing the local cursor. Lost replies replay the same source identity. */
export function makeThreadHistorySync(
  sql: SqlClient.SqlClient,
  engine: Pick<OrchestrationEngineShape, "latestSequence" | "readThreadEvents">,
  transport: ThreadHistoryTransport,
) {
  const fences = makeThreadExecutionFence(sql);
  const fail = (threadId: string, detail: string) =>
    new ThreadHistorySyncError({ threadId, detail });
  const current = Effect.fnUntraced(function* (threadId: string) {
    const owner = yield* fences.get(threadId);
    if (!owner) return null;
    const [cursor] = yield* sql<{ generation: number; sourceSequence: number }>`
      SELECT generation, source_sequence AS "sourceSequence" FROM thread_relay_history_cursors
      WHERE thread_id = ${threadId}`;
    if (cursor && cursor.generation !== owner.generation)
      return yield* fail(threadId, "History baseline belongs to an earlier thread generation.");
    return { owner, sequence: cursor?.sourceSequence ?? 0 };
  });
  const synchronize = Effect.fn("ThreadHistorySync.synchronize")(function* (threadId: string) {
    const state = yield* current(threadId);
    if (!state || state.owner.phase === "retired") return;
    const head =
      state.owner.phase === "frozen" && state.owner.frozenSequence !== null
        ? Math.max(state.sequence, state.owner.frozenSequence)
        : yield* engine.latestSequence;
    if (head < state.sequence) return yield* fail(threadId, "History head moved backwards.");
    let previousSequence = state.sequence;
    // A fixed head makes each pass finite even while the provider produces more events.
    yield* engine
      .readThreadEvents({
        threadId: ThreadId.make(threadId),
        fromSequenceExclusive: state.sequence,
        toSequenceInclusive: head,
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              event.aggregateKind !== "thread" ||
              event.aggregateId !== threadId ||
              !("threadId" in event.payload) ||
              event.payload.threadId !== threadId ||
              event.sequence <= previousSequence ||
              event.sequence > head
            )
              return yield* fail(threadId, "History replay crossed its thread or captured range.");
            yield* transport.append(state.owner, event);
            previousSequence = event.sequence;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const latest = yield* current(threadId);
                if (
                  !latest ||
                  latest.owner.generation !== state.owner.generation ||
                  latest.owner.environmentId !== state.owner.environmentId
                )
                  return yield* fail(
                    threadId,
                    "Thread ownership changed while history was uploading.",
                  );
                // Concurrent passes can acknowledge the same event; never move backwards.
                yield* sql`INSERT INTO thread_relay_history_cursors (thread_id, generation, source_sequence)
          VALUES (${threadId}, ${state.owner.generation}, ${event.sequence})
          ON CONFLICT(thread_id) DO UPDATE SET source_sequence = MAX(source_sequence, excluded.source_sequence)`;
              }),
            );
          }),
        ),
      );
    yield* transport.confirmThrough(state.owner, head);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const latest = yield* current(threadId);
        if (
          !latest ||
          latest.owner.generation !== state.owner.generation ||
          latest.owner.environmentId !== state.owner.environmentId
        )
          return yield* fail(threadId, "Thread ownership changed during history scan.");
        yield* sql`INSERT INTO thread_relay_history_cursors (thread_id,generation,source_sequence)
        VALUES (${threadId},${state.owner.generation},${head})
        ON CONFLICT(thread_id) DO UPDATE SET source_sequence = MAX(source_sequence,excluded.source_sequence)`;
      }),
    );
  });
  return { synchronize };
}
