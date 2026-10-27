import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import { ThreadId, ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { laterAttachmentCheckpoint } from "../threads/testUtils/attachmentCheckpointCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import { makeThreadVmPauseRecoveryStore } from "../threads/ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmPauseStore } from "../threads/ThreadVmPauseStore.ts";
import { makeThreadVmPauseWorker } from "../threads/ThreadVmPauseWorker.ts";
import { makeThreadVmResumeStore } from "../threads/ThreadVmResumeStore.ts";
import { makeThreadVmResumeWorker } from "../threads/ThreadVmResumeWorker.ts";
import { makeThreadVmActivityWorker } from "../threads/ThreadVmActivityWorker.ts";
import { makeThreadVmActivityStore } from "../threads/ThreadVmActivityStore.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import {
  getThreadVmPause,
  cancelThreadVmPause,
  freezeThreadVmPause,
  confirmThreadVmPauseActivation,
} from "./ThreadEnvironmentApi.ts";

const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(nativeCheckpointCatalogTestLayer),
);
const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  const pauses = makeThreadVmPauseStore(f.sql),
    recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
  yield* pauses.reserveIdle(f.hostId);
  const pause = (yield* recovery.get(f.owner))!,
    bootId = NodeCrypto.randomUUID();
  const publish = Effect.gen(function* () {
    const point = yield* laterAttachmentCheckpoint(f, 1, pause.operationId);
    yield* f.upload(point.attachments);
    yield* f.attachmentStore.publish({
      threadId: f.threadId,
      operationId: point.attachments.header.operationId,
      manifestArtifactId: point.attachments.artifactId,
      nativeCheckpointOperationId: point.native.header.operationId,
    });
    return point;
  });
  return { ...f, pauses, recovery, pause, bootId, publish };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "certified VM pause (Postgres)",
  () => {
    layer(services)((it) => {
      it.effect(
        "holds the idle timestamp during pause and recovers it from a certified paused source",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                activity = makeThreadVmActivityStore(f.sql);
              const [before] =
                yield* f.sql`SELECT idle_since FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`;
              expect(
                yield* activity.beginInspection(f.input.allocationId).pipe(Effect.isFailure),
              ).toBe(true);
              const [held] =
                yield* f.sql`SELECT idle_since FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`;
              expect(held).toEqual(before);
              const point = yield* f.publish;
              yield* f.recovery.sourceFrozen({
                ...f.owner,
                operationId: f.pause.operationId,
                nativeCheckpointOperationId: point.native.header.operationId,
                bootId: f.bootId,
              });
              const claim = (yield* f.pauses.claim(f.hostId))!;
              yield* f.pauses.markSealed(claim, f.bootId);
              expect(yield* f.pauses.finish(claim)).toBe(true);
              yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=NULL,activity='unknown' WHERE allocation_id=${f.input.allocationId}`;
              let inspected = false;
              const worker = makeThreadVmActivityWorker(
                f.sql,
                () => {
                  inspected = true;
                  return Effect.succeed("unknown");
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(inspected).toBe(false);
              const [recovered] =
                yield* f.sql`SELECT v.idle_since=x.source_frozen_at AS recovered,v.activity
            FROM relay_thread_vm_activity v JOIN relay_thread_vm_pauses x USING(allocation_id) WHERE v.allocation_id=${f.input.allocationId}`;
              expect(recovered).toEqual({ recovered: true, activity: "unknown" });
              // Recovery does not run against a source that has already reopened.
              yield* f.sql`UPDATE relay_thread_vm_pauses SET source_reopened_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=NULL WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* worker.runOne()).toBe(false);
            }),
          ),
      );
      for (const phase of ["uncertified", "certified", "sealed"] as const) {
        it.effect(`queues a new Send during ${phase} pause and waits for reopened execution`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                journal = makeThreadJournalStore(f.sql);
              if (phase !== "uncertified") {
                const point = yield* f.publish;
                yield* f.recovery.sourceFrozen({
                  ...f.owner,
                  operationId: f.pause.operationId,
                  bootId: f.bootId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                });
              }
              const claim = phase === "sealed" ? (yield* f.pauses.claim(f.hostId))! : null;
              if (claim) yield* f.pauses.markSealed(claim, f.bootId);
              const command = yield* decodeCommand({
                commandId: NodeCrypto.randomUUID(),
                threadId: f.threadId,
                createdAt: "2026-10-07T00:00:00Z",
                type: "thread.prompt.enqueue",
                message: { messageId: NodeCrypto.randomUUID(), text: "new work", attachments: [] },
                runtimeMode: "full-access",
                interactionMode: "default",
              });
              if (!("threadId" in command)) return yield* Effect.die("Expected thread command");
              const staged = yield* journal.stage({
                threadId: f.threadId,
                command,
                actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
              });
              expect(staged?.receipt).toBeNull();
              expect(yield* journal.next(f.owner)).toBeNull();
              expect(
                yield* journal.stage({
                  threadId: f.threadId,
                  command,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                }),
              ).toEqual(staged);
              const pause = (yield* f.recovery.get(f.owner))!;
              expect(
                (yield* Effect.result(
                  makeThreadPlacementStore(f.sql).admit({
                    ...f.owner,
                    workId: "direct-before-reopen",
                  }),
                ))._tag,
              ).toBe("Failure");
              if (phase === "uncertified") {
                expect(pause).toMatchObject({
                  phase: "cancelled",
                  canActivate: true,
                  sourceReopened: false,
                });
                expect(yield* f.pauses.claim(f.hostId)).toBeNull();
                yield* f.recovery.confirmActivation({
                  ...f.owner,
                  operationId: f.pause.operationId,
                });
                expect((yield* journal.next(f.owner))?.commandId).toBe(command.commandId);
              } else {
                expect(pause.phase).toBe(phase === "sealed" ? "sealed" : "pending");
                const claimed = claim ?? (yield* f.pauses.claim(f.hostId))!;
                yield* f.pauses.markSealed(claimed, f.bootId);
                expect(yield* f.pauses.finish(claimed)).toBe(true);
                expect(
                  (yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId))?.phase,
                ).toBe("waiting");
                expect(yield* journal.next(f.owner)).toBeNull();
                let state: "paused" | "running" = "paused";
                yield* makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state }),
                    resume: () =>
                      Effect.sync(() => {
                        state = "running";
                      }),
                  },
                  { reopenAfterResume: () => Effect.void },
                  f.hostId,
                ).runOne();
                expect(yield* journal.next(f.owner)).toBeNull();
                expect(
                  (yield* Effect.result(
                    makeThreadPlacementStore(f.sql).admit({
                      ...f.owner,
                      workId: "direct-powered-before-reopen",
                    }),
                  ))._tag,
                ).toBe("Failure");
                yield* f.recovery.confirmActivation({
                  ...f.owner,
                  operationId: f.pause.operationId,
                });
                expect((yield* journal.next(f.owner))?.commandId).toBe(command.commandId);
              }
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_commands WHERE thread_id=${f.threadId}`,
              ).toHaveLength(1);
            }),
          ),
        );
      }
      for (const hold of [
        "archive",
        "pause",
        "resume-then-pause",
        "retry-then-pause",
        "retry-after-pause",
        "unarchive",
      ] as const) {
        it.effect(`honors deferred Send and control order with ${hold}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                journal = makeThreadJournalStore(f.sql),
                point = yield* f.publish;
              yield* f.recovery.sourceFrozen({
                ...f.owner,
                operationId: f.pause.operationId,
                bootId: f.bootId,
                nativeCheckpointOperationId: point.native.header.operationId,
              });
              const stage = Effect.fnUntraced(function* (data: object) {
                const command = yield* decodeCommand({
                  commandId: NodeCrypto.randomUUID(),
                  threadId: f.threadId,
                  createdAt: "2026-10-07T00:00:00Z",
                  ...data,
                });
                if (!("threadId" in command)) return yield* Effect.die("Expected thread command");
                yield* journal.stage({
                  threadId: f.threadId,
                  command,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                });
              });
              yield* stage({
                type: "thread.prompt.enqueue",
                message: { messageId: NodeCrypto.randomUUID(), text: "new work", attachments: [] },
                runtimeMode: "full-access",
                interactionMode: "default",
              });
              if (hold === "archive" || hold === "unarchive")
                yield* stage({ type: "thread.archive" });
              if (hold === "unarchive") yield* stage({ type: "thread.unarchive" });
              if (hold === "resume-then-pause")
                yield* stage({ type: "thread.queue.resume", expectedRevision: 0 });
              if (hold === "retry-then-pause")
                yield* stage({
                  type: "thread.preparation.retry",
                  expectedRevision: 0,
                  expectedControlRevision: 0,
                });
              if (
                ["pause", "resume-then-pause", "retry-then-pause", "retry-after-pause"].includes(
                  hold,
                )
              )
                yield* stage({ type: "thread.queue.pause" });
              if (hold === "retry-after-pause")
                yield* stage({
                  type: "thread.preparation.retry",
                  expectedRevision: 0,
                  expectedControlRevision: 0,
                });
              const claim = (yield* f.pauses.claim(f.hostId))!;
              yield* f.pauses.markSealed(claim, f.bootId);
              expect(yield* f.pauses.finish(claim)).toBe(true);
              const wake = yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId);
              if (hold === "retry-after-pause") expect(wake?.phase).toBe("waiting");
              else expect(wake).toBeNull();
              expect(yield* journal.next(f.owner)).toBeNull();
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
            }),
          ),
        );
      }
      it.effect("retains the cancelled pause identity until the source has reopened", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const provide = Effect.provideService(RelayEnvironmentPrincipal, {
              environmentId: f.sourceEnvironmentId,
              environmentPublicKey: "test-key",
              credentialId: f.credentialId,
              threadVm: {
                allocationId: f.input.allocationId,
                threadId: ThreadId.make(f.threadId),
                repositoryId: "repo",
                generation: 1,
              },
            });
            const input = { ...f.owner, operationId: f.pause.operationId };
            const receipt = yield* cancelThreadVmPause(input).pipe(
              provide,
              Effect.provideService(ThreadArtifactObjectStorage, f.objects),
            );
            expect(receipt).toMatchObject({
              phase: "cancelled",
              canActivate: true,
              sourceReopened: false,
            });
            expect(yield* f.recovery.cancelBeforeFreeze(input)).toMatchObject(receipt);
            expect(yield* f.pauses.claim(f.hostId)).toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            const [capacity] = yield* f.sql<{
              state: string;
            }>`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.input.allocationId}`;
            expect(capacity?.state).toBe("started");
            yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),idle_since=clock_timestamp()-interval '31 minutes' WHERE allocation_id=${f.input.allocationId}`;
            expect(yield* f.pauses.reserveIdle(f.hostId)).toBeNull();
            expect((yield* f.recovery.get(f.owner))?.operationId).toBe(input.operationId);
            yield* f.recovery.confirmActivation(input);
            yield* f.pauses.reserveIdle(f.hostId);
            expect((yield* f.recovery.get(f.owner))?.operationId).not.toBe(input.operationId);
          }),
        ),
      );
      for (const winner of ["cancel", "freeze", "race"] as const) {
        it.effect(`serializes source cancellation against certification (${winner})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                point = yield* f.publish;
              const input = { ...f.owner, operationId: f.pause.operationId };
              const cancel = f.recovery.cancelBeforeFreeze(input),
                freeze = f.recovery.sourceFrozen({
                  ...input,
                  bootId: f.bootId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                });
              if (winner === "cancel") yield* cancel;
              if (winner === "freeze") yield* freeze;
              const [cancelled, certified] = yield* Effect.all(
                [Effect.result(cancel), Effect.result(freeze)],
                { concurrency: "unbounded" },
              );
              expect(
                [cancelled, certified].filter((result) => result._tag === "Success"),
              ).toHaveLength(1);
              const current = (yield* f.recovery.get(f.owner))!;
              if (current.phase === "cancelled") {
                expect(current.nativeCheckpointOperationId).toBeNull();
                expect(yield* f.pauses.claim(f.hostId)).toBeNull();
              } else {
                expect(current.nativeCheckpointOperationId).toBe(point.native.header.operationId);
                expect(yield* f.pauses.claim(f.hostId)).not.toBeNull();
              }
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
        );
      }
      for (const problem of [
        "missing-chat",
        "wrong-capture",
        "unfinished-work",
        "wrong-operation",
        "none",
      ] as const) {
        it.effect(`requires independently retained source recovery (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              expect(yield* f.pauses.claim(f.hostId)).toBeNull();
              let checkpoint = f.native.header.operationId;
              if (problem !== "wrong-capture") {
                const point = yield* laterAttachmentCheckpoint(f, 1, f.pause.operationId);
                checkpoint = point.native.header.operationId;
                if (problem !== "missing-chat") {
                  yield* f.upload(point.attachments);
                  yield* f.attachmentStore.publish({
                    threadId: f.threadId,
                    operationId: point.attachments.header.operationId,
                    manifestArtifactId: point.attachments.artifactId,
                    nativeCheckpointOperationId: checkpoint,
                  });
                }
              }
              if (problem === "unfinished-work")
                yield* f.sql`INSERT INTO relay_thread_execution_admissions(thread_id,work_id,environment_id,generation,completed) VALUES(${f.threadId},'late',${f.sourceEnvironmentId},1,false)`;
              const input = {
                ...f.owner,
                operationId:
                  problem === "wrong-operation" ? NodeCrypto.randomUUID() : f.pause.operationId,
                nativeCheckpointOperationId: checkpoint,
                bootId: f.bootId,
              };
              const result = yield* Effect.result(f.recovery.sourceFrozen(input));
              if (problem !== "none") {
                expect(result._tag).toBe("Failure");
                expect(yield* f.pauses.claim(f.hostId)).toBeNull();
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
                return;
              }
              expect(result._tag).toBe("Success");
              if (result._tag !== "Success")
                return yield* Effect.die("Missing successful certificate");
              expect(yield* f.recovery.sourceFrozen(input)).toEqual(result.success);
              expect(
                (yield* Effect.result(
                  f.recovery.sourceFrozen({ ...input, bootId: NodeCrypto.randomUUID() }),
                ))._tag,
              ).toBe("Failure");
              expect(
                (yield* Effect.result(
                  f.journal.confirmThrough({
                    ...f.owner,
                    sourceSequence: result.success!.sourceSequence! + 1,
                  }),
                ))._tag,
              ).toBe("Failure");
              const claim = (yield* f.pauses.claim(f.hostId))!;
              expect(yield* f.pauses.markSealed(claim, NodeCrypto.randomUUID())).toBe(false);
              expect(yield* f.pauses.markSealed(claim, f.bootId)).toBe(true);
            }),
          ),
        );
      }
      for (const problem of ["lost-reply", "new-boot"] as const) {
        it.effect(`retains recovery across physical pause (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                point = yield* f.publish;
              yield* f.recovery.sourceFrozen({
                ...f.owner,
                operationId: f.pause.operationId,
                nativeCheckpointOperationId: point.native.header.operationId,
                bootId: f.bootId,
              });
              let state: "running" | "paused" = "running",
                pauses = 0;
              const worker = makeThreadVmPauseWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed({ ...f.info, state }),
                  pause: () =>
                    Effect.gen(function* () {
                      pauses++;
                      state = "paused";
                      return yield* new ThreadVmComputeError({
                        operation: "pause",
                        message: "Lost reply",
                      });
                    }),
                },
                {
                  seal: () =>
                    Effect.succeed({
                      bootId: problem === "new-boot" ? NodeCrypto.randomUUID() : f.bootId,
                      idle: true,
                    }),
                  reopen: () => Effect.die("Unexpected reopen"),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(pauses).toBe(problem === "new-boot" ? 0 : 1);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              yield* f.sql`UPDATE relay_thread_vm_pauses SET retry_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              yield* worker.runOne();
              if (problem === "new-boot") return;
              expect(pauses).toBe(1);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
              const saved = yield* f.store.begin(f.input);
              expect(saved.phase).toBe("frozen");
              expect(saved.nativeCheckpointOperationId).toBe(point.native.header.operationId);
              expect(
                yield* f.storeNative.getForOperation({
                  threadId: f.threadId,
                  operationId: f.input.operationId,
                }),
              ).toMatchObject({ operationId: point.native.header.operationId });
              expect((yield* f.recovery.get(f.owner))?.canActivate).toBe(false);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
              yield* f.verifyBackup;
              expect((yield* f.store.recordSaved(f.input.operationId)).phase).toBe("deleting");
              const deletion = (yield* f.store.claimDeletion(f.hostId))!;
              yield* f.store.beginDeletion(deletion);
              yield* f.store.confirmDeleted(deletion);
              const retained = yield* f.sql`SELECT 1 FROM relay_thread_native_checkpoint_operations
                WHERE operation_id IN (${f.pause.operationId},${f.input.operationId}) AND phase='active'`;
              expect(retained).toHaveLength(0);
              expect((yield* f.storeNative.latestComplete(f.threadId))?.operationId).toBe(
                point.native.header.operationId,
              );
            }),
          ),
        );
      }
      it.effect("cancels a paused final save without losing its next recovery attempt", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture("paused"),
              recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
            const before = (yield* recovery.get(f.owner))!;
            const first = yield* f.store.begin(f.input);
            expect(first.phase).toBe("frozen");
            yield* f.store.requestAbort(f.input.operationId);
            yield* f.store.confirmAborted(f.input.operationId);
            const [pin] = yield* f.sql<{
              phase: string;
            }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${before.operationId}`;
            expect(pin?.phase).toBe("active");
            const second = yield* f.store.begin({
              ...f.input,
              operationId: NodeCrypto.randomUUID(),
            });
            expect(second.phase).toBe("frozen");
            expect(second.nativeCheckpointOperationId).toBe(first.nativeCheckpointOperationId);
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
            expect(
              yield* f.sql`SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=${f.input.allocationId}`,
            ).toHaveLength(0);
          }),
        ),
      );
      it.effect("does not adopt an old uncertified pause for deletion", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture();
            yield* f.allocations.recordPowerState({
              allocationId: f.input.allocationId,
              computeRef: f.computeRef,
              state: "paused",
              capacityOperationId: f.input.allocationId,
            });
            yield* f.sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase,boot_id)
              VALUES(${f.input.allocationId},${NodeCrypto.randomUUID()},1,'completed',${NodeCrypto.randomUUID()})`;
            expect((yield* Effect.result(f.store.begin(f.input)))._tag).toBe("Failure");
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("paused");
          }),
        ),
      );
      it.effect("releases the local fence only after explicit wake is confirmed", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              point = yield* f.publish;
            yield* f.recovery.sourceFrozen({
              ...f.owner,
              operationId: f.pause.operationId,
              nativeCheckpointOperationId: point.native.header.operationId,
              bootId: f.bootId,
            });
            const claim = (yield* f.pauses.claim(f.hostId))!;
            yield* f.pauses.markSealed(claim, f.bootId);
            yield* f.pauses.finish(claim);
            expect((yield* f.recovery.get(f.owner))?.canActivate).toBe(false);
            const resume = makeThreadVmResumeStore(f.sql);
            yield* resume.request(f.threadId);
            expect((yield* f.recovery.get(f.owner))?.canActivate).toBe(false);
            let state: "paused" | "running" = "paused";
            const worker = makeThreadVmResumeWorker(
              f.sql,
              {
                inspect: () => Effect.succeed({ ...f.info, state }),
                resume: () =>
                  Effect.sync(() => {
                    state = "running";
                  }),
              },
              { reopenAfterResume: () => Effect.void },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.recovery.get(f.owner))?.canActivate).toBe(true);
            const [held] = yield* f.sql<{
              phase: string;
            }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${f.pause.operationId}`;
            expect(held?.phase).toBe("active");
            yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),idle_since=clock_timestamp()-interval '31 minutes' WHERE allocation_id=${f.input.allocationId}`;
            expect(yield* f.pauses.reserveIdle(f.hostId)).toBeNull();
            expect(
              (yield* f.recovery.confirmActivation({
                ...f.owner,
                operationId: f.pause.operationId,
              })).sourceReopened,
            ).toBe(true);
            const [pin] = yield* f.sql<{
              phase: string;
            }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${f.pause.operationId}`;
            expect(pin?.phase).toBe("released");
            expect((yield* f.recovery.get(f.owner))?.canActivate).toBe(true);
            yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),idle_since=clock_timestamp()-interval '31 minutes' WHERE allocation_id=${f.input.allocationId}`;
            yield* f.pauses.reserveIdle(f.hostId);
            const next = (yield* f.recovery.get(f.owner))!;
            expect(next.operationId).not.toBe(f.pause.operationId);
            expect(next.nativeCheckpointOperationId).toBeNull();
            expect(next.canActivate).toBe(false);
            expect(yield* f.pauses.claim(f.hostId)).toBeNull();
          }),
        ),
      );
      for (const problem of [
        "foreign-allocation",
        "foreign-thread",
        "stale-generation",
        "revoked-credential",
        "ordinary-environment",
        "none",
      ] as const) {
        it.effect(`restricts source pause receipts to this allocation (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                point = yield* f.publish;
              const principal = {
                environmentId: f.sourceEnvironmentId,
                environmentPublicKey: "test-key",
                credentialId: f.credentialId,
                ...(problem === "ordinary-environment"
                  ? {}
                  : {
                      threadVm: {
                        allocationId:
                          problem === "foreign-allocation"
                            ? NodeCrypto.randomUUID()
                            : f.input.allocationId,
                        threadId: ThreadId.make(f.threadId),
                        repositoryId: "repo",
                        generation: 1,
                      },
                    }),
              };
              if (problem === "revoked-credential")
                yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.credentialId}`;
              const owner = {
                ...f.owner,
                threadId: problem === "foreign-thread" ? NodeCrypto.randomUUID() : f.threadId,
                generation: problem === "stale-generation" ? 2 : 1,
              };
              const provide = Effect.provideService(RelayEnvironmentPrincipal, principal),
                objects = Effect.provideService(ThreadArtifactObjectStorage, f.objects);
              const read = yield* Effect.result(getThreadVmPause(owner).pipe(provide, objects));
              if (problem !== "none") {
                const cancellation = yield* Effect.result(
                  cancelThreadVmPause({ ...owner, operationId: f.pause.operationId }).pipe(
                    provide,
                    objects,
                  ),
                );
                expect(cancellation._tag).toBe("Failure");
                expect((yield* f.recovery.get(f.owner))?.phase).toBe("pending");
              }
              const frozen = yield* Effect.result(
                freezeThreadVmPause({
                  ...owner,
                  operationId: f.pause.operationId,
                  bootId: f.bootId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                }).pipe(provide, objects),
              );
              expect(read._tag).toBe(problem === "none" ? "Success" : "Failure");
              expect(frozen._tag).toBe(problem === "none" ? "Success" : "Failure");
              const activation = yield* Effect.result(
                confirmThreadVmPauseActivation({ ...owner, operationId: f.pause.operationId }).pipe(
                  provide,
                  objects,
                ),
              );
              // Even the valid credential cannot acknowledge activation before an explicit wake wins.
              expect(activation._tag).toBe("Failure");
              expect((yield* f.recovery.get(f.owner))?.nativeCheckpointOperationId).toBe(
                problem === "none" ? point.native.header.operationId : null,
              );
            }),
          ),
        );
      }
    });
  },
);
