import {
  RELAY_LINEAR_CALLBACK_PATH,
  RelayIssueTrackerError,
  type RelayIssueTrackerService,
  type RelayIssueDetails,
  type RelayLinearDiscussion,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayConfiguration } from "../Config.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import {
  ConnectionStore,
  metadata,
  type ConnectionKey,
  type ConnectionRecord,
} from "./ConnectionStore.ts";
import {
  linearDiscussion,
  linearImageReferences,
  openLinearReference,
  sealLinearReference,
  validateLinearSource,
  type LinearReference,
  type LinearSource,
} from "./LinearContext.ts";
import {
  fetchLinearImage,
  ISSUE_RESPONSE_BYTES,
  linearImageUrls,
  readLinearCommentBody,
  utf8Bytes,
} from "./LinearDiscussion.ts";
import { readJiraIssue } from "./Jira.ts";
import { JiraOAuthCredentials, jiraCredentials } from "./JiraAuthorization.ts";
import { fitJiraIssueResponse } from "./JiraDiscussion.ts";
import {
  exchangeLinearCode,
  getLinearIdentity,
  linearAuthorizationUrl,
  readLinearIssue,
  refreshLinearTokens,
} from "./Linear.ts";

export const LINEAR_CALLBACK_PATH = RELAY_LINEAR_CALLBACK_PATH;

const Credentials = Schema.Union([
  JiraOAuthCredentials,
  Schema.Struct({
    service: Schema.Literal("linear"),
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    workspaceId: Schema.String,
    workspaceSlug: Schema.String,
    generation: Schema.optionalKey(Schema.String),
  }),
]);
type Credentials = typeof Credentials.Type;
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Credentials));
const isTrackerFailure = Schema.is(RelayIssueTrackerError);
const failure = (code: RelayIssueTrackerError["code"], message: string) =>
  new RelayIssueTrackerError({ code, message });
const conflict = () =>
  failure("conflict", "This connection changed. Start again from Organization settings.");
const milliseconds = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
// Leave time for cleanup and a typed response before the relay's 9-second deadline.
const boundedOperation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        Effect.fail(
          failure("unavailable", "The issue tracker took too long to respond. Try again."),
        ),
    }),
  );

const seal = Effect.fn("issueTrackers.seal")(function* (credentials: Credentials) {
  const box = yield* RelaySecretBox;
  return yield* encodeCredentials(credentials).pipe(
    Effect.flatMap(box.seal),
    Effect.mapError(() => failure("unavailable", "Could not save the connection.")),
  );
});
const open = Effect.fn("issueTrackers.open")(function* (row: ConnectionRecord) {
  if (!row.payloadSealed)
    return yield* failure("not_configured", "Connect this service in Organization settings first.");
  const box = yield* RelaySecretBox;
  return yield* box.open(row.payloadSealed).pipe(
    Effect.flatMap(decodeCredentials),
    Effect.mapError(() =>
      failure(
        "auth_required",
        // Unreadable credentials hide the workspace identity needed to compare a new grant.
        row.service === "linear"
          ? "The saved Linear connection could not be read. Disconnect Linear in Organization settings, then connect it again."
          : "Reconnect this service in Organization settings.",
      ),
    ),
  );
});

const linearConfig = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  if (!config.linear)
    return yield* failure("not_configured", "Linear OAuth is not configured on this relay.");
  return {
    clientId: config.linear.clientId,
    clientSecret: Redacted.value(config.linear.clientSecret),
    redirectUri: new URL(LINEAR_CALLBACK_PATH, config.relayIssuer).toString(),
  };
});

const hashState = (state: string) =>
  Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(state),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

export const listConnections = Effect.fn("issueTrackers.list")(function* (
  organizationId: string,
  includeJiraSites = false,
) {
  const store = yield* ConnectionStore;
  const config = yield* RelayConfiguration;
  const now = yield* milliseconds;
  let rows = yield* store.list(organizationId);
  let expired = false;
  for (const row of rows) {
    if (row.authorizationId && row.pendingExpiresAt && Date.parse(row.pendingExpiresAt) <= now) {
      yield* store.cancelAuthorization({
        ...row,
        authorizationId: row.authorizationId,
        expiresAt: row.pendingExpiresAt,
      });
      expired = true;
    }
    if (row.replacement && Date.parse(row.replacement.expiresAt) <= now) {
      yield* store.cancelReplacement({ ...row, proposalId: row.replacement.id });
      expired = true;
    }
  }
  if (expired) rows = yield* store.list(organizationId);
  return {
    linearAvailable: Boolean(config.linear),
    connections: rows.map((row) => ({
      ...metadata(row, includeJiraSites),
      status:
        row.status === "connecting" &&
        row.pendingExpiresAt &&
        Date.parse(row.pendingExpiresAt) < now
          ? ("reconnect_required" as const)
          : row.status,
    })),
  };
});

