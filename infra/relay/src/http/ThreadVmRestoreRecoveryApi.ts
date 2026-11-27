import { readWorkflowVmBinding } from "../jobs/WorkflowVmBinding.ts";
import { lockWorkflowVmCheckpoint } from "../jobs/WorkflowVmCheckpoint.ts";
import {
  readWorkflowVmPublishing,
  type WorkflowVmPublication,
} from "../jobs/WorkflowVmPublishing.ts";
import { readHeldPublishingBackup } from "../threads/WorkflowVmPublishingRecovery.ts";
import {
  WorkflowVmPublishingAction,
  type RepositoryWorkflowJob,
  type WorkflowVmPublishingRestore,
} from "@t3tools/contracts/workflows";
import { readWorkflowRestorePublication } from "../threads/WorkflowVmWorkspace.ts";
import { makeThreadArtifactStore } from "../threads/ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "../threads/ThreadArtifactTransfer.ts";
import { makeThreadVmResetImportStore } from "../threads/ThreadVmResetImportStore.ts";
import {
  RelayThreadVmRestoreRecovery,
  type RelayThreadVmRestoreImportReceipt,
} from "@t3tools/contracts/relay";
import { makeThreadVmRestoreImportStore } from "../threads/ThreadVmRestoreImportStore.ts";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "../threads/ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "../threads/ThreadAttachmentCheckpointStore.ts";
import { makeThreadVmRestoreStore } from "../threads/ThreadVmRestoreStore.ts";
import { makeThreadMoveCheckpointStore } from "../threads/ThreadMoveCheckpointStore.ts";
import { makeThreadVmRecoveryHistory } from "../threads/ThreadVmRecoveryHistory.ts";
import { withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { makeThreadVmCodexAuthStore } from "../threads/ThreadVmCodexAuthStore.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";

type Owner = { threadId: string; environmentId: string; generation: number };
const decodeRecovery = Schema.decodeEffect(RelayThreadVmRestoreRecovery);
const decodePublishingAction = Schema.decodeUnknownEffect(WorkflowVmPublishingAction);
const failures = {
  ThreadVmResetConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadVmRestoreConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
  SchemaError: () => tenancyConflict("thread_checkpoint_conflict"),
};
// The restore endpoints additionally require the exact fresh allocation and
// generation. Repository VM credentials have no personal owner to authorize.
const withRestoreEnvironment = <A, E, R>(
  input: Owner,
  action: Effect.Effect<A, E, R>,
  activatingOperationId?: string,
) =>
  Effect.gen(function* () {
    const principal = yield* RelayEnvironmentPrincipal;
    const sql = (yield* RelayDb).$client;
    const access = Effect.gen(function* () {
      const [workflow] = yield* sql<{ jobId: string }>`SELECT t.workflow_job_id AS "jobId"
        FROM relay_thread_placements t JOIN relay_thread_vm_restores r ON r.thread_id=t.thread_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE t.thread_id=${input.threadId} AND t.audience='repository'
          AND t.environment_id=${principal.environmentId}
          AND a.allocation_id=${principal.threadVm?.allocationId ?? null} AND a.resource_kind='organization_workflow'
          AND t.generation=${input.generation} AND r.target_generation=t.generation
          AND (t.operation_id=r.operation_id OR (r.phase='completed' AND t.operation_id IS NULL))
          ${activatingOperationId === undefined ? sql`` : sql`AND r.operation_id=${activatingOperationId}`}`;
      // Activation and follow-up polling both acquire the workflow job before the placement.
      if (workflow && activatingOperationId) yield* lockWorkflowVmCheckpoint(sql, workflow.jobId);
      return yield* withEnvironmentThread(input, workflow ? "workflow-lifecycle" : true, action);
    });
    return yield* activatingOperationId ? sql.withTransaction(access) : access;
  }).pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));

