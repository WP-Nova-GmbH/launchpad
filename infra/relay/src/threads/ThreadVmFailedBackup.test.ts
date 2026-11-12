import { makeThreadVmFinalSaveWorker } from "./ThreadVmFinalSaveWorker.ts";
import { makeThreadVmFinalSaveAbortWorker } from "./ThreadVmFinalSaveAbortWorker.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { makeThreadVmPauseRecoveryStore } from "./ThreadVmPauseRecoveryStore.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmBackupSourceStore } from "./ThreadVmBackupSourceStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmBackupRetentionWorker } from "./ThreadVmBackupRetentionWorker.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { laterAttachmentCheckpoint } from "./testUtils/attachmentCheckpointCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  const source = makeThreadVmBackupSourceStore(f.sql, f.objects),
    natives = makeThreadNativeCheckpointStore(f.sql, f.objects);
  let offset = 0;
  const enqueue = Effect.gen(function* () {
    yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
    const operationId = (yield* f.backup.enqueueDue(f.hostId))!;
    expect(operationId).toBeTypeOf("string");
    return operationId;
  });
  const freeze = Effect.fnUntraced(function* (operationId: string) {
    const point = yield* laterAttachmentCheckpoint(f, ++offset, operationId);
    yield* f.upload(point.attachments);
    yield* f.attachmentStore.publish({
      threadId: f.threadId,
      operationId: point.attachments.header.operationId,
      manifestArtifactId: point.attachments.artifactId,
      nativeCheckpointOperationId: point.native.header.operationId,
    });
    const input = {
      ...f.owner,
      operationId,
      nativeCheckpointOperationId: point.native.header.operationId,
      bootId: NodeCrypto.randomUUID(),
      sealEpoch: 1,
    };
    yield* source.sourceFrozen(input);
    return { ...input, sourceSequence: point.sourceSequence };
  });
  const complete = Effect.fnUntraced(function* (operationId: string) {
    const claim = (yield* f.backup.claim(f.hostId))!;
    expect(claim.operationId).toBe(operationId);
    expect(yield* f.backup.beginCapture(claim)).toBe(true);
    expect(
      yield* f.backup.recordCapture(claim, {
        snapshotId: `snapshot-${operationId}`,
        sourceTemplateId: `snapshot-${operationId}`,
        sourceBuildId: NodeCrypto.randomUUID(),
      }),
    ).toBe(true);
    return (yield* f.backup.get(operationId))!;
  });
  const queue = Effect.gen(function* () {
    const commandId = CommandId.make(NodeCrypto.randomUUID());
    yield* f.journal.stage({
      threadId: f.threadId,
      actor: { userId: f.input.actorUserId, displayName: "Test", imageUrl: null },
      command: {
        type: "thread.queue.pause",
        commandId,
        threadId: ThreadId.make(f.threadId),
        createdAt: "2026-10-28T10:00:00Z",
      },
    });
    return commandId;
  });
  const pinPhase = Effect.fnUntraced(function* (id: string) {
    const [row] = yield* f.sql<{
      phase: string;
    }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${id}`;
    return row?.phase;
  });
  return {
    ...f,
    finalFreeze: f.freeze,
    source,
    natives,
    enqueue,
    freeze,
    complete,
    queue,
    pinPhase,
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "native full snapshot capture and retention (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const activity of ["busy", "unknown"] as const)
        it.effect(`does not interrupt ${activity} work for a periodic backup`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.sql`UPDATE relay_thread_vm_activity SET activity=${activity} WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* f.backup.enqueueDue(f.hostId)).toBeNull();
            }),
          ),
        );
      it.effect(
        "waits for source history, attachments and an exact closed seal before snapshot dispatch",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue;
              const worker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () => Effect.die("No source acknowledgement"),
                  snapshot: () => Effect.die("No source acknowledgement"),
                  findSnapshot: () => Effect.die("No POST dispatched"),
                  restore: {
                    resolveNamedSnapshot: () => Effect.die("No capture"),
                    resolveFailedNamedSnapshot: () => Effect.die("No capture"),
                  },
                },
                f.hostId,
                false,
              );
              expect(yield* worker.runOne()).toBe(false);
              const frozen = yield* f.freeze(id);
              const claim = (yield* f.backup.claim(f.hostId))!;
              expect(claim.sourceReceipt.bootId).toBe(frozen.bootId);
              expect(claim.sourceReceipt.sealEpoch).toBe(1);
              expect(yield* f.pinPhase(id)).toBe("active");
            }),
          ),
      );
      it.effect(
        "a new queued command cancels only an undispatched capture and waits for source reopening",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue;
              yield* f.freeze(id);
              const claim = (yield* f.backup.claim(f.hostId))!;
              const commandId = yield* f.queue;
              expect((yield* f.backup.get(id))?.phase).toBe("failed");
              expect(yield* f.backup.beginCapture(claim)).toBe(false);
              expect(yield* f.journal.next(f.owner)).toBeNull();
              const ack = yield* f.source.confirmActivation({ ...f.owner, operationId: id });
              expect(ack.sourceReopened).toBe(true);
              expect(yield* f.pinPhase(id)).toBe("released");
              expect((yield* f.journal.next(f.owner))?.command.commandId).toBe(commandId);
            }),
          ),
      );
      it.effect("queued commands cannot cancel or reopen an uncertain native snapshot", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              id = yield* f.enqueue;
            yield* f.freeze(id);
            const claim = (yield* f.backup.claim(f.hostId))!;
            yield* f.backup.beginCapture(claim);
            yield* f.queue;
            expect((yield* f.backup.get(id))?.phase).toBe("creating");
            yield* Effect.flip(f.source.cancelPending({ ...f.owner, operationId: id }));
            yield* Effect.flip(f.source.confirmActivation({ ...f.owner, operationId: id }));
            expect(yield* f.journal.next(f.owner)).toBeNull();
          }),
        ),
      );
      it.effect(
        "a lost snapshot reply uses one POST then read-only alias reconciliation even after native pause",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue;
              yield* f.freeze(id);
              let posts = 0,
                lookups = 0;
              const worker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed(f.info),
                  snapshot: () =>
                    Effect.gen(function* () {
                      posts++;
                      return yield* new ThreadVmComputeError({
                        operation: "snapshot",
                        message: "lost native reply",
                      });
                    }),
                  findSnapshot: () =>
                    Effect.sync(() => {
                      lookups++;
                      const alias = `native-team/launchpad-backup-${id}`;
                      return { snapshotId: `${alias}:default`, names: [alias] };
                    }),
                  restore: {
                    resolveFailedNamedSnapshot: () => Effect.succeed(null),
                    resolveNamedSnapshot: (name) => {
                      expect(name).toBe(`launchpad-backup-${id}`);
                      return Effect.succeed({
                        sourceTemplateID: `snapshot-${id}`,
                        sourceBuildID: NodeCrypto.randomUUID(),
                      });
                    },
                  },
                },
                f.hostId,
                false,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(posts).toBe(1);
              expect((yield* f.backup.get(id))?.phase).toBe("creating");
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='paused' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp() WHERE operation_id=${id}`;
              expect(yield* worker.runOne()).toBe(true);
              expect(posts).toBe(1);
              expect(lookups).toBe(1);
              expect((yield* f.backup.get(id))?.nativeCaptureReceipt?.kind).toBe(
                "native-full-snapshot-v1",
              );
              expect((yield* f.backup.get(id))?.nativeCaptureReceipt?.snapshotId).toBe(
                `snapshot-${id}`,
              );
              expect((yield* f.source.get(f.owner))?.canActivate).toBe(false);
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.source.confirmActivation({ ...f.owner, operationId: id });
              expect(yield* f.pinPhase(id)).toBe("active");
            }),
          ),
      );
      it.effect(
        "native completion retains independent recovery after source reopening until catalog retirement",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                old = yield* f.enqueue;
              yield* f.freeze(old);
              yield* f.complete(old);
              yield* f.source.confirmActivation({ ...f.owner, operationId: old });
              yield* f.sql`UPDATE relay_thread_vm_backups SET verified_at=clock_timestamp()-interval '1 hour' WHERE operation_id=${old}`;
              const current = yield* f.enqueue;
              yield* f.freeze(current);
              yield* f.complete(current);
              yield* f.source.confirmActivation({ ...f.owner, operationId: current });
              const retention = makeThreadVmBackupRetentionStore(f.sql);
              yield* retention.pin({
                threadId: f.threadId,
                backupOperationId: old,
                operationId: "restore-pin",
              });
              const worker = makeThreadVmBackupRetentionWorker(
                f.sql,
                {
                  deleteSnapshot: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(`snapshot-${old}`);
                      return true;
                    }),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false);
              yield* retention.releasePin({ backupOperationId: old, operationId: "restore-pin" });
              expect(yield* worker.runOne()).toBe(true);
              expect(yield* f.pinPhase(old)).toBe("released");
              expect(yield* f.pinPhase(current)).toBe("active");
              expect((yield* f.backup.get(current))?.phase).toBe("verified");
            }),
          ),
      );
      it.effect(
        "new execution and moves stay fenced until the captured source acknowledges reopening",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue,
                placements = makeThreadPlacementStore(f.sql);
              const move = {
                threadId: f.threadId,
                operationId: NodeCrypto.randomUUID(),
                actorUserId: f.input.actorUserId,
                sourceEnvironmentId: f.sourceEnvironmentId,
                expectedGeneration: 1,
                destinationEnvironmentId: "local-destination",
                destinationProjectId: "original-project",
              };
              const work = { ...f.owner, workId: "later-work" };
              yield* Effect.flip(placements.admit(work));
              yield* Effect.flip(placements.beginMove(move));
              const point = yield* f.freeze(id);
              yield* Effect.flip(placements.admit(work));
              yield* Effect.flip(placements.beginMove(move));
              yield* f.complete(id);
              yield* Effect.flip(placements.admit(work));
              yield* Effect.flip(placements.beginMove(move));
              yield* Effect.flip(
                f.journal.confirmThrough({ ...f.owner, sourceSequence: point.sourceSequence + 1 }),
              );
              yield* f.source.confirmActivation({ ...f.owner, operationId: id });
              expect((yield* placements.admit(work)).newlyAdmitted).toBe(true);
              yield* placements.completeWork(work);
              expect((yield* placements.beginMove(move)).phase).toBe("preparing");
            }),
          ),
      );
      it.effect(
        "an uncaptured cancelled drain holds lifecycle admission until the guest reopens it",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue,
                pauses = makeThreadVmPauseStore(f.sql);
              yield* f.source.cancelPending({ ...f.owner, operationId: id });
              expect(yield* pauses.reserveIdle(f.hostId)).toBeNull();
              yield* Effect.flip(f.store.begin(f.input));
              yield* Effect.flip(
                makeThreadPlacementStore(f.sql).beginMove({
                  threadId: f.threadId,
                  operationId: NodeCrypto.randomUUID(),
                  actorUserId: f.input.actorUserId,
                  sourceEnvironmentId: f.sourceEnvironmentId,
                  expectedGeneration: 1,
                  destinationEnvironmentId: "local-destination",
                  destinationProjectId: "original-project",
                }),
              );
              yield* f.source.confirmActivation({ ...f.owner, operationId: id });
              expect(yield* pauses.reserveIdle(f.hostId)).toBe(f.input.allocationId);
            }),
          ),
      );
      it.effect("managed pause waits for a native backup even with periodic backups disabled", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              pauses = makeThreadVmPauseStore(f.sql),
              recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
            yield* pauses.reserveIdle(f.hostId);
            const pause = (yield* recovery.get(f.owner))!,
              point = yield* laterAttachmentCheckpoint(f, 1, pause.operationId);
            yield* f.upload(point.attachments);
            yield* f.attachmentStore.publish({
              threadId: f.threadId,
              operationId: point.attachments.header.operationId,
              manifestArtifactId: point.attachments.artifactId,
              nativeCheckpointOperationId: point.native.header.operationId,
            });
            const source = yield* recovery.sourceFrozen({
              ...f.owner,
              operationId: pause.operationId,
              nativeCheckpointOperationId: point.native.header.operationId,
              bootId: NodeCrypto.randomUUID(),
              sealEpoch: 1,
            });
            expect(yield* pauses.claim(f.hostId)).toBeNull();
            let posts = 0;
            const worker = makeThreadVmBackupWorker(
              f.sql,
              {
                inspect: () => Effect.succeed(f.info),
                snapshot: (_id, name) =>
                  Effect.sync(() => {
                    posts++;
                    return {
                      snapshotId: `native-team/${name}:default`,
                      names: [`native-team/${name}`],
                    };
                  }),
                findSnapshot: () => Effect.die("One successful dispatch needs no reconciliation"),
                restore: {
                  resolveFailedNamedSnapshot: () => Effect.succeed(null),
                  resolveNamedSnapshot: () =>
                    Effect.succeed({
                      sourceTemplateID: "pause-snapshot",
                      sourceBuildID: NodeCrypto.randomUUID(),
                    }),
                },
              },
              f.hostId,
              false,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect(posts).toBe(1);
            expect(
              (yield* f.backup.get(source.backupOperationId!))?.nativeCaptureReceipt?.source
                .captureOperationId,
            ).toBe(pause.operationId);
            expect((yield* pauses.claim(f.hostId))?.operationId).toBe(pause.operationId);
          }),
        ),
      );
      for (const queuedWake of [false, true])
        it.effect(
          `native timeout before pause snapshot dispatch retains the sealed source for ${queuedWake ? "queued" : "explicit"} wake`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  pauses = makeThreadVmPauseStore(f.sql),
                  recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
                yield* pauses.reserveIdle(f.hostId);
                const pause = (yield* recovery.get(f.owner))!,
                  point = yield* laterAttachmentCheckpoint(f, 1, pause.operationId);
                yield* f.upload(point.attachments);
                yield* f.attachmentStore.publish({
                  threadId: f.threadId,
                  operationId: point.attachments.header.operationId,
                  manifestArtifactId: point.attachments.artifactId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                });
                const frozen = yield* recovery.sourceFrozen({
                  ...f.owner,
                  operationId: pause.operationId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                  bootId: NodeCrypto.randomUUID(),
                  sealEpoch: 1,
                });
                if (queuedWake)
                  yield* f.journal.stage({
                    threadId: f.threadId,
                    actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                    command: {
                      type: "thread.queue.resume",
                      commandId: CommandId.make(NodeCrypto.randomUUID()),
                      threadId: ThreadId.make(f.threadId),
                      expectedRevision: 0,
                      createdAt: "2026-10-29T10:00:00Z",
                    },
                  });
                const worker = makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state: "paused" as const }),
                    snapshot: () => Effect.die("Never dispatch a snapshot for stopped compute"),
                    findSnapshot: () => Effect.die("No snapshot was dispatched"),
                    restore: {
                      resolveNamedSnapshot: () => Effect.die("No snapshot exists"),
                      resolveFailedNamedSnapshot: () => Effect.die("No snapshot was dispatched"),
                    },
                  },
                  f.hostId,
                  false,
                );
                expect(yield* worker.runOne()).toBe(true);
                expect((yield* f.backup.get(frozen.backupOperationId!))?.phase).toBe("retired");
                expect(yield* f.pinPhase(frozen.backupOperationId!)).toBe("released");
                expect(yield* f.pinPhase(pause.operationId)).toBe("active");
                expect(yield* recovery.get(f.owner)).toMatchObject({
                  operationId: pause.operationId,
                  phase: "cancelled",
                  sourceReopened: false,
                  canActivate: false,
                  nativeCheckpointOperationId: point.native.header.operationId,
                });
                const [allocation] =
                  yield* f.sql`SELECT state,native_paused_generation FROM relay_thread_vm_allocations WHERE allocation_id=${f.input.allocationId}`;
                expect(allocation).toMatchObject({ state: "paused", native_paused_generation: 1 });
                const [capacity] =
                  yield* f.sql`SELECT state FROM relay_thread_vm_capacity WHERE operation_id=${f.input.allocationId}`;
                expect(capacity?.state).toBe("released");
                const resumes = makeThreadVmResumeStore(f.sql);
                if (queuedWake)
                  expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("waiting");
                else yield* resumes.request(f.threadId);
                yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
                const resume = (yield* resumes.claim(f.hostId))!;
                expect(resume.pauseOperationId).toBe(pause.operationId);
                if (!queuedWake) {
                  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
                  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
                  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${f.input.actorUserId},'admin','now','now') ON CONFLICT DO NOTHING`;
                  yield* resumes.begin(resume);
                  yield* resumes.finishPower(resume, "sealed-resumed-test-token");
                  yield* resumes.complete(resume);
                  yield* recovery.confirmActivation({ ...f.owner, operationId: pause.operationId });
                  const acknowledged = Effect.gen(function* () {
                    const [row] =
                      yield* f.sql`SELECT source_reopened_at IS NOT NULL AS reopened FROM relay_thread_vm_backups WHERE operation_id=${frozen.backupOperationId}`;
                    return row?.reopened;
                  });
                  expect(yield* acknowledged).toBe(true);
                  // Older pause ACKs did not copy their timestamp to the linked backup.
                  yield* f.sql`UPDATE relay_thread_vm_backups SET source_reopened_at=NULL WHERE operation_id=${frozen.backupOperationId}`;
                  yield* recovery.confirmActivation({ ...f.owner, operationId: pause.operationId });
                  expect(yield* acknowledged).toBe(true);
                  yield* f.sql`UPDATE relay_thread_vm_backups SET source_reopened_at=NULL WHERE operation_id=${frozen.backupOperationId}`;
                  yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),idle_since=clock_timestamp()-interval '10 days' WHERE allocation_id=${f.input.allocationId}`;
                  expect(yield* pauses.reserveIdle(f.hostId)).toBe(f.input.allocationId);
                  expect((yield* recovery.get(f.owner))?.operationId).not.toBe(pause.operationId);
                  expect(yield* acknowledged).toBe(true);
                }
              }),
            ),
        );
      it.effect("a named native reply must resolve the same unique snapshot ID", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              id = yield* f.enqueue;
            yield* f.freeze(id);
            let posts = 0;
            const worker = makeThreadVmBackupWorker(
              f.sql,
              {
                inspect: () => Effect.succeed(f.info),
                snapshot: (_id, name) =>
                  Effect.sync(() => {
                    posts++;
                    return { snapshotId: "native-id", names: [name] };
                  }),
                findSnapshot: () => Effect.die("No reconciliation"),
                restore: {
                  resolveFailedNamedSnapshot: () => Effect.succeed(null),
                  resolveNamedSnapshot: (name) => {
                    expect(name).toBe(`launchpad-backup-${id}`);
                    return Effect.succeed({
                      sourceTemplateID: "different-native-id",
                      sourceBuildID: NodeCrypto.randomUUID(),
                    });
                  },
                },
              },
              f.hostId,
              false,
            );
            yield* worker.runOne();
            expect(posts).toBe(1);
            expect((yield* f.backup.get(id))?.phase).toBe("creating");
            expect((yield* f.backup.get(id))?.nativeCaptureReceipt).toBeNull();
            expect((yield* f.source.get(f.owner))?.canActivate).toBe(false);
          }),
        ),
      );
      for (const reply of ["raw-default", "foreign-alias", "foreign-tag"] as const)
        it.effect(`native snapshot ${reply} identity is checked before capture completion`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue;
              yield* f.freeze(id);
              const alias = `native-team/launchpad-backup-${id}`;
              const worker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed(f.info),
                  snapshot: () =>
                    Effect.succeed({
                      snapshotId:
                        reply === "raw-default"
                          ? "native-id:default"
                          : reply === "foreign-alias"
                            ? "native-team/another-capture:default"
                            : `${alias}:another-tag`,
                      names: [alias],
                    }),
                  findSnapshot: () => Effect.die("No reconciliation"),
                  restore: {
                    resolveFailedNamedSnapshot: () => Effect.succeed(null),
                    resolveNamedSnapshot: () =>
                      Effect.succeed({
                        sourceTemplateID: "native-id",
                        sourceBuildID: NodeCrypto.randomUUID(),
                      }),
                  },
                },
                f.hostId,
                false,
              );
              expect(yield* worker.runOne()).toBe(true);
              const saved = yield* f.backup.get(id);
              if (reply === "raw-default") {
                expect(saved?.phase).toBe("verified");
                expect(saved?.nativeCaptureReceipt?.snapshotId).toBe("native-id");
              } else {
                expect(saved?.phase).toBe("creating");
                expect(saved?.nativeCaptureReceipt).toBeNull();
                expect((yield* f.source.get(f.owner))?.canActivate).toBe(false);
              }
            }),
          ),
        );
      for (const kind of ["periodic", "pause", "final-save"] as const)
        it.effect(
          `a terminal native snapshot failure releases its ${kind} source without claiming a backup`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                let id: string, pauseOperationId: string | undefined;
                const pauses = makeThreadVmPauseStore(f.sql),
                  recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
                if (kind === "final-save") {
                  yield* f.store.begin(f.input);
                  yield* f.finalFreeze;
                  id = (yield* f.store.reserveBackup(f.input.operationId)).backupOperationId!;
                } else if (kind === "pause") {
                  yield* pauses.reserveIdle(f.hostId);
                  const pause = (yield* recovery.get(f.owner))!;
                  pauseOperationId = pause.operationId;
                  const point = yield* laterAttachmentCheckpoint(f, 1, pause.operationId);
                  yield* f.upload(point.attachments);
                  yield* f.attachmentStore.publish({
                    threadId: f.threadId,
                    operationId: point.attachments.header.operationId,
                    manifestArtifactId: point.attachments.artifactId,
                    nativeCheckpointOperationId: point.native.header.operationId,
                  });
                  id = (yield* recovery.sourceFrozen({
                    ...f.owner,
                    operationId: pause.operationId,
                    nativeCheckpointOperationId: point.native.header.operationId,
                    bootId: NodeCrypto.randomUUID(),
                    sealEpoch: 1,
                  })).backupOperationId!;
                } else {
                  id = yield* f.enqueue;
                  yield* f.freeze(id);
                }
                const claim = (yield* f.backup.claim(f.hostId))!;
                yield* f.backup.beginCapture(claim);
                yield* f.backup.defer(claim);
                yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp() WHERE operation_id=${id}`;
                const failedSnapshot = `failed-${id}`;
                const worker = makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: () => Effect.die("Read-only capture reconciliation"),
                    snapshot: () => Effect.die("Never repeat unknown POST"),
                    findSnapshot: () => Effect.succeed(null),
                    restore: {
                      resolveNamedSnapshot: () => Effect.die("No ready snapshot"),
                      resolveFailedNamedSnapshot: (name) => {
                        expect(name).toBe(claim.snapshotName);
                        return Effect.succeed({
                          snapshotId: failedSnapshot,
                          sourceTemplateID: failedSnapshot,
                          sourceBuildID: NodeCrypto.randomUUID(),
                        });
                      },
                    },
                  },
                  f.hostId,
                  false,
                );
                expect(yield* worker.runOne()).toBe(true);
                const failed = (yield* f.backup.get(id))!;
                expect(failed.phase).toBe("failed");
                expect(failed.nativeCaptureReceipt).toBeNull();
                expect(yield* f.pinPhase(id)).toBe("active");
                if (kind === "final-save") {
                  yield* makeThreadVmFinalSaveWorker(f.sql, f.objects, f.hostId).runOne();
                  expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
                  yield* makeThreadVmFinalSaveAbortWorker(
                    f.sql,
                    f.objects,
                    {
                      findSnapshot: () => Effect.die("Known failed identity"),
                      deleteSnapshot: (snapshotId) => {
                        expect(snapshotId).toBe(failedSnapshot);
                        return Effect.succeed(true);
                      },
                    },
                    f.hostId,
                  ).runOne();
                  expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborted");
                  expect(yield* f.pinPhase(id)).toBe("released");
                } else {
                  if (kind === "periodic") {
                    expect((yield* f.source.get(f.owner))?.canActivate).toBe(true);
                    yield* f.source.confirmActivation({ ...f.owner, operationId: id });
                    expect(yield* f.pinPhase(id)).toBe("active");
                  } else {
                    const cancelled = (yield* recovery.get(f.owner))!;
                    expect(cancelled.phase).toBe("cancelled");
                    expect(cancelled.canActivate).toBe(true);
                    expect(yield* pauses.claim(f.hostId)).toBeNull();
                    // A native timeout may have paused the VM while the failed capture settled.
                    expect(
                      yield* makeThreadVmResumeStore(f.sql).reconcileNativePause({
                        allocationId: f.input.allocationId,
                        computeRef: f.computeRef,
                        threadId: f.threadId,
                        generation: 1,
                        operationId: f.input.allocationId,
                        capacityOperationId: f.input.allocationId,
                        hostId: f.hostId,
                      }),
                    ).toBe(true);
                    expect((yield* recovery.get(f.owner))?.canActivate).toBe(false);
                    yield* makeThreadVmResumeStore(f.sql).request(f.threadId);
                    yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
                    expect(
                      (yield* makeThreadVmResumeStore(f.sql).claim(f.hostId))?.pauseOperationId,
                    ).toBe(pauseOperationId);
                  }
                  yield* makeThreadVmBackupRetentionWorker(
                    f.sql,
                    {
                      deleteSnapshot: (snapshotId) => {
                        expect(snapshotId).toBe(failedSnapshot);
                        return Effect.succeed(true);
                      },
                    },
                    f.hostId,
                  ).runOne();
                  expect((yield* f.backup.get(id))?.phase).toBe("retired");
                  expect(yield* f.pinPhase(id)).toBe("released");
                }
              }),
            ),
        );
      it.effect(
        "permanent deletion wins before POST while a dispatched snapshot keeps cleanup blocked",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                id = yield* f.enqueue;
              yield* f.freeze(id);
              const claim = (yield* f.backup.claim(f.hostId))!;
              const deletion = makeThreadDeletionStore(f.sql);
              yield* deletion.begin({
                threadId: f.threadId,
                operationId: NodeCrypto.randomUUID(),
                ownerUserId: f.input.actorUserId,
                generation: 1,
                hostId: f.hostId,
              });
              expect(yield* f.backup.beginCapture(claim)).toBe(false);
              expect((yield* f.backup.get(id))?.phase).toBe("retired");
            }),
          ),
      );
    });
  },
);
