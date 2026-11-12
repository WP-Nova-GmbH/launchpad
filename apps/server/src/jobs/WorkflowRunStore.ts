import * as NodeCrypto from "node:crypto";
import { makeWorkflowResultOutbox, type WorkflowResultCapture } from "./WorkflowResultOutbox.ts";
import {
  ModelSelection,
  ProviderDriverKind,
  type OrchestrationCommand,
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  WorkflowOrigin,
  TrimmedNonEmptyString,
  sameWorkflowOrigin,
} from "@t3tools/contracts";
import {
  RepositoryWorkflow,
  WorkflowMachineTarget,
  WorkflowVmDispatchBinding,
  WorkflowJobProgress,
  WorkflowReviewCheckpoint,
  WorkflowResponseSummary,
  WorkflowManualControl,
  WorkflowManualPause,
} from "@t3tools/contracts/workflows";
import {
  LAUNCHPAD_JOB_BRANCH_PREFIX,
  normalizeStoredWorkflow,
} from "@t3tools/shared/workflowStorage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { getPromptQueue } from "../persistence/ProjectionPromptQueues.ts";
import { BootEvidence } from "../terminal/SetupProcessAdapter.ts";
import { ownershipReleased } from "./workflowOwnership.ts";
import { classifyApprovalRequest } from "./approvalClassification.ts";
import {
  admittedWorkflowTurnId,
  canRecoverPausedWorkflowTurn,
  workflowPromptId,
} from "./workflowSequence.ts";

const decodeOrigin = Schema.decodeUnknownSync(WorkflowOrigin);

