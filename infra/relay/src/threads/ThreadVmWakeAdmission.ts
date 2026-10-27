import type { PgClient } from "@effect/sql-pg/PgClient";
import { ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";

type ThreadCommand = Extract<ClientOrchestrationCommand, { readonly threadId: string }>;
const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
// Queue management is durable while compute sleeps. Only new work or an
// explicit continuation asks for power; archive/unarchive retain the hold.
export const threadCommandRequestsWake = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
  command: ThreadCommand,
) {
  const explicitResume =
    command.type === "thread.queue.resume" || command.type === "thread.preparation.retry";
  if (
    !explicitResume &&
    command.type !== "thread.prompt.enqueue" &&
    command.type !== "thread.turn.start" &&
    command.type !== "thread.move.enqueue"
  )
    return false;
  const controls = yield* sql<{ type: string; cursor: number; enabled: boolean | null }>`
      SELECT DISTINCT ON (CASE WHEN event_json->>'type'='thread.prompt-queue-changed' THEN 'queue' ELSE 'archive' END)
        event_json->>'type' AS type,cursor,(event_json->'payload'->'control'->>'enabled')::boolean AS enabled
      FROM relay_thread_history WHERE thread_id=${threadId}
        AND (event_json->>'type' IN ('thread.archived','thread.unarchived')
          OR (event_json->>'type'='thread.prompt-queue-changed' AND event_json->'payload'->'control' IS NOT NULL))
      ORDER BY CASE WHEN event_json->>'type'='thread.prompt-queue-changed' THEN 'queue' ELSE 'archive' END,cursor DESC`;
  const archive = controls.find((row) => row.type !== "thread.prompt-queue-changed"),
    queue = controls.find((row) => row.type === "thread.prompt-queue-changed");
  let archived = archive?.type === "thread.archived";
  let held =
    queue?.enabled === false || (archive !== undefined && archive.cursor > (queue?.cursor ?? 0));
  // Apply queued controls in order, including holds accepted after this wake
  // request while a certified pause was still completing.
  const pending = yield* sql<{
    type: string;
    later: boolean;
  }>`SELECT payload_json->>'type' AS type,
      position>COALESCE((SELECT position FROM relay_thread_commands WHERE thread_id=${threadId} AND command_id=${command.commandId}),0) AS later
      FROM relay_thread_commands
      WHERE thread_id=${threadId} AND receipt_json IS NULL
        AND payload_json->>'type' IN ('thread.archive','thread.unarchive','thread.queue.pause','thread.queue.resume') ORDER BY position`;
  let laterHold = false;
  for (const control of pending) {
    if (control.type === "thread.archive") {
      archived = true;
      held = true;
    } else if (control.type === "thread.unarchive") {
      archived = false;
      held = true;
    } else if (control.type === "thread.queue.pause") held = true;
    else if (!archived) held = false;
    if (control.later) laterHold = control.type !== "thread.queue.resume" || archived;
  }
  return !archived && (!held || (explicitResume && !laterHold));
});

/** A send accepted during a certified pause waits for positive power-off before reserving wake. */
export const wakeQueuedThreadVm = Effect.fn("relay.thread_vm.wake_queued")(function* (
  sql: PgClient,
  threadId: string,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [placement] = yield* sql<{
        generation: number;
        environmentId: string;
        operationId: string | null;
      }>`
      SELECT generation, environment_id AS "environmentId", operation_id AS "operationId"
      FROM relay_thread_placements WHERE thread_id=${threadId} FOR UPDATE`;
      if (!placement || placement.operationId !== null) return false;
      const [paused] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_bindings b USING(allocation_id) LEFT JOIN relay_thread_vm_pauses x USING(allocation_id)
      WHERE a.thread_id=${threadId} AND a.state='paused' AND a.deleted_at IS NULL
        AND b.environment_id=${placement.environmentId} AND b.generation=${placement.generation} AND b.revoked_at IS NULL
        AND (a.native_paused_generation=${placement.generation} OR (x.phase='completed' AND x.generation=${placement.generation}))`;
      if (!paused) return false;
      const [candidate] = yield* sql<{
        payload: unknown;
      }>`SELECT payload_json AS payload FROM relay_thread_commands
      WHERE thread_id=${threadId} AND receipt_json IS NULL
        AND payload_json->>'type' IN ('thread.prompt.enqueue','thread.turn.start','thread.move.enqueue','thread.queue.resume','thread.preparation.retry')
      ORDER BY position DESC LIMIT 1`;
      if (!candidate) return false;
      const command = yield* decodeCommand(candidate.payload);
      if (
        !("threadId" in command) ||
        command.threadId !== threadId ||
        !(yield* threadCommandRequestsWake(sql, threadId, command))
      )
        return false;
      yield* makeThreadVmResumeStore(sql).request(threadId);
      return true;
    }),
  );
});
