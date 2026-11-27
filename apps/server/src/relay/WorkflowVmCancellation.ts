import * as NodeCrypto from "node:crypto";
import type { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import { WorkflowRun } from "../jobs/WorkflowRunStore.ts";
import { ownershipReleased } from "../jobs/workflowOwnership.ts";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";
import {
  inspectVmWorkloads,
  VmWorkloadInventory,
  withSealedVmWorkloads,
  withVmWorkloadMaintenance,
} from "../vmWorkload.ts";
import { VmControlSpawner, VmWorkloadTracking, WorkflowVmGuest } from "../vmWorkloadCommand.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export const WorkflowVmCancellationProof = Schema.Struct({
  jobId: Schema.String,
  threadId: Schema.String,
  environmentId: Schema.String,
  allocationId: Schema.String,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  operationId: Schema.String,
  cancellationId: Schema.String,
  runtimeEpisode: Schema.String,
  continuationKey: Schema.String,
  providerInstanceId: Schema.String,
  bootId: VmWorkloadInventory.fields.bootId,
  epoch: VmWorkloadInventory.fields.epoch,
});
export type WorkflowVmCancellationProof = typeof WorkflowVmCancellationProof.Type;
export const workflowVmCancellationOperation = (
  proof: Pick<WorkflowVmCancellationProof, "jobId" | "cancellationId">,
) => `workflow:${proof.jobId}:cancel:${proof.cancellationId}`;
const operationHash = (operation: string) =>
  NodeCrypto.createHash("sha256").update(operation).digest("hex").slice(0, 32);
export const workflowVmCancellationSeal = (
  proof: Pick<WorkflowVmCancellationProof, "jobId" | "cancellationId">,
) => operationHash(workflowVmCancellationOperation(proof));
const cancellationPayload = Schema.Struct({
  workflowVmCancellation: WorkflowVmCancellationProof,
  providerContinuation: Schema.Struct({
    workflowJobId: Schema.String,
    continuationKey: Schema.String,
    runtimeEpisode: Schema.String,
    shutdownConfirmed: Schema.Literal(true),
    shutdownEvidenceVersion: Schema.Literal(2),
  }),
});
const decodePayload = Schema.decodeUnknownOption(cancellationPayload);
const decodeReadPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    ...cancellationPayload.fields,
    stoppedRuntimeEventsDrained: Schema.Literal(true),
  }),
);
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowRun));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const sameProof = Schema.toEquivalence(WorkflowVmCancellationProof);