const SetupCleanup = Schema.Struct({
  attemptId: Schema.String,
  state: Schema.Literals(["pending", "done", "failed"]),
  detail: Schema.NullOr(Schema.String),
});
export const WorkflowSequence = Schema.Struct({
  cursor: Schema.Int,
  generation: Schema.Int,
  started: Schema.Boolean,
  stepStartedAt: Schema.String,
  completed: Schema.Array(
    Schema.Struct({
      stepId: Schema.String,
      generation: Schema.Int,
      checkpoint: Schema.NullOr(WorkflowReviewCheckpoint),
      head: Schema.NullOr(Schema.String),
    }),
  ),
  responses: Schema.Array(WorkflowResponseSummary),
  feedback: Schema.NullOr(Schema.String),
});
export type WorkflowSequence = typeof WorkflowSequence.Type;
export const WorkflowActionRecord = Schema.Struct({
  actionId: Schema.String,
  stepId: Schema.String,
  generation: Schema.Int,
  operation: Schema.Literals(["push", "open_pull_request"]),
  state: Schema.Literals(["running", "uncertain", "failed", "completed"]),
  phase: Schema.Literals(["prepare", "commit", "push", "pull_request", "done"]),
  parent: Schema.String,
  tree: Schema.String,
  checkpointRef: Schema.String,
  checkpointTurnId: Schema.optional(Schema.String),
  commitMessage: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  oldRemoteSha: Schema.NullOr(Schema.String),
  prTitle: Schema.NullOr(Schema.String),
  prBody: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  retryRevision: Schema.optional(Schema.Int),
  commands: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      phase: Schema.optional(Schema.Literals(["prepare", "commit", "push", "pull_request"])),
      pid: Schema.NullOr(Schema.Number),
      identity: Schema.NullOr(Schema.String),
      boot: Schema.NullOr(BootEvidence),
      stopped: Schema.Boolean,
      code: Schema.NullOr(Schema.Int),
    }),
  ),
});
export type WorkflowActionRecord = typeof WorkflowActionRecord.Type;
const WorkflowRunRuntime = Schema.Union([
  WorkflowMachineTarget,
  Schema.Struct({ ...WorkflowVmDispatchBinding.fields, kind: Schema.Literal("vm") }),
]);
export const WorkflowRun = Schema.Struct({
  actions: Schema.optional(Schema.Array(WorkflowActionRecord)),
  publication: Schema.optional(
    Schema.Struct({
      remoteName: Schema.String,
      remoteUrl: Schema.String,
      publishedHead: Schema.NullOr(Schema.String),
      pullRequestUrl: Schema.NullOr(Schema.String),
    }),
  ),
  manualPause: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...WorkflowManualPause.fields,
        promptId: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  lastManualControl: Schema.optional(Schema.NullOr(WorkflowManualControl)),
  sequence: Schema.optional(WorkflowSequence),
  /** Pinned before acceptance so an instance ID cannot hide a changed resume identity. */
  providerContinuation: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      continuationKey: Schema.String,
    }),
  ),
  jobId: Schema.String,
  /** Existing runs without this field keep the branch chosen before the prefix change. */
  jobBranchPrefix: Schema.optional(Schema.Literals([LAUNCHPAD_JOB_BRANCH_PREFIX, "launchpad-job"])),
  origin: Schema.optional(WorkflowOrigin),
  userId: Schema.NullOr(TrimmedNonEmptyString),
  repositoryCanonicalKey: Schema.String,
  instruction: Schema.String,
  workflow: RepositoryWorkflow,
  runtime: WorkflowRunRuntime,
  progress: WorkflowJobProgress,
  modelSelection: ModelSelection,
  baseBranch: Schema.String,
  baseSha: Schema.String,
  createdAt: Schema.String,
  /** Saved before the prompt command; retries use the same command and message IDs. */
  promptDispatched: Schema.Boolean,
  executionReserved: Schema.Boolean,
  worktreePath: Schema.NullOr(Schema.String),
  preparedHead: Schema.NullOr(Schema.String),
  approvedBy: Schema.NullOr(Schema.String),
  approvalAttempt: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        approvedBy: Schema.NullOr(Schema.String),
        checkpointId: Schema.String,
        preparedHead: Schema.String,
        acceptedRevision: Schema.Int,
        commandId: Schema.String,
        createdAt: Schema.String,
        setupCleanup: Schema.optional(SetupCleanup),
        /** A sequence review advances only after its saved result has been verified. */
        response: Schema.optional(
          Schema.Struct({
            ...WorkflowResponseSummary.fields,
            operation: Schema.Literal("approve"),
          }),
        ),
      }),
    ),
  ),
  cancellationAttempt: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commandId: Schema.String,
        /** Native VM cleanup keeps its original seal when orchestration retries use a new command. */
        workloadCancellationId: Schema.optional(Schema.String),
        createdAt: Schema.String,
        setupCleanup: Schema.optional(SetupCleanup),
      }),
    ),
  ),
  pendingQueueDismissal: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commandId: Schema.String,
        expectedRevision: Schema.Int,
        createdAt: Schema.String,
      }),
    ),
  ),
  pendingPreparationRetry: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commandId: Schema.String,
        expectedRevision: Schema.Int,
        expectedControlRevision: Schema.Int,
        createdAt: Schema.String,
      }),
    ),
  ),
});
export type WorkflowRun = typeof WorkflowRun.Type;
export function workflowRunOrigin(run: WorkflowRun): WorkflowOrigin {
  return decodeOrigin(
    run.origin ?? (run.userId ? { kind: "manual", userId: run.userId } : undefined),
  );
}
const WorkflowCancellation = Schema.Struct({
  origin: Schema.optional(WorkflowOrigin),
  jobId: Schema.String,
  organizationId: Schema.String,
  repositoryId: Schema.String,
  projectId: Schema.String,
  repositoryCanonicalKey: Schema.String,
  createdAt: Schema.String,
});
export type WorkflowCancellation = typeof WorkflowCancellation.Type;
const decodeCancellation = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowCancellation));
const encodeCancellation = Schema.encodeSync(Schema.fromJsonString(WorkflowCancellation));
const readStoredRun = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...WorkflowRun.fields,
      workflow: Schema.Unknown,
      runtime: Schema.optional(WorkflowRunRuntime),
    }),
  ),
);
const decodeRun = Schema.decodeUnknownSync(WorkflowRun);
const decode = (json: string): WorkflowRun => {
  const stored = readStoredRun(json);
  const workflow = normalizeStoredWorkflow(stored.workflow);
  const runtime = stored.runtime ?? workflow.definition.target;
  if (runtime.kind === "vm" && !("threadId" in runtime))
    throw new Error("Incomplete persisted workflow VM binding.");
  const run = decodeRun({ ...stored, workflow, runtime });
  if (
    run.runtime.kind === "vm" &&
    (run.runtime.jobId !== run.jobId ||
      run.runtime.threadId !== run.progress.threadId ||
      run.runtime.organizationId !== workflow.organizationId ||
      run.runtime.repositoryId !== workflow.repositoryId)
  )
    throw new Error("Invalid persisted workflow VM binding.");
  const origin = workflowRunOrigin(run);
  if (
    origin.kind === "manual"
      ? run.userId !== origin.userId
      : run.userId !== null ||
        origin.organizationId !== run.workflow.organizationId ||
        origin.repositoryId !== run.workflow.repositoryId ||
        origin.workflowId !== run.workflow.workflowId
  )
    throw new Error("Invalid persisted workflow origin.");
  return { ...run, origin };
};
const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowRun));

