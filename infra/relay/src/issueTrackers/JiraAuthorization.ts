import { RELAY_JIRA_CALLBACK_PATH, RelayIssueTrackerError } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayConfiguration } from "../Config.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { ConnectionStore, metadata, type ConnectionKey } from "./ConnectionStore.ts";
import { getJiraOAuthSites } from "./Jira.ts";
import {
  beginJiraOAuth,
  jiraOAuthErrorCode,
  JiraOAuthSession,
  JiraPendingOAuth,
  exchangeJiraCode,
  refreshJiraTokens,
} from "./JiraOAuth.ts";

const JiraOAuthGrant = Schema.Struct({
  service: Schema.Literal("jira"),
  authType: Schema.Literal("oauth"),
  oauth: JiraOAuthSession,
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  expiresAt: Schema.Number,
});
export const JiraOAuthCredentials = Schema.Struct({
  ...JiraOAuthGrant.fields,
  siteUrl: Schema.NonEmptyString,
  cloudId: Schema.NonEmptyString,
});
const encodeAuthorization = Schema.encodeEffect(Schema.fromJsonString(JiraPendingOAuth));
const decodeAuthorization = Schema.decodeUnknownEffect(Schema.fromJsonString(JiraPendingOAuth));
const encodeJiraGrant = Schema.encodeEffect(Schema.fromJsonString(JiraOAuthGrant));
const decodeJiraGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(JiraOAuthGrant));
const encodeJiraCredentials = Schema.encodeEffect(Schema.fromJsonString(JiraOAuthCredentials));
const decodeJiraCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JiraOAuthCredentials),
);

const failure = (code: RelayIssueTrackerError["code"], message: string) =>
  new RelayIssueTrackerError({ code, message });
const conflict = () =>
  failure("conflict", "This Jira connection changed. Start again from Organization settings.");
const unavailable = () =>
  failure("unavailable", "Could not finish connecting Jira. Try again from Organization settings.");
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const digest = (text: string) =>
  Effect.tryPromise({
    try: async () =>
      new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    catch: unavailable,
  });
const hashState = (state: string) => digest(state).pipe(Effect.map(base64url));
const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(unavailable()) }),
  );
const requireAdmin = Effect.fn("jiraAuthorization.requireAdmin")(function* (input: {
  readonly organizationId: string;
  readonly userId: string;
}) {
  const organizations = yield* Organizations;
  const membership = yield* organizations.getMembershipForUser({ userId: input.userId });
  if (
    !membership ||
    membership.role !== "admin" ||
    membership.organization.organizationId !== input.organizationId
  ) {
    return yield* failure("forbidden", "An organization administrator must connect Jira.");
  }
});

export const startJira = Effect.fn("jiraAuthorization.start")(function* (input: {
  readonly organizationId: string;
  readonly userId: string;
}) {
  yield* requireAdmin(input);
  const config = yield* RelayConfiguration;
  const redirectUri = new URL(RELAY_JIRA_CALLBACK_PATH, config.relayIssuer).toString();
  const crypto = yield* Crypto.Crypto;
  const state = base64url(yield* crypto.randomBytes(32).pipe(Effect.mapError(unavailable)));
  const started = yield* beginJiraOAuth({ redirectUri, state });
  const box = yield* RelaySecretBox;
  const pendingOAuthSealed = yield* encodeAuthorization(started.pending).pipe(
    Effect.flatMap(box.seal),
    Effect.mapError(unavailable),
  );
  const store = yield* ConnectionStore;
  const pending = yield* store.begin({
    ...input,
    service: "jira",
    stateHash: yield* hashState(state),
    pendingOAuthSealed,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe((yield* now) + 15 * 60_000)),
  });
  yield* Effect.logInfo("Jira OAuth authorization ready", {
    authorizationId: pending.authorizationId,
    expiresAt: pending.pendingExpiresAt,
  });
  return {
    authorizationUrl: started.authorizationUrl,
    authorizationId: pending.authorizationId!,
    connection: metadata(pending),
  };
}, bounded);

