import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import type { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import type { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import { ThreadPauseError, type ThreadPauseTransport } from "./ThreadPauseTransport.ts";
import { makeThreadVmSourceRecovery } from "./ThreadVmSourceRecovery.ts";

export const makeThreadPauseWorker = Effect.fn("ThreadPauseWorker.make")(function* (
  transport: ThreadPauseTransport,
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
) {
  const sql = yield* SqlClient.SqlClient,
    tracked = yield* VmWorkloadTracking;
  const fences = makeThreadExecutionFence(sql),
    recovery = yield* makeThreadVmSourceRecovery(history, checkpoints);
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
    const input = { ...owner, operationId: pause.operationId };
    // After a reopened pause, a later relay operation makes canActivate false.
    // Its historical receipt must let final saving install the next local drain.
    if (
      pause.phase === "completed" &&
      (owner.operationId !== pause.operationId ||
        (pause.sourceReopened && owner.phase === "active"))
    )
      return;
    if (pause.canActivate) {
      if (owner.operationId !== pause.operationId) {
        // A Send may cancel the relay reservation before this server sees it.
        // Install that exact operation locally before acknowledging reopening;
        // a delayed pending receipt then cannot start the same drain again.
        if (
          pause.phase !== "cancelled" ||
          pause.sourceReopened ||
          pause.nativeCheckpointOperationId ||
          owner.phase !== "active"
        )
          return;
        yield* fences.beginDrain({ ...input, previousOperationId: owner.operationId });
      }
      if (owner.phase !== "active" || owner.operationId !== pause.operationId) {
        if (!["active", "draining", "frozen"].includes(owner.phase)) return;
        if (tracked) {
          const inventory = yield* inspectVmWorkloads({ type: "inspect" });
          if (inventory.sealedBy !== null)
            yield* inspectVmWorkloads({
              type: "reopen",
              bootId: inventory.bootId,
              operationId: pause.operationId,
            });
        }
        yield* fences.activate(input);
      }
      // Persist the local active fence first. A lost relay read/ack must not let
      // a subsequent pause overwrite the only operation that can reopen it.
      if (!pause.sourceReopened) {
        const receipt = yield* transport.activate(input, { operationId: pause.operationId });
        if (
          receipt.operationId !== pause.operationId ||
          receipt.threadId !== threadId ||
          receipt.environmentId !== owner.environmentId ||
          receipt.generation !== owner.generation ||
          !receipt.canActivate ||
          !receipt.sourceReopened
        )
          return yield* fail("Relay acknowledged a different pause activation.");
      }
      return;
    }
    if (pause.phase === "cancelled") return;
    if (pause.nativeCheckpointOperationId || pause.phase !== "pending") {
      if (owner.operationId !== pause.operationId || owner.phase !== "frozen")
        return yield* fail("Pause has no matching frozen source.");
      return;
    }
    if (!tracked) return yield* fail("Pause requires a tracked VM workload boundary.");
    const point = yield* recovery
      .capture({ ...input, previousOperationId: owner.operationId })
      .pipe(
        Effect.catchTag("ThreadVmQueuedWork", () =>
          transport.cancel(input, { operationId: pause.operationId }).pipe(
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
    const inventory = yield* inspectVmWorkloads({ type: "inspect" });
    if (!inventory.stopped) return yield* fail("VM workspace processes have not stopped.");
    const seal = yield* inspectVmWorkloads({
      type: "seal",
      bootId: inventory.bootId,
      operationId: pause.operationId,
    });
    const receipt = yield* transport.freeze(input, {
      operationId: pause.operationId,
      nativeCheckpointOperationId: point.nativeCheckpointOperationId,
      bootId: seal.bootId,
    });
    if (
      receipt.threadId !== threadId ||
      receipt.environmentId !== owner.environmentId ||
      receipt.generation !== owner.generation ||
      receipt.operationId !== pause.operationId ||
      receipt.nativeCheckpointOperationId !== point.nativeCheckpointOperationId ||
      receipt.bootId !== seal.bootId ||
      !["pending", "sealed", "completed"].includes(receipt.phase)
    )
      return yield* fail("Relay acknowledged a different pause recovery point.");
  });
  return { synchronize };
});