export const WorkflowCheckpointPin = Schema.Struct({
  checkpointRef: Schema.String,
  commitId: Schema.String,
  treeId: Schema.String,
  baselineCommitId: Schema.String,
});
export type WorkflowCheckpointPin = typeof WorkflowCheckpointPin.Type;
export const WorkflowRunRecovery = Schema.Struct({
  format: Schema.Literal("workflow-run-recovery-v1"),
  run: WorkflowRun,
  frozenConfiguration: Schema.Struct({ jobId: Schema.String, repositoryId: Schema.String }),
  checkpointPins: Schema.Array(
    Schema.Struct({
      ...WorkflowCheckpointPin.fields,
      turnId: Schema.String,
      turnCount: Schema.Int,
    }),
  ),
  workflowIgnoreRulesBase64: Schema.NullOr(Schema.String),
});
const encodeRecovery = Schema.encodeSync(Schema.fromJsonString(WorkflowRunRecovery));

export type LegacyWorkflowTurnOutcome = "completed" | "failed" | "checkpoint-error";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const activeVmFence = (binding: WorkflowVmDispatchBinding) => sql`EXISTS (
    SELECT 1 FROM thread_execution_fences f WHERE f.thread_id=${binding.threadId}
      AND f.environment_id=${binding.environmentId} AND f.generation=${binding.generation}
      AND f.operation_id=${binding.operationId} AND f.project_id=${binding.projectId}
      AND f.phase='active' AND NOT EXISTS (
        SELECT 1 FROM thread_move_source_reopens r WHERE r.operation_id=f.operation_id
          AND r.thread_id=f.thread_id AND r.relay_url=f.relay_url
          AND r.environment_id=f.environment_id AND r.generation=f.generation))`;
  const pinColumns = sql`p.checkpoint_ref AS "checkpointRef", p.commit_id AS "commitId",
    p.tree_id AS "treeId", p.baseline_commit_id AS "baselineCommitId"`;
  const pinBinding = (binding: WorkflowVmDispatchBinding) => sql`
    p.job_id=${binding.jobId} AND p.thread_id=${binding.threadId}
    AND p.allocation_id=${binding.allocationId} AND p.operation_id=${binding.operationId}
    AND p.environment_id=${binding.environmentId} AND p.generation=${binding.generation}`;
  const getCheckpointPinForRun = (
    binding: WorkflowVmDispatchBinding,
    turnId: string,
    checkpointRef: string,
    preparationAttemptId?: string | null,
  ) =>
    sql<WorkflowCheckpointPin>`SELECT ${pinColumns} FROM workflow_vm_checkpoint_pins p
      WHERE ${pinBinding(binding)} AND p.turn_id=${turnId} AND p.checkpoint_ref=${checkpointRef}
        AND ${
          preparationAttemptId === undefined
            ? sql`TRUE`
            : sql`p.preparation_attempt_id IS ${preparationAttemptId}`
        }`.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orDie,
    );
  const noPromptHandoff = (threadId: string) => sql`NOT EXISTS (
    SELECT 1 FROM orchestration_events
    WHERE aggregate_kind='thread' AND stream_id=${threadId}
      AND event_type='thread.prompt-queue-changed'
      AND json_extract(payload_json, '$.handoff.attemptId') IS NOT NULL)`;
  const recoveryRecord = Effect.fn("WorkflowRunStore.recoveryRecord")(function* (run: WorkflowRun) {
    if (run.runtime.kind !== "vm")
      return yield* Effect.die("Only VM runs have saved recovery records.");
    const binding = run.runtime;
    const pins = yield* sql<
      WorkflowCheckpointPin & { turnId: string; turnCount: number; ignoreRules: Uint8Array | null }
    >`
      SELECT ${pinColumns},p.turn_id AS "turnId",p.turn_count AS "turnCount",p.workflow_ignore_rules AS "ignoreRules"
      FROM workflow_vm_checkpoint_pins p WHERE p.job_id=${run.jobId} AND p.thread_id=${binding.threadId}
        AND p.allocation_id=${binding.allocationId} AND p.operation_id=${binding.operationId}
        AND p.environment_id=${binding.environmentId} AND p.generation=${binding.generation}
        AND (p.turn_id='' OR p.turn_count=(SELECT MAX(latest.turn_count) FROM workflow_vm_checkpoint_pins latest WHERE latest.job_id=p.job_id))
      ORDER BY p.turn_count,p.turn_id`;
    const rules = pins.find((pin) => pin.turnId === "")?.ignoreRules;
    return encodeRecovery({
      format: "workflow-run-recovery-v1",
      run,
      frozenConfiguration: { jobId: run.jobId, repositoryId: run.workflow.repositoryId },
      checkpointPins: pins.map(({ ignoreRules: _rules, ...pin }) => pin),
      workflowIgnoreRulesBase64: rules ? Buffer.from(rules).toString("base64") : null,
    });
  });
  const canonicalPath = (cwd: string) =>
    fs.realPath(path.resolve(cwd)).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  const get = (jobId: string) =>
    sql<{
      record_json: string;
    }>`SELECT record_json FROM repository_workflow_jobs WHERE job_id = ${jobId}`.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows[0] ? decode(rows[0].record_json) : null)),
    );
  const getCancellation = (jobId: string) =>
    sql<{
      record_json: string;
    }>`SELECT record_json FROM repository_workflow_cancellations WHERE job_id = ${jobId}`.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows[0] ? decodeCancellation(rows[0].record_json) : null)),
    );
  const active = (status?: "waiting_capacity") =>
    (status
      ? sql<{
          record_json: string;
        }>`SELECT record_json FROM repository_workflow_jobs WHERE status = ${status} ORDER BY job_id`
      : sql<{
          record_json: string;
        }>`SELECT record_json FROM repository_workflow_jobs WHERE status NOT IN ('done', 'cancelled', 'failed')`
    ).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => decode(row.record_json))),
    );
  const owners = () =>
    sql<{
      jobId: string;
      threadId: string;
      projectId: string;
      worktreePath: string | null;
      record_json: string;
    }>`SELECT j.record_json, j.job_id AS "jobId", j.thread_id AS "threadId", COALESCE(json_extract(j.record_json, '$.runtime.projectId'), json_extract(j.record_json, '$.workflow.definition.target.projectId'), json_extract(j.record_json, '$.workflow.definition.projectId')) AS "projectId", COALESCE(json_extract(j.record_json, '$.worktreePath'), t.worktree_path) AS "worktreePath" FROM repository_workflow_jobs j LEFT JOIN projection_threads t ON t.thread_id = j.thread_id
      WHERE j.status NOT IN ('done','cancelled','failed') OR j.execution_reserved = 1
        OR json_extract(j.record_json,'$.executionReserved') = 1
        OR json_extract(j.record_json,'$.progress.status') NOT IN ('done','cancelled','failed')
        OR json_extract(j.record_json,'$.manualPause') IS NOT NULL
        OR json_extract(j.record_json,'$.approvalAttempt') IS NOT NULL
        OR json_extract(j.record_json,'$.cancellationAttempt') IS NOT NULL
        OR json_extract(j.record_json,'$.pendingQueueDismissal') IS NOT NULL
        OR json_extract(j.record_json,'$.pendingPreparationRetry') IS NOT NULL
        OR EXISTS (SELECT 1 FROM json_each(j.record_json,'$.actions') a, json_each(a.value,'$.commands') c
          WHERE json_extract(c.value,'$.stopped') = 0)`.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows
          .filter((row) => !ownershipReleased(decode(row.record_json)))
          .map(({ record_json: _record, ...owner }) => owner),
      ),
    );
  const workspaceOwner = Effect.fn(function* (
    cwd: string,
    runs: Effect.Success<ReturnType<typeof owners>>,
  ) {
    const actual = yield* canonicalPath(cwd);
    for (const run of runs) {
      if (run.worktreePath === null) continue;
      const owned = yield* canonicalPath(run.worktreePath);
      if (actual === owned || actual.startsWith(`${owned}${path.sep}`)) return run;
    }
    return null;
  });
  return {
    get,
    getSaveResult: (jobId: string, turnId: string) =>
      makeWorkflowResultOutbox(sql).result(jobId, turnId).pipe(Effect.orDie),
    getResultSaving: (jobId: string) =>
      makeWorkflowResultOutbox(sql).saving(jobId).pipe(Effect.orDie),
    retryResultSaving: (jobId: string, publicationId: string) =>
      makeWorkflowResultOutbox(sql).retry(jobId, publicationId).pipe(Effect.orDie),
    getLegacyTurnOutcome: (threadId: string, turnId: string) =>
      sql<{ pauseCode: string | null; wasEnabled: number }>`
        SELECT json_extract(e.payload_json, '$.control.pauseReason.code') AS "pauseCode",
          COALESCE((
            SELECT json_extract(previous.payload_json, '$.control.enabled')
            FROM orchestration_events previous
            WHERE previous.aggregate_kind = 'thread' AND previous.stream_id = e.stream_id
              AND previous.event_type = 'thread.prompt-queue-changed'
              AND previous.sequence < e.sequence
              AND json_type(previous.payload_json, '$.control.enabled') IN ('true', 'false')
            ORDER BY previous.sequence DESC LIMIT 1
          ), 1) AS "wasEnabled"
        FROM orchestration_events e
        WHERE e.aggregate_kind = 'thread' AND e.stream_id = ${threadId}
          AND e.event_type = 'thread.prompt-queue-changed'
          AND json_extract(e.payload_json, '$.finalizedTurnId') = ${turnId}
          AND instr(e.event_id, e.command_id || ':thread.queue.finalize:queue:') = 1
        ORDER BY e.sequence DESC LIMIT 1`.pipe(
        Effect.map(([event]): LegacyWorkflowTurnOutcome | null => {
          if (!event) return null;
          if (event.pauseCode === "checkpoint-error") return "checkpoint-error";
          if (event.pauseCode === "failed" || event.pauseCode === "usage-limit") return "failed";
          // An old disabled queue could finalize a failure without a control delta.
          if (event.pauseCode === "stopped" || (event.pauseCode === null && event.wasEnabled === 1))
            return "completed";
          return null;
        }),
        Effect.orDie,
      ),
    getCheckpointPinForRun,
    getCapturedWorkflowTurn: (binding: WorkflowVmDispatchBinding, turnId: string) =>
      sql<WorkflowCheckpointPin & { turnId: string; turnCount: number }>`
        SELECT ${pinColumns},p.turn_id AS "turnId",p.turn_count AS "turnCount"
        FROM workflow_vm_checkpoint_pins p
        JOIN repository_workflow_jobs j ON j.job_id=p.job_id AND j.thread_id=p.thread_id
        WHERE ${pinBinding(binding)} AND p.turn_id=${turnId} AND p.turn_count>0
          AND json_extract(j.record_json,'$.runtime.kind')='vm'
          AND json_extract(j.record_json,'$.runtime.organizationId')=${binding.organizationId}
          AND json_extract(j.record_json,'$.runtime.repositoryId')=${binding.repositoryId}
          AND json_extract(j.record_json,'$.runtime.projectId')=${binding.projectId}
          AND json_extract(j.record_json,'$.runtime.allocationId')=p.allocation_id
          AND json_extract(j.record_json,'$.runtime.operationId')=p.operation_id
          AND json_extract(j.record_json,'$.runtime.environmentId')=p.environment_id
          AND json_extract(j.record_json,'$.runtime.generation')=p.generation`.pipe(
        Effect.map(([pin]) => pin ?? null),
        Effect.orDie,
      ),
    getWorkflowIgnoreRules: (binding: WorkflowVmDispatchBinding) =>
      sql<{ workflowIgnoreRules: Uint8Array | null }>`
        SELECT p.workflow_ignore_rules AS "workflowIgnoreRules" FROM workflow_vm_checkpoint_pins p
        WHERE ${pinBinding(binding)} AND p.turn_id=''`.pipe(
        Effect.map((rows) => {
          const rules = rows[0]?.workflowIgnoreRules;
          return rules ? new Uint8Array(rules) : null;
        }),
        Effect.orDie,
      ),
    canPinInitialCheckpoint: (binding: WorkflowVmDispatchBinding) =>
      sql`SELECT 1 WHERE ${activeVmFence(binding)} AND ${noPromptHandoff(binding.threadId)}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    getCheckpointPinForTurn: (threadId: string, turnId: string, turnCount: number) =>
      sql<WorkflowCheckpointPin>`SELECT ${pinColumns} FROM workflow_vm_checkpoint_pins p
        JOIN repository_workflow_jobs j ON j.job_id=p.job_id AND j.thread_id=p.thread_id
        WHERE p.thread_id=${threadId} AND p.turn_id=${turnId} AND p.turn_count=${turnCount}
          AND json_extract(j.record_json,'$.runtime.kind')='vm'
          AND json_extract(j.record_json,'$.runtime.allocationId')=p.allocation_id
          AND json_extract(j.record_json,'$.runtime.operationId')=p.operation_id
          AND json_extract(j.record_json,'$.runtime.environmentId')=p.environment_id
          AND json_extract(j.record_json,'$.runtime.generation')=p.generation`.pipe(
        Effect.map((rows) => (rows.length === 1 ? rows[0]! : null)),
        Effect.orDie,
      ),
    saveCheckpointPin: (
      binding: WorkflowVmDispatchBinding,
      turnId: string,
      turnCount: number,
      pin: WorkflowCheckpointPin,
      preparationAttemptId: string | null = null,
      expectedPreparationRevision?: number | null,
      workflowIgnoreRules?: Uint8Array,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [job] = yield* sql<{ status: string; record_json: string }>`
            SELECT j.status, j.record_json FROM repository_workflow_jobs j
            WHERE j.job_id=${binding.jobId} AND j.thread_id=${binding.threadId}
              AND j.execution_reserved=1
              AND (j.status IN ('preparing', 'running') OR (${turnId !== ""} AND j.status='paused'))
              AND json_extract(j.record_json,'$.runtime.kind')='vm'
              AND json_extract(j.record_json,'$.runtime.allocationId')=${binding.allocationId}
              AND json_extract(j.record_json,'$.runtime.operationId')=${binding.operationId}
              AND json_extract(j.record_json,'$.runtime.environmentId')=${binding.environmentId}
              AND json_extract(j.record_json,'$.runtime.generation')=${binding.generation}
              AND ${activeVmFence(binding)}
              AND ${turnId === "" ? noPromptHandoff(binding.threadId) : sql`TRUE`}
              AND ${
                expectedPreparationRevision === undefined
                  ? sql`TRUE`
                  : sql`EXISTS (
                SELECT 1 FROM projection_thread_prompt_queues q WHERE q.thread_id=j.thread_id
                AND json_extract(q.state_json,'$.preparation.attemptId') IS ${preparationAttemptId}
                AND json_extract(q.state_json,'$.preparation.revision') IS ${expectedPreparationRevision}
                AND (${expectedPreparationRevision === null} OR json_extract(q.state_json,'$.preparation.state')='ready')
              )`
              }`;
            if (!job) return null;
            if (job.status === "paused") {
              const run = decode(job.record_json);
              if (!canRecoverPausedWorkflowTurn(run)) return null;
              const queue = yield* getPromptQueue(sql, binding.threadId);
              if (
                queue?.awaitingTurnId !== turnId ||
                queue.finalizedTurnId === turnId ||
                admittedWorkflowTurnId(queue, workflowPromptId(run)) !== turnId
              )
                return null;
            }
            yield* sql`INSERT INTO workflow_vm_checkpoint_pins (
            job_id, thread_id, allocation_id, operation_id, environment_id, generation,
            turn_id, turn_count, preparation_attempt_id, checkpoint_ref, commit_id, tree_id,
            baseline_commit_id, workflow_ignore_rules
          ) VALUES (
            ${binding.jobId}, ${binding.threadId}, ${binding.allocationId}, ${binding.operationId},
            ${binding.environmentId}, ${binding.generation}, ${turnId}, ${turnCount},
            ${preparationAttemptId}, ${pin.checkpointRef}, ${pin.commitId}, ${pin.treeId},
            ${pin.baselineCommitId}, ${turnId === "" ? (workflowIgnoreRules ?? null) : null}
          ) ON CONFLICT DO UPDATE SET
            preparation_attempt_id=excluded.preparation_attempt_id,
            checkpoint_ref=excluded.checkpoint_ref, commit_id=excluded.commit_id,
            tree_id=excluded.tree_id, baseline_commit_id=excluded.baseline_commit_id,
            workflow_ignore_rules=excluded.workflow_ignore_rules
          WHERE ${turnId === "" && expectedPreparationRevision !== undefined}
            AND workflow_vm_checkpoint_pins.preparation_attempt_id IS NOT excluded.preparation_attempt_id`;
            return yield* getCheckpointPinForRun(
              binding,
              turnId,
              pin.checkpointRef,
              preparationAttemptId,
            );
          }),
        )
        .pipe(Effect.orDie),
    getCancellation,
    isWorkflowVmThread: (threadId: string) =>
      sql`SELECT 1 FROM repository_workflow_jobs
      WHERE thread_id=${threadId} AND json_extract(record_json, '$.runtime.kind')='vm' LIMIT 1`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    isVmFenceActive: (binding: WorkflowVmDispatchBinding) =>
      sql`SELECT 1 WHERE ${activeVmFence(binding)}`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    cancelBeforeAcceptance: (cancellation: WorkflowCancellation) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO repository_workflow_cancellations (job_id, record_json)
          SELECT ${cancellation.jobId}, ${encodeCancellation(cancellation)}
          WHERE NOT EXISTS (SELECT 1 FROM repository_workflow_jobs WHERE job_id = ${cancellation.jobId})
          ON CONFLICT DO NOTHING`;
            return {
              run: yield* get(cancellation.jobId),
              cancellation: yield* getCancellation(cancellation.jobId),
            };
          }),
        )
        .pipe(Effect.orDie),
    active,
    owners,
    tryAccept: (run: WorkflowRun) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`INSERT INTO repository_workflow_jobs (job_id, thread_id, status, execution_reserved, record_json)
        SELECT ${run.jobId}, ${run.progress.threadId}, ${run.progress.status}, ${run.executionReserved ? 1 : 0}, ${encode({ ...run, origin: workflowRunOrigin(run) })}
        WHERE NOT EXISTS (SELECT 1 FROM repository_workflow_cancellations WHERE job_id = ${run.jobId})
          AND ${run.runtime.kind === "vm" ? activeVmFence(run.runtime) : sql`TRUE`}
        ON CONFLICT DO NOTHING RETURNING job_id`;
            if (rows.length && run.runtime.kind === "vm")
              yield* makeWorkflowResultOutbox(sql).enqueue({
                binding: run.runtime,
                recordJson: yield* recoveryRecord(run),
              });
            return rows.length > 0;
          }),
        )
        .pipe(Effect.orDie),
    getByThread: (threadId: string) =>
      sql<{
        record_json: string;
      }>`SELECT record_json FROM repository_workflow_jobs WHERE thread_id = ${threadId}`.pipe(
        Effect.orDie,
        Effect.map((rows) => {
          const run = rows[0] ? decode(rows[0].record_json) : null;
          return run && !ownershipReleased(run) ? run : null;
        }),
      ),
    getVmBindingForThread: (threadId: string) =>
      sql<{ record_json: string }>`SELECT record_json FROM repository_workflow_jobs
        WHERE thread_id=${threadId} AND json_extract(record_json, '$.runtime.kind')='vm'`.pipe(
        Effect.orDie,
        Effect.map(([row]) => {
          const runtime = row ? decode(row.record_json).runtime : null;
          return runtime?.kind === "vm" ? runtime : null;
        }),
      ),
    isExecuting: (exceptJobId = "") =>
      sql`SELECT 1 FROM repository_workflow_jobs WHERE execution_reserved = 1 AND job_id != ${exceptJobId} LIMIT 1`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    save: (run: WorkflowRun, captured?: WorkflowResultCapture) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const origin = workflowRunOrigin(run);
            const previous = yield* get(run.jobId);
            if (previous && !sameWorkflowOrigin(workflowRunOrigin(previous), origin))
              return yield* Effect.die("Workflow origin is immutable.");
            run = decode(encode({ ...run, origin }));
            yield* sql`INSERT INTO repository_workflow_jobs ${sql.insert({
              job_id: run.jobId,
              thread_id: run.progress.threadId,
              status: run.progress.status,
              execution_reserved: run.executionReserved ? 1 : 0,
              record_json: encode(run),
            })} ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, execution_reserved = excluded.execution_reserved, record_json = excluded.record_json`;
            if (run.runtime.kind === "vm") {
              const checkpoint = run.progress.checkpoint;
              const step = run.workflow.definition.steps[run.sequence?.cursor ?? 0];
              let result = captured;
              if (
                !result &&
                checkpoint &&
                checkpoint.kind !== "input" &&
                step?.kind === "agent" &&
                run.progress.status === "awaiting_review"
              ) {
                const pin = yield* getCheckpointPinForRun(
                  run.runtime,
                  checkpoint.turnId,
                  checkpoint.checkpointRef,
                );
                if (pin)
                  result = {
                    resultId: NodeCrypto.randomUUID(),
                    stepId: step.id,
                    turnId: checkpoint.turnId,
                    turnCount: checkpoint.checkpointTurnCount,
                    outcome: "completed",
                    createdAt: run.sequence?.stepStartedAt ?? run.createdAt,
                    ...pin,
                  };
              }
              yield* makeWorkflowResultOutbox(sql).enqueue({
                binding: run.runtime,
                recordJson: yield* recoveryRecord(run),
                ...(result ? { result } : {}),
              });
            }
            return run;
          }),
        )
        .pipe(Effect.orDie),
    requireCommand: Effect.fn("WorkflowRunStore.requireCommand")(function* (
      command: OrchestrationCommand,
    ) {
      const runs = yield* owners();
      let cwd =
        command.type === "thread.create"
          ? command.worktreePath
          : command.type === "thread.prompt.enqueue"
            ? (command.bootstrap?.createThread?.worktreePath ??
              command.bootstrap?.prepareWorktree?.projectCwd)
            : null;
      if (!cwd && "threadId" in command) {
        const rows = yield* sql<{
          worktree_path: string | null;
        }>`SELECT worktree_path FROM projection_threads WHERE thread_id = ${command.threadId}`.pipe(
          Effect.orDie,
        );
        cwd = rows[0]?.worktree_path;
      }
      const run =
        runs.find(
          (entry) =>
            ("threadId" in command && entry.threadId === command.threadId) ||
            ("projectId" in command &&
              command.projectId === entry.projectId &&
              command.type === "project.delete"),
        ) ?? (cwd ? yield* workspaceOwner(cwd, runs) : null);
      if (!run) return yield* Effect.void;
      if (
        command.type === "thread.approval.respond" &&
        ["acceptForSession", "acceptAlways"].includes(command.decision)
      ) {
        return yield* new EnvironmentAuthorizationError({
          message:
            "Workflow approvals apply to one request. Approve this request once or decline it.",
          requiredScope: AuthOrchestrationOperateScope,
        });
      }
      if (
        command.type === "thread.approval.respond" &&
        command.decision !== "decline" &&
        command.decision !== "cancel"
      ) {
        const requests = yield* sql<{
          requestType: string | null;
          detail: string | null;
        }>`SELECT json_extract(payload_json, '$.requestType') AS "requestType", json_extract(payload_json, '$.detail') AS "detail"
          FROM projection_thread_activities WHERE thread_id = ${command.threadId} AND kind = 'approval.requested' AND json_extract(payload_json, '$.requestId') = ${command.requestId} ORDER BY activity_id DESC LIMIT 1`.pipe(
          Effect.orDie,
        );
        const request = requests[0];
        if (
          request &&
          classifyApprovalRequest({
            requestType: request.requestType ?? undefined,
            detail: request.detail ?? undefined,
          }).kind === "deny"
        ) {
          return yield* new EnvironmentAuthorizationError({
            message:
              "This operation leaves the workflow's prepared workspace and cannot be approved here.",
            requiredScope: AuthOrchestrationOperateScope,
          });
        }
      }
      // Metadata and ordinary provider approval responses remain available. Work,
      // lifecycle changes, retries and checkpoint restoration belong to the job.
      if (
        [
          "thread.rename",
          "thread.pin",
          "thread.unpin",
          "thread.snooze",
          "thread.unsnooze",
          "thread.approval.respond",
          "thread.user-input.respond",
        ].includes(command.type)
      )
        return yield* Effect.void;
      return yield* new EnvironmentAuthorizationError({
        message: `This thread belongs to workflow job ${run.jobId}. Use its review, retry or Cancel controls.`,
        requiredScope: AuthOrchestrationOperateScope,
      });
    }),
    requireWorkspace: Effect.fn("WorkflowRunStore.requireWorkspace")(function* (cwd: string) {
      if (yield* workspaceOwner(cwd, yield* owners())) {
        return yield* new EnvironmentAuthorizationError({
          message: "This worktree belongs to an active workflow job.",
          requiredScope: AuthOrchestrationOperateScope,
        });
      }
      return yield* Effect.void;
    }),
  };
});
export type WorkflowRunStoreShape = Effect.Success<typeof make>;
export class WorkflowRunStore extends Context.Reference<WorkflowRunStoreShape>(
  "t3/jobs/WorkflowRunStore",
  {
    defaultValue: () => ({
      get: () => Effect.succeed(null),
      getSaveResult: () => Effect.succeed(null),
      getResultSaving: () => Effect.succeed(undefined),
      retryResultSaving: () => Effect.succeed(false),
      getLegacyTurnOutcome: () => Effect.succeed(null),
      getCheckpointPinForRun: () => Effect.succeed(null),
      getCapturedWorkflowTurn: () => Effect.succeed(null),
      getWorkflowIgnoreRules: () => Effect.succeed(null),
      canPinInitialCheckpoint: () => Effect.succeed(false),
      getCheckpointPinForTurn: () => Effect.succeed(null),
      saveCheckpointPin: () => Effect.succeed(null),
      getCancellation: () => Effect.succeed(null),
      isWorkflowVmThread: () => Effect.succeed(false),
      isVmFenceActive: () => Effect.succeed(false),
      cancelBeforeAcceptance: () => Effect.succeed({ run: null, cancellation: null }),
      getByThread: () => Effect.succeed(null),
      getVmBindingForThread: () => Effect.succeed(null),
      active: () => Effect.succeed([]),
      owners: () => Effect.succeed([]),
      isExecuting: () => Effect.succeed(false),
      save: (run) => Effect.succeed(run),
      tryAccept: () => Effect.succeed(true),
      requireCommand: () => Effect.void,
      requireWorkspace: () => Effect.void,
    }),
  },
) {}
export const layer = Layer.effect(WorkflowRunStore, make);
