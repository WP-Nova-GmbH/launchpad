import { CommandId, OrchestrationSession, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { checkpointPublicationOperationId } from "./ThreadCheckpointIntent.ts";
import { makeThreadNativeCheckpoint, threadCheckpointId } from "./ThreadNativeCheckpoint.ts";
import { makeThreadAttachmentCheckpoint } from "./ThreadAttachmentCheckpoint.ts";
import type { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import type { makeThreadHistorySync, ThreadHistoryOwner } from "./ThreadHistorySync.ts";
import { ThreadExecutionFenceError } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadTransferSource } from "./ThreadTransferSource.ts";

import { assertThreadVmQueueIdle } from "./ThreadVmQueueActivity.ts";
import { ThreadExecution } from "./ThreadExecution.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";

const decodeSession = Schema.decodeUnknownEffect(OrchestrationSession);

/** Stop and retain one exact conversation before either pause or final disk saving. */
export const makeThreadVmSourceRecovery = Effect.fn("ThreadVmSourceRecovery.make")(function* (
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
) {
  const sql = yield* SqlClient.SqlClient,
    provider = yield* ProviderService,
    engine = yield* OrchestrationEngineService,
    events = yield* OrchestrationEventStore,
    terminals = yield* TerminalManager,
    execution = yield* ThreadExecution,
    tracked = yield* VmWorkloadTracking;
  const fences = makeThreadExecutionFence(sql),
    native = makeThreadNativeCheckpoint(sql),
    attachments = makeThreadAttachmentCheckpoint(sql, events),
    source = makeThreadTransferSource(sql, events, provider);
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof source.freeze>>>();
  const capture = Effect.fn("ThreadVmSourceRecovery.capture")(function* (
    input: ThreadHistoryOwner & {
      readonly operationId: string;
      readonly previousOperationId: string;
    },
  ) {
    const threadId = input.threadId;
    const fail = (threadId: string, detail: string) =>
      new ThreadExecutionFenceError({ threadId, detail });
    let owner = yield* fences.get(threadId);
    if (
      !owner ||
      owner.environmentId !== input.environmentId ||
      owner.generation !== input.generation
    )
      return yield* fail(threadId, "VM recovery belongs to another source.");
    if (owner.phase === "active") {
      if (owner.operationId !== input.previousOperationId)
        return yield* fail(
          threadId,
          "Source ownership changed while the relay recovery state was read.",
        );
      yield* fences.beginDrain(input);
      owner = (yield* fences.get(threadId))!;
    }
    if (owner.operationId !== input.operationId || !["draining", "frozen"].includes(owner.phase))
      return yield* fail(threadId, "Another operation holds this source.");
    yield* assertThreadVmQueueIdle(sql, threadId);
    const unsettled = yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${threadId}
      AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
      UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
        AND (kind='workspace' OR (${!tracked} AND kind!='provider') OR completed=1)
          AND (completed=0 OR relay_completed=0) LIMIT 1`;
    if (unsettled.length) return;
    // Routine recovery must not close a shell or interrupt detached work that
    // raced the relay idle report. No live guest workload is evidence of idleness.
    if (tracked && !(yield* inspectVmWorkloads({ type: "inspect" })).stopped) {
      if (
        !provider.stopIdleVmSession ||
        !(yield* provider.stopIdleVmSession({
          threadId: ThreadId.make(threadId),
          environmentId: input.environmentId,
          generation: input.generation,
          operationId: input.operationId,
        }))
      )
        return;
      if (!(yield* inspectVmWorkloads({ type: "inspect" })).stopped) return;
    }
    const [runtime] = yield* sql<{
      status: string;
    }>`SELECT status FROM provider_session_runtime WHERE thread_id=${threadId}`;
    if (!runtime)
      return yield* fail(threadId, "Saving VM recovery needs a retained Codex conversation.");
    const providerWork = yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
      AND generation=${owner.generation} AND kind='provider' AND completed=0 LIMIT 1`;
    if (
      providerWork.length ||
      runtime.status !== "stopped" ||
      (yield* provider.listSessions()).some((s) => s.threadId === threadId)
    )
      yield* provider.stopSession({ threadId: ThreadId.make(threadId) });
    if (!provider.flushRuntimeEvents)
      return yield* fail(threadId, "Stopped provider output has not been confirmed.");
    yield* provider.flushRuntimeEvents(ThreadId.make(threadId));
    const [session] =
      yield* sql`SELECT thread_id AS "threadId",status,provider_name AS "providerName",provider_instance_id AS "providerInstanceId",runtime_mode AS "runtimeMode",active_turn_id AS "activeTurnId",last_error AS "lastError",updated_at AS "updatedAt" FROM projection_thread_sessions WHERE thread_id=${threadId}`;
    if (session && session.status !== "stopped") {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.session.set",
        threadId: ThreadId.make(threadId),
        commandId: CommandId.make(`${input.operationId}:vm-recovery-stopped`),
        createdAt: at,
        session: yield* decodeSession({
          ...session,
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        }),
      });
    }
    yield* terminals.close({ threadId: ThreadId.make(threadId), waitForProcessExit: true });
    if (tracked && !(yield* inspectVmWorkloads({ type: "inspect" })).stopped) return;
    yield* execution.confirmProcessesStopped(threadId, tracked ? "vm" : "provider");
    const frozen = yield* source
      .freeze({ ...input, requireIdleQueue: true })
      .pipe(Effect.provideContext(context));
    if (!frozen.nativeCheckpointTurnId)
      return yield* fail(threadId, "Frozen native recovery is unavailable.");
    yield* history.synchronize(threadId);
    yield* checkpoints.synchronize(threadId, input.operationId);
    const key = threadCheckpointId(frozen.nativeCheckpointTurnId, input.operationId);
    const point = yield* native.get(threadId, owner.generation, key),
      chat = yield* attachments.get(threadId, owner.generation, key);
    if (!point?.publishedArtifactId || !chat?.publishedArtifactId) return;
    const nativeCheckpointOperationId = checkpointPublicationOperationId(
      "launchpad-native-checkpoint-v1",
      threadId,
      owner.generation,
      frozen.nativeCheckpointTurnId,
      point,
    );
    return { sourceSequence: frozen.sourceSequence, nativeCheckpointOperationId };
  });
  return { capture };
});
