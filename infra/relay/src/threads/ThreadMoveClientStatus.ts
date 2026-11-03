import { MessageId } from "@t3tools/contracts";
import type { RelayThreadActiveMove } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import { sourceMoveRetry } from "./ThreadMoveParticipantStatus.ts";
import type { ThreadMove } from "./ThreadPlacementStore.ts";

/** The caller holds the placement lock, including for legacy queue evidence. */
export const threadMoveClientStatus = Effect.fnUntraced(function* (
  sql: PgClient,
  move: ThreadMove,
) {
  const [kinds] = yield* sql<{ sourceIsVm: boolean; destinationIsVm: boolean }>`SELECT
    EXISTS (SELECT 1 FROM relay_thread_vm_bindings b WHERE b.thread_id=${move.threadId}
      AND b.environment_id=${move.sourceEnvironmentId} AND b.generation=${move.expectedGeneration}) AS "sourceIsVm",
    (${move.destinationEnvironmentId === `pending-vm:${move.operationId}`} OR EXISTS (
      SELECT 1 FROM relay_thread_vm_move_destinations d WHERE d.operation_id=${move.operationId}
    ) OR EXISTS (SELECT 1 FROM relay_thread_vm_bindings b WHERE b.thread_id=${move.threadId}
      AND b.environment_id=${move.destinationEnvironmentId} AND b.generation=${move.expectedGeneration + 1})) AS "destinationIsVm"`;
  let phase: RelayThreadActiveMove["phase"] = move.phase;
  let blocker: RelayThreadActiveMove["cancellationBlocker"] = move.cancellationBlocker ?? undefined;
  const cancel = move.legacyCancelCommandId
    ? yield* makeThreadJournalStore(sql).command(move.threadId, move.legacyCancelCommandId)
    : null;
  if (move.phase === "aborted") {
    if (move.cancellationProtocol === "source-reopen-v1" && !move.sourceReopened)
      phase = "reopening";
    else if (move.legacyCancelCommandId) {
      // Old workers accept the queue command only after reopening the source,
      // then finish the move. The mirror has to confirm both steps.
      const finished =
        cancel?.command.type === "thread.move.cancel" &&
        cancel.acceptedGeneration === move.expectedGeneration &&
        cancel.receipt?.status === "accepted" &&
        (yield* sql`SELECT 1 FROM relay_thread_history
          WHERE thread_id=${move.threadId} AND environment_id=${move.sourceEnvironmentId}
          AND source_sequence>=${cancel.receipt.sequence}
          AND event_json->>'type'='thread.prompt-queue-changed'
          AND event_json->'payload'->>'removedMessageId'=${cancel.command.messageId}
          AND starts_with(event_json->>'commandId', ${`${move.operationId}:finish:cancelled:`}) LIMIT 1`)
          .length > 0;
      if (!finished) phase = "reopening";
      if (cancel?.receipt?.status === "rejected") blocker = "legacy_cancel_rejected";
    }
  }
  const sourceMessageId =
    move.sourceMessageId ??
    (cancel?.command.type === "thread.move.cancel" ? cancel.command.messageId : undefined) ??
    (yield* sql<{
      messageId: string;
    }>`SELECT event_json->'payload'->'entry'->>'messageId' AS "messageId"
      FROM relay_thread_history WHERE thread_id=${move.threadId}
        AND environment_id=${move.sourceEnvironmentId}
        AND event_json->>'type'='thread.prompt-queue-changed'
        AND event_json->'payload'->'entry'->>'operationId'=${move.operationId}
      ORDER BY cursor DESC LIMIT 1`)[0]?.messageId;
  const retry = sourceMoveRetry(move);
  return {
    operationId: move.operationId,
    sourceEnvironmentId: move.sourceEnvironmentId,
    sourceGeneration: move.expectedGeneration,
    ...(sourceMessageId === undefined ? {} : { sourceMessageId: MessageId.make(sourceMessageId) }),
    sourceKind: kinds?.sourceIsVm ? "vm" : "environment",
    destinationEnvironmentId: move.destinationEnvironmentId,
    destinationProjectId: move.destinationProjectId,
    destinationKind: kinds?.destinationIsVm ? "vm" : "environment",
    phase,
    cancellationMode:
      move.cancellationProtocol === "source-reopen-v1" || move.cancellationProtocol === "available"
        ? "direct"
        : "legacy",
    ...(blocker ? { cancellationBlocker: blocker } : {}),
    ...(retry
      ? retry.requested
        ? { retryRequestedAttempt: retry.attempt }
        : { retryRequiredAttempt: retry.attempt }
      : {}),
  } satisfies RelayThreadActiveMove;
});
