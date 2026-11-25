import * as NodeCrypto from "node:crypto";
import { ThreadId } from "@t3tools/contracts";
import { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { readWorkflowVmBackgroundRevision } from "../provider/workflowVmBackgroundActivity.ts";
import {
  inspectVmWorkloads,
  recoverIdleWorkflowVmStop,
  type VmWorkloadInventory,
} from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import type { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import type { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import { ThreadPauseError, type ThreadPauseTransport } from "./ThreadPauseTransport.ts";
import { ThreadVmQueuedWork } from "./ThreadVmQueueActivity.ts";
import { makeThreadVmSourceRecovery } from "./ThreadVmSourceRecovery.ts";

const sameWorkflowCheckpoint = Schema.toEquivalence(
  Schema.UndefinedOr(RelayThreadVmWorkflowCheckpoint),
);

export const makeThreadPauseWorker = Effect.fn("ThreadPauseWorker.make")(function* (
  transport: ThreadPauseTransport,
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
  stateDir: string,
) {
  const sql = yield* SqlClient.SqlClient,
    fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    background = yield* ThreadBackgroundLivenessService,
    provider = yield* ProviderService,
    tracked = yield* VmWorkloadTracking;
  const readBackgroundRevision = (inventory: typeof VmWorkloadInventory.Type) =>
    readWorkflowVmBackgroundRevision(fs, path, stateDir, inventory);
  const fences = makeThreadExecutionFence(sql),
    recovery = yield* makeThreadVmSourceRecovery(history, checkpoints, readBackgroundRevision);
  const synchronize = Effect.fn("ThreadPauseWorker.synchronize")(function* (threadId: string) {
    const owner = yield* fences.get(threadId);
    if (!owner || owner.phase === "retired") return;
    const pause = yield* transport.get(owner);
    if (!pause) return;
    const fail = (detail: string) => new ThreadPauseError({ threadId, detail });
    if (
      pause.threadId !== threadId ||
      pause.environmentId !== owner.environmentId ||
      pause.generation !== owner.generation
    )
      return yield* fail("Pause belongs to another VM source.");
    const input = {
      ...owner,
      operationId: pause.operationId,
      ...(pause.workflowCheckpoint ? { workflowCheckpoint: pause.workflowCheckpoint } : {}),
    };
    // After a reopened pause, a later relay operation makes canActivate false.
    // Its historical receipt must let final saving install the next local drain.
    if (
      pause.phase === "completed" &&
      ((owner.operationId !== pause.operationId &&
        (!pause.workflowCheckpoint || !pause.canActivate)) ||
        (pause.sourceReopened && owner.phase === "active"))
    )
      return;
    if (pause.canActivate) {
      if (owner.operationId !== pause.operationId && !pause.workflowCheckpoint) {
        // A Send may cancel the relay reservation before this server sees it.
        // Install that exact operation locally before acknowledging reopening;
        // a delayed pending receipt then cannot start the same drain again.
        if (
          pause.phase !== "cancelled" ||
          pause.sourceReopened ||
          pause.sourceSequence !== null ||
          owner.phase !== "active"
        )
          return;
        yield* fences.beginDrain({ ...input, previousOperationId: owner.operationId });
      }
      if (
        owner.phase !== "active" ||
        (!pause.workflowCheckpoint && owner.operationId !== pause.operationId)
      ) {
        if (!["active", "draining", "frozen"].includes(owner.phase)) return;
        if (tracked) {
          let inventory: typeof VmWorkloadInventory.Type | undefined;
          if (
            pause.phase === "cancelled" &&
            pause.sourceSequence === null &&
            pause.workflowCheckpoint?.finishedWorkspaceRevision !== undefined &&
            owner.operationId === pause.operationId &&
            owner.phase === "draining"
          ) {
            const live = (yield* provider.listSessions()).some(
              (session) => session.threadId === threadId,
            );
            const id = ThreadId.make(threadId);
            const stop = provider.stopIdleVmSession;
            if (live && !stop) return yield* fail("The provider cannot reconcile its idle stop.");
            const drained =
              live && stop
                ? yield* stop({
                    threadId: id,
                    environmentId: owner.environmentId,
                    generation: owner.generation,
                    operationId: pause.operationId,
                    recoverOnly: true,
                  })
                : false;
            const before = yield* inspectVmWorkloads({ type: "inspect" });
            const seal = NodeCrypto.createHash("sha256")
              .update(pause.operationId)
              .digest("hex")
              .slice(0, 32);
            if (before.sealedBy !== null && before.sealedBy !== seal)
              return yield* fail("Another operation owns the VM workload gate.");
            const receipt = yield* recoverIdleWorkflowVmStop(pause.operationId, before);
            const current = yield* inspectVmWorkloads({ type: "inspect" });
            const rejected = receipt === "rejected";
            const epoch = before.epoch - (rejected && before.sealedBy === seal ? 1 : 0);
            if (
              current.bootId !== before.bootId ||
              current.epoch !== epoch ||
              current.sealedBy !== (rejected ? null : before.sealedBy) ||
              (receipt === "reserved" && current.sealedBy !== seal)
            )
              return yield* fail("The VM workload gate changed during idle stop recovery.");
            if (receipt === "reserved" && !current.stopped) return;
            if (receipt === "reserved" && !drained) {
              const readWriter = () => sql<{ episode: string; drained: number | null }>`SELECT
                json_extract(runtime_payload_json,'$.providerContinuation.runtimeEpisode') AS episode,
                status='stopped' AND json_type(runtime_payload_json,'$.stoppedRuntimeEventsDrained')='true' AS drained
                FROM provider_session_runtime WHERE thread_id=${threadId}
                  AND provider_name='codex' AND provider_instance_id='codex' AND adapter_key='codex'
                  AND json_valid(runtime_payload_json)
                  AND json_type(runtime_payload_json,'$.providerContinuation.continuationKey')='text'
                  AND json_type(runtime_payload_json,'$.providerContinuation.runtimeEpisode')='text'`;
              const [writer] = yield* readWriter();
              if (!writer?.episode) return yield* fail("The stopped Codex episode is unavailable.");
              if (writer.drained !== 1) {
                // The adapter may still be draining after it stops advertising the session.
                // A new coordinator can flush its own queue without proving the old writer drained.
                yield* provider.stopSession({ threadId: id });
                const [stopped] = yield* readWriter();
                if (stopped?.episode !== writer.episode || stopped.drained !== 1)
                  return yield* fail("Stopped provider output has not been confirmed.");
              }
            }
            if (drained || receipt === "reserved") {
              if (!provider.flushRuntimeEvents)
                return yield* fail("Stopped provider output has not been confirmed.");
              yield* provider.flushRuntimeEvents(id);
            }
            inventory = current;
          }
          inventory ??= yield* inspectVmWorkloads({ type: "inspect" });
          if (inventory.sealedBy !== null)
            yield* inspectVmWorkloads({
              type: "reopen",
              bootId: inventory.bootId,
              operationId: pause.operationId,
            });
        }
        yield* fences.activate(input);
      } else if (pause.workflowCheckpoint) yield* fences.activate(input);
      // Persist the local active fence first. A lost relay read/ack must not let
      // a subsequent pause overwrite the only operation that can reopen it.
      if (!pause.sourceReopened) {
        const receipt = yield* transport.activate(input, { operationId: pause.operationId });
        if (
          receipt.operationId !== pause.operationId ||
          receipt.threadId !== threadId ||
          receipt.environmentId !== owner.environmentId ||
          receipt.generation !== owner.generation ||
          !sameWorkflowCheckpoint(receipt.workflowCheckpoint, pause.workflowCheckpoint) ||
          !receipt.canActivate ||
          !receipt.sourceReopened
        )
          return yield* fail("Relay acknowledged a different pause activation.");
      }
      return;
    }
    if (pause.phase === "cancelled") return;
    if (
      pause.nativeCheckpointOperationId !== null ||
      pause.sourceSequence !== null ||
      pause.phase !== "pending"
    ) {
      if (owner.operationId !== pause.operationId || owner.phase !== "frozen")
        return yield* fail("Pause has no matching frozen source.");
      return;
    }
    if (!tracked) return yield* fail("Pause requires a tracked VM workload boundary.");
    // The offline activity probe cannot see the server's in-memory task registry.
    const capture = Effect.gen(function* () {
      if (
        owner.phase === "active" &&
        pause.workflowCheckpoint?.finishedWorkspaceRevision !== undefined
      ) {
        if (background.getThreadBackgroundLiveness(threadId))
          return yield* new ThreadVmQueuedWork({ threadId });
        const revision = pause.workflowCheckpoint.backgroundRevision;
        if (revision !== undefined) {
          const workloads = yield* inspectVmWorkloads({ type: "inspect" });
          const current = yield* readBackgroundRevision(workloads);
          if (current !== revision) return yield* new ThreadVmQueuedWork({ threadId });
        }
      }
      return yield* recovery.captureForPause({ ...input, previousOperationId: owner.operationId });
    });
    const point = yield* capture.pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "ThreadVmQueuedWork" ||
          error._tag === "FinishedWorkflowCaptureUnavailable",
        (error) =>
          transport
            .cancel(input, {
              operationId: pause.operationId,
              ...(error._tag === "FinishedWorkflowCaptureUnavailable"
                ? { nativePauseFallback: true as const }
                : {}),
            })
            .pipe(
              Effect.flatMap((receipt) => {
                if (
                  receipt.operationId !== pause.operationId ||
                  receipt.threadId !== threadId ||
                  receipt.environmentId !== owner.environmentId ||
                  receipt.generation !== owner.generation ||
                  receipt.phase !== "cancelled" ||
                  !receipt.canActivate
                )
                  return fail("Relay acknowledged a different pause cancellation.");
                // A subsequent synchronize persists activation, then acknowledges reopening.
                return Effect.succeed(undefined);
              }),
            ),
      ),
    );
    if (!point) return;
    const receipt = yield* transport.freeze(input, {
      operationId: pause.operationId,
      nativeCheckpointOperationId: point.nativeCheckpointOperationId,
      ...(pause.workflowCheckpoint
        ? {
            workflowCheckpoint: pause.workflowCheckpoint,
            sourceSequence: point.sourceSequence,
          }
        : {}),
      bootId: point.bootId,
      sealEpoch: point.sealEpoch,
    });
    if (
      receipt.threadId !== threadId ||
      receipt.environmentId !== owner.environmentId ||
      receipt.generation !== owner.generation ||
      receipt.operationId !== pause.operationId ||
      receipt.nativeCheckpointOperationId !== point.nativeCheckpointOperationId ||
      (pause.workflowCheckpoint !== undefined && receipt.sourceSequence !== point.sourceSequence) ||
      !sameWorkflowCheckpoint(receipt.workflowCheckpoint, pause.workflowCheckpoint) ||
      receipt.bootId !== point.bootId ||
      !["pending", "sealed", "completed"].includes(receipt.phase)
    )
      return yield* fail("Relay acknowledged a different pause recovery point.");
  });
  return { synchronize };
});
