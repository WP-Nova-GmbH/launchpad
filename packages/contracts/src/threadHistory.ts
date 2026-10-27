import * as Schema from "effect/Schema";

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Digest = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  size: Count,
});
export const ThreadHistoryArchiveOwner = Schema.Struct({
  threadId: Schema.NonEmptyString,
  environmentId: Schema.NonEmptyString,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  operationId: Schema.NonEmptyString,
});
export const ThreadHistoryArchiveManifest = Schema.Struct({
  format: Schema.Literal("launchpad-history-v1"),
  ...ThreadHistoryArchiveOwner.fields,
  sourceSequence: Count,
  eventCount: Count,
  events: Digest,
  receiptCount: Count,
  receipts: Digest,
});
export type ThreadHistoryArchiveManifest = typeof ThreadHistoryArchiveManifest.Type;
