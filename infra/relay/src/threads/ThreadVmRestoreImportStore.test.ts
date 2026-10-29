import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeThreadVmRestoreServingWorker } from "./ThreadVmRestoreServingWorker.ts";
import * as Redacted from "effect/Redacted";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayEnvironmentPrincipal,
  type RelayThreadVmRestoreImportReceipt,
} from "@t3tools/contracts/relay";
import {
  inspectE2BThreadVmConnection,
  type E2BThreadVmIdentity,
} from "../machines/E2BThreadVmConnection.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import {
  getThreadVmRestoreRecovery,
  confirmThreadVmRestoreActivation,
} from "../http/ThreadVmRestoreRecoveryApi.ts";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeThreadVmEnrollmentStore } from "./ThreadVmEnrollmentStore.ts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import { makeThreadVmRestoreImportStore } from "./ThreadVmRestoreImportStore.ts";
import { makeThreadVmRestoreImportWorker } from "./ThreadVmRestoreImportWorker.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { nativeRestoreFixture, nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";
const importedFixture = Effect.fnUntraced(function* () {
  const f = yield* nativeRestoreFixture();
  yield* f.boot;
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
    boot: { sandboxID: f.sandboxId },
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
  "native restore import readiness (Postgres)",
  () => {
    layer(nativeRestoreTestLayer)((it) => {
      it.effect(
        "legacy targets cannot enroll, import or activate through native restore paths",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture(),
                claim = (yield* f.imports())!;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.input.allocationId}`;
              expect(yield* f.imports()).toBeNull();
              expect((yield* Effect.flip(f.authorized(f.importStore.authorize(claim))))._tag).toBe(
                "ThreadVmRestoreConflict",
              );
              expect(
                (yield* Effect.flip(
                  makeThreadVmEnrollmentStore(f.sql).prepare({
                    allocationId: f.input.allocationId,
                    operationId: f.input.operationId,
                  }),
                ))._tag,
              ).toBe("ThreadVmEnrollmentInvalid");
              expect(
                yield* makeThreadVmRestoreEnrollmentStore(f.sql).requested({
                  allocationId: f.input.allocationId,
                  operationId: f.input.operationId,
                  threadId: f.threadId,
                  generation: 2,
                }),
              ).toBe(false);
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
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
      it.effect("healthy serving checks do not starve import on consecutive scheduler ticks", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* importedFixture();
            let imports = 0,
              starts = 0;
            const monitor = makeThreadVmRestoreServingWorker(
              f.sql,
              f.objects,
              {
                ...f.compute,
                inspect: () => Effect.die("Healthy importing rows belong to ImportWorker"),
              },
              f.hostId,
              f.bootstrap,
            );
            const importer = f.worker(
              () =>
                Effect.sync(() => {
                  imports++;
                  return f.receipt;
                }),
              () =>
                Effect.sync(() => {
                  starts++;
                }),
            );
            expect(yield* monitor.runOne()).toBe(false);
            yield* f.authorized(importer.runOne());
            yield* f.retry;
            expect(yield* monitor.runOne()).toBe(false);
            yield* f.authorized(importer.runOne());
            expect(imports).toBe(1);
            expect(starts).toBe(2);
            expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
          }),
        ),
      );
      it.effect(
        "a failed unactivated target revokes only its fresh identity and retries the pinned snapshot at the committed generation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture();
              let deletes = 0;
              yield* f.sql`UPDATE relay_thread_vm_restores SET error_code='import_unconfirmed' WHERE operation_id=${f.input.operationId}`;
              const worker = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  inspect: () => Effect.succeed(null),
                  destroy: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(f.sandboxId);
                      deletes++;
                    }),
                },
                f.hostId,
                f.bootstrap,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(deletes).toBe(1);
              expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
                phase: "committed",
                targetGeneration: 2,
                sourceGeneration: 1,
                bootAttempt: 1,
                bootReceipt: null,
                bootstrapReceipt: null,
              });
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                operationId: f.input.operationId,
                environmentId: `pending-restore:${f.input.allocationId}`,
              });
              expect(
                (yield* f.sql<{
                  revoked: boolean;
                }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_environment_credentials WHERE credential_id=${f.credential}`)[0]
                  ?.revoked,
              ).toBe(true);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${f.input.allocationId}`,
              ).toHaveLength(0);
              const [pin] = yield* f.sql<{
                phase: string;
              }>`SELECT phase FROM relay_thread_native_checkpoint_operations WHERE operation_id=${f.input.operationId}`;
              expect(pin?.phase).toBe("active");
              yield* Effect.flip(
                f.authorized(
                  f.importStore.authorize({
                    operationId: f.input.operationId,
                    claimId: "obsolete",
                  }),
                ),
              );
            }),
          ),
      );
      it.effect(
        "activation that commits during a disappearance check wins without deleting the completed destination",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture(),
                claim = (yield* f.imports())!;
              yield* f.authorized(f.importStore.record(claim, f.receipt));
              yield* f.sql`UPDATE relay_thread_vm_restores SET error_code='import_unconfirmed',claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              const inspected = yield* Deferred.make<void>(),
                reply = yield* Deferred.make<null>();
              let deletes = 0;
              const monitor = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  inspect: () =>
                    Deferred.succeed(inspected, undefined).pipe(
                      Effect.andThen(Deferred.await(reply)),
                    ),
                  destroy: () =>
                    Effect.sync(() => {
                      deletes++;
                    }),
                },
                f.hostId,
                f.bootstrap,
              );
              const fiber = yield* Effect.forkChild(monitor.runOne());
              yield* Deferred.await(inspected);
              yield* f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt));
              yield* Deferred.succeed(reply, null);
              yield* Fiber.join(fiber);
              expect(deletes).toBe(0);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("completed");
              expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
            }),
          ),
      );
      it.effect(
        "uncertain restore ingress blocks import, activation and enrollment until settlement and durable token refresh",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* importedFixture(),
                importClaim = (yield* f.imports())!;
              yield* f.authorized(f.importStore.record(importClaim, f.receipt));
              yield* f.sql`UPDATE relay_thread_vm_restores SET error_code='import_unconfirmed',claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              const claim = (yield* f.serving.claim(f.hostId))!;
              yield* f.serving.beginIngressRecovery(claim, f.sandboxId);
              yield* f.sql`UPDATE relay_thread_vm_restores SET claim_until=clock_timestamp()-interval '1 minute' WHERE operation_id=${f.input.operationId}`;
              expect(yield* f.imports()).toBeNull();
              yield* Effect.flip(
                f.authorized(confirmThreadVmRestoreActivation(f.owner, f.receipt)),
              );
              yield* Effect.flip(
                makeThreadVmEnrollmentStore(f.sql).prepare({
                  allocationId: f.input.allocationId,
                  operationId: f.input.operationId,
                }),
              );
              yield* Effect.flip(
                makeThreadVmRestoreEnrollmentStore(f.sql).assigned({
                  enrolled: true,
                  operationId: f.input.operationId,
                  allocationId: f.input.allocationId,
                  threadId: ThreadId.make(f.threadId),
                  generation: 2,
                  environmentId: f.environment,
                }),
              );
              expect(
                (yield* f.sql<{
                  secret: string | null;
                }>`SELECT sealed_traffic_access_token AS secret FROM relay_thread_vm_allocations WHERE allocation_id=${f.input.allocationId}`)[0]
                  ?.secret,
              ).toBeNull();
              yield* f.serving.settleIngressRecovery(claim, f.sandboxId);
              let connects = 0,
                starts = 0;
              const monitor = makeThreadVmRestoreServingWorker(
                f.sql,
                f.objects,
                {
                  ...f.compute,
                  recoverIngress: () => {
                    connects++;
                    return f.compute.recoverIngress();
                  },
                },
                f.hostId,
                f.bootstrap,
              );
              yield* monitor.runOne();
              expect(connects).toBe(1);
              yield* f.authorized(
                f
                  .worker(
                    () => Effect.die("Import bytes were already durably recorded"),
                    () =>
                      Effect.sync(() => {
                        starts++;
                      }),
                  )
                  .runOne(),
              );
              expect(starts).toBe(1);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("importing");
            }),
          ),
      );
    });
  },
);
