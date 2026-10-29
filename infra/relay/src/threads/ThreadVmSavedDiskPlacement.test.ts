import * as NodeCrypto from "node:crypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal, RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import { threadVmPresentation } from "@t3tools/client-runtime/relay/threadVmControls";
import { RelayDb } from "../db.ts";
import { listPortableThreads } from "../http/ThreadHistoryApi.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmResetStore } from "./ThreadVmResetStore.ts";
import { makeThreadVmResetCancellationWorker } from "./ThreadVmResetCancellationWorker.ts";
import { makeThreadVmResetEnrollmentStore } from "./ThreadVmResetEnrollmentStore.ts";
import { makeThreadVmResetImportStore } from "./ThreadVmResetImportStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { nativeRestoreFixture, nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";

const decodeImportReceipt = Schema.decodeUnknownEffect(RelayThreadVmRestoreImportReceipt);
const cancelledFixture = Effect.fnUntraced(function* () {
  const f = yield* nativeRestoreFixture();
  yield* f.commit;
  yield* f.restores.requestAbort(f.input.operationId);
  yield* f.worker().runOne();
  expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborted");
  return f;
});
type Fixture = Effect.Success<ReturnType<typeof cancelledFixture>>;
const list = Effect.fnUntraced(function* (f: Fixture, userId = f.input.actorUserId) {
  const db = yield* PgDrizzle.makeWithDefaults();
  return yield* listPortableThreads({ limit: 100 }).pipe(
    Effect.provideService(RelayDb, db),
    Effect.provideService(RelayClientPrincipal, { userId, token: "fixture" }),
  );
});
const nextRestore = (f: Fixture) => ({
  ...f.input,
  operationId: NodeCrypto.randomUUID(),
  allocationId: NodeCrypto.randomUUID(),
  expectedGeneration: 2,
});
const expiredResetFixture = Effect.fnUntraced(function* () {
  const f = yield* cancelledFixture();
  yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.savedDiskOperationId}`;
  expect(yield* f.saved.completeExpiry((yield* f.saved.claimExpired(f.hostId))!)).toBe(true);
  const canonicalKey = `github.com/reset/${f.threadId}`;
  yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${canonicalKey},'repo','org','now')`;
  const reset = {
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    threadId: f.threadId,
    actorUserId: f.input.actorUserId,
    expectedGeneration: 2,
    hostId: f.hostId,
    templateId: "template:build-verified",
    canonicalKey,
    branch: "main",
    revision: "b".repeat(40),
  };
  const repository = yield* repositoryUploadCatalogFixture(
    f.sql,
    f.objects,
    f.threadId,
    reset.revision,
  );
  return { ...f, reset, repository };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "saved workspace after committed restore cancellation (Postgres)",
  () => {
    layer(nativeRestoreTestLayer)((it) => {
      it.effect("keeps status and portable discovery after a second precommit cancellation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* cancelledFixture();
            const read = () => makeThreadVmStatusStore(f.sql).read(f.threadId, 2);
            const original = (yield* f.saved.get(f.input.savedDiskOperationId))!;
            expect((yield* read()).savedDisk?.operationId).toBe(original.operationId);
            expect(threadVmPresentation({ status: yield* read() }).primary).toEqual({
              type: "restore",
              label: "Restore VM",
            });
            expect(
              (yield* list(f)).entries.find((e) => e.placement.threadId === f.threadId)?.vm,
            ).toMatchObject({ state: "saved", savedDiskOperationId: original.operationId });
            const retry = nextRestore(f);
            yield* f.restores.begin(retry);
            yield* f.restores.requestAbort(retry.operationId);
            yield* makeThreadVmRestoreWorker(
              f.sql,
              f.objects,
              {
                resolveSource: () => Effect.die("Aborted restore must not inspect a snapshot"),
              },
              f.hostId,
            ).runOne();
            expect((yield* f.restores.get(retry.operationId))?.phase).toBe("aborted");
            expect((yield* read()).savedDisk).toMatchObject({
              operationId: original.operationId,
              savedAt: original.savedAt,
              expiresAt: original.expiresAt,
            });
            expect(threadVmPresentation({ status: yield* read() }).primary?.type).toBe("restore");
            expect(
              (yield* list(f)).entries.find((e) => e.placement.threadId === f.threadId)?.vm,
            ).toMatchObject({ state: "saved", savedDiskOperationId: original.operationId });
            expect((yield* list(f, "another-owner")).entries).toHaveLength(0);
            const third = yield* f.restores.begin(nextRestore(f));
            expect(third).toMatchObject({ sourceGeneration: 1, generation: 2 });
          }),
        ),
      );
      it.effect("follows repeated committed cancellations and rejects changed lineage", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* cancelledFixture();
            const second = nextRestore(f);
            const row = yield* f.restores.begin(second);
            yield* f.capacity.admitNext(f.hostId);
            const claim = (yield* f.restores.claim(f.hostId))!;
            yield* f.restores.beginPrepare(claim);
            yield* f.restores.recordPrepared(claim, {
              version: 1,
              kind: "native-restore-catalog-v1",
              sourceTemplateId: row.sourceTemplateId,
              sourceBuildId: row.sourceBuildId,
            });
            yield* f.serving.commit((yield* f.serving.claim(f.hostId))!);
            yield* f.restores.requestAbort(second.operationId);
            yield* f.worker().runOne();
            const environmentId = `pending-restore:${second.allocationId}`;
            expect(yield* f.placements.get(f.threadId)).toMatchObject({
              generation: 3,
              environmentId,
            });
            expect(
              (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 3)).savedDisk?.operationId,
            ).toBe(f.input.savedDiskOperationId);
            expect(
              (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 2)).savedDisk,
            ).toBeNull();
            const retry = { ...nextRestore(f), expectedGeneration: 3 };
            const hidden = Effect.gen(function* () {
              expect(
                (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 3)).savedDisk,
              ).toBeNull();
              expect(
                (yield* list(f)).entries.find((e) => e.placement.threadId === f.threadId)?.vm
                  ?.savedDiskOperationId,
              ).toBeNull();
              expect((yield* Effect.flip(f.restores.begin(retry)))._tag).toBe(
                "ThreadVmSavedDiskConflict",
              );
            });
            yield* f.sql`UPDATE relay_thread_placements SET environment_id='unrelated-environment' WHERE thread_id=${f.threadId}`;
            yield* hidden;
            yield* f.sql`UPDATE relay_thread_placements SET environment_id=${environmentId} WHERE thread_id=${f.threadId}`;
            yield* f.sql`UPDATE relay_thread_vm_restores SET actor_user_id='different-owner' WHERE operation_id=${second.operationId}`;
            yield* hidden;
            yield* f.sql`UPDATE relay_thread_vm_restores SET actor_user_id=${f.input.actorUserId} WHERE operation_id=${second.operationId}`;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${second.allocationId}`;
            yield* hidden;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='native-v1' WHERE allocation_id=${second.allocationId}`;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.sourceAllocationId}`;
            yield* hidden;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='native-v1' WHERE allocation_id=${f.sourceAllocationId}`;
            const deletedAt = (yield* f.allocations.get(second.allocationId))!.deletedAt;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleting',deleted_at=NULL WHERE allocation_id=${second.allocationId}`;
            yield* hidden;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=${deletedAt} WHERE allocation_id=${second.allocationId}`;
            expect(yield* f.restores.begin(retry)).toMatchObject({
              generation: 3,
              sourceGeneration: 1,
            });
          }),
        ),
      );
      it.effect("does not bypass a retained workspace with a fresh allocation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* cancelledFixture();
            const allocationId = NodeCrypto.randomUUID();
            const error = yield* Effect.flip(
              makeThreadVmAllocationStore(f.sql).reserve({
                allocationId,
                threadId: f.threadId,
                organizationId: "org",
                ownerUserId: f.input.actorUserId,
                templateId: "template:build-verified",
              }),
            );
            expect(error._tag).toBe("ThreadVmAllocationConflict");
            expect(yield* f.allocations.get(allocationId)).toBeNull();
          }),
        ),
      );
      it.effect("keeps quota replacement eligible and admits it after another slot is freed", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* cancelledFixture();
            const otherThread = NodeCrypto.randomUUID(),
              otherAllocation = NodeCrypto.randomUUID();
            yield* f.placements.enroll({
              threadId: otherThread,
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: f.input.actorUserId,
              environmentId: `local-${otherThread}`,
              projectId: "project",
            });
            yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=1 WHERE organization_id='org'`;
            yield* f.allocations.reserve({
              allocationId: otherAllocation,
              threadId: otherThread,
              organizationId: "org",
              ownerUserId: f.input.actorUserId,
              templateId: "template:build-verified",
            });
            const request = nextRestore(f);
            expect((yield* Effect.flip(f.restores.begin(request)))._tag).toBe(
              "ThreadVmQuotaExceeded",
            );
            const coordinator = makeThreadVmReplacementCoordinator(f.sql, f.objects);
            const placement = (yield* f.placements.get(f.threadId))!;
            const pending = yield* coordinator.record({
              requestId: request.operationId,
              threadId: f.threadId,
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: f.input.actorUserId,
              hostId: f.hostId,
              templateId: "template:build-verified",
              intent: {
                kind: "restore",
                threadId: f.threadId,
                actorUserId: f.input.actorUserId,
                sourceEnvironmentId: placement.environmentId,
                request,
              },
            });
            expect(yield* coordinator.currentAccess(pending)).toBe(true);
            yield* coordinator.runOne(f.hostId);
            expect(yield* coordinator.get(request.operationId)).toMatchObject({
              phase: "awaiting_choice",
              errorCode: "quota_reached",
            });
            yield* f.allocations.requestDeletion(otherAllocation);
            yield* f.allocations.confirmDeleted({
              allocationId: otherAllocation,
              computeRef: null,
            });
            yield* f.sql`UPDATE relay_thread_vm_replacements SET checked_at=NULL WHERE request_id=${request.operationId}`;
            yield* coordinator.runOne(f.hostId);
            expect((yield* coordinator.get(request.operationId))?.phase).toBe("admitted");
            expect(yield* f.restores.get(request.operationId)).toMatchObject({
              generation: 2,
              sourceGeneration: 1,
              phase: "pending",
            });
          }),
        ),
      );
      it.effect(
        "can cancel an expired-source reset after restart without changing its provenance",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* expiredResetFixture();
              const before = (yield* f.saved.get(f.input.savedDiskOperationId))!;
              yield* makeThreadVmResetStore(f.sql, f.objects).begin(f.reset);
              const restarted = makeThreadVmResetStore(f.sql, f.objects);
              expect(yield* restarted.begin(f.reset)).toMatchObject({
                expectedGeneration: 2,
                sourceEnvironmentId: f.sourceEnvironmentId,
                phase: "pending",
              });
              yield* restarted.requestCancellation(f.reset.operationId);
              const cleanup = makeThreadVmResetCancellationWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.die("Unstarted reset must not inspect compute"),
                  destroy: () => Effect.die("Unstarted reset must not delete compute"),
                },
                f.hostId,
              );
              expect(yield* cleanup.runOne()).toBe(true);
              expect((yield* restarted.get(f.reset.operationId))?.phase).toBe("cancelled");
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                environmentId: `pending-restore:${f.input.allocationId}`,
                operationId: null,
              });
              expect(yield* f.saved.get(before.operationId)).toEqual(before);
              expect(
                (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 2)).savedDisk,
              ).toMatchObject({ operationId: before.operationId, phase: "expired" });
            }),
          ),
      );
      it.effect("enrolls and imports an expired source into a later reset generation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* expiredResetFixture();
            const resets = makeThreadVmResetStore(f.sql, f.objects);
            expect(yield* resets.begin(f.reset)).toMatchObject({
              expectedGeneration: 2,
              sourceGeneration: 1,
              sourceEnvironmentId: f.sourceEnvironmentId,
            });
            expect(yield* resets.begin(f.reset)).toMatchObject({ sourceGeneration: 1 });
            const provisions = makeThreadVmProvisionStore(f.sql);
            yield* f.capacity.admitNext(f.hostId);
            const claimId = NodeCrypto.randomUUID();
            yield* provisions.claim(claimId, f.hostId);
            yield* provisions.beginCreate({
              allocationId: f.reset.allocationId,
              claimId,
              templateId: f.reset.templateId,
            });
            yield* provisions.recordCreated({
              allocationId: f.reset.allocationId,
              claimId,
              computeRef: `reset-${f.reset.allocationId}`,
              sealedTrafficAccessToken: "sealed-fixture",
            });
            const credentialId = NodeCrypto.randomUUID();
            const environmentId = EnvironmentId.make(`reset-${credentialId}`);
            yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
              VALUES(${credentialId},${environmentId},'reset-key',${credentialId},'now','now')`;
            yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
              VALUES(${environmentId},${f.reset.allocationId},${f.threadId},'repo',3,'reset-key',${credentialId})`;
            yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
              VALUES(${f.reset.allocationId},${f.reset.operationId},${credentialId},${environmentId},'reset-key',${credentialId},'sealed',clock_timestamp(),clock_timestamp())`;
            const enrollment = {
              enrolled: true as const,
              operationId: f.reset.operationId,
              allocationId: f.reset.allocationId,
              environmentId,
              threadId: ThreadId.make(f.threadId),
              generation: 3,
            };
            expect(yield* makeThreadVmResetEnrollmentStore(f.sql).assigned(enrollment)).toBe(true);
            expect(yield* makeThreadVmResetEnrollmentStore(f.sql).assigned(enrollment)).toBe(true);
            expect(yield* makeThreadVmResetStore(f.sql, f.objects).begin(f.reset)).toMatchObject({
              phase: "importing",
              sourceGeneration: 1,
            });
            const importer = makeThreadVmResetImportStore(f.sql, f.objects);
            const claim = (yield* importer.claim(f.hostId))!;
            const db = yield* PgDrizzle.makeWithDefaults();
            const recovery = yield* importer
              .recovery(f.reset.operationId)
              .pipe(Effect.provideService(RelayDb, db));
            expect(recovery.native).toMatchObject({
              generation: 1,
              sourceEnvironmentId: f.sourceEnvironmentId,
            });
            expect(recovery.scope.generation).toBe(3);
            const receipt = yield* decodeImportReceipt({
              version: 1,
              operationId: f.reset.operationId,
              environmentId,
              scope: recovery.scope,
              projectId: `vm:${f.threadId}`,
              workspaceRoot: "/workspace/project",
              checkoutPath: "/workspace/project",
              branch: f.reset.branch,
              revision: f.reset.revision,
              repositoryBundleSha256: f.repository.bundle.sha256,
              manifestSha256: "e".repeat(64),
              sourceEnvironmentId: f.sourceEnvironmentId,
              sourceSequence: recovery.native.sourceSequence,
              nativeManifestArtifactId: recovery.native.manifestArtifactId,
              attachmentManifestArtifactId: recovery.attachments.manifestArtifactId,
              sequence: 23,
              execution: "frozen",
            });
            yield* importer.record(claim, receipt).pipe(Effect.provideService(RelayDb, db));
            expect(
              yield* importer.finish(receipt).pipe(Effect.provideService(RelayDb, db)),
            ).toEqual({ ready: true });
            expect(yield* f.placements.get(f.threadId)).toMatchObject({
              generation: 3,
              environmentId,
              operationId: null,
            });
            expect(
              (yield* makeThreadVmStatusStore(f.sql).read(f.threadId, 3)).savedDisk,
            ).toBeNull();
          }),
        ),
      );
    });
  },
);
