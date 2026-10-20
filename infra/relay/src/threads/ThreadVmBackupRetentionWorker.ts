import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { E2BRestoreError, E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";

/** SDK deletion returns false only for a confirmed catalog 404; both outcomes
 * retire the root. Network errors retain the durable decision for reconciliation. */
export function makeThreadVmBackupRetentionWorker(
  sql: PgClient,
  compute: {
    readonly restore?: {
      readonly cancel: (
        operationId: string,
        generation: string,
      ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
    };
    readonly deleteSnapshot: (snapshotId: string) => Effect.Effect<boolean, ThreadVmComputeError>;
  },
  hostId: string,
) {
  const store = makeThreadVmBackupRetentionStore(sql);
  const runOne = Effect.fn("relay.thread_vm.backup.retire_one")(function* () {
    const restore = compute.restore;
    const failed = restore ? yield* store.claimFailed(hostId) : null;
    if (failed && restore) {
      yield* Effect.gen(function* () {
        const receipt = yield* restore.cancel(failed.operationId, `backup-${failed.operationId}`);
        if (!(yield* store.retireFailed(failed, receipt))) return;
        yield* compute.deleteSnapshot(failed.snapshotId);
        yield* store.complete(failed);
      }).pipe(
        Effect.catchTags({
          E2BRestoreError: () => Effect.void,
          ThreadVmComputeError: () => Effect.void,
          ThreadVmBackupConflict: () => Effect.void,
        }),
        Effect.andThen(store.defer(failed)),
      );
      return true;
    }
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* compute.deleteSnapshot(claim.snapshotId).pipe(
      Effect.andThen(store.complete(claim)),
      Effect.catchTag("ThreadVmComputeError", () => store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
