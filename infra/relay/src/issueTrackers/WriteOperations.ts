import {
  RelayIssueTrackerError,
  RelayIssueTrackerTurnPrincipal,
  type RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { linearCredentials, readIssue } from "./Connections.ts";
import { ConnectionStore } from "./ConnectionStore.ts";
import {
  callJiraTool,
  jiraCommentReadRoute,
  listJiraIssueComments,
  listJiraTools,
} from "./Jira.ts";
import { jiraCredentials } from "./JiraAuthorization.ts";
import { callLinearTools, linearToolJson } from "./LinearMcp.ts";
import { authorizeWrite } from "./TurnAuthorization.ts";
import { WriteOperationStore } from "./WriteOperationStore.ts";
import { editPreview, readEditPayload } from "./WriteIssueEdits.ts";

const CommentPayload = Schema.Struct({
  service: Schema.Literals(["jira", "linear"]),
  identifier: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  issueUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  issueId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  retryOfOperationId: Schema.optionalKey(Schema.String),
});
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(CommentPayload));
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(CommentPayload));
const invalid = (message: string) => new RelayIssueTrackerError({ code: "invalid_input", message });
const unavailable = () =>
  new RelayIssueTrackerError({
    code: "unavailable",
    message: "Could not prepare this issue comment. Try again later.",
  });
const digest = (content: string) =>
  Effect.promise(async () => {
    const bytes = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    );
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

/** Prepare a single exact comment under the admitted turn; this does not call a write tool. */
export const prepareComment = Effect.fn("issueTrackers.prepareComment")(function* (input: {
  readonly environmentId: string;
  readonly providerSessionId: string;
  readonly invocationId: string;
  readonly service: RelayIssueTrackerService;
  readonly issue: string;
  readonly body: string;
  readonly retryAfterUnknown?: boolean;
}) {
  const body = input.body;
  if (body.trim().length === 0 || body.length > 20_000)
    return yield* invalid("Enter a comment of at most 20,000 characters.");
  const grant = yield* authorizeWrite(input.environmentId, input.service);
  const claims = yield* RelayIssueTrackerTurnPrincipal;
  const issue = yield* readIssue({
    ownerUserId: grant.ownerUserId,
    connectionVersion: grant.connectionVersion,
    service: input.service,
    issue: input.issue,
  });
  if (issue.url.length > 512 || issue.identifier.length > 256)
    return yield* invalid("This issue link is too long to prepare a comment.");
  const target =
    input.service === "linear" && issue.linear
      ? `${issue.linear.workspaceId}:${issue.linear.issueId}`
      : input.service === "jira"
        ? issue.url
        : null;
  if (!target || target.length > 512) return yield* unavailable();
  const payloadDigest = yield* digest(`${input.service}\n${target}\n${body}`);
  const store = yield* WriteOperationStore;
  const prior = yield* store.findUnknown({
    ownerUserId: grant.ownerUserId,
    service: input.service,
    environmentId: input.environmentId,
    threadId: grant.threadId,
    action: "add_comment",
    target,
    payloadDigest,
  });
  const box = yield* RelaySecretBox;
  if (prior?.state === "outcome_unknown" && prior.resultResourceId && prior.payloadSealed) {
    const previous = yield* box
      .open(prior.payloadSealed)
      .pipe(Effect.flatMap(decodePayload), Effect.mapError(unavailable));
    const confirmed =
      previous.service === input.service &&
      previous.issueUrl === issue.url &&
      previous.identifier === issue.identifier &&
      previous.body === body &&
      (input.service !== "linear" || previous.issueId === issue.linear?.issueId) &&
      (yield* verifyComment({
        service: input.service,
        ownerUserId: grant.ownerUserId,
        ...(previous.issueId ? { issueId: previous.issueId } : {}),
        identifier: previous.identifier,
        commentId: prior.resultResourceId,
        body: previous.body,
      }).pipe(Effect.orElseSucceed(() => false)));
    if (confirmed)
      return {
        operation: yield* store.reconcileVerifiedUnknown(
          prior.operationId,
          prior.resultResourceId,
          {
            ownerUserId: grant.ownerUserId,
            service: input.service,
            environmentId: input.environmentId,
            connectionVersion: grant.connectionVersion,
            writeGeneration: grant.writeGeneration,
          },
        ),
        reused: true,
      };
  }
  if (prior && !input.retryAfterUnknown) return { operation: prior, reused: true };
  if (input.service === "jira" && !(yield* jiraComments(grant.ownerUserId, issue.identifier)))
    return yield* unavailable();
  const payload = yield* encodePayload({
    service: input.service,
    identifier: issue.identifier,
    issueUrl: issue.url,
    ...(input.service === "linear" && issue.linear ? { issueId: issue.linear.issueId } : {}),
    body,
    ...(prior && input.retryAfterUnknown ? { retryOfOperationId: prior.operationId } : {}),
  }).pipe(Effect.mapError(unavailable));
  return yield* store.prepare({
    ownerUserId: grant.ownerUserId,
    service: input.service,
    environmentId: input.environmentId,
    threadId: grant.threadId,
    commandId: grant.commandId,
    providerSessionId: input.providerSessionId,
    invocationId: input.invocationId,
    connectionVersion: grant.connectionVersion,
    writeGeneration: grant.writeGeneration,
    runtimeMode: grant.runtimeMode,
    action: "add_comment",
    target,
    payloadDigest,
    payloadSealed: yield* box.seal(payload).pipe(Effect.mapError(unavailable)),
    baselineSealed: null,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(claims.expiresAt)),
    ...(prior && input.retryAfterUnknown ? { retryOfOperationId: prior.operationId } : {}),
  });
});

