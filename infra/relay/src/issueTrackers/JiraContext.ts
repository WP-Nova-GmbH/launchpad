import { RelayJiraReferenceRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Source = Schema.Struct({
  organizationId: Id,
  connectionVersion: Id,
  cloudId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  issueId: Id,
});
export type JiraSource = typeof Source.Type;

// Issue-source identity is independent of Atlassian's paging representation.
const Reference = Schema.Struct({
  service: Schema.Literal("jira"),
  kind: Schema.Literal("issue"),
  ...Source.fields,
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Reference));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Reference));
const decodeReference = Schema.decodeUnknownEffect(RelayJiraReferenceRequest.fields.reference);

export const sealJiraSource = Effect.fn("jiraContext.seal_source")(function* (source: JiraSource) {
  const box = yield* RelaySecretBox;
  return yield* encode({ ...source, service: "jira", kind: "issue" }).pipe(
    Effect.flatMap(box.seal),
    Effect.mapError(
      () =>
        new IssueTrackerFailure({
          code: "unavailable",
          message: "Could not prepare Jira discussion context.",
        }),
    ),
  );
});

export const openJiraSource = Effect.fn("jiraContext.open_source")(function* (reference: string) {
  const box = yield* RelaySecretBox;
  return yield* decodeReference(reference).pipe(
    Effect.flatMap(box.open),
    Effect.flatMap(decode),
    Effect.mapError(
      () =>
        new IssueTrackerFailure({
          code: "invalid_input",
          message: "Use an issue source reference returned by a Jira read.",
        }),
    ),
  );
});

/** A source identifies a connection; the caller must still check current issue access. */
export function validateJiraSource(source: JiraSource, active: Omit<JiraSource, "issueId">) {
  return source.organizationId === active.organizationId &&
    source.connectionVersion === active.connectionVersion &&
    source.cloudId === active.cloudId
    ? Effect.void
    : Effect.fail(
        new IssueTrackerFailure({
          code: "conflict",
          message: "The Jira connection changed. Read the issue again for fresh references.",
        }),
      );
}
