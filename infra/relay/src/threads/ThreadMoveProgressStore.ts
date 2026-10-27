import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadMoveProgressReport, ThreadMoveProgressSnapshot } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadMove } from "./ThreadPlacementStore.ts";

const decode = Schema.decodeUnknownEffect(Schema.Array(ThreadMoveProgressSnapshot));
const stages = [
  "capturing",
  "packing",
  "uploading",
  "downloading",
  "installing",
  "setup",
  "activating",
];

/** At most two latest snapshots per move; never part of the orchestration event stream. */
export function makeThreadMoveProgressStore(sql: PgClient) {
  const read = Effect.fnUntraced(function* (operationId: string) {
    const rows = yield* sql<{ snapshot: unknown }>`SELECT snapshot FROM relay_thread_move_progress
      WHERE operation_id=${operationId} ORDER BY environment_id`;
    return yield* decode(rows.map((row) => row.snapshot)).pipe(Effect.orDie);
  });
  const report = Effect.fnUntraced(function* (
    move: ThreadMove,
    input: ThreadMoveProgressReport & { environmentId: string; generation: number },
  ) {
    // A final/cancelling journal always wins, including a late request from an old process.
    if (["completed", "aborting", "aborted"].includes(move.phase)) return;
    const source =
      input.environmentId === move.sourceEnvironmentId &&
      input.generation === move.expectedGeneration;
    const destination =
      input.environmentId === move.destinationEnvironmentId &&
      input.generation === move.expectedGeneration + 1;
    if (!source && !destination) return;
    if (
      (input.totalBytes !== null && input.completedBytes > input.totalBytes) ||
      (input.totalArtifacts !== null && input.completedArtifacts > input.totalArtifacts)
    )
      return;
    if (
      (source && !["capturing", "packing", "uploading"].includes(input.stage)) ||
      (destination && !["downloading", "installing", "setup", "activating"].includes(input.stage))
    )
      return;
    const snapshot: ThreadMoveProgressSnapshot = {
      ...input,
      threadId: move.threadId,
      operationId: move.operationId,
      participant: source ? "source" : "destination",
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    const stage = stages.indexOf(input.stage);
    yield* sql`INSERT INTO relay_thread_move_progress
      (operation_id,environment_id,generation,attempt,revision,stage,snapshot)
      VALUES (${move.operationId},${input.environmentId},${input.generation},${input.attempt},${input.revision},${stage},${sql.json(snapshot)})
      ON CONFLICT(operation_id,environment_id) DO UPDATE SET
        attempt=excluded.attempt,revision=excluded.revision,stage=excluded.stage,snapshot=excluded.snapshot
      WHERE relay_thread_move_progress.generation=excluded.generation
        AND (excluded.attempt>relay_thread_move_progress.attempt OR
          (excluded.attempt=relay_thread_move_progress.attempt AND excluded.revision>relay_thread_move_progress.revision
            AND excluded.stage>=relay_thread_move_progress.stage
            AND (excluded.stage>relay_thread_move_progress.stage OR
              ((excluded.snapshot->>'completedBytes')::bigint>=(relay_thread_move_progress.snapshot->>'completedBytes')::bigint
                AND (excluded.snapshot->>'completedArtifacts')::bigint>=(relay_thread_move_progress.snapshot->>'completedArtifacts')::bigint))))`;
  });
  return { read, report };
}