const commentId = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const id = result.commentId ?? result.id;
  if (typeof id === "string" && id.length > 0 && id.length <= 256) return id;
  return commentId(result.comment ?? result.data);
};

const commentMatches = (value: unknown, id: string, body: string): boolean => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.id !== id) return false;
  const content = row.body;
  return typeof content === "string" && content === body;
};

const hasComment = (value: unknown, id: string, body: string, depth = 0): boolean => {
  if (depth > 5 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasComment(entry, id, body, depth + 1));
  if (commentMatches(value, id, body)) return true;
  return Object.values(value).some((entry) => hasComment(entry, id, body, depth + 1));
};

const jiraCommentPage = (value: unknown) => {
  const object = (input: unknown): Record<string, unknown> | null =>
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  let page = object(value);
  for (let depth = 0; depth < 3 && page && !Array.isArray(page.comments); depth++)
    page = object(page.data) ?? object(page.result);
  if (!page || !Array.isArray(page.comments) || page.comments.length > 50) return null;
  return {
    comments: page.comments,
    total:
      typeof page.total === "number" && Number.isSafeInteger(page.total) && page.total >= 0
        ? page.total
        : null,
    issueKey: typeof page.issueKey === "string" ? page.issueKey : null,
  };
};

const adfText = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.type !== "doc" || !Array.isArray(doc.content)) return null;
  const paragraphs: string[] = [];
  for (const block of doc.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return null;
    const row = block as Record<string, unknown>;
    if (row.type !== "paragraph" || !Array.isArray(row.content)) return null;
    let paragraph = "";
    for (const node of row.content) {
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const part = node as Record<string, unknown>;
      if (part.type !== "text" || typeof part.text !== "string" || part.marks) return null;
      paragraph += part.text;
    }
    paragraphs.push(paragraph);
  }
  return paragraphs.join("\n\n");
};

const sameComment = (value: unknown, issueKey: string, id: string, body: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (String(row.id) !== id) return false;
  if (
    (typeof row.issueKey === "string" && row.issueKey !== issueKey) ||
    (typeof row.issueIdOrKey === "string" && row.issueIdOrKey !== issueKey)
  )
    return false;
  const content = typeof row.body === "string" ? row.body : adfText(row.body);
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").trimEnd();
  return content !== null && normalize(content) === normalize(body);
};

