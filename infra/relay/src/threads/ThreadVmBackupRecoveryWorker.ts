import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  E2BExecutionRetentionReceipt,
  type makeE2BRestoreClient,
} from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmBackupRecoveryStore } from "./ThreadVmBackupRecoveryStore.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
const decodeRetention = Schema.decodeUnknownEffect(E2BExecutionRetentionReceipt);

/** Each effect has a durable precondition. Lost replies retry the exact native
 * identity; neither catalog absence nor a timeout can release the old capacity. */
export function makeThreadVmBackupRecoveryWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Pick<
    ReturnType<typeof makeE2BRestoreClient>,
    "retentionCandidate" | "retainForStop" | "stopRetained" | "requireExecutionRetention"
  >,
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
      if (row.phase === "stopped") {
        yield* restores.beginBackupRecovery(claim);
        return;
      }
      if (!row.independentHistory) {
        const descriptor = yield* history.retain({
          ...row,
          sourceEnvironmentId: row.environmentId,
        });
        yield* store.recordHistory(claim, descriptor);
        yield* store.again(claim);
        return;
      }
      yield* history.verify({
        ...row,
        sourceEnvironmentId: row.environmentId,
        independentHistory: row.independentHistory,
      });
      if (row.phase === "retained") {
        const receipt = yield* decodeRetention(row.retentionReceipt);
        yield* store.recordStopped(claim, yield* compute.stopRetained(receipt));
      } else {
        yield* compute.requireExecutionRetention();
        const candidate =
          row.retentionCandidate ?? (yield* compute.retentionCandidate(row.computeRef));
        yield* store.beginRetention(claim, candidate);
        yield* store.recordRetention(
          claim,
          yield* compute.retainForStop(row.operationId, candidate),
        );
      }
      yield* store.again(claim);
    }).pipe(
      Effect.catchTags({
        E2BRestoreError: (error) =>
          error.operation === "retain for stop" &&
          error.reason === "http" &&
          error.status === 409 &&
          error.nativeCode === "retention_candidate_changed"
            ? store.candidateChanged(claim)
            : store.defer(claim, "source_stop_unconfirmed"),
        ThreadVmBackupRecoveryConflict: () => store.defer(claim, "source_recovery_unconfirmed"),
        ThreadVmRecoveryHistoryConflict: () => store.defer(claim, "history_unconfirmed"),
        ThreadVmRestoreConflict: () => store.defer(claim, "restore_unconfirmed"),
        ThreadVmAllocationConflict: () => store.defer(claim, "allocation_unconfirmed"),
        ThreadVmQuotaExceeded: () => store.defer(claim, "quota_unavailable"),
        ThreadNativeCheckpointConflict: () => store.defer(claim, "native_unconfirmed"),
        SchemaError: () => store.defer(claim, "source_receipt_invalid"),
      }),
    );
    return true;
  });
  return { runOne };
}
