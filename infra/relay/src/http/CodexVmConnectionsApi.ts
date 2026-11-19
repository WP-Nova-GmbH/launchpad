import {
  CodexVmConnectionError,
  RelayApi,
  RelayClientPrincipal,
  RelayTenancyForbiddenError,
  RelayTenancyNotFoundError,
  RelayTenancyConflictError,
  RelayTenancyInvalidError,
  RelayAuthInvalidError,
  RelayInternalError,
  type RelayCodexVmConnection,
  type RelayCodexVmCompleteSignIn,
  type RelayCodexVmStartSignIn,
  type RelayCodexVmToken,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import {
  makeCodexVmConnections,
  CodexVmConnectionConflict,
  type CodexVmConnection,
} from "../tenancy/CodexVmConnections.ts";
import {
  CodexVmOAuth,
  CodexVmOAuthError,
  CodexVmOAuthAttemptMaterial,
  CodexVmTokenBundle,
  hashCodexVmState,
} from "../tenancy/CodexVmOAuth.ts";
import { appendRelayCredentialResponseHeaders, relayInternalErrorResponse } from "./Api.ts";
import { requireAdmin, resolveMembership } from "./TenancyApi.ts";

const encodeMaterial = Schema.encodeEffect(Schema.fromJsonString(CodexVmOAuthAttemptMaterial));
const decodeMaterial = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexVmOAuthAttemptMaterial),
);
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(CodexVmTokenBundle));
const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexVmTokenBundle));
const failure = (reason: CodexVmConnectionError["reason"]) =>
  new CodexVmConnectionError({ reason });
const iso = (milliseconds: number) => DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
const isConnectionError = Schema.is(CodexVmConnectionError);
const isRelayWireError = Schema.is(
  Schema.Union([
    RelayTenancyForbiddenError,
    RelayTenancyNotFoundError,
    RelayTenancyConflictError,
    RelayTenancyInvalidError,
    RelayAuthInvalidError,
    RelayInternalError,
  ]),
);
const isConnectionConflict = Schema.is(CodexVmConnectionConflict);
const isOAuthError = Schema.is(CodexVmOAuthError);

export const codexVmConnectionMetadata = (
  connection: CodexVmConnection | null,
  now: number,
): RelayCodexVmConnection => {
  const abandoned =
    connection?.status === "connected" &&
    connection.refreshStartedAt !== null &&
    Date.parse(connection.refreshStartedAt) + 6_000 <= now;
  return {
    connectionId: connection?.subject ? connection.connectionId : null,
    label: connection?.label ?? null,
    status: abandoned ? "reconnect_required" : (connection?.status ?? "disconnected"),
    epoch: connection?.epoch ?? 0,
    tokenRevision: connection?.tokenRevision ?? 0,
    errorCode: abandoned
      ? "refresh_uncertain"
      : ((connection?.errorCode as RelayCodexVmConnection["errorCode"]) ?? null),
    refreshing: Boolean(
      connection?.status === "connected" && connection.refreshAttemptId && !abandoned,
    ),
  };
};