const jiraComments = Effect.fn("issueTrackers.jiraComments")(function* (
  ownerUserId: string,
  identifier: string,
  commentId?: string,
  body?: string,
) {
  const active = yield* jiraCredentials({ ownerUserId, service: "jira" });
  const route = yield* jiraCommentReadRoute(active.credentials.accessToken);
  const read = (startAt: number, maxResults: number) =>
    listJiraIssueComments({
      accessToken: active.credentials.accessToken,
      cloudId: active.credentials.cloudId,
      issueIdOrKey: identifier,
      route,
      startAt,
      maxResults,
    }).pipe(Effect.map(jiraCommentPage));
  const first = yield* read(0, 1);
  if (!first || (first.issueKey && first.issueKey !== identifier)) return false;
  if (!commentId || body === undefined) return true;
  if (first.comments.some((comment) => sameComment(comment, identifier, commentId, body)))
    return true;
  if (first.total === null) return false;
  let startAt = Math.max(0, first.total - 50);
  for (let page = 0; page < 5; page++) {
    const next = yield* read(startAt, 50);
    if (!next || (next.issueKey && next.issueKey !== identifier)) return false;
    if (next.comments.some((comment) => sameComment(comment, identifier, commentId, body)))
      return true;
    if (startAt === 0) return false;
    startAt = Math.max(0, startAt - 50);
  }
  return false;
});

const verifyComment = Effect.fn("issueTrackers.verifyComment")(function* (input: {
  readonly service: RelayIssueTrackerService;
  readonly ownerUserId: string;
  readonly issueId?: string;
  readonly identifier: string;
  readonly commentId: string;
  readonly body: string;
}) {
  if (input.service === "linear") {
    if (!input.issueId) return false;
    const active = yield* linearCredentials({ ownerUserId: input.ownerUserId, service: "linear" });
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const results = yield* callLinearTools(
        active.credentials.accessToken,
        [
          {
            name: "list_comments",
            arguments: {
              issueId: input.issueId,
              limit: 50,
              orderBy: "createdAt",
              ...(cursor ? { cursor } : {}),
            },
          },
        ],
        active.credentials.oauth.resource,
      );
      const result = yield* linearToolJson(results[0]!);
      if (hasComment(result, input.commentId, input.body)) return true;
      if (!result || typeof result !== "object") return false;
      const list = result as Record<string, unknown>;
      if (
        list.hasNextPage !== true ||
        typeof list.endCursor !== "string" ||
        list.endCursor === cursor
      )
        return false;
      cursor = list.endCursor;
    }
    return false;
  }
  return yield* jiraComments(input.ownerUserId, input.identifier, input.commentId, input.body);
});

