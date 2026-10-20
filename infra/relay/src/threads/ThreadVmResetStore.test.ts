import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import * as Stream from "effect/Stream";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import {
  getThreadVmRestoreRecovery,
  readThreadVmRestoreArtifact,
  confirmThreadVmRestoreActivation,
} from "../http/ThreadVmRestoreRecoveryApi.ts";
import { makeThreadVmResetImportStore } from "./ThreadVmResetImportStore.ts";
import { makeThreadVmResetImportWorker } from "./ThreadVmResetImportWorker.ts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Redacted from "effect/Redacted";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { resetThreadVm, getThreadVmReset, cancelThreadVmReset } from "../http/ThreadVmResetApi.ts";
import { ThreadId, EnvironmentId } from "@t3tools/contracts";
import { makeThreadVmResetEnrollmentStore } from "./ThreadVmResetEnrollmentStore.ts";
import { makeThreadVmResetCancellationWorker } from "./ThreadVmResetCancellationWorker.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeThreadVmResetStore } from "./ThreadVmResetStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { makeThreadMoveCheckpointStore } from "./ThreadMoveCheckpointStore.ts";
const decodeRestoreReceipt = Schema.decodeUnknownEffect(RelayThreadVmRestoreImportReceipt);
const fixture = Effect.fnUntraced(function* (
  expire = true,
  state: "running" | "paused" = "running",
) {
  const f = yield* finalSaveCatalogFixture(state);
  yield* f.store.begin(f.input);
  yield* f.freeze;
  yield* f.verifyBackup;
  yield* f.store.recordSaved(f.input.operationId);
  const deletion = (yield* f.store.claimDeletion(f.hostId))!;
  yield* f.store.beginDeletion(deletion);
  yield* f.store.confirmDeleted(deletion);
  const saved = makeThreadVmSavedDiskStore(f.sql);
  if (expire) {
    yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.operationId}`;
    const expiry = (yield* saved.claimExpired(f.hostId))!;
    expect(yield* saved.completeExpiry(expiry)).toBe(true);
  }
  const canonicalKey = `github.com/reset/${f.threadId}`;
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${canonicalKey},'repo','org','now')`;
  const input = {
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    threadId: f.threadId,
    actorUserId: f.input.actorUserId,
    expectedGeneration: 1,
    hostId: f.hostId,
    templateId: "template:build-verified",
    canonicalKey,
    branch: "main",
    revision: "b".repeat(40),
  };
  const repositoryUpload = yield* repositoryUploadCatalogFixture(
    f.sql,
    f.objects,
    f.threadId,
    input.revision,
  );
  return {
    ...f,
    sourceAllocationId: f.input.allocationId,
    input,
    repositoryUpload,
    saved,
    resets: makeThreadVmResetStore(f.sql, f.objects),
    placements: makeThreadPlacementStore(f.sql),
    natives: makeThreadNativeCheckpointStore(f.sql, f.objects),
  };
});
const created = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  yield* f.resets.begin(f.input);
  const provisions = makeThreadVmProvisionStore(f.sql),
    capacity = makeThreadVmCapacityStore(f.sql);
  yield* capacity.admitNext(f.hostId);
  const claimId = NodeCrypto.randomUUID();
  yield* provisions.claim(claimId, f.hostId);
  yield* provisions.beginCreate({ allocationId: f.input.allocationId, claimId });
  const computeRef = "reset-" + f.input.allocationId;
  yield* provisions.recordCreated({ allocationId: f.input.allocationId, claimId, computeRef });
  return { computeRef, provisions };
});
const enrolled = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const compute = yield* created(f),
    credentialId = NodeCrypto.randomUUID(),
    environmentId = EnvironmentId.make("reset-environment-" + credentialId);
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
    VALUES(${credentialId},${environmentId},'reset-key',${credentialId},'now','now')`;
  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
    VALUES(${environmentId},${f.input.allocationId},${f.threadId},'repo',2,'reset-key',${credentialId})`;
  yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
    VALUES(${f.input.allocationId},${f.input.operationId},${credentialId},${environmentId},'reset-key',${credentialId},'sealed-fixture',clock_timestamp(),clock_timestamp())`;
  const receipt = {
    enrolled: true as const,
    operationId: f.input.operationId,
    allocationId: f.input.allocationId,
    environmentId,
    threadId: ThreadId.make(f.threadId),
    generation: 2,
  };
  return {
    ...compute,
    credentialId,
    environmentId,
    receipt,
    assign: makeThreadVmResetEnrollmentStore(f.sql).assigned,
  };
});
const api = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const db = yield* PgDrizzle.makeWithDefaults();
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${f.input.actorUserId},'member','now','now')`;
  yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at) VALUES('repo','org',${f.input.actorUserId},'developer','now','now')`;
  const authorize = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    userId = f.input.actorUserId,
    enabled = true,
  ) =>
    effect.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(ThreadArtifactObjectStorage, f.objects),
      Effect.provideService(RelayClientPrincipal, {
        userId,
        token: "fixture-token",
      }),
      Effect.provideService(ThreadVmRuntimeConfiguration, {
        settings: {
          compute: {
            apiUrl: "https://compute.invalid",
            sandboxUrl: "https://sandbox.invalid",
            apiKey: Redacted.make("fixture-management"),
            templateId: f.input.templateId,
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
          resetEnabled: enabled,
        },
      }),
    );
  const { operationId, allocationId, expectedGeneration, canonicalKey, branch, revision } = f.input;
  const payload = { operationId, allocationId, expectedGeneration, canonicalKey, branch, revision };
  return { authorize, payload };
});
const importing = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const a = yield* api(f),
    e = yield* enrolled(f);
  yield* e.assign(e.receipt);
  const store = makeThreadVmResetImportStore(f.sql, f.objects);
  const claim = (yield* store.claim(f.hostId))!;
  const recovery = yield* a.authorize(store.recovery(f.input.operationId));
  const receipt = yield* decodeRestoreReceipt({
    version: 1,
    operationId: f.input.operationId,
    environmentId: e.environmentId,
    scope: recovery.scope,
    projectId: `vm:${f.threadId}`,
    workspaceRoot: "/workspace/project",
    checkoutPath: "/workspace/project",
    branch: f.input.branch,
    revision: f.input.revision,
    repositoryBundleSha256: f.repositoryUpload.bundle.sha256,
    manifestSha256: "e".repeat(64),
    sourceEnvironmentId: recovery.native.sourceEnvironmentId,
    sourceSequence: recovery.native.sourceSequence,
    nativeManifestArtifactId: recovery.native.manifestArtifactId,
    attachmentManifestArtifactId: recovery.attachments.manifestArtifactId,
    sequence: 23,
    execution: "frozen",
  });
  return { ...a, ...e, store, claim, recovery, receipt };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "Reset VM admission (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const problem of [
        "none",
        "foreign-thread",
        "foreign-generation",
        "foreign-operation",
        "foreign-compute",
        "missing",
        "unavailable",
        "lost-stop",
        "changed-claim",
        "changed-placement",
        "changed-provision",
      ] as const) {
        it.effect(
          `cancelled Reset VM cleanup reconciles unavailable pause status: ${problem}`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  e = yield* enrolled(f);
                yield* f.resets.requestCancellation(f.input.operationId);
                let stops = 0;
                const worker = makeThreadVmResetCancellationWorker(
                  f.sql,
                  f.objects,
                  {
                    inspect: () =>
                      Effect.fail(
                        new ThreadVmComputeError({
                          operation: "inspect",
                          message: "Paused disk readiness is unavailable (409)",
                        }),
                      ),
                    inspectCreation: (operationId) =>
                      Effect.gen(function* () {
                        if (problem === "unavailable")
                          return yield* new ThreadVmComputeError({
                            operation: "inspect creation",
                            message: "Control plane unavailable",
                          });
                        if (problem === "changed-claim")
                          yield* f.sql`UPDATE relay_thread_vm_resets SET claim_id=${NodeCrypto.randomUUID()} WHERE operation_id=${f.input.operationId}`.pipe(
                            Effect.orDie,
                          );
                        if (problem === "changed-placement")
                          yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.threadId}`.pipe(
                            Effect.orDie,
                          );
                        if (problem === "changed-provision")
                          yield* f.sql`UPDATE relay_thread_vm_allocations SET compute_ref='changed-guest' WHERE allocation_id=${f.input.allocationId}`.pipe(
                            Effect.orDie,
                          );
                        return problem === "missing"
                          ? null
                          : {
                              operationId:
                                problem === "foreign-operation"
                                  ? NodeCrypto.randomUUID()
                                  : operationId,
                              computeRef:
                                problem === "foreign-compute" ? "foreign-guest" : e.computeRef,
                              metadata: {
                                "launchpad.managed": "thread-vm-v1",
                                "launchpad.allocation_id": f.input.allocationId,
                                "launchpad.operation_id": f.input.operationId,
                                "launchpad.thread_id":
                                  problem === "foreign-thread"
                                    ? NodeCrypto.randomUUID()
                                    : f.threadId,
                                "launchpad.generation":
                                  problem === "foreign-generation" ? "1" : "2",
                              },
                            };
                      }),
                    destroy: (id) =>
                      Effect.gen(function* () {
                        expect(id).toBe(e.computeRef);
                        expect(id).not.toBe(f.computeRef);
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
                expect((yield* f.resets.get(f.input.operationId))?.phase).toBe(
                  problem === "none" ? "cancelled" : "cancelling",
                );
                if (problem === "lost-stop") {
                  yield* f.sql`UPDATE relay_thread_vm_resets SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
                  yield* worker.runOne();
                  expect(stops).toBe(2);
                  expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("cancelled");
                }
                const retained = yield* f.natives.latestComplete(f.threadId);
                expect(retained).not.toBeNull();
                expect(yield* f.attachmentStore.get(retained!.operationId)).not.toBeNull();
                expect(
                  yield* makeThreadMoveCheckpointStore(f.sql, f.objects).repositoryUpload(
                    f.threadId,
                  ),
                ).toEqual(f.repositoryUpload);
                expect((yield* f.allocations.get(f.sourceAllocationId))?.state).toBe("deleted");
                expect(
                  (yield* f.saved.get(
                    (yield* f.resets.get(f.input.operationId))!.savedDiskOperationId,
                  ))?.phase,
                ).toBe("expired");
              }),
            ),
        );
      }
      it.effect(
        "reset cancellation cannot stop a replacement whose fresh enrollment committed first",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                e = yield* enrolled(f);
              yield* e.assign(e.receipt);
              yield* Effect.flip(f.resets.requestCancellation(f.input.operationId));
              const worker = makeThreadVmResetCancellationWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("Committed reset cannot enter cancellation cleanup"),
                  inspectCreation: () =>
                    Effect.die("Committed reset cannot inspect cleanup identity"),
                  destroy: () => Effect.die("Committed reset cannot destroy current compute"),
                },
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false);
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("importing");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              expect((yield* f.placements.get(f.threadId))?.environmentId).toBe(e.environmentId);
            }),
          ),
      );
      it.effect("does not select a replacement when the uploaded reset bundle loses its pins", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* api(f);
            const replacements = makeThreadVmReplacementCoordinator(f.sql, f.objects);
            const request = {
              requestId: f.input.operationId,
              threadId: f.threadId,
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: f.input.actorUserId,
              hostId: f.hostId,
              templateId: f.input.templateId,
              intent: {
                kind: "reset" as const,
                threadId: f.threadId,
                actorUserId: f.input.actorUserId,
                sourceEnvironmentId: f.sourceEnvironmentId,
                request: {
                  operationId: f.input.operationId,
                  allocationId: f.input.allocationId,
                  expectedGeneration: 1,
                  canonicalKey: f.input.canonicalKey,
                  branch: f.input.branch,
                  revision: f.input.revision,
                  confirmWorkspaceLoss: true as const,
                },
              },
            };
            yield* replacements.record(request);
            yield* f.sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${`move-repository:${f.repositoryUpload.operationId}`}`;
            expect(
              yield* Effect.flip(
                replacements.select({
                  requestId: request.requestId,
                  ownerUserId: request.ownerUserId,
                  victimAllocationId: f.sourceAllocationId,
                }),
              ),
            ).toMatchObject({ _tag: "ThreadVmReplacementConflict" });
            expect(yield* f.resets.get(request.requestId)).toBeNull();
            expect(yield* f.allocations.get(request.intent.request.allocationId)).toBeNull();
            expect(yield* replacements.get(request.requestId)).toMatchObject({
              phase: "awaiting_choice",
              finalSaveOperationId: null,
            });
          }),
        ),
      );
      it.effect("reset refuses a missing upload or another Git commit before reserving a VM", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* Effect.flip(f.resets.begin({ ...f.input, revision: "a".repeat(40) }));
            expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
            yield* f.sql`UPDATE relay_thread_move_checkpoints SET repository_retained=false WHERE thread_id=${f.threadId}`;
            yield* Effect.flip(f.resets.begin(f.input));
            expect(yield* f.allocations.get(f.input.allocationId)).toBeNull();
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
          }),
        ),
      );
      it.effect(
        "explicit owner reset API admits once and exposes status/cancel without starting compute",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                a = yield* api(f);
              for (let retry = 0; retry < 2; retry++)
                expect(yield* a.authorize(resetThreadVm(f.threadId, a.payload))).toMatchObject({
                  status: "accepted",
                  reset: { operationId: f.input.operationId, phase: "pending", generation: 2 },
                });
              expect(
                yield* a.authorize(getThreadVmReset(f.threadId, f.input.operationId)),
              ).toMatchObject({ phase: "pending" });
              expect(yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 1)).toMatchObject({
                reset: { operationId: f.input.operationId, phase: "pending" },
                savedDisk: {
                  operationId: (yield* f.resets.get(f.input.operationId))!.savedDiskOperationId,
                  phase: "expired",
                },
              });
              expect(
                yield* a.authorize(cancelThreadVmReset(f.threadId, f.input.operationId)),
              ).toMatchObject({ phase: "cancelling" });
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ computeRef: null, state: "deleting" });
            }),
          ),
      );
      it.effect(
        "default-off reset API and revoked repository access cannot reserve an allocation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                a = yield* api(f);
              yield* Effect.flip(
                a.authorize(resetThreadVm(f.threadId, a.payload), f.input.actorUserId, false),
              );
              expect(yield* f.resets.get(f.input.operationId)).toBeNull();
              yield* f.sql`DELETE FROM relay_repository_access WHERE user_id=${f.input.actorUserId}`;
              expect(
                (yield* Effect.flip(a.authorize(resetThreadVm(f.threadId, a.payload))))._tag,
              ).toBe("RelayTenancyNotFoundError");
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toBeNull();
            }),
          ),
      );
      it.effect(
        "another organization administrator cannot reset, inspect or cancel a private thread",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                a = yield* api(f),
                other = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${other},'admin','now','now')`;
              yield* a.authorize(resetThreadVm(f.threadId, a.payload));
              const errors = yield* Effect.all([
                Effect.flip(a.authorize(resetThreadVm(f.threadId, a.payload), other)),
                Effect.flip(a.authorize(getThreadVmReset(f.threadId, f.input.operationId), other)),
                Effect.flip(
                  a.authorize(cancelThreadVmReset(f.threadId, f.input.operationId), other),
                ),
              ]);
              expect(errors.map((error) => error._tag)).toEqual([
                "RelayTenancyNotFoundError",
                "RelayTenancyNotFoundError",
                "RelayTenancyNotFoundError",
              ]);
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("pending");
            }),
          ),
      );
      it.effect("status cannot use a reset operation to discover another thread", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              a = yield* api(f);
            yield* a.authorize(resetThreadVm(f.threadId, a.payload));
            expect(
              (yield* Effect.flip(
                a.authorize(getThreadVmReset(f.threadId, NodeCrypto.randomUUID())),
              ))._tag,
            ).toBe("RelayTenancyNotFoundError");
            expect(
              (yield* Effect.flip(
                a.authorize(cancelThreadVmReset(NodeCrypto.randomUUID(), f.input.operationId)),
              ))._tag,
            ).toBe("RelayTenancyNotFoundError");
          }),
        ),
      );

      it.effect(
        "fresh durable enrollment advances ownership once while keeping conversation import and all work held",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                e = yield* enrolled(f);
              expect(yield* e.assign(e.receipt)).toBe(true);
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                environmentId: e.environmentId,
                projectId: `vm:${f.threadId}`,
                operationId: f.input.operationId,
              });
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("importing");
              expect(yield* e.assign(e.receipt)).toBe(true);
              expect(yield* f.resets.begin(f.input)).toMatchObject({ phase: "importing" });
              yield* Effect.flip(f.resets.requestCancellation(f.input.operationId));
              yield* Effect.flip(
                f.placements.admit({
                  ...f.owner,
                  environmentId: e.environmentId,
                  generation: 2,
                  workId: "not-ready",
                }),
              );
              yield* Effect.flip(f.placements.admit({ ...f.owner, workId: "old-deleted-owner" }));
              expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
              expect(
                (yield* f.saved.get(
                  (yield* f.resets.get(f.input.operationId))!.savedDiskOperationId,
                ))?.phase,
              ).toBe("expired");
            }),
          ),
      );
      it.effect("incomplete, mismatched or revoked fresh enrollment cannot commit ownership", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              e = yield* enrolled(f);
            for (const receipt of [
              { ...e.receipt, generation: 1 },
              { ...e.receipt, environmentId: EnvironmentId.make(f.sourceEnvironmentId) },
            ])
              yield* Effect.flip(e.assign(receipt));
            yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=NULL WHERE allocation_id=${f.input.allocationId}`;
            yield* Effect.flip(e.assign(e.receipt));
            yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
            yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${e.credentialId}`;
            yield* Effect.flip(e.assign(e.receipt));
            expect(yield* f.placements.get(f.threadId)).toMatchObject({
              generation: 1,
              environmentId: f.sourceEnvironmentId,
              operationId: f.input.operationId,
            });
          }),
        ),
      );
      it.effect(
        "cancellation before create prevents late worker creation and frees only the new reservation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.resets.begin(f.input);
              const provisions = makeThreadVmProvisionStore(f.sql);
              yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
              const staleClaim = NodeCrypto.randomUUID();
              yield* provisions.claim(staleClaim, f.hostId);
              yield* f.resets.requestCancellation(f.input.operationId);
              yield* makeThreadVmResetCancellationWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("No guest exists"),
                  destroy: () => Effect.die("No guest exists"),
                },
                f.hostId,
              ).runOne();
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("cancelled");
              yield* Effect.flip(
                provisions.beginCreate({ allocationId: f.input.allocationId, claimId: staleClaim }),
              );
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ state: "deleted", computeRef: null });
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 1,
                environmentId: f.sourceEnvironmentId,
                operationId: null,
              });
              expect(yield* f.natives.getForOperation(f.input)).toBeNull();
              expect(yield* f.natives.latestComplete(f.threadId)).not.toBeNull();
              expect(yield* f.resets.requestCancellation(f.input.operationId)).toMatchObject({
                phase: "cancelled",
              });
              expect(yield* f.resets.begin(f.input)).toMatchObject({ phase: "cancelled" });
            }),
          ),
      );
      it.effect(
        "an uncertain external create retains quota, placement and retained conversation pins",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.resets.begin(f.input);
              const provisions = makeThreadVmProvisionStore(f.sql);
              yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
              const claimId = NodeCrypto.randomUUID();
              yield* provisions.claim(claimId, f.hostId);
              yield* provisions.beginCreate({ allocationId: f.input.allocationId, claimId });
              yield* f.resets.requestCancellation(f.input.operationId);
              yield* makeThreadVmResetCancellationWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("Creation unresolved"),
                  destroy: () => Effect.die("Creation unresolved"),
                },
                f.hostId,
              ).runOne();
              expect(yield* f.resets.get(f.input.operationId)).toMatchObject({
                phase: "cancelling",
                errorCode: "create_uncertain",
              });
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ state: "deleting", deletedAt: null });
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect(yield* f.natives.getForOperation(f.input)).not.toBeNull();
              // A later receipt records the real guest but cannot make it runnable.
              yield* provisions.recordCreated({
                allocationId: f.input.allocationId,
                claimId,
                computeRef: "late-created",
              });
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ state: "deleting", computeRef: "late-created" });
            }),
          ),
      );
      it.effect(
        "a lost physical stop reply keeps the slot even when the guest catalog is empty; retry safely finishes",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                e = yield* enrolled(f);
              yield* f.resets.requestCancellation(f.input.operationId);
              let fail = true,
                stops = 0;
              const worker = makeThreadVmResetCancellationWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(null),
                  destroy: () =>
                    Effect.suspend(() => {
                      stops++;
                      return fail
                        ? Effect.fail(
                            new ThreadVmComputeError({
                              operation: "destroy",
                              message: "Unavailable",
                            }),
                          )
                        : Effect.void;
                    }),
                },
                f.hostId,
              );
              yield* worker.runOne();
              expect(yield* f.resets.get(f.input.operationId)).toMatchObject({
                phase: "cancelling",
                errorCode: "stop_unconfirmed",
              });
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ deletedAt: null });
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              const [binding] = yield* f.sql<{
                revoked: boolean;
              }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_thread_vm_bindings WHERE allocation_id=${f.input.allocationId}`;
              expect(binding?.revoked).toBe(true);
              yield* Effect.flip(e.assign(e.receipt));
              fail = false;
              yield* f.sql`UPDATE relay_thread_vm_resets SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
              yield* worker.runOne();
              expect(stops).toBe(2);
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("cancelled");
              expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
              expect(yield* f.natives.getForOperation(f.input)).toBeNull();
            }),
          ),
      );
      it.effect("a mismatched guest is never stopped or treated as absent", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              e = yield* created(f);
            yield* f.resets.requestCancellation(f.input.operationId);
            yield* makeThreadVmResetCancellationWorker(
              f.sql,
              f.objects,
              {
                inspect: () => Effect.succeed({ ...f.info, sandboxId: e.computeRef }),
                destroy: () => Effect.die("Must not destroy another guest"),
              },
              f.hostId,
            ).runOne();
            expect(yield* f.resets.get(f.input.operationId)).toMatchObject({
              phase: "cancelling",
              errorCode: "cleanup_unconfirmed",
            });
            expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
          }),
        ),
      );
      it.effect("fresh enrollment and cancellation have one transactional winner", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              e = yield* enrolled(f);
            const outcomes = yield* Effect.all(
              [
                Effect.result(e.assign(e.receipt)),
                Effect.result(f.resets.requestCancellation(f.input.operationId)),
              ],
              { concurrency: "unbounded" },
            );
            expect(outcomes.filter((r) => r._tag === "Success")).toHaveLength(1);
            expect(outcomes.filter((r) => r._tag === "Failure")).toHaveLength(1);
            const reset = yield* f.resets.get(f.input.operationId),
              placement = yield* f.placements.get(f.threadId);
            expect(placement?.operationId).toBe(f.input.operationId);
            expect(["importing", "cancelling"]).toContain(reset?.phase);
            expect(placement?.generation).toBe(reset?.phase === "importing" ? 2 : 1);
          }),
        ),
      );

      it.effect(
        "pins the retained conversation and reserves inert provisioning once without changing history or generation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                before =
                  yield* f.sql`SELECT event_json FROM relay_thread_history WHERE thread_id=${f.threadId} ORDER BY cursor`;
              const first = yield* f.resets.begin(f.input);
              expect(first).toMatchObject({
                phase: "pending",
                expectedGeneration: 1,
                sourceEnvironmentId: f.sourceEnvironmentId,
                savedDiskOperationId: (yield* f.saved.get(first.savedDiskOperationId))?.operationId,
              });
              expect(yield* f.resets.begin(f.input)).toEqual(first);
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 1,
                environmentId: f.sourceEnvironmentId,
                operationId: f.input.operationId,
              });
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({ state: "creating", computeRef: null });
              expect(
                yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId),
              ).toMatchObject({
                phase: "pending",
                generation: 2,
                operationId: f.input.operationId,
              });
              expect(
                yield* makeThreadVmCapacityStore(f.sql).get(f.input.operationId),
              ).toMatchObject({ state: "waiting", kind: "create" });
              expect(yield* f.natives.getForOperation(f.input)).toMatchObject({
                generation: 1,
                sourceEnvironmentId: f.sourceEnvironmentId,
              });
              expect(
                yield* f.sql`SELECT event_json FROM relay_thread_history WHERE thread_id=${f.threadId} ORDER BY cursor`,
              ).toEqual(before);
              yield* Effect.flip(f.placements.admit({ ...f.owner, workId: "too-early" }));
              yield* Effect.flip(f.resets.begin({ ...f.input, branch: "other" }));
            }),
          ),
      );
      it.effect("refuses reset while a saved disk can still be restored", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(false);
            expect((yield* Effect.flip(f.resets.begin(f.input)))._tag).toBe(
              "ThreadVmResetConflict",
            );
            expect(yield* f.resets.get(f.input.operationId)).toBeNull();
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
            expect(yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId)).toBeNull();
          }),
        ),
      );
      it.effect(
        "rejects a foreign owner, repository, generation or conflicting operation before reserving",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              for (const changed of [
                { ...f.input, actorUserId: "other" },
                { ...f.input, canonicalKey: "github.com/reset/other" },
                { ...f.input, expectedGeneration: 2 },
                { ...f.input, revision: "invalid" },
              ])
                yield* Effect.flip(f.resets.begin(changed));
              yield* f.sql`UPDATE relay_thread_placements SET operation_id='other-operation' WHERE thread_id=${f.threadId}`;
              yield* Effect.flip(f.resets.begin(f.input));
              expect(yield* f.resets.get(f.input.operationId)).toBeNull();
            }),
          ),
      );
      it.effect("requires the exact retained native and attachment set", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const latest = yield* f.natives.latestComplete(f.threadId);
            if (latest)
              yield* f.sql`DELETE FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${latest.operationId}`;
            yield* Effect.flip(f.resets.begin(f.input));
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
            expect(yield* f.resets.get(f.input.operationId)).toBeNull();
          }),
        ),
      );
      it.effect("quota rejection rolls back reset hold, allocation and recovery pins", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              other = NodeCrypto.randomUUID();
            yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=1 WHERE organization_id='org'`;
            yield* f.placements.enroll({
              threadId: other,
              environmentId: "other",
              projectId: "other",
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: f.input.actorUserId,
            });
            yield* makeThreadVmAllocationStore(f.sql).reserve({
              allocationId: NodeCrypto.randomUUID(),
              threadId: other,
              organizationId: "org",
              ownerUserId: f.input.actorUserId,
              templateId: f.input.templateId,
            });
            expect((yield* Effect.flip(f.resets.begin(f.input)))._tag).toBe(
              "ThreadVmQuotaExceeded",
            );
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
            expect(yield* f.resets.get(f.input.operationId)).toBeNull();
            expect(yield* f.natives.getForOperation(f.input)).toBeNull();
            expect(yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId)).toBeNull();
          }),
        ),
      );
      it.effect(
        "two reset requests serialize on one thread and only the winner reserves quota",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                other = {
                  ...f.input,
                  operationId: NodeCrypto.randomUUID(),
                  allocationId: NodeCrypto.randomUUID(),
                };
              const outcomes = yield* Effect.all(
                [Effect.result(f.resets.begin(f.input)), Effect.result(f.resets.begin(other))],
                { concurrency: "unbounded" },
              );
              expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
              expect(outcomes.filter((result) => result._tag === "Failure")).toHaveLength(1);
              const rows =
                yield* f.sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE thread_id=${f.threadId} AND deleted_at IS NULL`;
              expect(rows).toHaveLength(1);
              const [reset] = yield* f.sql<{
                operationId: string;
              }>`SELECT operation_id AS "operationId" FROM relay_thread_vm_resets WHERE thread_id=${f.threadId}`;
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(reset!.operationId);
              expect(
                yield* f.natives.getForOperation({
                  threadId: f.threadId,
                  operationId: reset!.operationId,
                }),
              ).not.toBeNull();
            }),
          ),
      );
      it.effect("a forged reset hint cannot bypass the saved-workspace allocation guard", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const failure = yield* Effect.flip(
              makeThreadVmAllocationStore(f.sql).reserve({
                allocationId: f.input.allocationId,
                threadId: f.threadId,
                organizationId: "org",
                ownerUserId: f.input.actorUserId,
                templateId: f.input.templateId,
                savedDiskResetOperationId: f.input.operationId,
              }),
            );
            expect(failure._tag).toBe("ThreadVmAllocationConflict");
            expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
            expect(yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId)).toBeNull();
          }),
        ),
      );

      it.effect("resets a final save taken from its exact certified paused source", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(true, "paused");
            const point = (yield* f.natives.latestComplete(f.threadId))!;
            const [saved] = yield* f.sql<{
              operationId: string;
            }>`SELECT operation_id AS "operationId"
              FROM relay_thread_vm_saved_disks WHERE thread_id=${f.threadId}`;
            expect(point.captureOperationId).not.toBe(saved!.operationId);
            const reset = yield* f.resets.begin(f.input);
            expect(reset.nativeCheckpointOperationId).toBe(point.operationId);
            expect(reset.savedDiskOperationId).toBe(saved!.operationId);
            expect(reset.sourceEnvironmentId).toBe(point.sourceEnvironmentId);
            expect(reset.sourceSequence).toBe(point.sourceSequence);
            expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
          }),
        ),
      );

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
        it.effect(`refuses a paused final-save reset with changed ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(true, "paused");
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
                yield* f.sql`UPDATE relay_thread_placements SET environment_id='other-environment'
                  WHERE thread_id=${f.threadId}`;
              expect((yield* Effect.flip(f.resets.begin(f.input)))._tag).toBe(
                "ThreadVmResetConflict",
              );
              expect(yield* f.resets.get(f.input.operationId)).toBeNull();
              expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
              expect(
                yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId),
              ).toBeNull();
            }),
          ),
        );
      }

      it.effect(
        "refuses Reset VM if an older recovery point retained native/chat data without full history",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.sql`UPDATE relay_thread_native_checkpoints SET recovery_history_json=NULL WHERE thread_id=${f.threadId}`;
              yield* Effect.flip(f.resets.begin(f.input));
              expect(yield* f.resets.get(f.input.operationId)).toBeNull();
              const [placement] = yield* f.sql<{
                operationId: string | null;
              }>`SELECT operation_id AS "operationId" FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
              expect(placement?.operationId).toBeNull();
            }),
          ),
      );

      it.effect(
        "reset imports once and only fresh guest readiness releases the hold and recovery pins",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                r = yield* importing(f);
              expect(r.recovery.reset).toEqual({
                canonicalKey: f.input.canonicalKey,
                branch: f.input.branch,
                revision: f.input.revision,
                repositoryUpload: f.repositoryUpload,
              });
              expect(r.recovery.native.recoveryHistory).toBeTruthy();
              yield* Effect.flip(r.authorize(r.store.finish(r.receipt)));
              for (let retry = 0; retry < 2; retry++)
                expect(yield* r.authorize(r.store.record(r.claim, r.receipt))).toEqual(r.receipt);
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              yield* Effect.flip(
                r.authorize(r.store.record(r.claim, { ...r.receipt, branch: "other" })),
              );
              const { repositoryBundleSha256: _bundle, ...legacy } = r.receipt;
              yield* Effect.flip(r.authorize(r.store.record(r.claim, legacy)));
              yield* Effect.flip(
                r.authorize(
                  r.store.record(r.claim, {
                    ...r.receipt,
                    repositoryBundleSha256: "f".repeat(64),
                  }),
                ),
              );
              yield* Effect.flip(
                r.authorize(
                  r.store.record(r.claim, { ...r.receipt, manifestSha256: "f".repeat(64) }),
                ),
              );
              yield* f.sql`UPDATE relay_thread_vm_resets SET import_receipt=${f.sql.json(legacy)} WHERE operation_id=${f.input.operationId}`;
              yield* Effect.flip(r.authorize(r.store.finish(legacy)));
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              yield* f.sql`UPDATE relay_thread_vm_resets SET import_receipt=${f.sql.json(r.receipt)} WHERE operation_id=${f.input.operationId}`;
              expect(yield* r.authorize(r.store.finish(r.receipt))).toEqual({ ready: true });
              expect(yield* r.authorize(r.store.finish(r.receipt))).toEqual({ ready: true });
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("completed");
              expect((yield* f.placements.get(f.threadId))?.operationId).toBeNull();
              expect(
                yield* f.natives.getForOperation({
                  threadId: f.threadId,
                  operationId: f.input.operationId,
                }),
              ).toBeNull();
              expect((yield* f.saved.get(r.recovery.savedDiskOperationId))?.phase).toBe("expired");
            }),
          ),
      );
      it.effect(
        "only the fresh reset identity can read recovery artifacts and acknowledge readiness",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                r = yield* importing(f);
              const owner = { threadId: f.threadId, environmentId: r.environmentId, generation: 2 };
              const principal = {
                environmentId: r.environmentId,
                environmentPublicKey: "reset-key",
                credentialId: r.credentialId,
                threadVm: r.recovery.scope,
              };
              const authorized = <A, E, R>(effect: Effect.Effect<A, E, R>, identity = principal) =>
                r.authorize(
                  effect.pipe(Effect.provideService(RelayEnvironmentPrincipal, identity)),
                );
              expect(yield* authorized(getThreadVmRestoreRecovery(owner))).toEqual(r.recovery);
              const artifact = {
                ...owner,
                operationId: f.input.operationId,
                artifactId: r.recovery.native.manifestArtifactId,
              };
              const body = yield* authorized(readThreadVmRestoreArtifact(artifact));
              expect(
                (yield* Stream.runCollect(body)).reduce((size, bytes) => size + bytes.length, 0),
              ).toBeGreaterThan(0);
              const uploaded = yield* authorized(
                readThreadVmRestoreArtifact({
                  ...artifact,
                  artifactId: f.repositoryUpload.bundle.chunks[0]!.artifactId,
                }),
              );
              expect(new TextDecoder().decode((yield* Stream.runCollect(uploaded))[0])).toBe(
                "retained Git bundle fixture",
              );
              for (const changed of [
                { ...artifact, operationId: NodeCrypto.randomUUID() },
                { ...artifact, artifactId: NodeCrypto.randomUUID() },
                { ...artifact, generation: 3 },
              ])
                yield* Effect.flip(authorized(readThreadVmRestoreArtifact(changed)));
              const old = {
                environmentId: EnvironmentId.make(f.sourceEnvironmentId),
                environmentPublicKey: "test-key",
                credentialId: f.credentialId,
                threadVm: {
                  ...r.recovery.scope,
                  allocationId: f.sourceAllocationId,
                  generation: 1,
                },
              };
              yield* Effect.flip(authorized(getThreadVmRestoreRecovery(owner), old));
              yield* Effect.flip(authorized(readThreadVmRestoreArtifact(artifact), old));
              yield* r.authorize(r.store.record(r.claim, r.receipt));
              yield* Effect.flip(
                authorized(confirmThreadVmRestoreActivation(owner, r.receipt), old),
              );
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect(yield* authorized(confirmThreadVmRestoreActivation(owner, r.receipt))).toEqual(
                { ready: true },
              );
              expect(yield* authorized(confirmThreadVmRestoreActivation(owner, r.receipt))).toEqual(
                { ready: true },
              );
              expect(yield* authorized(getThreadVmRestoreRecovery(owner))).toBeNull();
              yield* Effect.flip(authorized(readThreadVmRestoreArtifact(artifact)));
            }),
          ),
      );
      it.effect(
        "revoking the fresh reset credential blocks recovery reads and activation while retaining the hold",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                r = yield* importing(f);
              yield* r.authorize(r.store.record(r.claim, r.receipt));
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at=clock_timestamp() WHERE credential_id=${r.credentialId}`;
              const owner = { threadId: f.threadId, environmentId: r.environmentId, generation: 2 };
              const principal = {
                environmentId: r.environmentId,
                environmentPublicKey: "reset-key",
                credentialId: r.credentialId,
                threadVm: r.recovery.scope,
              };
              yield* Effect.flip(
                r.authorize(
                  getThreadVmRestoreRecovery(owner).pipe(
                    Effect.provideService(RelayEnvironmentPrincipal, principal),
                  ),
                ),
              );
              yield* Effect.flip(
                r.authorize(
                  confirmThreadVmRestoreActivation(owner, r.receipt).pipe(
                    Effect.provideService(RelayEnvironmentPrincipal, principal),
                  ),
                ),
              );
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("importing");
              expect(
                yield* f.natives.getForOperation({
                  threadId: f.threadId,
                  operationId: f.input.operationId,
                }),
              ).not.toBeNull();
            }),
          ),
      );
      it.effect("revoked current access cannot import or activate a reset guest", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture(),
              r = yield* importing(f);
            yield* r.authorize(r.store.record(r.claim, r.receipt));
            yield* f.sql`DELETE FROM relay_repository_access WHERE user_id=${f.input.actorUserId}`;
            expect((yield* Effect.flip(r.authorize(r.store.finish(r.receipt))))._tag).toBe(
              "RelayTenancyNotFoundError",
            );
            expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
            expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("importing");
            expect(
              yield* f.natives.getForOperation({
                threadId: f.threadId,
                operationId: f.input.operationId,
              }),
            ).not.toBeNull();
          }),
        ),
      );
      it.effect(
        "reset worker retries a lost startup reply without importing the conversation twice",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                r = yield* importing(f);
              yield* r.store.defer(r.claim, null);
              let imports = 0,
                starts = 0;
              const worker = makeThreadVmResetImportWorker(
                f.sql,
                f.objects,
                () =>
                  Effect.sync(() => {
                    imports++;
                    return r.receipt;
                  }),
                () =>
                  Effect.gen(function* () {
                    starts++;
                    if (starts === 1)
                      return yield* new ThreadVmComputeError({
                        operation: "setup",
                        message: "Lost start reply",
                      });
                  }),
                f.hostId,
              );
              for (let retry = 0; retry < 2; retry++) {
                yield* f.sql`UPDATE relay_thread_vm_resets SET retry_at=clock_timestamp() WHERE operation_id=${f.input.operationId}`;
                expect(yield* r.authorize(worker.runOne())).toBe(true);
              }
              expect(imports).toBe(1);
              expect(starts).toBe(2);
              expect((yield* f.placements.get(f.threadId))?.operationId).toBe(f.input.operationId);
              expect((yield* f.resets.get(f.input.operationId))?.phase).toBe("importing");
            }),
          ),
      );
    });
  },
);
