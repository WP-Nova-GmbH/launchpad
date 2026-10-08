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
import { jiraCredentials } from "./JiraAuthorization.ts";
import { callJiraTool, listJiraTools } from "./Jira.ts";
import { callLinearTools, linearToolJson } from "./LinearMcp.ts";
import { authorizeWrite } from "./TurnAuthorization.ts";
import { WriteOperationStore } from "./WriteOperationStore.ts";

export type IssueEditField = "title" | "description" | "status" | "assignee";
const EditPayload = Schema.Struct({
  service: Schema.Literals(["jira", "linear"]),
  identifier: Schema.String,
  issueUrl: Schema.String,
  issueId: Schema.optionalKey(Schema.String),
  retryOfOperationId: Schema.optionalKey(Schema.String),
  field: Schema.Literals(["title", "description", "status", "assignee"]),
  value: Schema.NullOr(Schema.String),
  providerValue: Schema.NullOr(Schema.String),
  expectedValue: Schema.NullOr(Schema.String),
});
const Baseline = Schema.Struct({ value: Schema.NullOr(Schema.String) });
const encode = Schema.encodeEffect(Schema.fromJsonString(EditPayload));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(EditPayload));
const encodeBaseline = Schema.encodeEffect(Schema.fromJsonString(Baseline));
const decodeBaseline = Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline));
const error = (code: RelayIssueTrackerError["code"], message: string) =>
  new RelayIssueTrackerError({ code, message });
const unavailable = () =>
  error("unavailable", "Could not complete this issue change. Read the issue before retrying.");
const digest = (content: string) =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );

