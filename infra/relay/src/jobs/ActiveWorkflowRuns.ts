import { sql } from "drizzle-orm";
import type { RelayDb } from "../db.ts";
import { readWorkflowVmRecoveries } from "../threads/WorkflowVmRecovery.ts";
import { relayWorkflowJobs as jobs } from "../persistence/schema.ts";
import {
  cancellationState,
  checkpointResponsePending,
  finalChecks,
  manualPauseState,
  queueReasonCode,
  resultSaveState,
  summaryNeedsAttention,
  workflowRunCompletionState,
  type WorkflowFinalChecks,
} from "./WorkflowRunStatus.ts";
import {
  type ActiveWorkflowRun,
  type ActiveWorkflowRunPage,
  type ActiveWorkflowRunPageQuery,
  WorkflowInvalidError,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowPersistenceError } from "./Workflows.ts";

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    organizationId: Schema.String.check(Schema.isMaxLength(64)),
    userId: Schema.String.check(Schema.isMaxLength(191)),
    createdAt: Schema.String.check(Schema.isMaxLength(64)),
    jobId: Schema.String.check(Schema.isMaxLength(64)),
  }),
);
const decodeCursor = Schema.decodeEffect(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
const invalidCursor = () =>
  new WorkflowInvalidError({ message: "Invalid run-list cursor. Refresh the list." });

export const pageActiveWorkflowRuns = Effect.fn("Workflows.pageActiveWorkflowRuns")(function* (
  db: RelayDb["Service"],
  userId: string,
  query: ActiveWorkflowRunPageQuery,
): Effect.fn.Return<ActiveWorkflowRunPage, WorkflowInvalidError | WorkflowPersistenceError> {
  const cursor =
    query.cursor === undefined
      ? undefined
      : yield* decodeCursor(query.cursor).pipe(Effect.mapError(invalidCursor));
  if (cursor && cursor.userId !== userId) return yield* invalidCursor();
  const limit = query.limit ?? 50;

  // Count and page share a PostgreSQL snapshot. Materialize only active IDs so the
  // frequently refreshed sidebar reads saved workflow/issue JSON for one page.
  type ProjectedRow = ActiveWorkflowRun & {
    isVm: boolean;
    queueReasonCode: NonNullable<ActiveWorkflowRun["queueReason"]>["code"] | null;
    resultSaveState: ActiveWorkflowRun["completionState"] | null;
    finalChecks: WorkflowFinalChecks | null;
  };
  const [page] = yield* db
    .execute<{
      organizationId: string | null;
      total: number;
      jobs: ProjectedRow[];
    }>(
      sql`
    WITH member AS (
      SELECT m.organization_id, m.role FROM relay_organization_members m
      JOIN relay_organizations o ON o.organization_id=m.organization_id
      WHERE m.user_id=${userId}
    ), active AS (
      SELECT j.job_id, j.created_at, r.name AS repository_name
      FROM member m
      JOIN relay_repositories r ON r.organization_id=m.organization_id
      JOIN relay_workflow_jobs j ON j.repository_id=r.repository_id AND j.organization_id=m.organization_id
      WHERE j.status NOT IN ('done','cancelled','failed')
        AND (m.role='admin' OR EXISTS (
          SELECT 1 FROM relay_repository_access a WHERE a.repository_id=r.repository_id
            AND a.organization_id=m.organization_id AND a.user_id=${userId}
        ))
    ), page_keys AS (
      SELECT * FROM active
      ${cursor ? sql`WHERE (created_at, job_id) > (${cursor.createdAt}, ${cursor.jobId})` : sql``}
      ORDER BY created_at, job_id LIMIT ${limit + 1}
    ), page_rows AS (
      SELECT ${jobs.jobId} AS "jobId", ${jobs.repositoryId} AS "repositoryId", k.repository_name AS "repositoryName",
        ${jobs.status}, ${checkpointResponsePending} AS "checkpointResponsePending",
        ${cancellationState} AS "cancellationState",
        ${manualPauseState} AS "manualPauseState", ${queueReasonCode} AS "queueReasonCode",
        ${summaryNeedsAttention} AS "needsAttention",
        ${resultSaveState} AS "resultSaveState", ${finalChecks} AS "finalChecks",
        (${jobs.record}#>>'{runtime,kind}'='vm') IS TRUE AS "isVm", k.created_at AS "createdAt",
        coalesce(${jobs.record}#>>'{issueSnapshot,identifier}', ${jobs.record}#>>'{event,identifier}') AS "issueIdentifier",
        left(coalesce(${jobs.record}#>>'{issueSnapshot,title}', ${jobs.record}#>>'{event,title}',
          ${jobs.record}#>>'{workflow,definition,name}', ${jobs.record}#>>'{originSummary,workflowName}',
          w.record#>>'{definition,name}', 'Workflow run'), 280) AS title
      FROM page_keys k JOIN ${jobs} ON ${jobs.jobId}=k.job_id
      LEFT JOIN relay_repository_workflows w ON w.workflow_id=${jobs.record}->>'workflowId' AND w.repository_id=${jobs.repositoryId}
    )
    SELECT (SELECT organization_id FROM member) AS "organizationId",
      (SELECT count(*)::int FROM active) AS total,
      coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."createdAt", p."jobId") FROM page_rows p), '[]'::jsonb) AS jobs
  `,
      "objects",
    )
    .pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));
  if (!page) return yield* new WorkflowPersistenceError({ cause: "Missing active run page" });
  if (cursor && cursor.organizationId !== page.organizationId) return yield* invalidCursor();
  const rows = page.jobs.slice(0, limit);
  const recovery = yield* readWorkflowVmRecoveries(
    db.$client,
    rows.filter((row) => row.isVm).map((row) => row.jobId),
  ).pipe(Effect.mapError((cause) => new WorkflowPersistenceError({ cause })));
  const runs = rows.map((row): ActiveWorkflowRun => {
    const completionState = workflowRunCompletionState(
      row.status,
      row.resultSaveState,
      row.finalChecks,
    );
    const vmRecovery = recovery.get(row.jobId);
    return {
      jobId: row.jobId,
      repositoryId: row.repositoryId,
      repositoryName: row.repositoryName,
      issueIdentifier: row.issueIdentifier,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      ...((row.status === "queued" || row.status === "preparing") && row.queueReasonCode
        ? { queueReason: { code: row.queueReasonCode } }
        : {}),
      ...(row.needsAttention ? { needsAttention: true } : {}),
      ...(row.cancellationState ? { cancellationState: row.cancellationState } : {}),
      ...(row.manualPauseState ? { manualPauseState: row.manualPauseState } : {}),
      ...(row.checkpointResponsePending ? { checkpointResponsePending: true } : {}),
      ...(completionState ? { completionState } : {}),
      ...(vmRecovery ? { vmRecovery: { state: vmRecovery.state } } : {}),
    };
  });
  const last = runs.at(-1);
  return {
    ...page,
    jobs: runs,
    nextCursor:
      page.jobs.length > limit && page.organizationId && last
        ? encodeCursor({
            organizationId: page.organizationId,
            userId,
            createdAt: last.createdAt,
            jobId: last.jobId,
          })
        : null,
  };
});