const recovery = Effect.fnUntraced(function* (input: Owner, operationId?: string) {
  const principal = yield* RelayEnvironmentPrincipal;
  if (!principal.threadVm) return yield* tenancyNotFound("thread_not_found");
  const sql = (yield* RelayDb).$client,
    objects = yield* ThreadArtifactObjectStorage;
  return yield* withRestoreEnvironment(
    input,
    Effect.gen(function* () {
      const [intent] = yield* sql<{ operationId: string }>`SELECT r.operation_id AS "operationId"
      FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
      JOIN relay_thread_vm_enrollments e ON e.allocation_id=r.allocation_id
      WHERE r.thread_id=${input.threadId} AND r.allocation_id=${principal.threadVm!.allocationId}
        AND r.target_generation=${input.generation} AND r.phase='importing' AND r.serving_requested AND r.bootstrap_receipt->>'kind'='native-warm-restore-bootstrap-v1'
        AND t.operation_id=r.operation_id AND t.environment_id=${input.environmentId}
        AND e.installed_at IS NOT NULL AND e.environment_id=t.environment_id
        AND e.operation_id=r.operation_id AND (${operationId === undefined} OR r.operation_id=${operationId ?? ""})`;
      if (!intent) {
        const [reset] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId" FROM relay_thread_vm_resets r
          JOIN relay_thread_placements t USING(thread_id) WHERE r.thread_id=${input.threadId} AND r.allocation_id=${principal.threadVm!.allocationId}
            AND r.expected_generation+1=${input.generation} AND r.phase='importing' AND t.operation_id=r.operation_id
            AND t.environment_id=${input.environmentId} AND (${operationId === undefined} OR r.operation_id=${operationId ?? ""})`;
        if (reset)
          return yield* makeThreadVmResetImportStore(sql, objects).recovery(reset.operationId);
        if (operationId) return yield* tenancyNotFound("thread_not_found");
        return null;
      }
      const restores = makeThreadVmRestoreStore(sql, objects),
        row = yield* restores.lock(intent.operationId);
      const source = yield* restores.requireRecovery(row);
      const native = yield* makeThreadNativeCheckpointStore(sql, objects).getForOperation(row);
      const attachments = yield* makeThreadAttachmentCheckpointStore(sql, objects).getForOperation(
        row,
      );
      const checkpoint = row.workflowCheckpoint;
      const publication = checkpoint
        ? yield* readWorkflowRestorePublication(sql, row.threadId, checkpoint)
        : null;
      const target = checkpoint
        ? yield* readWorkflowVmBinding(
            sql,
            {
              jobId: checkpoint.jobId,
              threadId: row.threadId,
              environmentId: input.environmentId,
              generation: input.generation,
            },
            "enrolled",
          )
        : null;
      if (
        (checkpoint && (!publication || !target || target.allocationId !== row.allocationId)) ||
        (native &&
          (!attachments ||
            native.sourceSequence !== attachments.sourceSequence ||
            native.archiveSha256 !== attachments.nativeArchiveSha256)) ||
        (!native && (!checkpoint || row.nativeCheckpointOperationId !== null || attachments))
      )
        return yield* tenancyConflict("thread_checkpoint_conflict");
      let publishing: WorkflowVmPublishingRestore | undefined;
      if (row.publishingActionId) {
        if (!checkpoint || row.publishingExpectedRevision == null)
          return yield* tenancyConflict("thread_checkpoint_conflict");
        const current = yield* readWorkflowVmPublishing(
          sql,
          checkpoint.jobId,
          row.publishingActionId,
        );
        const held = current?.recoverySource
          ? yield* readHeldPublishingBackup(sql, row.threadId, current.recoverySource)
          : null;
        if (
          !current ||
          held?.savedDiskOperationId !== row.savedDiskOperationId ||
          held?.checkpoint.publicationId !== checkpoint.publicationId
        )
          return yield* tenancyConflict("thread_checkpoint_conflict");
        const [projection] = yield* sql<{ record: RepositoryWorkflowJob; revision: number }>`
          SELECT j.record,h.revision FROM relay_workflow_jobs j
          JOIN relay_workflow_recovery_heads h USING(job_id) WHERE j.job_id=${checkpoint.jobId}`;
        if (!projection || projection.revision < checkpoint.publicationRevision)
          return yield* tenancyConflict("thread_checkpoint_conflict");
        const previous = yield* sql<{ record: WorkflowVmPublication }>`SELECT previous.record
          FROM relay_workflow_vm_publications previous
          JOIN relay_workflow_vm_publications current ON current.job_id=previous.job_id
          WHERE current.job_id=${checkpoint.jobId} AND current.action_id=${row.publishingActionId}
            AND previous.ordinal<current.ordinal AND previous.record#>>'{outcome,commitSha}' IS NOT NULL
            AND (previous.record->>'resultTurnId'=${current.resultTurnId} OR previous.record->>'operation'='push')
          ORDER BY previous.ordinal DESC`;
        const completed = yield* Effect.forEach(previous, ({ record }) =>
          Effect.gen(function* () {
            if (!record.outcome) return null;
            return { ...(yield* decodePublishingAction(record)), outcome: record.outcome };
          }),
        );
        const actions = completed.filter((entry) => entry !== null);
        publishing = {
          action: yield* decodePublishingAction(current),
          outcome: current.outcome,
          previousPush: actions.find((entry) => entry.operation === "push") ?? null,
          completedActions: actions.filter((entry) => entry.resultTurnId === current.resultTurnId),
          expectedRevision: row.publishingExpectedRevision,
          latestPublicationRevision: projection.revision,
          responses: projection.record.progress?.responses ?? [],
        };
      }
      const [head] =
        checkpoint?.finishedWorkspaceRevision !== undefined
          ? yield* sql<{ revision: number }>`SELECT revision FROM relay_workflow_recovery_heads
          WHERE job_id=${checkpoint.jobId}`
          : [];
      return {
        operationId: row.operationId,
        ...(row.savedDiskOperationId
          ? { savedDiskOperationId: row.savedDiskOperationId }
          : { independentHistory: row.independentHistory! }),
        environmentId: EnvironmentId.make(principal.environmentId),
        scope: principal.threadVm!,
        native,
        attachments,
        ...(checkpoint && publication && target
          ? {
              workflow: {
                checkpoint,
                ...publication,
                binding: target.binding,
                sourceSequence: source.source.sourceSequence,
                ...(head ? { latestPublicationRevision: head.revision } : {}),
                ...(publishing ? { publishing } : {}),
              },
            }
          : {}),
      };
    }),
  );
});

/** Fresh allocation identity only. Old snapshots cannot use their revoked key to
 * obtain retained native/chat bytes or discover another thread's recovery point. */
export const getThreadVmRestoreRecovery = Effect.fn("relay.api.restore.recovery")(function* (
  input: Owner,
) {
  return yield* recovery(input);
}, Effect.catchTags(failures));

export const readThreadVmRestoreArtifact = Effect.fn("relay.api.restore.artifact")(
  function* (input: Owner & { operationId: string; artifactId: string }) {
    const point = yield* recovery(input, input.operationId);
    if (!point) return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    const decoded = yield* decodeRecovery(point);
    const repository = decoded.reset?.repositoryUpload;
    const uploaded = repository?.bundle.chunks.some(
      (chunk) => chunk.artifactId === input.artifactId,
    );
    // Eagerly verify the exact operation pin and object before HTTP headers. The
    // existing bounded read lease survives operation completion until this read ends.
    const body = yield* withRestoreEnvironment(
      input,
      Effect.gen(function* () {
        if (uploaded && repository)
          return yield* makeThreadMoveCheckpointStore(sql, objects).openRepositoryUpload({
            threadId: input.threadId,
            operationId: repository.operationId,
            artifactId: input.artifactId,
          });
        if (decoded.workflow?.manifest.state.artifactId === input.artifactId) {
          const state = decoded.workflow.manifest.state;
          const artifacts = makeThreadArtifactStore(sql);
          const artifact = yield* artifacts.get(input.artifactId);
          if (
            !artifact ||
            artifact.threadId !== input.threadId ||
            artifact.state !== "complete" ||
            artifact.sha256 !== state.sha256 ||
            artifact.sizeBytes !== state.sizeBytes
          )
            return yield* tenancyConflict("thread_artifact_conflict");
          const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
          const lease = { threadId: input.threadId, artifactId: input.artifactId, operationId };
          return (yield* makeThreadArtifactTransfer(sql, objects).readPinned(lease)).pipe(
            Stream.ensuring(artifacts.releasePin(lease).pipe(Effect.ignore)),
          );
        }
        if (decoded.independentHistory) {
          const history = makeThreadVmRecoveryHistory(sql, objects);
          if (yield* history.ownsArtifact(input)) return yield* history.openForOperation(input);
        }
        return yield* makeThreadNativeCheckpointStore(sql, objects).openForOperation(input);
      }),
    );
    return body.pipe(
      Stream.provideContext(
        yield* Effect.context<RelayDb | ThreadArtifactObjectStorage | Crypto.Crypto>(),
      ),
    );
  },
  Effect.catchTags({
    ...failures,
    ThreadVmRecoveryHistoryConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadMoveCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadArtifactConflict: () => tenancyConflict("thread_artifact_conflict"),
    ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const confirmThreadVmRestoreActivation = Effect.fn("relay.api.restore.activate")(
  function* (input: Owner, receipt: RelayThreadVmRestoreImportReceipt) {
    if (
      receipt.environmentId !== input.environmentId ||
      receipt.scope.threadId !== input.threadId ||
      receipt.scope.generation !== input.generation
    )
      return yield* tenancyConflict("thread_checkpoint_conflict");
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* withRestoreEnvironment(
      input,
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        const placement = yield* makeThreadPlacementStore(sql).getAny(input.threadId);
        if (!principal.threadVm || !placement) return yield* tenancyNotFound("thread_not_found");
        yield* makeThreadVmCodexAuthStore(sql).requireAcknowledged({
          ...input,
          allocationId: principal.threadVm.allocationId,
          organizationId: placement.organizationId,
        });
        const reset =
          yield* sql`SELECT 1 FROM relay_thread_vm_resets WHERE operation_id=${receipt.operationId} AND thread_id=${input.threadId}`;
        return yield* reset.length
          ? makeThreadVmResetImportStore(sql, objects).finish(receipt)
          : makeThreadVmRestoreImportStore(sql, objects).finish(receipt);
      }),
      receipt.operationId,
    );
  },
  Effect.catchTags({
    ...failures,
    ThreadVmSavedDiskConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
