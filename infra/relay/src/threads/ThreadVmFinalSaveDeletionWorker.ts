import {
  confirmThreadVmCleanupIdentity,
  type ThreadVmCleanupCompute,
} from "./ThreadVmCleanupIdentity.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";

/** Only a certified final save can reach physical deletion; this worker cannot create or resume a VM. */
export function makeThreadVmFinalSaveDeletionWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: ThreadVmCleanupCompute & {
    readonly destroy: (sandboxId: string) => Effect.Effect<void, ThreadVmComputeError>;
  },
  hostId: string,
) {
  const store = makeThreadVmFinalSaveStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.final_save.delete_one")(function* () {
    const claim = yield* store.claimDeletion(hostId);
    if (!claim) return false;
    const [provision] = yield* sql<{
      operationId: string;
    }>`SELECT operation_id AS "operationId" FROM relay_thread_vm_provisions WHERE allocation_id=${claim.allocationId}`;
    if (!provision) {
      yield* store.deferDeletion(claim, "identity_conflict");
      return true;
    }
    yield* Effect.gen(function* () {
      const current = yield* store.authorizeDeletion(claim);
      if (
        !(yield* confirmThreadVmCleanupIdentity(sql, compute, {
          allocationId: current.allocationId,
          threadId: current.threadId,
          operationId: provision.operationId,
          generation: current.generation,
          computeRef: current.computeRef,
        }))
      ) {
        yield* store.deferDeletion(claim, "identity_conflict");
        return;
      }
      // A 404 from the catalog is insufficient: the patched physical-stop endpoint
      // must confirm absence even when a previous stop response was lost.
      yield* store.beginDeletion(claim);
      yield* compute.destroy(current.computeRef);
      yield* store.confirmDeleted(claim);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.deferDeletion(claim, "stop_unconfirmed"),
        E2BRestoreError: () => store.deferDeletion(claim, "stop_unconfirmed"),
        ThreadVmFinalSaveConflict: () => store.deferDeletion(claim, "recovery_unavailable"),
        ThreadNativeCheckpointConflict: () => store.deferDeletion(claim, "recovery_unavailable"),
      }),
    );
    return true;
  });
  return { runOne };
}
