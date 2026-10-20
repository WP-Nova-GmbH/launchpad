import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import {
  makeThreadVmRestoreStore,
  restoreComputeGeneration,
  restoreBootGeneration,
  restoreProbeOperationId,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreServingStore } from "./ThreadVmRestoreServingStore.ts";

/** Reconcile exact infrastructure attempts without waking connections. A retired
 * unenrolled boot can retry only after its physical stop, under committed placement. */
export function makeThreadVmRestoreServingWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Pick<
    ReturnType<typeof makeE2BRestoreClient>,
    "prepare" | "inspect" | "activate" | "cancel" | "sandboxExists" | "stopBoot"
  >,
  hostId: string,
) {
  const restores = makeThreadVmRestoreStore(sql, objects),
    serving = makeThreadVmRestoreServingStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.restore.serve_one")(function* () {
    const claim = yield* serving.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const row = yield* serving.authorize(claim);
      const generation = restoreBootGeneration(row.generation);
      const bootOperationId = restoreBootOperationId(row.operationId, row.bootAttempt);
      if (row.phase === "booted") {
        const receipt = yield* compute
          .inspect(bootOperationId, generation)
          .pipe(Effect.flatMap((receipt) => serving.verifyReceipt(row, receipt)));
        if (
          !row.bootRecoveryStarted &&
          receipt.state === "active" &&
          (yield* compute.sandboxExists(receipt.sandboxID))
        )
          yield* serving.confirmStillActive(claim);
        else if (
          receipt.state === "active" ||
          receipt.state === "failed" ||
          receipt.state === "cancelled"
        ) {
          yield* serving.beginBootRecovery(claim);
          const stopped = yield* compute.stopBoot(receipt);
          yield* serving.retryStoppedBoot(claim, stopped);
        } else yield* restores.defer(claim, "boot_unconfirmed");
        return;
      }
      if (row.phase === "committed" && row.bootReceipt !== null) {
        let receipt = yield* compute
          .inspect(bootOperationId, generation)
          .pipe(Effect.flatMap((receipt) => serving.verifyReceipt(row, receipt)));
        if (
          row.bootRecoveryStarted ||
          row.bootReceipt.state === "failed" ||
          row.bootReceipt.state === "cancelled" ||
          receipt.state === "failed" ||
          receipt.state === "cancelled"
        ) {
          yield* serving.beginBootRecovery(claim);
          yield* serving.retryStoppedBoot(claim, yield* compute.stopBoot(receipt));
          return;
        }
        if (receipt.state === "prepared" || receipt.state === "activating")
          receipt = yield* compute
            .activate(bootOperationId, generation)
            .pipe(Effect.flatMap((receipt) => serving.verifyReceipt(row, receipt)));
        if (receipt.state === "failed" || receipt.state === "cancelled") {
          yield* serving.beginBootRecovery(claim);
          yield* serving.retryStoppedBoot(claim, yield* compute.stopBoot(receipt));
          return;
        }
        if (receipt.state !== "active") {
          yield* restores.defer(claim, "boot_unconfirmed");
          return;
        }
        yield* serving.recordActive(claim, receipt);
        return;
      }
      if (row.phase === "boot_prepared") {
        const receipt = yield* compute.inspect(bootOperationId, generation);
        if (receipt.state === "failed" || receipt.state === "cancelled") {
          if (row.backupRecoveryOperationId)
            yield* restores.retryBackupPreparation(
              claim,
              null,
              yield* compute.cancel(bootOperationId, generation),
            );
          else yield* restores.requestAbort(row.operationId);
          return;
        }
        yield* serving.commit(claim, receipt);
        return;
      }
      if (!row.probeRemoved) {
        const receipt = yield* compute.cancel(
          restoreProbeOperationId(row.operationId, row.probeAttempt),
          restoreComputeGeneration(row.operationId),
        );
        yield* serving.recordProbeRemoved(claim, receipt);
      }
      const preparing = yield* serving.beginPrepare(claim);
      const receipt = yield* compute.prepare(bootOperationId, {
        sourceTemplateID: preparing.sourceTemplateId,
        sourceBuildID: preparing.sourceBuildId,
        generation,
        leaseSeconds: 3600,
        bootstrap: {
          version: 1,
          operationId: preparing.operationId,
          allocationId: preparing.allocationId,
          threadId: preparing.threadId,
          generation: preparing.generation + 1,
        },
        metadata: {
          "launchpad.managed": "thread-vm-v1",
          "launchpad.allocation_id": preparing.allocationId,
          "launchpad.operation_id": preparing.operationId,
          "launchpad.thread_id": preparing.threadId,
          "launchpad.generation": String(preparing.generation + 1),
          "launchpad.restore": "v1",
          ...(preparing.bootAttempt > 0
            ? {
                "launchpad.restore_parent_operation_id": preparing.operationId,
                "launchpad.restore_boot_attempt": String(preparing.bootAttempt),
              }
            : {}),
        },
      });
      if (receipt.state === "failed" || receipt.state === "cancelled") {
        if (preparing.servingCommitted) {
          yield* serving.recordFailedPreparation(claim, receipt);
          yield* serving.beginBootRecovery(claim);
          yield* serving.retryStoppedBoot(claim, yield* compute.stopBoot(receipt));
        } else if (row.backupRecoveryOperationId)
          yield* restores.retryBackupPreparation(
            claim,
            null,
            yield* compute.cancel(bootOperationId, generation),
          );
        else yield* restores.requestAbort(row.operationId);
        return;
      }
      if (receipt.state !== "prepared") {
        yield* restores.defer(claim, "boot_preparation_pending");
        return;
      }
      yield* serving.recordPrepared(claim, receipt);
    }).pipe(
      Effect.catchTags({
        E2BRestoreError: () => restores.defer(claim, "boot_unconfirmed"),
        ThreadVmRestoreConflict: () => restores.defer(claim, "recovery_unconfirmed"),
        ThreadNativeCheckpointConflict: () => restores.defer(claim, "recovery_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
