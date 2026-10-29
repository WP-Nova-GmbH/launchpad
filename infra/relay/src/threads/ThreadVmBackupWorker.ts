import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo, SnapshotInfo } from "e2b";
import * as Effect from "effect/Effect";
import { matchesSnapshotAlias, type E2BRestoreError } from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupStore, type BackupClaim } from "./ThreadVmBackupStore.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { wakeQueuedThreadVm } from "./ThreadVmWakeAdmission.ts";

interface BackupCompute {
  readonly inspect: (id: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  readonly snapshot: (
    id: string,
    name: string,
  ) => Effect.Effect<SnapshotInfo, ThreadVmComputeError | E2BRestoreError>;
  readonly findSnapshot: (
    id: string,
    name: string,
  ) => Effect.Effect<SnapshotInfo | null, ThreadVmComputeError>;
  readonly restore: {
    readonly resolveNamedSnapshot: (
      id: string,
    ) => Effect.Effect<{ sourceTemplateID: string; sourceBuildID: string }, E2BRestoreError>;
    readonly resolveFailedNamedSnapshot: (
      name: string,
    ) => Effect.Effect<
      { snapshotId: string; sourceTemplateID: string; sourceBuildID: string } | null,
      E2BRestoreError
    >;
  };
}
function matches(info: SandboxInfo | null, claim: BackupClaim) {
  return (
    info?.sandboxId === claim.computeRef &&
    info.templateId === claim.templateId.split(":")[0] &&
    info.network?.allowPublicTraffic === false &&
    info.lifecycle?.autoResume === false &&
    info.metadata["launchpad.managed"] === "thread-vm-v1" &&
    info.metadata["launchpad.allocation_id"] === claim.allocationId &&
    threadVmOperationMatches(info.metadata, claim.provisionOperationId) &&
    info.metadata["launchpad.thread_id"] === claim.threadId &&
    info.metadata["launchpad.generation"] === String(claim.generation)
  );
}

/** A completed native snapshot and an independently published source replace cold probes. */
export function makeThreadVmBackupWorker(
  sql: PgClient,
  compute: BackupCompute,
  hostId: string,
  enqueuePeriodic = true,
) {
  const store = makeThreadVmBackupStore(sql);
  const runOne = Effect.fn("relay.thread_vm.backup.run_one")(function* () {
    if (enqueuePeriodic) yield* store.enqueueDue(hostId);
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      // Reconciliation is read-only and may complete after an automatic timeout
      // pause. Never wake the VM or issue another POST for an uncertain capture.
      let snapshot =
        claim.phase === "creating"
          ? yield* compute.findSnapshot(claim.computeRef, claim.snapshotName)
          : null;
      if (claim.phase === "pending") {
        const info = yield* compute.inspect(claim.computeRef);
        if (!matches(info, claim)) return;
        if (info?.state === "paused") {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (
                yield* makeThreadVmResumeStore(sql).reconcileNativePause({
                  ...claim,
                  operationId: claim.provisionOperationId,
                  hostId,
                })
              )
                yield* wakeQueuedThreadVm(sql, claim.threadId);
            }),
          );
          return;
        }
        if (info?.state !== "running") return;
        if (!(yield* store.beginCapture(claim))) return;
        snapshot = yield* compute.snapshot(claim.computeRef, claim.snapshotName);
      }
      if (!snapshot) {
        if (claim.phase !== "creating") return;
        const failed = yield* compute.restore.resolveFailedNamedSnapshot(claim.snapshotName);
        if (failed)
          yield* store.recordFailure(claim, {
            snapshotId: failed.snapshotId,
            sourceTemplateId: failed.sourceTemplateID,
            sourceBuildId: failed.sourceBuildID,
          });
        return;
      }
      const source = yield* compute.restore.resolveNamedSnapshot(claim.snapshotName);
      // Native named snapshots return namespace/alias:default, while the
      // catalogue resolves that unique alias to the immutable template/build.
      if (
        snapshot.snapshotId !== source.sourceTemplateID &&
        snapshot.snapshotId !== `${source.sourceTemplateID}:default` &&
        !snapshot.names.some(
          (name) =>
            matchesSnapshotAlias(name, claim.snapshotName) &&
            snapshot.snapshotId === `${name}:default`,
        )
      )
        return;
      yield* store.recordCapture(claim, {
        snapshotId: source.sourceTemplateID,
        sourceTemplateId: source.sourceTemplateID,
        sourceBuildId: source.sourceBuildID,
      });
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => Effect.void,
        E2BRestoreError: () => Effect.void,
      }),
      Effect.andThen(store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
