import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationAggregateKind, OrchestrationCommandReceiptStatus } from "./orchestration.ts";
import { CodexConversationManifest } from "./codexConversation.ts";
import { ThreadAttachmentManifest } from "./threadVm.ts";

import { ThreadHistoryArchiveManifest } from "./threadHistory.ts";
export { ThreadHistoryArchiveOwner, ThreadHistoryArchiveManifest } from "./threadHistory.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const WorkspaceFile = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    sha256: Hash,
    size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    executable: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("symlink"), path: Schema.String, target: Schema.String }),
]);
export type WorkspaceFile = typeof WorkspaceFile.Type;

const WorkspaceHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const ObjectId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
const ObjectDigest = Schema.Struct({
  sha256: WorkspaceHash,
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const ThreadWorkspaceManifest = Schema.Struct({
  format: Schema.Literal("launchpad-workspace-v1"),
  threadId: Schema.NonEmptyString,
  objectFormat: Schema.Literals(["sha1", "sha256"]),
  head: ObjectId,
  branch: Schema.NullOr(Schema.NonEmptyString),
  indexTree: ObjectId,
  indexCommit: ObjectId,
  checkpoints: Schema.Array(Schema.Struct({ ref: Schema.NonEmptyString, commit: ObjectId })),
  bundle: ObjectDigest,
  index: ObjectDigest,
  files: Schema.Array(WorkspaceFile),
});
export type ThreadWorkspaceManifest = typeof ThreadWorkspaceManifest.Type;

export const ThreadTransferArchiveManifest = Schema.Struct({
  format: Schema.Literal("launchpad-thread-transfer-v1"),
  history: ThreadHistoryArchiveManifest,
  workspace: ThreadWorkspaceManifest,
  attachments: ThreadAttachmentManifest,
  native: Schema.NullOr(CodexConversationManifest),
});
export type ThreadTransferArchiveManifest = typeof ThreadTransferArchiveManifest.Type;

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  // Null on legacy receipts; rejected bootstrap commands may never have a thread row.
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;
