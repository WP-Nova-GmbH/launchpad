import { makeThreadCurrentQueueStore } from "./ThreadCurrentQueueStore.ts";
import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Redacted from "effect/Redacted";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { ThreadId, CommandId, EventId, type OrchestrationEvent } from "@t3tools/contracts";
import { RelayDb } from "../db.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";
import {
  makeThreadVmRestoreStore,
  restoreProbeOperationId,
  restoreComputeGeneration,
} from "./ThreadVmRestoreStore.ts";
import { E2BRestoreError, type E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { makeThreadDeletionWorker } from "./ThreadDeletionWorker.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import { permanentlyDeleteThread, getThreadDeletion } from "../http/ThreadDeletionApi.ts";
const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  yield* repositoryUploadCatalogFixture(f.sql, f.objects, f.threadId);
  const input = {
    threadId: f.threadId,
    operationId: NodeCrypto.randomUUID(),
    ownerUserId: f.input.actorUserId,
    generation: 1,
    hostId: f.hostId,
  };
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${input.ownerUserId},'member','now','now')`;
  yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at) VALUES('repo','org',${input.ownerUserId},'developer','now','now')`;
  const db = yield* PgDrizzle.makeWithDefaults();
  const authorized = <A, E, R>(
    action: Effect.Effect<A, E, R>,
    userId = input.ownerUserId,
    enabled = true,
  ) =>
    action.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(RelayClientPrincipal, { userId, token: "fixture-token" }),
      Effect.provideService(ThreadVmRuntimeConfiguration, {
        settings: {
          compute: {
            apiUrl: "https://compute.invalid",
            sandboxUrl: "https://sandbox.invalid",
            apiKey: Redacted.make("fixture-management"),
            templateId: "template:build-verified",
            hostAddresses: ["192.0.2.1"],
            timeoutMs: 600_000,
          },
          templateBuildId: "build-verified",
          hostId: f.hostId,
          maxRunningVms: 1,
          publicRelayUrl: "https://relay.invalid",
          autoPauseEnabled: false,
          autoBackupEnabled: false,
          autoDeleteEnabled: false,
          replacementEnabled: false,
          restoreEnabled: false,
          resetEnabled: false,
          permanentDeleteEnabled: enabled,
        },
      }),
    );
  return {
    ...f,
    allocationId: f.input.allocationId,
    deletionInput: input,
    deletions: makeThreadDeletionStore(f.sql),
    authorized,
    payload: {
      operationId: input.operationId,
      expectedGeneration: input.generation,
      confirmWorkspaceLoss: true as const,
    },
  };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "permanent VM thread deletion (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const finalAlias of ["missing", "ready"] as const)
        it.effect(
          `explicit deletion seals an uncertain periodic capture before releasing quota, then reconciles ${finalAlias} alias`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  operationId = NodeCrypto.randomUUID(),
                  buildId = NodeCrypto.randomUUID();
                yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase) VALUES(${operationId},${f.allocationId},1,${f.computeRef},${`launchpad-backup-${operationId}`},'creating')`;
                expect(yield* f.deletions.needsUncertainCaptureCleanup(f.threadId)).toBe(true);
                yield* Effect.flip(f.deletions.begin(f.deletionInput));
                yield* f.deletions.begin({
                  ...f.deletionInput,
                  allowUncertainCaptureCleanup: true,
                });
                let stops = 0,
                  supportsFence = false,
                  alias: "building" | "missing" | "ready" = "building";
                const deleted: string[] = [];
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () => Effect.succeed(f.info),
                    destroy: () =>
                      Effect.gen(function* () {
                        stops++;
                        if (stops === 1)
                          return yield* new ThreadVmComputeError({
                            operation: "delete",
                            message: "Lost positive stop reply",
                          });
                      }),
                    deleteSnapshot: (id) =>
                      Effect.sync(() => {
                        deleted.push(id);
                        return true;
                      }),
                    restore: {
                      inspect: () => Effect.die("No serving recovery is needed"),
                      requireExecutionRetention: () =>
                        supportsFence
                          ? Effect.void
                          : Effect.fail(
                              new E2BRestoreError({
                                operation: "execution retention capability",
                                reason: "unsupported",
                              }),
                            ),
                      cancel: () =>
                        Effect.fail(
                          new E2BRestoreError({ operation: "cancel", reason: "http", status: 404 }),
                        ),
                      resolveStoppedNamedSnapshot: () =>
                        alias === "ready"
                          ? Effect.succeed({
                              snapshotId: `snapshot-${operationId}`,
                              sourceTemplateID: `snapshot-${operationId}`,
                              sourceBuildID: buildId,
                            })
                          : alias === "missing"
                            ? Effect.succeed(null)
                            : Effect.fail(
                                new E2BRestoreError({
                                  operation: "stopped snapshot",
                                  reason: "http",
                                  status: 409,
                                }),
                              ),
                    },
                  },
                  f.hostId,
                  () => Effect.succeed(true),
                );
                const retry = f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
                expect(stops).toBe(0);
                supportsFence = true;
                yield* retry;
                yield* worker.runOne();
                expect(yield* makeThreadVmAllocationStore(f.sql).get(f.allocationId)).toMatchObject(
                  {
                    state: "deleting",
                    deletedAt: null,
                  },
                );
                let [row] = yield* f.sql<{
                  proof: unknown;
                  phase: string;
                }>`SELECT a.deletion_stop_receipt AS proof,b.phase FROM relay_thread_vm_allocations a JOIN relay_thread_vm_backups b USING(allocation_id) WHERE b.operation_id=${operationId}`;
                expect(row).toEqual({ proof: null, phase: "creating" });
                yield* retry;
                yield* worker.runOne();
                expect(yield* makeThreadVmAllocationStore(f.sql).get(f.allocationId)).toMatchObject(
                  {
                    state: "deleted",
                  },
                );
                [row] = yield* f.sql<{
                  proof: unknown;
                  phase: string;
                }>`SELECT a.deletion_stop_receipt AS proof,b.phase FROM relay_thread_vm_allocations a JOIN relay_thread_vm_backups b USING(allocation_id) WHERE b.operation_id=${operationId}`;
                expect(row?.proof).toMatchObject({
                  operationId: f.deletionInput.operationId,
                  allocationId: f.allocationId,
                  computeRef: f.computeRef,
                  physicallyStopped: true,
                  captureAdmissionSealed: true,
                });
                expect(row?.phase).toBe("creating");
                yield* retry;
                yield* worker.runOne();
                expect(deleted).toEqual([]);
                expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe(
                  "snapshot_cleanup_unconfirmed",
                );
                alias = finalAlias;
                yield* retry;
                yield* worker.runOne();
                expect(deleted).toEqual(finalAlias === "ready" ? [`snapshot-${operationId}`] : []);
                const [backup] = yield* f.sql<{
                  phase: string;
                }>`SELECT phase FROM relay_thread_vm_backups WHERE operation_id=${operationId}`;
                expect(backup?.phase).toBe("retired");
                expect(stops).toBe(2);
              }),
            ),
        );
      for (const [phase, lookupFails] of [
        ["creating", false],
        ["captured", false],
        ["captured", true],
        ["verifying", false],
      ] as const)
        it.effect(
          `deletion durably reconciles ${phase} capture${lookupFails ? " after a lost alias lookup" : ""} before a committed alias delete loses its reply`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.backup.enqueueDue(f.hostId);
                const capture = (yield* f.backup.claim(f.hostId))!,
                  snapshotId = `snapshot-${capture.operationId}`,
                  sourceBuildID = NodeCrypto.randomUUID(),
                  identity = {
                    snapshotId: `local-dev-team/${capture.snapshotName}:default`,
                    sourceTemplateId: snapshotId,
                    sourceBuildId: sourceBuildID,
                  };
                yield* f.backup.beginCapture(capture);
                if (phase !== "creating") yield* f.backup.recordCapture(capture, identity);
                if (phase === "verifying") yield* f.backup.claim(f.hostId);
                yield* f.deletions.begin({
                  ...f.deletionInput,
                  allowUncertainCaptureCleanup: true,
                });
                let deletes = 0,
                  resolves = 0,
                  cancels = 0,
                  cancelReady = phase !== "verifying";
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () => Effect.succeed(f.info),
                    destroy: () => Effect.void,
                    deleteSnapshot: (id) =>
                      Effect.gen(function* () {
                        expect(id).toBe(snapshotId);
                        expect(
                          yield* f.backup.get(capture.operationId).pipe(Effect.orDie),
                        ).toMatchObject({ phase: "retiring", ...identity, snapshotId });
                        if (++deletes === 1)
                          return yield* new ThreadVmComputeError({
                            operation: "delete snapshot",
                            message: "Committed alias deletion lost its reply",
                          });
                        return false;
                      }),
                    restore: {
                      inspect: () => Effect.die("No boot restore"),
                      requireExecutionRetention: () => Effect.void,
                      cancel: (operationID, generation) =>
                        Effect.gen(function* () {
                          cancels++;
                          if (!cancelReady || phase !== "verifying")
                            return yield* new E2BRestoreError({
                              operation: "cancel",
                              reason: "http",
                              status: 404,
                            });
                          return {
                            operationID,
                            generation,
                            state: "cancelled" as const,
                            sandboxID: "probe",
                            executionID: NodeCrypto.randomUUID(),
                            preparedBuildID: NodeCrypto.randomUUID(),
                          };
                        }),
                      resolveStoppedNamedSnapshot: () =>
                        Effect.gen(function* () {
                          resolves++;
                          if (lookupFails && resolves === 1)
                            return yield* new E2BRestoreError({
                              operation: "snapshot",
                              reason: "transport",
                            });
                          if (resolves > (lookupFails ? 2 : 1))
                            throw new Error("The committed delete removed this alias");
                          return { snapshotId, sourceTemplateID: snapshotId, sourceBuildID };
                        }),
                    },
                  },
                  f.hostId,
                  () => Effect.succeed(true),
                );
                const retry = Effect.gen(function* () {
                  yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                  yield* worker.runOne();
                });
                yield* retry;
                if (phase === "verifying") {
                  yield* retry;
                  expect((yield* f.backup.get(capture.operationId))?.phase).toBe("verifying");
                  expect(deletes).toBe(0);
                  expect(resolves).toBe(0);
                  cancelReady = true;
                }
                yield* retry;
                expect((yield* f.backup.get(capture.operationId))?.phase).toBe("retiring");
                if (lookupFails) {
                  expect((yield* f.backup.get(capture.operationId))?.snapshotId).toBe(
                    identity.snapshotId,
                  );
                  expect(deletes).toBe(0);
                  yield* retry;
                }
                yield* retry;
                yield* retry;
                expect((yield* f.backup.get(capture.operationId))?.phase).toBe("retired");
                const [row] =
                  yield* f.sql`SELECT failed_probe_stopped_at FROM relay_thread_vm_backups WHERE operation_id=${capture.operationId}`;
                expect(row?.failed_probe_stopped_at === null).toBe(phase !== "verifying");
                expect(resolves).toBe(lookupFails ? 2 : 1);
                expect(deletes).toBe(2);
                expect(cancels).toBe(phase === "verifying" ? 3 : 0);
              }),
            ),
        );
      for (const captureWins of [false, true])
        it.effect(
          `creating retirement CAS ${captureWins ? "loses to" : "fences"} a delayed production recordCapture`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.backup.enqueueDue(f.hostId);
                const capture = (yield* f.backup.claim(f.hostId))!,
                  snapshotId = `snapshot-${capture.operationId}`,
                  sourceBuildID = NodeCrypto.randomUUID(),
                  identity = {
                    snapshotId,
                    sourceTemplateId: snapshotId,
                    sourceBuildId: sourceBuildID,
                  };
                yield* f.backup.beginCapture(capture);
                yield* f.deletions.begin({
                  ...f.deletionInput,
                  allowUncertainCaptureCleanup: true,
                });
                let hooked = false,
                  resolves = 0;
                const sql = new Proxy(f.sql, {
                  apply(target, thisArg, args) {
                    const statement: ReturnType<typeof f.sql<Record<string, unknown>>> =
                      Reflect.apply(target, thisArg, args);
                    // Complete the real capture between the worker's read and CAS.
                    if (
                      captureWins &&
                      !hooked &&
                      Array.isArray(args[0]) &&
                      args[0]
                        .join("")
                        .includes(
                          'SELECT x.operation_id AS "operationId",x.snapshot_name AS "snapshotName"',
                        )
                    ) {
                      hooked = true;
                      return statement.pipe(
                        Effect.tap(() =>
                          f.backup
                            .recordCapture(capture, identity)
                            .pipe(Effect.tap((ok) => Effect.sync(() => expect(ok).toBe(true)))),
                        ),
                      );
                    }
                    return statement;
                  },
                });
                const worker = makeThreadDeletionWorker(
                  sql,
                  f.objects,
                  {
                    inspect: () => Effect.succeed(f.info),
                    destroy: () => Effect.void,
                    deleteSnapshot: () => Effect.succeed(true),
                    restore: {
                      inspect: () => Effect.die("No boot restore"),
                      requireExecutionRetention: () => Effect.void,
                      cancel: () =>
                        Effect.fail(
                          new E2BRestoreError({ operation: "cancel", reason: "http", status: 404 }),
                        ),
                      resolveStoppedNamedSnapshot: () =>
                        Effect.gen(function* () {
                          resolves++;
                          expect(
                            yield* f.backup.recordCapture(capture, identity).pipe(Effect.orDie),
                          ).toBe(false);
                          return { snapshotId, sourceTemplateID: snapshotId, sourceBuildID };
                        }),
                    },
                  },
                  f.hostId,
                  () => Effect.succeed(true),
                );
                yield* worker.runOne();
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
                expect((yield* f.backup.get(capture.operationId))?.phase).toBe(
                  captureWins ? "captured" : "retired",
                );
                expect(resolves).toBe(captureWins ? 0 : 1);
              }),
            ),
        );
      for (const problem of [
        "old host",
        "foreign generation",
        "final-save name",
        "malformed pending",
      ] as const) {
        it.effect(`uncertain capture deletion remains blocked for ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                operationId = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,snapshot_id) VALUES(${operationId},${f.allocationId},${problem === "foreign generation" ? 2 : 1},${f.computeRef},${problem === "final-save name" ? `launchpad-final-${operationId}` : `launchpad-backup-${operationId}`},${problem === "malformed pending" ? "pending" : "creating"},${problem === "malformed pending" ? "unexpected-snapshot" : null})`;
              yield* Effect.flip(
                f.deletions.begin({
                  ...f.deletionInput,
                  allowUncertainCaptureCleanup: problem !== "old host",
                }),
              );
              expect(yield* f.deletions.get(f.threadId)).toBeNull();
              expect(yield* makeThreadVmAllocationStore(f.sql).get(f.allocationId)).toMatchObject({
                state: "running",
                deletedAt: null,
              });
            }),
          ),
        );
      }
      it.effect(
        "authorizes one explicit deletion, hides the thread immediately and retains its quota until physical stop",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* Effect.flip(
                f.authorized(
                  permanentlyDeleteThread(f.threadId, f.payload),
                  f.deletionInput.ownerUserId,
                  false,
                ),
              );
              yield* Effect.flip(
                f.authorized(
                  permanentlyDeleteThread(f.threadId, f.payload),
                  NodeCrypto.randomUUID(),
                ),
              );
              expect(yield* f.deletions.get(f.threadId)).toBeNull();
              const admissions = yield* Effect.all(
                [
                  f.authorized(permanentlyDeleteThread(f.threadId, f.payload)),
                  f.authorized(permanentlyDeleteThread(f.threadId, f.payload)),
                ],
                { concurrency: 2 },
              );
              expect(admissions[0]).toEqual(admissions[1]);
              expect(admissions[0]).toMatchObject({
                operationId: f.payload.operationId,
                phase: "stopping",
              });
              expect(yield* makeThreadPlacementStore(f.sql).get(f.threadId)).toBeNull();
              expect(yield* makeThreadVmAllocationStore(f.sql).get(f.allocationId)).toMatchObject({
                state: "deleting",
                deletedAt: null,
              });
              yield* Effect.flip(makeThreadJournalStore(f.sql).next(f.owner));
              const [key] = yield* f.sql<{
                revoked: boolean;
              }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_environment_credentials WHERE credential_id=${f.credentialId}`;
              expect(key?.revoked).toBe(true);
              yield* f.sql`DELETE FROM relay_repository_access WHERE user_id=${f.deletionInput.ownerUserId}`;
              expect(yield* f.authorized(getThreadDeletion(f.threadId))).toMatchObject({
                phase: "stopping",
              });
              yield* Effect.flip(
                f.authorized(getThreadDeletion(f.threadId), NodeCrypto.randomUUID()),
              );
              yield* Effect.flip(
                f.authorized(
                  permanentlyDeleteThread(f.threadId, {
                    ...f.payload,
                    operationId: NodeCrypto.randomUUID(),
                  }),
                ),
              );
            }),
          ),
      );
      it.effect(
        "a lost physical-stop reply keeps quota and retries before collecting conversation objects",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* makeThreadCurrentQueueStore(f.sql).read(f.threadId);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_current_queues WHERE thread_id=${f.threadId}`,
              ).toHaveLength(1);
              yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              let absent = false,
                stops = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(absent ? null : f.info),
                  destroy: () =>
                    Effect.gen(function* () {
                      stops++;
                      absent = true;
                      if (stops === 1)
                        return yield* new ThreadVmComputeError({
                          operation: "delete",
                          message: "Lost stop reply",
                        });
                    }),
                  deleteSnapshot: () => Effect.die("Deletion must not create or save a disk"),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: () => Effect.die("No snapshot preparation"),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
              const [retained] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId} AND state='complete'`;
              expect(retained!.count).toBeGreaterThan(0);
              for (
                let pass = 0;
                pass < 40 && (yield* f.deletions.get(f.threadId))?.phase !== "completed";
                pass++
              ) {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                expect(yield* worker.runOne()).toBe(true);
              }
              expect(stops).toBe(2);
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleted");
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
              const [remaining] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId} AND state!='deleted'`;
              expect(remaining?.count).toBe(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${f.threadId}`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_current_queues WHERE thread_id=${f.threadId}`,
              ).toHaveLength(0);
              expect(yield* worker.runOne()).toBe(false);
            }),
          ),
      );
      it.effect("physically stops a recovered restore boot using its exact child identity", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
            const parent = f.info.metadata["launchpad.operation_id"]!;
            const info = {
              ...f.info,
              metadata: {
                ...f.info.metadata,
                "launchpad.restore": "v1",
                "launchpad.restore_parent_operation_id": parent,
                "launchpad.restore_boot_attempt": "1",
                "launchpad.operation_id": restoreBootOperationId(parent, 1),
              },
            };
            let absent = false;
            const worker = makeThreadDeletionWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.succeed(absent ? null : info),
                destroy: (id) =>
                  Effect.sync(() => {
                    expect(id).toBe(f.info.sandboxId);
                    absent = true;
                  }),
                deleteSnapshot: () => Effect.die("No snapshot collection before stop"),
                restore: {
                  inspect: () => Effect.die("No restore collection before stop"),
                  cancel: () => Effect.die("No restore cancellation before stop"),
                },
              },
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect(absent).toBe(true);
            expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleted");
          }),
        ),
      );
      for (const problem of [
        "none",
        "lost-stop",
        "foreign-thread",
        "foreign-generation",
        "foreign-compute",
        "unknown",
      ] as const) {
        it.effect(
          `explicit deletion reconciles an unreadable pause with durable creation identity: ${problem}`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
                let stops = 0;
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () =>
                      Effect.fail(
                        new ThreadVmComputeError({
                          operation: "inspect",
                          message: "Paused disk is unconfirmed (409)",
                        }),
                      ),
                    inspectCreation: (operationId) =>
                      Effect.succeed(
                        problem === "unknown"
                          ? null
                          : {
                              operationId,
                              computeRef:
                                problem === "foreign-compute" ? "another-vm" : f.computeRef,
                              metadata: {
                                ...f.info.metadata,
                                ...(problem === "foreign-thread"
                                  ? { "launchpad.thread_id": NodeCrypto.randomUUID() }
                                  : {}),
                                ...(problem === "foreign-generation"
                                  ? { "launchpad.generation": "2" }
                                  : {}),
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
                            message: "Lost physical-stop reply",
                          });
                      }),
                    deleteSnapshot: () =>
                      Effect.die("No final save is needed for explicit deletion"),
                    restore: {
                      inspect: () => Effect.die("This is an original creation"),
                      cancel: () => Effect.die("No restore probe was created"),
                    },
                  },
                  f.hostId,
                );
                yield* worker.runOne();
                const accepted = problem === "none" || problem === "lost-stop";
                expect(stops).toBe(accepted ? 1 : 0);
                expect((yield* f.allocations.get(f.allocationId))?.state).toBe(
                  problem === "none" ? "deleted" : "deleting",
                );
                if (!accepted)
                  expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe("identity_conflict");
                if (problem === "lost-stop") {
                  expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe("stop_unconfirmed");
                  yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                  yield* worker.runOne();
                  expect(stops).toBe(2);
                  expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleted");
                }
              }),
            ),
        );
      }
      for (const foreign of [false, true]) {
        it.effect(
          `an unreadable restored VM requires its exact persisted child receipt (${foreign ? "foreign" : "matching"})`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.store.begin(f.input);
                yield* f.freeze;
                yield* f.verifyBackup;
                yield* f.store.recordSaved(f.input.operationId);
                const deletion = (yield* f.store.claimDeletion(f.hostId))!;
                yield* f.store.beginDeletion(deletion);
                yield* f.store.confirmDeleted(deletion);
                const operationId = NodeCrypto.randomUUID(),
                  allocationId = NodeCrypto.randomUUID();
                yield* makeThreadVmRestoreStore(f.sql, f.objects).begin({
                  operationId,
                  allocationId,
                  threadId: f.threadId,
                  savedDiskOperationId: f.input.operationId,
                  actorUserId: f.input.actorUserId,
                  expectedGeneration: 1,
                  serving: true,
                });
                const boot: E2BRestoreStatus = {
                  operationID: restoreBootOperationId(operationId, 1),
                  generation: "2",
                  sandboxID: `boot-${allocationId}`,
                  executionID: NodeCrypto.randomUUID(),
                  preparedBuildID: NodeCrypto.randomUUID(),
                  state: "active",
                };
                const probe = {
                  ...boot,
                  operationID: restoreProbeOperationId(operationId),
                  generation: restoreComputeGeneration(operationId),
                  state: "prepared" as const,
                };
                yield* f.sql`UPDATE relay_thread_vm_restores SET phase='completed',boot_attempt=1,prepare_started_at=clock_timestamp(),prepared_receipt=${f.sql.json(probe)},probe_removed_at=clock_timestamp(),boot_prepare_started_at=clock_timestamp(),boot_receipt=${f.sql.json(boot)},committed_at=clock_timestamp() WHERE operation_id=${operationId}`;
                yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${boot.sandboxID} WHERE allocation_id=${allocationId}`;
                yield* f.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES(${allocationId},${operationId},2,'created')`;
                yield* f.sql`UPDATE relay_thread_placements SET generation=2,operation_id=NULL WHERE thread_id=${f.threadId}`;
                yield* f.deletions.begin({
                  ...f.deletionInput,
                  generation: 2,
                  sourceDeleted: true,
                });
                let stops = 0;
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () =>
                      Effect.fail(
                        new ThreadVmComputeError({
                          operation: "inspect",
                          message: "Paused disk is unconfirmed (409)",
                        }),
                      ),
                    inspectCreation: () =>
                      Effect.die("Restored boot cannot use original creation identity"),
                    destroy: (id) =>
                      Effect.sync(() => {
                        expect(id).toBe(boot.sandboxID);
                        stops++;
                      }),
                    deleteSnapshot: () =>
                      Effect.die("Allocation must be stopped before disk cleanup"),
                    restore: {
                      inspect: (id, generation) =>
                        Effect.sync(() => {
                          expect(id).toBe(boot.operationID);
                          expect(generation).toBe("2");
                          return {
                            ...boot,
                            ...(foreign ? { executionID: NodeCrypto.randomUUID() } : {}),
                          };
                        }),
                      cancel: () => Effect.die("Completed boot must be physically stopped"),
                    },
                  },
                  f.hostId,
                );
                yield* worker.runOne();
                expect(stops).toBe(foreign ? 0 : 1);
                expect((yield* f.allocations.get(allocationId))?.state).toBe(
                  foreign ? "deleting" : "deleted",
                );
                if (foreign)
                  expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe("identity_conflict");
              }),
            ),
        );
      }
      it.effect(
        "identity conflicts and uncertain creates never stop foreign compute or release a slot",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.deletions.begin(f.deletionInput);
              let stops = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () =>
                    Effect.succeed({
                      ...f.info,
                      metadata: {
                        ...f.info.metadata,
                        "launchpad.thread_id": NodeCrypto.randomUUID(),
                      },
                    }),
                  destroy: () =>
                    Effect.sync(() => {
                      stops++;
                    }),
                  deleteSnapshot: () => Effect.die("no snapshots"),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: () => Effect.die("no preparation"),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              yield* worker.runOne();
              expect(stops).toBe(0);
              expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe("identity_conflict");
              yield* f.sql`UPDATE relay_thread_vm_allocations SET compute_ref=NULL WHERE allocation_id=${f.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_provisions SET phase='creating' WHERE allocation_id=${f.allocationId}`;
              yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
              yield* worker.runOne();
              expect(stops).toBe(0);
              expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe("create_unconfirmed");
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
            }),
          ),
      );
      it.effect(
        "permanent deletion waits for an in-flight artifact upload and prevents a late upload from recreating bytes",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                started = yield* Deferred.make<void>(),
                finish = yield* Deferred.make<void>();
              const bytes = new TextEncoder().encode("thread-owned upload"),
                artifact = yield* makeThreadArtifactStore(f.sql).begin({
                  artifactId: NodeCrypto.randomUUID(),
                  operationId: NodeCrypto.randomUUID(),
                  threadId: f.threadId,
                  kind: "attachment",
                  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                  sizeBytes: bytes.length,
                });
              const transfer = makeThreadArtifactTransfer(f.sql, {
                ...f.objects,
                put: (input) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(finish);
                    return yield* f.objects.put(input);
                  }),
              });
              const body = () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                });
              const upload = yield* transfer.uploadBytes(artifact, body()).pipe(Effect.forkScoped);
              yield* Deferred.await(started);
              yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              const claim = (yield* f.deletions.claim(f.hostId))!;
              yield* f.deletions.stopped(claim, f.allocationId, f.computeRef);
              yield* f.deletions.clean(claim);
              for (let pass = 0; pass < 40; pass++)
                if (!(yield* f.transfer.collectOne(f.threadId))) break;
              expect((yield* makeThreadArtifactStore(f.sql).get(artifact.artifactId))?.state).toBe(
                "deleting",
              );
              expect(yield* f.deletions.finish(claim)).toBe(false);
              yield* Deferred.succeed(finish, undefined);
              yield* Fiber.join(upload);
              yield* f.objects.verify({
                key: artifact.storageKey,
                sha256: artifact.sha256,
                sizeBytes: artifact.sizeBytes,
              });
              expect(yield* f.transfer.collectOne(f.threadId)).toBe(true);
              expect((yield* makeThreadArtifactStore(f.sql).get(artifact.artifactId))?.state).toBe(
                "deleted",
              );
              yield* Effect.flip(f.transfer.uploadBytes(artifact, body()));
              expect(yield* f.deletions.finish(claim)).toBe(false); // Endpoint receipt is still required.
            }),
          ),
      );
      it.effect(
        "ordinary Delete is reconciled only after its accepted receipt and deleted history event both arrive",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                journal = makeThreadJournalStore(f.sql),
                commandId = CommandId.make(NodeCrypto.randomUUID());
              yield* journal.stage({
                threadId: f.threadId,
                actor: { userId: f.deletionInput.ownerUserId, displayName: null, imageUrl: null },
                command: { type: "thread.delete", commandId, threadId: ThreadId.make(f.threadId) },
              });
              const [tail] = yield* f.sql<{
                sequence: number;
              }>`SELECT max(source_sequence)::int AS sequence FROM relay_thread_history WHERE thread_id=${f.threadId}`;
              const sequence = tail!.sequence + 1;
              const event: OrchestrationEvent = {
                type: "thread.deleted",
                sequence,
                eventId: EventId.make(NodeCrypto.randomUUID()),
                aggregateKind: "thread",
                aggregateId: ThreadId.make(f.threadId),
                occurredAt: "2026-10-07T00:00:00.000Z",
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId: ThreadId.make(f.threadId),
                  deletedAt: "2026-10-07T00:00:00.000Z",
                },
              };
              yield* journal.append({ ...f.owner, event });
              expect(yield* f.deletions.admitMirrored(f.hostId)).toBe(false);
              yield* journal.acknowledge({
                ...f.owner,
                commandId,
                receipt: { status: "accepted", sequence },
              });
              expect(yield* f.deletions.admitMirrored(f.hostId)).toBe(true);
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("stopping");
              expect(yield* f.deletions.admitMirrored(f.hostId)).toBe(false);
            }),
          ),
      );
      it.effect(
        "a failed capture with no admitted verifier retires after exact stop, including a lost delete reply",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.backup.enqueueDue(f.hostId);
              const capture = (yield* f.backup.claim(f.hostId))!,
                snapshotId = `failed-${capture.operationId}`,
                sourceBuildID = NodeCrypto.randomUUID();
              expect(yield* f.backup.beginCapture(capture)).toBe(true);
              expect(
                yield* f.backup.failCapture(capture, {
                  snapshotId,
                  sourceTemplateId: snapshotId,
                  sourceBuildId: sourceBuildID,
                }),
              ).toBe(true);
              yield* f.deletions.begin(f.deletionInput);
              let resolves = 0,
                deletes = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(f.info),
                  destroy: () => Effect.void,
                  deleteSnapshot: (id) =>
                    Effect.gen(function* () {
                      expect(id).toBe(snapshotId);
                      expect(
                        (yield* f.backup.get(capture.operationId).pipe(Effect.orDie))?.phase,
                      ).toBe("retiring");
                      deletes++;
                      if (deletes === 1)
                        return yield* new ThreadVmComputeError({
                          operation: "delete snapshot",
                          message: "Delete committed but its reply was lost",
                        });
                      return false; // Native confirmed 404 on the idempotent retry.
                    }),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: () => Effect.die("A failed native source never admitted a verifier"),
                    resolveFailedNamedSnapshot: (name) =>
                      Effect.sync(() => {
                        expect(name).toBe(capture.snapshotName);
                        resolves++;
                        if (resolves > 1) throw new Error("The committed delete removed the alias");
                        return { snapshotId, sourceTemplateID: snapshotId, sourceBuildID };
                      }),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              const retry = Effect.gen(function* () {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              });
              yield* retry; // Positive physical stop is persisted first.
              yield* retry; // Endpoint removal.
              yield* retry; // Proof, durable retirement, committed delete/lost reply.
              expect((yield* f.backup.get(capture.operationId))?.phase).toBe("retiring");
              yield* retry;
              expect((yield* f.backup.get(capture.operationId))?.phase).toBe("retired");
              const [row] =
                yield* f.sql`SELECT failed_probe_stopped_at FROM relay_thread_vm_backups WHERE operation_id=${capture.operationId}`;
              expect(row?.failed_probe_stopped_at).toBeNull();
              expect(resolves).toBe(1);
              expect(deletes).toBe(2);
            }),
          ),
      );
      for (const problem of [
        "verifier failure or lost prepare acknowledgement",
        "building source",
        "lookup unavailable",
        "missing resolver",
        "wrong snapshot",
        "wrong template",
        "wrong build",
        "wrong stop generation",
        "stop changed during lookup",
        "expired deletion claim",
        "probe evidence",
      ] as const)
        it.effect(`failed capture cleanup holds on ${problem} without a cancellation receipt`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.backup.enqueueDue(f.hostId);
              const capture = (yield* f.backup.claim(f.hostId))!,
                snapshotId = `failed-${capture.operationId}`,
                sourceBuildID = NodeCrypto.randomUUID(),
                identity = {
                  snapshotId,
                  sourceTemplateId: snapshotId,
                  sourceBuildId: sourceBuildID,
                };
              yield* f.backup.beginCapture(capture);
              if (problem === "verifier failure or lost prepare acknowledgement") {
                yield* f.backup.recordCapture(capture, identity);
                const verifier = (yield* f.backup.claim(f.hostId))!;
                // The external prepare may have committed before its reply failed.
                yield* f.backup.fail(verifier);
              } else yield* f.backup.failCapture(capture, identity);
              if (problem === "probe evidence")
                yield* f.sql`UPDATE relay_thread_vm_backups SET probe_receipt='{}'::jsonb WHERE operation_id=${capture.operationId}`;
              yield* f.deletions.begin(f.deletionInput);
              let deletes = 0,
                cancels = 0;
              const changeStop =
                f.sql`UPDATE relay_thread_vm_allocations SET deletion_stop_receipt=jsonb_set(deletion_stop_receipt,'{generation}','2'::jsonb) WHERE allocation_id=${f.allocationId}`.pipe(
                  Effect.orDie,
                );
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(f.info),
                  destroy: () => Effect.void,
                  deleteSnapshot: () =>
                    Effect.sync(() => {
                      deletes++;
                      return true;
                    }),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: () =>
                      Effect.gen(function* () {
                        cancels++;
                        return yield* new E2BRestoreError({
                          operation: "cancel",
                          reason: "http",
                          status: 404,
                        });
                      }),
                    ...(problem === "missing resolver"
                      ? {}
                      : {
                          resolveFailedNamedSnapshot: () =>
                            Effect.gen(function* () {
                              if (problem === "lookup unavailable")
                                return yield* new E2BRestoreError({
                                  operation: "failed snapshot",
                                  reason: "http",
                                  status: 503,
                                });
                              if (
                                problem === "building source" ||
                                problem === "verifier failure or lost prepare acknowledgement"
                              )
                                return null;
                              if (problem === "stop changed during lookup") yield* changeStop;
                              if (problem === "expired deletion claim")
                                yield* f.sql`UPDATE relay_thread_deletions SET claim_until=clock_timestamp()-interval '1 second' WHERE thread_id=${f.threadId}`.pipe(
                                  Effect.orDie,
                                );
                              return {
                                snapshotId: problem === "wrong snapshot" ? "different" : snapshotId,
                                sourceTemplateID:
                                  problem === "wrong template" ? "different" : snapshotId,
                                sourceBuildID:
                                  problem === "wrong build"
                                    ? NodeCrypto.randomUUID()
                                    : sourceBuildID,
                              };
                            }),
                        }),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              const retry = Effect.gen(function* () {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              });
              yield* retry;
              if (problem === "wrong stop generation") yield* changeStop;
              yield* retry;
              yield* retry;
              expect(deletes).toBe(0);
              expect((yield* f.backup.get(capture.operationId))?.phase).toBe("failed");
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("cleaning");
              if (
                ![
                  "lookup unavailable",
                  "stop changed during lookup",
                  "expired deletion claim",
                ].includes(problem)
              )
                expect(cancels).toBe(1);
            }),
          ),
        );
      it.effect(
        "saved-only deletion waits for tunnel and cold-probe cleanup before retiring its disk root",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              const stop = (yield* f.store.claimDeletion(f.hostId))!;
              yield* f.store.beginDeletion(stop);
              yield* f.store.confirmDeleted(stop);
              yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              let endpointReady = false,
                probeReady = false,
                snapshots = 0,
                cancels = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("Saved VM cannot be inspected or woken"),
                  destroy: () => Effect.die("Saved VM is already physically stopped"),
                  deleteSnapshot: () =>
                    Effect.sync(() => {
                      snapshots++;
                      return true;
                    }),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: (operationID, generation) =>
                      Effect.sync(() => {
                        cancels++;
                        return {
                          operationID,
                          generation,
                          sandboxID: "probe",
                          executionID: NodeCrypto.randomUUID(),
                          preparedBuildID: NodeCrypto.randomUUID(),
                          state: probeReady ? ("cancelled" as const) : ("active" as const),
                        };
                      }),
                  },
                },
                f.hostId,
                () => Effect.succeed(endpointReady),
              );
              yield* worker.runOne();
              expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe(
                "endpoint_cleanup_unconfirmed",
              );
              expect(snapshots).toBe(0);
              const retry = Effect.gen(function* () {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              });
              endpointReady = true;
              yield* retry;
              yield* retry;
              expect((yield* f.deletions.get(f.threadId))?.errorCode).toBe(
                "snapshot_cleanup_unconfirmed",
              );
              expect(snapshots).toBe(0);
              expect(cancels).toBe(1);
              probeReady = true;
              yield* retry;
              expect(snapshots).toBe(1);
              const [pending] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId} AND state!='deleted'`;
              for (let pass = 0; pass < pending!.count; pass++) yield* retry;
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
              expect(snapshots).toBe(1);
            }),
          ),
      );
      it.effect(
        "deleting one saved thread leaves another thread's disk and conversation intact",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                other = yield* fixture();
              let otherNativePoint: string | undefined;
              for (const source of [f, other]) {
                yield* source.store.begin(source.input);
                const point = yield* source.freeze;
                if (source.threadId === other.threadId)
                  otherNativePoint = point.native.header.operationId;
                yield* source.verifyBackup;
                yield* source.store.recordSaved(source.input.operationId);
                const stop = (yield* source.store.claimDeletion(source.hostId))!;
                yield* source.store.beginDeletion(stop);
                yield* source.store.confirmDeleted(stop);
              }
              const [saved] = yield* f.sql<{
                snapshotId: string;
              }>`SELECT snapshot_id AS "snapshotId" FROM relay_thread_vm_backups WHERE allocation_id=${f.allocationId}`;
              const [otherSaved] = yield* f.sql<{
                snapshotId: string;
              }>`SELECT snapshot_id AS "snapshotId" FROM relay_thread_vm_backups WHERE allocation_id=${other.allocationId}`;
              expect(saved!.snapshotId).not.toBe(otherSaved!.snapshotId);
              yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              const snapshots: string[] = [];
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("Saved compute must not be resumed"),
                  destroy: () => Effect.die("Saved compute was already physically stopped"),
                  deleteSnapshot: (snapshotId) =>
                    Effect.sync(() => {
                      snapshots.push(snapshotId);
                      return true;
                    }),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: (operationID, generation) =>
                      Effect.succeed({
                        operationID,
                        generation,
                        state: "cancelled" as const,
                        sandboxID: "backup-probe",
                        executionID: NodeCrypto.randomUUID(),
                        preparedBuildID: NodeCrypto.randomUUID(),
                      }),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              const [pending] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId}`;
              for (let pass = 0; pass < pending!.count + 4; pass++) {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              }
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
              expect(snapshots).toEqual([saved!.snapshotId]);
              const rows = yield* f.sql<{
                allocationId: string;
                phase: string;
              }>`SELECT allocation_id AS "allocationId",phase FROM relay_thread_vm_backups WHERE allocation_id IN (${f.allocationId},${other.allocationId})`;
              expect(rows).toContainEqual({ allocationId: f.allocationId, phase: "retired" });
              expect(rows).toContainEqual({ allocationId: other.allocationId, phase: "verified" });
              expect(yield* other.deletions.get(other.threadId)).toBeNull();
              expect(yield* other.attachmentStore.get(otherNativePoint!)).not.toBeNull();
            }),
          ),
      );
      it.effect(
        "a crashed reader's finite lease delays object deletion until its recorded expiry",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                catalog = makeThreadArtifactStore(f.sql);
              const bytes = new TextEncoder().encode("retained reader bytes");
              const artifact = yield* f.transfer.upload({
                artifactId: NodeCrypto.randomUUID(),
                operationId: NodeCrypto.randomUUID(),
                threadId: f.threadId,
                kind: "attachment",
                sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                sizeBytes: bytes.length,
                retentionDays: null,
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                }),
              });
              const readerId = NodeCrypto.randomUUID();
              yield* catalog.pin({
                artifactId: artifact.artifactId,
                threadId: f.threadId,
                operationId: readerId,
                leaseMinutes: 60,
              });
              yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(null),
                  destroy: () => Effect.void,
                  deleteSnapshot: () => Effect.die("No disk snapshots were created"),
                  restore: {
                    inspect: () => Effect.die("No boot restore"),
                    cancel: () => Effect.die("No restore was started"),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              const [pending] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId}`;
              const drain = Effect.gen(function* () {
                for (let pass = 0; pass < pending!.count + 4; pass++) {
                  yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                  yield* worker.runOne();
                }
              });
              yield* drain;
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("cleaning");
              expect((yield* catalog.get(artifact.artifactId))?.state).toBe("deleting");
              yield* f.objects.verify({
                key: artifact.storageKey,
                sha256: artifact.sha256,
                sizeBytes: artifact.sizeBytes,
              });
              yield* f.sql`UPDATE relay_thread_artifact_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=${readerId}`;
              yield* drain;
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
              expect((yield* catalog.get(artifact.artifactId))?.state).toBe("deleted");
              yield* Effect.flip(
                f.objects.verify({
                  key: artifact.storageKey,
                  sha256: artifact.sha256,
                  sizeBytes: artifact.sizeBytes,
                }),
              );
            }),
          ),
      );
      for (const problem of [
        "lost-stop",
        "lost-snapshot",
        "foreign-receipt",
        "activating",
      ] as const) {
        it.effect(`cleans a completed restore safely after ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              const deletion = (yield* f.store.claimDeletion(f.hostId))!;
              yield* f.store.beginDeletion(deletion);
              yield* f.store.confirmDeleted(deletion);
              const operationId = NodeCrypto.randomUUID(),
                allocationId = NodeCrypto.randomUUID();
              yield* makeThreadVmRestoreStore(f.sql, f.objects).begin({
                operationId,
                allocationId,
                threadId: f.threadId,
                savedDiskOperationId: f.input.operationId,
                actorUserId: f.input.actorUserId,
                expectedGeneration: 1,
                serving: true,
              });
              const boot: E2BRestoreStatus = {
                operationID: operationId,
                generation: "2",
                sandboxID: `boot-${allocationId}`,
                executionID: NodeCrypto.randomUUID(),
                preparedBuildID: NodeCrypto.randomUUID(),
                state: "active",
              };
              const probe = {
                ...boot,
                operationID: restoreProbeOperationId(operationId),
                generation: restoreComputeGeneration(operationId),
                state: "prepared" as const,
              };
              // Seed an already completed restore whose allocation catalog was retired.
              // Its historical runtime receipt still requires a positive physical stop.
              yield* f.sql`UPDATE relay_thread_vm_restores SET phase='completed',prepare_started_at=clock_timestamp(),prepared_receipt=${f.sql.json(probe)},probe_removed_at=clock_timestamp(),boot_prepare_started_at=clock_timestamp(),boot_receipt=${f.sql.json(boot)},committed_at=clock_timestamp() WHERE operation_id=${operationId}`;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',compute_ref=${boot.sandboxID},deleted_at=clock_timestamp() WHERE allocation_id=${allocationId}`;
              yield* f.sql`UPDATE relay_thread_placements SET generation=2,operation_id=NULL WHERE thread_id=${f.threadId}`;
              yield* f.deletions.begin({ ...f.deletionInput, generation: 2, sourceDeleted: true });
              let ready = false,
                stops = 0;
              const deleted: string[] = [];
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(null),
                  destroy: (id) =>
                    Effect.gen(function* () {
                      expect(id).toBe(boot.sandboxID);
                      stops++;
                      if (!ready && problem === "lost-stop")
                        return yield* new ThreadVmComputeError({
                          operation: "delete",
                          message: "Lost stop reply",
                        });
                    }),
                  deleteSnapshot: (id) =>
                    Effect.gen(function* () {
                      const removed = !deleted.includes(id);
                      if (removed) deleted.push(id);
                      if (!ready && problem === "lost-snapshot")
                        return yield* new ThreadVmComputeError({
                          operation: "delete snapshot",
                          message: "Lost snapshot reply",
                        });
                      return removed;
                    }),
                  restore: {
                    inspect: () =>
                      Effect.succeed({
                        ...boot,
                        ...(!ready && problem === "foreign-receipt"
                          ? { executionID: NodeCrypto.randomUUID() }
                          : {}),
                        state:
                          problem === "activating"
                            ? ready
                              ? ("failed" as const)
                              : ("activating" as const)
                            : ("active" as const),
                      }),
                    cancel: (operationID, generation) => {
                      expect(operationID).not.toBe(boot.operationID);
                      return Effect.succeed({
                        ...probe,
                        operationID,
                        generation,
                        state: "cancelled" as const,
                      });
                    },
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              const retry = Effect.gen(function* () {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              });
              yield* retry; // Remove the old endpoint.
              yield* retry; // Reconcile the exact completed boot.
              const cleaned = Effect.gen(function* () {
                const [row] = yield* f.sql<{
                  cleaned: boolean;
                }>`SELECT deletion_cleaned_at IS NOT NULL AS cleaned FROM relay_thread_vm_restores WHERE operation_id=${operationId}`;
                return row!.cleaned;
              });
              expect(yield* cleaned).toBe(false);
              expect(deleted).toEqual(problem === "lost-snapshot" ? [boot.sandboxID] : []);
              if (problem === "foreign-receipt") expect(stops).toBe(0);
              ready = true;
              yield* retry;
              expect(yield* cleaned).toBe(true);
              expect(deleted).toEqual([boot.sandboxID]);
              expect(stops).toBe(problem === "foreign-receipt" ? 1 : 2);
              const [pending] = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId}`;
              for (let pass = 0; pass < pending!.count + 4; pass++) yield* retry;
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
            }),
          ),
        );
      }
      it.effect(
        "active operation admission rejects permanent deletion without revoking its source",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.store.begin(f.input);
              yield* Effect.flip(f.authorized(permanentlyDeleteThread(f.threadId, f.payload)));
              expect(yield* f.deletions.get(f.threadId)).toBeNull();
              const [key] = yield* f.sql<{
                revoked: boolean;
              }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_environment_credentials WHERE credential_id=${f.credentialId}`;
              expect(key?.revoked).toBe(false);
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("running");
            }),
          ),
      );
    });
  },
);
