import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { E2BRestoreError, type E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmBackupRetentionWorker } from "./ThreadVmBackupRetentionWorker.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { makeThreadVmFinalSaveDeletionWorker } from "./ThreadVmFinalSaveDeletionWorker.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";

const fixture = Effect.fnUntraced(function* (failCandidate = true, uncertainCapture = false) {
  const f = yield* finalSaveCatalogFixture();
  const capture = Effect.fnUntraced(function* (record = true) {
    const id = (yield* f.backup.enqueueDue(f.hostId))!;
    const claim = (yield* f.backup.claim(f.hostId))!;
    yield* f.backup.beginCapture(claim);
    if (!record) return claim;
    yield* f.backup.recordCapture(claim, {
      snapshotId: `snapshot-${id}`,
      sourceTemplateId: `template-${id}`,
      sourceBuildId: NodeCrypto.randomUUID(),
    });
    return (yield* f.backup.claim(f.hostId))!;
  });
  const good = yield* capture(),
    build = NodeCrypto.randomUUID();
  yield* f.backup.markProbeReady(good, {
    operationID: good.operationId,
    generation: `backup-${good.operationId}`,
    preparedBuildID: build,
    manifestSHA256: "a".repeat(64),
    coldProbe: {
      version: 1,
      preparedBuildID: build,
      rootfsSHA256: "b".repeat(64),
      initSHA256: "c".repeat(64),
      physicalStopConfirmed: true,
      mountOnly: true,
    },
  });
  yield* f.backup.complete(good);
  yield* f.sql`UPDATE relay_thread_vm_backups SET verified_at=clock_timestamp()-interval '1 hour' WHERE operation_id=${good.operationId}`;
  const failed = yield* capture(!uncertainCapture);
  if (failCandidate) yield* f.backup.fail(failed);
  const cancelled: E2BRestoreStatus = {
    operationID: failed.operationId,
    generation: `backup-${failed.operationId}`,
    sandboxID: "disposable-probe",
    executionID: NodeCrypto.randomUUID(),
    preparedBuildID: NodeCrypto.randomUUID(),
    state: "cancelled",
  };
  const retry = f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp(), claim_until=NULL, claim_id=NULL WHERE operation_id=${failed.operationId}`;
  return {
    ...f,
    good,
    failed,
    cancelled,
    retry,
    retention: makeThreadVmBackupRetentionStore(f.sql),
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "failed periodic VM backup cleanup (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const outcome of [
        "deletion-wins",
        "capture-wins",
        "unavailable",
        "foreign",
        "expired",
      ] as const) {
        it.effect(`serializes pending capture and explicit deletion when ${outcome}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture();
              const operationId = (yield* f.backup.enqueueDue(f.hostId))!;
              const deletion = makeThreadDeletionStore(f.sql);
              const request = {
                threadId: f.threadId,
                operationId: NodeCrypto.randomUUID(),
                ownerUserId: f.input.actorUserId,
                generation: 1,
                hostId: f.hostId,
              };
              let captures = 0;
              const worker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () =>
                    Effect.gen(function* () {
                      expect((yield* f.backup.get(operationId).pipe(Effect.orDie))?.phase).toBe(
                        "pending",
                      );
                      if (outcome === "deletion-wins")
                        yield* deletion.begin(request).pipe(Effect.orDie);
                      if (outcome === "expired")
                        yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${operationId}`.pipe(
                          Effect.orDie,
                        );
                      if (outcome === "unavailable")
                        return yield* new ThreadVmComputeError({
                          operation: "inspect",
                          message: "HTTP409: source unavailable",
                        });
                      return outcome === "foreign"
                        ? {
                            ...f.info,
                            metadata: { ...f.info.metadata, "launchpad.generation": "999" },
                          }
                        : f.info;
                    }),
                  snapshot: () =>
                    Effect.gen(function* () {
                      captures++;
                      expect(outcome).toBe("capture-wins");
                      expect((yield* f.backup.get(operationId).pipe(Effect.orDie))?.phase).toBe(
                        "creating",
                      );
                      yield* Effect.flip(deletion.begin(request)).pipe(Effect.orDie);
                      return {
                        snapshotId: `snapshot-${operationId}`,
                        names: [`launchpad-backup-${operationId}`],
                      };
                    }),
                  findSnapshot: () => Effect.die("No uncertain capture exists"),
                  restore: {
                    resolveNamedSnapshot: () =>
                      Effect.succeed({
                        sourceTemplateID: "capture",
                        sourceBuildID: NodeCrypto.randomUUID(),
                      }),
                    prepare: () => Effect.die("This pass only captures"),
                    cancel: () => Effect.die("No verification operation was started"),
                  },
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(captures).toBe(outcome === "capture-wins" ? 1 : 0);
              if (outcome === "capture-wins") {
                expect((yield* f.backup.get(operationId))?.phase).toBe("captured");
                expect(yield* deletion.get(f.threadId)).toBeNull();
              } else {
                if (outcome !== "deletion-wins") {
                  expect((yield* f.backup.get(operationId))?.phase).toBe("pending");
                  expect(yield* deletion.begin(request)).toMatchObject({ phase: "stopping" });
                }
                expect((yield* f.backup.get(operationId))?.phase).toBe("retired");
                expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
              }
            }),
          ),
        );
      }
      for (const field of [
        "snapshot_id",
        "source_template_id",
        "source_build_id",
        "probe_receipt",
      ] as const) {
        it.effect(`retains a malformed pending capture with ${field} during deletion`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture();
              const operationId = (yield* f.backup.enqueueDue(f.hostId))!;
              const claim = (yield* f.backup.claim(f.hostId))!;
              if (field === "snapshot_id")
                yield* f.sql`UPDATE relay_thread_vm_backups SET snapshot_id='unexpected' WHERE operation_id=${operationId}`;
              if (field === "source_template_id")
                yield* f.sql`UPDATE relay_thread_vm_backups SET source_template_id='unexpected' WHERE operation_id=${operationId}`;
              if (field === "source_build_id")
                yield* f.sql`UPDATE relay_thread_vm_backups SET source_build_id=${NodeCrypto.randomUUID()} WHERE operation_id=${operationId}`;
              if (field === "probe_receipt")
                yield* f.sql`UPDATE relay_thread_vm_backups SET probe_receipt='{}'::jsonb WHERE operation_id=${operationId}`;
              expect(yield* f.backup.beginCapture(claim)).toBe(false);
              const deletion = makeThreadDeletionStore(f.sql);
              yield* Effect.flip(
                deletion.begin({
                  threadId: f.threadId,
                  operationId: NodeCrypto.randomUUID(),
                  ownerUserId: f.input.actorUserId,
                  generation: 1,
                  hostId: f.hostId,
                }),
              );
              expect(yield* deletion.get(f.threadId)).toBeNull();
              expect((yield* f.backup.get(operationId))?.phase).toBe("pending");
            }),
          ),
        );
      }
      for (const outcome of [
        "failed",
        "building",
        "missing",
        "transport",
        "expired",
        "moved",
      ] as const) {
        it.effect(
          `reconciles an uncertain capture ${outcome} before inspecting its failed source`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(false, true);
                yield* f.retry;
                const snapshotId = `failed-${f.failed.operationId}`;
                const sourceBuildId = NodeCrypto.randomUUID();
                let inspections = 0;
                const worker = makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: () =>
                      Effect.suspend(() => {
                        inspections++;
                        return Effect.fail(
                          new ThreadVmComputeError({
                            operation: "inspect",
                            message: "HTTP409: no certified paused disk",
                          }),
                        );
                      }),
                    snapshot: () => Effect.die("An uncertain capture must never be repeated"),
                    findSnapshot: () => Effect.die("The source inspection remains unavailable"),
                    restore: {
                      resolveFailedNamedSnapshot: (name) =>
                        Effect.gen(function* () {
                          expect(name).toBe(f.failed.snapshotName);
                          if (outcome === "missing" || outcome === "transport")
                            return yield* new E2BRestoreError({
                              operation: "failed snapshot alias",
                              reason: outcome === "transport" ? "transport" : "http",
                              status: 404,
                            });
                          if (outcome === "building") return null;
                          if (outcome === "expired")
                            yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${f.failed.operationId}`.pipe(
                              Effect.orDie,
                            );
                          if (outcome === "moved")
                            yield* f.sql`UPDATE relay_thread_placements SET generation=generation+1 WHERE thread_id=${f.threadId}`.pipe(
                              Effect.orDie,
                            );
                          return {
                            snapshotId,
                            sourceTemplateID: snapshotId,
                            sourceBuildID: sourceBuildId,
                          };
                        }),
                      resolveNamedSnapshot: () => Effect.die("No ready capture was found"),
                      prepare: () =>
                        Effect.die("A failed capture must never boot a verification probe"),
                      cancel: () => Effect.die("Failure reconciliation is not cleanup"),
                    },
                  },
                  f.hostId,
                );
                expect(yield* worker.runOne()).toBe(true);
                expect(inspections).toBe(outcome === "building" ? 1 : 0);
                const candidate = yield* f.backup.get(f.failed.operationId);
                expect(candidate?.phase).toBe(outcome === "failed" ? "failed" : "creating");
                expect(candidate?.snapshotId).toBe(outcome === "failed" ? snapshotId : null);
                expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
                const [capacity] =
                  yield* f.sql`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.input.allocationId}`;
                expect(capacity?.state).toBe("started");
                const deletion = makeThreadDeletionStore(f.sql);
                const request = {
                  threadId: f.threadId,
                  operationId: NodeCrypto.randomUUID(),
                  ownerUserId: f.input.actorUserId,
                  generation: 1,
                  hostId: f.hostId,
                };
                if (outcome === "failed") {
                  expect(yield* deletion.begin(request)).toMatchObject({ phase: "stopping" });
                  expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
                } else {
                  yield* Effect.flip(deletion.begin(request));
                  expect(yield* deletion.get(f.threadId)).toBeNull();
                }
              }),
            ),
        );
      }

      for (const problem of [
        "too-large",
        "occupied",
        "unavailable",
        "transport",
        "foreign-operation",
        "expired-claim",
      ] as const) {
        it.effect(
          `reconciles backup preparation ${problem} without releasing or deleting the VM`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(false);
                yield* f.retry;
                const pauses = makeThreadVmPauseStore(f.sql);
                expect(yield* pauses.reserveIdle(f.hostId)).toBeNull();
                const worker = makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: () => Effect.die("No new capture is needed"),
                    snapshot: () => Effect.die("The captured disk must be preserved"),
                    findSnapshot: () => Effect.die("The captured disk is already recorded"),
                    restore: {
                      resolveNamedSnapshot: () =>
                        Effect.die("The immutable source is already recorded"),
                      prepare: () =>
                        Effect.gen(function* () {
                          if (problem === "expired-claim")
                            yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${f.failed.operationId}`.pipe(
                              Effect.orDie,
                            );
                          return yield* new E2BRestoreError({
                            operation:
                              problem === "foreign-operation" ? "snapshot alias" : "prepare",
                            reason: problem === "transport" ? "transport" : "http",
                            status:
                              problem === "occupied" ? 429 : problem === "unavailable" ? 503 : 413,
                          });
                        }),
                      cancel: () => Effect.die("A rejected request is not cleanup authorization"),
                    },
                  },
                  f.hostId,
                );
                expect(yield* worker.runOne()).toBe(true);
                const candidate = yield* f.backup.get(f.failed.operationId);
                expect(candidate?.phase).toBe(problem === "too-large" ? "failed" : "verifying");
                expect(candidate?.snapshotId).toBe(f.failed.snapshotId);
                expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
                const [capacity] =
                  yield* f.sql`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.input.allocationId}`;
                expect(capacity?.state).toBe("started");
                expect((yield* pauses.reserveIdle(f.hostId)) !== null).toBe(
                  problem === "too-large",
                );
              }),
            ),
        );
      }

      it.effect("an oversized final backup never authorizes automatic source deletion", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            const save = yield* f.store.reserveBackup(f.input.operationId);
            const captured = (yield* f.backup.claim(f.hostId))!;
            yield* f.backup.beginCapture(captured);
            yield* f.backup.recordCapture(captured, {
              snapshotId: `snapshot-${captured.operationId}`,
              sourceTemplateId: "oversized-source",
              sourceBuildId: NodeCrypto.randomUUID(),
            });
            const worker = makeThreadVmBackupWorker(
              f.sql,
              {
                inspect: () => Effect.die("No new capture is needed"),
                snapshot: () => Effect.die("The captured disk must be preserved"),
                findSnapshot: () => Effect.die("The captured disk is already recorded"),
                restore: {
                  resolveNamedSnapshot: () => Effect.die("The immutable source is recorded"),
                  prepare: () =>
                    Effect.fail(
                      new E2BRestoreError({ operation: "prepare", reason: "http", status: 413 }),
                    ),
                  cancel: () => Effect.die("A rejected request cannot authorize cleanup"),
                },
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect((yield* f.backup.get(save.backupOperationId!))?.phase).toBe("failed");
            const deletion = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.die("A verified final save is required"),
                inspectCreation: () => Effect.die("A verified final save is required"),
                destroy: () => Effect.die("The source VM must survive"),
              },
              f.hostId,
            );
            expect(yield* deletion.runOne()).toBe(false);
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("saving");
          }),
        ),
      );

      it.effect(
        "retires only the failed candidate, preserves recovery and permits the next capture",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              expect(yield* f.backup.enqueueDue(f.hostId)).toBeNull();
              const calls: string[] = [];
              const worker = makeThreadVmBackupRetentionWorker(
                f.sql,
                {
                  restore: {
                    cancel: (id, generation) =>
                      Effect.sync(() => {
                        expect(id).toBe(f.failed.operationId);
                        expect(generation).toBe(f.cancelled.generation);
                        calls.push("stop");
                        return f.cancelled;
                      }),
                  },
                  deleteSnapshot: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(f.failed.snapshotId);
                      calls.push("delete");
                      return true;
                    }),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(calls).toEqual(["stop", "delete"]);
              expect((yield* f.backup.get(f.failed.operationId))?.phase).toBe("retired");
              expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              const [capacity] =
                yield* f.sql`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.input.allocationId}`;
              expect(capacity?.state).toBe("started");
              expect(yield* f.backup.enqueueDue(f.hostId)).not.toBeNull();
            }),
          ),
      );

      for (const problem of [
        "missing",
        "wrong-operation",
        "wrong-generation",
        "cancelling",
        "malformed",
      ] as const) {
        it.effect(`keeps failed recovery while probe stop is ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              let deletes = 0;
              const worker = makeThreadVmBackupRetentionWorker(
                f.sql,
                {
                  restore: {
                    cancel: () =>
                      problem === "missing"
                        ? Effect.fail(
                            new E2BRestoreError({
                              operation: "cancel",
                              reason: "http",
                              status: 404,
                            }),
                          )
                        : Effect.succeed({
                            ...f.cancelled,
                            ...(problem === "wrong-operation"
                              ? { operationID: NodeCrypto.randomUUID() }
                              : {}),
                            ...(problem === "wrong-generation" ? { generation: "foreign" } : {}),
                            ...(problem === "cancelling" ? { state: "cancelling" as const } : {}),
                            ...(problem === "malformed" ? { preparedBuildID: "invalid" } : {}),
                          }),
                  },
                  deleteSnapshot: () =>
                    Effect.sync(() => {
                      deletes++;
                      return true;
                    }),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(deletes).toBe(0);
              expect((yield* f.backup.get(f.failed.operationId))?.phase).toBe("failed");
              expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
              expect(yield* f.backup.enqueueDue(f.hostId)).toBeNull();
            }),
          ),
        );
      }

      it.effect("reconciles a lost root-deletion reply without cancelling the probe twice", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            let stops = 0,
              deletes = 0;
            const worker = makeThreadVmBackupRetentionWorker(
              f.sql,
              {
                restore: {
                  cancel: () =>
                    Effect.sync(() => {
                      stops++;
                      return f.cancelled;
                    }),
                },
                deleteSnapshot: () =>
                  Effect.gen(function* () {
                    deletes++;
                    if (deletes === 1)
                      return yield* new ThreadVmComputeError({
                        operation: "delete snapshot",
                        message: "lost deletion reply",
                      });
                    return false;
                  }),
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect((yield* f.backup.get(f.failed.operationId))?.phase).toBe("retiring");
            const [row] =
              yield* f.sql`SELECT failed_probe_stopped_at FROM relay_thread_vm_backups WHERE operation_id=${f.failed.operationId}`;
            expect(row?.failed_probe_stopped_at).not.toBeNull();
            expect(yield* f.backup.enqueueDue(f.hostId)).toBeNull();
            yield* f.retry;
            expect(yield* worker.runOne()).toBe(true);
            expect(stops).toBe(1);
            expect(deletes).toBe(2);
            expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
            expect(yield* f.backup.enqueueDue(f.hostId)).not.toBeNull();
          }),
        ),
      );

      for (const hold of [
        "pin",
        "placement-operation",
        "unknown-snapshot",
        "wrong-name",
        "final-save",
      ] as const) {
        it.effect(`does not claim a failed candidate with ${hold}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              if (hold === "pin")
                yield* f.sql`INSERT INTO relay_thread_vm_backup_pins(backup_operation_id,operation_id) VALUES(${f.failed.operationId},${NodeCrypto.randomUUID()})`;
              if (hold === "placement-operation")
                yield* f.sql`UPDATE relay_thread_placements SET operation_id=${NodeCrypto.randomUUID()} WHERE thread_id=${f.threadId}`;
              if (hold === "unknown-snapshot")
                yield* f.sql`UPDATE relay_thread_vm_backups SET snapshot_id=NULL WHERE operation_id=${f.failed.operationId}`;
              if (hold === "wrong-name")
                yield* f.sql`UPDATE relay_thread_vm_backups SET snapshot_name='foreign' WHERE operation_id=${f.failed.operationId}`;
              if (hold === "final-save") {
                yield* f.store.begin(f.input);
                yield* f.freeze;
                yield* f.store.reserveBackup(f.input.operationId);
                yield* f.sql`UPDATE relay_thread_vm_final_saves SET backup_operation_id=${f.failed.operationId} WHERE operation_id=${f.input.operationId}`;
                yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
              }
              expect(yield* f.retention.claimFailed(f.hostId)).toBeNull();
              expect((yield* f.backup.get(f.good.operationId))?.phase).toBe("verified");
            }),
          ),
        );
      }

      it.effect("does not authorize retirement from an expired or replaced claim", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const claim = (yield* f.retention.claimFailed(f.hostId))!;
            expect(yield* f.retention.claimFailed(f.hostId)).toBeNull();
            yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${claim.operationId}`;
            expect(yield* f.retention.retireFailed(claim, f.cancelled)).toBe(false);
            const replacement = (yield* f.retention.claimFailed(f.hostId))!;
            expect(replacement.claimId).not.toBe(claim.claimId);
            expect(yield* f.retention.retireFailed(claim, f.cancelled)).toBe(false);
            expect(yield* f.retention.retireFailed(replacement, f.cancelled)).toBe(true);
          }),
        ),
      );

      it.effect("rechecks new operation pins after probe cancellation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const claim = (yield* f.retention.claimFailed(f.hostId))!;
            yield* f.sql`INSERT INTO relay_thread_vm_backup_pins(backup_operation_id,operation_id) VALUES(${f.failed.operationId},${NodeCrypto.randomUUID()})`;
            expect(yield* f.retention.retireFailed(claim, f.cancelled)).toBe(false);
            expect((yield* f.backup.get(f.failed.operationId))?.phase).toBe("failed");
          }),
        ),
      );
    });
  },
);
