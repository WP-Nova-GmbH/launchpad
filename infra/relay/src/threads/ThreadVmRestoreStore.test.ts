import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmSavedDiskWorker } from "./ThreadVmSavedDiskWorker.ts";
import { nativeRestoreFixture, nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "native snapshot restore admission (Postgres)",
  () => {
    layer(nativeRestoreTestLayer)((it) => {
      it.effect("legacy allocation storage cannot enter native restore or routine expiry", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* nativeRestoreFixture();
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.sourceAllocationId}`;
            expect((yield* Effect.flip(f.restores.begin(f.input)))._tag).toBe(
              "ThreadVmSavedDiskConflict",
            );
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.savedDiskOperationId}`;
            expect(
              yield* makeThreadVmSavedDiskWorker(
                f.sql,
                {
                  deleteSnapshot: () => Effect.die("A legacy allocation must retain its roots"),
                },
                f.hostId,
              ).runOne(),
            ).toBe(false);
            expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
          }),
        ),
      );
      it.effect(
        "validates only the native catalog and pins the independent source without creating a VM",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture(),
                claim = yield* f.prepare,
                row = (yield* f.restores.get(f.input.operationId))!;
              expect(row).toMatchObject({
                phase: "prepared",
                sourceGeneration: 1,
                targetGeneration: null,
                bootCreateStarted: false,
                bootReceipt: null,
                preparedReceipt: {
                  kind: "native-restore-catalog-v1",
                  sourceTemplateId: "snapshot",
                },
              });
              expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
              expect(yield* f.restores.begin(f.input)).toEqual(row);
              expect(
                (yield* f.restores.requireRecovery(row)).source.nativeCheckpointOperationId,
              ).toBe(f.point.native.header.operationId);
              expect(claim.operationId).toBe(row.operationId);
            }),
          ),
      );
      for (const problem of [
        "snapshot",
        "build",
        "source-generation",
        "source-point",
        "missing-native",
      ] as const) {
        it.effect(`retains quota and pins when ${problem} changes after admission`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.restores.begin(f.input);
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.restores.claim(f.hostId))!;
              const [backup] = yield* f.sql<{
                operationId: string;
                receipt: Record<string, unknown>;
              }>`SELECT operation_id AS "operationId",native_capture_receipt AS receipt FROM relay_thread_vm_backups WHERE allocation_id=${f.sourceAllocationId}`;
              expect(backup).toBeDefined();
              const receipt = { ...backup!.receipt };
              if (problem === "snapshot") receipt.sourceTemplateId = "other";
              if (problem === "build") receipt.sourceBuildId = NodeCrypto.randomUUID();
              if (problem === "source-generation") receipt.generation = 2;
              if (problem === "source-point")
                receipt.source = {
                  ...(receipt.source as Record<string, unknown>),
                  nativeCheckpointOperationId: NodeCrypto.randomUUID(),
                };
              yield* f.sql`UPDATE relay_thread_vm_backups SET native_capture_receipt=${f.sql.json(problem === "missing-native" ? {} : receipt)} WHERE operation_id=${backup!.operationId}`;
              expect((yield* Effect.flip(f.restores.beginPrepare(claim)))._tag).toBe(
                "ThreadVmRestoreConflict",
              );
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("restoring");
            }),
          ),
        );
      }
      it.effect(
        "holds the source and quota when catalog verification fails; retry makes no boot",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.restores.begin(f.input);
              let reads = 0;
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  resolveSource: () => {
                    reads++;
                    return Effect.succeed({
                      sourceTemplateID: "wrong",
                      sourceBuildID: NodeCrypto.randomUUID(),
                    });
                  },
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(reads).toBe(1);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("preparing");
              expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
            }),
          ),
      );
      it.effect("only one unexpired worker claim can prepare; stale claim cannot publish", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* nativeRestoreFixture();
            yield* f.restores.begin(f.input);
            yield* f.capacity.admitNext(f.hostId);
            const first = (yield* f.restores.claim(f.hostId))!;
            expect(yield* f.restores.claim(f.hostId)).toBeNull();
            yield* f.sql`UPDATE relay_thread_vm_restores SET claim_until=clock_timestamp()-interval '1 minute' WHERE operation_id=${first.operationId}`;
            const next = (yield* f.restores.claim(f.hostId))!;
            expect(next.claimId).not.toBe(first.claimId);
            expect((yield* Effect.flip(f.restores.beginPrepare(first)))._tag).toBe(
              "ThreadVmRestoreConflict",
            );
          }),
        ),
      );
      it.effect(
        "cancels before commit without starting compute and releases restore pins/reservation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.restores.begin(f.input);
              yield* f.restores.requestAbort(f.input.operationId);
              yield* makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                { resolveSource: () => Effect.die("Cancelled restore must not inspect or boot") },
                f.hostId,
              ).runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("released");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 1,
                operationId: null,
              });
            }),
          ),
      );
      it.effect("saved workspace expiry releases its independent backup checkpoint pin", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* nativeRestoreFixture(),
              saved = (yield* f.saved.get(f.input.savedDiskOperationId))!;
            const [before] = yield* f.sql<{
              phase: string;
            }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${saved.backupOperationId}`;
            expect(before?.phase).toBe("active");
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${saved.operationId}`;
            const claim = (yield* f.saved.claimExpired(f.hostId))!;
            expect(claim).not.toBeNull();
            expect(yield* f.saved.completeExpiry(claim)).toBe(true);
            const [after] = yield* f.sql<{
              phase: string;
            }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${saved.backupOperationId}`;
            expect(after?.phase).toBe("released");
          }),
        ),
      );
      for (const phase of ["available", "expiring"] as const) {
        it.effect(`preserves legacy ${phase} snapshots during routine saved workspace expiry`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture(),
                save = (yield* f.saved.get(f.input.savedDiskOperationId))!,
                claimId = NodeCrypto.randomUUID();
              const [backup] = yield* f.sql<{ snapshotId: string; sourceBuildId: string }>`
                SELECT snapshot_id AS "snapshotId",source_build_id AS "sourceBuildId"
                FROM relay_thread_vm_backups WHERE operation_id=${save.backupOperationId}`;
              const proof = {
                operationID: save.backupOperationId,
                generation: String(save.generation),
                preparedBuildID: backup!.sourceBuildId,
                manifestSHA256: "a".repeat(64),
                coldProbe: {
                  version: 1,
                  preparedBuildID: backup!.sourceBuildId,
                  rootfsSHA256: "b".repeat(64),
                  initSHA256: "c".repeat(64),
                  physicalStopConfirmed: true,
                  mountOnly: true,
                },
              };
              yield* f.sql`UPDATE relay_thread_vm_backups
                SET native_capture_receipt=NULL,probe_receipt=${f.sql.json(proof)},
                  phase=${phase === "available" ? "verified" : "retiring"}
                WHERE operation_id=${save.backupOperationId}`;
              yield* f.sql`UPDATE relay_thread_vm_saved_disks SET phase=${phase},
                saved_at=clock_timestamp()-interval '31 days',claim_id=${claimId},
                claim_until=clock_timestamp()+interval '1 minute' WHERE operation_id=${save.operationId}`;
              if (phase === "expiring")
                expect(
                  yield* f.saved.completeExpiry({
                    operationId: save.operationId,
                    backupOperationId: save.backupOperationId,
                    snapshotId: backup!.snapshotId,
                    claimId,
                  }),
                ).toBe(false);
              yield* f.sql`UPDATE relay_thread_vm_saved_disks SET claim_id=NULL,claim_until=NULL
                WHERE operation_id=${save.operationId}`;
              expect(
                yield* makeThreadVmSavedDiskWorker(
                  f.sql,
                  {
                    deleteSnapshot: () => Effect.die("Historical snapshots must not be deleted"),
                  },
                  f.hostId,
                ).runOne(),
              ).toBe(false);
              const [after] = yield* f.sql<{
                savedPhase: string;
                backupPhase: string;
                proof: unknown;
                claimId: string | null;
              }>`SELECT s.phase AS "savedPhase",b.phase AS "backupPhase",b.probe_receipt AS proof,
                s.claim_id AS "claimId" FROM relay_thread_vm_saved_disks s
                JOIN relay_thread_vm_backups b ON b.operation_id=s.backup_operation_id
                WHERE s.operation_id=${save.operationId}`;
              expect(after).toEqual({
                savedPhase: phase,
                backupPhase: phase === "available" ? "verified" : "retiring",
                proof,
                claimId: null,
              });
              expect(
                (yield* f.sql<{
                  phase: string;
                }>`SELECT phase FROM relay_thread_native_checkpoint_operations
                WHERE operation_id=${save.backupOperationId}`)[0]?.phase,
              ).toBe("active");
            }),
          ),
        );
      }
    });
  },
);
