import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { VmWorkloadTracking } from "../vmWorkloadCommand.ts";
import type { makeThreadCheckpointPublisher } from "./ThreadCheckpointPublisher.ts";
import type { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import {
  ThreadBackupSourceError,
  type ThreadBackupSourceTransport,
} from "./ThreadBackupSourceTransport.ts";
import { makeThreadVmSourceRecovery } from "./ThreadVmSourceRecovery.ts";

/** Retain the exact source seal until the relay observes native snapshot completion. */
export const makeThreadBackupSourceWorker = Effect.fn("ThreadBackupSourceWorker.make")(function* (
  transport: ThreadBackupSourceTransport,
  history: Pick<ReturnType<typeof makeThreadHistorySync>, "synchronize">,
  checkpoints: Pick<ReturnType<typeof makeThreadCheckpointPublisher>, "synchronize">,
) {
  const sql = yield* SqlClient.SqlClient,
    tracked = yield* VmWorkloadTracking;
  const fences = makeThreadExecutionFence(sql),
    recovery = yield* makeThreadVmSourceRecovery(history, checkpoints);
  const synchronize = Effect.fn("ThreadBackupSourceWorker.synchronize")(function* (
    threadId: string,
  ) {
    const owner = yield* fences.get(threadId);
    if (!owner || owner.phase === "retired") return;
    const backup = yield* transport.get(owner);
    if (!backup) return;
    const fail = (detail: string) => new ThreadBackupSourceError({ threadId, detail });
    const matches = (receipt: typeof backup) =>
      receipt.threadId === threadId &&
      receipt.environmentId === owner.environmentId &&
      receipt.generation === owner.generation &&
      receipt.operationId === backup.operationId;
    if (!matches(backup)) return yield* fail("Backup belongs to another VM source.");
    const input = { ...owner, operationId: backup.operationId };
    if (backup.sourceReopened) return;
    if (backup.canActivate) {
      if (owner.operationId !== backup.operationId) {
        if (backup.nativeCheckpointOperationId || owner.phase !== "active") return;
        yield* fences.beginDrain({ ...input, previousOperationId: owner.operationId });
      }
      if (owner.phase !== "active" || owner.operationId !== backup.operationId) {
        if (!["active", "draining", "frozen"].includes(owner.phase)) return;
        if (tracked) {
          const inventory = yield* inspectVmWorkloads({ type: "inspect" });
          if (inventory.sealedBy !== null)
            yield* inspectVmWorkloads({
              type: "reopen",
              bootId: inventory.bootId,
              operationId: backup.operationId,
            });
        }
        yield* fences.activate(input);
      }
      const ack = yield* transport.activate(input, { operationId: backup.operationId });
      if (!matches(ack) || !ack.sourceReopened || !ack.canActivate)
        return yield* fail("Relay acknowledged another backup activation.");
      return;
    }
    if (backup.nativeCheckpointOperationId || backup.phase !== "pending") return;
    if (!tracked) return yield* fail("VM backup requires a tracked workload boundary.");
    const point = yield* recovery
      .capture({ ...input, previousOperationId: owner.operationId })
      .pipe(
        Effect.catchTag("ThreadVmQueuedWork", () =>
          transport
            .cancel(input, { operationId: backup.operationId })
            .pipe(
              Effect.flatMap((ack) =>
                matches(ack) && ack.canActivate && ack.nativeCheckpointOperationId === null
                  ? Effect.succeed(undefined)
                  : fail("Relay acknowledged another backup cancellation."),
              ),
            ),
        ),
      );
    if (!point) return;
    const ack = yield* transport.freeze(input, { operationId: backup.operationId, ...point });
    if (!matches(ack) || ack.nativeCheckpointOperationId !== point.nativeCheckpointOperationId)
      return yield* fail("Relay acknowledged another backup source.");
  });
  return { synchronize };
});
