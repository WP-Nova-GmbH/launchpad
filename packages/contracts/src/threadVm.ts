import { ThreadHistoryArchiveManifest } from "./threadHistory.ts";
import { CodexConversationManifest } from "./codexConversation.ts";
import { AuthSessionUser } from "./auth.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ChatAttachment,
  OrchestrationEvent,
  ClientOrchestrationCommand,
  ModelSelection,
} from "./orchestration.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Public cold-boot scope installed by the host while the destination disk is stopped. */
export const ThreadVmRestoreBoot = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  ),
  allocationId: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  ),
  threadId: TrimmedNonEmptyString,
  generation: PositiveInt,
});
export type ThreadVmRestoreBoot = typeof ThreadVmRestoreBoot.Type;

export const ThreadVmPolicy = Schema.Struct({
  maxVmsPerUser: NonNegativeInt,
  pauseAfterIdleMinutes: PositiveInt,
  deleteAfterIdleWeekdays: PositiveInt,
  backupIntervalMinutes: PositiveInt,
  savedDiskRetentionDays: PositiveInt,
  calendarTimeZone: Schema.String.check(
    Schema.makeFilter((value) => Option.isSome(DateTime.zoneMakeNamed(value)), {
      message: "Expected an IANA calendar time zone",
    }),
  ),
});
export type ThreadVmPolicy = typeof ThreadVmPolicy.Type;
export const DEFAULT_THREAD_VM_POLICY: ThreadVmPolicy = {
  maxVmsPerUser: 3,
  pauseAfterIdleMinutes: 30,
  deleteAfterIdleWeekdays: 2,
  backupIntervalMinutes: 15,
  savedDiskRetentionDays: 30,
  calendarTimeZone: "UTC",
};
export const ThreadVmPolicyRecord = Schema.Struct({
  organizationId: TrimmedNonEmptyString,
  revision: PositiveInt,
  policy: ThreadVmPolicy,
});
export type ThreadVmPolicyRecord = typeof ThreadVmPolicyRecord.Type;

export const RelayPortableThreadPlacement = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  organizationId: TrimmedNonEmptyString,
  repositoryId: TrimmedNonEmptyString,
  ownerUserId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  generation: PositiveInt,
  operationId: Schema.NullOr(TrimmedNonEmptyString),
});
export type RelayPortableThreadPlacement = typeof RelayPortableThreadPlacement.Type;
export const RelayPortableThreadSummary = Schema.Struct({
  placement: RelayPortableThreadPlacement,
  title: TrimmedNonEmptyString,
  modelSelection: Schema.NullOr(ModelSelection),
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type RelayPortableThreadSummary = typeof RelayPortableThreadSummary.Type;
export const RelayPortableThreadPage = Schema.Struct({
  entries: Schema.Array(RelayPortableThreadSummary),
  next: Schema.NullOr(TrimmedNonEmptyString),
});
export type RelayPortableThreadPage = typeof RelayPortableThreadPage.Type;
export const RelayThreadHistoryPage = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      cursor: PositiveInt,
      environmentId: TrimmedNonEmptyString,
      event: OrchestrationEvent,
    }),
  ),
});
export type RelayThreadHistoryPage = typeof RelayThreadHistoryPage.Type;

export const RelayThreadPersistedReceipt = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), sequence: NonNegativeInt }),
  Schema.Struct({ status: Schema.Literal("rejected"), detail: Schema.optional(Schema.String) }),
]);
export type RelayThreadPersistedReceipt = typeof RelayThreadPersistedReceipt.Type;

export const RelayThreadInboxEntry = Schema.Struct({
  acceptedAt: Schema.optionalKey(IsoDateTime),
  commandId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  position: PositiveInt,
  acceptedGeneration: PositiveInt,
  actor: AuthSessionUser,
  command: ClientOrchestrationCommand,
  receipt: Schema.NullOr(RelayThreadPersistedReceipt),
});
export type RelayThreadInboxEntry = typeof RelayThreadInboxEntry.Type;

/** Pending means durably queued at the relay, not executed by an environment. */
export const RelayThreadCommandReceipt = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  position: PositiveInt,
  receipt: Schema.NullOr(RelayThreadPersistedReceipt),
});
export type RelayThreadCommandReceipt = typeof RelayThreadCommandReceipt.Type;