/** An operation is claimed before a provider call. Any lost response remains uncertain. */
export const executeComment = Effect.fn("issueTrackers.executeComment")(function* (input: {
  readonly environmentId: string;
  readonly providerSessionId: string;
  readonly operationId: string;
}) {
  const store = yield* WriteOperationStore;
  const operation = yield* store.get(input.operationId);
  if (!operation || operation.action !== "add_comment")
    return yield* invalid("Unknown comment proposal.");
  const grant = yield* authorizeWrite(input.environmentId, operation.service);
  if (
    operation.ownerUserId !== grant.ownerUserId ||
    operation.environmentId !== input.environmentId ||
    operation.threadId !== grant.threadId ||
    operation.connectionVersion !== grant.connectionVersion ||
    operation.writeGeneration !== grant.writeGeneration
  )
    return yield* invalid("This comment proposal belongs to another turn or connection.");
  // A later turn can inspect an uncertain identical request, but must never dispatch it again.
  if (operation.state === "outcome_unknown" || operation.state === "executing")
    return {
      state: "outcome_unknown" as const,
      resourceId: null,
      url: operation.resultUrl ?? null,
    };
  if (
    operation.commandId !== grant.commandId ||
    operation.providerSessionId !== input.providerSessionId
  )
    return yield* invalid("This comment proposal belongs to another turn or connection.");
  if (operation.state === "succeeded" && operation.resultResourceId && operation.resultUrl)
    return {
      state: "succeeded" as const,
      resourceId: operation.resultResourceId,
      url: operation.resultUrl,
    };
  if (operation.state !== "ready" || !operation.payloadSealed)
    return yield* invalid("This comment proposal is awaiting approval or is no longer active.");
  const box = yield* RelaySecretBox;
  const payload = yield* box
    .open(operation.payloadSealed)
    .pipe(Effect.flatMap(decodePayload), Effect.mapError(unavailable));
  if (
    payload.service !== operation.service ||
    (payload.issueUrl !== operation.target && operation.service === "jira")
  )
    return yield* unavailable();
  // Resolve the target again before claiming; a stale or inaccessible issue never reaches the provider.
  const issue = yield* readIssue({
    ownerUserId: grant.ownerUserId,
    connectionVersion: grant.connectionVersion,
    service: operation.service,
    issue: payload.identifier,
  });
  if (
    issue.url !== payload.issueUrl ||
    (operation.service === "linear" && issue.linear?.issueId !== payload.issueId)
  )
    return yield* invalid("The issue changed. Prepare this comment again.");
  if (operation.service === "jira" && !(yield* jiraComments(grant.ownerUserId, payload.identifier)))
    return yield* unavailable();
  const jiraCommentTool =
    operation.service === "jira"
      ? yield* Effect.gen(function* () {
          const active = yield* jiraCredentials({
            ownerUserId: grant.ownerUserId,
            service: "jira",
          });
          const offered = (yield* listJiraTools(active.credentials.accessToken)).tools;
          const selected =
            offered.find((tool) => tool.name === "addOrEditJiraIssueComment") ??
            offered.find((tool) => tool.name === "addCommentToJiraIssue");
          if (selected && selected.inputSchema && typeof selected.inputSchema === "object") {
            const properties = (selected.inputSchema as Record<string, unknown>).properties;
            if (properties && typeof properties === "object") {
              const args = properties as Record<string, unknown>;
              const bodyKey =
                "commentBody" in args ? "commentBody" : "body" in args ? "body" : null;
              if (bodyKey)
                return { name: selected.name, bodyKey, contentFormat: "contentFormat" in args };
            }
          }
          return yield* new RelayIssueTrackerError({
            code: "forbidden",
            message:
              "This Jira connection does not offer a comment write tool. Manage the connection and authorize writes.",
          });
        })
      : null;
  return yield* Effect.acquireUseRelease(
    store.claim(operation.operationId, {
      ownerUserId: grant.ownerUserId,
      service: operation.service,
      connectionVersion: grant.connectionVersion,
      writeGeneration: grant.writeGeneration,
      ...(payload.retryOfOperationId ? { retryOfOperationId: payload.retryOfOperationId } : {}),
    }),
    (claimed) =>
      Effect.gen(function* () {
        if (!claimed.claimFence) return yield* unavailable();
        const attempted = yield* Effect.exit(
          Effect.gen(function* () {
            if (payload.service === "linear") {
              if (!payload.issueId) return yield* unavailable();
              const active = yield* linearCredentials({
                ownerUserId: grant.ownerUserId,
                service: "linear",
              });
              if (
                active.row.version !== grant.connectionVersion ||
                !active.row.writesEnabled ||
                active.row.writeGeneration !== grant.writeGeneration
              )
                return yield* unavailable();
              const results = yield* callLinearTools(
                active.credentials.accessToken,
                [
                  {
                    name: "save_comment",
                    arguments: { issueId: payload.issueId, body: payload.body },
                  },
                ],
                active.credentials.oauth.resource,
                ["save_comment"],
              );
              return yield* linearToolJson(results[0]!);
            }
            const active = yield* jiraCredentials({
              ownerUserId: grant.ownerUserId,
              service: "jira",
            });
            if (
              active.row.version !== grant.connectionVersion ||
              !active.row.writesEnabled ||
              active.row.writeGeneration !== grant.writeGeneration
            )
              return yield* unavailable();
            if (jiraCommentTool)
              return yield* callJiraTool(active.credentials.accessToken, jiraCommentTool.name, {
                cloudId: active.credentials.cloudId,
                issueIdOrKey: payload.identifier,
                [jiraCommentTool.bodyKey]: payload.body,
                ...(jiraCommentTool.contentFormat ? { contentFormat: "markdown" } : {}),
              });
            return yield* unavailable();
          }),
        );
        const id = attempted._tag === "Success" ? commentId(attempted.value) : null;
        if (id) {
          const url = `${payload.issueUrl}?focusedCommentId=${encodeURIComponent(id)}`;
          yield* store.outcomeUnknown(
            operation.operationId,
            claimed.claimFence,
            "Could not confirm whether the comment was posted. Read the issue before trying again.",
            { resourceId: id, url },
          );
          if (
            yield* verifyComment({
              service: operation.service,
              ownerUserId: grant.ownerUserId,
              ...(payload.issueId ? { issueId: payload.issueId } : {}),
              identifier: payload.identifier,
              commentId: id,
              body: payload.body,
            }).pipe(Effect.orElseSucceed(() => false))
          ) {
            yield* store.reconcileUnknown(operation.operationId, id, {
              ownerUserId: grant.ownerUserId,
              service: operation.service,
              connectionVersion: grant.connectionVersion,
              writeGeneration: grant.writeGeneration,
            });
            return { state: "succeeded" as const, resourceId: id, url };
          }
        }
        return { state: "outcome_unknown" as const, resourceId: null, url: payload.issueUrl };
      }),
    (claimed) =>
      claimed.claimFence
        ? store
            .outcomeUnknown(
              operation.operationId,
              claimed.claimFence,
              "Could not confirm whether the comment was posted. Read the issue before trying again.",
            )
            .pipe(Effect.ignore)
        : Effect.void,
  );
});