export const completeJira = Effect.fn("jiraAuthorization.complete")(
  function* (input: {
    readonly state: string;
    readonly code: string | null;
    readonly iss?: string;
    readonly error?: string;
  }) {
    yield* Effect.logDebug("Jira OAuth callback received", {
      hasState: Boolean(input.state),
      hasCode: Boolean(input.code),
      hasIssuer: input.iss !== undefined,
      oauthError: input.error === undefined ? undefined : jiraOAuthErrorCode(input.error),
    });
    if (!input.state || input.state.length > 16_384) return yield* conflict();
    const store = yield* ConnectionStore;
    const stateHash = yield* hashState(input.state);
    const pending = yield* store.findPending(stateHash);
    if (pending?.service !== "jira" || !pending.authorizationId) return yield* conflict();
    yield* Effect.logDebug("Jira OAuth callback matched", {
      authorizationId: pending.authorizationId,
    });
    const attempt = { ...pending, authorizationId: pending.authorizationId };
    const admin = { organizationId: pending.organizationId, userId: pending.updatedByUserId };
    const claimed = yield* Effect.gen(function* () {
      if (input.error !== undefined || !input.code || input.code.length > 16_384)
        return yield* failure(
          "invalid_input",
          "Jira authorization was cancelled. Connect again when ready.",
        );
      yield* requireAdmin(admin);
      return yield* store.withLock(pending, (row) =>
        Effect.gen(function* () {
          if (
            !row ||
            row.authorizationId !== attempt.authorizationId ||
            row.pendingStateHash !== stateHash ||
            !row.pendingExpiresAt ||
            Date.parse(row.pendingExpiresAt) <= (yield* now)
          )
            return yield* conflict();
          if (
            !(yield* store.claimAuthorization({
              ...row,
              authorizationId: attempt.authorizationId,
              stateHash,
            }))
          )
            return yield* conflict();
          return row;
        }),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? store
              .withLock(pending, (row) =>
                row?.authorizationId === attempt.authorizationId &&
                row.pendingStateHash === stateHash
                  ? store.cancelAuthorization(attempt)
                  : Effect.void,
              )
              .pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    return yield* Effect.gen(function* () {
      const box = yield* RelaySecretBox;
      if (!claimed.pendingOAuthSealed) return yield* conflict();
      const auth = yield* box
        .open(claimed.pendingOAuthSealed)
        .pipe(Effect.flatMap(decodeAuthorization), Effect.mapError(unavailable));
      const tokens = yield* exchangeJiraCode({
        ...auth,
        code: input.code!,
        ...(input.iss !== undefined ? { iss: input.iss } : {}),
      });
      const expiresAt = (yield* now) + tokens.expiresIn * 1000;
      const sites = yield* getJiraOAuthSites(tokens.accessToken);
      yield* Effect.logDebug("Jira OAuth sites verified", {
        authorizationId: attempt.authorizationId,
        siteCount: sites.length,
      });
      if (sites.length === 0)
        return yield* failure(
          "forbidden",
          "No Jira sites were authorized for read access. Connect again and allow access to a Jira site in Atlassian.",
        );
      const grant = {
        service: "jira" as const,
        authType: "oauth" as const,
        oauth: { server: auth.server, client: auth.client },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      };
      const site = sites.length === 1 ? sites[0]! : null;
      const payloadSealed = yield* (
        site
          ? encodeJiraCredentials({ ...grant, siteUrl: site.siteUrl, cloudId: site.cloudId })
          : encodeJiraGrant(grant)
      ).pipe(Effect.flatMap(box.seal), Effect.mapError(unavailable));
      yield* requireAdmin(admin);
      return yield* store.withLock(claimed, (row) =>
        Effect.gen(function* () {
          if (
            !row ||
            row.version !== claimed.version ||
            row.authorizationId !== attempt.authorizationId ||
            row.pendingStateHash !== null ||
            !row.pendingExpiresAt ||
            Date.parse(row.pendingExpiresAt) <= (yield* now)
          )
            return yield* conflict();
          const selectionDeadline = Math.min((yield* now) + 15 * 60_000, expiresAt);
          if (selectionDeadline <= (yield* now)) return yield* unavailable();
          if (!site) {
            if (
              !(yield* store.awaitJiraSelection({
                ...row,
                authorizationId: attempt.authorizationId,
                selection: { payloadSealed, sites },
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(selectionDeadline)),
              }))
            )
              return yield* conflict();
            return { status: "awaiting_site_selection" as const };
          }
          if (
            !(yield* store.complete({
              ...row,
              payloadSealed,
              accountLabel: site.accountLabel,
              userId: admin.userId,
            }))
          )
            return yield* conflict();
          return { status: "connected" as const, accountLabel: site.accountLabel };
        }),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? store.cancelAuthorization(attempt).pipe(Effect.ignore) : Effect.void,
      ),
    );
  },
  bounded,
  Effect.tap((result) =>
    Effect.logInfo("Jira OAuth callback completed", { status: result.status }),
  ),
  Effect.tapError((error) =>
    Effect.logWarning("Jira OAuth callback failed", {
      code: "code" in error ? error.code : "internal_error",
    }),
  ),
);

export const selectJiraSite = Effect.fn("jiraAuthorization.selectSite")(function* (input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly authorizationId: string;
  readonly cloudId: string;
}) {
  yield* requireAdmin(input);
  const store = yield* ConnectionStore;
  const key = { organizationId: input.organizationId, service: "jira" as const };
  const pending = yield* store.get(key);
  if (!pending?.jiraSelection || pending.authorizationId !== input.authorizationId)
    return yield* conflict();
  if (!pending.pendingExpiresAt || Date.parse(pending.pendingExpiresAt) <= (yield* now)) {
    yield* store.cancelAuthorization({ ...key, authorizationId: input.authorizationId });
    return yield* failure("conflict", "This site selection expired. Connect Jira again.");
  }
  if (!pending.jiraSelection.sites.some((site) => site.cloudId === input.cloudId))
    return yield* failure("invalid_input", "Choose a Jira site from this authorization.");
  const authorizingAdmin = {
    organizationId: input.organizationId,
    userId: pending.updatedByUserId,
  };
  yield* requireAdmin(authorizingAdmin);
  const box = yield* RelaySecretBox;
  const grant = yield* box
    .open(pending.jiraSelection.payloadSealed)
    .pipe(Effect.flatMap(decodeJiraGrant), Effect.mapError(unavailable));
  // Recheck the grant outside the row lock so the active connection keeps serving reads.
  const sites = yield* getJiraOAuthSites(grant.accessToken);
  const site = sites.find((site) => site.cloudId === input.cloudId);
  if (!site)
    return yield* failure(
      "forbidden",
      "This Jira site is no longer authorized. Connect Jira again.",
    );
  const payloadSealed = yield* encodeJiraCredentials({
    ...grant,
    siteUrl: site.siteUrl,
    cloudId: site.cloudId,
  }).pipe(Effect.flatMap(box.seal), Effect.mapError(unavailable));
  yield* requireAdmin(input);
  yield* requireAdmin(authorizingAdmin);
  yield* store.withLock(key, (row) =>
    Effect.gen(function* () {
      if (
        !row?.jiraSelection ||
        row.version !== pending.version ||
        row.authorizationId !== input.authorizationId ||
        !row.pendingExpiresAt ||
        Date.parse(row.pendingExpiresAt) <= (yield* now)
      )
        return yield* conflict();
      if (
        !(yield* store.complete({
          ...row,
          payloadSealed,
          accountLabel: site.accountLabel,
          userId: input.userId,
        }))
      )
        return yield* conflict();
    }),
  );
}, bounded);

export const cancelJiraSelection = Effect.fn("jiraAuthorization.cancelSelection")(
  function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly authorizationId: string;
  }) {
    yield* requireAdmin(input);
    const store = yield* ConnectionStore;
    const key = { organizationId: input.organizationId, service: "jira" as const };
    yield* store.withLock(key, (row) =>
      Effect.gen(function* () {
        if (!row?.jiraSelection || row.authorizationId !== input.authorizationId)
          return yield* conflict();
        yield* store.cancelAuthorization({ ...key, authorizationId: input.authorizationId });
      }),
    );
  },
  bounded,
);

