import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadMoveWaitingForAuth = Schema.Literals([
  "account_selection",
  "personal_sign_in",
  "organization_connection",
  "verification",
]);
export type ThreadMoveWaitingForAuth = typeof ThreadMoveWaitingForAuth.Type;
export const ThreadMoveParticipantFailure = Schema.Struct({
  attempt: PositiveInt,
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  reportedAt: IsoDateTime,
});
export const ThreadMoveParticipantState = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  resolvedBeforeAttempt: NonNegativeInt,
  failure: Schema.NullOr(ThreadMoveParticipantFailure),
});
export type ThreadMoveParticipantState = typeof ThreadMoveParticipantState.Type;
export const ThreadMoveFailureDiagnostic = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  ...ThreadMoveParticipantFailure.fields,
  active: Schema.Boolean,
});
export type ThreadMoveFailureDiagnostic = typeof ThreadMoveFailureDiagnostic.Type;

/** Informational only: ownership still comes from the move journal. */
export const ThreadMoveProgressStage = Schema.Literals([
  "capturing",
  "packing",
  "uploading",
  "downloading",
  "installing",
  "setup",
  "activating",
]);
export type ThreadMoveProgressStage = typeof ThreadMoveProgressStage.Type;
export const ThreadMoveProgressReport = Schema.Struct({
  attempt: PositiveInt,
  revision: PositiveInt,
  stage: ThreadMoveProgressStage,
  completedBytes: NonNegativeInt,
  totalBytes: Schema.NullOr(NonNegativeInt),
  completedArtifacts: NonNegativeInt,
  totalArtifacts: Schema.NullOr(NonNegativeInt),
  waitingForAuth: Schema.optionalKey(Schema.NullOr(ThreadMoveWaitingForAuth)),
});
export type ThreadMoveProgressReport = typeof ThreadMoveProgressReport.Type;
export const ThreadMoveProgressSnapshot = Schema.Struct({
  ...ThreadMoveProgressReport.fields,
  operationId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  generation: PositiveInt,
  participant: Schema.Literals(["source", "destination"]),
  updatedAt: IsoDateTime,
});
export type ThreadMoveProgressSnapshot = typeof ThreadMoveProgressSnapshot.Type;
