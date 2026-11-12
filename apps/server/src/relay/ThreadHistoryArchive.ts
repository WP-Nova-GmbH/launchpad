import * as NodeCrypto from "node:crypto";
import { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { OrchestrationCommandReceipt } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadTransferAborts } from "./ThreadTransferAbort.ts";
import { workspaceFileHash } from "./ThreadWorkspaceFiles.ts";

import {
  ThreadHistoryArchiveManifest,
  ThreadHistoryArchiveOwner as Owner,
} from "@t3tools/contracts/threadTransfer";
export { ThreadHistoryArchiveManifest } from "@t3tools/contracts/threadTransfer";
export class ThreadHistoryArchiveError extends Schema.TaggedError<ThreadHistoryArchiveError>()(
  "ThreadHistoryArchiveError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadHistoryArchiveError({ message });
const eventCodec = Schema.fromJsonString(OrchestrationEvent);
const receiptCodec = Schema.fromJsonString(OrchestrationCommandReceipt);
const encodeEvent = Schema.encodeEffect(eventCodec);
const decodeEvent = Schema.decodeUnknownEffect(eventCodec);
const encodeReceipt = Schema.encodeEffect(receiptCodec);
const decodeReceipt = Schema.decodeUnknownEffect(receiptCodec);
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(OrchestrationCommandReceipt));
const decodeManifest = Schema.decodeUnknownEffect(ThreadHistoryArchiveManifest);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadHistoryArchiveManifest));
const sameOwner = (a: typeof Owner.Type, b: typeof Owner.Type) =>
  a.threadId === b.threadId &&
  a.environmentId === b.environmentId &&
  a.generation === b.generation &&
  a.operationId === b.operationId;

const syncFile = (file: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* (yield* fs.open(file, { flag: "r" })).sync;
    }),
  );

