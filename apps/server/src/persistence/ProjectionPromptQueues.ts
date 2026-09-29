import { ThreadPromptQueue, ThreadPreparationSummary, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceDecodeError, toPersistenceSqlError } from "./Errors.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadPromptQueue));

export const getPromptQueue = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      stateJson: string;
    }>`SELECT state_json AS "stateJson" FROM projection_thread_prompt_queues WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("promptQueue.get")),
    );
    return rows[0]
      ? yield* decode(rows[0].stateJson).pipe(
          Effect.mapError(toPersistenceDecodeError("promptQueue.get")),
        )
      : undefined;
  });

export const listPromptQueues = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      threadId: ThreadId;
      stateJson: string;
    }>`SELECT thread_id AS "threadId", state_json AS "stateJson" FROM projection_thread_prompt_queues`.pipe(
      Effect.mapError(toPersistenceSqlError("promptQueue.list")),
    );
    const values = yield* Effect.forEach(rows, (row) =>
      decode(row.stateJson).pipe(
        Effect.map((queue) => [row.threadId, queue] as const),
        Effect.mapError(toPersistenceDecodeError("promptQueue.list")),
      ),
    );
    return new Map(values);
  });

const Summary = Schema.Struct({
  threadId: Schema.String,
  preparationState: Schema.NullOr(ThreadPreparationSummary.fields.state),
  preparationRevision: Schema.NullOr(Schema.Number),
  preparationSettled: Schema.NullOr(Schema.Number),
  count: Schema.Number,
  enabled: Schema.Number,
  pauseReason: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        code: Schema.Literals([
          "stopped",
          "failed",
          "usage-limit",
          "checkpoint-error",
          "delivery-unknown",
        ]),
        detail: Schema.String,
      }),
    ),
  ),
});
const summaries = (sql: SqlClient.SqlClient, threadId?: ThreadId) =>
  sql`SELECT thread_id AS "threadId", json_extract(state_json,'$.preparation.state') AS "preparationState", json_extract(state_json,'$.preparation.revision') AS "preparationRevision", json_extract(state_json,'$.preparation.settled') AS "preparationSettled", json_array_length(state_json,'$.entries') AS count, json_extract(state_json,'$.enabled') AS enabled, json_extract(state_json,'$.pauseReason') AS "pauseReason" FROM projection_thread_prompt_queues WHERE ${threadId === undefined ? sql`1=1` : sql`thread_id = ${threadId}`}`.pipe(
    Effect.mapError(toPersistenceSqlError("promptQueue.summary")),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Summary))),
    Effect.mapError((error) =>
      error._tag === "SchemaError" ? toPersistenceDecodeError("promptQueue.summary")(error) : error,
    ),
    Effect.map(
      (rows) =>
        new Map(
          rows.map(
            (row) =>
              [
                row.threadId,
                {
                  count: row.count,
                  enabled: row.enabled === 1,
                  pauseReason: row.pauseReason,
                  ...(row.preparationState !== null
                    ? {
                        preparation: {
                          state: row.preparationState,
                          revision: row.preparationRevision ?? 0,
                          settled: row.preparationSettled === 1,
                        },
                      }
                    : {}),
                },
              ] as const,
          ),
        ),
    ),
  );
export const listPromptQueueSummaries = (sql: SqlClient.SqlClient) => summaries(sql);
export const getPromptQueueSummary = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  summaries(sql, threadId).pipe(Effect.map((rows) => rows.get(threadId)));
