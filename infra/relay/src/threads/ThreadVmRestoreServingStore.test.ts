import { RelaySecretBox } from "../auth/SecretBox.ts";
import { makeThreadVmEnrollmentStore } from "./ThreadVmEnrollmentStore.ts";
import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import * as FileSystem from "effect/FileSystem";
import {
  inspectE2BThreadVmConnection,
  type E2BThreadVmIdentity,
} from "../machines/E2BThreadVmConnection.ts";
import { makeThreadVmRestoreImportStore } from "./ThreadVmRestoreImportStore.ts";
import { makeThreadVmRestoreImportWorker } from "./ThreadVmRestoreImportWorker.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Stream from "effect/Stream";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import {
  getThreadVmRestoreRecovery,
  readThreadVmRestoreArtifact,
  confirmThreadVmRestoreActivation,
} from "../http/ThreadVmRestoreRecoveryApi.ts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Redacted from "effect/Redacted";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import {
  restoreThreadVm,
  getThreadVmRestore,
  cancelThreadVmRestore,
} from "../http/ThreadVmRestoreApi.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { E2BRestoreError, type E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import {
  makeThreadVmRestoreStore,
  restoreComputeGeneration,
  restoreProbeOperationId,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmRestoreServingStore } from "./ThreadVmRestoreServingStore.ts";
