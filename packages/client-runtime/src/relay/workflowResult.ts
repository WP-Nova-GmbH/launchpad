import * as Schema from "effect/Schema";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { WorkflowScope } from "./workflowSession.ts";

export interface WorkflowResultOrigin extends WorkflowScope {
  readonly jobId: string;
  readonly threadId: string;
}
const Origin = Schema.Struct({
  accountId: Schema.String,
  organizationId: Schema.String,
  repositoryId: Schema.String,
  jobId: Schema.String,
  threadId: Schema.String,
});
const isOrigin = Schema.is(Origin);

/** A move preserves this job link only for the same account and conversation. */
export function workflowResultOrigin(
  value: unknown,
  accountId: string | null | undefined,
  threadId: string | undefined,
): WorkflowResultOrigin | null {
  if (typeof value !== "object" || value === null || !("workflowOrigin" in value)) return null;
  const origin = value.workflowOrigin;
  return isOrigin(origin) && origin.accountId === accountId && origin.threadId === threadId
    ? { ...origin, repositoryId: RelayRepositoryId.make(origin.repositoryId) }
    : null;
}
