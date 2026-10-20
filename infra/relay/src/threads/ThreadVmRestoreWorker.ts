import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import {
  makeThreadVmRestoreStore,
  restoreComputeGeneration,
  restoreBootGeneration,
  restoreProbeOperationId,
} from "./ThreadVmRestoreStore.ts";

/** Prepares an offline saved disk only. Omitting bootstrap makes this host
 * operation incapable of booting; activation requires a separate import gate. */
export function makeThreadVmRestoreWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Pick<ReturnType<typeof makeE2BRestoreClient>, "prepare" | "cancel" | "inspect">,
  hostId: string,
) {
  const store = makeThreadVmRestoreStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.restore.prepare_one")(function* () {
    yield* makeThreadVmCapacityStore(sql).admitNext(hostId);
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const generation = restoreComputeGeneration(claim.operationId);
      if (claim.phase === "aborting") {
        const receipt =
          claim.prepareStarted && !claim.probeRemoved
            ? yield* compute.cancel(
                restoreProbeOperationId(claim.operationId, claim.probeAttempt),
                generation,
              )
            : undefined;
        const bootReceipt = claim.bootPrepareStarted
          ? yield* compute.cancel(
              restoreBootOperationId(claim.operationId, claim.bootAttempt),
              restoreBootGeneration(claim.generation),
            )
          : undefined;
        yield* store.completeAbort(claim, receipt, bootReceipt);
        return;
      }
      if (claim.phase === "prepared") {
        const receipt = yield* compute.inspect(
          restoreProbeOperationId(claim.operationId, claim.probeAttempt),
          generation,
        );
        const previous = claim.preparedReceipt;
        if (
          !previous ||
          receipt.operationID !== previous.operationID ||
          receipt.generation !== previous.generation ||
          receipt.sandboxID !== previous.sandboxID ||
          receipt.executionID !== previous.executionID ||
          receipt.preparedBuildID !== previous.preparedBuildID
        ) {
          yield* store.defer(claim, "identity_conflict");
          return;
        }
        if (receipt.state === "cancelled" || receipt.state === "failed") {
          // A host lease can retire the offline preparation while the relay was
          // down. Reconcile its tombstone instead of leaking quota and pins.
          if (claim.backupRecoveryOperationId)
            yield* store.retryBackupPreparation(
              claim,
              yield* compute.cancel(
                restoreProbeOperationId(claim.operationId, claim.probeAttempt),
                generation,
              ),
              null,
            );
          else yield* store.requestAbort(claim.operationId);
          return;
        }
        yield* store.recordPrepared(claim, receipt);
        return;
      }
      const row = yield* store.beginPrepare(claim);
      // The patched PUT is idempotent under this exact immutable source pair and
      // operation. A lost response retries the preparation, never a VM create.
      const receipt = yield* compute.prepare(
        restoreProbeOperationId(row.operationId, row.probeAttempt),
        {
          sourceTemplateID: row.sourceTemplateId,
          sourceBuildID: row.sourceBuildId,
          generation,
          leaseSeconds: 3600,
        },
      );
      if (
        receipt.operationID !== restoreProbeOperationId(row.operationId, row.probeAttempt) ||
        receipt.generation !== generation
      ) {
        yield* store.defer(claim, "identity_conflict");
        return;
      }
      if (receipt.state === "failed" || receipt.state === "cancelled") {
        if (row.backupRecoveryOperationId)
          yield* store.retryBackupPreparation(
            claim,
            yield* compute.cancel(
              restoreProbeOperationId(row.operationId, row.probeAttempt),
              generation,
            ),
            null,
          );
        else yield* store.requestAbort(claim.operationId);
        return;
      }
      if (receipt.state !== "prepared") {
        yield* store.defer(claim, "preparation_pending");
        return;
      }
      yield* store.recordPrepared(claim, receipt);
    }).pipe(
      Effect.catchTags({
        E2BRestoreError: () =>
          store.defer(
            claim,
            claim.phase === "aborting" ? "cleanup_unconfirmed" : "preparation_unconfirmed",
          ),
        ThreadVmRestoreConflict: () => store.defer(claim, "recovery_unconfirmed"),
        ThreadNativeCheckpointConflict: () => store.defer(claim, "recovery_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