export const startLinear = Effect.fn("issueTrackers.startLinear")(function* (input: {
  readonly organizationId: string;
  readonly userId: string;
}) {
  const config = yield* linearConfig;
  const crypto = yield* Crypto.Crypto;
  const state = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("unavailable", "Could not begin authorization.")),
  );
  const now = yield* milliseconds;
  const store = yield* ConnectionStore;
  const pending = yield* store.begin({
    ...input,
    service: "linear",
    stateHash: yield* hashState(state),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 15 * 60_000)),
  });
  return {
    authorizationUrl: linearAuthorizationUrl({ ...config, state }),
    authorizationId: pending.authorizationId!,
    connection: metadata(pending),
  };
});

const requireLinearAdmin = Effect.fn("issueTrackers.requireLinearAdmin")(function* (input: {
  readonly organizationId: string;
  readonly userId: string;
}) {
  const organizations = yield* Organizations;
  const membership = yield* organizations.getMembershipForUser({ userId: input.userId });
  if (
    !membership ||
    membership.role !== "admin" ||
    membership.organization.organizationId !== input.organizationId
  )
    return yield* failure("forbidden", "An organization administrator must connect Linear.");
});

export const completeLinear = Effect.fn("issueTrackers.completeLinear")(function* (input: {
  readonly state: string;
  readonly code: string | null;
}) {
  const deadline = (yield* milliseconds) + 8000;
  const store = yield* ConnectionStore;
  const stateHash = yield* hashState(input.state);
  const pending = yield* store.findPending(stateHash);
  if (!pending?.authorizationId) return yield* conflict();
  const authorizationId = pending.authorizationId;
  const attempt = { ...pending, authorizationId };
  const admin = { organizationId: pending.organizationId, userId: pending.updatedByUserId };
  // A losing duplicate callback must not cancel the callback that already claimed this code.
  const discardUnclaimed = store.withLock(pending, (row) =>
    row?.authorizationId === authorizationId && row.pendingStateHash === stateHash
      ? store.cancelAuthorization(attempt)
      : Effect.void,
  );
  const claimed = yield* Effect.gen(function* () {
    if (!input.code)
      return yield* failure(
        "invalid_input",
        "Linear authorization was cancelled. Return to Organization settings to try again.",
      );
    yield* requireLinearAdmin(admin);
    return yield* store.withLock(pending, (row) =>
      Effect.gen(function* () {
        if (
          !row ||
          row.authorizationId !== authorizationId ||
          row.pendingStateHash !== stateHash ||
          !row.pendingExpiresAt ||
          Date.parse(row.pendingExpiresAt) <= (yield* milliseconds)
        )
          return yield* conflict();
        if (!(yield* store.claimAuthorization({ ...row, authorizationId, stateHash })))
          return yield* conflict();
        return row;
      }),
    );
  }).pipe(
    boundedOperation,
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? discardUnclaimed.pipe(Effect.ignore) : Effect.void,
    ),
  );
  const code = input.code!;
  return yield* Effect.gen(function* () {
    const previous = claimed.payloadSealed ? yield* open(claimed) : null;
    if (previous && previous.service !== "linear") return yield* conflict();
    const config = yield* linearConfig;
    // Provider calls run outside the connection lock so the selected workspace keeps serving reads.
    const tokens = yield* exchangeLinearCode({ ...config, code });
    const expiresAt = (yield* milliseconds) + tokens.expiresIn * 1000;
    const identity = yield* getLinearIdentity({ accessToken: tokens.accessToken });
    const sameWorkspace = previous?.workspaceId === identity.workspaceId;
    const crypto = yield* Crypto.Crypto;
    const newId = crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failure("unavailable", "Could not save the Linear connection.")),
    );
    const generation =
      sameWorkspace && previous ? (previous.generation ?? previous.workspaceId) : yield* newId;
    const payloadSealed = yield* seal({
      service: "linear",
      ...tokens,
      expiresAt,
      workspaceId: identity.workspaceId,
      workspaceSlug: identity.workspaceSlug,
      generation,
    });
    const proposalId = previous && !sameWorkspace ? yield* newId : null;
    yield* requireLinearAdmin(admin);
    return yield* store.withLock(claimed, (row) =>
      Effect.gen(function* () {
        const now = yield* milliseconds;
        if (
          !row ||
          row.version !== claimed.version ||
          row.authorizationId !== authorizationId ||
          row.pendingStateHash !== null ||
          !row.pendingExpiresAt ||
          Date.parse(row.pendingExpiresAt) <= now
        )
          return yield* conflict();
        if (proposalId && previous) {
          const replacement = {
            id: proposalId,
            payloadSealed,
            workspaceId: identity.workspaceId,
            currentWorkspaceId: previous.workspaceId,
            accountLabel: identity.accountLabel,
            currentAccountLabel: row.accountLabel ?? "Current Linear workspace",
            expectedVersion: row.version,
            createdByUserId: admin.userId,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 15 * 60_000)),
          };
          if (!(yield* store.proposeReplacement({ ...row, authorizationId, replacement })))
            return yield* conflict();
          return { status: "awaiting_confirmation" as const, accountLabel: identity.accountLabel };
        }
        if (
          !(yield* store.complete({
            ...row,
            payloadSealed,
            accountLabel: identity.accountLabel,
            userId: admin.userId,
          }))
        )
          return yield* conflict();
        return { status: "connected" as const, accountLabel: identity.accountLabel };
      }),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, deadline - (yield* milliseconds)),
      orElse: () =>
        Effect.fail(
          failure("unavailable", "The issue tracker took too long to respond. Try again."),
        ),
    }),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? store.cancelAuthorization(attempt).pipe(Effect.ignore) : Effect.void,
    ),
  );
});

