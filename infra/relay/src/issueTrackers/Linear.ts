import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueDetails, IssueTrackerFailure } from "./IssueTrackerModels.ts";
import { callLinearTools, linearToolJson } from "./LinearMcp.ts";
import { normalizeLinearMarkdown } from "./LinearMarkdown.ts";
import type { LinearResource } from "./LinearOAuth.ts";

const MAX_DESCRIPTION_LENGTH = 20_000;
const Identifier = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*-[1-9]\d*$/),
);
const Label = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const StableId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.Struct({ id: StableId, name: Label, url: Schema.String }),
);
const decodeUser = Schema.decodeUnknownEffect(Schema.Struct({ id: StableId, name: Label }));
const decodeIssue = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Identifier,
    uuid: StableId,
    title: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    url: Schema.String.check(Schema.isMaxLength(4096)),
    status: Schema.optionalKey(Schema.NullOr(Label)),
    assignee: Schema.optionalKey(Schema.NullOr(Label)),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeIdentifier = Schema.decodeUnknownEffect(Identifier);
const decodeIssueDetails = Schema.decodeUnknownEffect(IssueDetails);
const unavailable = () =>
  new IssueTrackerFailure({
    code: "unavailable",
    message: "Linear could not complete the request.",
  });
const isFailure = Schema.is(IssueTrackerFailure);
const safeFailure = (error: unknown) => (isFailure(error) ? error : unavailable());
const forbidden = () =>
  new IssueTrackerFailure({
    code: "forbidden",
    message: "This Linear connection cannot access the requested workspace or issue.",
  });
const invalidIssue = () =>
  new IssueTrackerFailure({
    code: "invalid_input",
    message: "Enter a Linear issue identifier or an issue URL from the connected workspace.",
  });
const workspaceSlug = (value: string) => {
  const url = URL.parse(value);
  return url?.origin === "https://linear.app" &&
    !url.username &&
    !url.password &&
    /^\/[^/]+\/?$/.test(url.pathname)
    ? url.pathname.split("/")[1]
    : undefined;
};
export const getLinearIdentity = Effect.fn("relay.linear.get_identity")(function* (input: {
  readonly accessToken: string;
  readonly resource?: LinearResource | undefined;
}) {
  const results = yield* callLinearTools(
    input.accessToken,
    [
      { name: "get_workspace", arguments: {} },
      { name: "get_user", arguments: { query: "me" } },
    ],
    input.resource,
  );
  const workspace = yield* linearToolJson(results[0]!).pipe(
    Effect.flatMap(decodeWorkspace),
    Effect.mapError(safeFailure),
  );
  const user = yield* linearToolJson(results[1]!).pipe(
    Effect.flatMap(decodeUser),
    Effect.mapError(safeFailure),
  );
  const slug = workspaceSlug(workspace.url);
  if (!slug) return yield* unavailable();
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: slug,
    accountId: user.id,
    accountLabel: `${workspace.name} · ${user.name}`,
  };
});

