import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SnapshotInfo } from "e2b";
import * as Effect from "effect/Effect";
import { matchesSnapshotAlias } from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";

/** Removes only this cancelled final save's candidate. It cannot stop or resume the source VM. */
export function makeThreadVmFinalSaveAbortWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: {
    readonly findSnapshot: (
      sandboxId: string,
      name: string,
    ) => Effect.Effect<SnapshotInfo | null, ThreadVmComputeError>;
    readonly deleteSnapshot: (snapshotId: string) => Effect.Effect<boolean, ThreadVmComputeError>;
  },
  hostId: string,
) {
  const store = makeThreadVmFinalSaveStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.final_save.abort_one")(function* () {
    const claim = yield* store.claimAbort(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      let current = yield* store.abortCandidate(claim);
      if (current.backup?.phase === "creating" && !current.backup.snapshotId) {
        const snapshot = yield* compute.findSnapshot(claim.computeRef, current.backup.snapshotName);
        if (
          !snapshot ||
          !snapshot.names.some((name) => matchesSnapshotAlias(name, current.backup!.snapshotName))
        ) {
          yield* store.deferAbort(claim, "capture_unconfirmed");
          return;
        }
        current = yield* store.adoptAbortCapture(claim, snapshot.snapshotId);
      }
      current = yield* store.retireAbortCapture(claim);
      if (current.backup?.phase === "retiring" && current.backup.snapshotId)
        yield* compute.deleteSnapshot(current.backup.snapshotId);
      yield* store.completeAbortCapture(claim);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.deferAbort(claim, "capture_cleanup_unconfirmed"),
        ThreadVmFinalSaveConflict: () => store.deferAbort(claim, "recovery_cleanup_unavailable"),
        ThreadNativeCheckpointConflict: () =>
          store.deferAbort(claim, "recovery_cleanup_unavailable"),
      }),
    );
    return true;
  });
  return { runOne };
}
