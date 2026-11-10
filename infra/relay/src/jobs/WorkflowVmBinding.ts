import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  RelayEnvironmentPrincipal,
  type RelayAssignedWorkflowThreadPlacement,
} from "@t3tools/contracts/relay";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkflowVmDispatchBinding } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";

type WorkflowVmIdentity = {
  readonly jobId?: string;
  readonly threadId?: string;
  readonly organizationId?: string;
  readonly repositoryId?: string;
  readonly environmentId?: string;
  readonly generation?: number;
};

export type WorkflowVmSnapshot = {
  readonly canonicalKey: string;
  readonly installationId: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly templateBuildId: string;
};

export const workflowVmHasSecrets = Effect.fnUntraced(function* (sql: PgClient, jobId: string) {
  const [snapshot] = yield* sql<{ hasSecrets: boolean }>`
    SELECT has_secrets AS "hasSecrets" FROM relay_workflow_run_configurations
    WHERE job_id=${jobId}`;
  return snapshot?.hasSecrets ?? true;
});

export const isWorkflowVmThread = Effect.fnUntraced(function* (sql: PgClient, threadId: string) {
  if (!threadId.startsWith("workflow:")) return false;
  const [row] = yield* sql`SELECT 1 FROM relay_thread_placements
    WHERE thread_id=${threadId} AND audience='repository'`;
  return row !== undefined;
});

export const readWorkflowVmBinding = Effect.fnUntraced(function* (
  sql: PgClient,
  expected: WorkflowVmIdentity,
  stage: "active" | "enrolled" = "active",
) {
  const [row] = yield* sql<{
    threadId: string;
    jobId: string;
    organizationId: string;
    repositoryId: string;
    environmentId: string;
    projectId: string;
    operationId: string;
    generation: number;
    allocationId: string;
    sandboxId: string;
    templateId: string;
    credentialId: string;
    environmentPublicKey: string;
    snapshot: WorkflowVmSnapshot;
    active: boolean;
  }>`
    SELECT t.thread_id AS "threadId", t.workflow_job_id AS "jobId",
      t.organization_id AS "organizationId", t.repository_id AS "repositoryId",
      t.environment_id AS "environmentId", t.project_id AS "projectId", t.generation,
      p.operation_id AS "operationId", a.allocation_id AS "allocationId",
      a.compute_ref AS "sandboxId", a.template_id AS "templateId",
      b.credential_id AS "credentialId", b.environment_public_key AS "environmentPublicKey",
      p.workflow_snapshot AS snapshot, t.operation_id IS NULL AS active
    FROM relay_thread_placements t
    JOIN relay_repositories r ON r.repository_id=t.repository_id AND r.organization_id=t.organization_id
    JOIN relay_workflow_jobs j ON j.job_id=t.workflow_job_id AND j.repository_id=t.repository_id
      AND j.organization_id=t.organization_id AND j.record#>>'{runtime,threadId}'=t.thread_id
    JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id AND a.organization_id=t.organization_id
      AND a.resource_kind='organization_workflow' AND a.state='running' AND a.deleted_at IS NULL
    JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
      AND p.phase='created' AND p.generation=t.generation AND p.workflow_snapshot IS NOT NULL
    JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id AND b.thread_id=t.thread_id
      AND b.environment_id=t.environment_id AND b.generation=t.generation
      AND b.repository_id=t.repository_id AND b.revoked_at IS NULL
    JOIN relay_thread_vm_enrollments e ON e.allocation_id=a.allocation_id
      AND e.operation_id=p.operation_id AND e.environment_id=b.environment_id
      AND e.credential_id=b.credential_id AND e.environment_public_key=b.environment_public_key
      AND e.installed_at IS NOT NULL
    JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
      AND c.environment_id=b.environment_id AND c.environment_public_key=b.environment_public_key
      AND c.revoked_at IS NULL
    WHERE t.audience='repository' AND t.owner_user_id IS NULL AND t.project_id='vm:' || t.thread_id
      AND a.compute_ref IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
      AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
        WHERE x.allocation_id=a.allocation_id AND x.phase IN ('pending','sealed'))
      AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes x
        WHERE x.allocation_id=a.allocation_id AND x.phase IN ('waiting','resuming'))
      ${expected.jobId === undefined ? sql`` : sql`AND j.job_id=${expected.jobId}`}
      ${expected.threadId === undefined ? sql`` : sql`AND t.thread_id=${expected.threadId}`}
      ${expected.organizationId === undefined ? sql`` : sql`AND t.organization_id=${expected.organizationId}`}
      ${expected.repositoryId === undefined ? sql`` : sql`AND t.repository_id=${expected.repositoryId}`}
      ${expected.environmentId === undefined ? sql`` : sql`AND t.environment_id=${expected.environmentId}`}
      ${expected.generation === undefined ? sql`` : sql`AND t.generation=${expected.generation}`}
      ${
        stage === "enrolled"
          ? sql`AND (t.operation_id IS NULL OR t.operation_id=p.operation_id)`
          : sql`
        AND t.operation_id IS NULL
        AND EXISTS (SELECT 1 FROM relay_thread_vm_ready s WHERE s.allocation_id=a.allocation_id
          AND s.environment_id=b.environment_id AND s.generation=b.generation AND s.phase='ready')
        AND EXISTS (SELECT 1 FROM relay_thread_vm_codex_auth x WHERE x.allocation_id=a.allocation_id
          AND x.environment_id=b.environment_id AND x.generation=b.generation
          AND x.mode='organization' AND x.connection_id=j.record#>>'{vmAdmission,codexConnectionId}'
          AND x.acknowledged_connection_id=x.connection_id)
      `
      }
    LIMIT 1`;
  if (!row) return yield* tenancyNotFound("thread_not_found");
  const binding = {
    jobId: row.jobId,
    organizationId: row.organizationId,
    repositoryId: row.repositoryId,
    threadId: ThreadId.make(row.threadId),
    allocationId: row.allocationId,
    environmentId: EnvironmentId.make(row.environmentId),
    generation: row.generation,
    operationId: row.operationId,
    projectId: ProjectId.make(row.projectId),
  } satisfies WorkflowVmDispatchBinding;
  const placement = {
    audience: "repository",
    workflowJobId: row.jobId,
    ownerUserId: null,
    threadId: row.threadId,
    organizationId: row.organizationId,
    repositoryId: row.repositoryId,
    environmentId: row.environmentId,
    projectId: row.projectId,
    generation: row.generation,
    operationId: row.active ? null : row.operationId,
    originalLocation: null,
  } satisfies RelayAssignedWorkflowThreadPlacement;
  return { ...row, binding, placement };
});