export const jiraCredentials = Effect.fn("jiraAuthorization.credentials")(function* (
  key: ConnectionKey,
) {
  const store = yield* ConnectionStore;
  const box = yield* RelaySecretBox;
  // Serialize refresh-token rotation across requests and relay instances, as with Linear.
  return yield* store.withLock(key, (row) =>
    Effect.gen(function* () {
      if (!row || row.status !== "connected" || !row.payloadSealed)
        return yield* failure("auth_required", "Connect Jira in Organization settings.");
      let credentials = yield* box.open(row.payloadSealed).pipe(
        Effect.flatMap(decodeJiraCredentials),
        Effect.mapError(() =>
          failure("auth_required", "Reconnect Jira with Atlassian OAuth in Organization settings."),
        ),
      );
      let activeRow = row;
      if (credentials.expiresAt <= (yield* now) + 60_000) {
        const tokens = yield* refreshJiraTokens(credentials);
        credentials = {
          ...credentials,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: (yield* now) + tokens.expiresIn * 1000,
        };
        const payloadSealed = yield* encodeJiraCredentials(credentials).pipe(
          Effect.flatMap(box.seal),
          Effect.mapError(unavailable),
        );
        if (!(yield* store.refresh({ ...row, payloadSealed }))) return yield* conflict();
        activeRow = { ...row, payloadSealed };
      }
      return { row: activeRow, credentials };
    }),
  );
});
