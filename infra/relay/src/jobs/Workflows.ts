import {
  RepositoryWorkflow,
  RepositoryWorkflowJob,
  isTerminalWorkflowJob,
  workflowIsFinishing,
  type RepositoryWorkflowJobSummary,
  type WorkflowJobProgress,
  WorkflowConflictError,
  WorkflowInvalidError,
  type WorkflowJobPageQuery,
  type WorkflowJobPage,
  type SaveRepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import {
  normalizeStoredWorkflow,
  normalizeStoredWorkflowJob,
} from "@t3tools/shared/workflowStorage";
import { WorkflowOrigin, sameWorkflowOrigin } from "@t3tools/contracts";
import { DEFAULT_WORKFLOW_VM_LIMIT } from "@t3tools/contracts/relay";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Routing from "../workflowEvents/Routing.ts";
import { vmWorkflowExecutionUnavailable, workflowRunTargetChanged } from "./WorkflowTarget.ts";
import { RelayDb } from "../db.ts";
import { relayRepositoryWorkflows, relayWorkflowJobs } from "../persistence/schema.ts";
import { getRepositoryWorkflowConfiguration } from "./RepositoryWorkflowConfiguration.ts";
import { recheckWorkflowVmGitHub, type WorkflowVmGitHubResolution } from "./WorkflowVmGithub.ts";
import { tenancyForbidden, tenancyNotFound } from "../http/tenancyErrors.ts";
import { lockWorkflowVmOrganization } from "../threads/WorkflowVmPolicyLock.ts";

export type WorkflowDispatchScope = {
  occurrenceId?: string;
  connectionId?: string;
  environmentId?: string;
};
export type WorkflowJobRecord = Omit<typeof relayWorkflowJobs.$inferSelect, "summary">;
type WorkflowVmSubmissionScope = Pick<
  WorkflowJobRecord,
  "organizationId" | "repositoryId" | "submitterUserId"
>;
type WorkflowVmSubmission = WorkflowVmSubmissionScope &
  Pick<WorkflowJobRecord, "jobId"> &
  Pick<RepositoryWorkflowJob, "workflowId" | "instruction">;
const isInvalid = Schema.is(WorkflowInvalidError);
const isConflict = Schema.is(WorkflowConflictError);
const decodeOrigin = Schema.decodeUnknownSync(WorkflowOrigin);

const JobPageCursor = Schema.Struct({
  version: Schema.Literal(1),
  repositoryId: Schema.String,
  view: Schema.Literals(["active", "attention", "history"]),
  createdAt: Schema.String.check(Schema.isMaxLength(64)),
  jobId: Schema.String.check(Schema.isMaxLength(64)),
});
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(JobPageCursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(JobPageCursor));
export class WorkflowPersistenceError extends Schema.TaggedError<WorkflowPersistenceError>()(
  "WorkflowPersistenceError",
  { cause: Schema.Defect() },
) {}
const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));