export const requireWorkflowVmViewer = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { organizationId: string; repositoryId: string },
  userId: string,
) {
  const [member] = yield* sql<{ role: string }>`
    SELECT role FROM relay_organization_members
    WHERE user_id=${userId} AND organization_id=${scope.organizationId} FOR SHARE`;
  if (!member) return yield* tenancyNotFound("thread_not_found");
  if (member.role === "admin") return;
  const [grant] = yield* sql`SELECT user_id FROM relay_repository_access
    WHERE repository_id=${scope.repositoryId} AND organization_id=${scope.organizationId}
      AND user_id=${userId} FOR SHARE`;
  if (!grant) return yield* tenancyNotFound("thread_not_found");
});

export const requireWorkflowVmMaintainer = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { organizationId: string; repositoryId: string },
  userId: string,
) {
  yield* requireWorkflowVmViewer(sql, scope, userId);
  const [access] = yield* sql`SELECT 1 FROM relay_organization_members m
    WHERE m.organization_id=${scope.organizationId} AND m.user_id=${userId}
      AND (m.role='admin' OR EXISTS(SELECT 1 FROM relay_repository_access r
        WHERE r.organization_id=m.organization_id AND r.repository_id=${scope.repositoryId}
          AND r.user_id=m.user_id AND r.role='maintainer')) FOR SHARE OF m`;
  if (!access) return yield* tenancyNotFound("thread_not_found");
});

export const authorizeWorkflowVmGuest = Effect.fnUntraced(function* (
  input: { threadId: string; environmentId: string; generation: number; jobId?: string },
  stage: "active" | "enrolled" = "active",
) {
  const principal = yield* RelayEnvironmentPrincipal;
  const scope = principal.threadVm;
  if (
    !scope ||
    principal.environmentId !== input.environmentId ||
    scope.threadId !== input.threadId ||
    scope.generation !== input.generation
  )
    return yield* tenancyNotFound("thread_not_found");
  const sql = (yield* RelayDb).$client;
  const resolved = yield* readWorkflowVmBinding(
    sql,
    { ...input, repositoryId: scope.repositoryId },
    stage,
  );
  if (
    resolved.binding.allocationId !== scope.allocationId ||
    resolved.credentialId !== principal.credentialId ||
    resolved.environmentPublicKey !== principal.environmentPublicKey
  )
    return yield* tenancyNotFound("thread_not_found");
  return resolved;
});

/** Use only for DB-local work. Keep the job/placement stable through the receipt. */
export const withWorkflowVmGuest = <A, E, R>(
  input: { threadId: string; environmentId: string; generation: number; jobId?: string },
  stage: "active" | "enrolled",
  use: (
    resolved: Effect.Success<ReturnType<typeof authorizeWorkflowVmGuest>>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [hint] = yield* sql<{ jobId: string }>`SELECT workflow_job_id AS "jobId"
        FROM relay_thread_placements WHERE thread_id=${input.threadId} AND audience='repository'`;
        if (!hint || (input.jobId !== undefined && hint.jobId !== input.jobId))
          return yield* tenancyNotFound("thread_not_found");
        yield* sql`SELECT job_id FROM relay_workflow_jobs WHERE job_id=${hint.jobId} FOR SHARE`;
        yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
        const resolved = yield* authorizeWorkflowVmGuest({ ...input, jobId: hint.jobId }, stage);
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations
        WHERE allocation_id=${resolved.binding.allocationId} FOR SHARE`;
        yield* sql`SELECT credential_id FROM relay_environment_credentials
        WHERE credential_id=${resolved.credentialId} FOR SHARE`;
        return yield* use(yield* authorizeWorkflowVmGuest({ ...input, jobId: hint.jobId }, stage));
      }),
    );
  });
