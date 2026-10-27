import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type { SandboxInfo } from "e2b";
import { makeThreadVmFinalSaveStore } from "../ThreadVmFinalSaveStore.ts";
import { makeThreadVmBackupStore } from "../ThreadVmBackupStore.ts";
import { makeThreadVmAllocationStore } from "../ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "../ThreadVmCapacityStore.ts";
import { makeThreadVmPauseRecoveryStore } from "../ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmPauseStore } from "../ThreadVmPauseStore.ts";
import { makeThreadVmProvisionStore } from "../ThreadVmProvisionStore.ts";
import {
  attachmentCheckpointCatalogFixture,
  laterAttachmentCheckpoint,
} from "./attachmentCheckpointCatalog.ts";

export const finalSaveCatalogFixture = Effect.fnUntraced(function* (
  state: "running" | "paused" = "running",
) {
  const f = yield* attachmentCheckpointCatalogFixture;
  const actorUserId = NodeCrypto.randomUUID(),
    allocationId = NodeCrypto.randomUUID(),
    hostId = NodeCrypto.randomUUID(),
    credentialId = NodeCrypto.randomUUID(),
    computeRef = `compute-${allocationId}`;
  yield* f.sql`UPDATE relay_thread_placements SET owner_user_id=${actorUserId} WHERE thread_id=${f.threadId}`;
  const allocations = makeThreadVmAllocationStore(f.sql),
    capacity = makeThreadVmCapacityStore(f.sql),
    provisions = makeThreadVmProvisionStore(f.sql);
  yield* allocations.reserve({
    allocationId,
    threadId: f.threadId,
    organizationId: "org",
    ownerUserId: actorUserId,
    templateId: "template:build-verified",
  });
  yield* capacity.configure(hostId, 1);
  yield* provisions.enqueue({ allocationId, operationId: allocationId, generation: 1, hostId });
  yield* capacity.admitNext(hostId);
  yield* provisions.claim("final-test", hostId);
  yield* provisions.beginCreate({
    allocationId,
    claimId: "final-test",
    templateId: "template:build-verified",
  });
  yield* provisions.recordCreated({ allocationId, claimId: "final-test", computeRef });
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credentialId},${f.sourceEnvironmentId},'test-key',${credentialId},'now','now')`;
  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${f.sourceEnvironmentId},${allocationId},${f.threadId},'repo',1,'test-key',${credentialId})`;
  yield* f.sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256) VALUES(${allocationId},'github.com/acme/test','main',${"a".repeat(40)},'ready',${f.sourceEnvironmentId},${"a".repeat(64)})`;
  yield* f.sql`INSERT INTO relay_thread_vm_activity(allocation_id,revision,activity,observed_at,idle_since,last_work_at) VALUES(${allocationId},1,'idle',clock_timestamp(),clock_timestamp()-interval '10 days',clock_timestamp()-interval '10 days')`;
  let pausedPoint: Effect.Success<ReturnType<typeof laterAttachmentCheckpoint>> | undefined;
  if (state === "paused") {
    const pauses = makeThreadVmPauseStore(f.sql),
      recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
    yield* pauses.reserveIdle(hostId);
    const pause = (yield* recovery.get(f.owner))!,
      bootId = NodeCrypto.randomUUID();
    pausedPoint = yield* laterAttachmentCheckpoint(f, 1, pause.operationId);
    yield* f.upload(pausedPoint.attachments);
    yield* f.attachmentStore.publish({
      threadId: f.threadId,
      operationId: pausedPoint.attachments.header.operationId,
      manifestArtifactId: pausedPoint.attachments.artifactId,
      nativeCheckpointOperationId: pausedPoint.native.header.operationId,
    });
    yield* recovery.sourceFrozen({
      ...f.owner,
      operationId: pause.operationId,
      bootId,
      nativeCheckpointOperationId: pausedPoint.native.header.operationId,
    });
    const claim = (yield* pauses.claim(hostId))!;
    yield* pauses.markSealed(claim, bootId);
    yield* pauses.finish(claim);
  }
  const operationId: string = NodeCrypto.randomUUID();
  const input = {
    operationId,
    threadId: f.threadId,
    allocationId,
    actorUserId,
    expectedGeneration: 1,
    reason: "idle" as const,
  };
  const store = makeThreadVmFinalSaveStore(f.sql, f.objects);
  const freeze = Effect.gen(function* () {
    if (pausedPoint) return pausedPoint;
    const point = yield* laterAttachmentCheckpoint(f, 1, input.operationId);
    yield* f.upload(point.attachments);
    yield* f.attachmentStore.publish({
      threadId: f.threadId,
      operationId: point.attachments.header.operationId,
      manifestArtifactId: point.attachments.artifactId,
      nativeCheckpointOperationId: point.native.header.operationId,
    });
    yield* store.sourceFrozen({
      operationId: input.operationId,
      environmentId: f.sourceEnvironmentId,
      generation: 1,
      nativeCheckpointOperationId: point.native.header.operationId,
    });
    return point;
  });
  const backup = makeThreadVmBackupStore(f.sql);
  const verifyBackup = Effect.gen(function* () {
    const save = yield* store.reserveBackup(input.operationId);
    const capture = (yield* backup.claim(hostId, true))!;
    yield* backup.beginCapture(capture);
    yield* backup.recordCapture(capture, {
      snapshotId: `snapshot-${capture.operationId}`,
      sourceTemplateId: "snapshot",
      sourceBuildId: NodeCrypto.randomUUID(),
    });
    const probe = (yield* backup.claim(hostId, true))!,
      build = NodeCrypto.randomUUID();
    yield* backup.markProbeReady(probe, {
      operationID: probe.operationId,
      generation: `backup-${probe.operationId}`,
      preparedBuildID: build,
      manifestSHA256: "a".repeat(64),
      coldProbe: {
        version: 1,
        preparedBuildID: build,
        rootfsSHA256: "b".repeat(64),
        initSHA256: "c".repeat(64),
        physicalStopConfirmed: true,
        mountOnly: true,
      },
    });
    yield* backup.complete(probe);
    return save;
  });
  const info: SandboxInfo = {
    sandboxId: computeRef,
    templateId: "template",
    metadata: {
      "launchpad.managed": "thread-vm-v1",
      "launchpad.allocation_id": allocationId,
      "launchpad.operation_id": allocationId,
      "launchpad.thread_id": f.threadId,
      "launchpad.generation": "1",
    },
    state,
    cpuCount: 2,
    memoryMB: 4096,
    envdVersion: "test",
    startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-01T00:00:00Z")),
    endAt: DateTime.toDateUtc(DateTime.makeUnsafe("2099-01-01T00:00:00Z")),
  };
  return {
    ...f,
    input,
    store,
    allocations,
    hostId,
    computeRef,
    credentialId,
    freeze,
    verifyBackup,
    info,
    backup,
  };
});
