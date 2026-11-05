import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  OrchestrationEvent,
  ThreadPromptQueue,
  type ThreadPromptQueue as Queue,
} from "@t3tools/contracts";
import {
  applyThreadPromptQueueChange,
  emptyThreadPromptQueue,
} from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeQueue = Schema.decodeUnknownEffect(ThreadPromptQueue);
const encodeQueue = Schema.encodeSync(Schema.fromJsonString(ThreadPromptQueue));

/** Called with the placement row locked by the journal or private-access read. */
export function makeThreadCurrentQueueStore(sql: PgClient) {
  const read = Effect.fn("relay.thread_queue.read")(function* (threadId: string) {
    const [cached] = yield* sql<{
      cursor: number;
      queue: unknown;
    }>`SELECT cursor,queue_json AS queue FROM relay_thread_current_queues WHERE thread_id=${threadId}`;
    let queue: Queue = cached ? yield* decodeQueue(cached.queue) : emptyThreadPromptQueue();
    let cursor = cached?.cursor ?? 0;
    // Backfill queue deltas only. Message bodies and old conversation pages never cross this API.
    const deltas = yield* sql<{
      cursor: number;
      event: unknown;
    }>`SELECT cursor,event_json AS event FROM relay_thread_history WHERE thread_id=${threadId} AND cursor>${cursor} AND event_json->>'type'='thread.prompt-queue-changed' AND NOT EXISTS (SELECT 1 FROM relay_thread_history prior WHERE prior.thread_id=relay_thread_history.thread_id AND prior.cursor<relay_thread_history.cursor AND prior.event_json->>'type'='thread.prompt-queue-changed' AND prior.event_json->>'eventId'=relay_thread_history.event_json->>'eventId') ORDER BY cursor`;
    for (const row of deltas) {
      const event = yield* decodeEvent(row.event);
      if (
        event.type === "thread.prompt-queue-changed" &&
        (!event.payload.control || event.payload.control.revision >= queue.revision)
      )
        queue = applyThreadPromptQueueChange(queue, event.payload, event.sequence);
    }
    const [tail] = yield* sql<{
      cursor: number;
    }>`SELECT coalesce(max(cursor),0)::int AS cursor FROM relay_thread_history WHERE thread_id=${threadId}`;
    cursor = tail?.cursor ?? cursor;
    if (!cached || cursor !== cached.cursor)
      yield* sql`INSERT INTO relay_thread_current_queues(thread_id,cursor,queue_json) VALUES(${threadId},${cursor},${encodeQueue(queue)}::jsonb) ON CONFLICT(thread_id) DO UPDATE SET cursor=excluded.cursor,queue_json=excluded.queue_json WHERE relay_thread_current_queues.cursor<=excluded.cursor`;
    return { cursor, queue };
  });
  const append = Effect.fn("relay.thread_queue.append")(function* (
    threadId: string,
    cursor: number,
    event: OrchestrationEvent,
  ) {
    // Streaming conversation events never rewrite the queue projection.
    if (event.type !== "thread.prompt-queue-changed") return;
    const [cached] = yield* sql<{
      cursor: number;
      queue: unknown;
    }>`SELECT cursor,queue_json AS queue FROM relay_thread_current_queues WHERE thread_id=${threadId}`;
    if (!cached) return yield* read(threadId);
    if (cursor <= cached.cursor) return;
    const previous = yield* decodeQueue(cached.queue);
    const duplicate =
      event.type === "thread.prompt-queue-changed" &&
      (yield* sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${threadId} AND cursor<${cursor} AND event_json->>'type'='thread.prompt-queue-changed' AND event_json->>'eventId'=${event.eventId} LIMIT 1`)
        .length > 0;
    const queue =
      !duplicate &&
      event.type === "thread.prompt-queue-changed" &&
      (!event.payload.control || event.payload.control.revision >= previous.revision)
        ? applyThreadPromptQueueChange(previous, event.payload, event.sequence)
        : previous;
    yield* sql`UPDATE relay_thread_current_queues SET cursor=${cursor},queue_json=${encodeQueue(queue)}::jsonb WHERE thread_id=${threadId} AND cursor<${cursor}`;
  });
  return { read, append };
}
