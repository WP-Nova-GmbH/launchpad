import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { make as makeWorkflows } from "../jobs/Workflows.ts";
import { listSavedWorkflowResults } from "../http/WorkflowResultsApi.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Redacted from "effect/Redacted";
import { RelayClientPrincipal, RelayThreadDeletionRequest } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { makeThreadVmBackupSourceStore } from "./ThreadVmBackupSourceStore.ts";
import { makeThreadDeletionWorker } from "./ThreadDeletionWorker.ts";
import { permanentlyDeleteThread, getThreadDeletion } from "../http/ThreadDeletionApi.ts";
const decodeDeletionRequest = Schema.decodeUnknownEffect(RelayThreadDeletionRequest);
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
    userId: string = input.ownerUserId,
    enabled = true,
  ) =>
    action.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(ThreadArtifactObjectStorage, f.objects),
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
const nativeCompute = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  ({
    inspect: () => Effect.succeed(f.info),
    destroy: () => Effect.void,
    deleteSnapshot: () => Effect.succeed(true),
    restore: { resolveTerminalNamedSnapshot: () => Effect.succeed(null) },
  }) satisfies Parameters<typeof makeThreadDeletionWorker>[2];
const addCapture = Effect.fnUntraced(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  phase: "creating" | "verified" | "pending" = "creating",
) {
  const operationId = NodeCrypto.randomUUID(),
    sourceBuildId = NodeCrypto.randomUUID(),
    snapshotId = `snapshot-${operationId}`;
  const source = {
    allocationId: f.allocationId,
    computeRef: f.computeRef,
    threadId: f.threadId,
    generation: 1,
    environmentId: f.sourceEnvironmentId,
    provisionOperationId: f.allocationId,
    captureOperationId: NodeCrypto.randomUUID(),
    bootId: NodeCrypto.randomUUID(),
    sealEpoch: 1,
    sourceSequence: 1,
    nativeCheckpointOperationId: NodeCrypto.randomUUID(),
  };
  const { allocationId, computeRef, threadId, generation, ...seal } = source;
  const receipt = {
    version: 1,
    kind: "native-full-snapshot-v1",
    operationId,
    allocationId,
    computeRef,
    threadId,
    generation,
    snapshotId,
    sourceTemplateId: snapshotId,
    sourceBuildId,
    source: seal,
  };
  yield* f.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,source_receipt,native_capture_receipt,snapshot_id,source_template_id,source_build_id,capture_started_at,verified_at)
    VALUES(${operationId},${f.allocationId},1,${f.computeRef},${`launchpad-backup-${operationId}`},${phase},${f.sql.json(source)},${phase === "verified" ? f.sql.json(receipt) : null},${phase === "verified" ? snapshotId : null},${phase === "verified" ? snapshotId : null},${phase === "verified" ? sourceBuildId : null},${phase === "pending" ? null : "2026-10-01T00:00:00Z"}::timestamptz,${phase === "verified" ? "2026-10-01T00:00:00Z" : null}::timestamptz)`;
  return { operationId, snapshotId, sourceBuildId, source, receipt };
});
const drain = Effect.fnUntraced(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  worker: ReturnType<typeof makeThreadDeletionWorker>,
) {
  for (let i = 0; i < 120; i++) {
    if ((yield* f.deletions.get(f.threadId))?.phase === "completed") return;
    yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
    yield* worker.runOne();
  }
  expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "native permanent thread deletion (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("quarantines legacy allocations before deletion admission or worker cleanup", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.allocationId}`;
            expect((yield* Effect.flip(f.deletions.begin(f.deletionInput)))._tag).toBe(
              "ThreadDeletionConflict",
            );
            expect((yield* f.allocations.get(f.allocationId))?.state).toBe("running");
            expect(
              (yield* f.sql`SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${f.allocationId} AND revoked_at IS NULL`)
                .length,
            ).toBe(1);
            expect(yield* f.deletions.get(f.threadId)).toBeNull();
            // An old in-progress tombstone is preserved too, rather than resumed natively.
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='native-v1' WHERE allocation_id=${f.allocationId}`;
            yield* f.deletions.begin(f.deletionInput);
            const claim = (yield* f.deletions.claim(f.hostId))!;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.allocationId}`;
            expect((yield* Effect.flip(f.deletions.authorize(claim)))._tag).toBe(
              "ThreadDeletionConflict",
            );
            yield* f.sql`UPDATE relay_thread_deletions SET claim_id=NULL,claim_until=NULL WHERE thread_id=${f.threadId}`;
            expect(
              yield* makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  inspect: () => Effect.die("Legacy allocation must not be inspected"),
                  destroy: () => Effect.die("Legacy allocation must not be deleted"),
                },
                f.hostId,
              ).runOne(),
            ).toBe(false);
            expect((yield* f.deletions.get(f.threadId))?.phase).toBe("stopping");
            expect(
              (yield* f.sql<{
                state: string;
              }>`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.allocationId}`)[0]
                ?.state,
            ).toBe("started");
            const artifacts = yield* f.sql`SELECT artifact_id,state FROM relay_thread_artifacts
              WHERE thread_id=${f.threadId} ORDER BY artifact_id`;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp()
              WHERE allocation_id=${f.allocationId}`;
            expect(
              yield* makeThreadDeletionWorker(
                f.sql,
                f.objects,
                nativeCompute(f),
                f.hostId,
              ).runOne(),
            ).toBe(false);
            expect(
              yield* f.sql`SELECT artifact_id,state FROM relay_thread_artifacts
              WHERE thread_id=${f.threadId} ORDER BY artifact_id`,
            ).toEqual(artifacts);
            expect((yield* f.deletions.get(f.threadId))?.phase).toBe("stopping");
          }),
        ),
      );
      it.effect(
        "known cancelled provisioning keeps quota until its creating phase is durably settled",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.sql`UPDATE relay_thread_vm_provisions SET phase='creating' WHERE allocation_id=${f.allocationId}`;
              yield* f.deletions.begin(f.deletionInput);
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  inspect: () => Effect.die("Creating allocation must not be inspected"),
                  destroy: () => Effect.die("Creating allocation must not be deleted"),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
              expect(
                (yield* f.sql<{
                  state: string;
                }>`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.allocationId}`)[0]
                  ?.state,
              ).toBe("started");
              yield* f.sql`UPDATE relay_thread_vm_provisions SET phase='created' WHERE allocation_id=${f.allocationId}`;
              const settled = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                nativeCompute(f),
                f.hostId,
                () => Effect.succeed(true),
              );
              yield* drain(f, settled);
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleted");
            }),
          ),
      );
      for (const marker of ["provision", "resume"] as const) {
        it.effect(
          `an unsettled ${marker} ingress call blocks inspect/delete and quota release after claim expiry`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                if (marker === "provision")
                  yield* f.sql`UPDATE relay_thread_vm_provisions SET ingress_recovery_claim_id='old-claim',claim_id='old-claim',claim_until=clock_timestamp()-interval '1 minute' WHERE allocation_id=${f.allocationId}`;
                if (marker === "resume")
                  yield* f.sql`INSERT INTO relay_thread_vm_resumes(allocation_id,operation_id,generation,phase,connect_claim_id) VALUES(${f.allocationId},${NodeCrypto.randomUUID()},1,'resuming','old-claim')`;
                if (marker === "resume") {
                  expect((yield* Effect.flip(f.deletions.begin(f.deletionInput)))._tag).toBe(
                    "ThreadDeletionConflict",
                  );
                  expect((yield* f.allocations.get(f.allocationId))?.state).toBe("running");
                  return;
                }
                yield* f.deletions.begin(f.deletionInput);
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    ...nativeCompute(f),
                    inspect: () => Effect.die("Unsettled connect must not inspect"),
                    destroy: () => Effect.die("Unsettled connect must not delete"),
                  },
                  f.hostId,
                );
                yield* worker.runOne();
                expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
                expect(
                  (yield* f.sql<{
                    state: string;
                  }>`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.allocationId}`)[0]
                    ?.state,
                ).toBe("started");
              }),
            ),
        );
      }
      it.effect(
        "a missing terminal capture alias holds the VM and quota after deletion revoked its old binding",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* addCapture(f);
              yield* f.deletions.begin(f.deletionInput);
              let reads = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  destroy: () => Effect.die("Unresolved upload must not delete"),
                  restore: {
                    resolveTerminalNamedSnapshot: () => {
                      reads++;
                      return Effect.succeed(null);
                    },
                  },
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(reads).toBe(1);
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
              expect(
                (yield* f.sql<{
                  state: string;
                }>`SELECT state FROM relay_thread_vm_capacity WHERE allocation_id=${f.allocationId}`)[0]
                  ?.state,
              ).toBe("started");
              expect(
                (yield* f.sql<{
                  revoked: boolean;
                }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_thread_vm_bindings WHERE allocation_id=${f.allocationId}`)[0]
                  ?.revoked,
              ).toBe(true);
            }),
          ),
      );
      it.effect(
        "observes the exact terminal native capture before deleting its VM and retiring its logical snapshot",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                capture = yield* addCapture(f);
              yield* f.deletions.begin(f.deletionInput);
              const calls: string[] = [];
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  destroy: () =>
                    Effect.sync(() => {
                      calls.push("vm-delete");
                    }),
                  deleteSnapshot: (id) =>
                    Effect.sync(() => {
                      calls.push(`snapshot-delete:${id}`);
                      return true;
                    }),
                  restore: {
                    resolveTerminalNamedSnapshot: (name) =>
                      Effect.sync(() => {
                        calls.push(`terminal:${name}`);
                        return {
                          snapshotId: capture.snapshotId,
                          sourceTemplateID: capture.snapshotId,
                          sourceBuildID: capture.sourceBuildId,
                        };
                      }),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              yield* drain(f, worker);
              expect(calls[0]).toBe(`terminal:launchpad-backup-${capture.operationId}`);
              expect(calls.indexOf("vm-delete")).toBeGreaterThan(0);
              expect(calls.indexOf(`snapshot-delete:${capture.snapshotId}`)).toBeGreaterThan(
                calls.indexOf("vm-delete"),
              );
              const [row] = yield* f.sql<{
                phase: string;
                receipt: unknown;
              }>`SELECT phase,native_capture_receipt AS receipt FROM relay_thread_vm_backups WHERE operation_id=${capture.operationId}`;
              expect(row).toEqual({ phase: "retired", receipt: null });
              expect((yield* f.deletions.get(f.threadId))?.phase).toBe("completed");
            }),
          ),
      );
      for (const problem of ["source", "operation", "alias"] as const) {
        it.effect(
          `an uncertain native capture with wrong ${problem} cannot reach external deletion`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  capture = yield* addCapture(f);
                yield* f.deletions.begin(f.deletionInput);
                if (problem === "source")
                  yield* f.sql`UPDATE relay_thread_vm_backups SET source_receipt=${f.sql.json({ ...capture.source, computeRef: "other" })} WHERE operation_id=${capture.operationId}`;
                if (problem === "operation")
                  yield* f.sql`UPDATE relay_thread_vm_backups SET source_receipt=${f.sql.json({ ...capture.source, provisionOperationId: NodeCrypto.randomUUID() })} WHERE operation_id=${capture.operationId}`;
                if (problem === "alias")
                  yield* f.sql`UPDATE relay_thread_vm_backups SET snapshot_name='other' WHERE operation_id=${capture.operationId}`;
                const worker = makeThreadDeletionWorker(
                  f.sql,
                  f.objects,
                  {
                    ...nativeCompute(f),
                    destroy: () => Effect.die("Wrong snapshot must not delete"),
                    restore: {
                      resolveTerminalNamedSnapshot: () =>
                        Effect.die("Wrong identity must not inspect alias"),
                    },
                  },
                  f.hostId,
                );
                yield* worker.runOne();
                expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
              }),
            ),
        );
      }
      it.effect("lost VM DELETE reply holds quota and retries only the same exact ID", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.deletions.begin(f.deletionInput);
            let calls = 0;
            const worker = makeThreadDeletionWorker(
              f.sql,
              f.objects,
              {
                ...nativeCompute(f),
                destroy: (id) => {
                  expect(id).toBe(f.computeRef);
                  return ++calls === 1
                    ? Effect.fail(
                        new ThreadVmComputeError({ operation: "destroy", message: "lost reply" }),
                      )
                    : Effect.void;
                },
              },
              f.hostId,
              () => Effect.succeed(true),
            );
            yield* worker.runOne();
            expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
            yield* drain(f, worker);
            expect(calls).toBe(2);
            expect(
              (yield* f.sql<{
                receipt: unknown;
              }>`SELECT deletion_stop_receipt AS receipt FROM relay_thread_vm_allocations WHERE allocation_id=${f.allocationId}`)[0]
                ?.receipt,
            ).toMatchObject({ kind: "native-delete-acknowledgement", acknowledged: true });
          }),
        ),
      );
      it.effect(
        "native deletion preserves existing historical certificates and never sends their extension commands",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                historical = {
                  physicallyStopped: true,
                  captureAdmissionSealed: true,
                  from: "old-host",
                };
              yield* f.sql`UPDATE relay_thread_vm_allocations SET deletion_stop_receipt=${f.sql.json(historical)} WHERE allocation_id=${f.allocationId}`;
              yield* f.deletions.begin(f.deletionInput);
              yield* drain(
                f,
                makeThreadDeletionWorker(f.sql, f.objects, nativeCompute(f), f.hostId, () =>
                  Effect.succeed(true),
                ),
              );
              expect(
                (yield* f.sql<{
                  receipt: unknown;
                }>`SELECT deletion_stop_receipt AS receipt FROM relay_thread_vm_allocations WHERE allocation_id=${f.allocationId}`)[0]
                  ?.receipt,
              ).toEqual(historical);
            }),
          ),
      );
      it.effect(
        "historical cold snapshot evidence stays quarantined rather than being treated as native completion",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                capture = yield* addCapture(f, "verified");
              yield* f.sql`UPDATE relay_thread_vm_backups SET native_capture_receipt=NULL,source_receipt=NULL,probe_receipt=${f.sql.json({ legacy: true })} WHERE operation_id=${capture.operationId}`;
              yield* f.deletions.begin(f.deletionInput);
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  deleteSnapshot: () => Effect.die("Historical root requires migration"),
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              for (let i = 0; i < 5; i++) {
                yield* f.sql`UPDATE relay_thread_deletions SET retry_at=clock_timestamp() WHERE thread_id=${f.threadId}`;
                yield* worker.runOne();
              }
              expect((yield* f.deletions.get(f.threadId))?.phase).not.toBe("completed");
              expect(
                (yield* f.sql<{
                  phase: string;
                }>`SELECT phase FROM relay_thread_vm_backups WHERE operation_id=${capture.operationId}`)[0]
                  ?.phase,
              ).toBe("verified");
            }),
          ),
      );
      it.effect(
        "permanent deletion requires explicit workspace-loss confirmation and current private owner access",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* Effect.flip(
                decodeDeletionRequest({
                  ...f.payload,
                  confirmWorkspaceLoss: false,
                }),
              );
              yield* Effect.flip(
                f.authorized(permanentlyDeleteThread(f.threadId, f.payload), "other-user"),
              );
              expect(yield* f.deletions.get(f.threadId)).toBeNull();
              const deletion = yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              expect(deletion.phase).toBe("stopping");
              expect((yield* f.authorized(getThreadDeletion(f.threadId)))?.operationId).toBe(
                f.deletionInput.operationId,
              );
            }),
          ),
      );
      it.effect(
        "uses durable native terminal failure identity without inventing a completed backup or re-reading its alias",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                capture = yield* addCapture(f),
                claim = (yield* f.backup.claim(f.hostId))!;
              yield* f.backup.recordFailure(claim, {
                snapshotId: capture.snapshotId,
                sourceTemplateId: capture.snapshotId,
                sourceBuildId: capture.sourceBuildId,
              });
              yield* f.deletions.begin(f.deletionInput);
              let deletes = 0;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                {
                  ...nativeCompute(f),
                  deleteSnapshot: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(capture.snapshotId);
                      deletes++;
                      return true;
                    }),
                  restore: {
                    resolveTerminalNamedSnapshot: () =>
                      Effect.die("Positive failure was durably recorded"),
                  },
                },
                f.hostId,
                () => Effect.succeed(true),
              );
              yield* drain(f, worker);
              expect(deletes).toBe(1);
              const [row] = yield* f.sql<{
                phase: string;
                receipt: unknown;
              }>`SELECT phase,native_capture_receipt AS receipt FROM relay_thread_vm_backups WHERE operation_id=${capture.operationId}`;
              expect(row).toEqual({ phase: "retired", receipt: null });
            }),
          ),
      );
      it.effect("never-dispatched native failures do not create an upload hold", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const capture = yield* addCapture(f, "pending");
            const cancelled = yield* makeThreadVmBackupSourceStore(f.sql, f.objects).cancelPending({
              threadId: f.threadId,
              environmentId: f.sourceEnvironmentId,
              generation: 1,
              operationId: capture.operationId,
            });
            expect(cancelled.phase).toBe("failed");
            yield* f.deletions.begin(f.deletionInput);
            const worker = makeThreadDeletionWorker(
              f.sql,
              f.objects,
              {
                ...nativeCompute(f),
                restore: {
                  resolveTerminalNamedSnapshot: () => Effect.die("No upload was dispatched"),
                },
              },
              f.hostId,
              () => Effect.succeed(true),
            );
            yield* drain(f, worker);
            expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleted");
          }),
        ),
      );
      it.effect(
        "legacy failed captures with a dispatch intent remain quarantined with their VM quota",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                capture = yield* addCapture(f);
              yield* f.sql`UPDATE relay_thread_vm_backups SET phase='failed',source_receipt=NULL WHERE operation_id=${capture.operationId}`;
              yield* Effect.flip(f.deletions.begin(f.deletionInput));
              expect((yield* f.allocations.get(f.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect(
        "deletes a shared workflow through the real API and worker after confirmed cleanup",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const jobId = NodeCrypto.randomUUID();
              const userId = f.deletionInput.ownerUserId;
              const record = {
                jobId,
                workflowId: "workflow",
                repositoryId: "repo",
                origin: { kind: "manual", userId },
                instruction: "test",
                workflow: null,
                vmAdmission: { codexConnectionId: NodeCrypto.randomUUID(), hasSecrets: false },
                detail: null,
                status: "done",
                runtime: { kind: "vm", threadId: f.threadId },
                progress: {
                  revision: 1,
                  threadId: f.threadId,
                  status: "done",
                  detail: null,
                  checkpoint: null,
                  hasThread: true,
                  executionReleased: false,
                  resultSaving: {
                    publicationId: NodeCrypto.randomUUID(),
                    resultId: null,
                    state: "saving",
                    detail: null,
                    retryable: false,
                  },
                },
                createdAt: "now",
                updatedAt: "now",
              };
              yield* f.sql`INSERT INTO relay_workflow_jobs(job_id,organization_id,repository_id,submitter_user_id,status,record,revision,created_at,checked_at) VALUES(${jobId},'org','repo',${userId},'done',${f.sql.json(record)},0,'now','now')`;
              yield* f.sql`UPDATE relay_thread_placements SET audience='repository',owner_user_id=NULL,workflow_job_id=${jobId} WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET resource_kind='organization_workflow',owner_user_id=NULL WHERE allocation_id=${f.allocationId}`;
              const scope = { repositoryId: "repo", jobId };
              // A repository member may inspect results, but cannot destroy the shared thread.
              expect(yield* f.authorized(listSavedWorkflowResults(scope))).toMatchObject({
                results: [],
              });
              expect(
                (yield* Effect.result(f.authorized(permanentlyDeleteThread(f.threadId, f.payload))))
                  ._tag,
              ).toBe("Failure");
              yield* f.sql`UPDATE relay_repository_access SET role='maintainer' WHERE repository_id='repo' AND user_id=${userId}`;
              // Terminal status does not substitute for the executor's stopping proof.
              expect(
                (yield* Effect.result(f.authorized(permanentlyDeleteThread(f.threadId, f.payload))))
                  ._tag,
              ).toBe("Failure");
              yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{progress,executionReleased}','true') WHERE job_id=${jobId}`;
              const wrongGeneration = { ...f.payload, expectedGeneration: 2 };
              expect(
                (yield* Effect.result(
                  f.authorized(permanentlyDeleteThread(f.threadId, wrongGeneration)),
                ))._tag,
              ).toBe("Failure");
              // Saved catalog ownership is retired by the same physical deletion worker.
              const publicationId = NodeCrypto.randomUUID(),
                resultId = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_workflow_saved_results(result_id,job_id,thread_id,turn_id,revision,result,native_checkpoint_operation_id)
                VALUES(${resultId},${jobId},${f.threadId},'turn',1,${f.sql.json({ resultId })},${f.native.header.operationId})`;
              yield* f.sql`INSERT INTO relay_workflow_recovery_records(publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest)
                VALUES(${publicationId},${jobId},${f.threadId},1,${f.native.artifactId},${"a".repeat(64)},1,${f.sql.json({ publicationId })})`;
              yield* f.sql`INSERT INTO relay_workflow_recovery_heads(job_id,publication_id,revision) VALUES(${jobId},${publicationId},1)`;
              yield* f.sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id) VALUES(${f.native.artifactId},${`workflow-result:${resultId}`}) ON CONFLICT DO NOTHING`;
              const jobs = yield* f.authorized(makeWorkflows);
              const stale = (yield* jobs.claim(jobId))!;
              const deleted = yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload));
              expect((yield* jobs.getJob(jobId))?.record.progress).toMatchObject({
                hasThread: false,
                threadDeletionRequested: true,
              });
              expect(
                (yield* Effect.result(
                  jobs.updateJob(stale, stale.record, null, true, stale.leaseUntil!),
                ))._tag,
              ).toBe("Failure");
              expect((yield* jobs.getJob(jobId))?.record.progress?.threadDeletionRequested).toBe(
                true,
              );
              expect(yield* f.authorized(permanentlyDeleteThread(f.threadId, f.payload))).toEqual(
                deleted,
              );
              expect(yield* f.deletions.get(f.threadId)).toMatchObject({
                audience: "repository",
                ownerUserId: null,
                requesterUserId: userId,
                workflowJobId: jobId,
              });
              expect(
                (yield* Effect.result(f.authorized(listSavedWorkflowResults(scope))))._tag,
              ).toBe("Failure");
              yield* f.sql`DELETE FROM relay_repository_access WHERE user_id=${userId}`;
              const worker = makeThreadDeletionWorker(
                f.sql,
                f.objects,
                nativeCompute(f),
                f.hostId,
                () => Effect.succeed(true),
              );
              yield* drain(f, worker);
              expect((yield* f.allocations.getAny(f.allocationId))?.state).toBe("deleted");
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_artifacts WHERE thread_id=${f.threadId} AND state!='deleted'`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_workflow_saved_results WHERE thread_id=${f.threadId}`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_workflow_recovery_records WHERE thread_id=${f.threadId}`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_workflow_recovery_heads WHERE job_id=${jobId}`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_artifact_pins WHERE operation_id=${`workflow-result:${resultId}`}`,
              ).toHaveLength(0);
              expect((yield* f.authorized(getThreadDeletion(f.threadId))).phase).toBe("completed");
            }),
          ),
      );
    });
  },
);
