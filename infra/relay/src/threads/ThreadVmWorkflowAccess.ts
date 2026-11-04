import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import { relayInternalErrorResponse } from "../http/Api.ts";

export interface WorkflowVmPreparationScope {
  readonly workflowJobId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly codexConnectionId: string;
}

/** Holds the preparing job and exact placement across a DB-only worker operation. */
export const withPreparingWorkflowVm = <A, E, R>(
  sql: PgClient,
  input: {
    readonly allocationId: string;
    readonly operationId: string;
    readonly allowReleasedHold?: boolean;
  },
  use: (scope: WorkflowVmPreparationScope) => Effect.Effect<A, E, R>,
) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const [hint] = yield* sql<
          Omit<WorkflowVmPreparationScope, "codexConnectionId"> & {
            threadId: string;
            generation: number;
          }
        >`SELECT t.workflow_job_id AS "workflowJobId",t.organization_id AS "organizationId",
        t.repository_id AS "repositoryId",t.thread_id AS "threadId",p.generation
        FROM relay_thread_vm_allocations a JOIN relay_thread_vm_provisions p USING(allocation_id)
        JOIN relay_thread_placements t ON t.thread_id=a.thread_id AND t.organization_id=a.organization_id
        WHERE a.allocation_id=${input.allocationId} AND p.operation_id=${input.operationId}
          AND a.resource_kind='organization_workflow' AND a.runtime_protocol='native-v1'
          AND p.workflow_snapshot IS NOT NULL AND t.audience='repository'`;
        if (!hint) return yield* tenancyNotFound("thread_not_found");
        const [repository] = yield* sql`SELECT repository_id FROM relay_repositories
        WHERE organization_id=${hint.organizationId} AND repository_id=${hint.repositoryId} FOR SHARE`;
        if (!repository) return yield* tenancyNotFound("thread_not_found");
        const [job] = yield* sql<{ codexConnectionId: string }>`
        SELECT record#>>'{vmAdmission,codexConnectionId}' AS "codexConnectionId"
        FROM relay_workflow_jobs WHERE job_id=${hint.workflowJobId}
          AND organization_id=${hint.organizationId} AND repository_id=${hint.repositoryId}
          AND status='preparing' AND pending_control IS NULL
          AND record#>>'{runtime,kind}'='vm' AND record#>>'{runtime,threadId}'=${hint.threadId} FOR SHARE`;
        if (!job?.codexConnectionId) return yield* tenancyNotFound("thread_not_found");
        const [placement] = yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${hint.threadId} AND audience='repository' AND workflow_job_id=${hint.workflowJobId}
          AND organization_id=${hint.organizationId} AND repository_id=${hint.repositoryId}
          AND generation=${hint.generation} AND (operation_id=${input.operationId}
            OR (${input.allowReleasedHold === true} AND operation_id IS NULL AND environment_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_deletions WHERE thread_id=${hint.threadId})
        FOR NO KEY UPDATE`;
        if (!placement) return yield* tenancyNotFound("thread_not_found");
        return yield* use({ ...hint, ...job });
      }),
    )
    .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
