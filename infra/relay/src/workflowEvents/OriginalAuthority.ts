import { WorkflowQueueReason } from "@t3tools/contracts/workflows";
import { WorkflowSourceError } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import type { WorkflowJobRecord } from "../jobs/Workflows.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Issue from "../workflowSources/IssueContext.ts";
import * as Fence from "./Fence.ts";

export class WorkflowQueued extends Schema.TaggedError<WorkflowQueued>()(
  "WorkflowQueued",
  WorkflowQueueReason.fields,
) {}
export const blocked = (code: WorkflowQueueReason["code"], retryAt: number | null = null) =>
  new WorkflowQueued({ code, retryAt });
export type WorkflowSourceBlocker =
  | "source_configuration"
  | "source_reconnect"
  | "source_unavailable"
  | "source_withdrawn";
export const isWorkflowSourceBlocker = (code: string | null): code is WorkflowSourceBlocker =>
  code === "source_configuration" ||
  code === "source_reconnect" ||
  code === "source_unavailable" ||
  code === "source_withdrawn";
const isSourceError = Schema.is(WorkflowSourceError);

/** This reads no provider data and holds authority only for its calling transaction. */
type AdmittedJob = Pick<WorkflowJobRecord, "jobId" | "organizationId" | "repositoryId" | "record">;

export const originalAuthority = Effect.fn("workflowEvents.originalAuthority")(function* (
  row: AdmittedJob,
) {
  const origin = row.record.origin;
  if (origin?.kind !== "automation" || !row.record.event)
    return yield* blocked("issue_context_invalid");
  const sql = (yield* RelayDb).$client;
  const [admission] = yield* sql<{
    grant_generation: number;
    connection_id: string;
    grant_id: string;
  }>`SELECT grant_generation,connection_id,grant_id FROM relay_workflow_admissions WHERE job_id=${row.jobId} AND occurrence_id=${origin.occurrenceId} AND workflow_id=${row.record.workflowId} AND organization_id=${row.organizationId} AND repository_id=${row.repositoryId}`;
  if (
    !admission ||
    admission.connection_id !== origin.source.connectionId ||
    admission.grant_id !== origin.source.grantId
  )
    return yield* blocked("source_withdrawn");
  const bound = yield* Store.authority(row.repositoryId, origin.source.grantId).pipe(
    Effect.catchIf(isSourceError, (error) =>
      Effect.fail(
        blocked(
          error.code === "reconnect_required"
            ? "source_reconnect"
            : error.code === "service_configuration" || error.code === "not_configured"
              ? "source_configuration"
              : error.code === "refresh_in_progress"
                ? "source_unavailable"
                : "source_withdrawn",
          error.retryAt ?? null,
        ),
      ),
    ),
  );
  if (
    bound.connection.connection_id !== origin.source.connectionId ||
    bound.connection.organization_id !== row.organizationId ||
    bound.connection.application_id !== origin.source.applicationId ||
    bound.connection.workspace_id !== origin.source.workspaceId ||
    bound.grant.generation !== admission.grant_generation
  )
    return yield* blocked("source_withdrawn");
  return bound;
});

/** Take the source fence before entering a transaction helper that locks the job. */
export const lockOriginalAuthority = Effect.fnUntraced(function* (row: AdmittedJob) {
  const origin = row.record.origin;
  if (origin?.kind !== "automation") return yield* blocked("issue_context_invalid");
  yield* Fence.lock(origin.source.applicationId, origin.source.workspaceId);
  return yield* originalAuthority(row);
});

export const readAdmittedIssue = Effect.fnUntraced(function* (
  connection: Store.Connection,
  issueId: string,
) {
  return yield* Issue.readIssue(connection, issueId).pipe(
    Effect.catchTag("IssueContextError", (error) => Effect.fail(blocked(error.code))),
    Effect.catchIf(isSourceError, (error) =>
      Effect.fail(
        blocked(
          error.code === "reconnect_required"
            ? "source_reconnect"
            : error.code === "service_configuration"
              ? "source_configuration"
              : error.code === "rate_limited"
                ? "source_rate_limited"
                : error.code === "forbidden" || error.code === "not_found"
                  ? "issue_unavailable"
                  : error.code === "invalid_input"
                    ? "issue_context_invalid"
                    : "source_unavailable",
          error.retryAt ?? null,
        ),
      ),
    ),
  );
});
