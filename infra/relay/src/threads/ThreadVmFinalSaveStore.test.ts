import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmFinalSaveAbortWorker } from "./ThreadVmFinalSaveAbortWorker.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { E2BRestoreError, type E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { makeThreadVmFinalSaveWorker } from "./ThreadVmFinalSaveWorker.ts";
import { makeThreadVmFinalSaveDeletionWorker } from "./ThreadVmFinalSaveDeletionWorker.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { laterAttachmentCheckpoint } from "./testUtils/attachmentCheckpointCatalog.ts";
import { finalSaveCatalogFixture as fixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "final VM saving before deletion (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("cleanup never stops a VM before its final save is verified", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture("paused");
            yield* f.store.begin(f.input);
            yield* f.freeze;
            const worker = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.die("Unverified saving cannot authorize cleanup"),
                inspectCreation: () =>
                  Effect.die("Unverified saving cannot inspect cleanup identity"),
                destroy: () => Effect.die("A verified final save is required"),
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(false);
            expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
          }),
        ),
      );
      for (const problem of ["none", "foreign", "unknown", "lost-stop"] as const) {
        it.effect(`certified final-save cleanup reconciles an unreadable pause: ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("paused");
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              let stops = 0;
              const worker = makeThreadVmFinalSaveDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () =>
                    Effect.fail(
                      new ThreadVmComputeError({
                        operation: "inspect",
                        message: "Paused disk readiness is unavailable",
                      }),
                    ),
                  inspectCreation: (operationId) =>
                    Effect.succeed(
                      problem === "unknown"
                        ? null
                        : {
                            operationId,
                            computeRef: f.computeRef,
                            metadata: {
                              ...f.info.metadata,
                              ...(problem === "foreign" ? { "launchpad.generation": "2" } : {}),
                            },
                          },
                    ),
                  destroy: (id) =>
                    Effect.gen(function* () {
                      expect(id).toBe(f.computeRef);
                      stops++;
                      if (problem === "lost-stop" && stops === 1)
                        return yield* new ThreadVmComputeError({
                          operation: "destroy",
                          message: "Lost certified physical-stop reply",
                        });
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(stops).toBe(problem === "none" || problem === "lost-stop" ? 1 : 0);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe(
                problem === "none" ? "deleted" : "deleting",
              );
              if (problem === "lost-stop") {
                yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
                yield* worker.runOne();
                expect(stops).toBe(2);
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              }
              expect(
                (yield* makeThreadVmSavedDiskStore(f.sql).get(f.input.operationId))?.phase,
              ).toBe("available");
            }),
          ),
        );
      }
      for (const statusCode of [409, 503]) {
        it.effect(
          `reconciles a paused capture refusal (${statusCode}) without treating an outage as cancellation proof`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture("paused");
                yield* f.store.begin(f.input);
                yield* f.freeze;
                const save = yield* f.store.reserveBackup(f.input.operationId);
                const first = (yield* f.backup.claim(f.hostId, true))!;
                yield* f.backup.beginCapture(first);
                yield* f.backup.defer(first);
                yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp() WHERE operation_id=${first.operationId}`;
                const worker = makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: () =>
                      Effect.die("A refused retention must not be misread as a completed pause"),
                    snapshot: () => Effect.die("Paused capture must never snapshot a live VM"),
                    snapshotPaused: () =>
                      Effect.fail(
                        new E2BRestoreError({
                          operation: "paused snapshot",
                          reason: "http",
                          status: statusCode,
                        }),
                      ),
                    findSnapshot: () => Effect.succeed(null),
                    restore: {
                      resolveNamedSnapshot: () => Effect.die("No capture exists"),
                      prepare: () => Effect.die("No probe may start"),
                      cancel: () => Effect.die("No probe exists"),
                    },
                  },
                  f.hostId,
                );
                expect(yield* worker.runOne()).toBe(true);
                expect((yield* f.backup.get(save.backupOperationId!))?.phase).toBe(
                  statusCode === 409 ? "failed" : "creating",
                );
                yield* f.store.requestAbort(f.input.operationId);
                const abort = makeThreadVmFinalSaveAbortWorker(
                  f.sql,
                  f.objects,
                  {
                    findSnapshot: () => Effect.succeed(null),
                    deleteSnapshot: () => Effect.die("No snapshot exists"),
                    restore: { cancel: () => Effect.die("No probe was issued") },
                  },
                  f.hostId,
                );
                expect(yield* abort.runOne()).toBe(true);
                expect((yield* f.store.get(f.input.operationId))?.phase).toBe(
                  statusCode === 409 ? "aborted" : "aborting",
                );
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
                if (statusCode === 409) {
                  expect((yield* f.backup.get(save.backupOperationId!))?.phase).toBe("retired");
                  expect(
                    (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
                  ).toBeNull();
                }
              }),
            ),
        );
      }
      it.effect("reports final-save blockage while retaining the original VM and ownership", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const status = makeThreadVmStatusStore(f.sql);
            expect((yield* status.read(f.threadId, 1)).finalSave).toBeNull();
            yield* f.store.begin(f.input);
            expect(yield* status.read(f.threadId, 1)).toMatchObject({
              allocation: { state: "running" },
              finalSave: {
                operationId: f.input.operationId,
                phase: "draining",
                reason: "idle",
                errorCode: null,
              },
            });
            yield* f.freeze;
            expect((yield* status.read(f.threadId, 1)).finalSave?.phase).toBe("frozen");
            yield* makeThreadVmFinalSaveWorker(f.sql, f.objects, f.hostId).runOne();
            expect(yield* status.read(f.threadId, 1)).toMatchObject({
              finalSave: { phase: "saving", errorCode: "backup_pending" },
            });
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            expect((yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId).toBe(
              f.input.operationId,
            );
          }),
        ),
      );
      for (const problem of [
        "busy",
        "unknown",
        "stale",
        "pending-command",
        "unfinished-execution",
        "foreign-owner",
      ] as const) {
        it.effect(`keeps the VM when admission sees ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              if (problem === "busy" || problem === "unknown")
                yield* f.sql`UPDATE relay_thread_vm_activity SET activity=${problem} WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "stale")
                yield* f.sql`UPDATE relay_thread_vm_activity SET observed_at=clock_timestamp()-interval '1 hour' WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "pending-command")
                yield* f.sql`INSERT INTO relay_thread_commands(command_id,thread_id,position,accepted_generation,actor_json,payload_json) VALUES(${NodeCrypto.randomUUID()},${f.threadId},1,1,'{}','{}')`;
              if (problem === "unfinished-execution")
                yield* makeThreadPlacementStore(f.sql).admit({ ...f.owner, workId: "busy-turn" });
              expect(
                yield* Effect.flip(
                  f.store.begin({
                    ...f.input,
                    ...(problem === "foreign-owner" ? { actorUserId: "another-user" } : {}),
                  }),
                ),
              ).toMatchObject({ _tag: "ThreadVmFinalSaveConflict" });
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              expect(
                (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
              ).toBeNull();
            }),
          ),
        );
      }
      it.effect("holds ownership and accepts no stale or incomplete frozen checkpoint", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.store.begin(f.input);
            yield* Effect.flip(
              makeThreadPlacementStore(f.sql).admit({ ...f.owner, workId: "after-hold" }),
            );
            expect(
              yield* Effect.flip(
                f.store.sourceFrozen({
                  operationId: f.input.operationId,
                  environmentId: f.sourceEnvironmentId,
                  generation: 1,
                  nativeCheckpointOperationId: f.native.header.operationId,
                }),
              ),
            ).toMatchObject({ _tag: "ThreadVmFinalSaveConflict" });
            const point = yield* laterAttachmentCheckpoint(f, 1, f.input.operationId);
            yield* Effect.flip(
              f.store.sourceFrozen({
                operationId: f.input.operationId,
                environmentId: f.sourceEnvironmentId,
                generation: 1,
                nativeCheckpointOperationId: point.native.header.operationId,
              }),
            );
            yield* f.upload(point.attachments);
            yield* f.attachmentStore.publish({
              threadId: f.threadId,
              operationId: point.attachments.header.operationId,
              manifestArtifactId: point.attachments.artifactId,
              nativeCheckpointOperationId: point.native.header.operationId,
            });
            const frozen = yield* f.store.sourceFrozen({
              operationId: f.input.operationId,
              environmentId: f.sourceEnvironmentId,
              generation: 1,
              nativeCheckpointOperationId: point.native.header.operationId,
            });
            expect(frozen.phase).toBe("frozen");
            yield* Effect.flip(
              f.journal.confirmThrough({ ...f.owner, sourceSequence: point.sourceSequence + 1 }),
            );
            expect(
              yield* Effect.flip(
                f.store.begin({ ...f.input, operationId: NodeCrypto.randomUUID() }),
              ),
            ).toMatchObject({ _tag: "ThreadVmFinalSaveConflict" });
          }),
        ),
      );
      it.effect(
        "cannot delete before a fresh final backup and cold probe; retries retain the saved-only placement",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              const candidate = yield* f.store.reserveBackup(f.input.operationId);
              yield* f.store.reserveBackup(f.input.operationId);
              expect(yield* Effect.flip(f.store.recordSaved(f.input.operationId))).toMatchObject({
                _tag: "ThreadVmFinalSaveConflict",
              });
              expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
              yield* f.verifyBackup;
              const saved = yield* f.store.recordSaved(f.input.operationId);
              yield* f.store.recordSaved(f.input.operationId);
              expect(saved.backupOperationId).toBe(candidate.backupOperationId);
              expect(saved.phase).toBe("deleting");
              expect(
                (yield* makeThreadVmSavedDiskStore(f.sql).get(f.input.operationId))?.phase,
              ).toBe("available");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleting");
              expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
            }),
          ),
      );
      it.effect(
        "workers advance only a frozen source, wait for its cold proof, then release the deleted allocation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                worker = makeThreadVmFinalSaveWorker(f.sql, f.objects, f.hostId);
              yield* f.store.begin(f.input);
              expect(yield* worker.runOne()).toBe(false);
              yield* f.freeze;
              expect(yield* worker.runOne()).toBe(true);
              const saving = (yield* f.store.get(f.input.operationId))!;
              expect(saving).toMatchObject({
                phase: "saving",
                errorCode: "backup_pending",
                physicalDeleteStartedAt: null,
              });
              expect(yield* worker.runOne()).toBe(false);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              yield* f.verifyBackup;
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("deleting");
              let stops = 0;
              const deletion = makeThreadVmFinalSaveDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(null),
                  destroy: () =>
                    Effect.sync(() => {
                      stops++;
                    }),
                },
                f.hostId,
              );
              expect(yield* deletion.runOne()).toBe(true);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("completed");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect(yield* deletion.runOne()).toBe(false);
              expect(yield* worker.runOne()).toBe(false);
              expect(stops).toBe(1);
            }),
          ),
      );
      it.effect(
        "only one worker claims final-save preparation; abort wins before a pending save is acted on",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              const claims = yield* Effect.all(
                [f.store.claimSave(f.hostId), f.store.claimSave(f.hostId)],
                { concurrency: "unbounded" },
              );
              expect(claims.filter(Boolean)).toHaveLength(1);
              yield* f.store.requestAbort(f.input.operationId);
              expect(yield* makeThreadVmFinalSaveWorker(f.sql, f.objects, f.hostId).runOne()).toBe(
                false,
              );
              expect((yield* f.store.get(f.input.operationId))?.backupOperationId).toBeNull();
              yield* f.store.confirmAborted(f.input.operationId);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect("cancels a final-save hold before source export without any compute action", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.store.requestAbort(f.input.operationId);
            const worker = makeThreadVmFinalSaveAbortWorker(
              f.sql,
              f.objects,
              {
                findSnapshot: () => Effect.die("Unexpected lookup"),
                deleteSnapshot: () => Effect.die("Unexpected snapshot deletion"),
                restore: { cancel: () => Effect.die("Unexpected probe stop") },
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
            expect(
              (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
            ).toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
          }),
        ),
      );
      for (const originalState of ["running", "paused"] as const) {
        it.effect(
          `cancels a never-started final capture without waking or stopping its ${originalState} source`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(originalState);
                yield* f.store.begin(f.input);
                yield* f.freeze;
                const pending = yield* f.store.reserveBackup(f.input.operationId);
                yield* f.store.requestAbort(f.input.operationId);
                const worker = makeThreadVmFinalSaveAbortWorker(
                  f.sql,
                  f.objects,
                  {
                    findSnapshot: () => Effect.die("Unexpected capture lookup"),
                    deleteSnapshot: () => Effect.die("Unexpected snapshot delete"),
                    restore: { cancel: () => Effect.die("Unexpected probe cancellation") },
                  },
                  f.hostId,
                );
                expect(yield* worker.runOne()).toBe(true);
                expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
                expect((yield* f.backup.get(pending.backupOperationId!))?.phase).toBe("retired");
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe(originalState);
                expect(
                  (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
                ).toBeNull();
                expect(yield* worker.runOne()).toBe(false);
              }),
            ),
        );
      }
      it.effect(
        "a cancelled uncertain capture keeps its source until the exact snapshot is found",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              const save = yield* f.store.reserveBackup(f.input.operationId),
                capture = (yield* f.backup.claim(f.hostId))!;
              yield* f.backup.beginCapture(capture);
              yield* f.store.requestAbort(f.input.operationId);
              let lookup: "absent" | "foreign" | "own" = "absent",
                deleted = 0;
              const worker = makeThreadVmFinalSaveAbortWorker(
                f.sql,
                f.objects,
                {
                  findSnapshot: () =>
                    Effect.sync(() =>
                      lookup === "absent"
                        ? null
                        : {
                            snapshotId: `snapshot-${capture.operationId}`,
                            names: [
                              lookup === "foreign" ? "some-other-snapshot" : capture.snapshotName,
                            ],
                          },
                    ),
                  deleteSnapshot: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(`snapshot-${capture.operationId}`);
                      deleted++;
                      return true;
                    }),
                  restore: { cancel: () => Effect.die("Capture never started a probe") },
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false); // active capture claim
              yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${capture.operationId}`;
              for (const state of ["absent", "foreign"] as const) {
                lookup = state;
                yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
                expect(yield* worker.runOne()).toBe(true);
                expect((yield* f.store.get(f.input.operationId))?.errorCode).toBe(
                  "capture_unconfirmed",
                );
                expect((yield* f.backup.get(save.backupOperationId!))?.phase).toBe("creating");
                expect(deleted).toBe(0);
              }
              lookup = "own";
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              yield* worker.runOne();
              expect(deleted).toBe(1);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect(
        "retries a lost snapshot-delete response without asking to stop a nonexistent probe",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.store.reserveBackup(f.input.operationId);
              const capture = (yield* f.backup.claim(f.hostId))!;
              yield* f.backup.beginCapture(capture);
              yield* f.backup.recordCapture(capture, {
                snapshotId: `snapshot-${capture.operationId}`,
                sourceTemplateId: "snapshot",
                sourceBuildId: NodeCrypto.randomUUID(),
              });
              yield* f.store.requestAbort(f.input.operationId);
              let lost = true,
                deletes = 0;
              const worker = makeThreadVmFinalSaveAbortWorker(
                f.sql,
                f.objects,
                {
                  findSnapshot: () => Effect.die("Unexpected lookup"),
                  deleteSnapshot: () =>
                    Effect.gen(function* () {
                      deletes++;
                      if (lost)
                        return yield* new ThreadVmComputeError({
                          operation: "delete snapshot",
                          message: "lost reply",
                        });
                      return false;
                    }),
                  restore: { cancel: () => Effect.die("Probe was never started") },
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.backup.get(capture.operationId))?.phase).toBe("retiring");
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
              expect((yield* f.store.get(f.input.operationId))?.abortProbeStoppedAt).not.toBeNull();
              lost = false;
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              yield* worker.runOne();
              expect(deletes).toBe(2);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
            }),
          ),
      );
      it.effect(
        "stops the correct recovery probe before deleting its candidate and releasing the source hold",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.store.reserveBackup(f.input.operationId);
              const capture = (yield* f.backup.claim(f.hostId))!;
              yield* f.backup.beginCapture(capture);
              yield* f.backup.recordCapture(capture, {
                snapshotId: `snapshot-${capture.operationId}`,
                sourceTemplateId: "snapshot",
                sourceBuildId: NodeCrypto.randomUUID(),
              });
              const probe = (yield* f.backup.claim(f.hostId))!;
              yield* f.store.requestAbort(f.input.operationId);
              yield* f.sql`UPDATE relay_thread_vm_backups SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${probe.operationId}`;
              let response: "foreign" | "cancelling" | "cancelled" = "foreign",
                deletes = 0;
              const worker = makeThreadVmFinalSaveAbortWorker(
                f.sql,
                f.objects,
                {
                  findSnapshot: () => Effect.die("Unexpected lookup"),
                  deleteSnapshot: () =>
                    Effect.sync(() => {
                      deletes++;
                      return true;
                    }),
                  restore: {
                    cancel: (operationID, generation) =>
                      Effect.sync((): E2BRestoreStatus => ({
                        operationID: response === "foreign" ? NodeCrypto.randomUUID() : operationID,
                        generation,
                        sandboxID: "probe",
                        executionID: NodeCrypto.randomUUID(),
                        preparedBuildID: NodeCrypto.randomUUID(),
                        state: response === "cancelling" ? "cancelling" : "cancelled",
                      })),
                  },
                },
                f.hostId,
              );
              for (const state of ["foreign", "cancelling"] as const) {
                response = state;
                yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
                yield* worker.runOne();
                expect(deletes).toBe(0);
                expect((yield* f.store.get(f.input.operationId))?.abortProbeStoppedAt).toBeNull();
                expect((yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId).toBe(
                  f.input.operationId,
                );
              }
              response = "cancelled";
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              yield* worker.runOne();
              expect(deletes).toBe(1);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect("cancellation retains a final capture pinned by another recovery operation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            const save = yield* f.verifyBackup;
            yield* makeThreadVmBackupRetentionStore(f.sql).pin({
              threadId: f.threadId,
              backupOperationId: save.backupOperationId!,
              operationId: "another-recovery",
            });
            yield* f.store.requestAbort(f.input.operationId);
            const worker = makeThreadVmFinalSaveAbortWorker(
              f.sql,
              f.objects,
              {
                findSnapshot: () => Effect.die("Unexpected lookup"),
                deleteSnapshot: () => Effect.die("Pinned recovery root"),
                restore: { cancel: () => Effect.die("Unexpected probe stop") },
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.store.get(f.input.operationId))?.errorCode).toBe(
              "recovery_cleanup_unavailable",
            );
            expect((yield* f.backup.get(save.backupOperationId!))?.phase).toBe("verified");
            expect((yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId).toBe(
              f.input.operationId,
            );
          }),
        ),
      );
      it.effect("policy changes during inspection still prevent the physical stop", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.store.recordSaved(f.input.operationId);
            let stops = 0;
            const worker = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () =>
                  Effect.gen(function* () {
                    yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=100,revision=revision+1 WHERE organization_id='org'`.pipe(
                      Effect.orDie,
                    );
                    return null;
                  }),
                destroy: () =>
                  Effect.sync(() => {
                    stops++;
                  }),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect(stops).toBe(0);
            expect((yield* f.store.get(f.input.operationId))?.physicalDeleteStartedAt).toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
            yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=2,revision=revision+1 WHERE organization_id='org'`;
          }),
        ),
      );
      it.effect(
        "a policy change after an uncertain physical stop cannot strand its quota reservation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              let lost = true,
                stops = 0;
              const worker = makeThreadVmFinalSaveDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(null),
                  destroy: () =>
                    Effect.gen(function* () {
                      stops++;
                      if (lost) {
                        yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=100,revision=revision+1 WHERE organization_id='org'`.pipe(
                          Effect.orDie,
                        );
                        return yield* new ThreadVmComputeError({
                          operation: "destroy",
                          message: "lost physical stop response",
                        });
                      }
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              const boundary = (yield* f.store.get(f.input.operationId))!.physicalDeleteStartedAt;
              expect(boundary).not.toBeNull();
              expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
              lost = false;
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              yield* worker.runOne();
              expect(stops).toBe(2);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect((yield* f.store.get(f.input.operationId))?.physicalDeleteStartedAt).toBe(
                boundary,
              );
              yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=2,revision=revision+1 WHERE organization_id='org'`;
            }),
          ),
      );
      it.effect("a lost physical stop reply retains quota; a verified retry releases it once", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.store.recordSaved(f.input.operationId);
            let failed = true,
              stops = 0;
            const worker = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.succeed(null),
                destroy: () => {
                  stops++;
                  return failed
                    ? Effect.fail(
                        new ThreadVmComputeError({
                          operation: "destroy",
                          message: "lost stop reply",
                        }),
                      )
                    : Effect.void;
                },
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("deleting");
            failed = false;
            yield* f.sql`UPDATE relay_thread_vm_final_saves SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
            yield* worker.runOne();
            expect(stops).toBe(2);
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
            const saved = (yield* makeThreadVmSavedDiskStore(f.sql).get(f.input.operationId))!;
            yield* f.store.confirmDeleted({
              operationId: f.input.operationId,
              claimId: "completed-retry",
            });
            expect(
              (yield* makeThreadVmSavedDiskStore(f.sql).get(f.input.operationId))?.savedAt,
            ).toBe(saved.savedAt);
            expect(
              (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
            ).toBeNull();
            const [credentials] = yield* f.sql<{
              revoked: boolean;
            }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_environment_credentials WHERE credential_id=${f.credentialId}`;
            expect(credentials?.revoked).toBe(true);
          }),
        ),
      );
      for (const problem of [
        "foreign-compute",
        "missing-disk-pin",
        "missing-native-pin",
        "stale-catalog",
      ] as const) {
        it.effect(`certified deletion reconciles ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              if (problem === "missing-disk-pin")
                yield* f.sql`DELETE FROM relay_thread_vm_backup_pins WHERE operation_id=${`saved-${f.input.operationId}`}`;
              if (problem === "missing-native-pin")
                yield* f.sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${`native-recovery:${f.input.operationId}`}`;
              let stops = 0;
              const worker = makeThreadVmFinalSaveDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () =>
                    Effect.succeed(
                      problem === "foreign-compute"
                        ? {
                            ...f.info,
                            metadata: {
                              ...f.info.metadata,
                              "launchpad.allocation_id": "someone-else",
                            },
                          }
                        : problem === "stale-catalog"
                          ? f.info
                          : null,
                    ),
                  destroy: () =>
                    Effect.sync(() => {
                      stops++;
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(stops).toBe(problem === "stale-catalog" ? 1 : 0);
              const allocation = yield* f.allocations.get(f.input.allocationId);
              if (problem === "stale-catalog") expect(allocation?.state).toBe("deleted");
              else expect(allocation?.deletedAt).toBeNull();
            }),
          ),
        );
      }
      it.effect("rechecks a changed idle threshold before allowing deletion", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=100,revision=revision+1 WHERE organization_id='org'`;
            yield* Effect.flip(f.store.recordSaved(f.input.operationId));
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=2,revision=revision+1 WHERE organization_id='org'`;
          }),
        ),
      );
      it.effect("only one worker can claim deletion and a stale claim cannot release quota", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.store.recordSaved(f.input.operationId);
            const claims = yield* Effect.all(
              [f.store.claimDeletion(f.hostId), f.store.claimDeletion(f.hostId)],
              { concurrency: "unbounded" },
            );
            expect(claims.filter(Boolean)).toHaveLength(1);
            const old = claims.find((c) => c !== null)!;
            yield* f.sql`UPDATE relay_thread_vm_final_saves SET claim_until=clock_timestamp()-interval '1 second' WHERE operation_id=${f.input.operationId}`;
            const current = (yield* f.store.claimDeletion(f.hostId))!;
            expect(current.claimId).not.toBe(old.claimId);
            yield* Effect.flip(f.store.authorizeDeletion(old));
            yield* Effect.flip(f.store.confirmDeleted(old));
            expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
            yield* f.store.authorizeDeletion(current);
          }),
        ),
      );
      it.effect(
        "new activity after reservation blocks freezing and cancellation preserves the source",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              const point = yield* laterAttachmentCheckpoint(f, 1, f.input.operationId);
              yield* f.upload(point.attachments);
              yield* f.attachmentStore.publish({
                threadId: f.threadId,
                operationId: point.attachments.header.operationId,
                manifestArtifactId: point.attachments.artifactId,
                nativeCheckpointOperationId: point.native.header.operationId,
              });
              yield* f.sql`UPDATE relay_thread_vm_activity SET activity='unknown',idle_since=NULL WHERE allocation_id=${f.input.allocationId}`;
              yield* Effect.flip(
                f.store.sourceFrozen({
                  operationId: f.input.operationId,
                  environmentId: f.sourceEnvironmentId,
                  generation: 1,
                  nativeCheckpointOperationId: point.native.header.operationId,
                }),
              );
              yield* f.store.requestAbort(f.input.operationId);
              yield* f.store.confirmAborted(f.input.operationId);
              yield* f.store.confirmAborted(f.input.operationId);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              expect(
                (yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId,
              ).toBeNull();
            }),
          ),
      );
      it.effect(
        "cancellation cannot discard an uncertain capture or undo saved-only ownership",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.store.reserveBackup(f.input.operationId);
              yield* f.store.requestAbort(f.input.operationId);
              yield* Effect.flip(f.store.confirmAborted(f.input.operationId));
              expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
              expect((yield* makeThreadPlacementStore(f.sql).get(f.threadId))?.operationId).toBe(
                f.input.operationId,
              );
              const other = yield* fixture();
              yield* other.store.begin(other.input);
              yield* other.freeze;
              yield* other.verifyBackup;
              yield* other.store.recordSaved(other.input.operationId);
              yield* Effect.flip(other.store.requestAbort(other.input.operationId));
              expect((yield* other.store.get(other.input.operationId))?.phase).toBe("deleting");
            }),
          ),
      );
      it.effect("a policy edit after saving still prevents physical deletion", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.store.recordSaved(f.input.operationId);
            yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=100,revision=revision+1 WHERE organization_id='org'`;
            let stops = 0;
            const worker = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.succeed(null),
                destroy: () =>
                  Effect.sync(() => {
                    stops++;
                  }),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect(stops).toBe(0);
            expect((yield* f.allocations.get(f.input.allocationId))?.deletedAt).toBeNull();
            yield* f.sql`UPDATE relay_thread_vm_policies SET delete_after_idle_weekdays=2,revision=revision+1 WHERE organization_id='org'`;
          }),
        ),
      );
      it.effect(
        "stages commands during a paused final save without waking the old allocation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("paused");
              yield* f.store.begin(f.input);
              const queued = yield* f.journal.stage({
                threadId: f.threadId,
                actor: { userId: f.input.actorUserId, displayName: "Owner", imageUrl: null },
                command: {
                  type: "thread.queue.pause",
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  threadId: ThreadId.make(f.threadId),
                  createdAt: "2026-10-07T10:00:00Z",
                },
              });
              expect(queued?.receipt).toBeNull();
              expect(yield* f.journal.next(f.owner)).toBeNull();
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=${f.input.allocationId}`,
              ).toHaveLength(0);
              yield* f.freeze;
              const saved = yield* f.store.reserveBackup(f.input.operationId);
              const claim = yield* f.backup.claim(f.hostId, true);
              expect(claim?.finalSaveOperationId).toBe(f.input.operationId);
              expect(claim?.originalState).toBe("paused");
              expect(saved.backupOperationId).toBe(claim?.operationId);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
            }),
          ),
      );
      for (const adapter of ["missing", "older-host"] as const) {
        it.effect(`does not claim a paused capture with ${adapter} support`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("paused");
              yield* f.store.begin(f.input);
              yield* f.freeze;
              const save = yield* f.store.reserveBackup(f.input.operationId);
              const worker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () => Effect.die("unsupported capture must not inspect"),
                  snapshot: () => Effect.die("must not use an ordinary snapshot"),
                  ...(adapter === "older-host"
                    ? {
                        snapshotPaused: () => Effect.die("unsupported host must not capture"),
                        pausedSnapshotsSupported: Effect.succeed(false),
                      }
                    : {}),
                  findSnapshot: () => Effect.die("no capture was attempted"),
                  restore: {
                    resolveNamedSnapshot: () => Effect.die("no snapshot"),
                    prepare: () => Effect.die("no snapshot"),
                    cancel: () => Effect.die("no probe"),
                  },
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false);
              const [candidate] = yield* f.sql<{
                phase: string;
                claimId: string | null;
              }>`SELECT phase,claim_id AS "claimId" FROM relay_thread_vm_backups WHERE operation_id=${save.backupOperationId}`;
              expect(candidate).toMatchObject({ phase: "pending", claimId: null });
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
            }),
          ),
        );
      }
      it.effect("a paused capture failure never resumes or deletes the source", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture("paused");
            yield* f.store.begin(f.input);
            yield* f.freeze;
            yield* f.store.reserveBackup(f.input.operationId);
            const worker = makeThreadVmBackupWorker(
              f.sql,
              {
                inspect: () => Effect.succeed(f.info),
                snapshot: () =>
                  Effect.die("A paused VM must never use the ordinary capture method"),
                snapshotPaused: () =>
                  Effect.fail(
                    new ThreadVmComputeError({
                      operation: "snapshot",
                      message: "paused capture unavailable",
                    }),
                  ),
                findSnapshot: () => Effect.succeed(null),
                restore: {
                  resolveNamedSnapshot: () => Effect.die("no snapshot"),
                  prepare: () => Effect.die("no snapshot"),
                  cancel: () => Effect.die("no probe"),
                },
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("saving");
            yield* Effect.flip(f.store.recordSaved(f.input.operationId));
          }),
        ),
      );
    });
  },
);
