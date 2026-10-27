import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
