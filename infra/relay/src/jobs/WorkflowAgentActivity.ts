import type { PgClient } from "@effect/sql-pg/PgClient";
import { isToolLifecycleItemType, ToolLifecycleItemType } from "@t3tools/contracts";
import {
  runningWorkflowVmAgent,
  workflowAgentPromptId,
  WORKFLOW_AGENT_ACTIVITY_MESSAGE_LIMIT,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import type { WorkflowJobRecord } from "./Workflows.ts";
import { readWorkflowVmBinding, requireWorkflowVmViewer } from "./WorkflowVmBinding.ts";

// Provider titles and tool arguments can include commands, issue text or output.
const labels = {
  command_execution: "Running a command",
  file_change: "Editing files",
  web_search: "Searching the web",
  image_view: "Viewing an image",
  collab_agent_tool_call: "Working with another agent",
  mcp_tool_call: "Using a tool",
  dynamic_tool_call: "Using a tool",
} satisfies Record<ToolLifecycleItemType, string>;

function workflowAgentActivityTool(itemType: string | null): string | null {
  return itemType && isToolLifecycleItemType(itemType) ? labels[itemType] : null;
}

/** Read only the redacted journal already mirrored by the VM. */
export const readWorkflowAgentActivity = Effect.fn("relay.workflow_agent_activity")(function* (
  sql: PgClient,
  row: WorkflowJobRecord,
  userId: string,
) {
  const job = row.record;
  const step = runningWorkflowVmAgent(job);
  if (!step || job.runtime?.kind !== "vm" || !job.workflow || !job.progress) return undefined;
  const threadId = job.runtime.threadId;
  const firstAgent = job.workflow.definition.steps.find((candidate) => candidate.kind === "agent");
  const promptId = workflowAgentPromptId(
    row.jobId,
    step.id,
    job.progress.generation ?? 0,
    firstAgent?.id !== step.id,
    job.progress.agentRetryAttempt,
  );
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // The binding, queue, and history must agree while the VM continues appending events.
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
        yield* requireWorkflowVmViewer(sql, row, userId);
        const vm = yield* readWorkflowVmBinding(sql, { ...row, threadId }).pipe(
          Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
        );
        if (!vm) return undefined;
        const limit = WORKFLOW_AGENT_ACTIVITY_MESSAGE_LIMIT;
        const [activity] = yield* sql<{
          message: string | null;
          itemType: string | null;
          updatedAt: string | null;
        }>`
      WITH queue AS (
        SELECT queue_json FROM relay_thread_current_queues WHERE thread_id=${threadId}
      ), attempt AS (
        SELECT admission->>'turnId' AS turn_id,
          COALESCE((admission#>>'{prompt,acceptedSequence}')::int, 0) AS first_sequence, false AS finalized
        FROM queue q, jsonb_array_elements(q.queue_json->'admissions') admission
        WHERE admission->>'messageId'=${promptId}
          AND admission->>'turnId'=q.queue_json->>'awaitingTurnId'
        UNION ALL
        -- The user message persists before buffered provider events and survives queue finalization.
        SELECT q.queue_json->>'finalizedTurnId', h.source_sequence, true
        FROM queue q JOIN relay_thread_history h ON h.thread_id=${threadId}
          AND h.environment_id=${vm.environmentId} AND h.event_json->>'type'='thread.message-sent'
          AND h.event_json#>>'{payload,role}'='user' AND h.event_json#>>'{payload,messageId}'=${promptId}
          AND h.event_json#>>'{payload,turnId}'=q.queue_json->>'finalizedTurnId'
        WHERE q.queue_json->>'awaitingTurnId' IS NULL AND q.queue_json->>'finalizedTurnId' IS NOT NULL
        LIMIT 1
      ), messages AS NOT MATERIALIZED (
        SELECT h.cursor, h.event_json->'payload' AS payload
        FROM attempt a JOIN relay_thread_history h
          ON h.thread_id=${threadId} AND h.environment_id=${vm.environmentId}
          AND h.source_sequence>=a.first_sequence
        WHERE h.event_json->>'type'='thread.message-sent'
          AND h.event_json#>>'{payload,role}'='assistant' AND h.event_json#>>'{payload,turnId}'=a.turn_id
      ), completed AS (
        SELECT f.cursor, f.payload->>'updatedAt' AS updated_at,
          CASE WHEN f.payload->>'text'<>'' THEN left(f.payload->>'text', ${limit})
            ELSE (
              SELECT left(string_agg(chunk.text, '' ORDER BY chunk.cursor), ${limit}) FROM (
                SELECT d.cursor, left(d.payload->>'text', ${limit}) AS text FROM messages d
                WHERE d.cursor<f.cursor AND d.payload->>'messageId'=f.payload->>'messageId'
                  AND d.payload->>'streaming'='true' AND d.payload->>'text'<>''
                ORDER BY d.cursor LIMIT ${limit}
              ) chunk
            ) END AS message
        FROM messages f WHERE f.payload->>'streaming'='false'
      ), message AS (
        SELECT cursor, updated_at, regexp_replace(message, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS message
        FROM completed WHERE message ~ '[^[:space:]]' ORDER BY cursor DESC LIMIT 1
      ), tools AS (
        SELECT h.cursor, activity->>'createdAt' AS updated_at,
          activity#>>'{payload,toolCallId}' AS call_id, activity#>>'{payload,itemType}' AS item_type,
          (activity->>'kind'='tool.completed' OR
            COALESCE(activity#>>'{payload,status}','') IN ('completed','failed','declined')) AS finished
        FROM attempt a JOIN relay_thread_history h
          ON h.thread_id=${threadId} AND h.environment_id=${vm.environmentId}
          AND h.source_sequence>=a.first_sequence
        CROSS JOIN LATERAL (SELECT h.event_json#>'{payload,activity}' AS activity) event
        WHERE h.event_json->>'type'='thread.activity-appended' AND activity->>'turnId'=a.turn_id
          AND activity->>'kind' IN ('tool.started','tool.updated','tool.completed')
          AND activity#>>'{payload,toolCallId}' IS NOT NULL
          AND activity#>>'{payload,itemType}' IN ${sql.in(ToolLifecycleItemType.literals)}
          AND activity#>>'{payload,agentId}' IS NULL AND activity#>>'{payload,parentToolUseId}' IS NULL
      ), calls AS (
        SELECT DISTINCT ON (call_id) * FROM tools ORDER BY call_id, finished DESC, cursor DESC
      )
      SELECT (SELECT message FROM message) AS message,
        (SELECT item_type FROM calls WHERE NOT finished AND NOT (SELECT finalized FROM attempt)
          ORDER BY cursor DESC LIMIT 1) AS "itemType",
        (SELECT updated_at FROM (
          SELECT cursor, updated_at FROM message UNION ALL SELECT cursor, updated_at FROM calls
        ) activity ORDER BY cursor DESC LIMIT 1) AS "updatedAt"
      FROM relay_workflow_jobs WHERE job_id=${row.jobId} AND revision=${row.revision}`;
        return (
          activity && {
            message: activity.message,
            tool: workflowAgentActivityTool(activity.itemType),
            updatedAt: activity.updatedAt,
          }
        );
      }),
    )
    .pipe(
      Effect.catchTag("SqlError", () =>
        Effect.logWarning("Workflow Agent activity could not be read.").pipe(Effect.as(undefined)),
      ),
    );
});