export const RelayThreadPendingCommandPage = Schema.Struct({
  entries: Schema.Array(RelayThreadCommandReceipt),
  hasMore: Schema.Boolean,
});
export type RelayThreadPendingCommandPage = typeof RelayThreadPendingCommandPage.Type;

/** The relay keeps the chunk objects opaque; the destination verifies this manifest. */
export const ThreadTransferChunkManifest = Schema.Struct({
  format: Schema.Literal("launchpad-thread-chunks-v1"),
  threadId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  sourceEnvironmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  transferManifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      sizeBytes: NonNegativeInt,
      chunks: Schema.Array(
        Schema.Struct({
          artifactId: Schema.String.check(Schema.isUUID()),
          sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
          sizeBytes: PositiveInt,
        }),
      ),
    }),
  ),
});
export type ThreadTransferChunkManifest = typeof ThreadTransferChunkManifest.Type;

/** A whole native checkpoint is retained independently of its VM disk. */
export const ThreadNativeCheckpointArchiveManifest = Schema.Struct({
  format: Schema.Literal("launchpad-native-checkpoint-v1"),
  threadId: TrimmedNonEmptyString,
  operationId: Schema.String.check(Schema.isUUID()),
  turnId: TrimmedNonEmptyString,
  captureOperationId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
  sourceEnvironmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  sourceSequence: NonNegativeInt,
  nativeManifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  archiveSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  native: CodexConversationManifest,
  recoveryHistory: Schema.optionalKey(ThreadHistoryArchiveManifest),
  directories: Schema.Array(Schema.Literals(["files", "native-rollouts"])).check(
    Schema.isMaxLength(2),
  ),
});
export type ThreadNativeCheckpointArchiveManifest =
  typeof ThreadNativeCheckpointArchiveManifest.Type;

/** An immutable publication receipt is useful only while its catalog pin set remains retained. */
export const ThreadNativeCheckpointPublicationReceipt = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  operationId: Schema.String.check(Schema.isUUID()),
  turnId: TrimmedNonEmptyString,
  captureOperationId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
  sourceEnvironmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  sourceSequence: NonNegativeInt,
  nativeThreadId: CodexConversationManifest.fields.threadId,
  recoveryHistory: Schema.optionalKey(Schema.NullOr(ThreadHistoryArchiveManifest)),
  nativeManifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  archiveSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  manifestArtifactId: Schema.String.check(Schema.isUUID()),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type ThreadNativeCheckpointPublicationReceipt =
  typeof ThreadNativeCheckpointPublicationReceipt.Type;

/** Independently retained chat attachments, including queued and historical references. */
export const ThreadAttachmentManifest = Schema.Struct({
  format: Schema.Literal("launchpad-attachments-v1"),
  threadId: Schema.NonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      attachment: ChatAttachment,
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    }),
  ),
});
export type ThreadAttachmentManifest = typeof ThreadAttachmentManifest.Type;
export const THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES = 1024;
export const THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES = 512 * 1024 * 1024;
export const ThreadAttachmentCheckpointArchiveManifest = Schema.Struct({
  format: Schema.Literal("launchpad-attachment-checkpoint-v1"),
  threadId: TrimmedNonEmptyString,
  operationId: Schema.String.check(Schema.isUUID()),
  turnId: TrimmedNonEmptyString,
  captureOperationId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
  sourceEnvironmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  sourceSequence: NonNegativeInt,
  nativeArchiveSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  attachmentManifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  attachments: ThreadAttachmentManifest,
});
export type ThreadAttachmentCheckpointArchiveManifest =
  typeof ThreadAttachmentCheckpointArchiveManifest.Type;
export const ThreadAttachmentCheckpointPublicationReceipt = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  operationId: Schema.String.check(Schema.isUUID()),
  turnId: TrimmedNonEmptyString,
  captureOperationId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
  sourceEnvironmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  sourceSequence: NonNegativeInt,
  nativeArchiveSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  attachmentManifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  manifestArtifactId: Schema.String.check(Schema.isUUID()),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type ThreadAttachmentCheckpointPublicationReceipt =
  typeof ThreadAttachmentCheckpointPublicationReceipt.Type;
