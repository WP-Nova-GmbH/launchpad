import {
  RELAY_LINEAR_CALLBACK_PATH,
  RelayIssueTrackerError,
  type RelayConnectJiraRequest,
  type RelayIssueTrackerService,
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
import { connectJira, readJiraIssue } from "./Jira.ts";
import {
  exchangeLinearCode,
  getLinearIdentity,
  linearAuthorizationUrl,
  readLinearIssue,
  refreshLinearTokens,
} from "./Linear.ts";

export const LINEAR_CALLBACK_PATH = RELAY_LINEAR_CALLBACK_PATH;

const Credentials = Schema.Union([
  Schema.Struct({
    service: Schema.Literal("jira"),
    apiKey: Schema.String,
    siteUrl: Schema.String,
    cloudId: Schema.String,
  }),
  Schema.Struct({
    service: Schema.Literal("linear"),
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
    workspaceId: Schema.String,
    workspaceSlug: Schema.String,
  }),
]);
type Credentials = typeof Credentials.Type;
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Credentials));
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
      failure("auth_required", "Reconnect this service in Organization settings."),
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

export const listConnections = Effect.fn("issueTrackers.list")(function* (organizationId: string) {
  const store = yield* ConnectionStore;
  const config = yield* RelayConfiguration;
  const now = yield* milliseconds;
  const rows = yield* store.list(organizationId);
  return {
    linearAvailable: Boolean(config.linear),
    connections: rows.map((row) => ({
      ...metadata(row),
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
  yield* store.begin({
    ...input,
    service: "linear",
    stateHash: yield* hashState(state),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 15 * 60_000)),
  });
  return { authorizationUrl: linearAuthorizationUrl({ ...config, state }) };
});

export const completeLinear = Effect.fn("issueTrackers.completeLinear")(function* (input: {
  readonly state: string;
  readonly code: string | null;
}) {
  const store = yield* ConnectionStore;
  const pending = yield* store.findPending(yield* hashState(input.state));
  const now = yield* milliseconds;
  if (!pending || !pending.pendingExpiresAt || Date.parse(pending.pendingExpiresAt) <= now)
    return yield* conflict();
  if (!input.code) {
    yield* store.cancel(pending);
    return yield* failure(
      "invalid_input",
      "Linear authorization was cancelled. Return to Organization settings to try again.",
    );
  }
  // Authorization can outlive the admin's membership; recheck before accepting the grant.
  const organizations = yield* Organizations;
  const membership = yield* organizations.getMembershipForUser({ userId: pending.updatedByUserId });
  if (
    !membership ||
    membership.role !== "admin" ||
    membership.organization.organizationId !== pending.organizationId
  ) {
    yield* store.cancel(pending);
    return yield* failure("forbidden", "An organization administrator must connect Linear.");
  }
  const code = input.code;
  return yield* store
    .withLock(pending, (row) =>
      Effect.gen(function* () {
        if (
          !row ||
          row.version !== pending.version ||
          row.pendingStateHash !== pending.pendingStateHash
        )
          return yield* conflict();
        const config = yield* linearConfig;
        const tokens = yield* exchangeLinearCode({ ...config, code });
        const identity = yield* getLinearIdentity({ accessToken: tokens.accessToken });
        const payloadSealed = yield* seal({
          service: "linear",
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: (yield* milliseconds) + tokens.expiresIn * 1000,
          workspaceId: identity.workspaceId,
          workspaceSlug: identity.workspaceSlug,
        });
        if (
          !(yield* store.complete({ ...row, payloadSealed, accountLabel: identity.accountLabel }))
        )
          return yield* conflict();
        return identity.accountLabel;
      }),
    )
    .pipe(
      boundedOperation,
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? store.cancel(pending).pipe(Effect.ignore) : Effect.void,
      ),
    );
});

export const saveJira = Effect.fn("issueTrackers.saveJira")(function* (
  input: RelayConnectJiraRequest & { readonly organizationId: string; readonly userId: string },
) {
  const store = yield* ConnectionStore;
  const pending = yield* store.begin({
    organizationId: input.organizationId,
    service: "jira",
    userId: input.userId,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe((yield* milliseconds) + 60_000)),
  });
  return yield* Effect.gen(function* () {
    const identity = yield* connectJira(input);
    const payloadSealed = yield* seal({
      service: "jira",
      apiKey: input.apiKey,
      cloudId: identity.cloudId,
      siteUrl: identity.siteUrl,
    });
    if (
      !(yield* store.complete({ ...pending, payloadSealed, accountLabel: identity.accountLabel }))
    )
      return yield* conflict();
    return {
      ...metadata(pending),
      status: "connected" as const,
      accountLabel: identity.accountLabel,
    };
  }).pipe(
    boundedOperation,
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? store.cancel(pending).pipe(Effect.ignore) : Effect.void,
    ),
  );
});

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
    const active =
      input.service === "linear"
        ? yield* linearCredentials(input)
        : { row: initial, credentials: yield* open(initial) };
    authRecord = active.row;
    const result =
      active.credentials.service === "linear"
        ? yield* readLinearIssue({ ...active.credentials, issue: input.issue })
        : yield* readJiraIssue({ ...active.credentials, issue: input.issue });
    const current = yield* store.get(input);
    if (!current || current.version !== active.row.version) return yield* conflict();
    return {
      ...result,
      service: input.service,
      accountLabel: active.row.accountLabel ?? input.service,
    };
  }).pipe(
    boundedOperation,
    Effect.tapError((error) =>
      error._tag === "RelayIssueTrackerError" && error.code === "auth_required"
        ? store.requireReconnect(authRecord)
        : Effect.void,
    ),
  );
});