/** Archive source identities unchanged; import must assign destination-local event/receipt watermarks. */
export function makeThreadHistoryArchive(
  sql: SqlClient.SqlClient,
  events: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
) {
  const fences = makeThreadExecutionFence(sql);
  const source = Effect.fnUntraced(function* (owner: typeof Owner.Type) {
    const fence = yield* fences.get(owner.threadId);
    if (
      !fence ||
      !sameOwner(fence, owner) ||
      fence.phase !== "frozen" ||
      fence.frozenSequence === null
    )
      return yield* fail("A confirmed frozen source is required to export thread history.");
    const [head] = yield* sql<{
      sequence: number;
      count: number;
    }>`SELECT COALESCE(MAX(sequence), 0) AS sequence,
      COUNT(*) AS count FROM orchestration_events e WHERE aggregate_kind = 'thread' AND stream_id = ${owner.threadId}
      AND NOT EXISTS(SELECT 1 FROM thread_transfer_aborts a WHERE a.thread_id=e.stream_id
        AND e.event_type='thread.placement-imported' AND e.event_id='thread-transfer:' || a.operation_id)`;
    if (!head || head.sequence !== fence.frozenSequence || head.count === 0)
      return yield* fail("The thread history no longer matches its frozen watermark.");
    const busy =
      yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id = ${owner.threadId} AND completed = 0 LIMIT 1`;
    if (busy.length) return yield* fail("Thread work is not confirmed stopped.");
    return { ...owner, sourceSequence: head.sequence, eventCount: head.count };
  });
  const receipts = Effect.fnUntraced(function* (threadId: string) {
    const rows =
      yield* sql`SELECT command_id AS "commandId", aggregate_kind AS "aggregateKind", aggregate_id AS "aggregateId",
      project_id AS "projectId", accepted_at AS "acceptedAt", result_sequence AS "resultSequence", status, error
      FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId} ORDER BY command_id`;
    return yield* decodeReceipts(rows);
  });
  const exportFrozen = Effect.fn("ThreadHistoryArchive.exportFrozen")(function* (
    input: typeof Owner.Type & { readonly artifactRoot: string },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const frozen = yield* sql.withTransaction(source(input));
    const savedReceipts = yield* receipts(input.threadId);
    yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({
      directory: input.artifactRoot,
      prefix: "history-",
    });
    return yield* Effect.gen(function* () {
      const eventFile = path.join(directory, "events.jsonl");
      const receiptFile = path.join(directory, "receipts.jsonl");
      let count = 0,
        previous = 0;
      const identities = new Set<string>();
      const abortedArrivals = yield* makeThreadTransferAborts(sql).eventIds(input.threadId);
      yield* events
        .readAggregateRange({
          aggregateKind: "thread",
          aggregateId: input.threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: frozen.sourceSequence,
          limit: Number.MAX_SAFE_INTEGER,
        })
        .pipe(
          Stream.filter(
            (event) =>
              event.type !== "thread.placement-imported" || !abortedArrivals.has(event.eventId),
          ),
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (
                event.aggregateKind !== "thread" ||
                event.aggregateId !== input.threadId ||
                !("threadId" in event.payload) ||
                event.payload.threadId !== input.threadId ||
                event.sequence <= previous ||
                event.sequence > frozen.sourceSequence ||
                identities.has(event.eventId) ||
                (count === 0 && event.type !== "thread.created")
              )
                return yield* fail(
                  "History replay crossed its identity, order, or complete source baseline.",
                );
              identities.add(event.eventId);
              previous = event.sequence;
              count++;
              return new TextEncoder().encode(`${yield* encodeEvent(event)}\n`);
            }),
          ),
          Stream.run(fs.sink(eventFile, { flag: "wx", mode: 0o600 })),
        );
      if (count !== frozen.eventCount || previous !== frozen.sourceSequence)
        return yield* fail("History replay omitted part of the frozen thread.");
      const receiptLines = yield* Effect.forEach(savedReceipts, (receipt) =>
        encodeReceipt(receipt),
      );
      yield* fs.writeFileString(
        receiptFile,
        receiptLines.length ? `${receiptLines.join("\n")}\n` : "",
        { flag: "wx", mode: 0o600 },
      );
      const current = yield* sql.withTransaction(source(input));
      const latestReceipts = yield* Effect.forEach(yield* receipts(input.threadId), (receipt) =>
        encodeReceipt(receipt),
      );
      if (
        current.sourceSequence !== frozen.sourceSequence ||
        current.eventCount !== frozen.eventCount ||
        latestReceipts.join("\n") !== receiptLines.join("\n")
      )
        return yield* fail("Thread state changed while its history was being exported.");
      const manifest: ThreadHistoryArchiveManifest = {
        format: "launchpad-history-v1",
        ...frozen,
        receiptCount: savedReceipts.length,
        events: yield* workspaceFileHash(eventFile),
        receipts: yield* workspaceFileHash(receiptFile),
      };
      const manifestFile = path.join(directory, "manifest.json");
      yield* fs.writeFileString(manifestFile, yield* encodeManifest(manifest), {
        flag: "wx",
        mode: 0o600,
      });
      for (const file of [eventFile, receiptFile, manifestFile, directory, input.artifactRoot])
        yield* syncFile(file);
      return { directory, manifest };
    }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  });
  const verifyFrozen = Effect.fn("ThreadHistoryArchive.verifyFrozen")(function* (
    manifest: ThreadHistoryArchiveManifest,
  ) {
    const current = yield* sql.withTransaction(source(manifest));
    const currentReceipts = yield* Effect.forEach(yield* receipts(manifest.threadId), (receipt) =>
      encodeReceipt(receipt),
    );
    const bytes = new TextEncoder().encode(
      currentReceipts.length ? currentReceipts.join("\n") + "\n" : "",
    );
    if (
      current.sourceSequence !== manifest.sourceSequence ||
      current.eventCount !== manifest.eventCount ||
      currentReceipts.length !== manifest.receiptCount ||
      bytes.length !== manifest.receipts.size ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== manifest.receipts.sha256
    )
      return yield* fail(
        "History or command receipts changed after the source archive was captured.",
      );
  });
  return { exportFrozen, verifyFrozen };
}

const lines = (file: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let lastByte: number | undefined;
      let lineLength = 0;
      const decode = (bytes?: Uint8Array) =>
        Effect.try({
          try: () => {
            const text = decoder.decode(bytes, { stream: bytes !== undefined });
            const parts = text.split("\n");
            for (let index = 0; index < parts.length; index++) {
              lineLength += parts[index]!.length;
              if (lineLength > 32 * 1024 * 1024) throw fail("History record is too large.");
              if (index < parts.length - 1) lineLength = 0;
            }
            return text;
          },
          catch: () => fail("History archive contains invalid UTF-8."),
        });
      return fs.stream(file).pipe(
        Stream.tap((bytes) =>
          Effect.sync(() => {
            if (bytes.length) lastByte = bytes[bytes.length - 1];
          }),
        ),
        Stream.mapEffect((bytes) => decode(bytes)),
        Stream.concat(Stream.fromEffect(decode())),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.concat(
          Stream.fromEffect(
            Effect.suspend(() =>
              lastByte !== undefined && lastByte !== 10
                ? Effect.fail(fail("History archive ends with an incomplete record."))
                : Effect.void,
            ),
          ).pipe(Stream.drain),
        ),
      );
    }),
  );

/** Verify before installing any baseline. Returned identities still belong to the source environment. */
export const inspectThreadHistoryArchive = Effect.fn("inspectThreadHistoryArchive")(
  function* (input: {
    readonly owner: typeof Owner.Type;
    readonly manifest: unknown;
    readonly directory: string;
  }) {
    const manifest = yield* decodeManifest(input.manifest);
    if (!sameOwner(input.owner, manifest))
      return yield* fail("History archive belongs to another thread placement or move.");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.realPath(input.directory);
    for (const [name, expected] of [
      ["events.jsonl", manifest.events],
      ["receipts.jsonl", manifest.receipts],
    ] as const) {
      const file = path.join(directory, name);
      if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== "File")
        return yield* fail("History archive must contain regular files in its own directory.");
      const actual = yield* workspaceFileHash(file);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
        return yield* fail("History archive failed its integrity check.");
    }
    const eventFile = path.join(directory, "events.jsonl");
    let eventCount = 0,
      last = 0;
    const ids = new Set<string>();
    yield* lines(eventFile).pipe(
      Stream.mapEffect((line) => decodeEvent(line)),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (
            event.aggregateKind !== "thread" ||
            event.aggregateId !== manifest.threadId ||
            !("threadId" in event.payload) ||
            event.payload.threadId !== manifest.threadId ||
            event.sequence <= last ||
            event.sequence > manifest.sourceSequence ||
            ids.has(event.eventId) ||
            (eventCount === 0 && event.type !== "thread.created")
          )
            return yield* fail("History archive contains invalid source events.");
          ids.add(event.eventId);
          last = event.sequence;
          eventCount++;
        }),
      ),
    );
    const savedReceipts: OrchestrationCommandReceipt[] = [];
    const commandIds = new Set<string>();
    yield* lines(path.join(directory, "receipts.jsonl")).pipe(
      Stream.mapEffect((line) => decodeReceipt(line)),
      Stream.runForEach((receipt) =>
        Effect.gen(function* () {
          if (
            receipt.aggregateKind !== "thread" ||
            receipt.aggregateId !== manifest.threadId ||
            commandIds.has(receipt.commandId)
          )
            return yield* fail("History archive contains invalid command receipts.");
          commandIds.add(receipt.commandId);
          savedReceipts.push(receipt);
        }),
      ),
    );
    if (
      eventCount !== manifest.eventCount ||
      last !== manifest.sourceSequence ||
      eventCount === 0 ||
      savedReceipts.length !== manifest.receiptCount
    )
      return yield* fail("History archive is incomplete.");
    return {
      manifest,
      receipts: savedReceipts,
      events: lines(eventFile).pipe(Stream.mapEffect((line) => decodeEvent(line))),
    };
  },
);
