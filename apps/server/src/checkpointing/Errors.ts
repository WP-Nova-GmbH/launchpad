import { NonNegativeInt, ThreadId, type VcsError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

/** The computed result does not satisfy the checkpoint RPC contract. */
export class CheckpointDiffResultInvalidError extends Schema.TaggedError<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

/** Projection state no longer contains the requested checkpoint thread. */
export class CheckpointThreadNotFoundError extends Schema.TaggedError<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

/** The checkpoint thread has no workspace path from which to compute a diff. */
export class CheckpointWorkspacePathMissingError extends Schema.TaggedError<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

/** The requested turn lies beyond the latest available checkpoint. */
export class CheckpointTurnRangeUnavailableError extends Schema.TaggedError<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

/** Expected checkpoint metadata does not contain the requested Git ref. */
export class CheckpointRefUnavailableError extends Schema.TaggedError<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

export class CheckpointWorkflowPinUnavailableError extends Schema.TaggedError<CheckpointWorkflowPinUnavailableError>()(
  "CheckpointWorkflowPinUnavailableError",
  {
    threadId: ThreadId,
    turnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return "The saved workflow checkpoint is unavailable. Refresh the run, or cancel it and start again.";
  }
}

export class CheckpointWorkflowDiffRestrictedError extends Schema.TaggedError<CheckpointWorkflowDiffRestrictedError>()(
  "CheckpointWorkflowDiffRestrictedError",
  { reason: Schema.Literals(["contains_secret", "verification_unavailable"]) },
) {
  override get message() {
    return this.reason === "contains_secret"
      ? "This saved diff contains a workflow secret and cannot be displayed. Cancel the run and start again with the secret kept out of tracked files."
      : "Could not check the saved diff for workflow secrets. Refresh the run and try again.";
  }
}

export type CheckpointStoreError = VcsError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointWorkflowPinUnavailableError
  | CheckpointWorkflowDiffRestrictedError
  | CheckpointRefUnavailableError;
