import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { makeE2BThreadVmCompute } from "../machines/E2BThreadVmCompute.ts";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmBackupRecoveryStore } from "./ThreadVmBackupRecoveryStore.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";

/** Recovery pins the last completed snapshot and independent history before discarding the broken VM. */
export function makeThreadVmBackupRecoveryWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Pick<ReturnType<typeof makeE2BThreadVmCompute>, "inspect" | "destroy">,
  hostId: string,
) {
  const store = makeThreadVmBackupRecoveryStore(sql, objects),
    history = makeThreadVmRecoveryHistory(sql, objects),
    restores = makeThreadVmRestoreStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.backup_recovery.run_one")(function* () {
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const row = yield* sql.withTransaction(store.authorize(claim));
      yield* store.selectedReceipt(row);
      if (row.phase === "stopped") {
        yield* restores.beginBackupRecovery(claim);
        return;
      }
      if (!row.independentHistory) {
        yield* store.recordHistory(
          claim,
          yield* history.retain({ ...row, sourceEnvironmentId: row.environmentId }),
        );
        yield* store.again(claim);
        return;
      }
      yield* history.verify({
        ...row,
        sourceEnvironmentId: row.environmentId,
        independentHistory: row.independentHistory,
      });
      if (row.phase !== "retained") {
        yield* store.beginRetention(claim);
        yield* store.again(claim);
        return;
      }
      const source = yield* compute.inspect(row.computeRef);
      if (
        source &&
        (source.metadata["launchpad.managed"] !== "thread-vm-v1" ||
          source.metadata["launchpad.allocation_id"] !== row.sourceAllocationId ||
          source.metadata["launchpad.thread_id"] !== row.threadId ||
          source.metadata["launchpad.generation"] !== String(row.generation) ||
          !threadVmOperationMatches(source.metadata, row.sourceOperationId))
      ) {
        yield* store.defer(claim, "source_identity_conflict");
        return;
      }
      // The selected immutable backup/history survive even if this DELETE reply is lost.
      yield* sql.withTransaction(store.authorize(claim));
      yield* compute.destroy(row.computeRef);
      yield* store.recordStopped(claim, {
        version: 1,
        kind: "native-recovery-source-deleted-v1",
        operationId: row.operationId,
        sourceAllocationId: row.sourceAllocationId,
        computeRef: row.computeRef,
        sourceOperationId: row.sourceOperationId,
        generation: row.generation,
        acknowledged: true,
      });
      yield* store.again(claim);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.defer(claim, "source_stop_unconfirmed"),
        ThreadVmBackupRecoveryConflict: () => store.defer(claim, "source_recovery_unconfirmed"),
        ThreadVmRecoveryHistoryConflict: () => store.defer(claim, "history_unconfirmed"),
        ThreadVmRestoreConflict: () => store.defer(claim, "restore_unconfirmed"),
        ThreadVmAllocationConflict: () => store.defer(claim, "allocation_unconfirmed"),
        ThreadVmQuotaExceeded: () => store.defer(claim, "quota_unavailable"),
        ThreadNativeCheckpointConflict: () => store.defer(claim, "native_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
