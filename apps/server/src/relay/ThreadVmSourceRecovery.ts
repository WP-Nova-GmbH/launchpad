import * as NodeCrypto from "node:crypto";
import { CommandId, OrchestrationSession, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
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
import { requireWorkflowVmLifecycleCheckpoint } from "../persistence/WorkflowThreadOwnership.ts";
import { makeThreadTransferSource } from "./ThreadTransferSource.ts";

import { assertThreadVmQueueIdle, ThreadVmQueuedWork } from "./ThreadVmQueueActivity.ts";
import { ThreadExecution } from "./ThreadExecution.ts";
import {
  inspectVmWorkloads,
  recoverIdleWorkflowVmStop,
  stopPassiveWorkflowVmSetup,
  type VmWorkloadInventory,
} from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import { adoptWorkflowVmCancellationSeal } from "./WorkflowVmCancellation.ts";
import { collectThreadAttachmentReferences } from "./ThreadAttachmentReferences.ts";

const decodeSession = Schema.decodeUnknownEffect(OrchestrationSession);

class FinishedWorkflowCaptureUnavailable extends Schema.TaggedError<FinishedWorkflowCaptureUnavailable>()(
  "FinishedWorkflowCaptureUnavailable",
  { threadId: Schema.String },
) {}

/** Stop and retain one exact conversation before either pause or final disk saving. */
export const makeThreadVmSourceRecovery = Effect.fn("ThreadVmSourceRecovery.make")(function* (
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
  readBackgroundRevision?: (
    inventory: typeof VmWorkloadInventory.Type,
  ) => Effect.Effect<string | undefined>,
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
      readonly workflowCheckpoint?: RelayThreadVmWorkflowCheckpoint;
    },
  ) {
    const threadId = input.threadId;
    const fail = (threadId: string, detail: string) =>
      new ThreadExecutionFenceError({ threadId, detail });
    const workflow = input.workflowCheckpoint
      ? yield* requireWorkflowVmLifecycleCheckpoint(sql, {
          ...input,
          workflowCheckpoint: input.workflowCheckpoint,
        }).pipe(Effect.mapError((error) => fail(threadId, error.message)))
      : null;
    const finishedWorkflow = input.workflowCheckpoint?.finishedWorkspaceRevision !== undefined;
    const cancelledWorkflow = finishedWorkflow && workflow?.status === "cancelled";
    const cancellationReclaim =
      cancelledWorkflow && input.workflowCheckpoint?.backgroundRevision === undefined;
    const operationSeal = finishedWorkflow
      ? NodeCrypto.createHash("sha256").update(input.operationId).digest("hex").slice(0, 32)
      : undefined;
    let owner = yield* fences.get(threadId);
    if (
      !owner ||
      owner.environmentId !== input.environmentId ||
      owner.generation !== input.generation
    )
      return yield* fail(threadId, "VM recovery belongs to another source.");
    if (owner.phase === "active") {
      if (
        (yield* sql`SELECT 1 FROM workflow_result_outbox WHERE thread_id=${threadId} AND status!='acknowledged' LIMIT 1`)
          .length
      )
        return yield* fail(
          threadId,
          "Save the pending workflow result before freezing or discarding this workspace.",
        );
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
    // Transferring a cancellation seal requires closing local admission first.
    if (tracked && owner.phase === "draining" && (!workflow || cancellationReclaim))
      yield* adoptWorkflowVmCancellationSeal(sql, input);
    const cancellationInventory =
      tracked && cancellationReclaim ? yield* inspectVmWorkloads({ type: "inspect" }) : null;
    const adoptedCancellationSeal =
      cancellationInventory?.stopped === true && cancellationInventory.sealedBy === operationSeal;
    const checkpointlessCancellation =
      adoptedCancellationSeal && workflow?.cancelledBeforeNativeTurn === true;
    const holdCancelledWorkspace = (error: ThreadVmQueuedWork) =>
      adoptedCancellationSeal
        ? fail(threadId, "The cancelled VM still has queued work to reconcile before saving.")
        : error;
    yield* assertThreadVmQueueIdle(sql, threadId).pipe(
      Effect.catchTag("ThreadVmQueuedWork", (error) => Effect.fail(holdCancelledWorkspace(error))),
    );
    const unsettled = yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${threadId}
      AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
      UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
        AND (kind='workspace' OR (${!tracked} AND kind!='provider') OR completed=1)
          AND (completed=0 OR relay_completed=0) LIMIT 1`;
    if (unsettled.length) return;
    // Routine recovery must not interrupt work that raced the relay idle report.
    let beforeStop =
      cancellationInventory ?? (tracked ? yield* inspectVmWorkloads({ type: "inspect" }) : null);
    const checkIdleStopRollback = Effect.fnUntraced(function* (
      before: typeof VmWorkloadInventory.Type,
      current: typeof VmWorkloadInventory.Type,
    ) {
      if (before.sealedBy !== null && before.sealedBy !== operationSeal) return;
      // A rejected native stop restores the original open epoch. A normal reopen increments it.
      const openEpoch = before.epoch - (before.sealedBy === null ? 0 : 1);
      if (
        current.bootId === before.bootId &&
        current.epoch === openEpoch &&
        current.sealedBy === null
      )
        return yield* new ThreadVmQueuedWork({ threadId });
    });
    const assertEmptyRevision = Effect.fnUntraced(function* (
      inventory: typeof VmWorkloadInventory.Type,
    ) {
      const revision = input.workflowCheckpoint?.backgroundRevision;
      // An independent exit has no native stop receipt tied to the reserved idle revision.
      if (
        inventory.stopped &&
        inventory.sealedBy === null &&
        revision !== undefined &&
        (!readBackgroundRevision || (yield* readBackgroundRevision(inventory)) !== revision)
      )
        return yield* new ThreadVmQueuedWork({ threadId });
    });
    if (
      beforeStop &&
      finishedWorkflow &&
      owner.phase === "draining" &&
      !(yield* provider.listSessions()).some((session) => session.threadId === threadId)
    ) {
      // After a coordinator restart only the privileged journal can identify the old stop.
      // A live runtime still owns its handshake and notification drain.
      const receipt = yield* recoverIdleWorkflowVmStop(input.operationId, beforeStop);
      const current = yield* inspectVmWorkloads({ type: "inspect" });
      if (receipt === "rejected") return yield* checkIdleStopRollback(beforeStop, current);
      if (
        !current.stopped ||
        current.bootId !== beforeStop.bootId ||
        current.epoch !== beforeStop.epoch ||
        current.sealedBy !== beforeStop.sealedBy ||
        (current.sealedBy !== null && current.sealedBy !== operationSeal) ||
        (receipt === "reserved" && current.sealedBy !== operationSeal)
      )
        return;
      beforeStop = current;
    }
    if (beforeStop) yield* assertEmptyRevision(beforeStop);
    if (beforeStop && !beforeStop.stopped) {
      if (workflow && !finishedWorkflow) {
        // Only the authenticated passive setup supervisor may be closed here.
        // Any recipe, terminal, provider or detached work still blocks capture.
        if (yield* Effect.isFailure(stopPassiveWorkflowVmSetup())) return;
      } else {
        if (!provider.stopIdleVmSession) return;
        const stopped = yield* provider.stopIdleVmSession({
          threadId: ThreadId.make(threadId),
          environmentId: input.environmentId,
          generation: input.generation,
          operationId: input.operationId,
          ...(input.workflowCheckpoint?.backgroundRevision
            ? { backgroundRevision: input.workflowCheckpoint.backgroundRevision }
            : {}),
        });
        if (!stopped) {
          if (!finishedWorkflow) return;
          return yield* checkIdleStopRollback(
            beforeStop,
            yield* inspectVmWorkloads({ type: "inspect" }),
          );
        }
      }
      if (!(yield* inspectVmWorkloads({ type: "inspect" })).stopped) return;
    }
    const [runtime] = yield* sql<{
      status: string;
    }>`SELECT status FROM provider_session_runtime WHERE thread_id=${threadId}`;
    if (!runtime && !workflow?.beforeAgent) {
      if (finishedWorkflow && !adoptedCancellationSeal)
        return yield* new FinishedWorkflowCaptureUnavailable({ threadId });
      return yield* fail(threadId, "Saving VM recovery needs a retained Codex conversation.");
    }
    if (
      !runtime &&
      !checkpointlessCancellation &&
      (yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${threadId} LIMIT 1`).length
    )
      return yield* fail(threadId, "The workflow already has a conversation to retain.");
    const providerWork = yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
      AND generation=${owner.generation} AND kind='provider' AND completed=0 LIMIT 1`;
    if (
      runtime &&
      (providerWork.length ||
        runtime.status !== "stopped" ||
        (yield* provider.listSessions()).some((s) => s.threadId === threadId))
    )
      yield* provider.stopSession({ threadId: ThreadId.make(threadId) });
    if (runtime) {
      if (!provider.flushRuntimeEvents)
        return yield* fail(threadId, "Stopped provider output has not been confirmed.");
      yield* provider.flushRuntimeEvents(ThreadId.make(threadId));
    }
    const [session] =
      yield* sql`SELECT thread_id AS "threadId",status,provider_name AS "providerName",provider_instance_id AS "providerInstanceId",runtime_mode AS "runtimeMode",active_turn_id AS "activeTurnId",last_error AS "lastError",updated_at AS "updatedAt" FROM projection_thread_sessions WHERE thread_id=${threadId}`;
    if (runtime && session && session.status !== "stopped") {
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
    if (tracked) {
      const inventory = yield* inspectVmWorkloads({ type: "inspect" });
      if (!inventory.stopped) return;
      yield* assertEmptyRevision(inventory);
    }
    yield* execution.confirmProcessesStopped(threadId, tracked ? "vm" : "provider");
    if (
      runtime &&
      adoptedCancellationSeal &&
      workflow?.cancelledWithoutNativeCheckpoint &&
      input.workflowCheckpoint
    ) {
      const workflowCheckpoint = input.workflowCheckpoint;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const latest = yield* requireWorkflowVmLifecycleCheckpoint(sql, {
            ...input,
            workflowCheckpoint,
          }).pipe(Effect.mapError((error) => fail(threadId, error.message)));
          if (!latest.cancelledWithoutNativeCheckpoint)
            return yield* fail(threadId, "A native turn needs recovery before saving this VM.");
          const [stopped] = yield* sql`SELECT 1 FROM provider_session_runtime
            WHERE thread_id=${threadId} AND provider_name='codex' AND adapter_key='codex'
              AND provider_instance_id='codex' AND status='stopped'
              AND json_extract(runtime_payload_json,'$.providerContinuation.workflowJobId')=${workflowCheckpoint.jobId}
              AND json_type(runtime_payload_json,'$.providerContinuation.shutdownConfirmed')='true'
              AND json_extract(runtime_payload_json,'$.providerContinuation.shutdownEvidenceVersion')=2
              AND json_type(runtime_payload_json,'$.stoppedRuntimeEventsDrained')='true'
              AND EXISTS(SELECT 1 FROM thread_execution_fences WHERE thread_id=${threadId}
                AND environment_id=${input.environmentId} AND generation=${input.generation}
                AND operation_id=${input.operationId} AND phase='draining')`;
          if (!stopped)
            return yield* fail(threadId, "The cancelled Codex startup is not confirmed stopped.");
          // A send may have reached Codex even when no turn was published. The
          // warm native pause retains that runtime and its files for follow-up.
          if (!latest.cancelledBeforeNativeTurn)
            return yield* new FinishedWorkflowCaptureUnavailable({ threadId });
          // Only startup without a send can use the checkpoint-less cold backup.
          yield* sql`DELETE FROM provider_session_runtime WHERE thread_id=${threadId}`;
        }),
      );
    }
    const frozen = yield* source
      .freeze({
        ...input,
        requireIdleQueue: true,
        ...(cancelledWorkflow ? { allowSettledCancelledSetup: true as const } : {}),
      })
      .pipe(
        Effect.provideContext(context),
        Effect.catchTag("ThreadVmQueuedWork", (error) =>
          Effect.fail(holdCancelledWorkspace(error)),
        ),
      );
    if (workflow && workflow.sourceSequence > frozen.sourceSequence)
      return yield* fail(threadId, "The saved workflow is newer than the frozen source.");
    if (!frozen.nativeCheckpointTurnId) {
      if (!workflow?.beforeAgent) {
        if (finishedWorkflow && !adoptedCancellationSeal)
          return yield* new FinishedWorkflowCaptureUnavailable({ threadId });
        return yield* fail(threadId, "Frozen native recovery is unavailable.");
      }
      const references = yield* collectThreadAttachmentReferences(
        threadId,
        events.readAggregateRange({
          aggregateKind: "thread",
          aggregateId: threadId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: frozen.sourceSequence,
          limit: Number.MAX_SAFE_INTEGER,
        }),
      );
      if (references.length)
        return yield* fail(
          threadId,
          "The pre-Agent workflow has attachments without a recovery archive.",
        );
    }
    yield* history.synchronize(threadId);
    let nativeCheckpointOperationId: string | null = null;
    if (frozen.nativeCheckpointTurnId) {
      yield* checkpoints.synchronize(threadId, input.operationId);
      const key = threadCheckpointId(frozen.nativeCheckpointTurnId, input.operationId);
      const point = yield* native.get(threadId, owner.generation, key),
        chat = yield* attachments.get(threadId, owner.generation, key);
      if (!point?.publishedArtifactId || !chat?.publishedArtifactId) return;
      nativeCheckpointOperationId = checkpointPublicationOperationId(
        "launchpad-native-checkpoint-v1",
        threadId,
        owner.generation,
        frozen.nativeCheckpointTurnId,
        point,
      );
    }
    if (!tracked) return yield* fail(threadId, "Native VM snapshots require tracked workloads.");
    const inventory = yield* inspectVmWorkloads({ type: "inspect" });
    if (!inventory.stopped) return yield* fail(threadId, "VM workloads did not remain stopped.");
    const seal = yield* inspectVmWorkloads({
      type: "seal",
      bootId: inventory.bootId,
      operationId: input.operationId,
    });
    return {
      sourceSequence: frozen.sourceSequence,
      nativeCheckpointOperationId,
      bootId: seal.bootId,
      sealEpoch: seal.epoch,
    };
  });
  const captureNative = Effect.fn("ThreadVmSourceRecovery.captureNative")(function* (
    input: ThreadHistoryOwner & {
      readonly operationId: string;
      readonly previousOperationId: string;
    },
  ) {
    const point = yield* capture(input);
    if (!point) return;
    if (!point.nativeCheckpointOperationId)
      return yield* new ThreadExecutionFenceError({
        threadId: input.threadId,
        detail: "Frozen native recovery is unavailable.",
      });
    return { ...point, nativeCheckpointOperationId: point.nativeCheckpointOperationId };
  });
  return { capture: captureNative, captureForPause: capture };
});
