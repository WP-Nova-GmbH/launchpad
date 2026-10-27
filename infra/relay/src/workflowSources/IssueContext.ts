import {
  WorkflowIssueSnapshot,
  workflowIssueUrl,
  type WorkflowQueueReason,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Linear from "./Linear.ts";
import * as Sources from "./Sources.ts";
import * as Store from "./Store.ts";

export class IssueContextError extends Schema.TaggedError<IssueContextError>()(
  "IssueContextError",
  {
    code: Schema.Literals([
      "issue_unavailable",
      "issue_context_invalid",
      "issue_context_too_large",
    ]),
  },
) {}
const Name = Schema.Struct({ id: Schema.String, name: Schema.String });
const decode = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Schema.Struct({ id: Schema.String }),
      issue: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          identifier: Schema.String,
          title: Schema.String,
          description: Schema.NullOr(Schema.String),
          url: Schema.String,
          updatedAt: Schema.String,
          team: Name,
          state: Name,
          labels: Schema.Struct({
            nodes: Schema.Array(Name),
            pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
          }),
        }),
      ),
    }),
  }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(WorkflowIssueSnapshot);

export function issueInstruction(issue: WorkflowIssueSnapshot) {
  return [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
    `Team: ${issue.team.name} (${issue.team.id})`,
    `Status: ${issue.status.name} (${issue.status.id})`,
    `Labels: ${issue.labels.map((label) => `${label.name} (${label.id})`).join(", ") || "None"}`,
    "Issue description (external task context):",
    issue.description,
  ].join("\n");
}

/** The original connection is authority; event-time filters are not rematched here. */
export const readIssue = Effect.fn("workflowSources.readIssue")(function* (
  connection: Store.Connection,
  issueId: string,
) {
  const loaded = yield* Sources.read(connection, (token, current) =>
    Linear.graphql(
      token,
      "query WorkflowStartIssue($id:String!) { organization{id} issue(id:$id){id identifier title description url updatedAt team{id name} state{id name} labels(first:100){nodes{id name} pageInfo{hasNextPage}}} }",
      { id: issueId },
      decode,
      "issue",
    ).pipe(Effect.map((data) => ({ data, connection: current }))),
  );
  const raw = loaded.data.issue;
  if (!raw) return yield* new IssueContextError({ code: "issue_unavailable" });
  if (
    loaded.data.organization.id !== connection.workspace_id ||
    raw.id !== issueId ||
    !workflowIssueUrl(raw.url) ||
    raw.labels.pageInfo.hasNextPage
  )
    return yield* new IssueContextError({ code: "issue_context_invalid" });
  if ((raw.description?.length ?? 0) > 32_000)
    return yield* new IssueContextError({ code: "issue_context_too_large" });
  const snapshot = yield* decodeSnapshot({
    workspaceId: connection.workspace_id,
    issueId,
    identifier: raw.identifier,
    url: raw.url,
    title: raw.title,
    description: raw.description ?? "",
    team: raw.team,
    status: raw.state,
    labels: raw.labels.nodes,
    issueUpdatedAt: raw.updatedAt,
    retrievedAt: Store.iso(yield* Store.now),
    authorizationEpoch: loaded.connection.authorization_epoch,
    credentialVersion: loaded.connection.credential_version,
  }).pipe(Effect.mapError(() => new IssueContextError({ code: "issue_context_invalid" })));
  const instruction = issueInstruction(snapshot);
  if (instruction.length > 32_000)
    return yield* new IssueContextError({ code: "issue_context_too_large" });
  return { snapshot, instruction };
});

export const queueReasonText: Record<WorkflowQueueReason["code"], string> = {
  environment_offline: "Waiting for the selected environment to reconnect.",
  environment_busy: "Waiting for the selected environment to become available.",
  environment_update: "Update the selected environment to support this workflow.",
  workflow_unavailable: "Restore the workflow or cancel this queued job.",
  workflow_changed: "The workflow changed before starting. Preparing its latest saved steps.",
  target_invalid: "Choose a valid checkout in the workflow, then refresh this job.",
  source_unavailable: "Linear is temporarily unavailable. The job will retry automatically.",
  source_rate_limited: "Linear is rate limited. The job will retry after its waiting period.",
  source_reconnect: "The source owner must reconnect Linear before this job can start.",
  source_configuration:
    "Linear service configuration needs attention. Retry after the relay operator repairs it.",
  source_withdrawn:
    "The original repository source permission was withdrawn. Cancel this job; a different grant cannot replace it.",
  source_owner_ineligible:
    "The source owner is no longer in this organization. Restore access or cancel this job.",
  issue_unavailable:
    "The original Linear connection cannot read this issue. Restore issue access or cancel the job.",
  issue_context_invalid:
    "Linear returned incomplete or unsupported issue details. Fix the issue and refresh, or cancel the job.",
  issue_context_too_large:
    "Issue context exceeds 32,000 characters. Shorten the issue description or labels, then refresh this job.",
};