export const confirmLinearReplacement = Effect.fn("issueTrackers.confirmLinearReplacement")(
  function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly proposalId: string;
  }) {
    yield* requireLinearAdmin(input);
    const store = yield* ConnectionStore;
    const key = { organizationId: input.organizationId, service: "linear" as const };
    yield* store.withLock(key, (row) =>
      Effect.gen(function* () {
        const proposal = row?.replacement;
        if (
          !row ||
          !proposal ||
          proposal.id !== input.proposalId ||
          proposal.expectedVersion !== row.version
        )
          return yield* conflict();
        if (Date.parse(proposal.expiresAt) <= (yield* milliseconds))
          return yield* failure("conflict", "This workspace change expired. Connect Linear again.");
        if (
          !(yield* store.complete({
            ...row,
            payloadSealed: proposal.payloadSealed,
            accountLabel: proposal.accountLabel,
            userId: input.userId,
          }))
        )
          return yield* conflict();
      }),
    );
    return yield* listConnections(input.organizationId, true);
  },
);

export const cancelLinearReplacement = Effect.fn("issueTrackers.cancelLinearReplacement")(
  function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly proposalId: string;
  }) {
    yield* requireLinearAdmin(input);
    const store = yield* ConnectionStore;
    const key = { organizationId: input.organizationId, service: "linear" as const };
    yield* store.withLock(key, (row) =>
      Effect.gen(function* () {
        if (!row?.replacement) return;
        if (row.replacement.id !== input.proposalId) return yield* conflict();
        yield* store.cancelReplacement({ ...row, proposalId: input.proposalId });
      }),
    );
    return yield* listConnections(input.organizationId, true);
  },
);

export const disconnect = Effect.fn("issueTrackers.disconnect")(function* (key: ConnectionKey) {
  const store = yield* ConnectionStore;
  // Deleting also invalidates pending callbacks. No saved token ever reaches an executor.
  yield* store.remove(key);
  return { ok: true };
});

const linearCredentials = Effect.fn("issueTrackers.linearCredentials")(function* (
  key: ConnectionKey,
) {
  const store = yield* ConnectionStore;
  return yield* store.withLock(key, (row) =>
    Effect.gen(function* () {
      if (!row || row.status !== "connected")
        return yield* failure(
          "auth_required",
          "Connect or reconnect Linear in Organization settings.",
        );
      let credentials = yield* open(row);
      let activeRow = row;
      if (credentials.service !== "linear") return yield* conflict();
      if (credentials.expiresAt <= (yield* milliseconds) + 60_000) {
        const config = yield* linearConfig;
        const tokens = yield* refreshLinearTokens({
          ...config,
          refreshToken: credentials.refreshToken,
        });
        credentials = {
          ...credentials,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: (yield* milliseconds) + tokens.expiresIn * 1000,
        };
        const payloadSealed = yield* seal(credentials);
        if (!(yield* store.refresh({ ...row, payloadSealed }))) return yield* conflict();
        activeRow = { ...row, payloadSealed };
      }
      return { row: activeRow, credentials };
    }),
  );
});

