import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { SandboxInfo } from "e2b";
import { RelayConfiguration } from "../../Config.ts";
import * as SecretBox from "../../auth/SecretBox.ts";
import { makeThreadVmRestoreStore } from "../ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreServingStore } from "../ThreadVmRestoreServingStore.ts";
import { makeThreadVmRestoreServingWorker } from "../ThreadVmRestoreServingWorker.ts";
import { makeThreadVmRestoreWorker } from "../ThreadVmRestoreWorker.ts";
import { makeThreadVmSavedDiskStore } from "../ThreadVmSavedDiskStore.ts";
import { makeThreadVmCapacityStore } from "../ThreadVmCapacityStore.ts";
import { makeThreadPlacementStore } from "../ThreadPlacementStore.ts";
import { finalSaveCatalogFixture } from "./finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./nativeCheckpointCatalog.ts";

export const nativeRestoreSecretBoxTestLayer = SecretBox.layer.pipe(
  Layer.provide(
    Layer.succeed(RelayConfiguration, {
      relayIssuer: "https://relay.test",
      apns: null,
      clerkSecretKey: Redacted.make("clerk"),
      clerkPublishableKey: "public",
      clerkJwtAudience: "relay",
      apnsDeliveryJobSigningSecret: Redacted.make("push"),
      cloudMintPrivateKey: Redacted.make("restore-test-key"),
      cloudMintPublicKey: "public",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    }),
  ),
);
export const nativeRestoreTestLayer = Layer.mergeAll(
  nativeCheckpointCatalogTestLayer,
  nativeRestoreSecretBoxTestLayer,
);

export const nativeRestoreFixture = Effect.fnUntraced(function* () {
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
    serving = makeThreadVmRestoreServingStore(f.sql, f.objects),
    placements = makeThreadPlacementStore(f.sql);
  const retry = f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp() WHERE operation_id=${input.operationId}`;
  const prepare = Effect.gen(function* () {
    yield* restores.begin(input);
    yield* makeThreadVmRestoreWorker(
      f.sql,
      f.objects,
      {
        resolveSource: (sourceTemplateID, sourceBuildID) =>
          Effect.succeed({ sourceTemplateID, sourceBuildID }),
      },
      f.hostId,
    ).runOne();
    return (yield* serving.claim(f.hostId))!;
  });
  const sandboxId = `boot-${input.allocationId}`;
  const info = (): SandboxInfo => ({
    sandboxId,
    templateId: "snapshot",
    state: "running",
    metadata: {
      "launchpad.managed": "thread-vm-v1",
      "launchpad.allocation_id": input.allocationId,
      "launchpad.operation_id": input.operationId,
      "launchpad.thread_id": input.threadId,
      "launchpad.generation": "2",
      "launchpad.restore": "v1",
    },
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "pause", autoResume: false },
    cpuCount: 2,
    memoryMB: 4096,
    envdVersion: "test",
    startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-01T00:00:00Z")),
    endAt: DateTime.toDateUtc(DateTime.makeUnsafe("2099-01-01T00:00:00Z")),
  });
  const compute = {
    createFromSnapshot: () =>
      Effect.succeed({ sandboxId, trafficAccessToken: Redacted.make("native-private-token") }),
    findOperation: () => Effect.succeed([info()]),
    recoverIngress: () =>
      Effect.succeed({ sandboxId, trafficAccessToken: Redacted.make("native-private-token") }),
    inspect: () => Effect.succeed(info()),
    destroy: () => Effect.void,
  } satisfies Parameters<typeof makeThreadVmRestoreServingWorker>[2];
  const bootstrap: Parameters<typeof makeThreadVmRestoreServingWorker>[4] = (
    _id,
    _identity,
    request,
  ) =>
    Effect.succeed({
      version: 1,
      kind: "native-warm-restore-bootstrap-v1",
      ...request,
      targetSealEpoch: request.source.sealEpoch + 1,
      coordinatorStopped: true,
      sealRebound: true,
    });
  const worker = (
    overrides: Partial<Parameters<typeof makeThreadVmRestoreServingWorker>[2]> = {},
    boot = bootstrap,
    allowStart = true,
  ) =>
    makeThreadVmRestoreServingWorker(
      f.sql,
      f.objects,
      { ...compute, ...overrides },
      f.hostId,
      boot,
      allowStart,
    );
  const commit = Effect.gen(function* () {
    const claim = yield* prepare;
    return yield* serving.commit(claim);
  });
  const boot = Effect.gen(function* () {
    yield* commit;
    yield* worker().runOne();
    return (yield* restores.get(input.operationId))!;
  });
  return {
    ...f,
    sourceAllocationId: f.input.allocationId,
    input,
    point,
    restores,
    serving,
    placements,
    retry,
    prepare,
    commit,
    boot,
    sandboxId,
    info,
    compute,
    bootstrap,
    worker,
    capacity: makeThreadVmCapacityStore(f.sql),
    saved: makeThreadVmSavedDiskStore(f.sql),
  };
});