/** Return only a safe preview; callers must authorize access to the operation first. */
export const presentWriteOperation = Effect.fn("issueTrackers.presentWriteOperation")(function* (
  operation: import("./WriteOperationStore.ts").WriteOperationRecord,
) {
  const box = yield* RelaySecretBox;
  const connections = yield* ConnectionStore;
  const connection = yield* connections.get({
    ownerUserId: operation.ownerUserId,
    service: operation.service,
  });
  const payload =
    operation.action === "add_comment" && operation.payloadSealed
      ? yield* box
          .open(operation.payloadSealed)
          .pipe(Effect.flatMap(decodePayload), Effect.mapError(unavailable))
      : null;
  const edit =
    operation.action === "edit_issue" && operation.payloadSealed
      ? yield* readEditPayload(operation.payloadSealed)
      : null;
  const baseline =
    edit && operation.baselineSealed
      ? yield* box
          .open(operation.baselineSealed)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ value: Schema.NullOr(Schema.String) })),
              ),
            ),
            Effect.mapError(unavailable),
          )
      : null;
  return {
    operationId: operation.operationId,
    state: operation.state,
    service: operation.service,
    action: operation.action as "add_comment" | "edit_issue",
    field: edit?.field ?? null,
    identifier: payload?.identifier ?? edit?.identifier ?? "",
    issueUrl: payload?.issueUrl ?? edit?.issueUrl ?? operation.resultUrl ?? "",
    body:
      payload?.body ?? (edit ? editPreview(edit.field, baseline?.value ?? null, edit.value) : ""),
    executionAccount: connection?.accountLabel ?? "Disconnected account",
    resultResourceId: operation.resultResourceId,
    resultUrl: operation.resultUrl,
    retryWarning: Boolean(payload?.retryOfOperationId ?? edit?.retryOfOperationId),
  };
});