export const readIssue = Effect.fn("issueTrackers.readIssue")(function* (input: {
  readonly organizationId: string;
  readonly service: RelayIssueTrackerService;
  readonly issue: string;
}) {
  const store = yield* ConnectionStore;
  const initial = yield* store.get(input);
  if (!initial)
    return yield* failure(
      "not_configured",
      "Ask an administrator to connect this service in Organization settings.",
    );
  if (initial.status !== "connected")
    return yield* failure(
      "auth_required",
      "Ask an administrator to reconnect this service in Organization settings.",
    );
  let authRecord = initial;
  return yield* Effect.gen(function* () {
    const startedAt = yield* milliseconds;
    const active =
      input.service === "linear" ? yield* linearCredentials(input) : yield* jiraCredentials(input);
    authRecord = active.row;
    const providerResult =
      active.credentials.service === "linear"
        ? yield* readLinearIssue({ ...active.credentials, issue: input.issue }).pipe(
            Effect.timeoutOrElse({
              duration: Math.max(1, startedAt + 7500 - (yield* milliseconds)),
              orElse: () =>
                Effect.fail(failure("unavailable", "Linear took too long to read the issue.")),
            }),
          )
        : yield* readJiraIssue({ ...active.credentials, issue: input.issue });
    // The original body is only for discovering and validating image references.
    const { originalDescription, ...result } =
      "originalDescription" in providerResult
        ? providerResult
        : { ...providerResult, originalDescription: undefined };
    let linear;
    if (
      active.credentials.service === "linear" &&
      "issueId" in result &&
      typeof result.issueId === "string"
    ) {
      const source: LinearSource = {
        organizationId: input.organizationId,
        generation: active.credentials.generation ?? active.credentials.workspaceId,
        workspaceId: active.credentials.workspaceId,
        issueId: result.issueId,
      };
      const reference = yield* sealLinearReference({ ...source, kind: "issue" });
      const images = yield* linearImageReferences(
        source,
        typeof originalDescription === "string" ? originalDescription : result.description,
      );
      const remaining = startedAt + 7500 - (yield* milliseconds);
      const discussion: RelayLinearDiscussion =
        remaining <= 0
          ? {
              status: "unavailable",
              reason: "No time remained to read discussion. Use the source reference to retry.",
            }
          : yield* linearDiscussion({
              source,
              accessToken: active.credentials.accessToken,
              byteBudget:
                ISSUE_RESPONSE_BYTES -
                utf8Bytes({
                  ...result,
                  ...images,
                  source: reference,
                  accountLabel: active.row.accountLabel,
                }) -
                4096,
            }).pipe(
              Effect.timeoutOrElse({
                duration: Math.min(2000, remaining),
                orElse: () =>
                  Effect.fail(
                    failure(
                      "unavailable",
                      "Discussion timed out. Use the source reference to retry.",
                    ),
                  ),
              }),
              Effect.catch((error) =>
                error.code === "auth_required" ||
                error.code === "forbidden" ||
                error.code === "not_found"
                  ? Effect.fail(error)
                  : Effect.succeed({ status: "unavailable" as const, reason: error.message }),
              ),
            );
      linear = {
        source: reference,
        workspaceId: source.workspaceId,
        issueId: source.issueId,
        discussion,
        ...images,
      };
    }
    const current = yield* store.get(input);
    if (!current || current.version !== active.row.version) return yield* conflict();
    const response = {
      ...result,
      ...(linear ? { linear } : {}),
      service: input.service,
      accountLabel: active.row.accountLabel ?? input.service,
    };
    return input.service === "jira" ? yield* fitJiraIssueResponse(response) : response;
  }).pipe(
    boundedOperation,
    Effect.tapError((error) =>
      error._tag === "RelayIssueTrackerError" && error.code === "auth_required"
        ? store.requireReconnect(authRecord)
        : Effect.void,
    ),
  );
});