const issueIdentifier = Effect.fn("relay.linear.issue_identifier")(function* (
  issue: string,
  workspaceSlug: string,
) {
  const value = issue.trim();
  let identifier = value;
  if (value.includes(":")) {
    const url = yield* Effect.try({ try: () => new URL(value), catch: invalidIssue });
    const match = /^\/([^/]+)\/issue\/([^/]+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
    if (
      url.origin !== "https://linear.app" ||
      url.username ||
      url.password ||
      !match ||
      match[1] !== workspaceSlug
    )
      return yield* invalidIssue();
    identifier = match[2] ?? "";
  }
  return yield* decodeIdentifier(identifier).pipe(
    Effect.map((id) => id.toUpperCase()),
    Effect.mapError(invalidIssue),
  );
});

export const readLinearIssue = Effect.fn("relay.linear.read_issue")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly issue: string;
  readonly issueId?: string;
  readonly resource?: LinearResource | undefined;
}) {
  const identifier = input.issueId ?? (yield* issueIdentifier(input.issue, input.workspaceSlug));
  const results = yield* callLinearTools(
    input.accessToken,
    [
      { name: "get_workspace", arguments: {} },
      { name: "get_issue", arguments: { id: identifier } },
    ],
    input.resource,
  );
  const workspace = yield* linearToolJson(results[0]!).pipe(
    Effect.flatMap(decodeWorkspace),
    Effect.mapError(safeFailure),
  );
  if (workspace.id !== input.workspaceId || workspaceSlug(workspace.url) !== input.workspaceSlug)
    return yield* forbidden();
  const raw = yield* linearToolJson(results[1]!).pipe(
    Effect.flatMap(decodeIssue),
    Effect.mapError(safeFailure),
  );
  const issue = { ...raw, id: raw.uuid, identifier: raw.id };
  const returnedIdentifier = yield* issueIdentifier(issue.url, input.workspaceSlug).pipe(
    Effect.mapError(unavailable),
  );
  if (
    input.issueId
      ? issue.id !== input.issueId || returnedIdentifier !== issue.identifier.toUpperCase()
      : issue.identifier.toUpperCase() !== identifier || returnedIdentifier !== identifier
  )
    return yield* unavailable();
  const description = normalizeLinearMarkdown(issue.description ?? "");
  const details = yield* decodeIssueDetails({
    identifier: issue.identifier,
    title: issue.title,
    description:
      description.length > MAX_DESCRIPTION_LENGTH
        ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}\n\n[Description truncated by Launchpad. Open the issue for the full text.]`
        : description,
    url: issue.url,
    status: issue.status ?? null,
    assignee: issue.assignee ?? null,
  }).pipe(Effect.mapError(safeFailure));
  const result = { ...details, issueId: issue.id };
  const notice = "\n\n[Description truncated by Launchpad. Open the issue for the full text.]";
  let shortened = result.description;
  while (new TextEncoder().encode(encodeJson(result)).byteLength > 48 * 1024) {
    if (shortened.length === 0)
      return yield* new IssueTrackerFailure({
        code: "unavailable",
        message: "Linear issue metadata exceeded the response size limit.",
      });
    shortened = shortened.slice(0, Math.floor(shortened.length / 2));
    result.description = shortened + notice;
  }
  return { ...result, originalDescription: description };
});

const SearchPage = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      id: Identifier,
      uuid: StableId,
      title: Schema.String.check(Schema.isMaxLength(4096)),
      url: Schema.String.check(Schema.isMaxLength(4096)),
      status: Schema.optionalKey(Schema.NullOr(Label)),
      assignee: Schema.optionalKey(Schema.NullOr(Label)),
      project: Schema.optionalKey(Schema.NullOr(Label)),
      team: Schema.optionalKey(Schema.NullOr(Label)),
    }),
  ),
  hasNextPage: Schema.Boolean,
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
  endCursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
});
const decodeSearchPage = Schema.decodeUnknownEffect(SearchPage);

export const searchLinearIssues = Effect.fn("relay.linear.search_issues")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly query?: string;
  readonly team?: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly project?: string;
  readonly cursor?: string;
  readonly resource?: LinearResource | undefined;
}) {
  const results = yield* callLinearTools(
    input.accessToken,
    [
      { name: "get_workspace", arguments: {} },
      {
        name: "list_issues",
        arguments: {
          limit: 20,
          fields: ["id", "uuid", "title", "url", "status", "assignee", "project", "team"],
          ...(input.query ? { query: input.query } : {}),
          ...(input.team ? { team: input.team } : {}),
          ...(input.status ? { state: input.status } : {}),
          ...(input.assignee ? { assignee: input.assignee } : {}),
          ...(input.project ? { project: input.project } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      },
    ],
    input.resource,
  );
  const workspace = yield* linearToolJson(results[0]!).pipe(
    Effect.flatMap(decodeWorkspace),
    Effect.mapError(safeFailure),
  );
  if (workspace.id !== input.workspaceId || workspaceSlug(workspace.url) !== input.workspaceSlug)
    return yield* forbidden();
  const page = yield* linearToolJson(results[1]!).pipe(
    Effect.flatMap(decodeSearchPage),
    Effect.mapError(safeFailure),
  );
  const nextCursor = page.cursor ?? page.endCursor ?? null;
  if (page.issues.length > 20 || (page.hasNextPage && (!nextCursor || nextCursor === input.cursor)))
    return yield* unavailable();
  const issues = yield* Effect.forEach(page.issues, (item) =>
    Effect.gen(function* () {
      const key = yield* issueIdentifier(item.url, input.workspaceSlug).pipe(
        Effect.mapError(unavailable),
      );
      if (key !== item.id.toUpperCase()) return yield* unavailable();
      return {
        id: item.uuid,
        identifier: item.id,
        title: item.title.slice(0, 512),
        url: item.url,
        status: item.status?.slice(0, 128) ?? null,
        assignee: item.assignee?.slice(0, 128) ?? null,
        project: item.project?.slice(0, 128) ?? null,
        team: item.team?.slice(0, 128) ?? null,
      };
    }),
  );
  return { issues, cursor: page.hasNextPage ? nextCursor! : null };
});
