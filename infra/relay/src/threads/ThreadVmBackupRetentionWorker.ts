import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";

/** SDK deletion returns false only for a confirmed catalog 404; both outcomes
 * retire the root. Network errors retain the durable decision for reconciliation. */
export function makeThreadVmBackupRetentionWorker(
  sql: PgClient,
  compute: {
    readonly deleteSnapshot: (snapshotId: string) => Effect.Effect<boolean, ThreadVmComputeError>;
  },
  hostId: string,
) {
  const store = makeThreadVmBackupRetentionStore(sql);
  const runOne = Effect.fn("relay.thread_vm.backup.retire_one")(function* () {
    const claim = (yield* store.claimFailed(hostId)) ?? (yield* store.claim(hostId));
    if (!claim) return false;
    yield* compute.deleteSnapshot(claim.snapshotId).pipe(
      Effect.andThen(store.complete(claim)),
      Effect.catchTag("ThreadVmComputeError", () => store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