function validateOrigin(row: WorkflowJobRecord, record = row.record) {
  record = normalizeStoredWorkflowJob(record);
  const origin = decodeOrigin(
    record.origin ??
      (row.submitterUserId ? { kind: "manual", userId: row.submitterUserId } : undefined),
  );
  if (
    origin.kind === "manual"
      ? origin.userId !== row.submitterUserId
      : row.submitterUserId !== null ||
        origin.organizationId !== row.organizationId ||
        origin.repositoryId !== row.repositoryId ||
        origin.workflowId !== record.workflowId ||
        (record.requiredProtocol ?? 0) < 8
  )
    throw new Error("Invalid workflow origin binding.");
  return { ...record, origin };
}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const get = (workflowId: string) =>
    persist(
      db
        .select({ record: relayRepositoryWorkflows.record })
        .from(relayRepositoryWorkflows)
        .where(eq(relayRepositoryWorkflows.workflowId, workflowId))
        .limit(1),
    ).pipe(Effect.map((rows) => (rows[0] ? normalizeStoredWorkflow(rows[0].record) : null)));
  const lockSavedWorkflow = (workflowId: string, repositoryId: string) =>
    persist(
      db
        .select({ record: relayRepositoryWorkflows.record })
        .from(relayRepositoryWorkflows)
        .where(
          and(
            eq(relayRepositoryWorkflows.workflowId, workflowId),
            eq(relayRepositoryWorkflows.repositoryId, repositoryId),
          ),
        )
        .for("share"),
    ).pipe(Effect.map((rows) => (rows[0] ? normalizeStoredWorkflow(rows[0].record) : null)));
  const getJob = (jobId: string) =>
    persist(
      db.select().from(relayWorkflowJobs).where(eq(relayWorkflowJobs.jobId, jobId)).limit(1),
    ).pipe(
      Effect.map((rows): WorkflowJobRecord | null =>
        rows[0] ? { ...rows[0], record: normalizeStoredWorkflowJob(rows[0].record) } : null,
      ),
    );
  const findVmSubmission = Effect.fnUntraced(function* (input: WorkflowVmSubmission) {
    const row = yield* getJob(input.jobId);
    if (
      row &&
      (row.organizationId !== input.organizationId ||
        row.repositoryId !== input.repositoryId ||
        row.submitterUserId !== input.submitterUserId ||
        !row.record.vmAdmission ||
        row.record.workflowId !== input.workflowId ||
        row.record.instruction !== input.instruction)
    )
      return yield* new WorkflowConflictError({
        message: "This submission ID was already used. Start a new run to change its instructions.",
      });
    return row;
  });
  const getWorkflowVmCodexConnection = Effect.fn("Workflows.getWorkflowVmCodexConnection")(
    function* (organizationId: string, lock = false) {
      const sql = db.$client;
      const [connection] = yield* persist(sql<{
        connectionId: string;
        status: "connected" | "disconnected" | "reconnect_required";
      }>`
        SELECT connection_id AS "connectionId",
          CASE WHEN status='connected' AND refresh_started_at::timestamptz <=
            clock_timestamp() - interval '6 seconds' THEN 'reconnect_required'
          ELSE status END AS status
        FROM relay_codex_vm_connections
        WHERE organization_id=${organizationId} ${lock ? sql`FOR SHARE` : sql``}
      `);
      return connection ?? null;
    },
  );
  const requireVisibleWorkflowRepository = Effect.fnUntraced(function* (
    scope: Pick<WorkflowJobRecord, "organizationId" | "repositoryId">,
    userId: string | null,
    lock: boolean,
  ) {
    const sql = db.$client;
    const forShare = lock ? sql`FOR SHARE` : sql``;
    const [membership] = yield* persist(sql<{ role: string }>`
        SELECT role FROM relay_organization_members
        WHERE organization_id=${scope.organizationId} AND user_id=${userId}
        ${forShare}
      `);
    if (!membership) return yield* tenancyNotFound("repository_not_found");
    const [grant] =
      membership.role === "admin"
        ? []
        : yield* persist(sql<{ role: string }>`
              SELECT role FROM relay_repository_access WHERE organization_id=${scope.organizationId}
                AND repository_id=${scope.repositoryId} AND user_id=${userId}
              ${forShare}
            `);
    if (membership.role !== "admin" && !grant)
      return yield* tenancyNotFound("repository_not_found");
    const [repository] = yield* persist(sql`
        SELECT repository_id FROM relay_repositories
        WHERE organization_id=${scope.organizationId} AND repository_id=${scope.repositoryId}
        ${forShare}
      `);
    if (!repository) return yield* tenancyNotFound("repository_not_found");
    return membership.role === "admin" || grant?.role === "maintainer";
  });
  const checkWorkflowVmSecretAccess = Effect.fnUntraced(function* (
    scope: WorkflowVmSubmissionScope,
    canUseSecrets: boolean,
  ) {
    const configuration = yield* persist(getRepositoryWorkflowConfiguration(db.$client, scope));
    const hasSecrets = configuration.entries.some((entry) => entry.kind === "secret");
    if (hasSecrets && !canUseSecrets) return yield* tenancyForbidden("not_a_maintainer");
    return hasSecrets;
  });
  const canSettleVmCancellation = Effect.fnUntraced(function* (row: WorkflowJobRecord) {
    const requester = row.pendingControl?.userId;
    if (!requester || !row.record.vmAdmission) return false;
    const canManage = yield* requireVisibleWorkflowRepository(row, requester, true).pipe(
      Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
    );
    if (canManage === null || canManage || requester !== row.submitterUserId)
      return canManage === true;
    if (row.record.workflow === null) return row.record.vmAdmission.hasSecrets === false;
    const [configuration] = yield* persist(db.$client<{
      hasSecrets: boolean;
    }>`SELECT has_secrets AS "hasSecrets"
      FROM relay_workflow_run_configurations WHERE job_id=${row.jobId} AND organization_id=${row.organizationId}
        AND repository_id=${row.repositoryId} FOR SHARE`);
    return configuration?.hasSecrets === false;
  });
  const getWorkflowVmLimit = Effect.fn("Workflows.getWorkflowVmLimit")(function* (
    organizationId: string,
  ) {
    const sql = db.$client;
    const [policy] = yield* persist(sql<{ limit: number }>`
      SELECT max_running_workflow_vms AS "limit"
      FROM relay_thread_vm_policies WHERE organization_id=${organizationId}
    `);
    return policy?.limit ?? DEFAULT_WORKFLOW_VM_LIMIT;
  });
  const requireWorkflowVmLimit = Effect.fnUntraced(function* (organizationId: string) {
    if ((yield* getWorkflowVmLimit(organizationId)) === 0)
      return yield* new WorkflowInvalidError({
        message:
          "Workflow VMs are disabled. An organization admin can raise the limit in Workflow VMs settings.",
      });
  });
  const createJob = (row: WorkflowJobRecord) =>
    persist(
      Effect.try(() => validateOrigin(row)).pipe(
        Effect.flatMap((record) => db.insert(relayWorkflowJobs).values({ ...row, record })),
      ),
    ).pipe(Effect.as(row));
  const updateJob = Effect.fn("Workflows.updateJob")(function* (
    previous: WorkflowJobRecord,
    record: RepositoryWorkflowJob,
    pendingControl = previous.pendingControl,
    releaseLease = true,
    expectedLease?: string,
  ) {
    if (isTerminalWorkflowJob(previous.record.status)) {
      if (
        !previous.record.vmAdmission ||
        (!previous.record.progress?.resultSaving &&
          pendingControl?.response.operation !== "retry_saving")
      )
        return previous;
      // Terminal execution never reopens. Only its independent storage state can settle.
      record = {
        ...previous.record,
        updatedAt: record.updatedAt,
        progress: previous.record.progress
          ? { ...previous.record.progress, resultSaving: record.progress?.resultSaving }
          : null,
      };
      if (pendingControl && pendingControl.response.operation !== "retry_saving") return previous;
    }
    record = yield* persist(
      Effect.try(() => {
        const saved = validateOrigin(previous);
        const next = validateOrigin(previous, record);
        if (!sameWorkflowOrigin(saved.origin, next.origin))
          throw new Error("Workflow origin is immutable.");
        return next;
      }),
    );
    const writeJob = db
      .update(relayWorkflowJobs)
      .set({
        record,
        status: record.status,
        repositoryCanonicalKey: previous.repositoryCanonicalKey,
        pendingControl,
        revision: previous.revision + 1,
        ...(releaseLease ? { leaseUntil: null } : {}),
      })
      .where(
        and(
          eq(relayWorkflowJobs.jobId, previous.jobId),
          eq(relayWorkflowJobs.revision, previous.revision),
          ...(expectedLease === undefined
            ? []
            : [
                eq(relayWorkflowJobs.leaseUntil, expectedLease),
                sql`${relayWorkflowJobs.leaseUntil}::timestamptz > clock_timestamp()`,
              ]),
        ),
      )
      .returning();
    const startsSavedRetention =
      record.runtime?.kind === "vm" &&
      isTerminalWorkflowJob(record.status) &&
      record.progress?.executionReleased === true &&
      (!isTerminalWorkflowJob(previous.record.status) ||
        previous.record.progress?.executionReleased !== true);
    const rows = yield* persist(
      startsSavedRetention
        ? db.$client.withTransaction(
            Effect.gen(function* () {
              const changed = yield* writeJob;
              if (changed.length > 0) {
                yield* db.$client`UPDATE relay_thread_vm_saved_disks d
                  SET saved_at=clock_timestamp()
                  FROM relay_thread_placements p
                  WHERE p.workflow_job_id=${previous.jobId} AND p.audience='repository'
                    AND p.thread_id=d.thread_id AND p.generation=d.generation
                    AND d.phase='available'`;
              }
              return changed;
            }),
          )
        : writeJob,
    );
    if (rows.length === 0)
      return yield* new WorkflowConflictError({
        message: "The job changed. Refresh its current state.",
      });
    const row: WorkflowJobRecord = rows[0]!;
    return row;
  });
  const releaseUnusedVmPreparation = Effect.fnUntraced(function* (row: WorkflowJobRecord) {
    const sql = db.$client;
    const [allocation] = yield* sql`UPDATE relay_thread_vm_allocations a
      SET state='deleted',deleted_at=clock_timestamp()
      FROM relay_thread_placements t
      WHERE a.thread_id=t.thread_id AND t.workflow_job_id=${row.jobId}
        AND t.organization_id=${row.organizationId} AND t.repository_id=${row.repositoryId}
        AND a.allocation_id=${row.jobId} AND a.resource_kind='organization_workflow'
        AND a.state='creating' AND a.compute_ref IS NULL AND t.environment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=a.allocation_id)
      RETURNING a.allocation_id`;
    if (allocation)
      yield* sql`UPDATE relay_thread_vm_capacity SET state='released'
        WHERE operation_id=${row.jobId} AND allocation_id=${row.jobId} AND state='waiting'`;
  });
  return {
    get,
    getJob,
    list: (repositoryId: string) =>
      persist(
        db
          .select({ record: relayRepositoryWorkflows.record })
          .from(relayRepositoryWorkflows)
          .where(eq(relayRepositoryWorkflows.repositoryId, repositoryId)),
      ).pipe(Effect.map((rows) => rows.map((row) => normalizeStoredWorkflow(row.record)))),
    save: Effect.fn("Workflows.save")(function* (
      organizationId: string,
      repositoryId: string,
      input: typeof SaveRepositoryWorkflow.Type,
      context?: Routing.SaveContext,
    ) {
      const timestamp = yield* now;
      const previous = yield* get(input.workflowId);
      if (
        (previous && previous.repositoryId !== repositoryId) ||
        (previous?.revision ?? 0) !== input.expectedRevision
      ) {
        return yield* new WorkflowConflictError({
          message: "This workflow changed. Reload it before saving; your draft has been retained.",
        });
      }
      const record = {
        workflowId: input.workflowId,
        organizationId,
        repositoryId,
        revision: input.expectedRevision + 1,
        definition: input.definition,
        archived: input.archived,
        automation: Routing.automation(previous?.automation),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies RepositoryWorkflow;
      if (
        input.definition.target.kind === "vm" ||
        previous?.definition.target.kind === "vm" ||
        input.automation !== undefined ||
        previous?.automation?.trigger
      ) {
        return yield* Routing.save(
          {
            ...record,
            automation: Routing.automation(
              input.automation === undefined ? previous?.automation : input.automation,
            ),
          },
          input,
          previous,
          context,
        ).pipe(
          Effect.provideService(RelayDb, db),
          Effect.mapError((cause) =>
            isInvalid(cause) || isConflict(cause) ? cause : new WorkflowPersistenceError({ cause }),
          ),
        );
      }
      const rows = previous
        ? yield* persist(
            db
              .update(relayRepositoryWorkflows)
              .set({ revision: record.revision, record })
              .where(
                and(
                  eq(relayRepositoryWorkflows.workflowId, input.workflowId),
                  eq(relayRepositoryWorkflows.revision, input.expectedRevision),
                ),
              )
              .returning(),
          )
        : yield* persist(
            db
              .insert(relayRepositoryWorkflows)
              .values({
                workflowId: input.workflowId,
                repositoryId,
                revision: record.revision,
                record,
              })
              .onConflictDoNothing()
              .returning(),
          );
      if (rows.length === 0)
        return yield* new WorkflowConflictError({
          message: "This workflow was saved elsewhere. Reload before saving your draft.",
        });
      return record;
    }),
    createJob,
    getVmSubmission: Effect.fn("Workflows.getVmSubmission")(function* (
      input: WorkflowVmSubmission,
    ) {
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            yield* requireVisibleWorkflowRepository(input, input.submitterUserId, true);
            return yield* findVmSubmission(input);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
    }),
    getWorkflowVmCodexConnection,
    getWorkflowVmLimit,
    requireWorkflowVmLimit,
    checkWorkflowVmSubmissionAccess: Effect.fn("Workflows.checkWorkflowVmSubmissionAccess")(
      function* (scope: WorkflowVmSubmissionScope) {
        const canUseSecrets = yield* requireVisibleWorkflowRepository(
          scope,
          scope.submitterUserId,
          false,
        );
        return yield* checkWorkflowVmSecretAccess(scope, canUseSecrets);
      },
    ),
    createManualJob: Effect.fn("Workflows.createManualJob")(function* (
      row: WorkflowJobRecord,
      expected: {
        readonly expectedRevision: number;
        readonly expectedTargetKind: RepositoryWorkflow["definition"]["target"]["kind"];
        readonly hasReviewedRevision: boolean;
        readonly vm?: {
          readonly codexConnectionId: string;
          readonly github: WorkflowVmGitHubResolution;
        };
      },
    ) {
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const vm = expected.vm;
            const input = {
              ...row,
              workflowId: row.record.workflowId,
              instruction: row.record.instruction,
            };
            const sql = db.$client;
            let hasSecrets = false;
            if (vm) {
              const canUseSecrets = yield* requireVisibleWorkflowRepository(
                row,
                row.submitterUserId,
                true,
              );
              const prior = yield* findVmSubmission(input);
              if (prior) return prior;
              hasSecrets = yield* checkWorkflowVmSecretAccess(row, canUseSecrets);
              yield* lockWorkflowVmOrganization(sql, row.organizationId);
              yield* requireWorkflowVmLimit(row.organizationId);
            }
            const workflow = yield* lockSavedWorkflow(row.record.workflowId, row.repositoryId);
            const targetChanged = workflow?.definition.target.kind !== expected.expectedTargetKind;
            // A reviewed preview can be refreshed. Keep the older errors for requests without one.
            if (
              workflow &&
              workflow.revision !== expected.expectedRevision &&
              (expected.hasReviewedRevision || (!workflow.archived && !targetChanged))
            )
              return yield* new WorkflowConflictError({
                message: "The workflow changed while checking this run. Review it and try again.",
                workflowRevision: workflow.revision,
              });
            if (!workflow || workflow.archived)
              return yield* new WorkflowInvalidError({
                message: "The workflow is archived or unavailable. Restore it before running.",
              });
            if (targetChanged) return yield* workflowRunTargetChanged();
            if (!vm) return yield* createJob(row);
            yield* recheckWorkflowVmGitHub(sql, row, vm.github);
            const codex = yield* getWorkflowVmCodexConnection(row.organizationId, true);
            if (codex?.status !== "connected" || codex.connectionId !== vm.codexConnectionId)
              return yield* new WorkflowInvalidError({
                message: "The organization Codex connection changed. Check it and try again.",
              });
            const record = validateOrigin(row, {
              ...row.record,
              vmAdmission: { codexConnectionId: vm.codexConnectionId, hasSecrets },
            });
            const inserted = yield* persist(
              db
                .insert(relayWorkflowJobs)
                .values({ ...row, record })
                .onConflictDoNothing({ target: relayWorkflowJobs.jobId })
                .returning({ jobId: relayWorkflowJobs.jobId }),
            );
            return inserted.length
              ? { ...row, record }
              : ((yield* findVmSubmission(input)) ??
                  (yield* new WorkflowPersistenceError({
                    cause: "Missing VM submission after conflict.",
                  })));
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
    }),
    listJobs: (repositoryId: string) =>
      persist(
        db
          .select()
          .from(relayWorkflowJobs)
          .where(eq(relayWorkflowJobs.repositoryId, repositoryId))
          .orderBy(desc(relayWorkflowJobs.createdAt))
          .limit(100),
      ),
    pageJobs: Effect.fn("Workflows.pageJobs")(function* (
      repositoryId: string,
      query: WorkflowJobPageQuery,
    ): Effect.fn.Return<WorkflowJobPage, WorkflowPersistenceError | WorkflowInvalidError> {
      const cursor =
        query.cursor === undefined
          ? null
          : yield* decodeCursor(query.cursor).pipe(
              Effect.mapError(
                () =>
                  new WorkflowInvalidError({
                    message: "Invalid run-list cursor. Refresh the list.",
                  }),
              ),
            );
      if (cursor && (cursor.repositoryId !== repositoryId || cursor.view !== query.view))
        return yield* new WorkflowInvalidError({
          message: "This cursor belongs to a different run list. Refresh the list.",
        });
      const jobs = relayWorkflowJobs;
      const history = query.view === "history";
      const limit = query.limit ?? 50;
      const needsAttention = sql<boolean>`(
        (${jobs.summary}->>'needsAttention' IS NOT DISTINCT FROM 'true'
          AND ${jobs.summary}#>>'{queueReason,code}' IS DISTINCT FROM 'vm_waiting_capacity')
        OR (${jobs.record}#>>'{runtime,kind}'='vm'
          AND (${jobs.status} IN ('awaiting_review','awaiting_input')
            OR (${jobs.status}='cancelling'
              AND ${jobs.record}#>>'{progress,status}' IN ('awaiting_review','awaiting_input')))
          AND (${jobs.record}#>>'{vmRecovery,state}'='recovery_error' OR EXISTS (
            SELECT 1 FROM relay_thread_placements t JOIN relay_thread_vm_restores r
              ON r.thread_id=t.thread_id
              AND r.operation_id=COALESCE(t.operation_id,${jobs.pendingControl}->>'responseId')
            WHERE t.workflow_job_id=${jobs.jobId} AND t.audience='repository'
              AND t.thread_id=${jobs.record}#>>'{runtime,threadId}'
              AND t.organization_id=${jobs.organizationId} AND t.repository_id=${jobs.repositoryId}
              AND r.phase<>'completed' AND r.error_code='boot_deletion_unconfirmed'
              AND r.boot_recovery_started_at IS NOT NULL AND r.boot_receipt IS NOT NULL))) IS TRUE)`;
      const pendingOperation = sql`${jobs.pendingControl}#>>'{response,operation}'`;
      // Match canReplaceBlockedCheckpoint in WorkflowsApi. Retry saving stays available
      // when the VM checkpoint response has never reached the executor.
      const blockedByRetryableSave = sql<boolean>`(
        ${jobs.record}#>>'{runtime,kind}' = 'vm'
        AND ${jobs.pendingControl}->>'responseId' IS NOT NULL
        AND ${jobs.pendingControl}->>'checkpointDispatch' IS NULL
        AND ${jobs.record}#>>'{progress,resultSaving,state}' = 'failed'
        AND ${jobs.record}#>>'{progress,resultSaving,retryable}' = 'true'
      )`;
      const checkpointResponsePending = sql<boolean>`(
        (${jobs.status} = 'awaiting_review'
          AND ${jobs.record}#>>'{progress,approvalPending}' = 'true')
        OR (
          ((${jobs.status} = 'awaiting_input' AND ${pendingOperation} = 'input')
            OR (${jobs.status} = 'awaiting_review' AND ${pendingOperation} IN ('request_changes', 'approve')))
            AND ${blockedByRetryableSave} IS NOT TRUE
        )
      ) IS TRUE`;
      const approvalPending = sql<boolean>`(
        ${pendingOperation} = 'approve'
        OR ${jobs.record}#>>'{progress,approvalPending}' = 'true'
      ) IS TRUE`;
      const resultSave = sql`${jobs.record}#>'{progress,resultSaving}'`;
      const resultSaveState = sql<RepositoryWorkflowJobSummary["completionState"] | null>`
        CASE WHEN ${jobs.status} IN ('awaiting_input', 'awaiting_review', 'finishing') THEN
          CASE ${resultSave}->>'state'
            WHEN 'saving' THEN 'saving_result'
            WHEN 'failed' THEN
              CASE WHEN ${pendingOperation} = 'retry_saving'
                AND ${jobs.pendingControl}#>>'{response,publicationId}' = ${resultSave}->>'publicationId'
                THEN 'retrying_save' ELSE 'save_failed' END
          END
        END`;
      const finalChecks = sql<{
        stepIds: readonly string[];
        steps: WorkflowJobProgress["steps"] | null;
        detail: string | null;
        retryableApproval: boolean | null;
        approvalPending: boolean;
      } | null>`
        CASE WHEN ${jobs.status} IN ('awaiting_review', 'finishing') THEN jsonb_build_object(
          'stepIds', jsonb_path_query_array(${jobs.record}, '$.workflow.definition.steps[*].id'),
          'steps', ${jobs.record}#>'{progress,steps}',
          'detail', ${jobs.record}#>>'{progress,detail}',
          'retryableApproval', ${jobs.record}#>'{progress,retryableApproval}',
          'approvalPending', ${approvalPending}
        ) END`;
      const rows = yield* persist(
        db
          .select({
            summary: jobs.summary,
            needsAttention,
            checkpointResponsePending,
            resultSaveState,
            resultSaveDetail: sql<
              string | null
            >`CASE WHEN ${resultSaveState} = 'save_failed' THEN ${resultSave}->>'detail' END`,
            finalChecks,
            targetKind: sql<"machine" | "vm">`CASE
              WHEN ${jobs.record}#>>'{vmAdmission,codexConnectionId}' IS NOT NULL
                OR ${jobs.record}#>>'{runtime,kind}'='vm' THEN 'vm' ELSE 'machine' END`,
          })
          .from(jobs)
          .where(
            and(
              eq(jobs.repositoryId, repositoryId),
              history
                ? sql`${jobs.status} IN ('done','cancelled','failed')`
                : sql`${jobs.status} NOT IN ('done','cancelled','failed')`,
              query.view === "attention" ? needsAttention : undefined,
              cursor
                ? history
                  ? sql`(${jobs.createdAt}, ${jobs.jobId}) < (${cursor.createdAt}, ${cursor.jobId})`
                  : sql`(${jobs.createdAt}, ${jobs.jobId}) > (${cursor.createdAt}, ${cursor.jobId})`
                : undefined,
            ),
          )
          .orderBy(
            history ? desc(jobs.createdAt) : asc(jobs.createdAt),
            history ? desc(jobs.jobId) : asc(jobs.jobId),
          )
          .limit(limit + 1),
      );
      const page = rows
        .slice(0, limit)
        .map(
          ({
            summary,
            needsAttention,
            checkpointResponsePending,
            targetKind,
            resultSaveState,
            resultSaveDetail,
            finalChecks,
          }) => {
            let completionState = resultSaveState;
            if (
              !completionState &&
              finalChecks &&
              workflowIsFinishing({
                status: summary.status,
                workflow: { definition: { steps: finalChecks.stepIds.map((id) => ({ id })) } },
                progress: { steps: finalChecks.steps ?? undefined },
              })
            ) {
              // The detail client clears retryableApproval for cancel-only messages. Those
              // messages still indicate a blocked completion even when retry is unavailable.
              const blocked =
                !finalChecks.approvalPending &&
                (finalChecks.retryableApproval === true || !!finalChecks.detail?.trim());
              completionState = blocked ? "completion_blocked" : "finishing";
            }
            const reason = (
              completionState === "save_failed"
                ? resultSaveDetail
                : completionState === "completion_blocked"
                  ? finalChecks?.detail
                  : null
            )?.trim();
            const completionDetail =
              reason && reason !== "Response saved; waiting for the environment."
                ? Array.from(reason).slice(0, 500).join("")
                : undefined;
            return {
              ...summary,
              needsAttention,
              ...(checkpointResponsePending ? { checkpointResponsePending } : {}),
              ...(completionState ? { completionState } : {}),
              ...(completionDetail ? { completionDetail } : {}),
              targetKind,
            };
          },
        );
      const last = page.at(-1);
      return {
        jobs: page,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({
                version: 1,
                repositoryId,
                view: query.view,
                createdAt: last.createdAt,
                jobId: last.jobId,
              })
            : null,
      };
    }),
    pendingJobs: (scope: WorkflowDispatchScope = {}) =>
      persist(
        db
          .select()
          .from(relayWorkflowJobs)
          .where(
            and(
              scope.occurrenceId
                ? sql`${relayWorkflowJobs.jobId} IN (SELECT job_id FROM relay_workflow_admissions WHERE occurrence_id=${scope.occurrenceId})`
                : undefined,
              scope.connectionId
                ? sql`${relayWorkflowJobs.jobId} IN (SELECT job_id FROM relay_workflow_admissions WHERE connection_id=${scope.connectionId})`
                : undefined,
              scope.environmentId
                ? sql`(${relayWorkflowJobs.record}#>>'{runtime,environmentId}'=${scope.environmentId} OR (${relayWorkflowJobs.record}->'workflow'='null'::jsonb AND ${relayWorkflowJobs.record}->>'workflowId' IN (SELECT workflow_id FROM relay_repository_workflows WHERE record#>>'{definition,target,environmentId}'=${scope.environmentId})))`
                : undefined,
              sql`(${relayWorkflowJobs.pendingControl} IS NOT NULL OR ${relayWorkflowJobs.record}->'workflow'<>'null'::jsonb OR COALESCE((${relayWorkflowJobs.record}#>>'{queueReason,retryAt}')::double precision,0)<=extract(epoch FROM clock_timestamp())*1000)`,
              or(
                inArray(relayWorkflowJobs.status, [
                  "queued",
                  "dispatching",
                  "preparing",
                  "running",
                  "awaiting_review",
                  "awaiting_input",
                  "waiting_capacity",
                  "finishing",
                  "paused",
                  "cancelling",
                ]),
                and(
                  inArray(relayWorkflowJobs.status, ["done", "failed", "cancelled"]),
                  sql`${relayWorkflowJobs.record}->'vmAdmission' IS NOT NULL AND ${relayWorkflowJobs.record}->'vmAdmission'<>'null'::jsonb`,
                  sql`(${relayWorkflowJobs.record}#>>'{progress,resultSaving,state}'='saving' OR ${relayWorkflowJobs.pendingControl}#>>'{response,operation}'='retry_saving')`,
                ),
              ),
            ),
          )
          .orderBy(asc(relayWorkflowJobs.checkedAt), asc(relayWorkflowJobs.createdAt))
          .limit(100),
      ),
    /** A cross-instance lease pins an offered snapshot until acceptance is reconciled. */
    claim: Effect.fn("Workflows.claim")(function* (jobId: string) {
      // Database time also governs lease-fenced writes; relay clocks may differ.
      const rows = yield* persist(
        db
          .update(relayWorkflowJobs)
          .set({
            leaseUntil: sql`to_char((clock_timestamp() + interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
            checkedAt: sql`to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          })
          .where(
            and(
              eq(relayWorkflowJobs.jobId, jobId),
              or(
                isNull(relayWorkflowJobs.leaseUntil),
                sql`${relayWorkflowJobs.leaseUntil}::timestamptz <= clock_timestamp()`,
              ),
            ),
          )
          .returning(),
      );
      const row: WorkflowJobRecord | null = rows[0]
        ? { ...rows[0], record: normalizeStoredWorkflowJob(rows[0].record) }
        : null;
      return row;
    }),
    updateJob,
    settlePreparedMachineCancellation: Effect.fn("Workflows.settlePreparedMachineCancellation")(
      function* (previous: WorkflowJobRecord, expectedLease: string) {
        const request = previous.pendingControl;
        if (request?.response.operation !== "cancel") return previous;
        return yield* db.$client
          .withTransaction(
            Effect.gen(function* () {
              const authorized = yield* requireVisibleWorkflowRepository(
                previous,
                request.userId,
                true,
              ).pipe(Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(false)));
              return yield* updateJob(
                previous,
                {
                  ...previous.record,
                  status: authorized ? "cancelled" : "dispatching",
                  detail: authorized
                    ? "Cancelled before acceptance."
                    : "Cancellation was withdrawn because the requester no longer has permission.",
                  updatedAt: yield* now,
                },
                null,
                false,
                expectedLease,
              );
            }),
          )
          .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
      },
    ),
    canSettleVmCancellation,
    rejectQueuedVmStart: Effect.fn("Workflows.rejectQueuedVmStart")(function* (
      previous: WorkflowJobRecord,
      workflowRevision: number,
      detail: string,
      expectedLease: string,
    ) {
      const job = previous.record;
      if (
        !job.vmAdmission ||
        job.status !== "queued" ||
        job.workflow !== null ||
        job.runtime !== null ||
        previous.pendingControl
      )
        return previous;
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const workflow = yield* lockSavedWorkflow(job.workflowId, previous.repositoryId);
            if (!workflow || workflow.revision !== workflowRevision) return previous;
            const failed = yield* updateJob(
              previous,
              { ...job, status: "failed", queueReason: null, detail, updatedAt: yield* now },
              null,
              false,
              expectedLease,
            );
            yield* releaseUnusedVmPreparation(previous);
            return failed;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
    }),
    settleQueuedVmCancellation: Effect.fn("Workflows.settleQueuedVmCancellation")(function* (
      previous: WorkflowJobRecord,
      expectedLease: string,
    ) {
      const job = previous.record;
      const pending = previous.pendingControl;
      if (
        !job.vmAdmission ||
        job.status !== "cancelling" ||
        job.workflow !== null ||
        job.runtime !== null ||
        pending?.response.operation !== "cancel"
      )
        return previous;
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const authorized = yield* canSettleVmCancellation(previous);
            const settled = yield* updateJob(
              previous,
              {
                ...job,
                ...(authorized
                  ? {
                      status: "cancelled" as const,
                      queueReason: null,
                      detail: "Cancelled before preparation.",
                    }
                  : {
                      status: "queued" as const,
                      detail:
                        "Cancellation was withdrawn because the requester no longer has permission.",
                    }),
                updatedAt: yield* now,
              },
              null,
              false,
              expectedLease,
            );
            if (authorized) yield* releaseUnusedVmPreparation(previous);
            return settled;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
    }),
    /** Recheck the definition after the remote probe, before committing the initial binding. */
    bindManualOffer: Effect.fn("Workflows.bindManualOffer")(function* (
      previous: WorkflowJobRecord,
      record: RepositoryWorkflowJob,
      expectedLease: string,
    ) {
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* lockSavedWorkflow(record.workflowId, previous.repositoryId);
            if (!current || current.archived)
              return yield* new WorkflowInvalidError({
                message: "The workflow is archived or unavailable. Restore it or cancel this job.",
              });
            if (current.definition.target.kind === "vm")
              return yield* vmWorkflowExecutionUnavailable();
            if (current.revision !== record.workflow?.revision)
              return yield* new WorkflowInvalidError({
                message:
                  "The workflow changed while preparing this run. Waiting to retry with the saved definition.",
              });
            return yield* updateJob(
              previous,
              record,
              previous.pendingControl,
              false,
              expectedLease,
            );
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => new WorkflowPersistenceError({ cause })));
    }),
    release: (jobId: string, leaseUntil: string) =>
      persist(
        db
          .update(relayWorkflowJobs)
          .set({ leaseUntil: null })
          .where(
            and(eq(relayWorkflowJobs.jobId, jobId), eq(relayWorkflowJobs.leaseUntil, leaseUntil)),
          ),
      ).pipe(Effect.asVoid),
  };
});
export class Workflows extends Context.Service<Workflows, Effect.Success<typeof make>>()(
  "launchpad-relay/jobs/Workflows",
) {}
export const layer = Layer.effect(Workflows, make);
