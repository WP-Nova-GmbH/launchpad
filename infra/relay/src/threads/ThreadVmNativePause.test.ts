import * as NodeCrypto from "node:crypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { nativeRestoreSecretBoxTestLayer } from "./testUtils/nativeRestoreCatalog.ts";
import { confirmThreadVmCleanupIdentity } from "./ThreadVmCleanupIdentity.ts";
import {
  readThreadVmTrafficAccessToken,
  sealThreadVmTrafficAccessToken,
} from "./ThreadVmIngressToken.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { threadVmPresentation } from "@t3tools/client-runtime/relay/threadVmControls";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmResumeWorker } from "./ThreadVmResumeWorker.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmPauseRecoveryStore } from "./ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmBackupSourceStore } from "./ThreadVmBackupSourceStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { listPortableThreads } from "../http/ThreadHistoryApi.ts";
import { finalSaveCatalogFixture as baseFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { laterAttachmentCheckpoint } from "./testUtils/attachmentCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* (state: "running" | "paused" = "running") {
  const f = yield* baseFixture(state);
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${f.input.actorUserId},'admin','now','now') ON CONFLICT DO NOTHING`;
  return {
    ...f,
    info: {
      ...f.info,
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: "pause" as const, autoResume: false },
    },
  };
});
const unavailable = () =>
  new ThreadVmComputeError({ operation: "inspect", message: "Unconfirmed native state" });
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const portableVmState = Effect.fnUntraced(function* (f: Fixture) {
  const db = yield* PgDrizzle.makeWithDefaults();
  const page = yield* listPortableThreads({ limit: 100 }).pipe(
    Effect.provideService(RelayDb, db),
    Effect.provideService(RelayClientPrincipal, {
      userId: f.input.actorUserId,
      token: "fixture",
    }),
  );
  return page.entries.find((entry) => entry.placement.threadId === f.threadId)?.vm?.state;
});
const inspectPaused = (f: Fixture) => Effect.succeed({ ...f.info, state: "paused" as const });
const worker = (f: Fixture, inspect: typeof inspectPaused) =>
  makeThreadVmLeaseWorker(f.sql, () => Effect.fail(unavailable()), f.hostId, {
    inspect: () => inspect(f),
  });
const state = Effect.fnUntraced(function* (f: Fixture) {
  const [row] = yield* f.sql`SELECT state,native_paused_generation FROM relay_thread_vm_allocations
    WHERE allocation_id=${f.input.allocationId}`;
  return row;
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "native VM timeout reconciliation (Postgres)",
  () => {
    layer(Layer.mergeAll(nativeCheckpointCatalogTestLayer, nativeRestoreSecretBoxTestLayer))(
      (it) => {
        for (const phase of [
          "unpublished",
          "frozen",
          "cancelled",
          "creating",
          "verified",
        ] as const) {
          it.effect(`native timeout respects the ${phase} periodic backup source`, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  source = makeThreadVmBackupSourceStore(f.sql, f.objects),
                  id = (yield* f.backup.enqueueDue(f.hostId))!,
                  journal = makeThreadJournalStore(f.sql);
                if (phase !== "unpublished") {
                  const point = yield* laterAttachmentCheckpoint(f, 1, id);
                  yield* f.upload(point.attachments);
                  yield* f.attachmentStore.publish({
                    threadId: f.threadId,
                    operationId: point.attachments.header.operationId,
                    manifestArtifactId: point.attachments.artifactId,
                    nativeCheckpointOperationId: point.native.header.operationId,
                  });
                  yield* source.sourceFrozen({
                    ...f.owner,
                    operationId: id,
                    nativeCheckpointOperationId: point.native.header.operationId,
                    bootId: NodeCrypto.randomUUID(),
                    sealEpoch: 1,
                  });
                }
                if (phase === "creating" || phase === "verified") {
                  const claim = (yield* f.backup.claim(f.hostId))!;
                  yield* f.backup.beginCapture(claim);
                  if (phase === "verified")
                    yield* f.backup.recordCapture(claim, {
                      snapshotId: `snapshot-${id}`,
                      sourceTemplateId: `snapshot-${id}`,
                      sourceBuildId: NodeCrypto.randomUUID(),
                    });
                }
                const unissuedClaim = phase === "frozen" ? yield* f.backup.claim(f.hostId) : null;
                const queue = journal.stage({
                  threadId: f.threadId,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                  command: {
                    type: "thread.queue.pause",
                    commandId: CommandId.make(NodeCrypto.randomUUID()),
                    threadId: ThreadId.make(f.threadId),
                    createdAt: "2026-10-29T10:00:00Z",
                  },
                });
                let queued = phase === "cancelled" ? yield* queue : null;
                expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
                if (phase === "creating") {
                  expect(yield* state(f)).toMatchObject({
                    state: "running",
                    native_paused_generation: null,
                  });
                  expect((yield* f.backup.get(id))?.phase).toBe("creating");
                  expect(
                    yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId),
                  ).toBeNull();
                  return;
                }
                expect(yield* state(f)).toMatchObject({
                  state: "paused",
                  native_paused_generation: 1,
                });
                expect((yield* f.backup.get(id))?.phase).toBe(
                  phase === "verified" ? "verified" : "failed",
                );
                if (unissuedClaim) expect(yield* f.backup.beginCapture(unissuedClaim)).toBe(false);
                const resumes = makeThreadVmResumeStore(f.sql);
                expect(yield* resumes.get(f.input.allocationId)).toBeNull();
                const pausedStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                expect(pausedStatus.sourceActivationPending).toBe(true);
                expect(threadVmPresentation({ status: pausedStatus })).toMatchObject({
                  ready: false,
                  canPreview: false,
                  primary: { type: "resume" },
                });
                if (phase === "frozen") expect(yield* portableVmState(f)).toBe("paused");
                if (!queued) queued = yield* queue;
                expect(yield* journal.next(f.owner)).toBeNull();
                yield* resumes.request(f.threadId);
                let nativeState: "paused" | "running" = "paused";
                const resume = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                    recoverIngress: () =>
                      Effect.sync(() => {
                        nativeState = "running";
                        return {
                          sandboxId: f.computeRef,
                          trafficAccessToken: Redacted.make("resumed-periodic-token"),
                        };
                      }),
                  },
                  {
                    reopenAfterResume: (_sandbox, _identity, sealOperationId) =>
                      Effect.sync(() => {
                        expect(sealOperationId).toBe(id);
                      }),
                  },
                  f.hostId,
                );
                expect(yield* resume.runOne()).toBe(true);
                expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
                expect((yield* source.get(f.owner))?.canActivate).toBe(true);
                expect(yield* journal.next(f.owner)).toBeNull();
                const waitingStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                expect(waitingStatus.sourceActivationPending).toBe(true);
                expect(threadVmPresentation({ status: waitingStatus })).toMatchObject({
                  held: true,
                  ready: false,
                  canPreview: false,
                  primary: null,
                });
                if (phase === "frozen") expect(yield* portableVmState(f)).toBe("preparing");
                yield* source.confirmActivation({ ...f.owner, operationId: id });
                expect((yield* journal.next(f.owner))?.commandId).toBe(queued!.commandId);
                const activeStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                expect(activeStatus.sourceActivationPending).toBe(false);
                expect(threadVmPresentation({ status: activeStatus })).toMatchObject({
                  held: false,
                  ready: true,
                  canPreview: true,
                });
                if (phase === "frozen") expect(yield* portableVmState(f)).toBe("running");
                if (phase !== "unpublished") {
                  expect((yield* f.backup.get(id))?.phase).toBe(
                    phase === "verified" ? "verified" : "retired",
                  );
                  const [pin] =
                    yield* f.sql`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${id}`;
                  expect(pin?.phase).toBe(phase === "verified" ? "active" : "released");
                }
              }),
            ),
          );
        }
        it.effect("an acknowledged newest backup cannot hide an older source hold", () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const source = makeThreadVmBackupSourceStore(f.sql, f.objects);
              const older = (yield* f.backup.enqueueDue(f.hostId))!;
              yield* source.cancelPending({ ...f.owner, operationId: older });
              const newer = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_vm_backups
                (operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,source_reopened_at,created_at)
                SELECT ${newer},allocation_id,generation,compute_ref,${`launchpad-backup-${newer}`},'failed',clock_timestamp(),
                  created_at+interval '1 second' FROM relay_thread_vm_backups WHERE operation_id=${older}`;
              expect(yield* source.get(f.owner)).toMatchObject({
                operationId: newer,
                sourceReopened: true,
              });
              yield* f.journal.stage({
                threadId: f.threadId,
                actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                command: {
                  type: "thread.queue.pause",
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  threadId: ThreadId.make(f.threadId),
                  createdAt: "2026-10-29T10:00:00Z",
                },
              });
              const status = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
              expect(status.sourceActivationPending).toBe(true);
              expect(threadVmPresentation({ status })).toMatchObject({
                held: true,
                ready: false,
                canPreview: false,
              });
              expect(yield* f.journal.next(f.owner)).toBeNull();
            }),
          ),
        );
        for (const wake of ["explicit", "queued-before", "queued-after"] as const) {
          it.effect(
            `native-paused final-save cancellation retains its seal until ${wake} wake acknowledges activation`,
            () =>
              Effect.scoped(
                Effect.gen(function* () {
                  const f = yield* fixture();
                  yield* f.store.begin(f.input);
                  yield* f.freeze;
                  yield* f.store.requestAbort(f.input.operationId);
                  yield* f.store.confirmAborted(f.input.operationId);
                  const resumes = makeThreadVmResumeStore(f.sql);
                  const queueWake = makeThreadJournalStore(f.sql).stage({
                    threadId: f.threadId,
                    actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                    command: {
                      type: "thread.queue.resume",
                      threadId: ThreadId.make(f.threadId),
                      commandId: CommandId.make(NodeCrypto.randomUUID()),
                      expectedRevision: 0,
                      createdAt: "2026-10-29T10:00:00Z",
                    },
                  });
                  if (wake === "queued-before") yield* queueWake;
                  expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
                  expect(yield* state(f)).toMatchObject({
                    state: "paused",
                    native_paused_generation: 1,
                  });
                  expect((yield* f.store.get(f.input.operationId))?.sourceActivationPending).toBe(
                    true,
                  );
                  if (wake !== "queued-before") {
                    expect(yield* resumes.get(f.input.allocationId)).toBeNull();
                    const status = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                    expect(status.finalSave).toBeNull();
                    expect(threadVmPresentation({ status }).primary).toMatchObject({
                      type: "resume",
                    });
                    if (wake === "explicit") yield* resumes.request(f.threadId);
                    else yield* queueWake;
                  }
                  expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("waiting");
                  let nativeState: "paused" | "running" = "paused";
                  let wakes = 0;
                  const resume = makeThreadVmResumeWorker(
                    f.sql,
                    {
                      inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                      recoverIngress: () =>
                        Effect.sync(() => {
                          wakes++;
                          nativeState = "running";
                          return {
                            sandboxId: f.computeRef,
                            trafficAccessToken: Redacted.make("final-save-resume-token"),
                          };
                        }),
                    },
                    {
                      reopenAfterResume: (_sandbox, _identity, sourceOperationId) =>
                        Effect.gen(function* () {
                          expect(sourceOperationId).toBe(f.input.operationId);
                          expect(yield* f.journal.next(f.owner)).toBeNull();
                          // The guest can acknowledge its active fence before the
                          // resume worker commits completion; that exact claim survives.
                          yield* f.store.confirmActivation({
                            ...f.owner,
                            operationId: f.input.operationId,
                          });
                        }).pipe(Effect.orDie),
                    },
                    f.hostId,
                  );
                  expect(yield* resume.runOne()).toBe(true);
                  expect(wakes).toBe(1);
                  expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
                  expect((yield* f.store.get(f.input.operationId))?.sourceActivationPending).toBe(
                    false,
                  );
                  expect(yield* state(f)).toMatchObject({
                    state: "running",
                    native_paused_generation: null,
                  });
                  if (wake !== "explicit") expect(yield* f.journal.next(f.owner)).not.toBeNull();
                }),
              ),
          );
        }
        it.effect(
          "releases exact power capacity and resumes the same allocation without a fake pause",
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const journal = makeThreadJournalStore(f.sql);
                const queued = yield* journal.stage({
                  threadId: f.threadId,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                  command: {
                    type: "thread.queue.pause",
                    threadId: ThreadId.make(f.threadId),
                    commandId: CommandId.make(NodeCrypto.randomUUID()),
                    createdAt: "2026-10-14T00:00:00Z",
                  },
                });
                expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
                expect(yield* state(f)).toMatchObject({
                  state: "paused",
                  native_paused_generation: 1,
                });
                const capacity = makeThreadVmCapacityStore(f.sql);
                expect((yield* capacity.get(f.input.allocationId))?.state).toBe("released");
                expect(
                  yield* f.sql`SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=${f.input.allocationId}`,
                ).toEqual([]);
                expect(
                  yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE allocation_id=${f.input.allocationId}`,
                ).toEqual([]);
                const resumes = makeThreadVmResumeStore(f.sql);
                expect(yield* resumes.get(f.input.allocationId)).toBeNull();
                expect(yield* journal.next(f.owner)).toBeNull();
                const requested = yield* resumes.request(f.threadId);
                expect((yield* capacity.get(requested.operationId))?.state).toBe("waiting");
                let nativeState: "running" | "paused" = "paused";
                let wakes = 0,
                  verifiedGates = 0;
                const resume = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                    recoverIngress: () =>
                      Effect.sync(() => {
                        wakes++;
                        nativeState = "running";
                        return {
                          sandboxId: f.computeRef,
                          trafficAccessToken: Redacted.make("resumed-token"),
                        };
                      }),
                  },
                  {
                    reopenAfterResume: (_sandbox, identity, pauseOperationId) =>
                      Effect.gen(function* () {
                        verifiedGates++;
                        expect(pauseOperationId).toBeNull();
                        expect(identity.scope.allocationId).toBe(f.input.allocationId);
                        expect(identity.scope.generation).toBe(1);
                        expect(yield* journal.next(f.owner)).toBeNull();
                      }).pipe(Effect.orDie),
                  },
                  f.hostId,
                );
                expect(yield* resume.runOne()).toBe(true);
                expect(wakes).toBe(1);
                expect(verifiedGates).toBe(1);
                expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
                expect(yield* state(f)).toMatchObject({
                  state: "running",
                  native_paused_generation: null,
                });
                expect((yield* capacity.get(requested.operationId))?.state).toBe("started");
                const [command] = yield* f.sql`SELECT receipt_json FROM relay_thread_commands
            WHERE command_id=${queued!.commandId}`;
                expect(command?.receipt_json).toBeNull();
                expect(yield* resume.runOne()).toBe(false);
              }),
            ),
        );

        for (const successor of ["backup", "final-save"] as const)
          it.effect(
            `a resumed managed pause waits for guest activation before another ${successor}`,
            () =>
              Effect.scoped(
                Effect.gen(function* () {
                  const f = yield* fixture("paused"),
                    recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects),
                    pause = (yield* recovery.get(f.owner))!,
                    resumes = makeThreadVmResumeStore(f.sql);
                  const pausedStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                  expect(pausedStatus.sourceActivationPending).toBe(true);
                  expect(threadVmPresentation({ status: pausedStatus }).primary?.type).toBe(
                    "resume",
                  );
                  yield* resumes.request(f.threadId);
                  let nativeState: "paused" | "running" = "paused";
                  const resume = makeThreadVmResumeWorker(
                    f.sql,
                    {
                      inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                      recoverIngress: () =>
                        Effect.sync(() => {
                          nativeState = "running";
                          return {
                            sandboxId: f.computeRef,
                            trafficAccessToken: Redacted.make("resumed-managed-token"),
                          };
                        }),
                    },
                    { reopenAfterResume: () => Effect.void },
                    f.hostId,
                  );
                  expect(yield* resume.runOne()).toBe(true);
                  yield* f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),idle_since=clock_timestamp()-interval '10 days' WHERE allocation_id=${f.input.allocationId}`;
                  yield* f.sql`UPDATE relay_thread_vm_backups SET verified_at=clock_timestamp()-interval '1 day' WHERE allocation_id=${f.input.allocationId}`;
                  expect(yield* f.backup.enqueueDue(f.hostId)).toBeNull();
                  yield* Effect.flip(f.store.begin(f.input));
                  const waitingStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                  expect(waitingStatus.sourceActivationPending).toBe(true);
                  expect(threadVmPresentation({ status: waitingStatus })).toMatchObject({
                    held: true,
                    ready: false,
                    canPreview: false,
                    primary: null,
                  });
                  yield* recovery.confirmActivation({ ...f.owner, operationId: pause.operationId });
                  const activeStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                  expect(activeStatus.sourceActivationPending).toBe(false);
                  expect(threadVmPresentation({ status: activeStatus })).toMatchObject({
                    held: false,
                    ready: true,
                    canPreview: true,
                  });
                  if (successor === "backup")
                    expect(yield* f.backup.enqueueDue(f.hostId)).toBeTypeOf("string");
                  else expect((yield* f.store.begin(f.input)).phase).toBe("draining");
                }),
              ),
          );
        it.effect(
          "a paused observation cannot release the capacity of a later resumed execution",
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  resumes = makeThreadVmResumeStore(f.sql),
                  observation = {
                    allocationId: f.input.allocationId,
                    computeRef: f.computeRef,
                    threadId: f.threadId,
                    generation: 1,
                    operationId: f.input.allocationId,
                    capacityOperationId: f.input.allocationId,
                    hostId: f.hostId,
                  };
                expect(yield* resumes.reconcileNativePause(observation)).toBe(true);
                yield* resumes.request(f.threadId);
                let nativeState: "paused" | "running" = "paused";
                const resume = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                    recoverIngress: () =>
                      Effect.sync(() => {
                        nativeState = "running";
                        return {
                          sandboxId: f.computeRef,
                          trafficAccessToken: Redacted.make("later-execution-token"),
                        };
                      }),
                  },
                  { reopenAfterResume: () => Effect.void },
                  f.hostId,
                );
                expect(yield* resume.runOne()).toBe(true);
                expect(yield* resumes.reconcileNativePause(observation)).toBe(false);
                expect(yield* state(f)).toMatchObject({
                  state: "running",
                  native_paused_generation: null,
                });
                const [capacity] =
                  yield* f.sql`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.input.allocationId} ORDER BY position DESC LIMIT 1`;
                expect(capacity?.state).toBe("started");
              }),
            ),
        );
        it.effect(
          "a queued explicit continuation requests normal FIFO wake after certified power-off",
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* makeThreadJournalStore(f.sql).stage({
                  threadId: f.threadId,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                  command: {
                    type: "thread.queue.resume",
                    threadId: ThreadId.make(f.threadId),
                    commandId: CommandId.make(NodeCrypto.randomUUID()),
                    expectedRevision: 0,
                    createdAt: "2026-10-14T00:00:00Z",
                  },
                });
                expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
                const requested = yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId);
                expect(requested?.phase).toBe("waiting");
                expect(
                  (yield* makeThreadVmCapacityStore(f.sql).get(requested!.operationId))?.state,
                ).toBe("waiting");
                expect(yield* state(f)).toMatchObject({ state: "paused" });
              }),
            ),
        );

        it.effect("a revoked binding during native resume cannot publish running readiness", () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* worker(f, inspectPaused).runOne();
              const resumes = makeThreadVmResumeStore(f.sql);
              const requested = yield* resumes.request(f.threadId);
              let nativeState: "paused" | "running" = "paused";
              let wakes = 0;
              const resume = makeThreadVmResumeWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                  recoverIngress: () =>
                    Effect.gen(function* () {
                      wakes++;
                      nativeState = "running";
                      yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now'
                WHERE credential_id=${f.credentialId}`;
                      return {
                        sandboxId: f.computeRef,
                        trafficAccessToken: Redacted.make("resumed-token"),
                      };
                    }).pipe(Effect.orDie),
                },
                {
                  reopenAfterResume: () =>
                    Effect.die("Revoked ownership cannot open its guest gate"),
                },
                f.hostId,
              );
              expect(yield* resume.runOne()).toBe(true);
              expect(wakes).toBe(1);
              expect(yield* state(f)).toMatchObject({
                state: "paused",
                native_paused_generation: 1,
              });
              expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("resuming");
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(requested.operationId))?.state,
              ).toBe("started");
            }),
          ),
        );

        it.effect("holds unknown native resumes across claim expiry and blocks deletion", () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* worker(f, inspectPaused).runOne();
              const resumes = makeThreadVmResumeStore(f.sql);
              const requested = yield* resumes.request(f.threadId);
              let calls = 0;
              const resume = makeThreadVmResumeWorker(
                f.sql,
                {
                  inspect: () => inspectPaused(f),
                  recoverIngress: () =>
                    Effect.gen(function* () {
                      calls++;
                      return yield* new ThreadVmComputeError({
                        operation: "recover ingress",
                        message: "Lost native reply",
                        connectUncertain: true,
                      });
                    }),
                },
                {
                  reopenAfterResume: () =>
                    Effect.die("Unknown native outcome cannot open execution"),
                },
                f.hostId,
              );
              expect(yield* resume.runOne()).toBe(true);
              yield* f.sql`UPDATE relay_thread_vm_resumes SET claim_until=clock_timestamp()-interval '1 second',retry_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* resume.runOne()).toBe(false);
              expect(calls).toBe(1);
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(requested.operationId))?.state,
              ).toBe("started");
              expect(
                yield* confirmThreadVmCleanupIdentity(
                  f.sql,
                  {
                    inspect: () =>
                      Effect.die("Pending resume blocks native cleanup before any inspection"),
                  },
                  {
                    allocationId: f.input.allocationId,
                    threadId: f.threadId,
                    operationId: f.input.allocationId,
                    generation: 1,
                    computeRef: f.computeRef,
                  },
                ),
              ).toBe(false);
              const [held] =
                yield* f.sql`SELECT connect_claim_id FROM relay_thread_vm_resumes WHERE allocation_id=${f.input.allocationId}`;
              expect(held?.connect_claim_id).not.toBeNull();
            }),
          ),
        );
        it.effect("settles a delayed exact reply without publishing through an expired claim", () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* worker(f, inspectPaused).runOne();
              const resumes = makeThreadVmResumeStore(f.sql);
              const requested = yield* resumes.request(f.threadId);
              // An earlier attempt restored power but failed to reopen its gate;
              // native timeout has paused it again before this delayed connect.
              const oldToken = yield* sealThreadVmTrafficAccessToken(
                {
                  allocationId: f.input.allocationId,
                  computeRef: f.computeRef,
                  operationId: f.input.allocationId,
                  threadId: f.threadId,
                  generation: 1,
                },
                Redacted.make("previous-execution-token"),
              );
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',sealed_traffic_access_token=${oldToken} WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_resumes SET phase='resuming' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_capacity SET state='started',compute_ref=${f.computeRef} WHERE operation_id=${requested.operationId}`;
              const entered = yield* Deferred.make<void>(),
                ack = yield* Deferred.make<void>();
              let nativeState: "running" | "paused" = "paused",
                calls = 0,
                gates = 0;
              const resume = makeThreadVmResumeWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                  recoverIngress: () =>
                    Effect.gen(function* () {
                      calls++;
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(ack);
                      nativeState = "running";
                      return {
                        sandboxId: f.computeRef,
                        trafficAccessToken: Redacted.make("refreshed-private-token"),
                      };
                    }),
                },
                {
                  reopenAfterResume: () =>
                    Effect.sync(() => {
                      gates++;
                    }),
                },
                f.hostId,
              );
              const pending = yield* resume.runOne().pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* f.sql`UPDATE relay_thread_vm_resumes SET claim_until=clock_timestamp()-interval '1 second',retry_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* resume.runOne()).toBe(false);
              yield* Deferred.succeed(ack, undefined);
              yield* Fiber.join(pending);
              expect(gates).toBe(0);
              expect(yield* state(f)).toMatchObject({ state: "running" });
              const [settled] =
                yield* f.sql`SELECT connect_claim_id FROM relay_thread_vm_resumes WHERE allocation_id=${f.input.allocationId}`;
              expect(settled?.connect_claim_id).toBeNull();
              yield* f.sql`UPDATE relay_thread_vm_resumes SET retry_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* resume.runOne()).toBe(true);
              expect(calls).toBe(2);
              expect(gates).toBe(1);
              expect(
                Redacted.value(
                  yield* readThreadVmTrafficAccessToken(f.sql, {
                    allocationId: f.input.allocationId,
                    computeRef: f.computeRef,
                    operationId: f.input.allocationId,
                    threadId: f.threadId,
                    generation: 1,
                  }),
                ),
              ).toBe("refreshed-private-token");
              const [stored] = yield* f.sql<{
                sealed: string;
              }>`SELECT sealed_traffic_access_token AS sealed FROM relay_thread_vm_allocations WHERE allocation_id=${f.input.allocationId}`;
              expect(stored?.sealed).not.toContain("refreshed-private-token");
            }),
          ),
        );
        for (const key of [
          "launchpad.managed",
          "launchpad.allocation_id",
          "launchpad.operation_id",
          "launchpad.thread_id",
          "launchpad.generation",
        ] as const) {
          it.effect(`does not reconcile a foreign ${key}`, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* worker(f, (current) =>
                  Effect.succeed({
                    ...current.info,
                    state: "paused",
                    metadata: { ...current.info.metadata, [key]: "foreign" },
                  }),
                ).runOne();
                expect(yield* state(f)).toMatchObject({
                  state: "running",
                  native_paused_generation: null,
                });
                expect(
                  (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
                ).toBe("started");
              }),
            ),
          );
        }
        for (const reason of ["HTTP409", "transient", "missing", "running"] as const) {
          it.effect(`keeps the source and capacity for ${reason}`, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const inspect =
                  reason === "HTTP409" || reason === "transient"
                    ? () => Effect.fail(unavailable())
                    : reason === "missing"
                      ? () => Effect.succeed(null)
                      : reason === "running"
                        ? (current: Fixture) => Effect.succeed(current.info)
                        : inspectPaused;
                yield* makeThreadVmLeaseWorker(f.sql, () => Effect.fail(unavailable()), f.hostId, {
                  inspect: () => inspect(f),
                }).runOne();
                expect(yield* state(f)).toMatchObject({
                  state: "running",
                  native_paused_generation: null,
                });
                expect(
                  (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
                ).toBe("started");
                expect(yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId)).toBeNull();
              }),
            ),
          );
        }

        for (const changed of ["generation", "move", "credential", "deleting"] as const) {
          it.effect(`discards a late native result after ${changed} changes`, () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const native = worker(f, (current) =>
                  Effect.gen(function* () {
                    if (changed === "generation")
                      yield* current.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${current.threadId}`;
                    else if (changed === "move")
                      yield* current.sql`UPDATE relay_thread_placements SET operation_id=${NodeCrypto.randomUUID()} WHERE thread_id=${current.threadId}`;
                    else if (changed === "credential")
                      yield* current.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${current.credentialId}`;
                    else
                      yield* current.sql`UPDATE relay_thread_vm_allocations SET state='deleting' WHERE allocation_id=${current.input.allocationId}`;
                    return { ...current.info, state: "paused" as const };
                  }).pipe(Effect.orDie),
                );
                yield* native.runOne();
                expect(yield* state(f)).toMatchObject({
                  state: changed === "deleting" ? "deleting" : "running",
                  native_paused_generation: null,
                });
                expect(
                  (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
                ).toBe("started");
              }),
            ),
          );
        }
        it.effect(
          "a native timeout cancels an uncertified pause and preserves its drain until resumed acknowledgement",
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const journal = makeThreadJournalStore(f.sql);
                const queued = yield* journal.stage({
                  threadId: f.threadId,
                  actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                  command: {
                    type: "thread.queue.pause",
                    threadId: ThreadId.make(f.threadId),
                    commandId: CommandId.make(NodeCrypto.randomUUID()),
                    createdAt: "2026-10-14T00:00:00Z",
                  },
                });
                const pauseOperationId = NodeCrypto.randomUUID();
                yield* f.sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase)
          VALUES(${f.input.allocationId},${pauseOperationId},1,'pending')`;
                yield* worker(f, inspectPaused).runOne();
                expect(yield* state(f)).toMatchObject({
                  state: "paused",
                  native_paused_generation: 1,
                });
                const recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
                expect(yield* recovery.get(f.owner)).toMatchObject({
                  operationId: pauseOperationId,
                  phase: "cancelled",
                  sourceReopened: false,
                  canActivate: false,
                  nativeCheckpointOperationId: null,
                });
                expect(yield* journal.next(f.owner)).toBeNull();
                const resumes = makeThreadVmResumeStore(f.sql);
                yield* resumes.request(f.threadId);
                let nativeState: "paused" | "running" = "paused";
                const resume = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                    recoverIngress: () =>
                      Effect.sync(() => {
                        nativeState = "running";
                        return {
                          sandboxId: f.computeRef,
                          trafficAccessToken: Redacted.make("resumed-token"),
                        };
                      }),
                  },
                  {
                    reopenAfterResume: (_sandbox, _identity, operationId) =>
                      Effect.sync(() => {
                        expect(operationId).toBe(pauseOperationId);
                      }),
                  },
                  f.hostId,
                );
                expect(yield* resume.runOne()).toBe(true);
                expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
                expect(yield* recovery.get(f.owner)).toMatchObject({
                  operationId: pauseOperationId,
                  phase: "cancelled",
                  sourceReopened: false,
                  canActivate: true,
                  nativeCheckpointOperationId: null,
                });
                expect(yield* journal.next(f.owner)).toBeNull();
                const waitingStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                expect(waitingStatus.sourceActivationPending).toBe(true);
                expect(threadVmPresentation({ status: waitingStatus })).toMatchObject({
                  held: true,
                  ready: false,
                  canPreview: false,
                });
                yield* recovery.confirmActivation({ ...f.owner, operationId: pauseOperationId });
                expect((yield* journal.next(f.owner))?.commandId).toBe(queued!.commandId);
                expect((yield* recovery.get(f.owner))?.sourceReopened).toBe(true);
                const activeStatus = yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1);
                expect(activeStatus.sourceActivationPending).toBe(false);
                expect(threadVmPresentation({ status: activeStatus }).ready).toBe(true);
              }),
            ),
        );
        it.effect(
          "finishes an already retained pending pause when native timeout beats worker sealing",
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture("paused");
                yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running' WHERE allocation_id=${f.input.allocationId}`;
                yield* f.sql`UPDATE relay_thread_vm_capacity SET state='started' WHERE allocation_id=${f.input.allocationId}`;
                yield* f.sql`UPDATE relay_thread_vm_pauses SET phase='pending' WHERE allocation_id=${f.input.allocationId}`;
                const pause = makeThreadVmPauseWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed(f.info),
                    pause: () => Effect.die("The exact native execution is already stopped"),
                  },
                  {
                    seal: () => Effect.die("A stopped guest cannot seal again"),
                    reopen: () => Effect.die("A retained frozen source must not reopen"),
                  },
                  f.hostId,
                );
                expect(yield* pause.runOne()).toBe(true);
                expect(yield* state(f)).toMatchObject({
                  state: "paused",
                  native_paused_generation: null,
                });
                expect(
                  (yield* makeThreadVmPauseRecoveryStore(f.sql, f.objects).get(f.owner))?.phase,
                ).toBe("completed");
              }),
            ),
        );
      },
    );
  },
);
