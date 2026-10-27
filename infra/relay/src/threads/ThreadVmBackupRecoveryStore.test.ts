import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayDb } from "../db.ts";
import { makeThreadVmRestoreServingStore } from "./ThreadVmRestoreServingStore.ts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import { makeThreadVmRestoreImportStore } from "./ThreadVmRestoreImportStore.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { makeThreadDeletionWorker } from "./ThreadDeletionWorker.ts";
import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import {
  E2BRestoreError,
  type E2BExecutionRetentionReceipt,
  type E2BRestoreStatus,
} from "../machines/E2BRestoreClient.ts";
import {
  makeThreadVmBackupRecoveryStore,
  type ThreadVmBackupRecoveryInput,
} from "./ThreadVmBackupRecoveryStore.ts";
import { makeThreadVmBackupRecoveryWorker } from "./ThreadVmBackupRecoveryWorker.ts";
import {
  makeThreadVmRestoreStore,
  restoreComputeGeneration,
  restoreProbeOperationId,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  yield* f.upload(f.attachments);
  yield* f.publishAttachments;
  yield* f.sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id,phase,source_sequence,receipt_count) VALUES(${f.threadId},${NodeCrypto.randomUUID()},'active',${f.sourceSequence},0)`;
  const backupOperationId = NodeCrypto.randomUUID();
  yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase) VALUES(${backupOperationId},${f.input.allocationId},1,${f.computeRef},${`launchpad-backup-${backupOperationId}`},'pending')`;
  const capture = (yield* f.backup.claim(f.hostId))!;
  expect(yield* f.backup.beginCapture(capture)).toBe(true);
  const sourceBuildId = NodeCrypto.randomUUID();
  yield* f.backup.recordCapture(capture, {
    snapshotId: `snapshot-${backupOperationId}`,
    sourceTemplateId: `template-${backupOperationId}`,
    sourceBuildId,
  });
  const probe = (yield* f.backup.claim(f.hostId))!,
    preparedBuildID = NodeCrypto.randomUUID();
  yield* f.backup.markProbeReady(probe, {
    operationID: backupOperationId,
    generation: `backup-${backupOperationId}`,
    preparedBuildID,
    manifestSHA256: "a".repeat(64),
    coldProbe: {
      version: 1,
      preparedBuildID,
      rootfsSHA256: "b".repeat(64),
      initSHA256: "c".repeat(64),
      physicalStopConfirmed: true,
      mountOnly: true,
    },
  });
  yield* f.backup.complete(probe);
  const store = makeThreadVmBackupRecoveryStore(f.sql, f.objects),
    candidate = (yield* store.candidate(f.threadId))!;
  const input: ThreadVmBackupRecoveryInput = {
    threadId: f.threadId,
    actorUserId: f.input.actorUserId,
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    expectedGeneration: 1,
    backup: {
      sourceAllocationId: f.input.allocationId,
      backupOperationId,
      capturedAt: candidate.capturedAt!,
      nativeCheckpointOperationId: f.native.header.operationId,
    },
  };
  const nativeCandidate = {
    sandboxID: f.computeRef,
    executionID: NodeCrypto.randomUUID(),
    buildID: NodeCrypto.randomUUID(),
    metadata: f.info.metadata,
    disposition: "ready_tip" as const,
  };
  const receipt: E2BExecutionRetentionReceipt = {
    ...nativeCandidate,
    version: 1,
    kind: "retained_for_stop",
    recoveryOperationID: input.operationId,
    retainedTemplateID: `damaged-tip-${input.operationId}`,
    retainedBuildIDs: [nativeCandidate.buildID],
    requestSHA256: "d".repeat(64),
  };
  const calls: string[] = [];
  const compute = {
    requireExecutionRetention: () => Effect.void,
    retentionCandidate: (_id: string) =>
      Effect.sync(() => {
        calls.push("candidate");
        return nativeCandidate;
      }),
    retainForStop: () =>
      Effect.sync(() => {
        calls.push("retain");
        return receipt;
      }),
    stopRetained: (_receipt: E2BExecutionRetentionReceipt) =>
      Effect.sync(() => {
        calls.push("stop");
        return { ...receipt, physicallyStopped: true as const };
      }),
  };
  const worker = makeThreadVmBackupRecoveryWorker(f.sql, f.objects, compute, f.hostId),
    restores = makeThreadVmRestoreStore(f.sql, f.objects);
  const ready = Effect.gen(function* () {
    yield* store.begin(input);
    for (let i = 0; i < 4; i++) expect(yield* worker.runOne()).toBe(true);
    return (yield* restores.get(input.operationId))!;
  });
  const retry = f.sql`UPDATE relay_thread_vm_backup_recoveries SET retry_at=clock_timestamp() WHERE operation_id=${input.operationId}`;
  return {
    ...f,
    store,
    candidate,
    input,
    nativeCandidate,
    receipt,
    compute,
    calls,
    worker,
    restores,
    ready,
    retry,
    sourceBuildId,
    backupOperationId,
  };
});
const activate = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const row = (yield* f.restores.get(f.input.operationId))!;
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${f.input.actorUserId},'admin','now','now')`;
  yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES('github.com/test/repo','repo','org','now') ON CONFLICT DO NOTHING`;
  const prepared = (
    operationID: string,
    sandboxID: string,
    generation: string,
  ): E2BRestoreStatus => {
    const preparedBuildID = NodeCrypto.randomUUID();
    return {
      operationID,
      sandboxID,
      generation,
      executionID: NodeCrypto.randomUUID(),
      preparedBuildID,
      state: "prepared",
      manifestSHA256: "d".repeat(64),
      coldProbe: {
        version: 1,
        preparedBuildID,
        rootfsSHA256: "b".repeat(64),
        initSHA256: "c".repeat(64),
        physicalStopConfirmed: true,
        mountOnly: true,
      },
    };
  };
  yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
  const probe = prepared(
      restoreProbeOperationId(row.operationId, row.probeAttempt),
      `offline-${row.allocationId}`,
      restoreComputeGeneration(row.operationId),
    ),
    boot = prepared(
      restoreBootOperationId(row.operationId, row.bootAttempt),
      `fresh-${row.allocationId}`,
      "2",
    );
  const claim = (yield* f.restores.claim(f.hostId))!;
  yield* f.restores.beginPrepare(claim);
  yield* f.restores.recordPrepared(claim, probe);
  yield* f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
  const serving = makeThreadVmRestoreServingStore(f.sql, f.objects),
    preparing = (yield* serving.claim(f.hostId))!;
  yield* serving.recordProbeRemoved(preparing, { ...probe, state: "cancelled" });
  yield* serving.beginPrepare(preparing);
  yield* serving.recordPrepared(preparing, boot);
  yield* serving.commit((yield* serving.claim(f.hostId))!, boot);
  yield* serving.recordActive((yield* serving.claim(f.hostId))!, { ...boot, state: "active" });
  const credential = NodeCrypto.randomUUID(),
    environment = EnvironmentId.make(`recovered-${credential}`);
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'fresh-key',${credential},'now','now')`;
  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${environment},${row.allocationId},${f.threadId},'repo',2,'fresh-key',${credential})`;
  yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at) VALUES(${row.allocationId},${row.operationId},${credential},${environment},'fresh-key',${credential},'sealed-fixture',clock_timestamp(),clock_timestamp())`;
  yield* makeThreadVmRestoreEnrollmentStore(f.sql).assigned({
    enrolled: true,
    operationId: row.operationId,
    allocationId: row.allocationId,
    threadId: ThreadId.make(f.threadId),
    generation: 2,
    environmentId: environment,
  });
  const db = yield* PgDrizzle.makeWithDefaults(),
    imports = makeThreadVmRestoreImportStore(f.sql, f.objects),
    importClaim = (yield* imports.claim(f.hostId))!;
  const receipt = {
    version: 1 as const,
    operationId: row.operationId,
    environmentId: environment,
    scope: {
      allocationId: row.allocationId,
      threadId: ThreadId.make(f.threadId),
      repositoryId: "repo",
      generation: 2,
    },
    projectId: ProjectId.make(`vm:${f.threadId}`),
    workspaceRoot: "/workspace/project",
    checkoutPath: "/workspace/project",
    branch: "main",
    revision: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    sourceEnvironmentId: EnvironmentId.make(f.sourceEnvironmentId),
    sourceSequence: f.sourceSequence,
    nativeManifestArtifactId: f.native.artifactId,
    attachmentManifestArtifactId: f.attachments.artifactId,
    sequence: 10,
    execution: "frozen" as const,
  };
  yield* imports.record(importClaim, receipt).pipe(Effect.provideService(RelayDb, db));
  yield* imports.finish(receipt).pipe(Effect.provideService(RelayDb, db));
  return { environment, credential, boot, receipt };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "verified-backup recovery admission and workers",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "rejects an existing destination allocation before holding or stopping its source",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* Effect.flip(
                f.store.begin({ ...f.input, allocationId: f.input.backup.sourceAllocationId }),
              );
              expect(yield* f.store.get(f.input.operationId)).toBeNull();
              const [source] = yield* f.sql<{
                operationId: string | null;
                state: string;
              }>`SELECT t.operation_id AS "operationId",a.state FROM relay_thread_placements t JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id WHERE a.allocation_id=${f.input.backup.sourceAllocationId}`;
              expect(source).toEqual({ operationId: null, state: "running" });
              expect(f.calls).toEqual([]);
            }),
          ),
      );
      it.effect(
        "a held recovery destination cannot be stolen by another allocation reservation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                other = yield* fixture();
              yield* f.store.begin(f.input);
              const allocations = makeThreadVmAllocationStore(f.sql);
              yield* Effect.flip(
                allocations.reserve({
                  allocationId: f.input.allocationId,
                  threadId: other.threadId,
                  organizationId: "org",
                  ownerUserId: other.input.actorUserId,
                  templateId: "template",
                }),
              );
              expect(yield* allocations.get(f.input.allocationId)).toBeNull();
              for (let i = 0; i < 4; i++) yield* f.worker.runOne();
              expect(yield* allocations.get(f.input.allocationId)).toMatchObject({
                threadId: f.threadId,
                state: "creating",
              });
              expect((yield* f.restores.get(f.input.operationId))?.backupRecoveryOperationId).toBe(
                f.input.operationId,
              );
            }),
          ),
      );
      it.effect("rejects the source capacity operation ID before holding or stopping compute", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const [source] = yield* f.sql<{
              operationId: string;
            }>`SELECT operation_id AS "operationId" FROM relay_thread_vm_provisions WHERE allocation_id=${f.input.backup.sourceAllocationId}`;
            expect(source).toBeDefined();
            yield* Effect.flip(f.store.begin({ ...f.input, operationId: source!.operationId }));
            expect(yield* f.store.get(source!.operationId)).toBeNull();
            const [placement] = yield* f.sql<{
              operationId: string | null;
            }>`SELECT operation_id AS "operationId" FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
            expect(placement?.operationId).toBeNull();
            expect(f.calls).toEqual([]);
          }),
        ),
      );
      it.effect("accepts exact restored child-attempt lineage and rejects a forged parent", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.worker.runOne();
            const metadata = {
                ...f.nativeCandidate.metadata,
                "launchpad.operation_id": restoreBootOperationId(
                  f.input.backup.sourceAllocationId,
                  2,
                ),
                "launchpad.restore": "v1",
                "launchpad.restore_parent_operation_id": f.input.backup.sourceAllocationId,
                "launchpad.restore_boot_attempt": "2",
              },
              candidate = { ...f.nativeCandidate, metadata };
            const claim = (yield* f.store.claim(f.hostId))!;
            yield* Effect.flip(
              f.store.beginRetention(claim, {
                ...candidate,
                metadata: {
                  ...metadata,
                  "launchpad.restore_parent_operation_id": NodeCrypto.randomUUID(),
                },
              }),
            );
            expect((yield* f.store.beginRetention(claim, candidate)).phase).toBe("retaining");
          }),
        ),
      );
      it.effect("unsupported native runtime cannot make a pending recovery uncancellable", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.worker.runOne();
            const worker = makeThreadVmBackupRecoveryWorker(
              f.sql,
              f.objects,
              {
                ...f.compute,
                requireExecutionRetention: () =>
                  Effect.fail(
                    new E2BRestoreError({
                      operation: "execution retention capability",
                      reason: "unsupported",
                    }),
                  ),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("pending");
            expect(f.calls).toEqual([]);
            yield* f.store.cancelIntent(f.input);
          }),
        ),
      );
      it.effect("a generic native 409 cannot refresh an uncertain retention request", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.worker.runOne();
            const worker = makeThreadVmBackupRecoveryWorker(
              f.sql,
              f.objects,
              {
                ...f.compute,
                retainForStop: () =>
                  Effect.fail(
                    new E2BRestoreError({
                      operation: "retain for stop",
                      reason: "http",
                      status: 409,
                    }),
                  ),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("retaining");
            expect((yield* f.store.get(f.input.operationId))?.retentionCandidate).toEqual(
              f.nativeCandidate,
            );
            yield* Effect.flip(f.store.cancelIntent(f.input));
          }),
        ),
      );
      it.effect(
        "enrolls and imports into the fresh generation, releasing recovery pins only after readiness",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.ready;
              const active = yield* activate(f);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("completed");
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("completed");
              const [placement] = yield* f.sql<{
                generation: number;
                environmentId: string;
                operationId: string | null;
              }>`SELECT generation,environment_id AS "environmentId",operation_id AS "operationId" FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
              expect(placement).toEqual({
                generation: 2,
                environmentId: active.environment,
                operationId: null,
              });
              expect(
                (yield* f.sql`SELECT 1 FROM relay_thread_vm_backup_pins WHERE operation_id=${f.input.operationId}`)
                  .length,
              ).toBe(0);
              expect(
                (yield* f.sql`SELECT 1 FROM relay_thread_artifact_pins WHERE operation_id=${`recovery-history:${f.input.operationId}`}`)
                  .length,
              ).toBe(0);
            }),
          ),
      );
      for (const phase of ["creating", "failed"] as const)
        it.effect(
          `permanent owner deletion retires damaged roots and certified-source ${phase} captures`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  unknown = NodeCrypto.randomUUID(),
                  failedIdentity = {
                    snapshotId: `failed-${unknown}`,
                    sourceTemplateId: `failed-${unknown}`,
                    sourceBuildId: NodeCrypto.randomUUID(),
                  };
                yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase) VALUES(${unknown},${f.input.backup.sourceAllocationId},1,${f.computeRef},${`launchpad-backup-${unknown}`},'pending')`;
                const capture = (yield* f.backup.claim(f.hostId))!;
                expect(yield* f.backup.beginCapture(capture)).toBe(true);
                if (phase === "failed")
                  expect(yield* f.backup.failCapture(capture, failedIdentity)).toBe(true);
                yield* f.ready;
                const active = yield* activate(f),
                  deletions = makeThreadDeletionStore(f.sql);
                const [oldSource] =
                  yield* f.sql`SELECT deletion_stop_receipt FROM relay_thread_vm_allocations WHERE allocation_id=${f.input.backup.sourceAllocationId}`;
                expect(oldSource?.deletion_stop_receipt).toBeNull();
                yield* deletions.begin({
                  threadId: f.threadId,
                  operationId: NodeCrypto.randomUUID(),
                  ownerUserId: f.input.actorUserId,
                  generation: 2,
                  hostId: f.hostId,
                });
                const removed: string[] = [];
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () =>
                      Effect.succeed({
                        ...f.info,
                        sandboxId: active.boot.sandboxID,
                        metadata: {
                          ...f.info.metadata,
                          "launchpad.allocation_id": f.input.allocationId,
                          "launchpad.operation_id": f.input.operationId,
                          "launchpad.generation": "2",
                        },
                      }),
                    destroy: (id) =>
                      Effect.sync(() => {
                        removed.push(`stop:${id}`);
                      }),
                    deleteSnapshot: (id) =>
                      Effect.sync(() => {
                        removed.push(id);
                        return true;
                      }),
                    restore: {
                      inspect: () => Effect.succeed({ ...active.boot, state: "active" as const }),
                      cancel: (id, generation) =>
                        id === unknown
                          ? Effect.die("A never-probed capture must not require cancellation")
                          : Effect.succeed({
                              operationID: id,
                              generation,
                              sandboxID: "cancelled-probe",
                              executionID: NodeCrypto.randomUUID(),
                              preparedBuildID: NodeCrypto.randomUUID(),
                              state: "cancelled",
                            }),
                      resolveStoppedNamedSnapshot: () => Effect.succeed(null),
                      resolveFailedNamedSnapshot: (name) => {
                        expect(name).toBe(`launchpad-backup-${unknown}`);
                        return Effect.succeed({
                          snapshotId: failedIdentity.snapshotId,
                          sourceTemplateID: failedIdentity.sourceTemplateId,
                          sourceBuildID: failedIdentity.sourceBuildId,
                        });
                      },
                    },
                  },
                  f.hostId,
                  () => Effect.succeed(true),
                );
                // Check the newly admitted deletion, then reconcile one exact source per pass.
                yield* worker.runOne();
                for (let i = 0; i < 9; i++) {
                  yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                  yield* worker.runOne();
                }
                expect((yield* f.backup.get(unknown))?.phase).toBe("retired");
                expect(removed).toContain(f.receipt.retainedTemplateID);
                if (phase === "failed") expect(removed).toContain(failedIdentity.snapshotId);
                const [retired] = yield* f.sql<{
                  retired: boolean;
                }>`SELECT retention_retired_at IS NOT NULL AS retired FROM relay_thread_vm_backup_recoveries WHERE operation_id=${f.input.operationId}`;
                expect(retired?.retired).toBe(true);
              }),
            ),
        );
      for (const problem of [
        "missing-stop",
        "wrong-generation",
        "wrong-receipt",
        "malformed-pending",
      ] as const)
        it.effect(`keeps deletion blocked for ${problem} on a recovered damaged source`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                unknown = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,source_build_id) VALUES(${unknown},${f.input.backup.sourceAllocationId},1,${f.computeRef},${`launchpad-backup-${unknown}`},${problem === "malformed-pending" ? "pending" : "creating"},${problem === "malformed-pending" ? NodeCrypto.randomUUID() : null})`;
              yield* f.ready;
              yield* activate(f);
              if (problem === "missing-stop")
                yield* f.sql`UPDATE relay_thread_vm_backup_recoveries SET stop_receipt=stop_receipt-'physicallyStopped' WHERE operation_id=${f.input.operationId}`;
              if (problem === "wrong-generation")
                yield* f.sql`UPDATE relay_thread_vm_backup_recoveries SET generation=2 WHERE operation_id=${f.input.operationId}`;
              if (problem === "wrong-receipt")
                yield* f.sql`UPDATE relay_thread_vm_backup_recoveries SET retention_receipt=jsonb_set(retention_receipt,'{recoveryOperationID}',${f.sql.json(NodeCrypto.randomUUID())}) WHERE operation_id=${f.input.operationId}`;
              const deletions = makeThreadDeletionStore(f.sql);
              expect(
                (yield* Effect.flip(
                  deletions.begin({
                    threadId: f.threadId,
                    operationId: NodeCrypto.randomUUID(),
                    ownerUserId: f.input.actorUserId,
                    generation: 2,
                    hostId: f.hostId,
                  }),
                ))._tag,
              ).toBe("ThreadDeletionConflict");
              expect(yield* deletions.get(f.threadId)).toBeNull();
            }),
          ),
        );
      it.effect(
        "pins the exact workspace/native selection before stop and reuses cold restore without final-save rows",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              expect(f.candidate.available).toBe(true);
              const admitted = yield* f.store.begin(f.input);
              expect(yield* f.store.begin(f.input)).toEqual(admitted);
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "running",
              );
              expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
              expect(
                (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1)).restore,
              ).toMatchObject({ phase: "pending", canCancel: true });
              const row = yield* f.ready;
              expect(f.calls).toEqual(["candidate", "retain", "stop"]);
              expect(row.savedDiskOperationId).toBeNull();
              expect(row.backupRecoveryOperationId).toBe(f.input.operationId);
              expect(row.independentHistory?.nativeBoundary.checkpointOperationId).toBe(
                f.native.header.operationId,
              );
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "deleted",
              );
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(f.input.operationId))?.state,
              ).toBe("waiting");
              expect(
                (yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE thread_id=${f.threadId}`)
                  .length,
              ).toBe(0);
              expect(
                (yield* f.sql`SELECT 1 FROM relay_thread_vm_saved_disks WHERE thread_id=${f.threadId}`)
                  .length,
              ).toBe(0);
              yield* f.sql.withTransaction(f.restores.requireRecovery(row));
              expect(
                (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1)).restore?.canCancel,
              ).toBe(false);
            }),
          ),
      );
      for (const problem of [
        "owner",
        "generation",
        "allocation",
        "timestamp",
        "native",
        "proof",
        "unknown-time",
      ] as const)
        it.effect(`refuses ${problem} without holding placement or deleting compute`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const input = { ...f.input, backup: { ...f.input.backup } };
              if (problem === "owner") input.actorUserId = "another-user";
              if (problem === "generation") input.expectedGeneration++;
              if (problem === "allocation")
                input.backup.sourceAllocationId = NodeCrypto.randomUUID();
              if (problem === "timestamp") input.backup.capturedAt = "2020-01-01T00:00:00.000Z";
              if (problem === "native")
                input.backup.nativeCheckpointOperationId = NodeCrypto.randomUUID();
              if (problem === "proof")
                yield* f.sql`UPDATE relay_thread_vm_backups SET probe_receipt='{}'::jsonb WHERE operation_id=${f.backupOperationId}`;
              if (problem === "unknown-time")
                yield* f.sql`UPDATE relay_thread_vm_backups SET capture_started_at=NULL WHERE operation_id=${f.backupOperationId}`;
              expect((yield* Effect.flip(f.store.begin(input)))._tag).toBe(
                "ThreadVmBackupRecoveryConflict",
              );
              expect(yield* f.store.get(input.operationId)).toBeNull();
              expect(f.calls).toEqual([]);
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "running",
              );
              const [placement] = yield* f.sql<{
                operationId: string | null;
              }>`SELECT operation_id AS "operationId" FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
              expect(placement?.operationId).toBeNull();
            }),
          ),
        );
      it.effect("cancels a stale unadmitted intent durably so a late POST cannot admit it", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              input = {
                ...f.input,
                backup: { ...f.input.backup, capturedAt: "2020-01-01T00:00:00.000Z" },
              };
            yield* Effect.flip(f.store.begin(input));
            yield* f.store.cancelIntent(input);
            yield* f.store.cancelIntent(input);
            yield* Effect.flip(f.store.begin(input));
            yield* Effect.flip(f.store.begin(f.input));
            expect(yield* f.store.get(input.operationId)).toBeNull();
            expect(f.calls).toEqual([]);
          }),
        ),
      );
      it.effect(
        "cancellation during the read-only candidate lookup wins before native retention dispatch",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.worker.runOne();
              const worker = makeThreadVmBackupRecoveryWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  retentionCandidate: () =>
                    f.store.cancelIntent(f.input).pipe(Effect.orDie, Effect.as(f.nativeCandidate)),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("cancelled");
              expect(f.calls).toEqual([]);
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "running",
              );
            }),
          ),
      );
      it.effect(
        "a lost retention reply keeps its exact native request and cannot cancel or stop early",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.worker.runOne();
              const worker = makeThreadVmBackupRecoveryWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  retainForStop: () =>
                    Effect.fail(
                      new E2BRestoreError({ operation: "retain for stop", reason: "transport" }),
                    ),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("retaining");
              yield* Effect.flip(f.store.cancelIntent(f.input));
              expect(f.calls).toEqual(["candidate"]);
              yield* f.retry;
              yield* f.worker.runOne();
              expect(f.calls).toEqual(["candidate", "retain"]);
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "running",
              );
            }),
          ),
      );
      it.effect(
        "only authoritative no-retention CAS rejection can refresh the native candidate",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.worker.runOne();
              const worker = makeThreadVmBackupRecoveryWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  retainForStop: () =>
                    Effect.fail(
                      new E2BRestoreError({
                        operation: "retain for stop",
                        reason: "http",
                        status: 409,
                        nativeCode: "retention_candidate_changed",
                      }),
                    ),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("pending");
              expect((yield* f.store.get(f.input.operationId))?.retentionCandidate).toBeNull();
              yield* f.worker.runOne();
              expect(f.calls).toEqual(["candidate", "candidate", "retain"]);
            }),
          ),
      );
      it.effect("wrong native metadata never reaches retention or stop", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.worker.runOne();
            const worker = makeThreadVmBackupRecoveryWorker(
              f.sql,
              f.objects,
              {
                ...f.compute,
                retentionCandidate: () =>
                  Effect.succeed({
                    ...f.nativeCandidate,
                    metadata: {
                      ...f.nativeCandidate.metadata,
                      "launchpad.allocation_id": "foreign",
                    },
                  }),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("pending");
            expect(f.calls).toEqual([]);
          }),
        ),
      );
      it.effect(
        "physical-stop uncertainty retains the old allocation, slot, backup and conversation pins",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.worker.runOne();
              yield* f.worker.runOne();
              const worker = makeThreadVmBackupRecoveryWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  stopRetained: () =>
                    Effect.fail(
                      new E2BRestoreError({
                        operation: "stop retained execution",
                        reason: "transport",
                      }),
                    ),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("retained");
              expect((yield* f.allocations.get(f.input.backup.sourceAllocationId))?.state).toBe(
                "running",
              );
              expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
              const [pin] =
                yield* f.sql`SELECT 1 FROM relay_thread_vm_backup_pins WHERE backup_operation_id=${f.backupOperationId} AND operation_id=${f.input.operationId}`;
              expect(pin).toBeDefined();
            }),
          ),
      );
      it.effect(
        "source hold cancels only never-dispatched pending capture and preserves uncertain creating state",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                other = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase) VALUES(${other},${f.input.backup.sourceAllocationId},1,${f.computeRef},${`launchpad-backup-${other}`},'creating')`;
              yield* f.ready;
              expect((yield* f.backup.get(other))?.phase).toBe("creating");
            }),
          ),
      );
      it.effect("the recovery hold wins a claimed but never-dispatched backup race", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              pending = NodeCrypto.randomUUID();
            yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase) VALUES(${pending},${f.input.backup.sourceAllocationId},1,${f.computeRef},${`launchpad-backup-${pending}`},'pending')`;
            const claimed = (yield* f.backup.claim(f.hostId))!;
            yield* f.store.begin(f.input);
            expect(yield* f.backup.beginCapture(claimed)).toBe(false);
            expect((yield* f.backup.get(pending))?.phase).toBe("retired");
            expect(f.calls).toEqual([]);
            yield* f.store.cancelIntent(f.input);
          }),
        ),
      );
      it.effect(
        "failed cold preparation retries only after exact cancellation while preserving the stopped source and immutable selection",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                row = yield* f.ready;
              yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
              const build = NodeCrypto.randomUUID(),
                receipt: E2BRestoreStatus = {
                  operationID: restoreProbeOperationId(row.operationId),
                  generation: restoreComputeGeneration(row.operationId),
                  sandboxID: "probe-owned",
                  executionID: NodeCrypto.randomUUID(),
                  preparedBuildID: build,
                  state: "failed",
                };
              let cancelled = 0;
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.succeed(receipt),
                  inspect: () => Effect.succeed(receipt),
                  cancel: () =>
                    Effect.sync(() => {
                      cancelled++;
                      return { ...receipt, state: "cancelled" as const };
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              const retry = (yield* f.restores.get(row.operationId))!;
              expect(cancelled).toBe(1);
              expect(retry.phase).toBe("pending");
              expect(retry.probeAttempt).toBe(1);
              expect(restoreProbeOperationId(row.operationId, retry.probeAttempt)).not.toBe(
                receipt.operationID,
              );
              expect(retry.sourceBuildId).toBe(f.sourceBuildId);
              expect(retry.independentHistory).toEqual(row.independentHistory);
              yield* Effect.flip(f.restores.requestAbort(row.operationId));
              expect((yield* f.allocations.get(row.allocationId))?.state).toBe("creating");
            }),
          ),
      );
    });
  },
);
