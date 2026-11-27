import * as Schema from "effect/Schema";
import { RelayThreadVmWorkflowCheckpoint } from "@t3tools/contracts/relay";

const Identifier = Schema.NonEmptyString;
const UUID = Schema.String.check(Schema.isUUID());
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const SourceIdentity = {
  allocationId: Identifier,
  computeRef: Identifier,
  threadId: Identifier,
  generation: PositiveInt,
};
const SourceSeal = {
  environmentId: Identifier,
  provisionOperationId: Schema.Union([
    UUID,
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  ]),
  captureOperationId: UUID,
  bootId: UUID,
  sealEpoch: PositiveInt,
  sourceSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nativeCheckpointOperationId: Schema.NullOr(UUID),
  workflowCheckpoint: Schema.optionalKey(RelayThreadVmWorkflowCheckpoint),
};

/** The exact independently published source point held closed during capture. */
export const ThreadVmCaptureSourceReceipt = Schema.Struct({
  ...SourceIdentity,
  ...SourceSeal,
});
export type ThreadVmCaptureSourceReceipt = typeof ThreadVmCaptureSourceReceipt.Type;

/** Native completion and source identity; this makes no cold-boot or fsck claim. */
export const E2BNativeSnapshotReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native-full-snapshot-v1"),
  operationId: UUID,
  ...SourceIdentity,
  snapshotId: Identifier,
  sourceTemplateId: Identifier,
  sourceBuildId: UUID,
  source: Schema.Struct(SourceSeal),
});
export type E2BNativeSnapshotReceipt = typeof E2BNativeSnapshotReceipt.Type;
