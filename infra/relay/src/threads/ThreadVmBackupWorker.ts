import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo, SnapshotInfo } from "e2b";
import * as Effect from "effect/Effect";
import type {
  E2BRestoreError,
  E2BRestoreRequest,
  E2BRestoreStatus,
} from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupStore, type BackupClaim } from "./ThreadVmBackupStore.ts";

interface BackupCompute {
  readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  readonly snapshot: (
    sandboxId: string,
    name: string,
  ) => Effect.Effect<SnapshotInfo, ThreadVmComputeError | E2BRestoreError>;
  /** A proven host-side disk capture that never resumes a paused guest. Absent capabilities keep the VM. */
  readonly snapshotPaused?: BackupCompute["snapshot"];
  readonly pausedSnapshotsSupported?: Effect.Effect<boolean>;
  readonly findSnapshot: (
    sandboxId: string,
    name: string,
  ) => Effect.Effect<SnapshotInfo | null, ThreadVmComputeError>;
  readonly restore: {
    readonly resolveFailedNamedSnapshot?: (
      name: string,
    ) => Effect.Effect<
      { snapshotId: string; sourceTemplateID: string; sourceBuildID: string } | null,
      E2BRestoreError
    >;
    readonly resolveNamedSnapshot: (
      snapshotId: string,
    ) => Effect.Effect<{ sourceTemplateID: string; sourceBuildID: string }, E2BRestoreError>;
    readonly prepare: (
      operationId: string,
      input: E2BRestoreRequest,
    ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
    readonly cancel: (
      operationId: string,
      generation: string,
    ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
  };
}

function matches(info: SandboxInfo | null, claim: BackupClaim) {
  return (
    info?.sandboxId === claim.computeRef &&
    info.state === (claim.finalSaveOperationId ? claim.originalState : "running") &&
    info.metadata["launchpad.managed"] === "thread-vm-v1" &&
    info.metadata["launchpad.allocation_id"] === claim.allocationId &&
    threadVmOperationMatches(info.metadata, claim.provisionOperationId) &&
    info.metadata["launchpad.thread_id"] === claim.threadId &&
    info.metadata["launchpad.generation"] === String(claim.generation)
  );
}

/** An uncertain capture is looked up by its unique name, never attempted twice. */
export function makeThreadVmBackupWorker(sql: PgClient, compute: BackupCompute, hostId: string) {
  const store = makeThreadVmBackupStore(sql);
  const runOne = Effect.fn("relay.thread_vm.backup.run_one")(function* () {
    yield* store.enqueueDue(hostId);
    const allowPaused =
      compute.snapshotPaused !== undefined &&
      (compute.pausedSnapshotsSupported === undefined || (yield* compute.pausedSnapshotsSupported));
    const claim = yield* store.claim(hostId, allowPaused);
    if (!claim) return false;
    const generation = `backup-${claim.operationId}`;
    const cleanup = Effect.gen(function* () {
      const cancelled = yield* compute.restore.cancel(claim.operationId, generation);
      if (cancelled.state === "cancelled") yield* store.complete(claim);
    });
    const attempt = Effect.gen(function* () {
      if (claim.phase === "pending" || claim.phase === "creating") {
        if (
          claim.phase === "creating" &&
          claim.originalState !== "paused" &&
          compute.restore.resolveFailedNamedSnapshot
        ) {
          const failed = yield* compute.restore.resolveFailedNamedSnapshot(claim.snapshotName);
          if (failed) {
            yield* store.failCapture(claim, {
              snapshotId: failed.snapshotId,
              sourceTemplateId: failed.sourceTemplateID,
              sourceBuildId: failed.sourceBuildID,
            });
            return;
          }
        }
        // A paused disk alias is immutable and idempotent. Retrying a lost reply
        // cannot take another snapshot or wake the guest.
        const reconciledPaused =
          claim.phase === "creating" && claim.originalState === "paused"
            ? ((yield* compute.findSnapshot(claim.computeRef, claim.snapshotName)) ??
              (compute.snapshotPaused
                ? yield* compute.snapshotPaused(claim.computeRef, claim.snapshotName)
                : null))
            : null;
        const info = yield* compute.inspect(claim.computeRef);
        if (!matches(info, claim)) return;
        const capture =
          claim.originalState === "paused" ? compute.snapshotPaused : compute.snapshot;
        if (!capture) return;
        if (claim.phase === "pending" && !(yield* store.beginCapture(claim))) return;
        const snapshot =
          reconciledPaused ??
          (claim.phase === "pending"
            ? yield* capture(claim.computeRef, claim.snapshotName)
            : yield* compute.findSnapshot(claim.computeRef, claim.snapshotName));
        if (!snapshot) return;
        const source = yield* compute.restore.resolveNamedSnapshot(snapshot.snapshotId);
        yield* store.recordCapture(claim, {
          snapshotId: snapshot.snapshotId,
          sourceTemplateId: source.sourceTemplateID,
          sourceBuildId: source.sourceBuildID,
        });
        return;
      }
      if (claim.phase === "cleanup") {
        yield* cleanup;
        return;
      }
      if (!claim.snapshotId || !claim.sourceTemplateId || !claim.sourceBuildId) {
        yield* store.fail(claim);
        return;
      }
      const result = yield* compute.restore.prepare(claim.operationId, {
        sourceTemplateID: claim.sourceTemplateId,
        sourceBuildID: claim.sourceBuildId,
        generation,
        leaseSeconds: 900,
      });
      if (result.state === "failed" || result.state === "cancelled") {
        yield* store.fail(claim);
        return;
      }
      // Preparation replays/fscks an offline copy. It is not a cold VM proof.
      // Older hosts leave the candidate pending and preserve the previous save.
      if (
        result.state !== "prepared" ||
        !result.coldProbe ||
        result.coldProbe.preparedBuildID !== result.preparedBuildID ||
        !(yield* store.markProbeReady(claim, result))
      )
        return;
      yield* cleanup;
    });
    yield* attempt.pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => Effect.void,
        E2BRestoreError: (error) =>
          error.reason === "http" &&
          ((error.operation === "paused snapshot" && error.status === 409) ||
            // A fixed immutable disk cannot fit this host's total budget. The
            // unverified snapshot stays retained; ordinary 429 contention retries.
            (error.operation === "prepare" && error.status === 413))
            ? store.fail(claim).pipe(Effect.asVoid)
            : Effect.void,
      }),
      Effect.andThen(store.defer(claim)),
    );
    return true;
  });
  return { runOne };
}
