import type { SandboxInfo } from "e2b";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { makeE2BThreadVmCompute, ThreadVmCreated } from "../machines/E2BThreadVmCompute.ts";
import type { makeE2BThreadVmWarmRestoreBootstrap } from "../machines/E2BThreadVmRestoreImport.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import {
  readThreadVmTrafficAccessToken,
  sealThreadVmTrafficAccessToken,
} from "./ThreadVmIngressToken.ts";
import {
  makeThreadVmRestoreStore,
  ThreadVmRestoreConflict,
  type ThreadVmRestore,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadVmRestoreServingStore } from "./ThreadVmRestoreServingStore.ts";

type RestoreCompute = Pick<
  ReturnType<typeof makeE2BThreadVmCompute>,
  "createFromSnapshot" | "findOperation" | "recoverIngress" | "inspect" | "destroy"
>;
const matches = (row: ThreadVmRestore, info: SandboxInfo, expectedId?: string) =>
  (!expectedId || info.sandboxId === expectedId) &&
  info.templateId === row.sourceTemplateId &&
  (info.state === "running" || info.state === "paused") &&
  info.network?.allowPublicTraffic === false &&
  info.lifecycle?.autoResume === false &&
  info.metadata["launchpad.managed"] === "thread-vm-v1" &&
  info.metadata["launchpad.allocation_id"] === row.allocationId &&
  info.metadata["launchpad.thread_id"] === row.threadId &&
  info.metadata["launchpad.generation"] === String(row.targetGeneration) &&
  info.metadata["launchpad.operation_id"] ===
    restoreBootOperationId(row.operationId, row.bootAttempt) &&
  info.metadata["launchpad.restore"] === "v1" &&
  (row.bootAttempt === 0 ||
    (info.metadata["launchpad.restore_parent_operation_id"] === row.operationId &&
      info.metadata["launchpad.restore_boot_attempt"] === String(row.bootAttempt)));

