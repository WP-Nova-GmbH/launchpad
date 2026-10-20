import {
  confirmThreadVmCleanupIdentity,
  type ThreadVmCleanupCompute,
} from "./ThreadVmCleanupIdentity.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmResetStore, ThreadVmResetConflict } from "./ThreadVmResetStore.ts";

interface Compute extends ThreadVmCleanupCompute {
  readonly destroy: (sandboxId: string) => Effect.Effect<void, ThreadVmComputeError>;
}
/** Cleanup never needs the revoked owner's access. Unknown creation or stop keeps
 * quota and the placement hold; absence of a catalog entry is not a stop receipt. */
export function makeThreadVmResetCancellationWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: Compute,
  hostId: string,
) {
  const resets = makeThreadVmResetStore(sql, objects);
  const allocations = makeThreadVmAllocationStore(sql);
  const provisions = makeThreadVmProvisionStore(sql);
  const runOne = Effect.fn("relay.thread_vm.reset.cancel_one")(function* () {
    const claim = yield* resets.claimCancellation(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      // A pending provision has not crossed beginCreate. Serialize against that
      // writer before cancelling; an expired worker cannot subsequently create.
      const provision = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* resets.requireCancellationClaim(claim);
          yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${claim.allocationId} FOR UPDATE`;
          yield* sql`SELECT allocation_id FROM relay_thread_vm_provisions WHERE allocation_id=${claim.allocationId} FOR UPDATE`;
          const row = yield* provisions.get(claim.allocationId);
          if (
            row &&
            (row.operationId !== claim.operationId ||
              row.threadId !== claim.threadId ||
              row.generation !== claim.expectedGeneration + 1)
          )
            return yield* new ThreadVmResetConflict({
              message: "Replacement provision identity changed",
            });
          if (
            row?.phase === "pending" &&
            row.computeRef === null &&
            row.allocationState === "deleting"
          ) {
            yield* makeThreadVmCapacityStore(sql).cancelUnstarted(claim.operationId);
            yield* allocations.confirmDeleted({
              allocationId: claim.allocationId,
              computeRef: null,
            });
            yield* sql`UPDATE relay_thread_vm_provisions SET phase='cancelled',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE allocation_id=${claim.allocationId}`;
          }
          return yield* provisions.get(claim.allocationId);
        }),
      );
      if (!provision)
        return yield* new ThreadVmResetConflict({ message: "Replacement provision is missing" });
      if (provision.phase === "creating") {
        // The ordinary provisioning reconciler resolves an ambiguous create by
        // immutable operation metadata. Never infer absence from an empty list.
        yield* resets.deferCancellation(claim, "create_uncertain");
        return;
      }
      if (provision.allocationState !== "deleted") {
        if (
          provision.phase !== "created" ||
          !provision.computeRef ||
          provision.allocationState !== "deleting"
        )
          return yield* new ThreadVmResetConflict({
            message: "Replacement deletion is unconfirmed",
          });
        if (
          !(yield* confirmThreadVmCleanupIdentity(sql, compute, {
            allocationId: claim.allocationId,
            threadId: claim.threadId,
            operationId: claim.operationId,
            generation: claim.expectedGeneration + 1,
            computeRef: provision.computeRef,
          }).pipe(Effect.timeout("30 seconds")))
        )
          return yield* new ThreadVmResetConflict({
            message: "Replacement compute identity changed",
          });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* resets.requireCancellationClaim(claim);
            yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${claim.allocationId} FOR UPDATE`;
            yield* sql`SELECT allocation_id FROM relay_thread_vm_provisions WHERE allocation_id=${claim.allocationId} FOR UPDATE`;
            const current = yield* provisions.get(claim.allocationId);
            if (
              !current ||
              current.phase !== "created" ||
              current.allocationState !== "deleting" ||
              !current.computeRef ||
              current.computeRef !== provision.computeRef ||
              current.operationId !== claim.operationId ||
              current.threadId !== claim.threadId ||
              current.generation !== claim.expectedGeneration + 1
            )
              return yield* new ThreadVmResetConflict({
                message: "Replacement cleanup identity changed",
              });
            // Cancellation still owns the expired source placement; its new
            // uncommitted VM stays fenced while the exact physical stop completes.
            yield* compute.destroy(current.computeRef).pipe(Effect.timeout("60 seconds"));
            yield* allocations.confirmDeleted({
              allocationId: claim.allocationId,
              computeRef: current.computeRef,
            });
          }),
        );
      }
      yield* resets.finishCancellation(claim);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => resets.deferCancellation(claim, "stop_unconfirmed"),
        E2BRestoreError: () => resets.deferCancellation(claim, "stop_unconfirmed"),
        TimeoutError: () => resets.deferCancellation(claim, "stop_unconfirmed"),
        ThreadVmResetConflict: () => resets.deferCancellation(claim, "cleanup_unconfirmed"),
        ThreadVmCapacityConflict: () => resets.deferCancellation(claim, "cleanup_unconfirmed"),
        ThreadVmAllocationConflict: () => resets.deferCancellation(claim, "cleanup_unconfirmed"),
        ThreadNativeCheckpointConflict: () =>
          resets.deferCancellation(claim, "recovery_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
