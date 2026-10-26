import type { RelayIssueTrackerService, RelaySearchIssuesRequest } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

const Filters = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
});
export type SearchFilters = typeof Filters.Type;
const Reference = Schema.Struct({
  purpose: Schema.Literal("issue-search-v1"),
  ownerUserId: Schema.String,
  service: Schema.Literals(["jira", "linear"]),
  connectionVersion: Schema.String,
  filters: Filters,
  cursor: Schema.String,
  expiresAt: Schema.Number,
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Reference));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Reference));
const invalid = () =>
  new IssueTrackerFailure({
    code: "invalid_input",
    message: "Start a new issue search or use its unchanged continuation reference.",
  });
const conflict = () =>
  new IssueTrackerFailure({
    code: "conflict",
    message: "This connection changed. Start the issue search again.",
  });

export const searchInput = Effect.fn("issueSearch.input")(function* (input: {
  readonly ownerUserId: string;
  readonly service: RelayIssueTrackerService;
  readonly connectionVersion: string;
  readonly request: RelaySearchIssuesRequest;
}) {
  if (input.request.continuation) {
    if (Object.keys(input.request).some((key) => key !== "continuation")) return yield* invalid();
    const box = yield* RelaySecretBox;
    const reference = yield* box
      .open(input.request.continuation)
      .pipe(Effect.flatMap(decode), Effect.mapError(invalid));
    if (reference.ownerUserId !== input.ownerUserId || reference.service !== input.service)
      return yield* invalid();
    if (reference.connectionVersion !== input.connectionVersion) return yield* conflict();
    if (reference.expiresAt <= DateTime.toEpochMillis(yield* DateTime.now)) return yield* invalid();
    return { filters: reference.filters, cursor: reference.cursor };
  }
  const filters: SearchFilters = {
    ...(input.request.query?.trim() ? { query: input.request.query.trim() } : {}),
    ...(input.request.project ? { project: input.request.project.trim() } : {}),
    ...(input.request.team ? { team: input.request.team.trim() } : {}),
    ...(input.request.status ? { status: input.request.status.trim() } : {}),
    ...(input.request.assignee ? { assignee: input.request.assignee.trim() } : {}),
  };
  if (Object.keys(filters).length === 0) return yield* invalid();
  return { filters, cursor: undefined };
});

export const sealSearchCursor = Effect.fn("issueSearch.sealCursor")(function* (input: {
  readonly ownerUserId: string;
  readonly service: RelayIssueTrackerService;
  readonly connectionVersion: string;
  readonly filters: SearchFilters;
  readonly cursor: string | null;
}) {
  if (!input.cursor) return null;
  const box = yield* RelaySecretBox;
  return yield* encode({
    purpose: "issue-search-v1",
    ...input,
    cursor: input.cursor,
    expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 15 * 60_000,
  }).pipe(
    Effect.flatMap(box.seal),
    Effect.mapError(() => invalid()),
  );
});
