import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { ManagedEndpointDeprovisioningFailed } from "../environments/ManagedEndpointProvider.ts";
import {
  restoreProbeOperationId,
  restoreComputeGeneration,
  restoreBootGeneration,
} from "./ThreadVmRestoreStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import {
  E2BExecutionRetentionReceipt,
  type E2BRestoreError,
  type E2BRestoreStatus,
} from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import {
  confirmThreadVmCleanupIdentity,
  type ThreadVmCleanupCompute,
} from "./ThreadVmCleanupIdentity.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
const decodeRetention = Schema.decodeUnknownEffect(E2BExecutionRetentionReceipt);

/** Reconcile one exact managed resource per pass. Never remove a normal checkout
 * or release an unknown create reservation because its catalog lookup was empty. */
export function makeThreadDeletionWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: ThreadVmCleanupCompute & {
    /** Success certifies an exact physical stop and fences every later start. */
    readonly destroy: (id: string) => Effect.Effect<void, ThreadVmComputeError>;
    readonly deleteSnapshot: (id: string) => Effect.Effect<boolean, ThreadVmComputeError>;
    readonly restore: {
      readonly requireExecutionRetention?: () => Effect.Effect<void, E2BRestoreError>;
      readonly inspect: (
        id: string,
        generation: string,
      ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
      readonly cancel: (
        id: string,
        generation: string,
      ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
      readonly resolveStoppedNamedSnapshot?: (
        name: string,
      ) => Effect.Effect<
        { snapshotId: string; sourceTemplateID: string; sourceBuildID: string } | null,
        E2BRestoreError
      >;
      readonly resolveFailedNamedSnapshot?: (
        name: string,
      ) => Effect.Effect<
        { snapshotId: string; sourceTemplateID: string; sourceBuildID: string } | null,
        E2BRestoreError
      >;
    };
  },
  hostId: string,
  removeEndpoint?: (
    allocationId: string,
    environmentId: string,
  ) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>,
) {
  const store = makeThreadDeletionStore(sql);
  const runOne = Effect.fn("relay.thread.delete.run_one")(function* () {
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const allocation = yield* store.nextAllocation(claim);
      if (allocation) {
        // The existing provision worker reconciles uncertain creates and cancels never-started intents.
        if (!allocation.computeRef || !allocation.operationId || !allocation.generation) {
          yield* store.defer(claim, "create_unconfirmed");
          return;
        }
        if (
          !(yield* confirmThreadVmCleanupIdentity(sql, compute, {
            allocationId: allocation.allocationId,
            threadId: claim.threadId,
            operationId: allocation.operationId,
            generation: allocation.generation,
            computeRef: allocation.computeRef,
          }))
        ) {
          yield* store.defer(claim, "identity_conflict");
          return;
        }
        if (allocation.needsCaptureCleanup) {
          if (!compute.restore.requireExecutionRetention) {
            yield* store.defer(claim, "capture_admission_unconfirmed");
            return;
          }
          // Native39 seals all capture admission before its ordinary exact Stop.
          // This is destructive owner deletion, so no usable recovery tip is needed.
          yield* compute.restore.requireExecutionRetention();
        }
        yield* compute.destroy(allocation.computeRef);
        // The stop receipt, rather than eventually consistent routing or snapshot
        // status, proves absence. A failed/lost stop still retains the allocation.
        yield* store.stopped(
          claim,
          allocation.allocationId,
          allocation.computeRef,
          allocation.needsCaptureCleanup,
        );
        yield* store.defer(claim, null);
        return;
      }
      yield* store.clean(claim);
      const [uncertain] = yield* sql<{
        operationId: string;
        snapshotName: string;
        snapshotId: string | null;
        sourceTemplateId: string | null;
        sourceBuildId: string | null;
        phase: string;
      }>`SELECT x.operation_id AS "operationId",x.snapshot_name AS "snapshotName",x.snapshot_id AS "snapshotId",x.source_template_id AS "sourceTemplateId",x.source_build_id AS "sourceBuildId",x.phase
        FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_thread_deletions d ON d.thread_id=a.thread_id
        WHERE a.thread_id=${claim.threadId} AND (x.phase IN ('creating','captured','verifying','cleanup') OR
          (x.phase='retiring' AND x.probe_receipt IS NULL AND x.verified_at IS NULL AND x.failed_probe_stopped_at IS NULL
            AND ((x.snapshot_id IS NULL AND x.source_template_id IS NULL AND x.source_build_id IS NULL)
              OR (x.snapshot_id IS NOT NULL AND x.source_template_id IS NOT NULL AND x.source_build_id IS NOT NULL AND x.snapshot_id!=x.source_template_id))))
          AND x.snapshot_name='launchpad-backup-' || x.operation_id AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
          AND a.state='deleted' AND a.deleted_at IS NOT NULL AND (
            (d.allow_uncertain_capture_cleanup AND a.deletion_stop_receipt->>'operationId'=d.operation_id
              AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref
              AND a.deletion_stop_receipt->>'generation'=x.generation::text AND a.deletion_stop_receipt->>'physicallyStopped'='true'
              AND a.deletion_stop_receipt->>'captureAdmissionSealed'='true'
              AND EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id AND p.generation=x.generation AND p.operation_id=a.deletion_stop_receipt->>'sourceOperationId'))
            OR EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.source_allocation_id=a.allocation_id AND r.thread_id=a.thread_id AND r.generation=x.generation AND r.phase='completed'
              AND r.retention_receipt->>'kind'='retained_for_stop' AND r.retention_receipt->>'recoveryOperationID'=r.operation_id AND r.retention_receipt->>'sandboxID'=a.compute_ref
              AND r.stop_receipt->>'physicallyStopped'='true' AND r.stop_receipt-'physicallyStopped'=r.retention_receipt))
        ORDER BY x.created_at,x.operation_id LIMIT 1`;
      if (uncertain) {
        if (!compute.restore.resolveStoppedNamedSnapshot) {
          yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
          return;
        }
        const reserveRetirement = Effect.fnUntraced(function* (probeStopped: boolean) {
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* store.authorize(claim);
              return yield* sql`UPDATE relay_thread_vm_backups x SET phase='retiring',
                  failed_probe_stopped_at=CASE WHEN ${probeStopped} THEN clock_timestamp() ELSE NULL END
                FROM relay_thread_vm_allocations a,relay_thread_deletions d
                WHERE x.operation_id=${uncertain.operationId} AND x.snapshot_name=${uncertain.snapshotName} AND x.phase=${uncertain.phase}
                  AND x.snapshot_id IS NOT DISTINCT FROM ${uncertain.snapshotId}
                  AND x.source_template_id IS NOT DISTINCT FROM ${uncertain.sourceTemplateId}
                  AND x.source_build_id IS NOT DISTINCT FROM ${uncertain.sourceBuildId}
                  AND (${probeStopped} OR (x.phase IN ('creating','captured') AND x.probe_receipt IS NULL AND x.verified_at IS NULL AND x.failed_probe_stopped_at IS NULL
                    AND ((x.phase='creating' AND x.snapshot_id IS NULL AND x.source_template_id IS NULL AND x.source_build_id IS NULL)
                      OR (x.phase='captured' AND x.snapshot_id IS NOT NULL AND x.source_template_id IS NOT NULL AND x.source_build_id IS NOT NULL))))
                  AND a.allocation_id=x.allocation_id AND a.thread_id=${claim.threadId} AND d.thread_id=a.thread_id
                  AND a.state='deleted' AND a.deleted_at IS NOT NULL AND (
                    (d.allow_uncertain_capture_cleanup AND a.deletion_stop_receipt->>'operationId'=d.operation_id
                      AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref
                      AND a.deletion_stop_receipt->>'generation'=x.generation::text AND a.deletion_stop_receipt->>'physicallyStopped'='true'
                      AND a.deletion_stop_receipt->>'captureAdmissionSealed'='true'
                      AND EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id AND p.generation=x.generation AND p.operation_id=a.deletion_stop_receipt->>'sourceOperationId'))
                    OR EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.source_allocation_id=a.allocation_id AND r.thread_id=a.thread_id AND r.generation=x.generation AND r.phase='completed'
                      AND r.retention_receipt->>'kind'='retained_for_stop' AND r.retention_receipt->>'recoveryOperationID'=r.operation_id AND r.retention_receipt->>'sandboxID'=a.compute_ref
                      AND r.stop_receipt->>'physicallyStopped'='true' AND r.stop_receipt-'physicallyStopped'=r.retention_receipt))
                RETURNING x.operation_id`;
            }),
          );
        });
        if (uncertain.phase !== "retiring") {
          if (uncertain.phase !== "creating" && uncertain.phase !== "captured") {
            yield* sql.withTransaction(store.authorize(claim));
            const cancelled = yield* compute.restore.cancel(
              uncertain.operationId,
              `backup-${uncertain.operationId}`,
            );
            if (
              cancelled.operationID !== uncertain.operationId ||
              cancelled.generation !== `backup-${uncertain.operationId}` ||
              cancelled.state !== "cancelled"
            ) {
              yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
              return;
            }
          }
          // Probe admission first changes captured to verifying under this row
          // lock. Reserve no-dispatch before lookup, racing both that transition
          // and a delayed recordCapture rather than treating a cancel 404 as proof.
          if (
            !(yield* reserveRetirement(!["creating", "captured"].includes(uncertain.phase))).length
          ) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
        }
        yield* sql.withTransaction(store.authorize(claim));
        const named = yield* compute.restore.resolveStoppedNamedSnapshot(uncertain.snapshotName);
        // Native39 serializes managed alias publication with Stop and reads these
        // names uncached. Its post-stop 404 cannot later become a new named root.
        // A previously recorded root still needs its exact identity reconciled.
        if (!named && uncertain.snapshotId) {
          yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
          return;
        }
        if (
          named &&
          ((uncertain.snapshotId &&
            uncertain.snapshotId !== named.snapshotId &&
            (!uncertain.sourceTemplateId || !uncertain.sourceBuildId)) ||
            (uncertain.sourceTemplateId && uncertain.sourceTemplateId !== named.sourceTemplateID) ||
            (uncertain.sourceBuildId && uncertain.sourceBuildId !== named.sourceBuildID))
        ) {
          yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
          return;
        }
        if (named) {
          const recorded = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* store.authorize(claim);
              // SDK snapshot IDs can be the unique alias spelling. The exact
              // template/build match above authorizes canonicalization; the CAS
              // still binds the original raw spelling before replacing it.
              return yield* sql`UPDATE relay_thread_vm_backups SET snapshot_id=${named.snapshotId},
                source_template_id=${named.sourceTemplateID},source_build_id=${named.sourceBuildID}
                WHERE operation_id=${uncertain.operationId} AND snapshot_name=${uncertain.snapshotName} AND phase='retiring'
                  AND snapshot_id IS NOT DISTINCT FROM ${uncertain.snapshotId}
                  AND source_template_id IS NOT DISTINCT FROM ${uncertain.sourceTemplateId}
                  AND source_build_id IS NOT DISTINCT FROM ${uncertain.sourceBuildId} RETURNING operation_id`;
            }),
          );
          if (!recorded.length) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
          const shared =
            yield* sql`SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.thread_id!=${claim.threadId} AND x.snapshot_id=${named.snapshotId} AND x.phase!='retired'
            UNION ALL SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.thread_id!=${claim.threadId} AND r.retention_retired_at IS NULL AND r.retention_receipt->>'retainedTemplateID'=${named.snapshotId}`;
          if (shared.length) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
          yield* sql.withTransaction(store.authorize(claim));
          yield* compute.deleteSnapshot(named.snapshotId);
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL WHERE operation_id=${uncertain.operationId} AND snapshot_name=${uncertain.snapshotName} AND phase='retiring'`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      const [preserved] = yield* sql<{
        operationId: string;
        receipt: unknown;
      }>`SELECT operation_id AS "operationId",retention_receipt AS receipt FROM relay_thread_vm_backup_recoveries WHERE thread_id=${claim.threadId} AND retention_receipt IS NOT NULL AND retention_retired_at IS NULL ORDER BY operation_id LIMIT 1`;
      if (preserved) {
        const receipt = yield* decodeRetention(preserved.receipt);
        if (receipt.recoveryOperationID !== preserved.operationId) {
          yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
          return;
        }
        yield* sql.withTransaction(store.authorize(claim));
        if (receipt.retainedTemplateID) {
          const shared =
            yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE thread_id!=${claim.threadId} AND retention_retired_at IS NULL AND retention_receipt->>'retainedTemplateID'=${receipt.retainedTemplateID}`;
          if (shared.length) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
          yield* compute.deleteSnapshot(receipt.retainedTemplateID);
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_backup_recoveries SET retention_retired_at=clock_timestamp() WHERE operation_id=${preserved.operationId} AND thread_id=${claim.threadId} AND retention_receipt=${sql.json(receipt)}`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      const [endpoint] = yield* sql<{
        allocationId: string;
        environmentId: string;
      }>`SELECT allocation_id AS "allocationId",environment_id AS "environmentId" FROM relay_thread_vm_bindings WHERE thread_id=${claim.threadId} AND deletion_endpoint_removed_at IS NULL ORDER BY allocation_id LIMIT 1`;
      if (endpoint) {
        if (
          !removeEndpoint ||
          !(yield* removeEndpoint(endpoint.allocationId, endpoint.environmentId))
        ) {
          yield* store.defer(claim, "endpoint_cleanup_unconfirmed");
          return;
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_bindings SET deletion_endpoint_removed_at=clock_timestamp() WHERE allocation_id=${endpoint.allocationId} AND thread_id=${claim.threadId}`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }

      const [restored] = yield* sql<{
        operationId: string;
        generation: number;
        bootAttempt: number;
        probeAttempt: number;
        prepareStarted: boolean;
        bootStarted: boolean;
        probeRemoved: boolean;
        bootReceipt: E2BRestoreStatus | null;
      }>`SELECT operation_id AS "operationId",generation,boot_attempt AS "bootAttempt",probe_attempt AS "probeAttempt",(prepare_started_at IS NOT NULL) AS "prepareStarted",(boot_prepare_started_at IS NOT NULL) AS "bootStarted",(probe_removed_at IS NOT NULL) AS "probeRemoved",boot_receipt AS "bootReceipt" FROM relay_thread_vm_restores WHERE thread_id=${claim.threadId} AND (prepare_started_at IS NOT NULL OR boot_prepare_started_at IS NOT NULL) AND deletion_cleaned_at IS NULL ORDER BY created_at,operation_id LIMIT 1`;
      if (restored) {
        const targets = [
          ...(restored.prepareStarted && !restored.probeRemoved
            ? [
                {
                  boot: false,
                  id: restoreProbeOperationId(restored.operationId, restored.probeAttempt),
                  generation: restoreComputeGeneration(restored.operationId),
                },
              ]
            : []),
          ...(restored.bootStarted
            ? [
                {
                  boot: true,
                  id: restoreBootOperationId(restored.operationId, restored.bootAttempt),
                  generation: restoreBootGeneration(restored.generation),
                },
              ]
            : []),
        ];
        for (const target of targets) {
          if (target.boot) {
            const receipt = yield* compute.restore.inspect(target.id, target.generation);
            const expected = restored.bootReceipt;
            if (
              receipt.operationID !== target.id ||
              receipt.generation !== target.generation ||
              (expected &&
                (receipt.sandboxID !== expected.sandboxID ||
                  receipt.executionID !== expected.executionID ||
                  receipt.preparedBuildID !== expected.preparedBuildID))
            ) {
              yield* store.defer(claim, "restore_cleanup_unconfirmed");
              return;
            }
            if (["active", "activating", "failed"].includes(receipt.state)) {
              // Completed restores cannot be cancelled. A positive stop also fences
              // an uncertain activation; its worker must settle before disk collection.
              yield* compute.destroy(receipt.sandboxID);
              if (receipt.state === "activating") {
                yield* store.defer(claim, "restore_cleanup_unconfirmed");
                return;
              }
              yield* compute.deleteSnapshot(receipt.sandboxID);
              continue;
            }
          }
          const receipt = yield* compute.restore.cancel(target.id, target.generation);
          if (
            receipt.operationID !== target.id ||
            receipt.generation !== target.generation ||
            receipt.state !== "cancelled"
          ) {
            yield* store.defer(claim, "restore_cleanup_unconfirmed");
            return;
          }
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_restores SET deletion_cleaned_at=clock_timestamp() WHERE operation_id=${restored.operationId}`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      const [snapshot] = yield* sql<{
        operationId: string;
        snapshotId: string;
        snapshotName: string;
        sourceTemplateId: string | null;
        sourceBuildId: string | null;
        phase: string;
        canConfirmFailedCapture: boolean;
        shared: boolean;
      }>`SELECT x.operation_id AS "operationId",x.snapshot_id AS "snapshotId",x.snapshot_name AS "snapshotName",
          x.source_template_id AS "sourceTemplateId",x.source_build_id AS "sourceBuildId",x.phase,
          COALESCE(x.phase IN ('failed','retiring') AND x.probe_receipt IS NULL AND x.verified_at IS NULL AND x.failed_probe_stopped_at IS NULL
            AND x.snapshot_id=x.source_template_id AND x.source_build_id IS NOT NULL
            AND x.snapshot_name='launchpad-backup-' || x.operation_id
            AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
            AND a.state='deleted' AND a.deleted_at IS NOT NULL
            AND ((a.deletion_stop_receipt->>'operationId'=d.operation_id
            AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id
            AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref
            AND a.deletion_stop_receipt->>'generation'=x.generation::text
            AND a.deletion_stop_receipt->>'physicallyStopped'='true'
            AND EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id
              AND p.generation=x.generation AND p.operation_id=a.deletion_stop_receipt->>'sourceOperationId'))
              OR EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.source_allocation_id=a.allocation_id AND r.thread_id=a.thread_id AND r.generation=x.generation AND r.phase='completed'
                AND r.retention_receipt->>'kind'='retained_for_stop' AND r.retention_receipt->>'recoveryOperationID'=r.operation_id AND r.retention_receipt->>'sandboxID'=a.compute_ref
                AND r.stop_receipt->>'physicallyStopped'='true' AND r.stop_receipt-'physicallyStopped'=r.retention_receipt)),false) AS "canConfirmFailedCapture",
          EXISTS(SELECT 1 FROM relay_thread_vm_backups other JOIN relay_thread_vm_allocations oa ON oa.allocation_id=other.allocation_id WHERE other.snapshot_id=x.snapshot_id AND oa.thread_id!=${claim.threadId} AND other.phase!='retired') AS shared
        FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_thread_deletions d ON d.thread_id=a.thread_id
        WHERE a.thread_id=${claim.threadId} AND x.snapshot_id IS NOT NULL AND x.phase!='retired' ORDER BY x.created_at,x.operation_id LIMIT 1`;
      if (snapshot) {
        const failed =
          snapshot.phase === "failed" &&
          snapshot.canConfirmFailedCapture &&
          compute.restore.resolveFailedNamedSnapshot
            ? yield* compute.restore.resolveFailedNamedSnapshot(snapshot.snapshotName)
            : null;
        // A unique native snapshot build has one terminal writer. Its error
        // branch never publishes ready, which restore admission requires. Failed
        // verification or a lost prepare reply still needs real cancellation.
        // Creating/captured deletion CASes also reserve no-dispatch before a
        // verifier can claim the row. Other periodic retirement paths retain
        // verified_at/probe evidence or failed_probe_stopped_at; final-save
        // aborts are excluded by the query.
        // Only this no-probe admission creates the remaining retiring shape.
        const noProbeRetirement =
          snapshot.canConfirmFailedCapture &&
          (snapshot.phase === "retiring" ||
            (failed !== null &&
              failed.snapshotId === snapshot.snapshotId &&
              failed.sourceTemplateID === snapshot.sourceTemplateId &&
              failed.sourceBuildID === snapshot.sourceBuildId));
        if (noProbeRetirement && snapshot.phase === "failed") {
          const admitted = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* store.authorize(claim);
              // Persist the retirement decision before deleting its named proof,
              // so a committed delete with a lost reply remains reconcilable.
              return yield* sql`UPDATE relay_thread_vm_backups x SET phase='retiring'
                FROM relay_thread_vm_allocations a,relay_thread_deletions d
                WHERE x.operation_id=${snapshot.operationId} AND x.snapshot_id=${snapshot.snapshotId}
                  AND x.source_template_id=${snapshot.sourceTemplateId} AND x.source_build_id=${snapshot.sourceBuildId}
                  AND x.phase='failed' AND x.probe_receipt IS NULL AND x.verified_at IS NULL AND x.failed_probe_stopped_at IS NULL
                  AND x.snapshot_name=${snapshot.snapshotName} AND x.snapshot_name='launchpad-backup-' || x.operation_id
                  AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
                  AND a.allocation_id=x.allocation_id AND a.thread_id=${claim.threadId} AND d.thread_id=a.thread_id
                  AND a.state='deleted' AND a.deleted_at IS NOT NULL
                  AND ((a.deletion_stop_receipt->>'operationId'=d.operation_id
                  AND a.deletion_stop_receipt->>'allocationId'=a.allocation_id
                  AND a.deletion_stop_receipt->>'computeRef'=a.compute_ref
                  AND a.deletion_stop_receipt->>'generation'=x.generation::text
                  AND a.deletion_stop_receipt->>'physicallyStopped'='true'
                  AND EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id
                    AND p.generation=x.generation AND p.operation_id=a.deletion_stop_receipt->>'sourceOperationId'))
                    OR EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.source_allocation_id=a.allocation_id AND r.thread_id=a.thread_id AND r.generation=x.generation AND r.phase='completed'
                      AND r.retention_receipt->>'kind'='retained_for_stop' AND r.retention_receipt->>'recoveryOperationID'=r.operation_id AND r.retention_receipt->>'sandboxID'=a.compute_ref
                      AND r.stop_receipt->>'physicallyStopped'='true' AND r.stop_receipt-'physicallyStopped'=r.retention_receipt))
                RETURNING x.operation_id`;
            }),
          );
          if (!admitted.length) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
        }
        if (!noProbeRetirement) {
          const receipt = yield* compute.restore.cancel(
            snapshot.operationId,
            `backup-${snapshot.operationId}`,
          );
          if (
            receipt.operationID !== snapshot.operationId ||
            receipt.generation !== `backup-${snapshot.operationId}` ||
            receipt.state !== "cancelled"
          ) {
            yield* store.defer(claim, "snapshot_cleanup_unconfirmed");
            return;
          }
        }
        yield* sql.withTransaction(store.authorize(claim));
        if (!snapshot.shared) yield* compute.deleteSnapshot(snapshot.snapshotId);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL WHERE operation_id=${snapshot.operationId} AND snapshot_id=${snapshot.snapshotId}`;
            yield* sql`UPDATE relay_thread_vm_saved_disks SET phase='expired',claim_id=NULL,claim_until=NULL WHERE backup_operation_id=${snapshot.operationId}`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      yield* makeThreadArtifactTransfer(sql, objects).collectOne(claim.threadId);
      if (!(yield* store.finish(claim))) yield* store.defer(claim, null);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.defer(claim, "stop_unconfirmed"),
        ManagedEndpointDeprovisioningFailed: () =>
          store.defer(claim, "endpoint_cleanup_unconfirmed"),
        ThreadArtifactConflict: () => store.defer(claim, "artifact_cleanup_unconfirmed"),
        E2BRestoreError: () => store.defer(claim, "snapshot_cleanup_unconfirmed"),
        SchemaError: () => store.defer(claim, "snapshot_cleanup_unconfirmed"),
        ThreadDeletionConflict: () => store.defer(claim, "cleanup_unconfirmed"),
        ThreadVmAllocationConflict: () => store.defer(claim, "stop_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
