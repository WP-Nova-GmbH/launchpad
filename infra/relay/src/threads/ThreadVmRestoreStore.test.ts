import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { E2BRestoreError, type E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import {
  makeThreadVmRestoreStore,
  restoreComputeGeneration,
  restoreProbeOperationId,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* (state: "running" | "paused" = "running") {
  const f = yield* finalSaveCatalogFixture(state);
  yield* f.store.begin(f.input);
  const point = yield* f.freeze;
  yield* f.verifyBackup;
  yield* f.store.recordSaved(f.input.operationId);
  const deletion = (yield* f.store.claimDeletion(f.hostId))!;
  yield* f.store.beginDeletion(deletion);
  yield* f.store.confirmDeleted(deletion);
  const store = makeThreadVmRestoreStore(f.sql, f.objects);
  const input = {
    operationId: NodeCrypto.randomUUID(),
    savedDiskOperationId: f.input.operationId,
    threadId: f.threadId,
    allocationId: NodeCrypto.randomUUID(),
    actorUserId: f.input.actorUserId,
    expectedGeneration: 1,
  };
  const preparedBuildID = NodeCrypto.randomUUID();
  const receipt: E2BRestoreStatus = {
    operationID: restoreProbeOperationId(input.operationId),
    generation: restoreComputeGeneration(input.operationId),
    sandboxID: `restore-${input.allocationId}`,
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
  const resetRetry = f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp()
    WHERE operation_id=${input.operationId}`;
  return {
    ...f,
    sourceAllocationId: f.input.allocationId,
    store,
    input,
    point,
    receipt,
    resetRetry,
    capacity: makeThreadVmCapacityStore(f.sql),
    saved: makeThreadVmSavedDiskStore(f.sql),
    natives: makeThreadNativeCheckpointStore(f.sql, f.objects),
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "offline VM restore (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("restores a final save taken from its exact certified paused source", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture("paused");
            const point = (yield* f.natives.latestComplete(f.threadId))!;
            expect(point.captureOperationId).not.toBe(f.input.savedDiskOperationId);
            const before = (yield* f.saved.get(f.input.savedDiskOperationId))!;
            const row = yield* f.store.begin(f.input);
            expect(row.nativeCheckpointOperationId).toBe(point.operationId);
            expect(yield* f.store.begin(f.input)).toEqual(row);
            yield* f.capacity.admitNext(f.hostId);
            const claim = (yield* f.store.claim(f.hostId))!;
            yield* f.store.beginPrepare(claim);
            expect((yield* f.store.recordPrepared(claim, f.receipt)).phase).toBe("prepared");
            expect((yield* f.saved.get(f.input.savedDiskOperationId))?.savedAt).toBe(
              before.savedAt,
            );
            expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
            expect(yield* f.natives.getForOperation(f.input)).toMatchObject({
              operationId: point.operationId,
              sourceEnvironmentId: point.sourceEnvironmentId,
              sourceSequence: point.sourceSequence,
            });
          }),
        ),
      );
      for (const stage of ["admission", "preparation"] as const) {
        for (const problem of [
          "generation",
          "native-point",
          "capture-operation",
          "source-sequence",
          "reopened",
          "cancelled",
          "missing-certificate",
          "environment",
        ] as const) {
          it.effect(`refuses paused restore ${stage} with changed ${problem}`, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture("paused");
                const claim =
                  stage === "preparation"
                    ? yield* Effect.gen(function* () {
                        yield* f.store.begin(f.input);
                        yield* f.capacity.admitNext(f.hostId);
                        return (yield* f.store.claim(f.hostId))!;
                      })
                    : null;
                if (problem === "generation")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET generation=generation+1
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "native-point")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET native_checkpoint_operation_id=${f.native.header.operationId}
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "capture-operation")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET operation_id=${NodeCrypto.randomUUID()}
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "source-sequence")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET source_sequence=source_sequence+1
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "reopened")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET source_reopened_at=clock_timestamp()
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "cancelled")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET phase='cancelled'
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else if (problem === "missing-certificate")
                  yield* f.sql`UPDATE relay_thread_vm_pauses SET native_checkpoint_operation_id=NULL,
                    source_sequence=NULL,source_frozen_at=NULL,boot_id=NULL
                    WHERE allocation_id=${f.sourceAllocationId}`;
                else
                  yield* f.sql`UPDATE relay_thread_native_checkpoints SET source_environment_id='other-environment'
                    WHERE operation_id=${f.point.native.header.operationId}`;
                expect(
                  (yield* Effect.flip(claim ? f.store.beginPrepare(claim) : f.store.begin(f.input)))
                    ._tag,
                ).toBe("ThreadVmRestoreConflict");
                if (claim) {
                  expect((yield* f.store.get(f.input.operationId))?.phase).toBe("pending");
                  expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe(
                    "restoring",
                  );
                  expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
                  expect(
                    (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
                  ).toBe(f.input.operationId);
                } else {
                  expect(yield* f.store.get(f.input.operationId)).toBeNull();
                  expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe(
                    "available",
                  );
                  expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
                  expect(
                    (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
                  ).toBeNull();
                }
              }),
            ),
          );
        }
      }
      it.effect(
        "reports saved-only, restore wait, and cleanup blockage without waking or renewing anything",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const status = makeThreadVmStatusStore(f.sql);
              const before = yield* status.read(f.threadId, 1);
              expect(before).toMatchObject({
                allocation: null,
                restore: null,
                finalSave: null,
                savedDisk: { phase: "available" },
              });
              const savedAt = before.savedDisk!.savedAt;
              yield* f.store.begin(f.input);
              expect(yield* status.read(f.threadId, 1)).toMatchObject({
                allocation: { state: "creating" },
                capacityState: "waiting",
                restore: { phase: "pending", operationId: f.input.operationId, errorCode: null },
              });
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.store.claim(f.hostId))!;
              yield* f.store.beginPrepare(claim);
              yield* f.store.defer(claim, "preparation_unconfirmed");
              expect(yield* status.read(f.threadId, 1)).toMatchObject({
                restore: { phase: "preparing", errorCode: "preparation_unconfirmed" },
              });
              yield* f.store.requestAbort(f.input.operationId);
              const cancellation = (yield* f.store.claim(f.hostId))!;
              yield* f.store.defer(cancellation, "cleanup_unconfirmed");
              expect(yield* status.read(f.threadId, 1)).toMatchObject({
                restore: { phase: "aborting", errorCode: "cleanup_unconfirmed" },
              });
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.savedAt).toBe(savedAt);
              expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
            }),
          ),
      );
      it.effect(
        "pins exact recovery, reserves quota and retries admission without renewing retention",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const before = yield* f.saved.get(f.input.savedDiskOperationId);
              const row = yield* f.store.begin(f.input);
              expect(row).toMatchObject({
                phase: "pending",
                generation: 1,
                allocationId: f.input.allocationId,
                nativeCheckpointOperationId: f.point.native.header.operationId,
              });
              expect(yield* f.store.begin(f.input)).toEqual(row);
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.savedAt).toBe(
                before?.savedAt,
              );
              expect(yield* f.allocations.get(f.input.allocationId)).toMatchObject({
                state: "creating",
                computeRef: null,
              });
              expect(yield* f.natives.getForOperation(f.input)).toMatchObject({
                operationId: f.point.native.header.operationId,
              });
              expect(
                yield* Effect.flip(
                  f.store.begin({ ...f.input, allocationId: NodeCrypto.randomUUID() }),
                ),
              ).toMatchObject({ _tag: "ThreadVmRestoreConflict" });
              expect(
                yield* Effect.flip(
                  makeThreadPlacementStore(f.sql).admit({
                    ...f.owner,
                    workId: "restore-must-not-run",
                  }),
                ),
              ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            }),
          ),
      );
      for (const problem of [
        "wrong-owner",
        "missing-chat",
        "wrong-disk-build",
        "missing-conversation",
      ] as const) {
        it.effect(`rolls back quota and disk pins on ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              if (problem === "missing-chat")
                yield* f.sql`DELETE FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${f.point.native.header.operationId}`;
              if (problem === "wrong-disk-build")
                yield* f.sql`UPDATE relay_thread_vm_backups SET source_build_id='invalid-build' WHERE operation_id=(SELECT backup_operation_id FROM relay_thread_vm_saved_disks WHERE operation_id=${f.input.savedDiskOperationId})`;
              if (problem === "missing-conversation")
                yield* f.sql`UPDATE relay_thread_native_checkpoints SET retained=false WHERE operation_id=${f.point.native.header.operationId}`;
              yield* Effect.flip(
                f.store.begin({
                  ...f.input,
                  ...(problem === "wrong-owner" ? { actorUserId: "another-user" } : {}),
                }),
              );
              expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
              expect(yield* f.natives.getForOperation(f.input)).toBeNull();
              expect(
                (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
              ).toBeNull();
            }),
          ),
        );
      }
      it.effect("waits for physical capacity without dispatching a preparation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const blockerThreadId = NodeCrypto.randomUUID(),
              blockerAllocationId = NodeCrypto.randomUUID();
            yield* makeThreadPlacementStore(f.sql).enroll({
              threadId: blockerThreadId,
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: f.input.actorUserId,
              environmentId: "blocker",
              projectId: "project",
            });
            yield* f.allocations.reserve({
              allocationId: blockerAllocationId,
              threadId: blockerThreadId,
              organizationId: "org",
              ownerUserId: f.input.actorUserId,
              templateId: "template:build-verified",
            });
            yield* f.capacity.request({
              operationId: blockerAllocationId,
              allocationId: blockerAllocationId,
              hostId: f.hostId,
              kind: "create",
            });
            yield* f.capacity.admitNext(f.hostId);
            yield* f.store.begin(f.input);
            const worker = makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                prepare: () => Effect.die("No host capacity"),
                inspect: () => Effect.die("Unexpected host inspection"),
                cancel: () => Effect.die("No cancellation"),
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(false);
            expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("waiting");
            yield* f.store.requestAbort(f.input.operationId);
            expect(yield* worker.runOne()).toBe(true);
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
          }),
        ),
      );
      it.effect("only one worker can claim an admitted restore", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.capacity.admitNext(f.hostId);
            const results = yield* Effect.all([f.store.claim(f.hostId), f.store.claim(f.hostId)], {
              concurrency: "unbounded",
            });
            expect(results.filter(Boolean)).toHaveLength(1);
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("pending");
          }),
        ),
      );
      it.effect(
        "reconciles lost prepare response under one immutable operation, without activating",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              const requests: unknown[] = [];
              let attempts = 0;
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: (operationId, input) =>
                    Effect.gen(function* () {
                      requests.push({ operationId, input });
                      attempts++;
                      expect(
                        (yield* f.store.get(f.input.operationId).pipe(Effect.orDie))
                          ?.prepareStarted,
                      ).toBe(true);
                      if (attempts === 1)
                        return yield* new E2BRestoreError({
                          operation: "prepare",
                          reason: "transport",
                        });
                      return f.receipt;
                    }),
                  inspect: () => Effect.die("Unexpected host inspection"),
                  cancel: () => Effect.die("Unexpected cancel"),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("preparing");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              yield* f.resetRetry;
              yield* worker.runOne();
              expect(requests).toHaveLength(2);
              expect(requests[0]).toEqual(requests[1]);
              expect(requests[0]).toMatchObject({
                operationId: restoreProbeOperationId(f.input.operationId),
              });
              expect((requests[0] as { operationId: string }).operationId).not.toBe(
                f.input.operationId,
              );
              expect(requests[0]).toMatchObject({ input: { leaseSeconds: 3600 } });
              expect(
                (requests[0] as { input: Record<string, unknown> }).input.bootstrap,
              ).toBeUndefined();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("prepared");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
              expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
              expect((yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.generation).toBe(1);
              expect(yield* worker.runOne()).toBe(false);
            }),
          ),
      );
      it.effect("accepts a distinct recovered disk hash under the exact selected source pair", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const selected = yield* f.store.begin(f.input);
            const receipt = {
              ...f.receipt,
              coldProbe: { ...f.receipt.coldProbe!, rootfsSHA256: "e".repeat(64) },
            };
            const requests: unknown[] = [];
            const worker = makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                prepare: (operationId, input) => {
                  requests.push({ operationId, input });
                  return Effect.succeed(receipt);
                },
                inspect: () => Effect.succeed(receipt),
                cancel: () => Effect.die("Unexpected cancellation"),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("prepared");
            expect(requests).toEqual([
              {
                operationId: restoreProbeOperationId(f.input.operationId),
                input: {
                  sourceTemplateID: selected.sourceTemplateId,
                  sourceBuildID: selected.sourceBuildId,
                  generation: restoreComputeGeneration(f.input.operationId),
                  leaseSeconds: 3600,
                },
              },
            ]);
            expect((yield* f.store.requireRecovery(selected)).coldProbe.rootfsSHA256).toBe(
              "b".repeat(64),
            );
            expect((yield* f.store.get(f.input.operationId))?.preparedReceipt).toEqual(receipt);
            yield* f.resetRetry;
            yield* worker.runOne();
            expect(requests).toHaveLength(1);
            expect((yield* f.store.get(f.input.operationId))?.preparedReceipt).toEqual(receipt);
          }),
        ),
      );
      for (const problem of [
        "rootfs",
        "init",
        "sandbox",
        "execution",
        "prepared-build",
        "manifest",
      ] as const) {
        it.effect(`refuses changed ${problem} on the same prepared operation`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.store.claim(f.hostId))!;
              yield* f.store.beginPrepare(claim);
              const first = {
                ...f.receipt,
                coldProbe: { ...f.receipt.coldProbe!, rootfsSHA256: "e".repeat(64) },
              };
              yield* f.store.recordPrepared(claim, first);
              yield* f.resetRetry;
              const inspected = (yield* f.store.claim(f.hostId))!;
              const preparedBuildID = NodeCrypto.randomUUID();
              const changed = {
                ...first,
                ...(problem === "rootfs"
                  ? { coldProbe: { ...first.coldProbe, rootfsSHA256: "f".repeat(64) } }
                  : {}),
                ...(problem === "init"
                  ? { coldProbe: { ...first.coldProbe, initSHA256: "f".repeat(64) } }
                  : {}),
                ...(problem === "sandbox" ? { sandboxID: "changed-sandbox" } : {}),
                ...(problem === "execution" ? { executionID: NodeCrypto.randomUUID() } : {}),
                ...(problem === "prepared-build"
                  ? { preparedBuildID, coldProbe: { ...first.coldProbe, preparedBuildID } }
                  : {}),
                ...(problem === "manifest" ? { manifestSHA256: "f".repeat(64) } : {}),
              };
              expect(yield* Effect.flip(f.store.recordPrepared(inspected, changed))).toMatchObject({
                _tag: "ThreadVmRestoreConflict",
              });
              expect((yield* f.store.get(f.input.operationId))?.preparedReceipt).toEqual(first);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("prepared");
            }),
          ),
        );
      }
      for (const problem of [
        "foreign-operation",
        "foreign-generation",
        "missing-probe",
        "foreign-build",
      ] as const) {
        it.effect(`does not certify a preparation with ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.store.claim(f.hostId))!;
              yield* f.store.beginPrepare(claim);
              const { coldProbe: _coldProbe, ...withoutProbe } = f.receipt;
              const receipt = {
                ...(problem === "missing-probe" ? withoutProbe : f.receipt),
                ...(problem === "foreign-operation"
                  ? { operationID: NodeCrypto.randomUUID() }
                  : {}),
                ...(problem === "foreign-generation" ? { generation: "placement-elsewhere" } : {}),
                ...(problem === "foreign-build"
                  ? { preparedBuildID: NodeCrypto.randomUUID() }
                  : {}),
              };
              expect(yield* Effect.flip(f.store.recordPrepared(claim, receipt))).toMatchObject({
                _tag: "ThreadVmRestoreConflict",
              });
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("preparing");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("restoring");
            }),
          ),
        );
      }
      it.effect(
        "cancels an unattempted restore without an RPC and restores original retention",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const before = (yield* f.saved.get(f.input.savedDiskOperationId))!;
              yield* f.store.begin(f.input);
              yield* f.store.requestAbort(f.input.operationId);
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.die("Cancelled"),
                  inspect: () => Effect.die("Unexpected host inspection"),
                  cancel: () => Effect.die("Never attempted preparation"),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.savedAt).toBe(
                before.savedAt,
              );
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect(yield* f.natives.getForOperation(f.input)).toBeNull();
              expect(yield* f.store.requestAbort(f.input.operationId)).toMatchObject({
                phase: "aborted",
              });
              yield* Effect.flip(f.store.begin(f.input));
            }),
          ),
      );
      it.effect(
        "holds quota and pins when attempted preparation is missing from host catalog",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.store.claim(f.hostId))!;
              yield* f.store.beginPrepare(claim);
              yield* f.store.requestAbort(f.input.operationId);
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.die("Cancelled"),
                  inspect: () => Effect.die("Unexpected host inspection"),
                  cancel: () =>
                    new E2BRestoreError({ operation: "cancel", reason: "http", status: 404 }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.errorCode).toBe(
                "cleanup_unconfirmed",
              );
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
              expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
            }),
          ),
      );
      it.effect(
        "cancel wins over a late prepared reply; only exact positive cleanup releases quota",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              let cancelled = 0;
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () =>
                    f.store
                      .requestAbort(f.input.operationId)
                      .pipe(Effect.orDie, Effect.as(f.receipt)),
                  inspect: () => Effect.die("Unexpected host inspection"),
                  cancel: () =>
                    Effect.sync(() => {
                      cancelled++;
                      return {
                        ...f.receipt,
                        state: "cancelled" as const,
                        ...(cancelled === 1 ? { operationID: NodeCrypto.randomUUID() } : {}),
                      };
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
              yield* worker.runOne();
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              yield* f.resetRetry;
              yield* worker.runOne();
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
            }),
          ),
      );
      it.effect(
        "reconciles a host-expired preparation without renewing disk retention or leaking quota",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const original = (yield* f.saved.get(f.input.savedDiskOperationId))!;
              yield* f.store.begin(f.input);
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.succeed(f.receipt),
                  inspect: () => Effect.succeed({ ...f.receipt, state: "cancelled" }),
                  cancel: () => Effect.succeed({ ...f.receipt, state: "cancelled" }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              yield* f.resetRetry;
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              yield* worker.runOne();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.savedAt).toBe(
                original.savedAt,
              );
              expect(yield* f.natives.getForOperation(f.input)).toBeNull();
            }),
          ),
      );
      it.effect("refuses a changed prepared identity and retains its recovery pins", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            const worker = makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                prepare: () => Effect.succeed(f.receipt),
                inspect: () =>
                  Effect.succeed({ ...f.receipt, preparedBuildID: NodeCrypto.randomUUID() }),
                cancel: () => Effect.die("Foreign identity must not authorize cleanup"),
              },
              f.hostId,
            );
            yield* worker.runOne();
            yield* f.resetRetry;
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("prepared");
            expect((yield* f.store.get(f.input.operationId))?.errorCode).toBe("identity_conflict");
            expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
            expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
          }),
        ),
      );
      it.effect("cleans up failed preparation only after a positive host cancellation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            const worker = makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                prepare: () => Effect.succeed({ ...f.receipt, state: "failed" }),
                inspect: () => Effect.die("Failed preparation is not ready"),
                cancel: () => Effect.succeed({ ...f.receipt, state: "cancelled" }),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
          }),
        ),
      );
      it.effect("prepared cancellation rejects another physical preparation's receipt", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            const worker = makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                prepare: () => Effect.succeed(f.receipt),
                inspect: () => Effect.die("Unexpected host inspection"),
                cancel: () => Effect.succeed({ ...f.receipt, state: "cancelled" }),
              },
              f.hostId,
            );
            yield* worker.runOne();
            yield* f.store.requestAbort(f.input.operationId);
            const claim = (yield* f.store.claim(f.hostId))!;
            expect(
              yield* Effect.flip(
                f.store.completeAbort(claim, {
                  ...f.receipt,
                  state: "cancelled",
                  executionID: NodeCrypto.randomUUID(),
                }),
              ),
            ).toMatchObject({ _tag: "ThreadVmRestoreConflict" });
            yield* f.store.completeAbort(claim, { ...f.receipt, state: "cancelled" });
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
          }),
        ),
      );
    });
  },
);
