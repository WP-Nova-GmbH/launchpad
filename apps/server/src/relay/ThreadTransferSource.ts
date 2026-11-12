import { assertWorkflowThreadReleased } from "../persistence/WorkflowThreadOwnership.ts";
import { ThreadId, TurnId, ThreadPromptQueue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { makeThreadNativeCheckpoint, threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import {
  makeThreadAttachmentCheckpoint,
  verifyThreadAttachmentCheckpointArchive,
} from "./ThreadAttachmentCheckpoint.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";

import { assertThreadVmQueueIdle } from "./ThreadVmQueueActivity.ts";

const decodeQueue = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadPromptQueue));

/** The internal coordinator must already own a draining fence and stop the
 * provider/terminals through their receipt-backed paths. This never interrupts
 * work or releases ownership; external workspace writers must be quiesced too.
 */
export function makeThreadTransferSource(
  sql: SqlClient.SqlClient,
  events: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
  provider: Pick<ProviderServiceShape, "listSessions" | "checkpointConversation">,
) {
  const fences = makeThreadExecutionFence(sql),
    native = makeThreadNativeCheckpoint(sql),
    attachments = makeThreadAttachmentCheckpoint(sql, events);
  const freeze = Effect.fn("ThreadTransferSource.freeze")(function* (input: {
    readonly threadId: string;
    readonly environmentId: string;
    readonly generation: number;
    readonly operationId: string;
    readonly requireIdleQueue?: boolean;
  }) {
    const fail = (detail: string) =>
      new ThreadExecutionFenceError({ threadId: input.threadId, detail });
    yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
      Effect.mapError((error) => fail(error.message)),
    );
    const fence = yield* fences.get(input.threadId);
    if (
      !fence ||
      fence.generation !== input.generation ||
      fence.environmentId !== input.environmentId ||
      fence.operationId !== input.operationId ||
      !["draining", "frozen"].includes(fence.phase)
    )
      return yield* fail("The source coordinator does not own this drain operation.");
    const pending = yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${input.threadId}
      AND (completed=0 OR relay_completed=0) LIMIT 1`;
    const turns = yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${input.threadId}
      AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending') LIMIT 1`;
    if (pending.length || turns.length)
      return yield* fail(
        "Source work and its recovery checkpoint must settle and be acknowledged before freezing.",
      );
    const [queueRow] = yield* sql<{
      state: string;
    }>`SELECT state_json AS state FROM projection_thread_prompt_queues WHERE thread_id=${input.threadId}`;
    if (queueRow) {
      const queue = yield* decodeQueue(queueRow.state);
      if (
        queue.handoff ||
        queue.awaitingTurnId ||
        (queue.preparation && (queue.preparation.state !== "ready" || !queue.preparation.settled))
      )
        return yield* fail("Source queue delivery or setup still needs to settle.");
    }
    const [runtime] = yield* sql<{
      provider: string;
      status: string;
    }>`SELECT adapter_key AS provider, status FROM provider_session_runtime WHERE thread_id=${input.threadId}`;
    if (runtime && (runtime.provider !== "codex" || runtime.status !== "stopped"))
      return yield* fail("Stop the source Codex session before freezing its native conversation.");
    if ((yield* provider.listSessions()).some((session) => session.threadId === input.threadId))
      return yield* fail("The source provider still has a live session.");
    const [settled] = yield* sql<{
      turnId: string;
    }>`SELECT turn_id AS "turnId" FROM projection_turns
      WHERE thread_id=${input.threadId} AND completed_at IS NOT NULL AND state NOT IN ('pending','running')
      AND turn_id IS NOT NULL ORDER BY requested_at DESC,row_id DESC LIMIT 1`;
    if (runtime && (!settled || !provider.checkpointConversation))
      return yield* fail("The source has no supported settled native conversation to retain.");
    if (yield* VmWorkloadTracking) {
      const inventory = yield* inspectVmWorkloads({ type: "inspect" });
      if (!inventory.stopped)
        return yield* fail("VM workspace processes must stop before freezing.");
      const sealed = yield* inspectVmWorkloads({
        type: "seal",
        bootId: inventory.bootId,
        operationId: input.operationId,
      });
      if (!sealed.stopped || sealed.bootId !== inventory.bootId)
        return yield* fail("VM workspace processes changed while sealing the source.");
    }
    const sourceSequence = yield* sql.withTransaction(
      Effect.gen(function* () {
        if (input.requireIdleQueue) yield* assertThreadVmQueueIdle(sql, input.threadId);
        return yield* fences.freeze(input);
      }),
    );
    const [frozenHead] = yield* sql<{
      sequence: number;
    }>`SELECT COALESCE(MAX(sequence),0) AS sequence
      FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${input.threadId}`;
    if (frozenHead?.sequence !== sourceSequence)
      return yield* fail(
        "Source history changed after freezing; reconcile the late event before exporting.",
      );
    if (!runtime) return { sourceSequence, nativeCheckpointTurnId: null };
    const turnId = settled!.turnId;
    yield* provider.checkpointConversation!({
      threadId: ThreadId.make(input.threadId),
      turnId: TurnId.make(turnId),
      captureOperationId: input.operationId,
    });
    const key = threadCheckpointId(turnId, input.operationId);
    const point = yield* native.get(input.threadId, input.generation, key),
      chat = yield* attachments.get(input.threadId, input.generation, key);
    const current = yield* fences.get(input.threadId);
    const [head] = yield* sql<{ sequence: number }>`SELECT COALESCE(MAX(sequence),0) AS sequence
      FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${input.threadId}`;
    if (
      !point ||
      !chat ||
      point.turnId !== turnId ||
      point.captureOperationId !== input.operationId ||
      point.environmentId !== input.environmentId ||
      chat.environmentId !== input.environmentId ||
      point.sourceSequence !== sourceSequence ||
      chat.sourceSequence !== sourceSequence ||
      current?.phase !== "frozen" ||
      current.operationId !== input.operationId ||
      current.generation !== input.generation ||
      current.frozenSequence !== sourceSequence ||
      head?.sequence !== sourceSequence
    )
      return yield* fail(
        "The complete source recovery point does not match the frozen ownership and history.",
      );
    yield* verifyThreadAttachmentCheckpointArchive(chat, input.threadId);
    return { sourceSequence, nativeCheckpointTurnId: turnId };
  });
  return { freeze };
}
