import {
  ModelSelection,
  ProviderDriverKind,
  type OrchestrationCommand,
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import {
  RepositoryWorkflow,
  WorkflowJobProgress,
  WorkflowReviewCheckpoint,
  WorkflowResponseSummary,
} from "@t3tools/contracts/workflows";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { classifyApprovalRequest } from "./approvalClassification.ts";

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
export const WorkflowRun = Schema.Struct({
  sequence: Schema.optional(WorkflowSequence),
  /** Pinned before acceptance so an instance ID cannot hide a changed resume identity. */
  providerContinuation: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      continuationKey: Schema.String,
    }),
  ),
  jobId: Schema.String,
  userId: Schema.String,
  repositoryCanonicalKey: Schema.String,
  instruction: Schema.String,
  workflow: RepositoryWorkflow,
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
      }),
    ),
  ),
  cancellationAttempt: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commandId: Schema.String,
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
const WorkflowCancellation = Schema.Struct({
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
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowRun));
const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowRun));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
    }>`SELECT j.job_id AS "jobId", j.thread_id AS "threadId", json_extract(j.record_json, '$.workflow.definition.projectId') AS "projectId", COALESCE(json_extract(j.record_json, '$.worktreePath'), t.worktree_path) AS "worktreePath" FROM repository_workflow_jobs j LEFT JOIN projection_threads t ON t.thread_id = j.thread_id WHERE j.status NOT IN ('done', 'cancelled', 'failed')`.pipe(
      Effect.orDie,
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
    getCancellation,
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
      sql`INSERT INTO repository_workflow_jobs (job_id, thread_id, status, execution_reserved, record_json)
        SELECT ${run.jobId}, ${run.progress.threadId}, ${run.progress.status}, ${run.executionReserved ? 1 : 0}, ${encode(run)}
        WHERE NOT EXISTS (SELECT 1 FROM repository_workflow_cancellations WHERE job_id = ${run.jobId})
        ON CONFLICT DO NOTHING RETURNING job_id`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    getByThread: (threadId: string) =>
      sql<{
        record_json: string;
      }>`SELECT record_json FROM repository_workflow_jobs WHERE thread_id = ${threadId} AND status NOT IN ('done', 'cancelled', 'failed')`.pipe(
        Effect.orDie,
        Effect.map((rows) => (rows[0] ? decode(rows[0].record_json) : null)),
      ),
    isExecuting: (exceptJobId = "") =>
      sql`SELECT 1 FROM repository_workflow_jobs WHERE execution_reserved = 1 AND job_id != ${exceptJobId} LIMIT 1`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length > 0),
      ),
    save: (run: WorkflowRun) =>
      sql`INSERT INTO repository_workflow_jobs ${sql.insert({
        job_id: run.jobId,
        thread_id: run.progress.threadId,
        status: run.progress.status,
        execution_reserved: run.executionReserved ? 1 : 0,
        record_json: encode(run),
      })} ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, execution_reserved = excluded.execution_reserved, record_json = excluded.record_json`.pipe(
        Effect.orDie,
        Effect.as(run),
      ),
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
      getCancellation: () => Effect.succeed(null),
      cancelBeforeAcceptance: () => Effect.succeed({ run: null, cancellation: null }),
      getByThread: () => Effect.succeed(null),
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
