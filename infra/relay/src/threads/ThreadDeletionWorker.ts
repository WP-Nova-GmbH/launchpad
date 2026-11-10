import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ManagedEndpointDeprovisioningFailed } from "../environments/ManagedEndpointProvider.ts";
import type { makeE2BRestoreClient } from "../machines/E2BRestoreClient.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import {
  E2BNativeSnapshotReceipt,
  ThreadVmCaptureSourceReceipt,
} from "../machines/E2BNativeSnapshotReceipt.ts";
import {
  confirmThreadVmCleanupIdentity,
  type ThreadVmCleanupCompute,
} from "./ThreadVmCleanupIdentity.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
import {
  NativeThreadVmRestoreCatalogReceipt,
  NativeThreadVmRestoreBootReceipt,
} from "./NativeThreadVmRestoreReceipt.ts";

const isNativeCatalog = Schema.is(NativeThreadVmRestoreCatalogReceipt);
const decodeSource = Schema.decodeUnknownEffect(ThreadVmCaptureSourceReceipt),
  decodeCapture = Schema.decodeUnknownEffect(E2BNativeSnapshotReceipt),
  decodeBoot = Schema.decodeUnknownEffect(NativeThreadVmRestoreBootReceipt);

/** Delete one exact native resource per pass. Unknown create/connect/upload outcomes hold quota. */
export function makeThreadDeletionWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: ThreadVmCleanupCompute & {
    destroy: (id: string) => Effect.Effect<void, ThreadVmComputeError>;
    deleteSnapshot: (id: string) => Effect.Effect<boolean, ThreadVmComputeError>;
    restore: Pick<ReturnType<typeof makeE2BRestoreClient>, "resolveTerminalNamedSnapshot">;
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
      const [capture] = yield* sql<{
        operationId: string;
        allocationId: string;
        generation: number;
        computeRef: string;
        sourceOperationId: string;
        snapshotName: string;
        snapshotId: string | null;
        sourceTemplateId: string | null;
        sourceBuildId: string | null;
        sourceReceipt: unknown;
        phase: string;
        captureStarted: boolean;
      }>`
        SELECT b.operation_id AS "operationId",b.allocation_id AS "allocationId",b.generation,b.compute_ref AS "computeRef",p.operation_id AS "sourceOperationId",
          b.snapshot_name AS "snapshotName",b.snapshot_id AS "snapshotId",b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",b.source_receipt AS "sourceReceipt",b.phase,b.capture_started_at IS NOT NULL AS "captureStarted"
        FROM relay_thread_vm_backups b JOIN relay_thread_vm_allocations a USING(allocation_id) JOIN relay_thread_vm_provisions p USING(allocation_id)
        WHERE a.thread_id=${claim.threadId} AND (b.phase='creating' OR (b.phase='failed' AND (b.capture_started_at IS NOT NULL OR b.snapshot_id IS NOT NULL OR b.source_template_id IS NOT NULL OR b.source_build_id IS NOT NULL))) AND b.source_receipt IS NOT NULL AND b.native_capture_receipt IS NULL ORDER BY b.created_at,b.operation_id LIMIT 1`;
      if (capture) {
        const source = yield* decodeSource(capture.sourceReceipt);
        if (
          source.allocationId !== capture.allocationId ||
          source.computeRef !== capture.computeRef ||
          source.threadId !== claim.threadId ||
          source.generation !== capture.generation ||
          source.provisionOperationId !== capture.sourceOperationId ||
          !["launchpad-backup-", "launchpad-pause-", "launchpad-final-"].some(
            (prefix) => capture.snapshotName === prefix + capture.operationId,
          )
        ) {
          yield* store.defer(claim, "snapshot_identity_conflict");
          return;
        }
        yield* sql.withTransaction(store.authorize(claim));
        const terminal =
          capture.phase === "failed"
            ? capture.captureStarted &&
              capture.snapshotId &&
              capture.sourceTemplateId &&
              capture.sourceBuildId
              ? {
                  snapshotId: capture.snapshotId,
                  sourceTemplateID: capture.sourceTemplateId,
                  sourceBuildID: capture.sourceBuildId,
                }
              : null
            : yield* compute.restore.resolveTerminalNamedSnapshot(capture.snapshotName);
        // A 404 is not an upload fence. A delayed writer may still publish this unique alias.
        if (
          !terminal ||
          (capture.snapshotId !== null && capture.snapshotId !== terminal.snapshotId) ||
          (capture.sourceTemplateId !== null &&
            capture.sourceTemplateId !== terminal.sourceTemplateID) ||
          (capture.sourceBuildId !== null && capture.sourceBuildId !== terminal.sourceBuildID)
        ) {
          yield* store.defer(claim, "snapshot_unconfirmed");
          return;
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retiring',snapshot_id=${terminal.snapshotId},source_template_id=${terminal.sourceTemplateID},source_build_id=${terminal.sourceBuildID},claim_id=NULL,claim_until=NULL
            WHERE operation_id=${capture.operationId} AND allocation_id=${capture.allocationId} AND phase=${capture.phase} AND source_receipt=${sql.json(source)}
              AND snapshot_id IS NOT DISTINCT FROM ${capture.snapshotId} AND source_template_id IS NOT DISTINCT FROM ${capture.sourceTemplateId} AND source_build_id IS NOT DISTINCT FROM ${capture.sourceBuildId}`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      const allocation = yield* store.nextAllocation(claim);
      if (allocation) {
        if (!allocation.computeRef || !allocation.operationId || !allocation.generation) {
          yield* store.defer(claim, "create_unconfirmed");
          return;
        }
        if (allocation.needsCaptureCleanup) {
          yield* store.defer(claim, "legacy_snapshot_requires_migration");
          return;
        }
        if (
          !(yield* confirmThreadVmCleanupIdentity(sql, compute, {
            allocationId: allocation.allocationId,
            threadId: claim.threadId,
            operationId: allocation.operationId,
            generation: allocation.generation,
            computeRef: allocation.computeRef,
            resourceKind: allocation.resourceKind,
          }))
        ) {
          yield* store.defer(claim, "identity_conflict");
          return;
        }
        yield* compute.destroy(allocation.computeRef);
        yield* store.stopped(claim, allocation.allocationId, allocation.computeRef);
        yield* store.defer(claim, null);
        return;
      }
      yield* store.clean(claim);
      const [legacy] =
        yield* sql`SELECT 1 FROM relay_thread_vm_backup_recoveries WHERE thread_id=${claim.threadId} AND retention_receipt IS NOT NULL AND retention_retired_at IS NULL`;
      if (legacy) {
        yield* store.defer(claim, "legacy_snapshot_requires_migration");
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
      const [restore] = yield* sql<{
        operationId: string;
        allocationId: string;
        preparedReceipt: unknown;
        bootReceipt: unknown;
        createStarted: boolean;
        pendingIngress: boolean;
      }>`
        SELECT operation_id AS "operationId",allocation_id AS "allocationId",prepared_receipt AS "preparedReceipt",boot_receipt AS "bootReceipt",boot_create_started_at IS NOT NULL AS "createStarted",boot_ingress_recovery_claim_id IS NOT NULL AS "pendingIngress"
        FROM relay_thread_vm_restores WHERE thread_id=${claim.threadId} AND (prepare_started_at IS NOT NULL OR boot_prepare_started_at IS NOT NULL OR boot_create_started_at IS NOT NULL OR boot_ingress_recovery_claim_id IS NOT NULL) AND deletion_cleaned_at IS NULL ORDER BY created_at,operation_id LIMIT 1`;
      if (restore) {
        if (!isNativeCatalog(restore.preparedReceipt)) {
          yield* store.defer(claim, "legacy_restore_requires_migration");
          return;
        }
        if (restore.pendingIngress || (restore.createStarted && !restore.bootReceipt)) {
          yield* store.defer(claim, "restore_create_unconfirmed");
          return;
        }
        if (restore.bootReceipt) {
          const boot = yield* decodeBoot(restore.bootReceipt);
          const [deleted] =
            yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=${restore.allocationId} AND thread_id=${claim.threadId} AND state='deleted' AND deleted_at IS NOT NULL AND compute_ref=${boot.sandboxId}`;
          if (
            !deleted ||
            boot.operationId !== restore.operationId ||
            boot.allocationId !== restore.allocationId ||
            boot.threadId !== claim.threadId
          ) {
            yield* store.defer(claim, "restore_cleanup_unconfirmed");
            return;
          }
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.authorize(claim);
            yield* sql`UPDATE relay_thread_vm_restores SET deletion_cleaned_at=clock_timestamp() WHERE operation_id=${restore.operationId} AND boot_ingress_recovery_claim_id IS NULL`;
          }),
        );
        yield* store.defer(claim, null);
        return;
      }
      const [snapshot] = yield* sql<{
        operationId: string;
        allocationId: string;
        computeRef: string;
        generation: number;
        snapshotId: string;
        sourceTemplateId: string | null;
        sourceBuildId: string | null;
        receipt: unknown;
        sourceReceipt: unknown;
        phase: string;
        shared: boolean;
      }>`
        SELECT b.operation_id AS "operationId",b.allocation_id AS "allocationId",b.compute_ref AS "computeRef",b.generation,b.snapshot_id AS "snapshotId",b.source_template_id AS "sourceTemplateId",b.source_build_id AS "sourceBuildId",b.native_capture_receipt AS receipt,b.source_receipt AS "sourceReceipt",b.phase,
          (EXISTS(SELECT 1 FROM relay_thread_vm_backups other JOIN relay_thread_vm_allocations othera ON othera.allocation_id=other.allocation_id WHERE othera.thread_id!=${claim.threadId} AND other.phase!='retired' AND (other.snapshot_id=b.snapshot_id OR other.source_template_id=b.snapshot_id))
            OR EXISTS(SELECT 1 FROM relay_thread_vm_backup_recoveries r WHERE r.thread_id!=${claim.threadId} AND r.retention_retired_at IS NULL AND r.retention_receipt->>'retainedTemplateID'=b.snapshot_id)) AS shared
        FROM relay_thread_vm_backups b JOIN relay_thread_vm_allocations a USING(allocation_id) WHERE a.thread_id=${claim.threadId} AND b.snapshot_id IS NOT NULL AND b.phase!='retired' ORDER BY b.created_at,b.operation_id LIMIT 1`;
      if (snapshot) {
        const source = yield* decodeSource(snapshot.sourceReceipt);
        if (
          source.threadId !== claim.threadId ||
          source.allocationId !== snapshot.allocationId ||
          source.computeRef !== snapshot.computeRef ||
          source.generation !== snapshot.generation
        ) {
          yield* store.defer(claim, "snapshot_identity_conflict");
          return;
        }
        if (snapshot.receipt) {
          const receipt = yield* decodeCapture(snapshot.receipt);
          if (
            receipt.operationId !== snapshot.operationId ||
            receipt.allocationId !== snapshot.allocationId ||
            receipt.threadId !== claim.threadId ||
            receipt.computeRef !== snapshot.computeRef ||
            receipt.generation !== snapshot.generation ||
            receipt.snapshotId !== snapshot.snapshotId ||
            receipt.sourceTemplateId !== snapshot.sourceTemplateId ||
            receipt.sourceBuildId !== snapshot.sourceBuildId
          ) {
            yield* store.defer(claim, "snapshot_identity_conflict");
            return;
          }
        } else if (
          snapshot.phase !== "retiring" ||
          !snapshot.sourceTemplateId ||
          !snapshot.sourceBuildId
        ) {
          yield* store.defer(claim, "legacy_snapshot_requires_migration");
          return;
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
        SchemaError: () => store.defer(claim, "legacy_snapshot_requires_migration"),
        ThreadDeletionConflict: () => store.defer(claim, "cleanup_unconfirmed"),
        ThreadVmAllocationConflict: () => store.defer(claim, "stop_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
