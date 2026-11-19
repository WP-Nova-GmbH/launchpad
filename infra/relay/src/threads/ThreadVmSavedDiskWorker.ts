import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";

/** Expiry removes only the disk snapshot catalog root. Conversation artifacts
 * have independent retention; physical ancestry collection stays on the host. */
export function makeThreadVmSavedDiskWorker(
  sql: PgClient,
  compute: {
    readonly deleteSnapshot: (snapshotId: string) => Effect.Effect<boolean, ThreadVmComputeError>;
  },
  hostId: string,
) {
  const store = makeThreadVmSavedDiskStore(sql);
  const runOne = Effect.fn("relay.thread_vm.saved_disk.expire_one")(function* () {
    const claim = yield* store.claimExpired(hostId);
    if (!claim) return false;
    yield* compute.deleteSnapshot(claim.snapshotId).pipe(
      Effect.andThen(store.completeExpiry(claim)),
      Effect.catchTag("ThreadVmComputeError", () => store.deferExpiry(claim)),
    );
    return true;
  });
  return { runOne };
}
