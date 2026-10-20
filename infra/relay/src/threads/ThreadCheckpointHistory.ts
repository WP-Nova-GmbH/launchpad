import type { PgClient } from "@effect/sql-pg/PgClient";
import { OrchestrationEvent } from "@t3tools/contracts";
import {
  OrchestrationCommandReceipt,
  ThreadHistoryArchiveManifest,
} from "@t3tools/contracts/threadTransfer";
import type { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(OrchestrationEvent));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(OrchestrationCommandReceipt));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(ThreadHistoryArchiveManifest));
type File = ThreadTransferChunkManifest["files"][number];

/** Validate complete frozen recovery history against the independent relay mirror.
 * Environment-global event sequences may change on import; stable event contents and cursor order may not. */
export const verifyRetainedCheckpointHistory = Effect.fn("relay.checkpoint.history.verify")(
  function* <E extends Error>(input: {
    sql: PgClient;
    history: ThreadHistoryArchiveManifest;
    byName: ReadonlyMap<string, File>;
    readMetadata: (name: string) => Effect.Effect<string, E>;
    streamFile: (file: File) => Stream.Stream<Uint8Array, E>;
    conflict: (message: string) => E;
  }) {
    const { history: h, sql, conflict } = input;
    if (
      h.eventCount === 0 ||
      h.eventCount > 100_000 ||
      h.receiptCount > 100_000 ||
      h.events.size + h.receipts.size > 256 * 1024 * 1024 ||
      (yield* input.readMetadata("history/manifest.json")) !== encodeHistory(h)
    )
      return yield* Effect.fail(conflict("Frozen history metadata is invalid or unbounded."));
    for (const [name, descriptor] of [
      ["events.jsonl", h.events],
      ["receipts.jsonl", h.receipts],
    ] as const) {
      const file = input.byName.get(`history/${name}`);
      if (!file || file.sha256 !== descriptor.sha256 || file.sizeBytes !== descriptor.size)
        return yield* Effect.fail(conflict("Frozen history omitted or changed a required file."));
    }
    const lines = (name: string) =>
      Stream.unwrap(
        Effect.sync(() => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let last: number | undefined,
            lineLength = 0;
          const decode = (bytes?: Uint8Array) =>
            Effect.try({
              try: () => {
                if (bytes?.length) last = bytes.at(-1);
                const text = decoder.decode(bytes, { stream: bytes !== undefined });
                const parts = text.split("\n");
                for (let index = 0; index < parts.length; index++) {
                  lineLength += parts[index]!.length;
                  if (lineLength > 32 * 1024 * 1024)
                    throw conflict("Frozen history record is too large.");
                  if (index < parts.length - 1) lineLength = 0;
                }
                return text;
              },
              catch: () => conflict("Frozen history contains an invalid record."),
            });
          return input.streamFile(input.byName.get(name)!).pipe(
            Stream.mapEffect(decode),
            Stream.concat(Stream.fromEffect(decode())),
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.concat(
              Stream.fromEffect(
                Effect.suspend(() =>
                  last !== undefined && last !== 10
                    ? Effect.fail(conflict("Frozen history ends with an incomplete record."))
                    : Effect.void,
                ),
              ).pipe(Stream.drain),
            ),
          );
        }),
      );
    const eventIds = new Set<string>();
    let previous = 0,
      count = 0,
      batchBytes = 0;
    const batch: string[] = [];
    const verifyBatch = Effect.fnUntraced(function* () {
      if (!batch.length) return;
      const [matched] = yield* sql<{ count: number }>`WITH expected AS (
        SELECT value AS event,ordinality+${count - batch.length} AS cursor
        FROM jsonb_array_elements(${`[${batch.join(",")}]`}::jsonb) WITH ORDINALITY
      ) SELECT count(*)::int AS count FROM expected e JOIN relay_thread_history m
        ON m.thread_id=${h.threadId} AND m.cursor=e.cursor
          AND (m.event_json-'sequence')=(e.event-'sequence')`;
      if (matched?.count !== batch.length)
        return yield* Effect.fail(conflict("Frozen history disagrees with its retained mirror."));
      batch.length = 0;
      batchBytes = 0;
    });
    yield* lines("history/events.jsonl").pipe(
      Stream.mapEffect((line) => decodeEvent(line)),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (
            event.aggregateKind !== "thread" ||
            event.aggregateId !== h.threadId ||
            !("threadId" in event.payload) ||
            event.payload.threadId !== h.threadId ||
            eventIds.has(event.eventId) ||
            event.sequence <= previous ||
            event.sequence > h.sourceSequence ||
            (count === 0 && event.type !== "thread.created") ||
            count >= h.eventCount
          )
            return yield* Effect.fail(
              conflict("Frozen history has invalid source identities or order."),
            );
          eventIds.add(event.eventId);
          previous = event.sequence;
          count++;
          const encoded = encodeEvent(event);
          batch.push(encoded);
          batchBytes += encoded.length;
          if (batch.length >= 32 || batchBytes >= 8 * 1024 * 1024) yield* verifyBatch();
        }),
      ),
    );
    yield* verifyBatch();
    const [mirror] = yield* sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM relay_thread_history WHERE thread_id=${h.threadId}`;
    if (count !== h.eventCount || previous !== h.sourceSequence || mirror?.count !== count)
      return yield* Effect.fail(conflict("Frozen history is incomplete."));
    const receiptIds = new Set<string>();
    yield* lines("history/receipts.jsonl").pipe(
      Stream.mapEffect((line) => decodeReceipt(line)),
      Stream.runForEach((receipt) =>
        Effect.gen(function* () {
          if (
            receipt.aggregateKind !== "thread" ||
            receipt.aggregateId !== h.threadId ||
            receiptIds.has(receipt.commandId) ||
            receipt.resultSequence > h.sourceSequence ||
            receiptIds.size >= h.receiptCount
          )
            return yield* Effect.fail(conflict("Frozen command receipts have invalid identities."));
          receiptIds.add(receipt.commandId);
        }),
      ),
    );
    if (receiptIds.size !== h.receiptCount)
      return yield* Effect.fail(conflict("Frozen command receipts are incomplete."));
  },
);