const entries = (value: unknown, depth = 0): Record<string, unknown>[] => {
  if (depth > 5 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((part) => entries(part, depth + 1));
  const row = value as Record<string, unknown>;
  return [row, ...Object.values(row).flatMap((part) => entries(part, depth + 1))];
};
const unique = <T>(items: readonly T[], key: (item: T) => string) => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

const resolveJiraTransition = Effect.fn("issueTrackers.resolveJiraTransition")(function* (
  ownerUserId: string,
  issue: string,
  status: string,
) {
  const active = yield* jiraCredentials({ ownerUserId, service: "jira" });
  const tools = yield* listJiraTools(active.credentials.accessToken);
  const name = tools.tools.some((tool) => tool.name === "listJiraIssueTransitions")
    ? "listJiraIssueTransitions"
    : "getTransitionsForJiraIssue";
  if (!tools.tools.some((tool) => tool.name === name))
    return yield* error("forbidden", "This Jira connection cannot list workflow transitions.");
  const result = yield* callJiraTool(active.credentials.accessToken, name, {
    cloudId: active.credentials.cloudId,
    issueIdOrKey: issue,
  });
  const matches = unique(
    entries(result).flatMap((row) => {
      const destination =
        row.to && typeof row.to === "object" ? (row.to as Record<string, unknown>).name : undefined;
      return typeof row.id === "string" && (row.name === status || destination === status)
        ? [{ id: row.id, name: typeof destination === "string" ? destination : status }]
        : [];
    }),
    (item) => item.id,
  );
  if (matches.length !== 1)
    return yield* error(
      "invalid_input",
      "Choose one available Jira transition by its exact destination status.",
    );
  return matches[0]!;
});

const resolveAssignee = Effect.fn("issueTrackers.resolveAssignee")(function* (
  service: RelayIssueTrackerService,
  ownerUserId: string,
  query: string,
) {
  if (service === "linear") {
    const active = yield* linearCredentials({ ownerUserId, service: "linear" });
    if (query.toLowerCase() === "me") {
      const results = yield* callLinearTools(
        active.credentials.accessToken,
        [{ name: "get_user", arguments: { query: "me" } }],
        active.credentials.oauth.resource,
      );
      const value = yield* linearToolJson(results[0]!);
      const person = entries(value).find(
        (row) => typeof row.id === "string" && typeof row.name === "string",
      );
      if (!person) return yield* error("unavailable", "Could not resolve your Linear account.");
      return { id: person.id as string, name: person.name as string };
    }
    const results = yield* callLinearTools(
      active.credentials.accessToken,
      [{ name: "list_users", arguments: { query, limit: 50 } }],
      active.credentials.oauth.resource,
    );
    const value = yield* linearToolJson(results[0]!);
    if (entries(value).some((row) => row.hasNextPage === true))
      return yield* error("invalid_input", "Use a more specific Linear assignee name or email.");
    const matches = unique(
      entries(value).flatMap((row) =>
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        [row.id, row.name, row.email].some(
          (candidate) =>
            typeof candidate === "string" && candidate.toLowerCase() === query.toLowerCase(),
        )
          ? [{ id: row.id, name: row.name }]
          : [],
      ),
      (item) => item.id,
    );
    if (matches.length !== 1)
      return yield* error(
        "invalid_input",
        "Choose one Linear assignee by exact name, email, or ID.",
      );
    return matches[0]!;
  }
  const active = yield* jiraCredentials({ ownerUserId, service: "jira" });
  const value = yield* callJiraTool(active.credentials.accessToken, "lookupJiraAccountId", {
    cloudId: active.credentials.cloudId,
    searchString: query,
  });
  const matches = unique(
    entries(value).flatMap((row) =>
      typeof row.accountId === "string" &&
      typeof row.displayName === "string" &&
      [row.accountId, row.displayName, row.emailAddress].some(
        (candidate) =>
          typeof candidate === "string" && candidate.toLowerCase() === query.toLowerCase(),
      )
        ? [{ id: row.accountId, name: row.displayName }]
        : [],
    ),
    (item) => item.id,
  );
  if (matches.length !== 1)
    return yield* error(
      "invalid_input",
      "Choose one Jira assignee by exact name, email, or account ID.",
    );
  return matches[0]!;
});

export const editPreview = (field: IssueEditField, before: string | null, after: string | null) =>
  `${field}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`;

export const readEditPayload = Effect.fn("issueTrackers.readEditPayload")(function* (
  sealed: string,
) {
  const box = yield* RelaySecretBox;
  return yield* box.open(sealed).pipe(Effect.flatMap(decode), Effect.mapError(unavailable));
});

export const prepareEdit = Effect.fn("issueTrackers.prepareEdit")(function* (input: {
  readonly environmentId: string;
  readonly providerSessionId: string;
  readonly invocationId: string;
  readonly service: RelayIssueTrackerService;
  readonly issue: string;
  readonly field: IssueEditField;
  readonly value: string | null;
  readonly retryAfterUnknown?: boolean;
}) {
  if (input.service === "jira" && input.field === "description")
    return yield* error(
      "invalid_input",
      "Jira descriptions cannot be safely replaced through this connection.",
    );
  if (input.value !== null && input.value.length > 20_000)
    return yield* error("invalid_input", "The replacement value is too long.");
  if (input.field !== "assignee" && input.value === null)
    return yield* error("invalid_input", "Only an assignee can be removed with null.");
  if (input.field !== "description" && input.value !== null && !input.value.trim())
    return yield* error("invalid_input", "Enter a non-empty replacement value.");
  const grant = yield* authorizeWrite(input.environmentId, input.service);
  const claims = yield* RelayIssueTrackerTurnPrincipal;
  const issue = yield* readIssue({
    ownerUserId: grant.ownerUserId,
    connectionVersion: grant.connectionVersion,
    service: input.service,
    issue: input.issue,
  });
  if (issue.url.length > 512 || issue.identifier.length > 256)
    return yield* error("invalid_input", "The issue link is too long.");
  if (input.service === "linear" && !issue.linear)
    return yield* error("unavailable", "Could not verify this Linear issue's identity.");
  const target =
    input.service === "linear" && issue.linear
      ? `${issue.linear.workspaceId}:${issue.linear.issueId}`
      : issue.url;
  const payloadDigest = yield* digest(
    [input.service, issue.url, input.field, input.value]
      .map((part) => (part === null ? "-1:" : `${part.length}:${part}`))
      .join(""),
  );
  const box = yield* RelaySecretBox;
  const store = yield* WriteOperationStore;
  const unknown = yield* store.findUnknown({
    ownerUserId: grant.ownerUserId,
    service: input.service,
    environmentId: input.environmentId,
    threadId: grant.threadId,
    action: "edit_issue",
    target,
    payloadDigest,
  });
  if (unknown?.state === "outcome_unknown") {
    if (unknown.resultResourceId && unknown.payloadSealed && unknown.resultUrl === issue.url) {
      const previous = yield* readEditPayload(unknown.payloadSealed);
      if (
        previous.identifier === issue.identifier &&
        previous.issueUrl === issue.url &&
        (input.service !== "linear" || previous.issueId === issue.linear?.issueId) &&
        issue[previous.field] === previous.expectedValue
      )
        return {
          operation: yield* store.reconcileVerifiedUnknown(
            unknown.operationId,
            unknown.resultResourceId,
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
  }
  if (unknown && !input.retryAfterUnknown) return { operation: unknown, reused: true };
  const before = issue[input.field];
  if (before === input.value)
    return yield* error("invalid_input", "The requested field already has this value.");
  if (
    input.field === "description" &&
    issue.description.includes("[Description truncated by Launchpad")
  )
    return yield* error("invalid_input", "Open this issue to edit its full description safely.");
  let providerValue = input.value;
  let expectedValue = input.value;
  if (input.field === "status" && input.service === "jira") {
    const transition = yield* resolveJiraTransition(
      grant.ownerUserId,
      issue.identifier,
      input.value!,
    );
    providerValue = transition.id;
    expectedValue = transition.name;
  }
  if (input.field === "assignee" && input.value !== null) {
    const assignee = yield* resolveAssignee(input.service, grant.ownerUserId, input.value);
    providerValue = assignee.id;
    expectedValue = assignee.name;
  }
  const payload = yield* encode({
    service: input.service,
    identifier: issue.identifier,
    issueUrl: issue.url,
    ...(issue.linear ? { issueId: issue.linear.issueId } : {}),
    ...(unknown && input.retryAfterUnknown ? { retryOfOperationId: unknown.operationId } : {}),
    field: input.field,
    value: input.value,
    providerValue,
    expectedValue,
  }).pipe(Effect.mapError(unavailable));
  const baseline = yield* encodeBaseline({ value: before }).pipe(Effect.mapError(unavailable));
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
    action: "edit_issue",
    target,
    payloadDigest,
    payloadSealed: yield* box.seal(payload).pipe(Effect.mapError(unavailable)),
    baselineSealed: yield* box.seal(baseline).pipe(Effect.mapError(unavailable)),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(claims.expiresAt)),
    ...(unknown && input.retryAfterUnknown ? { retryOfOperationId: unknown.operationId } : {}),
  });
});

export const executeEdit = Effect.fn("issueTrackers.executeEdit")(function* (input: {
  readonly environmentId: string;
  readonly providerSessionId: string;
  readonly operationId: string;
}) {
  const store = yield* WriteOperationStore;
  const operation = yield* store.get(input.operationId);
  if (!operation || operation.action !== "edit_issue")
    return yield* error("invalid_input", "Unknown issue edit.");
  const grant = yield* authorizeWrite(input.environmentId, operation.service);
  if (
    operation.ownerUserId !== grant.ownerUserId ||
    operation.environmentId !== input.environmentId ||
    operation.threadId !== grant.threadId ||
    operation.connectionVersion !== grant.connectionVersion ||
    operation.writeGeneration !== grant.writeGeneration
  )
    return yield* error("invalid_input", "This issue edit belongs to another turn or connection.");
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
    return yield* error("invalid_input", "This issue edit belongs to another turn or connection.");
  if (operation.state === "succeeded" && operation.resultResourceId && operation.resultUrl)
    return {
      state: "succeeded" as const,
      resourceId: operation.resultResourceId,
      url: operation.resultUrl,
    };
  if (operation.state !== "ready" || !operation.payloadSealed || !operation.baselineSealed)
    return yield* error(
      "invalid_input",
      "This issue edit is awaiting approval or is no longer active.",
    );
  const payload = yield* readEditPayload(operation.payloadSealed);
  if (operation.service === "jira" && payload.field === "description")
    return yield* error(
      "invalid_input",
      "Jira descriptions cannot be safely replaced through this connection.",
    );
  const box = yield* RelaySecretBox;
  const baseline = yield* box
    .open(operation.baselineSealed)
    .pipe(Effect.flatMap(decodeBaseline), Effect.mapError(unavailable));
  const issue = yield* readIssue({
    ownerUserId: grant.ownerUserId,
    connectionVersion: grant.connectionVersion,
    service: operation.service,
    issue: payload.identifier,
  });
  if (
    issue.url !== payload.issueUrl ||
    issue[payload.field] !== baseline.value ||
    (operation.service === "linear" && issue.linear?.issueId !== payload.issueId)
  )
    return yield* error("conflict", "The issue changed. Read it and prepare this edit again.");
  if (operation.service === "jira" && payload.field === "status") {
    const current = yield* resolveJiraTransition(
      grant.ownerUserId,
      payload.identifier,
      payload.value!,
    );
    if (current.id !== payload.providerValue)
      return yield* error("conflict", "The Jira workflow changed. Prepare this edit again.");
  }
  const jiraTool =
    operation.service === "jira"
      ? yield* Effect.gen(function* () {
          const active = yield* jiraCredentials({
            ownerUserId: grant.ownerUserId,
            service: "jira",
          });
          const name = payload.field === "status" ? "transitionJiraIssue" : "editJiraIssue";
          const offered = yield* listJiraTools(active.credentials.accessToken);
          if (!offered.tools.some((tool) => tool.name === name))
            return yield* error("forbidden", `This Jira connection does not offer ${name}.`);
          return name;
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
            if (operation.service === "linear") {
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
              const result = yield* callLinearTools(
                active.credentials.accessToken,
                [
                  {
                    name: "save_issue",
                    arguments: {
                      id: payload.issueId!,
                      [payload.field === "status" ? "state" : payload.field]: payload.providerValue,
                    },
                  },
                ],
                active.credentials.oauth.resource,
                ["save_issue"],
              );
              return yield* linearToolJson(result[0]!);
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
            const base = { cloudId: active.credentials.cloudId, issueIdOrKey: payload.identifier };
            if (jiraTool === "transitionJiraIssue")
              return yield* callJiraTool(active.credentials.accessToken, jiraTool, {
                ...base,
                transition: { id: payload.providerValue },
              });
            const field = payload.field === "title" ? "summary" : payload.field;
            return yield* callJiraTool(active.credentials.accessToken, "editJiraIssue", {
              ...base,
              fields: {
                [field]:
                  payload.field === "assignee" && payload.providerValue
                    ? { accountId: payload.providerValue }
                    : payload.providerValue,
              },
            });
          }),
        );
        if (attempted._tag === "Success") {
          yield* store.outcomeUnknown(
            operation.operationId,
            claimed.claimFence,
            "Could not confirm whether the issue changed. Read the issue before trying again.",
            { resourceId: payload.identifier, url: payload.issueUrl },
          );
          const readBack = yield* Effect.exit(
            readIssue({
              ownerUserId: grant.ownerUserId,
              connectionVersion: grant.connectionVersion,
              service: operation.service,
              issue: payload.identifier,
            }),
          );
          if (
            readBack._tag === "Success" &&
            readBack.value.url === payload.issueUrl &&
            (operation.service !== "linear" ||
              readBack.value.linear?.issueId === payload.issueId) &&
            readBack.value[payload.field] === payload.expectedValue
          ) {
            yield* store.reconcileUnknown(operation.operationId, payload.identifier, {
              ownerUserId: grant.ownerUserId,
              service: operation.service,
              connectionVersion: grant.connectionVersion,
              writeGeneration: grant.writeGeneration,
            });
            return {
              state: "succeeded" as const,
              resourceId: payload.identifier,
              url: payload.issueUrl,
            };
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
              "Could not confirm whether the issue changed. Read the issue before trying again.",
            )
            .pipe(Effect.ignore)
        : Effect.void,
  );
});