import { makeThreadVmRestoreServingWorker } from "./ThreadVmRestoreServingWorker.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const fixture = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${f.input.actorUserId},'admin','now','now')`;
  yield* f.store.begin(f.input);
  const point = yield* f.freeze;
  yield* f.verifyBackup;
  yield* f.store.recordSaved(f.input.operationId);
  const deletion = (yield* f.store.claimDeletion(f.hostId))!;
  yield* f.store.beginDeletion(deletion);
  yield* f.store.confirmDeleted(deletion);
  const input = {
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    savedDiskOperationId: f.input.operationId,
    threadId: f.threadId,
    actorUserId: f.input.actorUserId,
    expectedGeneration: 1,
    serving: true,
  };
  const restores = makeThreadVmRestoreStore(f.sql, f.objects),
    serving = makeThreadVmRestoreServingStore(f.sql, f.objects);
  const prepared = (operationID: string, sandboxID: string): E2BRestoreStatus => {
    const preparedBuildID = NodeCrypto.randomUUID();
    return {
      operationID,
      sandboxID,
      preparedBuildID,
      executionID: NodeCrypto.randomUUID(),
      generation:
        operationID === input.operationId ? "2" : restoreComputeGeneration(input.operationId),
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
  const probe = prepared(restoreProbeOperationId(input.operationId), "probe-" + input.allocationId),
    boot = prepared(input.operationId, "boot-" + input.allocationId);
  const retry = f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp() WHERE operation_id=${input.operationId}`;
  const prepare = Effect.gen(function* () {
    yield* restores.begin(input);
    yield* makeThreadVmRestoreWorker(
      f.sql,
      f.objects,
      {
        prepare: () => Effect.succeed(probe),
        inspect: () => Effect.die("Unexpected inspect"),
        cancel: () => Effect.die("Unexpected cancel"),
      },
      f.hostId,
    ).runOne();
    yield* retry;
    const claim = (yield* serving.claim(f.hostId))!;
    yield* serving.recordProbeRemoved(claim, { ...probe, state: "cancelled" });
    yield* serving.beginPrepare(claim);
    yield* serving.recordPrepared(claim, boot);
    return (yield* serving.claim(f.hostId))!;
  });
  return {
    ...f,
    input,
    point,
    restores,
    serving,
    probe,
    boot,
    retry,
    prepare,
    capacity: makeThreadVmCapacityStore(f.sql),
    placements: makeThreadPlacementStore(f.sql),
    natives: makeThreadNativeCheckpointStore(f.sql, f.objects),
  };
});

const importedFixture = Effect.fnUntraced(function* () {
  const f = yield* fixture(),
    claim = yield* f.prepare;
  yield* f.serving.commit(claim, f.boot);
  yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
    ...f.boot,
    state: "active",
  });
  const credential = NodeCrypto.randomUUID(),
    environment = EnvironmentId.make("fresh-" + credential);
  yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES('github.com/test/repo','repo','org','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'fresh-key',${credential},'now','now')`;
  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${environment},${f.input.allocationId},${f.threadId},'repo',2,'fresh-key',${credential})`;
  yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at) VALUES(${f.input.allocationId},${f.input.operationId},${credential},${environment},'fresh-key',${credential},'sealed-fixture',clock_timestamp(),clock_timestamp())`;
  yield* makeThreadVmRestoreEnrollmentStore(f.sql).assigned({
    enrolled: true,
    operationId: f.input.operationId,
    allocationId: f.input.allocationId,
    environmentId: environment,
    threadId: ThreadId.make(f.threadId),
    generation: 2,
  });
  const db = yield* PgDrizzle.makeWithDefaults(),
    store = makeThreadVmRestoreImportStore(f.sql, f.objects);
  const principal = {
    environmentId: environment,
    environmentPublicKey: "fresh-key",
    credentialId: credential,
    threadVm: {
      allocationId: f.input.allocationId,
      threadId: ThreadId.make(f.threadId),
      repositoryId: "repo",
      generation: 2,
    },
  };
  const authorized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(ThreadArtifactObjectStorage, f.objects),
      Effect.provideService(RelayEnvironmentPrincipal, principal),
    );
  const owner = { threadId: f.threadId, environmentId: environment, generation: 2 },
    recovery = (yield* authorized(getThreadVmRestoreRecovery(owner)))!;
  const receipt: RelayThreadVmRestoreImportReceipt = {
    version: 1,
    operationId: f.input.operationId,
    environmentId: environment,
    scope: principal.threadVm,
    projectId: ProjectId.make(`vm:${f.threadId}`),
    workspaceRoot: "/workspace/project",
    checkoutPath: "/workspace/project",
    branch: "main",
    revision: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    sourceEnvironmentId: EnvironmentId.make(recovery.native.sourceEnvironmentId),
    sourceSequence: recovery.native.sourceSequence,
    nativeManifestArtifactId: recovery.native.manifestArtifactId,
    attachmentManifestArtifactId: recovery.attachments.manifestArtifactId,
    sequence: 10,
    execution: "frozen",
  };
  const imports = () => store.claim(f.hostId),
    worker = (
      deliver: Parameters<typeof makeThreadVmRestoreImportWorker>[2],
      start: Parameters<typeof makeThreadVmRestoreImportWorker>[3],
      cleanup: Parameters<typeof makeThreadVmRestoreImportWorker>[5] = () => Effect.void,
    ) => makeThreadVmRestoreImportWorker(f.sql, f.objects, deliver, start, f.hostId, cleanup);
  return {
    ...f,
    credential,
    environment,
    owner,
    authorized,
    receipt,
    importStore: store,
    imports,
    worker,
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "serving VM restore (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "commits a new generation before boot and keeps work fenced after its positive receipt",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
              yield* f.serving.commit(claim, f.boot);
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                operationId: f.input.operationId,
                environmentId: `pending-restore:${f.input.allocationId}`,
              });
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
              yield* Effect.flip(
                f.placements.admit({
                  ...f.owner,
                  generation: 2,
                  environmentId: `pending-restore:${f.input.allocationId}`,
                  workId: "before-boot",
                }),
              );
              const committed = (yield* f.serving.claim(f.hostId))!;
              yield* f.serving.recordActive(committed, { ...f.boot, state: "active" });
              expect(yield* f.allocations.get(f.input.allocationId)).toMatchObject({
                state: "running",
                computeRef: f.boot.sandboxID,
              });
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
              const allocation = (yield* f.allocations.get(f.input.allocationId))!;
              const connection = yield* Effect.promise(() =>
                inspectE2BThreadVmConnection(
                  {
                    apiUrl: "https://compute.invalid",
                    sandboxUrl: "https://sandbox.invalid",
                    apiKey: Redacted.make("management-fixture"),
                    templateId: "future-template:rollout",
                    hostAddresses: [],
                    timeoutMs: 600_000,
                  },
                  f.boot.sandboxID,
                  {
                    templateId: allocation.templateId,
                    operationId: f.input.operationId,
                    scope: {
                      allocationId: allocation.allocationId,
                      threadId: ThreadId.make(f.threadId),
                      repositoryId: "repo",
                      generation: 2,
                    },
                  },
                  async () =>
                    Response.json({
                      sandboxID: f.boot.sandboxID,
                      templateID: "snapshot",
                      state: "running",
                      envdVersion: "0.9",
                      envdAccessToken: "guest-fixture",
                      metadata: {
                        "launchpad.managed": "thread-vm-v1",
                        "launchpad.allocation_id": allocation.allocationId,
                        "launchpad.thread_id": f.threadId,
                        "launchpad.operation_id": f.input.operationId,
                        "launchpad.generation": "2",
                        "launchpad.restore": "v1",
                      },
                      lifecycle: { autoResume: false },
                    }),
                  new AbortController().signal,
                ),
              );
              expect(connection.sandboxId).toBe(f.boot.sandboxID);
              const [provision] =
                yield* f.sql`SELECT phase,generation FROM relay_thread_vm_provisions WHERE allocation_id=${f.input.allocationId}`;
              expect(provision).toMatchObject({ phase: "created", generation: 2 });
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              yield* Effect.flip(
                f.placements.admit({
                  ...f.owner,
                  generation: 2,
                  environmentId: `pending-restore:${f.input.allocationId}`,
                  workId: "after-boot-before-import",
                }),
              );
              expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
            }),
          ),
      );
      it.effect(
        "repairs an old restored image pin only for the surviving verified destination",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              yield* f.serving.commit(claim, f.boot);
              yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
                ...f.boot,
                state: "active",
              });
              const fs = yield* FileSystem.FileSystem;
              const migration = yield* fs.readFileString(
                new URL(
                  "../../migrations/postgres/20261009145000_thread_vm_restore_image_pin/migration.sql",
                  import.meta.url,
                ).pathname,
              );
              // Reproduce the old catalog while a different compute identity survives.
              yield* f.sql`UPDATE relay_thread_vm_allocations SET template_id='template:build-verified',
            compute_ref='another-guest' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql.unsafe(migration);
              expect((yield* f.allocations.get(f.input.allocationId))?.templateId).toBe(
                "template:build-verified",
              );
              yield* f.sql`UPDATE relay_thread_vm_allocations SET compute_ref=${f.boot.sandboxID}
            WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql.unsafe(migration);
              yield* f.sql.unsafe(migration);
              expect((yield* f.allocations.get(f.input.allocationId))?.templateId).toBe("snapshot");
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
            }),
          ),
      );
      it.effect(
        "cancellation wins over a late inspected boot preparation without changing generation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              yield* f.restores.requestAbort(f.input.operationId);
              yield* Effect.flip(f.serving.commit(claim, f.boot));
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
              let cancels = 0;
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.die("Cancelled"),
                  inspect: () => Effect.die("Cancelled"),
                  cancel: (operationId) =>
                    Effect.sync(() => {
                      expect(operationId).toBe(f.input.operationId);
                      cancels++;
                      return { ...f.boot, state: "cancelled" as const };
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(cancels).toBe(1);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborted");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("deleted");
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
            }),
          ),
      );
      it.effect("retries an unenrolled lost restore boot without rolling back placement", () =>
        Effect.gen(function* () {
          const f = yield* fixture(),
            claim = yield* f.prepare;
          yield* f.serving.commit(claim, f.boot);
          yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
            ...f.boot,
            state: "active",
          });
          const nextBuildId = NodeCrypto.randomUUID();
          const next = {
            ...f.boot,
            coldProbe: { ...f.boot.coldProbe!, preparedBuildID: nextBuildId },
            sandboxID: "retry-" + f.input.allocationId,
            preparedBuildID: nextBuildId,
            executionID: NodeCrypto.randomUUID(),
            generation: "2",
            operationID: restoreBootOperationId(f.input.operationId, 1),
          };
          let cancellations = 0;
          let inspected = { ...f.boot, state: "active" as E2BRestoreStatus["state"] };
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              prepare: (operation, request) =>
                Effect.sync(() => {
                  expect(operation).toBe(next.operationID);
                  expect(request.generation).toBe(next.generation);
                  expect(request.bootstrap?.generation).toBe(2);
                  return next;
                }),
              inspect: () => Effect.sync(() => inspected),
              cancel: () => Effect.die("Committed boot cannot be cancelled"),
              stopBoot: () =>
                Effect.sync(() => {
                  cancellations++;
                  return { ...f.boot, state: "active" as const, physicallyStopped: true as const };
                }),
              sandboxExists: () => Effect.succeed(false),
              activate: () => Effect.sync(() => ({ ...next, state: "active" as const })),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          const retry = (yield* f.restores.get(f.input.operationId))!;
          expect(retry).toMatchObject({
            phase: "committed",
            bootAttempt: 1,
            bootReceipt: null,
          });
          expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
          expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
          expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
          expect(cancellations).toBe(1);
          expect(yield* worker.runOne()).toBe(true);
          inspected = next;
          expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
          expect((yield* f.capacity.get(f.input.operationId))?.computeRef).toBe(next.sandboxID);
          expect(
            (yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId))?.generation,
          ).toBe(2);
          const [audit] =
            yield* f.sql`SELECT retired_boot_receipts FROM relay_thread_vm_restores WHERE operation_id=${f.input.operationId}`;
          expect(audit?.retired_boot_receipts).toEqual([
            { ...f.boot, state: "active", physicallyStopped: true },
          ]);
        }),
      );

      for (const state of ["failed", "cancelled"] as const) {
        it.effect(
          `retries ${state} committed boots and preparations without changing ownership`,
          () =>
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.serving.commit(yield* f.prepare, f.boot);
              const next = (attempt: number): E2BRestoreStatus => {
                const preparedBuildID = NodeCrypto.randomUUID();
                return {
                  ...f.boot,
                  operationID: restoreBootOperationId(f.input.operationId, attempt),
                  sandboxID: `retry-${attempt}-${f.input.allocationId}`,
                  executionID: NodeCrypto.randomUUID(),
                  preparedBuildID,
                  coldProbe: { ...f.boot.coldProbe!, preparedBuildID },
                };
              };
              const failedIdentity = next(1);
              const failedPreparation: E2BRestoreStatus = {
                operationID: failedIdentity.operationID,
                generation: failedIdentity.generation,
                sandboxID: failedIdentity.sandboxID,
                executionID: failedIdentity.executionID,
                preparedBuildID: failedIdentity.preparedBuildID,
                state,
              };
              const success = next(2);
              const stopped: E2BRestoreStatus[] = [];
              let inspected: E2BRestoreStatus = { ...f.boot, state: "prepared" };
              const worker = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.sync(() => inspected),
                  activate: () => Effect.succeed({ ...f.boot, state }),
                  prepare: (operation, request) =>
                    Effect.sync(() => {
                      expect(request.bootstrap?.operationId).toBe(f.input.operationId);
                      expect(request.bootstrap?.generation).toBe(2);
                      expect(request.sourceTemplateID).toBe("snapshot");
                      return operation === failedPreparation.operationID
                        ? failedPreparation
                        : success;
                    }),
                  stopBoot: (receipt) =>
                    Effect.sync(() => {
                      stopped.push(receipt);
                      return { ...receipt, physicallyStopped: true as const };
                    }),
                  cancel: () => Effect.die("Committed ownership cannot abort"),
                  sandboxExists: () => Effect.die("No absence-based recovery before boot"),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.restores.get(f.input.operationId))?.bootAttempt).toBe(1);
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.restores.get(f.input.operationId))?.bootAttempt).toBe(2);
              expect(stopped.map((receipt) => receipt.sandboxID)).toEqual([
                f.boot.sandboxID,
                failedPreparation.sandboxID,
              ]);
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect(yield* f.capacity.get(f.input.operationId)).toMatchObject({
                state: "started",
                computeRef: null,
                allocationId: f.input.allocationId,
              });
              expect(yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId)).toBeNull();
              expect(yield* worker.runOne()).toBe(true);
              inspected = { ...success, state: "active" };
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
              const [audit] =
                yield* f.sql`SELECT retired_boot_receipts FROM relay_thread_vm_restores WHERE operation_id=${f.input.operationId}`;
              expect(audit?.retired_boot_receipts).toEqual([
                { ...f.boot, state, physicallyStopped: true },
                { ...failedPreparation, physicallyStopped: true },
              ]);
            }),
        );
      }
      it.effect("a failed preparation cannot gain boot permission after a worker restart", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.serving.commit(yield* f.prepare, f.boot);
          const initial = (yield* f.serving.claim(f.hostId))!;
          yield* f.serving.beginBootRecovery(initial);
          yield* f.serving.retryStoppedBoot(initial, {
            ...f.boot,
            state: "failed",
            physicallyStopped: true,
          });
          const claim = (yield* f.serving.claim(f.hostId))!;
          yield* f.serving.beginPrepare(claim);
          const failed: E2BRestoreStatus = {
            operationID: restoreBootOperationId(f.input.operationId, 1),
            generation: "2",
            sandboxID: "failed-" + f.input.allocationId,
            preparedBuildID: NodeCrypto.randomUUID(),
            executionID: NodeCrypto.randomUUID(),
            state: "failed",
          };
          yield* f.serving.recordFailedPreparation(claim, failed);
          expect(
            yield* Effect.flip(f.serving.recordActive(claim, { ...failed, state: "active" })),
          ).toMatchObject({ _tag: "ThreadVmRestoreConflict" });
          yield* f.restores.defer(claim, "boot_unconfirmed");
          yield* f.retry;
          let stops = 0;
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              inspect: () => Effect.succeed({ ...failed, state: "active" as const }),
              stopBoot: (receipt) =>
                Effect.sync(() => {
                  stops++;
                  return { ...receipt, physicallyStopped: true as const };
                }),
              prepare: () => Effect.die("No new preparation before stop"),
              activate: () => Effect.die("Failed preparation cannot activate"),
              cancel: () => Effect.die("Committed ownership cannot abort"),
              sandboxExists: () => Effect.die("No absence-based recovery"),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect(stops).toBe(1);
          expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
            phase: "committed",
            bootAttempt: 2,
            bootReceipt: null,
          });
          expect(yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId)).toBeNull();
        }),
      );
      it.effect("keeps a committed recovery fenced after a lost stop reply", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.serving.commit(yield* f.prepare, f.boot);
          let stops = 0;
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              inspect: () =>
                Effect.sync(() => ({
                  ...f.boot,
                  state: stops === 0 ? ("failed" as const) : ("prepared" as const),
                })),
              stopBoot: (receipt) =>
                Effect.gen(function* () {
                  stops++;
                  if (stops === 1)
                    return yield* new E2BRestoreError({
                      operation: "stop restore boot",
                      reason: "transport",
                    });
                  return { ...receipt, physicallyStopped: true as const };
                }),
              prepare: () => Effect.die("No new preparation before stop proof"),
              activate: () => Effect.die("A fenced boot cannot reactivate"),
              cancel: () => Effect.die("Committed ownership cannot abort"),
              sandboxExists: () => Effect.die("No absence-based recovery"),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
            phase: "committed",
            bootAttempt: 0,
            bootRecoveryStarted: true,
          });
          expect(yield* f.capacity.get(f.input.operationId)).toMatchObject({
            state: "started",
            computeRef: null,
          });
          yield* f.retry;
          expect(yield* worker.runOne()).toBe(true);
          expect(stops).toBe(2);
          expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
            phase: "committed",
            bootAttempt: 1,
            bootRecoveryStarted: false,
          });
        }),
      );
      it.effect("does not stop a committed boot with unexpected enrollment ownership", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.serving.commit(yield* f.prepare, f.boot);
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              inspect: () =>
                Effect.gen(function* () {
                  yield* f.sql`INSERT INTO relay_thread_vm_provisions (allocation_id,operation_id,generation,phase)
              VALUES (${f.input.allocationId},${f.input.operationId},2,'created')`;
                  return { ...f.boot, state: "failed" as const };
                }).pipe(Effect.orDie),
              stopBoot: () => Effect.die("Unexpected ownership must not stop"),
              prepare: () => Effect.die("No replacement"),
              activate: () => Effect.die("No activation"),
              cancel: () => Effect.die("No cancellation"),
              sandboxExists: () => Effect.die("No absence-based recovery"),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
            phase: "committed",
            bootAttempt: 0,
            bootRecoveryStarted: false,
          });
        }),
      );

      it.effect("fences an unused enrollment seed before stopping a lost boot", () =>
        Effect.gen(function* () {
          const f = yield* fixture(),
            claim = yield* f.prepare;
          yield* f.serving.commit(claim, f.boot);
          yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
            ...f.boot,
            state: "active",
          });
          const store = makeThreadVmEnrollmentStore(f.sql);
          const withBox = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(RelaySecretBox, { seal: Effect.succeed, open: Effect.succeed }),
            );
          const seed = yield* withBox(store.prepare(f.input));
          const recovery = (yield* f.serving.claim(f.hostId))!;
          yield* f.serving.beginBootRecovery(recovery);
          expect(yield* withBox(Effect.flip(store.prepare(f.input)))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          let issued = 0;
          expect(
            yield* withBox(
              Effect.flip(
                store.exchange(
                  {
                    ...f.input,
                    seed,
                    environmentId: "late-guest",
                    environmentPublicKey: "late-key",
                  },
                  Effect.sync(() => {
                    issued++;
                    return { credentialId: "late", response: Redacted.make("late") };
                  }),
                ),
              ),
            ),
          ).toMatchObject({ _tag: "ThreadVmEnrollmentInvalid" });
          expect(issued).toBe(0);
          yield* f.serving.retryStoppedBoot(recovery, {
            ...f.boot,
            state: "active",
            physicallyStopped: true,
          });
          expect((yield* f.restores.get(f.input.operationId))?.bootRecoveryStarted).toBe(false);
          expect((yield* f.restores.get(f.input.operationId))?.bootAttempt).toBe(1);
        }),
      );
      it.effect("does not stop a boot whose identity was issued after inspection began", () =>
        Effect.gen(function* () {
          const f = yield* fixture(),
            claim = yield* f.prepare;
          yield* f.serving.commit(claim, f.boot);
          yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
            ...f.boot,
            state: "active",
          });
          const credential = NodeCrypto.randomUUID(),
            environment = "late-" + credential;
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              prepare: () => Effect.die("No replacement"),
              activate: () => Effect.die("No activation"),
              sandboxExists: () => Effect.succeed(false),
              cancel: () => Effect.die("Committed boot cannot be cancelled"),
              stopBoot: () => Effect.die("Issued identity must not stop"),
              inspect: () =>
                Effect.gen(function* () {
                  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'late-key',${credential},'now','now')`;
                  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${environment},${f.input.allocationId},${f.threadId},'repo',2,'late-key',${credential})`;
                  return { ...f.boot, state: "failed" as const };
                }).pipe(Effect.orDie),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* f.restores.get(f.input.operationId))?.bootRecoveryStarted).toBe(false);
          expect((yield* f.restores.get(f.input.operationId))?.bootAttempt).toBe(0);
          expect((yield* f.capacity.get(f.input.operationId))?.computeRef).toBe(f.boot.sandboxID);
          yield* f.retry;
          expect(yield* worker.runOne()).toBe(false);
        }),
      );
      it.effect("refuses boot replacement without the exact stopped receipt", () =>
        Effect.gen(function* () {
          const f = yield* fixture(),
            claim = yield* f.prepare;
          yield* f.serving.commit(claim, f.boot);
          yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
            ...f.boot,
            state: "active",
          });
          const worker = makeThreadVmRestoreServingWorker(
            f.sql,
            f.objects,
            {
              prepare: () => Effect.die("No replacement without a stopped receipt"),
              inspect: () => Effect.succeed({ ...f.boot, state: "failed" as const }),
              cancel: () => Effect.die("Committed boot cannot be cancelled"),
              stopBoot: () =>
                Effect.succeed({
                  ...f.boot,
                  sandboxID: "foreign",
                  state: "failed" as const,
                  physicallyStopped: true as const,
                }),
              sandboxExists: () => Effect.succeed(true),
              activate: () => Effect.die("No activation"),
            },
            f.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
          expect((yield* f.capacity.get(f.input.operationId))?.computeRef).toBe(f.boot.sandboxID);
          expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
        }),
      );

      it.effect("commit wins over cancellation and cannot revive the old saved source", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              claim = yield* f.prepare;
            yield* f.serving.commit(claim, f.boot);
            yield* Effect.flip(f.restores.requestAbort(f.input.operationId));
            expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
            expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
            expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
          }),
        ),
      );
      it.effect(
        "lost activation reply inspects the same execution and never issues a second boot",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              yield* f.serving.commit(claim, f.boot);
              let activated = false,
                starts = 0,
                inspections = 0;
              const worker = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.die("No new preparation"),
                  cancel: () => Effect.die("Committed"),
                  inspect: () =>
                    Effect.sync(() => {
                      inspections++;
                      return {
                        ...f.boot,
                        state: activated ? ("active" as const) : ("prepared" as const),
                      };
                    }),
                  sandboxExists: () => Effect.succeed(true),
                  stopBoot: () => Effect.die("Unexpected physical stop"),
                  activate: () =>
                    Effect.gen(function* () {
                      starts++;
                      activated = true;
                      return yield* new E2BRestoreError({
                        operation: "activate",
                        reason: "transport",
                      });
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
              expect((yield* f.restores.get(f.input.operationId))?.errorCode).toBe(
                "boot_unconfirmed",
              );
              yield* f.retry;
              yield* worker.runOne();
              expect(starts).toBe(1);
              expect(inspections).toBe(2);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
            }),
          ),
      );
      for (const problem of [
        "foreign-operation",
        "foreign-generation",
        "foreign-sandbox",
        "foreign-execution",
        "foreign-build",
        "foreign-manifest",
        "missing-native",
        "lost-access",
        "live-old-credential",
      ] as const) {
        it.effect(`holds ownership and quota when pre-commit evidence has ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              if (problem === "missing-native")
                yield* f.sql`DELETE FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${f.point.native.header.operationId}`;
              if (problem === "lost-access")
                yield* f.sql`DELETE FROM relay_organization_members WHERE user_id=${f.input.actorUserId}`;
              if (problem === "live-old-credential")
                yield* f.sql`UPDATE relay_environment_credentials SET revoked_at=NULL WHERE credential_id=${f.credentialId}`;
              const receipt = {
                ...f.boot,
                ...(problem === "foreign-operation"
                  ? { operationID: NodeCrypto.randomUUID() }
                  : {}),
                ...(problem === "foreign-generation" ? { generation: "wrong" } : {}),
                ...(problem === "foreign-sandbox" ? { sandboxID: "other" } : {}),
                ...(problem === "foreign-execution"
                  ? { executionID: NodeCrypto.randomUUID() }
                  : {}),
                ...(problem === "foreign-build"
                  ? { preparedBuildID: NodeCrypto.randomUUID() }
                  : {}),
                ...(problem === "foreign-manifest" ? { manifestSHA256: "e".repeat(64) } : {}),
              };
              yield* Effect.flip(f.serving.commit(claim, receipt));
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
            }),
          ),
        );
      }
      it.effect("does not activate a host receipt for a different committed execution", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              claim = yield* f.prepare;
            yield* f.serving.commit(claim, f.boot);
            const worker = makeThreadVmRestoreServingWorker(
              f.sql,
              f.objects,
              {
                prepare: () => Effect.die("Already prepared"),
                cancel: () => Effect.die("Committed"),
                inspect: () => Effect.succeed({ ...f.boot, executionID: NodeCrypto.randomUUID() }),
                sandboxExists: () => Effect.succeed(true),
                stopBoot: () => Effect.die("Unexpected physical stop"),
                activate: () => Effect.die("Foreign execution must never boot"),
              },
              f.hostId,
            );
            yield* worker.runOne();
            expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
            expect((yield* f.allocations.get(f.input.allocationId))?.computeRef).toBeNull();
            expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
          }),
        ),
      );
      it.effect(
        "boot-enabled prepare retries one immutable source pair after a lost response",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.restores.begin(f.input);
              yield* makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.succeed(f.probe),
                  inspect: () => Effect.die("No inspect"),
                  cancel: () => Effect.die("No cancel"),
                },
                f.hostId,
              ).runOne();
              yield* f.retry;
              const requests: unknown[] = [];
              let tries = 0;
              const worker = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  cancel: () => Effect.succeed({ ...f.probe, state: "cancelled" }),
                  inspect: () => Effect.succeed(f.boot),
                  sandboxExists: () => Effect.succeed(true),
                  stopBoot: () => Effect.die("Unexpected physical stop"),
                  activate: () => Effect.die("Not committed"),
                  prepare: (operationId, input) =>
                    Effect.gen(function* () {
                      requests.push({ operationId, input });
                      tries++;
                      if (tries === 1)
                        return yield* new E2BRestoreError({
                          operation: "prepare",
                          reason: "transport",
                        });
                      return f.boot;
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              yield* f.retry;
              yield* worker.runOne();
              expect(requests).toHaveLength(2);
              expect(requests[0]).toEqual(requests[1]);
              expect(requests[0]).toMatchObject({
                operationId: f.input.operationId,
                input: {
                  bootstrap: { version: 1, generation: 2 },
                  metadata: { "launchpad.generation": "2" },
                },
              });
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("boot_prepared");
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(1);
              yield* worker.runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
            }),
          ),
      );
      it.effect(
        "retains both recovery pins and quota when boot preparation cleanup is uncertain",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.prepare;
              yield* f.restores.requestAbort(f.input.operationId);
              const worker = makeThreadVmRestoreWorker(
                f.sql,
                f.objects,
                {
                  prepare: () => Effect.die("Cancelled"),
                  inspect: () => Effect.die("No inspect"),
                  cancel: () =>
                    new E2BRestoreError({ operation: "cancel", reason: "http", status: 404 }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborting");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("reserved");
            }),
          ),
      );
      it.effect(
        "owner-only restore APIs remain gated and return status without contacting compute",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                db = yield* PgDrizzle.makeWithDefaults();
              const settings = {
                compute: {
                  apiUrl: "http://127.0.0.1:3000",
                  sandboxUrl: "http://127.0.0.1:3002",
                  apiKey: Redacted.make("test-key"),
                  templateId: "template:build-verified",
                  hostAddresses: ["192.0.2.1"],
                  timeoutMs: 600_000,
                },
                templateBuildId: "verified",
                hostId: f.hostId,
                maxRunningVms: 1,
                publicRelayUrl: "https://relay.example.test",
                autoPauseEnabled: false,
                autoBackupEnabled: false,
                autoDeleteEnabled: false,
                replacementEnabled: false,
                restoreEnabled: true,
                resetEnabled: false,
              };
              const authorized = <A, E, R>(
                action: Effect.Effect<A, E, R>,
                userId: string = f.input.actorUserId,
                enabled = true,
              ) =>
                action.pipe(
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
                  Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                  Effect.provideService(ThreadVmRuntimeConfiguration, {
                    settings: { ...settings, restoreEnabled: enabled },
                  }),
                );
              expect(
                yield* Effect.flip(
                  authorized(restoreThreadVm(f.threadId, f.input), f.input.actorUserId, false),
                ),
              ).toMatchObject({ _tag: "RelayInternalError", reason: "upstream_unavailable" });
              expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
              expect(
                yield* Effect.flip(
                  authorized(restoreThreadVm(f.threadId, f.input), "someone-else"),
                ),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              expect(yield* authorized(restoreThreadVm(f.threadId, f.input))).toMatchObject({
                status: "accepted",
                restore: { operationId: f.input.operationId, generation: 2, phase: "pending" },
              });
              expect(
                yield* authorized(getThreadVmRestore(f.threadId, f.input.operationId)),
              ).toMatchObject({ phase: "pending" });
              expect(
                yield* Effect.flip(
                  authorized(getThreadVmRestore(f.threadId, f.input.operationId), "someone-else"),
                ),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              expect(
                yield* authorized(cancelThreadVmRestore(f.threadId, f.input.operationId)),
              ).toMatchObject({ phase: "aborting" });
            }),
          ),
      );
      it.effect(
        "status retains the original saved disk while a committed restore awaits import",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                claim = yield* f.prepare;
              yield* f.serving.commit(claim, f.boot);
              expect(yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 2)).toMatchObject({
                restore: { phase: "committed", operationId: f.input.operationId, canCancel: false },
                savedDisk: { phase: "restoring" },
                capacityState: "started",
              });
              const bootClaim = (yield* f.serving.claim(f.hostId))!;
              yield* f.serving.recordActive(bootClaim, { ...f.boot, state: "active" });
              expect(yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 2)).toMatchObject({
                restore: { phase: "booted" },
                savedDisk: { phase: "restoring" },
                allocation: { state: "running" },
              });
              const retry = yield* f.restores.begin(f.input);
              expect(retry.phase).toBe("booted");
              expect((yield* f.placements.get(f.threadId))?.generation).toBe(2);
            }),
          ),
      );
      it.effect("assigns only the fresh installed identity and still holds queue execution", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              claim = yield* f.prepare;
            yield* f.serving.commit(claim, f.boot);
            yield* f.serving.recordActive((yield* f.serving.claim(f.hostId))!, {
              ...f.boot,
              state: "active",
            });
            const enrollment = makeThreadVmRestoreEnrollmentStore(f.sql),
              credential = NodeCrypto.randomUUID(),
              environment = "fresh-" + credential;
            const receipt = {
              enrolled: true as const,
              environmentId: EnvironmentId.make(environment),
              allocationId: f.input.allocationId,
              operationId: f.input.operationId,
              threadId: ThreadId.make(f.threadId),
              generation: 2,
            };
            expect(yield* enrollment.requested(receipt)).toBe(true);
            yield* Effect.flip(enrollment.assigned(receipt));
            yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'fresh-key',${credential},'now','now')`;
            yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${environment},${f.input.allocationId},${f.threadId},'repo',2,'fresh-key',${credential})`;
            yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at) VALUES(${f.input.allocationId},${f.input.operationId},${credential},${environment},'fresh-key',${credential},'sealed-fixture',clock_timestamp(),clock_timestamp())`;
            expect(yield* enrollment.assigned(receipt)).toBe(true);
            expect(yield* enrollment.assigned(receipt)).toBe(true);
            const db = yield* PgDrizzle.makeWithDefaults();
            const principal = {
              environmentId: receipt.environmentId,
              environmentPublicKey: "fresh-key",
              credentialId: credential,
              threadVm: {
                allocationId: receipt.allocationId,
                threadId: receipt.threadId,
                repositoryId: "repo",
                generation: 2,
              },
            };
            const owner = { threadId: f.threadId, environmentId: environment, generation: 2 };
            const authorized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.provideService(RelayDb, db),
                Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                Effect.provideService(RelayEnvironmentPrincipal, principal),
              );
            const recovery = yield* authorized(getThreadVmRestoreRecovery(owner));
            expect(recovery).toMatchObject({
              operationId: f.input.operationId,
              savedDiskOperationId: f.input.savedDiskOperationId,
              native: { captureOperationId: f.input.savedDiskOperationId, generation: 1 },
              attachments: { generation: 1 },
            });
            const artifact = {
              ...owner,
              operationId: f.input.operationId,
              artifactId: recovery!.native.manifestArtifactId,
            };
            const body = yield* authorized(readThreadVmRestoreArtifact(artifact));
            const chunks = yield* Stream.runCollect(body);
            expect(chunks.reduce((sum, bytes) => sum + bytes.length, 0)).toBeGreaterThan(0);
            for (const changed of [
              { ...artifact, operationId: NodeCrypto.randomUUID() },
              { ...artifact, artifactId: NodeCrypto.randomUUID() },
              { ...artifact, generation: 3 },
            ])
              yield* Effect.flip(authorized(readThreadVmRestoreArtifact(changed)));
            expect(
              (yield* authorized(getThreadVmRestoreRecovery(owner)))?.native.manifestArtifactId,
            ).toBe(recovery!.native.manifestArtifactId);

            expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
            expect(yield* f.placements.get(f.threadId)).toMatchObject({
              environmentId: environment,
              generation: 2,
              operationId: f.input.operationId,
            });
            yield* Effect.flip(
              f.placements.admit({
                ...f.owner,
                environmentId: environment,
                generation: 2,
                workId: "unimported",
              }),
            );
            yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${credential}`;
            yield* Effect.flip(enrollment.assigned(receipt));
            yield* Effect.flip(authorized(getThreadVmRestoreRecovery(owner)));
            expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
          }),
        ),
      );

      it.effect(
        "keeps import and launch fenced until exact fresh-credential readiness, then retries the acknowledgement",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture(),
                claim = (yield* f.imports())!;
              yield* Effect.flip(
                f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt)),
              );
              for (const changed of [
                { ...f.receipt, environmentId: EnvironmentId.make("other") },
                { ...f.receipt, attachmentManifestArtifactId: NodeCrypto.randomUUID() },
                { ...f.receipt, scope: { ...f.receipt.scope, generation: 3 } },
              ])
                yield* Effect.flip(f.authorized(f.importStore.record(claim, changed)));
              yield* f.authorized(f.importStore.record(claim, f.receipt));
              yield* f.authorized(f.importStore.record(claim, f.receipt));
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              yield* Effect.flip(
                f.authorized(
                  confirmThreadVmRestoreActivation(f.owner, { ...f.receipt, sequence: 11 }),
                ),
              );
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
              expect(
                yield* f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt)),
              ).toEqual({ ready: true });
              expect(
                yield* f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt)),
              ).toEqual({ ready: true });
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                environmentId: f.environment,
                projectId: f.receipt.projectId,
                operationId: null,
              });
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("completed");
              expect(
                (yield* makeThreadVmSavedDiskStore(f.sql).get(f.input.savedDiskOperationId))?.phase,
              ).toBe("restored");
              const [pins] =
                yield* f.sql`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${f.input.operationId}`;
              expect(pins?.phase).toBe("released");
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.credential}`;
              yield* Effect.flip(
                f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt)),
              );
            }),
          ),
      );
      it.effect(
        "retries a lost launch reply without importing again and uses restore startup after completion",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture();
              let imports = 0,
                starts = 0,
                cleanups = 0;
              const inspect = (identity: E2BThreadVmIdentity) =>
                Effect.promise(() =>
                  inspectE2BThreadVmConnection(
                    {
                      apiUrl: "https://compute.invalid",
                      sandboxUrl: "https://guest.invalid",
                      apiKey: Redacted.make("test"),
                      templateId: "future-template:rollout",
                      hostAddresses: [],
                      timeoutMs: 600_000,
                    },
                    f.boot.sandboxID,
                    identity,
                    async () =>
                      Response.json({
                        sandboxID: f.boot.sandboxID,
                        templateID: "snapshot",
                        state: "running",
                        envdVersion: "0.9",
                        envdAccessToken: "guest-fixture",
                        metadata: {
                          "launchpad.managed": "thread-vm-v1",
                          "launchpad.allocation_id": f.input.allocationId,
                          "launchpad.operation_id": f.input.operationId,
                          "launchpad.thread_id": f.threadId,
                          "launchpad.generation": "2",
                          "launchpad.restore": "v1",
                        },
                        lifecycle: { autoResume: false },
                      }),
                    new AbortController().signal,
                  ),
                );
              const worker = f.worker(
                (_sandbox, _environment, identity) =>
                  Effect.gen(function* () {
                    yield* inspect(identity);
                    imports++;
                    return f.receipt;
                  }),
                (_sandbox, identity, digest, mode) =>
                  Effect.gen(function* () {
                    yield* inspect(identity);
                    starts++;
                    expect(mode).toBe("restore");
                    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
                    if (starts === 1)
                      return yield* new ThreadVmComputeError({
                        operation: "startup",
                        message: "lost reply",
                      });
                  }),
                (_sandbox, identity) =>
                  Effect.gen(function* () {
                    yield* inspect(identity);
                    cleanups++;
                  }),
              );
              yield* f.authorized(worker.runOne());
              expect(imports).toBe(1);
              expect(starts).toBe(1);
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              yield* f.retry;
              yield* f.authorized(worker.runOne());
              expect(imports).toBe(1);
              expect(starts).toBe(2);
              expect(cleanups).toBe(0);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
              yield* f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt));
              yield* f.retry;
              yield* f.authorized(worker.runOne());
              expect(imports).toBe(1);
              expect(starts).toBe(3);
              expect(cleanups).toBe(1);
              yield* f.retry;
              yield* f.authorized(worker.runOne());
              expect(imports).toBe(1);
              expect(starts).toBe(4);
              expect(cleanups).toBe(1);
              expect(
                yield* makeThreadVmProvisionStore(f.sql).claimStartup(
                  NodeCrypto.randomUUID(),
                  f.hostId,
                ),
              ).toBeNull();
            }),
          ),
      );
      it.effect(
        "rechecks authorization after importing and refuses startup when credentials or repository access changed",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              for (const revoke of ["credential", "membership"]) {
                const f = yield* importedFixture();
                let starts = 0;
                const worker = f.worker(
                  () =>
                    Effect.gen(function* () {
                      if (revoke === "credential")
                        yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.credential}`;
                      else
                        yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id='org' AND user_id=${f.input.actorUserId}`;
                      return f.receipt;
                    }).pipe(Effect.orDie),
                  () =>
                    Effect.sync(() => {
                      starts++;
                    }),
                );
                yield* f.authorized(worker.runOne());
                expect(starts).toBe(0);
                expect((yield* f.placements.get(f.threadId))?.operationId).toBe(
                  f.input.operationId,
                );
                expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
              }
            }),
          ),
      );
    });
  },
);