/** Only saved, pinned diff queries may borrow a completed cancellation's seal. */
export const withWorkflowVmCancelledCheckpointRead = Effect.fn(
  "WorkflowVmCancellation.readCheckpoint",
)(function* <A, E, R>(
  sql: SqlClient.SqlClient,
  binding: WorkflowVmDispatchBinding,
  effect: Effect.Effect<A, E, R>,
) {
  if (!(yield* WorkflowVmGuest) || !(yield* VmWorkloadTracking)) return yield* effect;
  const fail = () =>
    new ThreadExecutionFenceError({
      threadId: binding.threadId,
      detail: "The cancelled VM checkpoint ownership could not be verified.",
    });
  const readPayload = Effect.fnUntraced(function* () {
    const [runtime] = yield* sql<{
      payload: unknown;
      status: string;
      instanceId: string;
      provider: string;
    }>`SELECT runtime_payload_json AS payload,status,provider_instance_id AS instanceId,
      provider_name AS provider FROM provider_session_runtime WHERE thread_id=${binding.threadId}`;
    if (!runtime || runtime.payload === null) return null;
    if (typeof runtime.payload !== "string") return yield* fail();
    const payload = yield* decodeJson(runtime.payload).pipe(Effect.mapError(fail));
    if (!Predicate.hasProperty(payload, "workflowVmCancellation")) return null;
    const decoded = decodeReadPayload(payload);
    if (Option.isNone(decoded)) return yield* fail();
    return { runtime, ...decoded.value };
  });
  const candidate = yield* readPayload();
  if (!candidate) return yield* effect;
  const proof = candidate.workflowVmCancellation;
  const control = yield* VmControlSpawner;
  if (!control) return yield* fail();
  const secrets = yield* Effect.serviceOption(ServerSecretStore);
  const verifyOwner = Effect.fnUntraced(function* () {
    const current = yield* readPayload();
    if (!current || !sameProof(current.workflowVmCancellation, proof)) return yield* fail();
    const owner = yield* makeThreadExecutionFence(sql).get(binding.threadId);
    const [record] = yield* sql<{
      record: string;
    }>`SELECT record_json AS record FROM repository_workflow_jobs
      WHERE job_id=${binding.jobId} AND thread_id=${binding.threadId}`;
    const run = record && Option.getOrUndefined(decodeRun(record.record));
    if (Option.isNone(secrets)) return yield* fail();
    const vm = yield* readInstalledThreadVm().pipe(
      Effect.provideService(ServerSecretStore, secrets.value),
      Effect.mapError(fail),
    );
    const { runtime, providerContinuation } = current;
    if (
      !run ||
      run.runtime.kind !== "vm" ||
      run.progress.status !== "cancelled" ||
      !ownershipReleased(run) ||
      run.jobId !== binding.jobId ||
      run.progress.threadId !== binding.threadId ||
      run.workflow.organizationId !== binding.organizationId ||
      run.workflow.repositoryId !== binding.repositoryId ||
      run.runtime.jobId !== binding.jobId ||
      run.runtime.organizationId !== binding.organizationId ||
      run.runtime.repositoryId !== binding.repositoryId ||
      run.runtime.threadId !== binding.threadId ||
      run.runtime.environmentId !== binding.environmentId ||
      run.runtime.allocationId !== binding.allocationId ||
      run.runtime.generation !== binding.generation ||
      run.runtime.operationId !== binding.operationId ||
      run.runtime.projectId !== binding.projectId ||
      proof.jobId !== binding.jobId ||
      proof.threadId !== binding.threadId ||
      proof.environmentId !== binding.environmentId ||
      proof.allocationId !== binding.allocationId ||
      proof.generation !== binding.generation ||
      proof.operationId !== binding.operationId ||
      proof.cancellationId.length === 0 ||
      proof.runtimeEpisode.length === 0 ||
      runtime.status !== "stopped" ||
      runtime.instanceId !== proof.providerInstanceId ||
      run.providerContinuation?.driver !== runtime.provider ||
      run.providerContinuation.continuationKey !== proof.continuationKey ||
      providerContinuation.workflowJobId !== proof.jobId ||
      providerContinuation.runtimeEpisode !== proof.runtimeEpisode ||
      providerContinuation.continuationKey !== proof.continuationKey ||
      !vm ||
      vm.scope.threadId !== binding.threadId ||
      vm.scope.repositoryId !== binding.repositoryId ||
      vm.scope.allocationId !== binding.allocationId ||
      vm.scope.generation !== binding.generation ||
      vm.environmentId !== binding.environmentId ||
      vm.operationId !== binding.operationId ||
      !owner ||
      owner.phase !== "active" ||
      owner.threadId !== binding.threadId ||
      owner.environmentId !== binding.environmentId ||
      owner.projectId !== binding.projectId ||
      owner.generation !== binding.generation ||
      owner.operationId !== binding.operationId ||
      owner.relayUrl !== vm.relayUrl
    )
      return yield* fail();
  });
  return yield* withSealedVmWorkloads(
    workflowVmCancellationOperation(proof),
    Effect.gen(function* () {
      yield* verifyOwner();
      const value = yield* effect;
      yield* verifyOwner();
      return value;
    }),
    { bootId: proof.bootId, epoch: proof.epoch },
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, control));
});

/** Final save may adopt a completed cancellation's seal only after closing local
 * admission. A crash between reopen and reseal is bound by the exact boot/epoch. */
