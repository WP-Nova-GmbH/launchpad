import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { makeThreadVmBackupStore } from "./ThreadVmBackupStore.ts";

/** Advances already certified source freezes; it cannot freeze, wake or delete compute. */
export function makeThreadVmFinalSaveWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  hostId: string,
) {
  const store = makeThreadVmFinalSaveStore(sql, objects),
    backups = makeThreadVmBackupStore(sql);
  const runOne = Effect.fn("relay.thread_vm.final_save.advance_one")(function* () {
    const claim = yield* store.claimSave(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const current = yield* store.reserveBackup(claim.operationId);
      const backup = current.backupOperationId
        ? yield* backups.get(current.backupOperationId)
        : null;
      if (backup?.phase !== "verified") {
        yield* store.deferSave(
          claim,
          backup?.phase === "failed" ? "backup_failed" : "backup_pending",
        );
        return;
      }
      yield* store.recordSaved(claim.operationId);
      yield* store.deferSave(claim, null);
    }).pipe(
      Effect.catchTags({
        ThreadVmFinalSaveConflict: () => store.deferSave(claim, "recovery_unavailable"),
        ThreadNativeCheckpointConflict: () => store.deferSave(claim, "recovery_unavailable"),
        ThreadVmBackupConflict: () => store.deferSave(claim, "recovery_unavailable"),
      }),
    );
    return true;
  });
  return { runOne };
}
