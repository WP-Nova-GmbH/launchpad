import { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import { RelayThreadPersistedReceipt, type RelayThreadInboxEntry } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  AuthSessionUser,
  ClientOrchestrationCommand,
  OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadPlacementConflict } from "./ThreadPlacementStore.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { threadCommandRequestsWake } from "./ThreadVmWakeAdmission.ts";

type ThreadCommand = Extract<ClientOrchestrationCommand, { readonly threadId: string }>;
type Receipt = RelayThreadPersistedReceipt;
type CommandEntry = RelayThreadInboxEntry;
interface HistoryEntry {
  readonly cursor: number;
  readonly environmentId: string;
  readonly event: OrchestrationEvent;
}
type Owner = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
};
const conflict = (message: string) => new ThreadPlacementConflict({ message });
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(ClientOrchestrationCommand));
const encodeActor = Schema.encodeEffect(Schema.fromJsonString(AuthSessionUser));
const encodeArchiveReceipt = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationCommandReceipt),
);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadPersistedReceipt));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationEvent));

/** Admission is pending until the environment reports a persisted command receipt. */
export function makeThreadJournalStore(sql: PgClient) {
  const requireLiveDisk = Effect.fnUntraced(function* (input: Owner) {
    const saved = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
      WHERE thread_id=${input.threadId} AND generation=${input.generation} AND phase != 'restored'`;
    if (saved.length) return yield* conflict("VM disk requires an explicit restore or reset");
  });
  const requireUnfrozenPause = Effect.fnUntraced(function* (input: Owner) {
    const frozen =
      yield* sql`SELECT 1 FROM relay_thread_vm_pauses x JOIN relay_thread_vm_allocations a USING(allocation_id)
      WHERE a.thread_id=${input.threadId} AND x.generation=${input.generation}
        AND x.native_checkpoint_operation_id IS NOT NULL AND (x.phase IN ('pending','sealed') OR (x.phase='completed'
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_resumes r WHERE r.allocation_id=a.allocation_id
          AND r.generation=x.generation AND r.phase='completed' AND a.state='running'))) `;
    if (frozen.length) return yield* conflict("Source history is frozen for VM pause");
  });
  const lock = Effect.fnUntraced(function* (threadId: string) {
    const [placement] = yield* sql<{
      environmentId: string;
      generation: number;
      operationId: string | null;
    }>`
      SELECT environment_id AS "environmentId", generation, operation_id AS "operationId"
      FROM relay_thread_placements WHERE thread_id = ${threadId} FOR UPDATE`;
    if (!placement) return yield* conflict("Portable thread does not exist");
    if ((yield* sql`SELECT 1 FROM relay_thread_deletions WHERE thread_id=${threadId}`).length)
      return yield* conflict("Portable thread was permanently deleted");
    const aborted =
      yield* sql`SELECT 1 FROM relay_thread_local_enrollments WHERE thread_id=${threadId} AND phase='aborted'`;
    if (aborted.length) return yield* conflict("Local enrollment was cancelled");
    return placement;
  });
  const requireOwner = Effect.fnUntraced(function* (input: Owner) {
    const placement = yield* lock(input.threadId);
    if (
      placement.environmentId !== input.environmentId ||
      placement.generation !== input.generation
    )
      return yield* conflict("Environment no longer owns this thread generation");
    return placement;
  });
  const command = Effect.fn("relay.thread_journal.command")(function* (
    threadId: string,
    commandId: string,
  ) {
    const [entry] =
      yield* sql<CommandEntry>`SELECT command_id AS "commandId", thread_id AS "threadId", position,
      accepted_generation AS "acceptedGeneration", actor_json AS actor, payload_json AS command, receipt_json AS receipt,
      to_char(admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt"
      FROM relay_thread_commands WHERE thread_id = ${threadId} AND command_id = ${commandId}`;
    return entry ?? null;
  });
  const pending = Effect.fn("relay.thread_journal.pending")(function* (
    threadId: string,
    after: number,
    limit: number,
  ) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      return yield* conflict("Invalid pending command page");
    const rows = yield* sql<{ commandId: string; position: number; receipt: null }>`
      SELECT command_id AS "commandId", position, receipt_json AS receipt FROM relay_thread_commands
      WHERE thread_id = ${threadId} AND position > ${after} AND receipt_json IS NULL
      ORDER BY position LIMIT ${limit + 1}`;
    return { entries: rows.slice(0, limit), hasMore: rows.length > limit };
  });
  const stage = Effect.fn("relay.thread_journal.stage")(function* (input: {
    readonly threadId: string;
    readonly actor: AuthSessionUser;
    readonly command: ThreadCommand;
  }) {
    if (input.command.threadId !== input.threadId)
      return yield* conflict("Command belongs to another thread");
    const payload = yield* encodeCommand(input.command);
    const actor = yield* encodeActor(input.actor);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const [prior] = yield* sql<{ same: boolean }>`SELECT
        (thread_id = ${input.threadId} AND payload_json = ${payload}::jsonb AND actor_json->>'userId' = ${input.actor.userId}) AS same
        FROM relay_thread_commands WHERE command_id = ${input.command.commandId}`;
        if (prior) {
          if (!prior.same)
            return yield* conflict("Command ID reused with different content or author");
          return yield* command(input.threadId, input.command.commandId);
        }
        const [baselineReceipt] = yield* sql<{
          threadId: string;
          receipt: import("@t3tools/contracts/threadTransfer").OrchestrationCommandReceipt;
        }>`
          SELECT thread_id AS "threadId",receipt_json AS receipt FROM relay_thread_local_receipts WHERE command_id=${input.command.commandId}`;
        if (baselineReceipt && baselineReceipt.threadId !== input.threadId)
          return yield* conflict("Command ID belongs to another thread");
        const baselineResult = baselineReceipt
          ? yield* encodeReceipt(
              baselineReceipt.receipt.status === "accepted"
                ? { status: "accepted", sequence: baselineReceipt.receipt.resultSequence! }
                : {
                    status: "rejected",
                    detail: baselineReceipt.receipt.error ?? "Command was previously rejected",
                  },
            )
          : null;
        const [pausing] = yield* sql<{
          operationId: string;
        }>`SELECT x.operation_id AS "operationId" FROM relay_thread_vm_pauses x
          JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
          WHERE a.thread_id = ${input.threadId} AND x.generation=${placement.generation} AND x.phase='pending'
            AND x.native_checkpoint_operation_id IS NULL AND x.source_frozen_at IS NULL`;
        if (pausing && baselineResult === null)
          yield* makeThreadVmPauseStore(sql).cancelBeforeFreeze({
            threadId: input.threadId,
            environmentId: placement.environmentId,
            generation: placement.generation,
            operationId: pausing.operationId,
          });
        const baselineArchive = baselineReceipt
          ? yield* encodeArchiveReceipt(baselineReceipt.receipt)
          : null;
        yield* sql`INSERT INTO relay_thread_commands (command_id, thread_id, position, accepted_generation, actor_json, payload_json, receipt_json,archive_receipt_json)
        SELECT ${input.command.commandId}, ${input.threadId}, COALESCE(MAX(position), 0) + 1, ${placement.generation}, ${actor}::jsonb, ${payload}::jsonb, ${baselineResult}::jsonb,${baselineArchive}::jsonb
        FROM relay_thread_commands WHERE thread_id = ${input.threadId}`;
        const [paused] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
          WHERE a.thread_id = ${input.threadId} AND a.state = 'paused'
            AND a.deleted_at IS NULL AND b.environment_id = ${placement.environmentId}
            AND b.generation = ${placement.generation} AND b.revoked_at IS NULL`;
        if (
          paused &&
          baselineResult === null &&
          placement.operationId === null &&
          (yield* threadCommandRequestsWake(sql, input.threadId, input.command))
        )
          yield* makeThreadVmResumeStore(sql).request(input.threadId);
        return yield* command(input.threadId, input.command.commandId);
      }),
    );
  });
  const next = Effect.fn("relay.thread_journal.next")(function* (input: Owner) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* requireOwner(input);
        if (placement.operationId !== null) return null;
        const saved = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
          WHERE thread_id=${input.threadId} AND generation=${input.generation} AND phase != 'restored'`;
        if (saved.length) return null;
        const asleep = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_bindings b USING(allocation_id)
          WHERE a.thread_id=${input.threadId} AND a.deleted_at IS NULL AND a.state='paused'
            AND b.environment_id=${input.environmentId} AND b.generation=${input.generation} AND b.revoked_at IS NULL`;
        if (asleep.length) return null;
        const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses x
          JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
          WHERE a.thread_id = ${input.threadId} AND x.generation=${input.generation}
            AND (x.phase IN ('pending','sealed') OR (x.phase IN ('cancelled','completed') AND x.source_reopened_at IS NULL))`;
        if (pausing.length) return null;
        const resuming = yield* sql`SELECT 1 FROM relay_thread_vm_resumes r
          JOIN relay_thread_vm_allocations a ON a.allocation_id = r.allocation_id
          WHERE a.thread_id = ${input.threadId} AND r.phase IN ('waiting','resuming')`;
        if (resuming.length) return null;
        const [pending] = yield* sql<{
          commandId: string;
        }>`SELECT command_id AS "commandId" FROM relay_thread_commands
        WHERE thread_id = ${input.threadId} AND receipt_json IS NULL ORDER BY position LIMIT 1`;
        return pending ? yield* command(input.threadId, pending.commandId) : null;
      }),
    );
  });
  const acknowledge = Effect.fn("relay.thread_journal.acknowledge")(function* (
    input: Owner & {
      readonly commandId: string;
      readonly receipt: Receipt;
      readonly commandReceipt?: OrchestrationCommandReceipt;
    },
  ) {
    const receipt = yield* encodeReceipt(input.receipt);
    const archive = input.commandReceipt;
    if (
      archive &&
      (archive.commandId !== input.commandId ||
        archive.aggregateKind !== "thread" ||
        archive.aggregateId !== input.threadId ||
        archive.status !== input.receipt.status ||
        (input.receipt.status === "accepted" &&
          archive.resultSequence !== input.receipt.sequence) ||
        (input.receipt.status === "rejected" && archive.error !== (input.receipt.detail ?? null)))
    )
      return yield* conflict("Archived command receipt does not match its acknowledgement");
    const archived = archive ? yield* encodeArchiveReceipt(archive) : null;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* requireOwner(input);
        const [row] = yield* sql<{
          position: number;
          complete: boolean;
          same: boolean;
          archiveMatches: boolean;
        }>`SELECT position,
        (archive_receipt_json IS NULL OR ${archived}::jsonb IS NULL OR archive_receipt_json=${archived}::jsonb) AS "archiveMatches",
        receipt_json IS NOT NULL AS complete, receipt_json = ${receipt}::jsonb AS same FROM relay_thread_commands
        WHERE thread_id = ${input.threadId} AND command_id = ${input.commandId}`;
        if (!row) return yield* conflict("Command does not exist for this thread");
        if (!row.archiveMatches) return yield* conflict("Archived command receipt cannot change");
        if (row.complete) {
          if (!row.same) return yield* conflict("Persisted command receipt cannot change");
          if (archived)
            yield* sql`UPDATE relay_thread_commands SET archive_receipt_json=COALESCE(archive_receipt_json,${archived}::jsonb) WHERE command_id=${input.commandId}`;
          return;
        }
        yield* requireLiveDisk(input);
        yield* requireUnfrozenPause(input);
        if (placement.operationId !== null) {
          const [move] = yield* sql<{
            phase: string;
          }>`SELECT phase FROM relay_thread_moves WHERE operation_id = ${placement.operationId}`;
          if (!move || move.phase !== "preparing")
            return yield* conflict("Source receipts are frozen for handoff");
        }
        const predecessors = yield* sql`SELECT command_id FROM relay_thread_commands
        WHERE thread_id = ${input.threadId} AND position < ${row.position} AND receipt_json IS NULL LIMIT 1`;
        if (predecessors.length) return yield* conflict("An earlier command is still pending");
        yield* sql`UPDATE relay_thread_commands SET receipt_json = ${receipt}::jsonb,archive_receipt_json=${archived}::jsonb WHERE command_id = ${input.commandId}`;
      }),
    );
  });
  const append = Effect.fn("relay.thread_journal.append")(function* (
    input: Owner & { readonly event: OrchestrationEvent },
  ) {
    if (
      input.event.aggregateKind !== "thread" ||
      input.event.aggregateId !== input.threadId ||
      !("threadId" in input.event.payload) ||
      input.event.payload.threadId !== input.threadId
    )
      return yield* conflict("History event belongs to another thread");
    const event = yield* encodeEvent(input.event);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Deduplicate a delayed upload even after ownership moved, but never accept new old-owner events.
        const placement = yield* lock(input.threadId);
        const [prior] = yield* sql<{ cursor: number; same: boolean }>`SELECT cursor,
        (thread_id = ${input.threadId} AND event_json = ${event}::jsonb) AS same FROM relay_thread_history
        WHERE environment_id = ${input.environmentId} AND source_sequence = ${input.event.sequence}`;
        if (prior) {
          if (!prior.same)
            return yield* conflict("Source event identity was reused with different content");
          return prior.cursor;
        }
        if (
          placement.environmentId !== input.environmentId ||
          placement.generation !== input.generation
        )
          return yield* conflict("Environment no longer owns this thread generation");
        yield* requireLiveDisk(input);
        yield* requireUnfrozenPause(input);
        if (placement.operationId !== null) {
          const [move] = yield* sql<{
            phase: string;
          }>`SELECT phase FROM relay_thread_moves WHERE operation_id = ${placement.operationId}`;
          const [finalSave] = yield* sql<{
            phase: string;
          }>`SELECT phase FROM relay_thread_vm_final_saves WHERE operation_id=${placement.operationId}`;
          const enrolling = yield* sql`SELECT 1 FROM relay_thread_local_enrollments
            WHERE thread_id=${input.threadId} AND operation_id=${placement.operationId} AND phase='preparing'`;
          if (move?.phase !== "preparing" && finalSave?.phase !== "draining" && !enrolling.length)
            return yield* conflict("Source history is frozen for handoff");
        }
        const [tail] = yield* sql<{ cursor: number }>`SELECT cursor FROM relay_thread_history
          WHERE thread_id = ${input.threadId} ORDER BY cursor DESC LIMIT 1`;
        const [sourceTail] = yield* sql<{
          sourceSequence: number;
        }>`SELECT source_sequence AS "sourceSequence" FROM relay_thread_history
          WHERE thread_id = ${input.threadId} AND environment_id = ${input.environmentId} ORDER BY source_sequence DESC LIMIT 1`;
        if (sourceTail && input.event.sequence <= sourceTail.sourceSequence)
          return yield* conflict("History must be uploaded in source sequence order");
        const cursor = (tail?.cursor ?? 0) + 1;
        yield* sql`INSERT INTO relay_thread_history (thread_id, cursor, environment_id, source_sequence, event_json)
        VALUES (${input.threadId}, ${cursor}, ${input.environmentId}, ${input.event.sequence}, ${event}::jsonb)`;
        return cursor;
      }),
    );
  });
  const confirmThrough = Effect.fn("relay.thread_journal.confirm_through")(function* (
    input: Owner & { readonly sourceSequence: number },
  ) {
    if (!Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 0)
      return yield* conflict("Invalid history scan watermark");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* requireOwner(input);
        const [prior] = yield* sql<{ sourceSequence: number }>`SELECT
        source_sequence AS "sourceSequence" FROM relay_thread_history_watermarks
        WHERE thread_id = ${input.threadId} AND environment_id = ${input.environmentId}
          AND generation = ${input.generation}`;
        if (prior && prior.sourceSequence >= input.sourceSequence) return prior.sourceSequence;
        yield* requireLiveDisk(input);
        yield* requireUnfrozenPause(input);
        if (placement.operationId !== null) {
          const [move] = yield* sql<{ phase: string }>`SELECT phase FROM relay_thread_moves
          WHERE operation_id = ${placement.operationId}`;
          const [finalSave] = yield* sql<{
            phase: string;
          }>`SELECT phase FROM relay_thread_vm_final_saves WHERE operation_id=${placement.operationId}`;
          const enrolling = yield* sql`SELECT 1 FROM relay_thread_local_enrollments
            WHERE thread_id=${input.threadId} AND operation_id=${placement.operationId} AND phase='preparing'`;
          if (move?.phase !== "preparing" && finalSave?.phase !== "draining" && !enrolling.length)
            return yield* conflict("Source history is frozen for handoff");
        }
        const [tail] = yield* sql<{
          sourceSequence: number;
        }>`SELECT source_sequence AS "sourceSequence"
        FROM relay_thread_history WHERE thread_id = ${input.threadId}
          AND environment_id = ${input.environmentId}
        ORDER BY source_sequence DESC LIMIT 1`;
        if (tail && tail.sourceSequence > input.sourceSequence)
          return yield* conflict("History scan ends before its uploaded events");
        yield* sql`INSERT INTO relay_thread_history_watermarks
        (thread_id,environment_id,generation,source_sequence)
        VALUES (${input.threadId},${input.environmentId},${input.generation},${input.sourceSequence})
        ON CONFLICT(thread_id,environment_id,generation) DO UPDATE
        SET source_sequence = GREATEST(relay_thread_history_watermarks.source_sequence,
          excluded.source_sequence)`;
        return input.sourceSequence;
      }),
    );
  });
  const history = Effect.fn("relay.thread_journal.history")(function* (input: {
    readonly threadId: string;
    readonly after: number;
    readonly limit: number;
  }) {
    if (
      !Number.isSafeInteger(input.after) ||
      input.after < 0 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    )
      return yield* conflict("Invalid history page");
    return yield* sql<HistoryEntry>`SELECT cursor, environment_id AS "environmentId", event_json AS event
      FROM relay_thread_history WHERE thread_id = ${input.threadId} AND cursor > ${input.after} ORDER BY cursor LIMIT ${input.limit}`;
  });
  return { command, pending, stage, next, acknowledge, append, confirmThrough, history };
}
