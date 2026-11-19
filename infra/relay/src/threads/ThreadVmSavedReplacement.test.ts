import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Redacted from "effect/Redacted";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { resetThreadVm } from "../http/ThreadVmResetApi.ts";
import { restoreThreadVm } from "../http/ThreadVmRestoreApi.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { repositoryUploadCatalogFixture } from "./testUtils/repositoryUploadCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadVmResetStore } from "./ThreadVmResetStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { threadVmQuotaUsage } from "./ThreadVmQuota.ts";

const fixture = Effect.fnUntraced(function* (
  kind: "reset" | "restore",
  sourceState: "running" | "paused" = "running",
) {
  const victim = yield* finalSaveCatalogFixture();
  const incoming = yield* finalSaveCatalogFixture(sourceState);
  const owner = victim.input.actorUserId;
  incoming.input.actorUserId = owner;
  yield* incoming.sql`UPDATE relay_thread_placements SET owner_user_id=${owner} WHERE thread_id=${incoming.threadId}`;
  yield* incoming.sql`UPDATE relay_thread_vm_allocations SET owner_user_id=${owner} WHERE allocation_id=${incoming.input.allocationId}`;
  yield* incoming.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* incoming.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* incoming.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${owner},'admin','now','now')`;
  const canonicalKey = "github.com/acme/test";
  yield* incoming.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${canonicalKey},'repo','org','now') ON CONFLICT DO NOTHING`;
  yield* incoming.store.begin(incoming.input);
  yield* incoming.freeze;
  yield* incoming.verifyBackup;
  yield* incoming.store.recordSaved(incoming.input.operationId);
  const stop = (yield* incoming.store.claimDeletion(incoming.hostId))!;
  yield* incoming.store.beginDeletion(stop);
  yield* incoming.store.confirmDeleted(stop);
  if (kind === "reset") {
    yield* incoming.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${incoming.input.operationId}`;
    const saved = makeThreadVmSavedDiskStore(incoming.sql);
    const expiry = (yield* saved.claimExpired(incoming.hostId))!;
    expect(yield* saved.completeExpiry(expiry)).toBe(true);
  }
  yield* incoming.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=1 WHERE organization_id='org'`;
  yield* repositoryUploadCatalogFixture(
    incoming.sql,
    incoming.objects,
    incoming.threadId,
    "b".repeat(40),
  );
  const request = {
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    expectedGeneration: 1,
  };
  const intent =
    kind === "reset"
      ? {
          kind,
          threadId: incoming.threadId,
          actorUserId: owner,
          sourceEnvironmentId: incoming.sourceEnvironmentId,
          request: { ...request, canonicalKey, branch: "main", revision: "b".repeat(40) },
        }
      : {
          kind,
          threadId: incoming.threadId,
          actorUserId: owner,
          sourceEnvironmentId: incoming.sourceEnvironmentId,
          request: { ...request, savedDiskOperationId: incoming.input.operationId },
        };
  const coordinator = makeThreadVmReplacementCoordinator(incoming.sql, incoming.objects);
  const input = {
    requestId: request.operationId,
    threadId: incoming.threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: owner,
    hostId: kind === "reset" ? victim.hostId : incoming.hostId,
    templateId: "template:build-verified",
    intent,
  };
  const select = {
    requestId: request.operationId,
    ownerUserId: owner,
    victimAllocationId: victim.input.allocationId,
  };
  const remove = Effect.gen(function* () {
    const replacement = (yield* coordinator.get(request.operationId))!;
    victim.input.operationId = replacement.finalSaveOperationId!;
    yield* victim.freeze;
    yield* victim.verifyBackup;
    yield* victim.store.recordSaved(victim.input.operationId);
    const claim = (yield* victim.store.claimDeletion(victim.hostId))!;
    yield* victim.store.beginDeletion(claim);
    yield* victim.store.confirmDeleted(claim);
    yield* incoming.sql`UPDATE relay_thread_vm_replacements SET checked_at=NULL WHERE request_id=${request.operationId}`;
  });
  return { incoming, victim, owner, input, select, request, coordinator, remove };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "saved VM quota replacements (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const kind of ["reset", "restore"] as const) {
        it.effect(`${kind} admits a saved paused source through quota replacement`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(kind, "paused");
              const [point] = yield* f.incoming.sql<{ captureOperationId: string }>`SELECT
                capture_operation_id AS "captureOperationId" FROM relay_thread_native_checkpoints
                WHERE operation_id=(SELECT native_checkpoint_operation_id FROM relay_thread_vm_final_saves
                  WHERE operation_id=${f.incoming.input.operationId})`;
              expect(point!.captureOperationId).not.toBe(f.incoming.input.operationId);
              yield* f.coordinator.record(f.input);
              expect(yield* f.coordinator.select(f.select)).toMatchObject({ phase: "waiting" });
              yield* f.remove;
              expect(yield* f.coordinator.runOne(f.input.hostId)).toBe(true);
              expect((yield* f.coordinator.get(f.request.operationId))?.phase).toBe("admitted");
              expect(
                (yield* makeThreadVmAllocationStore(f.incoming.sql).get(f.request.allocationId))
                  ?.state,
              ).toBe("creating");
            }),
          ),
        );
        it.effect(
          `${kind} rechecks the paused-source certificate before replacing another VM`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(kind, "paused");
                yield* f.coordinator.record(f.input);
                yield* f.incoming
                  .sql`UPDATE relay_thread_vm_pauses SET source_reopened_at=clock_timestamp()
                WHERE allocation_id=${f.incoming.input.allocationId}`;
                const failure = yield* Effect.flip(f.coordinator.select(f.select));
                expect(failure._tag).toBe("ThreadVmReplacementConflict");
                expect((yield* f.coordinator.get(f.request.operationId))?.phase).toBe(
                  "awaiting_choice",
                );
                expect((yield* f.victim.allocations.get(f.victim.input.allocationId))?.state).toBe(
                  "running",
                );
              }),
            ),
        );
        it.effect(
          `${kind} API retains a resumable choice request when the user quota is full`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(kind),
                  db = yield* PgDrizzle.makeWithDefaults();
                const intent = f.input.intent;
                const action = Effect.gen(function* () {
                  if (intent.kind === "reset")
                    return yield* resetThreadVm(f.incoming.threadId, intent.request);
                  return yield* restoreThreadVm(f.incoming.threadId, intent.request);
                });
                const result = yield* action.pipe(
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(RelayClientPrincipal, {
                    userId: f.owner,
                    token: "fixture-token",
                  }),
                  Effect.provideService(ThreadArtifactObjectStorage, f.incoming.objects),
                  Effect.provideService(ThreadVmRuntimeConfiguration, {
                    settings: {
                      compute: {
                        apiUrl: "https://compute.invalid",
                        sandboxUrl: "https://sandbox.invalid",
                        apiKey: Redacted.make("fixture"),
                        templateId: f.input.templateId,
                        hostAddresses: ["192.0.2.1"],
                        timeoutMs: 600_000,
                      },
                      templateBuildId: "verified",
                      hostId: f.input.hostId,
                      maxRunningVms: 1,
                      publicRelayUrl: "https://relay.invalid",
                      autoPauseEnabled: false,
                      autoBackupEnabled: true,
                      autoDeleteEnabled: false,
                      replacementEnabled: true,
                      restoreEnabled: true,
                      resetEnabled: true,
                    },
                  }),
                );
                expect(result).toMatchObject({
                  status: "quota_reached",
                  maxVms: 1,
                  reservedVms: 1,
                  replacement: { requestId: f.request.operationId, phase: "awaiting_choice" },
                });
                expect(
                  yield* makeThreadVmStatusStore(f.incoming.sql).read(f.incoming.threadId, 1),
                ).toMatchObject({
                  replacement: { requestId: f.request.operationId, phase: "awaiting_choice" },
                  savedDisk: {
                    operationId: f.incoming.input.operationId,
                    phase: kind === "reset" ? "expired" : "available",
                  },
                  repository: {
                    canonicalKey: "github.com/acme/test",
                    branch: "main",
                    revision: "b".repeat(40),
                  },
                });
                expect(
                  yield* makeThreadVmAllocationStore(f.incoming.sql).get(f.request.allocationId),
                ).toBeNull();
              }),
            ),
        );

        it.effect(
          `${kind} keeps its selected slot through confirmed deletion and admits the original intent once`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(kind);
                yield* f.coordinator.record(f.input);
                expect(yield* f.coordinator.select(f.select)).toMatchObject({ phase: "waiting" });
                yield* f.coordinator.runOne(f.input.hostId);
                expect(
                  yield* makeThreadVmAllocationStore(f.incoming.sql).get(f.request.allocationId),
                ).toBeNull();
                yield* f.remove;
                expect(yield* threadVmQuotaUsage(f.incoming.sql, f.owner)).toBe(1);
                expect(yield* f.coordinator.runOne(f.input.hostId)).toBe(true);
                expect((yield* f.coordinator.get(f.request.operationId))?.phase).toBe("admitted");
                expect(
                  (yield* makeThreadVmAllocationStore(f.incoming.sql).get(f.request.allocationId))
                    ?.state,
                ).toBe("creating");
                expect(yield* threadVmQuotaUsage(f.incoming.sql, f.owner)).toBe(1);
                const operation =
                  kind === "reset"
                    ? yield* makeThreadVmResetStore(f.incoming.sql, f.incoming.objects).get(
                        f.request.operationId,
                      )
                    : yield* makeThreadVmRestoreStore(f.incoming.sql, f.incoming.objects).get(
                        f.request.operationId,
                      );
                expect(operation).toMatchObject({
                  allocationId: f.request.allocationId,
                  phase: "pending",
                });
                expect(yield* f.coordinator.runOne(f.input.hostId)).toBe(false);
              }),
            ),
        );
        it.effect(
          `${kind} revocation cancels the waiting request before the selected VM is removed`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(kind);
                yield* f.coordinator.record(f.input);
                yield* f.coordinator.select(f.select);
                yield* f.incoming
                  .sql`DELETE FROM relay_organization_members WHERE organization_id='org' AND user_id=${f.owner}`;
                yield* f.coordinator.runOne(f.input.hostId);
                expect((yield* f.coordinator.get(f.request.operationId))?.phase).toBe("cancelled");
                expect((yield* f.victim.allocations.get(f.victim.input.allocationId))?.state).toBe(
                  "running",
                );
                expect(
                  (yield* f.victim.store.get(
                    (yield* f.coordinator.get(f.request.operationId))!.finalSaveOperationId!,
                  ))?.phase,
                ).toBe("aborting");
              }),
            ),
        );
        it.effect(`${kind} rejects stale saved identity without selecting a victim`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(kind);
              yield* Effect.flip(
                f.coordinator.record({
                  ...f.input,
                  intent: { ...f.input.intent, sourceEnvironmentId: "wrong-source" },
                }),
              );
              expect(yield* f.coordinator.get(f.request.operationId)).toBeNull();
              expect((yield* f.victim.allocations.get(f.victim.input.allocationId))?.state).toBe(
                "running",
              );
            }),
          ),
        );
      }
    });
  },
);
