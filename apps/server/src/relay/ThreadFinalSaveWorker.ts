import type { RelayThreadVmFinalSave } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import type { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import type { makeThreadHistorySync, ThreadHistoryOwner } from "./ThreadHistorySync.ts";
import { ThreadFinalSaveError, type ThreadFinalSaveTransport } from "./ThreadFinalSaveTransport.ts";
import { makeThreadVmSourceRecovery } from "./ThreadVmSourceRecovery.ts";

/** The guest only certifies a stopped, independently retained source. Compute deletion belongs to the relay. */
export const makeThreadFinalSaveWorker = Effect.fn("ThreadFinalSaveWorker.make")(function* (
  transport: ThreadFinalSaveTransport,
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
) {
  const sql = yield* SqlClient.SqlClient,
    tracked = yield* VmWorkloadTracking;
  const fences = makeThreadExecutionFence(sql);
  const recovery = yield* makeThreadVmSourceRecovery(history, checkpoints);
  const fail = (threadId: string, detail: string) => new ThreadFinalSaveError({ threadId, detail });
  const matches = (owner: ThreadHistoryOwner, operation: RelayThreadVmFinalSave) =>
    owner.threadId === operation.threadId &&
    owner.environmentId === operation.environmentId &&
    owner.generation === operation.generation;
  const synchronize = Effect.fn("ThreadFinalSaveWorker.synchronize")(function* (threadId: string) {
    const owner = yield* fences.get(threadId);
    if (!owner || owner.phase === "retired") return;
    const operation = yield* transport.get(owner);
    if (!operation) return;
    if (!matches(owner, operation))
      return yield* fail(threadId, "Final save belongs to another thread or generation.");
    const input = { ...owner, operationId: operation.operationId };
    if (operation.phase === "aborted") {
      if (
        !operation.sourceActivationPending &&
        (owner.operationId !== operation.operationId ||
          !["draining", "frozen"].includes(owner.phase))
      )
        return;
      if (owner.operationId !== operation.operationId) {
        // Cancellation may finish before this guest observes the reservation.
        // Install its identity so a delayed draining receipt cannot restart it.
        if (owner.phase !== "active" || operation.nativeCheckpointOperationId !== null) return;
        yield* fences.beginDrain({ ...input, previousOperationId: owner.operationId });
      }
      if (owner.phase !== "active" || owner.operationId !== operation.operationId) {
        if (!["active", "draining", "frozen"].includes(owner.phase)) return;
        if (tracked) {
          const inventory = yield* inspectVmWorkloads({ type: "inspect" });
          if (inventory.sealedBy !== null)
            yield* inspectVmWorkloads({
              type: "reopen",
              bootId: inventory.bootId,
              operationId: operation.operationId,
            });
        }
        yield* fences.activate(input);
      }
      if (!operation.sourceActivationPending) return;
      const receipt = yield* transport.activate(input, { operationId: operation.operationId });
      if (
        !matches(owner, receipt) ||
        receipt.operationId !== operation.operationId ||
        receipt.phase !== "aborted" ||
        receipt.sourceActivationPending
      )
        return yield* fail(threadId, "Relay acknowledged a different final-save activation.");
      return;
    }
    if (operation.phase === "aborting") return;
    if (operation.phase === "deleting" || operation.phase === "completed") {
      if (owner.operationId !== operation.operationId || owner.phase !== "frozen")
        return yield* fail(threadId, "Saved-only ownership has no matching frozen source.");
      yield* fences.retire(input);
      return;
    }
    if (operation.phase !== "draining") {
      if (owner.operationId !== operation.operationId || owner.phase !== "frozen")
        return yield* fail(threadId, "Final save has no matching local source fence.");
      return;
    }
    const point = yield* recovery
      .capture({ ...input, previousOperationId: owner.operationId })
      .pipe(
        Effect.catchTag("ThreadVmQueuedWork", () =>
          transport.cancel(input, { operationId: operation.operationId }).pipe(
            Effect.flatMap((receipt) => {
              if (
                !matches(input, receipt) ||
                receipt.operationId !== operation.operationId ||
                !["aborting", "aborted"].includes(receipt.phase) ||
                receipt.nativeCheckpointOperationId !== null
              )
                return fail(threadId, "Relay acknowledged a different final-save cancellation.");
              // Retain the source fence until the relay's durable abort cleanup finishes.
              return Effect.succeed(undefined);
            }),
          ),
        ),
      );
    if (!point) return;
    const { nativeCheckpointOperationId } = point;
    const receipt = yield* transport.freeze(input, {
      operationId: operation.operationId,
      nativeCheckpointOperationId,
      bootId: point.bootId,
      sealEpoch: point.sealEpoch,
    });
    if (
      !matches(input, receipt) ||
      receipt.operationId !== operation.operationId ||
      receipt.nativeCheckpointOperationId !== nativeCheckpointOperationId ||
      !["frozen", "saving", "deleting", "completed"].includes(receipt.phase)
    )
      return yield* fail(threadId, "The relay returned a different final-save checkpoint.");
  });
  return { synchronize };
});