type LinearCredentials = Extract<Credentials, { service: "linear" }>;
const withLinearReference = Effect.fn("issueTrackers.withLinearReference")(function* <A, E, R>(
  input: { readonly organizationId: string; readonly reference: string },
  use: (context: {
    readonly reference: LinearReference;
    readonly source: LinearSource;
    readonly credentials: LinearCredentials;
    readonly issue: RelayIssueDetails & {
      readonly issueId: string;
      readonly originalDescription: string;
    };
    readonly accountLabel: string;
  }) => Effect.Effect<A, E, R>,
) {
  const store = yield* ConnectionStore;
  const key = { organizationId: input.organizationId, service: "linear" as const };
  const initial = yield* store.get(key);
  if (!initial) return yield* conflict();
  let authRecord = initial;
  return yield* Effect.gen(function* () {
    const reference = yield* openLinearReference(input.reference);
    const active = yield* linearCredentials(key);
    authRecord = active.row;
    const source = {
      organizationId: input.organizationId,
      generation: active.credentials.generation ?? active.credentials.workspaceId,
      workspaceId: active.credentials.workspaceId,
      issueId: reference.issueId,
    };
    yield* validateLinearSource(reference, source);
    const issue = yield* readLinearIssue({
      ...active.credentials,
      issue: reference.issueId,
      issueId: reference.issueId,
    });
    const result = yield* use({
      reference,
      source,
      credentials: active.credentials,
      issue,
      accountLabel: active.row.accountLabel ?? "Linear",
    });
    const current = yield* store.get(key);
    if (!current || current.version !== active.row.version) return yield* conflict();
    return result;
  }).pipe(
    boundedOperation,
    Effect.tapError((error) =>
      isTrackerFailure(error) && error.code === "auth_required"
        ? store.requireReconnect(authRecord)
        : Effect.void,
    ),
  );
});

export const readComments = Effect.fn("issueTrackers.readComments")(function* (input: {
  readonly organizationId: string;
  readonly reference: string;
}) {
  return yield* withLinearReference(
    input,
    ({ reference, source, credentials, issue, accountLabel }) =>
      Effect.gen(function* () {
        if (reference.kind !== "issue" && reference.kind !== "comments")
          return yield* failure(
            "invalid_input",
            "Use an issue source or discussion continuation reference.",
          );
        const discussion = yield* linearDiscussion({
          source,
          accessToken: credentials.accessToken,
          ...(reference.after ? { after: reference.after } : {}),
        });
        return {
          service: "linear" as const,
          accountLabel,
          identifier: issue.identifier,
          url: issue.url,
          source: yield* sealLinearReference({ ...source, kind: "issue" }),
          workspaceId: source.workspaceId,
          issueId: source.issueId,
          discussion,
          images: [],
          imagesTruncated: false,
          imagesContinuation: null,
        };
      }),
  );
});

export const readImages = Effect.fn("issueTrackers.readImages")(function* (input: {
  readonly organizationId: string;
  readonly reference: string;
}) {
  return yield* withLinearReference(
    input,
    ({ reference, source, credentials, issue, accountLabel }) =>
      Effect.gen(function* () {
        if (reference.kind !== "images" || !reference.afterImage)
          return yield* failure("invalid_input", "Use an imagesContinuation from a Linear read.");
        const markdown = reference.commentId
          ? yield* readLinearCommentBody({
              ...credentials,
              issueId: source.issueId,
              commentId: reference.commentId,
            })
          : issue.originalDescription;
        return {
          service: "linear" as const,
          accountLabel,
          identifier: issue.identifier,
          url: issue.url,
          workspaceId: source.workspaceId,
          issueId: source.issueId,
          ...(yield* linearImageReferences(
            source,
            markdown,
            reference.commentId,
            reference.afterImage,
          )),
        };
      }),
  );
});

export const viewImage = Effect.fn("issueTrackers.viewImage")(function* (input: {
  readonly organizationId: string;
  readonly reference: string;
}) {
  return yield* withLinearReference(
    input,
    ({ reference, source, credentials, issue, accountLabel }) =>
      Effect.gen(function* () {
        if (reference.kind !== "image" || !reference.imageUrl)
          return yield* failure(
            "invalid_input",
            "Use an image reference returned by a Linear read.",
          );
        const markdown = reference.commentId
          ? yield* readLinearCommentBody({
              ...credentials,
              issueId: source.issueId,
              commentId: reference.commentId,
            })
          : issue.originalDescription;
        if (!linearImageUrls(markdown).includes(reference.imageUrl))
          return yield* failure(
            "not_found",
            "This image is no longer embedded in the issue or comment. Read the issue again.",
          );
        const image = yield* fetchLinearImage({
          accessToken: credentials.accessToken,
          url: reference.imageUrl,
        });
        return {
          service: "linear" as const,
          accountLabel,
          identifier: issue.identifier,
          url: issue.url,
          workspaceId: source.workspaceId,
          issueId: source.issueId,
          image,
        };
      }),
  );
});