export const adoptWorkflowVmCancellationSeal = Effect.fn("WorkflowVmCancellation.adoptSeal")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly threadId: string;
      readonly environmentId: string;
      readonly generation: number;
      readonly operationId: string;
    },
  ) {
    yield* withVmWorkloadMaintenance(
      sql.withTransaction(
        Effect.gen(function* () {
          const [runtime] = yield* sql<{
            payload: unknown;
            status: string;
            instanceId: string;
          }>`SELECT runtime_payload_json AS payload,status,provider_instance_id AS instanceId FROM provider_session_runtime WHERE thread_id=${input.threadId}`;
          if (!runtime || typeof runtime.payload !== "string") return;
          const payload = yield* decodeJson(runtime.payload);
          const decoded = decodePayload(payload);
          if (Option.isNone(decoded)) return;
          const { workflowVmCancellation: proof, providerContinuation } = decoded.value;
          const fail = () =>
            new ThreadExecutionFenceError({
              threadId: input.threadId,
              detail:
                "The cancelled VM workload seal cannot be adopted by this recovery operation.",
            });
          const owner = yield* makeThreadExecutionFence(sql).get(input.threadId);
          const [record] = yield* sql<{
            record: string;
          }>`SELECT record_json AS record FROM repository_workflow_jobs WHERE job_id=${proof.jobId} AND thread_id=${input.threadId}`;
          const run = record && Option.getOrUndefined(decodeRun(record.record));
          if (
            !owner ||
            !run ||
            run.runtime.kind !== "vm" ||
            run.jobId !== proof.jobId ||
            run.progress.threadId !== proof.threadId ||
            run.runtime.threadId !== proof.threadId ||
            run.runtime.jobId !== proof.jobId ||
            run.progress.status !== "cancelled" ||
            !ownershipReleased(run) ||
            runtime.status !== "stopped" ||
            runtime.instanceId !== proof.providerInstanceId ||
            owner.phase !== "draining" ||
            owner.operationId !== input.operationId ||
            owner.environmentId !== input.environmentId ||
            owner.generation !== input.generation ||
            proof.threadId !== input.threadId ||
            proof.environmentId !== input.environmentId ||
            proof.generation !== input.generation ||
            run.runtime.operationId !== proof.operationId ||
            run.runtime.allocationId !== proof.allocationId ||
            run.runtime.environmentId !== proof.environmentId ||
            run.runtime.generation !== proof.generation ||
            run.runtime.projectId !== owner.projectId ||
            providerContinuation.workflowJobId !== proof.jobId ||
            providerContinuation.runtimeEpisode !== proof.runtimeEpisode ||
            providerContinuation.continuationKey !== proof.continuationKey
          )
            return yield* fail();
          let inventory = yield* inspectVmWorkloads({ type: "inspect" });
          if (!inventory.stopped || inventory.bootId !== proof.bootId) return yield* fail();
          const oldOperation = workflowVmCancellationOperation(proof);
          if (
            inventory.sealedBy === operationHash(oldOperation) &&
            inventory.epoch === proof.epoch
          ) {
            inventory = yield* inspectVmWorkloads({
              type: "reopen",
              bootId: proof.bootId,
              operationId: oldOperation,
            });
          }
          if (inventory.sealedBy === null && inventory.epoch === proof.epoch + 1) {
            inventory = yield* inspectVmWorkloads({
              type: "seal",
              bootId: proof.bootId,
              operationId: input.operationId,
            });
          }
          if (
            !inventory.stopped ||
            inventory.sealedBy !== operationHash(input.operationId) ||
            inventory.epoch !== proof.epoch + 2
          )
            return yield* fail();
          yield* sql`UPDATE provider_session_runtime SET runtime_payload_json=json_remove(runtime_payload_json,'$.workflowVmCancellation') WHERE thread_id=${input.threadId}`;
        }),
      ),
    );
  },
);
