import { describe, expect, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmMigrationInventory } from "./ThreadVmMigrationInventory.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
const testLayer = Layer.unwrap(
  Effect.promise(
    async () =>
      (await import("./testUtils/nativeCheckpointCatalog.ts")).nativeCheckpointCatalogTestLayer,
  ),
);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "VM migration inventory (Postgres)",
  () => {
    layer(testLayer)((it) => {
      it.effect("only requires a cancelled pause to reopen while its allocation still exists", () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const hostId = NodeCrypto.randomUUID(),
            threadId = NodeCrypto.randomUUID(),
            allocationId = NodeCrypto.randomUUID(),
            operationId = NodeCrypto.randomUUID(),
            computeRef = `compute-${allocationId}`;
          yield* sql`INSERT INTO relay_thread_vm_hosts(host_id,max_running_vms) VALUES(${hostId},1)`;
          yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id)
            VALUES(${threadId},'org','repo','user','environment','project')`;
          yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
            VALUES(${allocationId},${threadId},'org','user','template','running',${computeRef})`;
          yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref)
            VALUES(${allocationId},${allocationId},${hostId},'create','started',${computeRef})`;
          yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase)
            VALUES(${allocationId},${allocationId},1,'created')`;
          yield* sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase)
            VALUES(${allocationId},${operationId},1,'pending')`;
          const store = makeThreadVmMigrationInventory(sql);
          const request = { hostId, pinId: "e2b-migration-cancelled-pause" };
          for (const phase of ["pending", "sealed", "cancelled"]) {
            yield* sql`UPDATE relay_thread_vm_pauses SET phase=${phase},boot_id=${NodeCrypto.randomUUID()}
              WHERE allocation_id=${allocationId}`;
            expect((yield* store.inventory(hostId)).pendingOperations).toContainEqual({
              kind: "pause",
              operationId,
              threadId,
              phase,
            });
            yield* Effect.flip(store.protect(request));
          }
          const allocations = makeThreadVmAllocationStore(sql);
          yield* allocations.requestDeletion(allocationId);
          yield* allocations.confirmDeleted({ allocationId, computeRef });
          expect((yield* store.protect(request)).blockers).toEqual([]);
        }),
      );
      it.effect("recognizes a completed deletion's exact placement tombstone", () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const hostId = NodeCrypto.randomUUID(),
            threadId = NodeCrypto.randomUUID(),
            allocationId = NodeCrypto.randomUUID(),
            operationId = NodeCrypto.randomUUID();
          yield* sql`INSERT INTO relay_thread_vm_hosts(host_id,max_running_vms) VALUES(${hostId},1)`;
          yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id)
            VALUES(${threadId},'org','repo','user','environment','project')`;
          yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,deleted_at)
            VALUES(${allocationId},${threadId},'org','user','template','deleted','2026-10-01T00:00:00.000Z')`;
          yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state)
            VALUES(${allocationId},${allocationId},${hostId},'create','released')`;
          yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase)
            VALUES(${allocationId},${allocationId},1,'cancelled')`;
          const deletions = makeThreadDeletionStore(sql);
          yield* deletions.begin({
            threadId,
            operationId,
            ownerUserId: "user",
            generation: 1,
            hostId,
            sourceDeleted: true,
          });
          const claim = (yield* deletions.claim(hostId))!;
          const store = makeThreadVmMigrationInventory(sql);
          const request = { hostId, pinId: "e2b-migration-deletion" };
          yield* Effect.flip(store.protect(request));
          expect(yield* deletions.finish(claim)).toBe(true);
          expect((yield* store.protect(request)).blockers).toEqual([]);

          for (const mismatch of ["operation", "generation"]) {
            yield* sql`UPDATE relay_thread_placements SET
              operation_id=${mismatch === "operation" ? "unknown-operation" : operationId},
              generation=${mismatch === "generation" ? 2 : 1} WHERE thread_id=${threadId}`;
            expect((yield* store.inventory(hostId)).pendingOperations).toContainEqual({
              kind: "placement",
              operationId: mismatch === "operation" ? "unknown-operation" : operationId,
              threadId,
              phase: "locked",
            });
            yield* Effect.flip(store.protect(request));
          }
        }),
      );
      it.effect(
        "protects the original saved disk after a restore is cancelled before provisioning",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              const deletion = (yield* f.store.claimDeletion(f.hostId))!;
              yield* f.store.beginDeletion(deletion);
              yield* f.store.confirmDeleted(deletion);
              const restore = makeThreadVmRestoreStore(f.sql, f.objects);
              const operationId = NodeCrypto.randomUUID(),
                allocationId = NodeCrypto.randomUUID();
              yield* restore.begin({
                operationId,
                allocationId,
                threadId: f.threadId,
                savedDiskOperationId: f.input.operationId,
                actorUserId: f.input.actorUserId,
                expectedGeneration: 1,
              });
              yield* restore.requestAbort(operationId);
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  resolveSource: () => Effect.die("Cancelled before preparation"),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* restore.get(operationId))?.phase).toBe("aborted");
              const report = yield* makeThreadVmMigrationInventory(f.sql).protect({
                hostId: f.hostId,
                pinId: "e2b-migration-cancelled-restore",
              });
              expect(report.allocations).toContainEqual(
                expect.objectContaining({
                  allocationId,
                  state: "deleted",
                  generation: null,
                }),
              );
              expect(report.blockers).toEqual([]);
              expect(report.hostDrainRequired).toBe(false);
              expect(report.backups).toContainEqual(
                expect.objectContaining({
                  phase: "verified",
                  pinOperationIds: expect.arrayContaining(["e2b-migration-cancelled-restore"]),
                }),
              );
            }),
          ),
      );
      it.effect(
        "takes a private read-only inventory and pins all roots idempotently, without releasing existing pins",
        () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            const hostId = NodeCrypto.randomUUID(),
              threadId = NodeCrypto.randomUUID(),
              allocationId = NodeCrypto.randomUUID(),
              backupId = NodeCrypto.randomUUID(),
              otherHostId = NodeCrypto.randomUUID(),
              otherThreadId = NodeCrypto.randomUUID(),
              otherAllocationId = NodeCrypto.randomUUID(),
              otherBackupId = NodeCrypto.randomUUID();
            for (const [host, thread, allocation, backup] of [
              [hostId, threadId, allocationId, backupId],
              [otherHostId, otherThreadId, otherAllocationId, otherBackupId],
            ] as const) {
              yield* sql`INSERT INTO relay_thread_vm_hosts(host_id,max_running_vms) VALUES(${host},1)`;
              yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id)
            VALUES(${thread},'org','repo','user','environment','project')`;
              yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,compute_ref,state,runtime_protocol)
            VALUES(${allocation},${thread},'org','user','template',${`compute-${allocation}`},'running','legacy')`;
              yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state)
            VALUES(${allocation},${allocation},${host},'create','started')`;
              yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase)
                VALUES(${allocation},${allocation},1,'created')`;
              yield* sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,snapshot_id,source_template_id,source_build_id,probe_receipt,phase)
            VALUES(${backup},${allocation},1,${`compute-${allocation}`},${`name-${backup}`},${`snapshot-${backup}`},'template','build',
              '{"secret":"must-stay-in-database"}'::jsonb,'verified')`;
            }
            const store = makeThreadVmMigrationInventory(sql);
            // A later move changes placement generation; historical VM identity must retain its own generation.
            yield* sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${threadId}`;
            const before = yield* store.inventory(hostId);
            expect(before.allocations[0]).toMatchObject({ generation: 1, placementGeneration: 2 });
            expect(before.backups.map((backup) => backup.operationId)).toEqual([backupId]);
            expect(before.hostQuiescenceVerified).toBe(false);
            expect(before.stockCompatibilityVerified).toBe(false);
            expect(before.automaticCutoverSupported).toBe(false);
            expect(before.legacyBackupOperationIds).toEqual([backupId]);
            expect(before.legacyAllocationIds).toEqual([allocationId]);
            expect(before.hostDrainRequired).toBe(true);
            expect(yield* encodeReport(before)).not.toContain("must-stay-in-database");
            expect(before.backups[0]!.pinOperationIds).toEqual([]);
            yield* sql`INSERT INTO relay_thread_vm_backup_pins(backup_operation_id,operation_id)
              VALUES(${backupId},'existing-consumer')`;
            const request = { hostId, pinId: "e2b-migration-test" };
            yield* store.protect(request);
            const protectedReport = yield* store.protect(request);
            expect(
              yield* makeThreadVmBackupRetentionStore(sql)
                .pin({
                  threadId,
                  backupOperationId: backupId,
                  operationId: "native-consumer-must-refuse",
                })
                .pipe(Effect.isFailure),
            ).toBe(true);
            const [unchanged] = yield* sql<{
              native: unknown;
            }>`SELECT native_capture_receipt AS native
              FROM relay_thread_vm_backups WHERE operation_id=${backupId}`;
            expect(unchanged?.native).toBeNull();
            expect(protectedReport.backups[0]!.pinOperationIds).toEqual([
              "e2b-migration-test",
              "existing-consumer",
            ]);
            expect((yield* store.inventory(otherHostId)).backups[0]!.pinOperationIds).toEqual([]);
            yield* store.release(request);
            expect((yield* store.inventory(hostId)).backups[0]!.pinOperationIds).toEqual([
              "existing-consumer",
            ]);

            yield* sql`UPDATE relay_thread_vm_backups SET phase='retiring' WHERE operation_id=${backupId}`;
            expect((yield* store.inventory(hostId)).blockers).toContainEqual({
              kind: "backup",
              id: backupId,
              state: "retiring",
            });
            yield* Effect.flip(store.protect(request));
            expect((yield* store.inventory(hostId)).backups[0]!.pinOperationIds).toEqual([
              "existing-consumer",
            ]);
          }),
      );
    });
  },
);
