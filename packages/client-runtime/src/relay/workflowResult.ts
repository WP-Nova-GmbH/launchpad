import * as Schema from "effect/Schema";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { WorkflowCheckpoint } from "@t3tools/contracts/workflows";
import type { WorkflowScope } from "./workflowSession.ts";

const ReviewCheckpoint = Schema.Struct({
  checkpointId: Schema.String,
  turnId: Schema.String,
  checkpointTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkflowResultCheckpoint = typeof ReviewCheckpoint.Type;
export interface WorkflowResultOrigin extends WorkflowScope {
  readonly jobId: string;
  readonly threadId: string;
  readonly workflowVmResultReader?: true;
  readonly reviewCheckpoint?: WorkflowResultCheckpoint;
  readonly reviewVisitId?: string;
}
const Origin = Schema.Struct({
  accountId: Schema.String,
  organizationId: Schema.String,
  repositoryId: Schema.String,
  jobId: Schema.String,
  threadId: Schema.String,
  workflowVmResultReader: Schema.optionalKey(Schema.Literal(true)),
  reviewCheckpoint: Schema.optionalKey(ReviewCheckpoint),
  reviewVisitId: Schema.optionalKey(Schema.String),
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

export function workflowResultCheckpoint(
  checkpoint: WorkflowCheckpoint | null | undefined,
): WorkflowResultCheckpoint | undefined {
  if (!checkpoint || checkpoint.kind === "input") return;
  const { checkpointId, turnId, checkpointTurnCount } = checkpoint;
  return { checkpointId, turnId, checkpointTurnCount };
}

export const sameWorkflowResultCheckpoint = (
  left: WorkflowResultCheckpoint,
  right: WorkflowResultCheckpoint,
) =>
  left.checkpointId === right.checkpointId &&
  left.turnId === right.turnId &&
  left.checkpointTurnCount === right.checkpointTurnCount;
