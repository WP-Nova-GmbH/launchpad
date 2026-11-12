import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupRecoveryStore } from "./ThreadVmBackupRecoveryStore.ts";
import { makeThreadVmBackupRecoveryWorker } from "./ThreadVmBackupRecoveryWorker.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { laterAttachmentCheckpoint } from "./testUtils/attachmentCheckpointCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture(),
    captureOperationId = NodeCrypto.randomUUID();
  const source = {
    ...f,
    storeNative: {
      ...f.storeNative,
      publish: (input: Parameters<typeof f.storeNative.publish>[0]) =>
        f.sql`UPDATE relay_thread_placements SET operation_id=${captureOperationId} WHERE thread_id=${f.threadId}`.pipe(
          Effect.andThen(f.storeNative.publish(input)),
        ),
    },
  };
  const point = yield* laterAttachmentCheckpoint(source, 1, captureOperationId);
  yield* f.upload(point.attachments);
  yield* f.attachmentStore.publish({
    threadId: f.threadId,
    operationId: point.attachments.header.operationId,
    manifestArtifactId: point.attachments.artifactId,
    nativeCheckpointOperationId: point.native.header.operationId,
  });
  yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
  yield* f.sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id,phase,source_sequence,receipt_count) VALUES(${f.threadId},${NodeCrypto.randomUUID()},'active',${point.sourceSequence},0)`;
  const backupOperationId = NodeCrypto.randomUUID(),
    sourceBuildId = NodeCrypto.randomUUID();
  const sourceReceipt = {
    allocationId: f.input.allocationId,
    computeRef: f.computeRef,
    threadId: f.threadId,
    generation: 1,
    environmentId: f.sourceEnvironmentId,
    provisionOperationId: f.input.allocationId,
    captureOperationId,
    bootId: NodeCrypto.randomUUID(),
    sealEpoch: 1,
    sourceSequence: point.sourceSequence,
    nativeCheckpointOperationId: point.native.header.operationId,
  };
  yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,source_receipt,phase) VALUES(${backupOperationId},${f.input.allocationId},1,${f.computeRef},${`launchpad-backup-${backupOperationId}`},${f.sql.json(sourceReceipt)},'pending')`;
  const capture = (yield* f.backup.claim(f.hostId))!;
  expect(capture).not.toBeNull();
  yield* f.backup.beginCapture(capture);
  yield* f.backup.recordCapture(capture, {
    snapshotId: `snapshot-${backupOperationId}`,
    sourceTemplateId: `snapshot-${backupOperationId}`,
    sourceBuildId,
  });
  const store = makeThreadVmBackupRecoveryStore(f.sql, f.objects),
    candidate = (yield* store.candidate(f.threadId))!;
  const input = {
    threadId: f.threadId,
    actorUserId: f.input.actorUserId,
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    expectedGeneration: 1,
    backup: {
      sourceAllocationId: f.input.allocationId,
      backupOperationId,
      capturedAt: candidate.capturedAt!,
      nativeCheckpointOperationId: point.native.header.operationId,
    },
  };
  const compute = { inspect: () => Effect.succeed(f.info), destroy: () => Effect.void };
  const worker = (
    overrides: Partial<Parameters<typeof makeThreadVmBackupRecoveryWorker>[2]> = {},
  ) => makeThreadVmBackupRecoveryWorker(f.sql, f.objects, { ...compute, ...overrides }, f.hostId);
  const retry = f.sql`UPDATE relay_thread_vm_backup_recoveries SET retry_at=clock_timestamp() WHERE operation_id=${input.operationId}`;
  return {
    ...f,
    sourceAllocationId: f.input.allocationId,
    input,
    point,
    store,
    candidate,
    worker,
    retry,
    backupOperationId,
    sourceBuildId,
    restores: makeThreadVmRestoreStore(f.sql, f.objects),
    placements: makeThreadPlacementStore(f.sql),
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "completed native backup recovery (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "refuses native recovery for legacy allocation storage before revoking its owner",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.sourceAllocationId}`;
              expect((yield* Effect.flip(f.store.begin(f.input)))._tag).toBe(
                "ThreadVmBackupRecoveryConflict",
              );
              expect(yield* f.store.claim(f.hostId)).toBeNull();
              expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
              expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("running");
              expect(
                (yield* f.sql`SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${f.sourceAllocationId} AND revoked_at IS NULL`)
                  .length,
              ).toBe(1);
            }),
          ),
      );
      it.effect(
        "pins completed snapshot and independent history before deleting the broken source, then hands off to native restore",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              expect(f.candidate.available).toBe(true);
              yield* f.store.begin(f.input);
              let deletes = 0;
              const worker = f.worker({
                destroy: () =>
                  Effect.gen(function* () {
                    deletes++;
                    const row = (yield* f.store.get(f.input.operationId))!;
                    expect(row.phase).toBe("retained");
                    expect(row.independentHistory).not.toBeNull();
                    expect(row.retentionReceipt).toBeNull();
                    expect((yield* f.store.selectedReceipt(row)).sourceBuildId).toBe(
                      f.sourceBuildId,
                    );
                  }).pipe(Effect.orDie),
              });
              for (let i = 0; i < 4; i++) expect(yield* worker.runOne()).toBe(true);
              const row = (yield* f.restores.get(f.input.operationId))!;
              expect(deletes).toBe(1);
              expect(row).toMatchObject({
                phase: "pending",
                generation: 1,
                sourceGeneration: 1,
                targetGeneration: null,
                sourceBuildId: f.sourceBuildId,
              });
              expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("deleted");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect((yield* f.store.get(f.input.operationId))?.stopReceipt).toMatchObject({
                kind: "native-recovery-source-deleted-v1",
                acknowledged: true,
                computeRef: f.computeRef,
              });
            }),
          ),
      );
      for (const problem of [
        "generation",
        "owner",
        "backup",
        "captured-at",
        "checkpoint",
      ] as const) {
        it.effect(
          `rejects changed ${problem} before taking the recovery hold or deleting anything`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const input = {
                  ...f.input,
                  ...(problem === "generation" ? { expectedGeneration: 2 } : {}),
                  ...(problem === "owner" ? { actorUserId: "other" } : {}),
                  backup: {
                    ...f.input.backup,
                    ...(problem === "backup" ? { backupOperationId: NodeCrypto.randomUUID() } : {}),
                    ...(problem === "captured-at"
                      ? { capturedAt: "2020-01-01T00:00:00.000Z" }
                      : {}),
                    ...(problem === "checkpoint"
                      ? { nativeCheckpointOperationId: NodeCrypto.randomUUID() }
                      : {}),
                  },
                };
                yield* Effect.flip(f.store.begin(input));
                expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
                expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("running");
              }),
            ),
        );
      }
      it.effect(
        "native DELETE uncertainty retains source quota and all recovery pins; exact retry can complete",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              let deletes = 0;
              const worker = f.worker({
                destroy: () =>
                  ++deletes === 1
                    ? Effect.fail(
                        new ThreadVmComputeError({ operation: "destroy", message: "lost reply" }),
                      )
                    : Effect.void,
              });
              yield* worker.runOne();
              yield* worker.runOne();
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("retained");
              expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("running");
              yield* f.retry;
              yield* worker.runOne();
              yield* worker.runOne();
              expect(deletes).toBe(2);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("pending");
            }),
          ),
      );
      it.effect("does not delete source after native metadata changes", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            const worker = f.worker({
              inspect: () =>
                Effect.succeed({
                  ...f.info,
                  metadata: {
                    ...f.info.metadata,
                    "launchpad.operation_id": NodeCrypto.randomUUID(),
                  },
                }),
              destroy: () => Effect.die("Wrong source must not be deleted"),
            });
            yield* worker.runOne();
            yield* worker.runOne();
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("retained");
            expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("running");
          }),
        ),
      );
      it.effect("refuses historical cold proof without a completed native receipt", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.sql`UPDATE relay_thread_vm_backups SET native_capture_receipt=${f.sql.json({ kind: "historical-cold-proof" })} WHERE operation_id=${f.backupOperationId}`;
            yield* Effect.flip(f.store.begin(f.input));
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
          }),
        ),
      );
      it.effect("cancels an undispatched recovery durably and never reuses its operation ID", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.cancelIntent(f.input);
            yield* Effect.flip(f.store.begin(f.input));
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
          }),
        ),
      );
      it.effect(
        "pending cancellation releases pins; after retention begins the stopped-source recovery cannot roll back",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const first = yield* fixture();
              yield* first.store.begin(first.input);
              yield* first.store.cancel(first.input.operationId);
              expect((yield* first.placements.get(first.threadId))?.operationId).toBeNull();
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              const worker = f.worker();
              yield* worker.runOne();
              yield* worker.runOne();
              yield* Effect.flip(f.store.cancel(f.input.operationId));
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("running");
            }),
          ),
      );
    });
  },
);