/** OAuth I/O is deliberately outside the store's short claim/install transactions. */
export function makeCodexVmConnectionActions(dependencies: {
  readonly store: ReturnType<typeof makeCodexVmConnections>;
  readonly oauth: CodexVmOAuth["Service"];
  readonly secrets: RelaySecretBox["Service"];
}) {
  const { store, oauth, secrets } = dependencies;
  const metadata = Effect.fn("codex_vm.connection_metadata")(function* (organizationId: string) {
    return codexVmConnectionMetadata(
      yield* store.get(organizationId),
      (yield* DateTime.now).epochMilliseconds,
    );
  });
  const openBundle = (sealed: string) =>
    secrets.open(sealed).pipe(
      Effect.flatMap(decodeBundle),
      Effect.mapError(() => failure("configuration")),
    );
  const retire = Effect.fn("codex_vm.retire_session")(function* (
    connection: CodexVmConnection | null,
  ) {
    if (!connection?.payloadSealed || !connection.clientId)
      return connection?.errorCode !== "revocation_unconfirmed";
    return yield* openBundle(connection.payloadSealed).pipe(
      Effect.flatMap((bundle) =>
        oauth.revoke({ clientId: connection.clientId!, refreshToken: bundle.refreshToken }),
      ),
      Effect.map((result) => result.confirmed),
      Effect.orElseSucceed(() => false),
    );
  });
  const unconfirmed = Effect.fn("codex_vm.unconfirmed_retirement")(function* (
    organizationId: string,
    reason: CodexVmConnectionError["reason"],
  ) {
    yield* store.get(organizationId).pipe(
      Effect.flatMap((current) =>
        current?.status === "disconnected"
          ? store.markRevocation({ organizationId, epoch: current.epoch, confirmed: false })
          : Effect.succeed(false),
      ),
      Effect.ignore,
    );
    return yield* new CodexVmConnectionError({ reason, revocationUnconfirmed: true });
  });
  const start = Effect.fn("codex_vm.start_sign_in")(function* (
    organizationId: string,
    userId: string,
    input: RelayCodexVmStartSignIn,
  ) {
    const current = yield* store.get(organizationId);
    const retry = input.retryAttemptId ? yield* store.getAttempt(input.retryAttemptId) : null;
    if (
      input.retryAttemptId &&
      (!retry ||
        retry.organizationId !== organizationId ||
        retry.userId !== userId ||
        retry.intent !== input.intent ||
        retry.phase !== "failed" ||
        !retry.issuedClientId)
    )
      return yield* failure("stale_attempt");
    const previous =
      input.intent === "reconnect" && current?.payloadSealed
        ? yield* openBundle(current.payloadSealed).pipe(Effect.orElseSucceed(() => null))
        : null;
    const registration =
      retry?.issuedClientId && input.intent !== "reconnect"
        ? { issuer: "https://auth.openai.com" as const, clientId: retry.issuedClientId }
        : input.intent === "reconnect" &&
            current?.issuer === "https://auth.openai.com" &&
            current.subject &&
            current.clientId
          ? {
              issuer: "https://auth.openai.com" as const,
              subject: current.subject,
              clientId: current.clientId,
              ...(previous ? { idTokenHint: previous.idToken } : {}),
            }
          : undefined;
    const material = yield* oauth.createAttempt({
      state: input.state,
      callbackUri: input.redirectUri,
      hostId: `urn:uuid:${yield* store.getHostId()}`,
      ...(registration ? { registration } : {}),
    });
    const pendingSealed = yield* encodeMaterial(material).pipe(Effect.flatMap(secrets.seal));
    const expiresAt = iso((yield* DateTime.now).epochMilliseconds + 10 * 60_000);
    const attempt = yield* store.beginOAuthAttempt({
      organizationId,
      userId,
      intent: input.intent,
      redirectUri: input.redirectUri,
      stateHash: material.stateHash,
      pendingSealed,
      expiresAt,
      expected: current,
      ...(input.retryAttemptId ? { retryAttemptId: input.retryAttemptId } : {}),
    });
    return {
      attempt: { attemptId: attempt.attemptId, expiresAt, phase: attempt.phase },
      authorizationUrl: material.authorizationUrl,
    };
  });
  const complete = Effect.fn("codex_vm.complete_sign_in")(function* (
    organizationId: string,
    userId: string,
    input: RelayCodexVmCompleteSignIn,
  ) {
    const stateHash = yield* hashCodexVmState(input.state);
    if (input.error) {
      const changed = yield* store.markOAuthFailure({
        organizationId,
        userId,
        attemptId: input.attemptId,
        stateHash,
        phase: "denied",
      });
      if (!changed) return yield* failure("stale_attempt");
      return yield* failure("access_denied");
    }
    const attempt = yield* store.claimCallback({
      organizationId,
      userId,
      attemptId: input.attemptId,
      stateHash,
      ...(input.clientId ? { issuedClientId: input.clientId } : {}),
    });
    if (!attempt.pendingSealed) return yield* failure("stale_attempt");
    const failAttempt = store
      .markOAuthFailure({ organizationId, userId, attemptId: input.attemptId })
      .pipe(Effect.ignore);
    const material = yield* secrets.open(attempt.pendingSealed).pipe(
      Effect.flatMap(decodeMaterial),
      Effect.mapError(() => failure("configuration")),
      Effect.tapError(() => failAttempt),
    );
    const authorized = yield* oauth
      .completeAuthorization({ attempt: material, callback: input })
      .pipe(
        Effect.tapError(() =>
          store
            .markOAuthFailure({ organizationId, userId, attemptId: input.attemptId })
            .pipe(Effect.ignore),
        ),
      );
    // Retain the known response while persisting: retrying storage must never exchange the code again.
    const payloadSealed = yield* encodeBundle(authorized.bundle).pipe(
      Effect.flatMap(secrets.seal),
      Effect.catch(() => Effect.andThen(failAttempt, unconfirmed(organizationId, "unavailable"))),
    );
    const installed = yield* store
      .install({
        organizationId,
        userId,
        attemptId: input.attemptId,
        ...authorized.identity,
        label: authorized.identity.email ?? authorized.identity.subject,
        payloadSealed,
        expiresAt: iso(authorized.bundle.expiresAt),
        earliestRefreshAt:
          authorized.bundle.earliestRefreshAt === null
            ? null
            : iso(authorized.bundle.earliestRefreshAt),
      })
      .pipe(
        Effect.retry({ times: 2 }),
        Effect.catch(() => Effect.andThen(failAttempt, unconfirmed(organizationId, "unavailable"))),
      );
    if (!installed) {
      return yield* unconfirmed(organizationId, "stale_attempt");
    }
    // Reauthorization reuses a registration; revoking its older grant may also
    // invalidate the freshly authorized session. Retire only an account replacement.
    const confirmed = installed.retirementUnconfirmed
      ? false
      : installed.previous && installed.previous.connectionId !== installed.connection.connectionId
        ? yield* store.withConnectionRevocation(
            {
              organizationId,
              connectionId: installed.connection.connectionId,
              epoch: installed.connection.epoch,
              actionRevision: installed.connection.actionRevision,
            },
            retire(installed.previous),
          )
        : true;
    return {
      ...(yield* metadata(organizationId)),
      ...(!confirmed ? { revocationUnconfirmed: true } : {}),
    };
  });
  const disconnect = Effect.fn("codex_vm.disconnect_sign_in")(function* (
    organizationId: string,
    userId: string,
  ) {
    const removed = yield* store.disconnect({ organizationId, userId });
    if (removed) {
      const confirmed = yield* store.withConnectionRevocation(
        {
          organizationId,
          connectionId: removed.previous.connectionId,
          epoch: removed.epoch,
          actionRevision: removed.previous.actionRevision + 1,
        },
        retire(removed.previous),
      );
      return {
        ...(yield* metadata(organizationId)),
        ...(!confirmed ? { revocationUnconfirmed: true } : {}),
      };
    }
    return yield* metadata(organizationId);
  });
  const token = Effect.fn("codex_vm.access_token")(function* (
    organizationId: string,
    connectionId: string,
  ) {
    const claim = yield* store.claimRefresh({ organizationId, connectionId });
    if (claim.kind === "pending")
      return { status: "pending", retryAfterMs: claim.retryAfterMs } satisfies RelayCodexVmToken;
    if (claim.kind === "unavailable") return yield* failure("not_connected");
    let connection = claim.connection;
    if (
      !connection.payloadSealed ||
      !connection.clientId ||
      !connection.subject ||
      connection.issuer !== "https://auth.openai.com"
    )
      return yield* failure("not_connected");
    let bundle = yield* openBundle(connection.payloadSealed).pipe(
      Effect.tapError(() =>
        claim.kind === "refresh"
          ? store.failRefresh(claim.fence, "configuration_error").pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    if (claim.kind === "refresh") {
      bundle = yield* oauth
        .refresh({
          identity: {
            issuer: "https://auth.openai.com",
            subject: connection.subject,
            clientId: connection.clientId,
          },
          bundle,
        })
        .pipe(
          Effect.tapError((error) =>
            (error.reason === "unavailable"
              ? store.releaseRefreshClaim(claim.fence)
              : store.failRefresh(
                  claim.fence,
                  error.reason === "invalid_grant"
                    ? "invalid_grant"
                    : error.reason === "configuration"
                      ? "configuration_error"
                      : "refresh_uncertain",
                )
            ).pipe(Effect.ignore),
          ),
        );
      const payloadSealed = yield* encodeBundle(bundle).pipe(
        Effect.flatMap(secrets.seal),
        Effect.catch(() => unconfirmed(organizationId, "unavailable")),
      );
      const saved = yield* store
        .completeRefresh({
          fence: claim.fence,
          payloadSealed,
          expiresAt: iso(bundle.expiresAt),
          earliestRefreshAt:
            bundle.earliestRefreshAt === null ? null : iso(bundle.earliestRefreshAt),
        })
        .pipe(
          Effect.retry({ times: 2 }),
          Effect.catch(() => unconfirmed(organizationId, "unavailable")),
        );
      if (!saved) {
        return yield* unconfirmed(organizationId, "not_connected");
      }
      connection = { ...connection, tokenRevision: connection.tokenRevision + 1 };
    }
    const current = yield* store.get(organizationId);
    if (
      !current ||
      current.status !== "connected" ||
      current.connectionId !== connectionId ||
      current.epoch !== connection.epoch ||
      current.tokenRevision !== connection.tokenRevision ||
      bundle.expiresAt <= (yield* DateTime.now).epochMilliseconds
    )
      return yield* failure("not_connected");
    return {
      status: "ready",
      connectionId,
      label: connection.label ?? connection.subject!,
      epoch: connection.epoch,
      tokenRevision: connection.tokenRevision,
      token: bundle.accessToken,
      expiresAt: iso(bundle.expiresAt),
    } satisfies RelayCodexVmToken;
  });
  return { metadata, start, complete, disconnect, token };
}

export const mapCodexVmConnectionErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch(
      (
        error,
      ): Effect.Effect<
        never,
        | CodexVmConnectionError
        | RelayInternalError
        | RelayTenancyForbiddenError
        | RelayTenancyNotFoundError
        | RelayTenancyConflictError
        | RelayTenancyInvalidError
        | RelayAuthInvalidError
      > => {
        if (isConnectionError(error) || isRelayWireError(error)) return Effect.fail(error);
        if (isConnectionConflict(error))
          return failure(
            error.code === "not_admin"
              ? "access_denied"
              : error.code === "invalid_state"
                ? "invalid_request"
                : error.code,
          );
        if (isOAuthError(error))
          return new CodexVmConnectionError({
            reason: error.reason,
            ...(error.revocationUnconfirmed ? { revocationUnconfirmed: true } : {}),
          });
        return relayInternalErrorResponse("persistence_failed");
      },
    ),
  );

export const codexVmConnectionsApi = HttpApiBuilder.group(
  RelayApi,
  "codexVmConnections",
  (handlers) =>
    Effect.gen(function* () {
      const store = makeCodexVmConnections((yield* RelayDb).$client);
      const actions = makeCodexVmConnectionActions({
        store,
        oauth: yield* CodexVmOAuth,
        secrets: yield* RelaySecretBox,
      });
      const caller = Effect.gen(function* () {
        const { userId } = yield* RelayClientPrincipal;
        const membership = yield* requireAdmin({ userId });
        return { userId, organizationId: membership.organization.organizationId };
      });
      return handlers
        .handle("status", () =>
          Effect.gen(function* () {
            const { userId } = yield* RelayClientPrincipal;
            const membership = yield* resolveMembership({ userId });
            return yield* actions.metadata(membership.organization.organizationId);
          }).pipe(mapCodexVmConnectionErrors),
        )
        .handle("start", ({ payload }) =>
          Effect.gen(function* () {
            yield* appendRelayCredentialResponseHeaders;
            const { organizationId, userId } = yield* caller;
            return yield* actions.start(organizationId, userId, payload);
          }).pipe(mapCodexVmConnectionErrors),
        )
        .handle("complete", ({ payload }) =>
          Effect.gen(function* () {
            const { organizationId, userId } = yield* caller;
            return yield* actions.complete(organizationId, userId, payload);
          }).pipe(mapCodexVmConnectionErrors),
        )
        .handle("attempt", ({ params }) =>
          Effect.gen(function* () {
            const { organizationId, userId } = yield* caller;
            const attempt = yield* store.getAttempt(params.attemptId);
            if (!attempt || attempt.organizationId !== organizationId || attempt.userId !== userId)
              return null;
            const expired =
              ["pending", "exchanging"].includes(attempt.phase) &&
              Date.parse(attempt.expiresAt) <= (yield* DateTime.now).epochMilliseconds;
            if (expired)
              yield* store.markOAuthFailure({
                organizationId,
                userId,
                attemptId: params.attemptId,
                phase: "expired",
              });
            return {
              attemptId: attempt.attemptId,
              expiresAt: attempt.expiresAt,
              phase: expired ? ("expired" as const) : attempt.phase,
            };
          }).pipe(mapCodexVmConnectionErrors),
        )
        .handle("cancel", ({ payload }) =>
          Effect.gen(function* () {
            const { organizationId, userId } = yield* caller;
            yield* store.cancel({ organizationId, userId, attemptId: payload.attemptId });
            return yield* actions.metadata(organizationId);
          }).pipe(mapCodexVmConnectionErrors),
        )
        .handle("disconnect", () =>
          Effect.gen(function* () {
            const { organizationId, userId } = yield* caller;
            return yield* actions.disconnect(organizationId, userId);
          }).pipe(mapCodexVmConnectionErrors),
        );
    }),
);