/** Native create has one durable dispatch. A warm target cannot enroll before trusted bootstrap. */
export function makeThreadVmRestoreServingWorker(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  compute: RestoreCompute,
  hostId: string,
  bootstrap: ReturnType<typeof makeE2BThreadVmWarmRestoreBootstrap>,
  allowStart = true,
) {
  const restores = makeThreadVmRestoreStore(sql, objects),
    serving = makeThreadVmRestoreServingStore(sql, objects);
  const runOne = Effect.fn("relay.thread_vm.restore.serve_one")(function* () {
    const claim = yield* serving.claim(hostId, allowStart);
    if (!claim) return false;
    yield* Effect.gen(function* () {
      const discover = Effect.fnUntraced(function* (row: ThreadVmRestore) {
        const found = yield* compute.findOperation(
          restoreBootOperationId(row.operationId, row.bootAttempt),
        );
        if (found.length !== 1 || !found[0] || !matches(row, found[0])) {
          yield* restores.defer(
            claim,
            found.length === 0 ? "create_uncertain" : "identity_conflict",
          );
          return null;
        }
        return yield* serving.recordObserved(claim, found[0].sandboxId);
      });
      const retire = Effect.fnUntraced(function* (row: ThreadVmRestore) {
        const recovery = yield* serving.beginBootRecovery(claim),
          boot = recovery.bootReceipt!;
        const current = yield* compute.inspect(boot.sandboxId);
        if (current && !matches(row, current, boot.sandboxId))
          return yield* new ThreadVmRestoreConflict({
            message: "Native deletion target identity changed.",
          });
        yield* compute.destroy(boot.sandboxId);
        yield* serving.retryStoppedBoot(claim, {
          ...boot,
          kind: "native-restore-deleted-boot-v1",
          acknowledged: true,
        });
      });
      if (claim.phase === "aborting") {
        let row: ThreadVmRestore = claim;
        if (!row.bootReceipt && row.bootCreateStarted) {
          const found = yield* discover(row);
          if (!found) return;
          row = found;
        }
        if (row.bootReceipt) {
          yield* retire(row);
          return;
        }
        yield* serving.completeCommittedAbort(claim);
        return;
      }
      let row: ThreadVmRestore = yield* serving.authorize(claim);
      if (row.phase === "prepared") {
        yield* serving.commit(claim);
        return;
      }
      if (row.bootRecoveryStarted) {
        yield* retire(row);
        return;
      }
      if (row.phase === "booted" || row.phase === "importing") {
        const current = yield* compute.inspect(row.bootReceipt!.sandboxId);
        if (!current) {
          yield* retire(row);
          return;
        }
        if (!matches(row, current, row.bootReceipt!.sandboxId))
          return yield* new ThreadVmRestoreConflict({ message: "Native boot identity changed." });
        const identity = {
          allocationId: row.allocationId,
          operationId: row.operationId,
          threadId: row.threadId,
          generation: row.targetGeneration!,
          templateId: row.sourceTemplateId,
        };
        const knownToken =
          current.state === "running"
            ? yield* readThreadVmTrafficAccessToken(sql, {
                ...identity,
                computeRef: current.sandboxId,
              }).pipe(
                Effect.catchTag("ThreadVmIngressTokenUnavailable", () => Effect.succeed(undefined)),
              )
            : undefined;
        if (!knownToken) {
          yield* serving.beginIngressRecovery(claim, current.sandboxId);
          const connected = yield* compute
            .recoverIngress(current.sandboxId, identity)
            .pipe(
              Effect.tapError((error) =>
                error.connectUncertain === false
                  ? serving.settleIngressRecovery(claim, current.sandboxId)
                  : Effect.void,
              ),
            );
          if (connected.sandboxId === current.sandboxId)
            yield* serving.settleIngressRecovery(claim, current.sandboxId);
          if (connected.sandboxId !== current.sandboxId || !connected.trafficAccessToken)
            return yield* new ThreadVmRestoreConflict({
              message: "Native enrolled boot ingress is unconfirmed.",
            });
          yield* serving.admitIngressRecovery(claim, current.sandboxId);
          const sealedTrafficAccessToken = yield* sealThreadVmTrafficAccessToken(
            { ...identity, computeRef: current.sandboxId },
            connected.trafficAccessToken,
          );
          yield* serving.recordObserved(claim, current.sandboxId, sealedTrafficAccessToken);
        }
        yield* serving.confirmStillActive(claim);
        return;
      }
      let created: ThreadVmCreated | undefined;
      if (row.phase === "committed") {
        row = yield* serving.beginCreate(claim);
        created = yield* compute.createFromSnapshot({
          allocationId: row.allocationId,
          operationId: restoreBootOperationId(row.operationId, row.bootAttempt),
          threadId: row.threadId,
          generation: row.targetGeneration!,
          environment: {},
          sourceTemplateId: row.sourceTemplateId,
          sourceBuildId: row.sourceBuildId,
          restoreOperationId: row.operationId,
          bootAttempt: row.bootAttempt,
        });
        row = yield* serving.recordObserved(claim, created.sandboxId);
      } else if (row.phase === "creating") {
        const found = yield* discover(row);
        if (!found) return;
        row = yield* serving.authorize(claim);
      }
      const boot = row.bootReceipt!;
      const identity = {
        allocationId: row.allocationId,
        operationId: row.operationId,
        threadId: row.threadId,
        generation: row.targetGeneration!,
        templateId: row.sourceTemplateId,
      };
      const current = yield* compute.inspect(boot.sandboxId);
      if (!current) {
        yield* retire(row);
        return;
      }
      if (!matches(row, current, row.bootReceipt!.sandboxId))
        return yield* new ThreadVmRestoreConflict({ message: "Native restored identity changed." });
      const stored =
        current.state === "running"
          ? yield* readThreadVmTrafficAccessToken(sql, {
              ...identity,
              computeRef: boot.sandboxId,
            }).pipe(
              Effect.catchTag("ThreadVmIngressTokenUnavailable", () => Effect.succeed(undefined)),
            )
          : undefined;
      let token = created?.trafficAccessToken ?? stored;
      if (!token) {
        yield* serving.beginIngressRecovery(claim, boot.sandboxId);
        const connected = yield* compute
          .recoverIngress(boot.sandboxId, identity)
          .pipe(
            Effect.tapError((error) =>
              error.connectUncertain === false
                ? serving.settleIngressRecovery(claim, boot.sandboxId)
                : Effect.void,
            ),
          );
        if (connected.sandboxId === boot.sandboxId)
          yield* serving.settleIngressRecovery(claim, boot.sandboxId);
        if (connected.sandboxId !== boot.sandboxId || !connected.trafficAccessToken)
          return yield* new ThreadVmRestoreConflict({
            message: "Native ingress identity is unconfirmed.",
          });
        token = connected.trafficAccessToken;
      }
      yield* serving.admitIngressRecovery(claim, boot.sandboxId);
      const sealedTrafficAccessToken = yield* sealThreadVmTrafficAccessToken(
        { ...identity, computeRef: boot.sandboxId },
        token,
      );
      yield* serving.recordObserved(claim, boot.sandboxId, sealedTrafficAccessToken);
      const authorized = yield* serving.authorize(claim),
        source = yield* restores.requireRecovery(authorized);
      const receipt = yield* bootstrap(
        boot.sandboxId,
        {
          operationId: row.operationId,
          templateId: row.sourceTemplateId,
          scope: {
            allocationId: row.allocationId,
            threadId: ThreadId.make(row.threadId),
            repositoryId: authorized.repositoryId,
            generation: row.targetGeneration!,
          },
        },
        {
          boot: {
            version: 1,
            operationId: row.operationId,
            allocationId: row.allocationId,
            threadId: ThreadId.make(row.threadId),
            generation: row.targetGeneration!,
          },
          source: {
            allocationId: source.allocationId,
            operationId: source.source.provisionOperationId,
            threadId: ThreadId.make(source.threadId),
            generation: source.generation,
            bootId: source.source.bootId,
            captureOperationId: source.source.captureOperationId,
            sealEpoch: source.source.sealEpoch,
          },
        },
      );
      yield* serving.recordBootstrap(claim, receipt);
    }).pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => restores.defer(claim, "boot_unconfirmed"),
        ThreadVmIngressTokenUnavailable: () => restores.defer(claim, "ingress_unconfirmed"),
        ThreadVmRestoreConflict: () => restores.defer(claim, "recovery_unconfirmed"),
        ThreadNativeCheckpointConflict: () => restores.defer(claim, "recovery_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
