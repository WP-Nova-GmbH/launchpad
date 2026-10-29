import {
  CodexVmSignInError,
  type CodexVmSignInBridge,
  type CodexVmSignInCallback,
} from "@t3tools/contracts";
import {
  CodexVmConnectionError,
  type RelayCodexVmConnection,
  type RelayCodexVmCompleteSignIn,
  type RelayCodexVmSignInAttempt,
  type RelayCodexVmStartSignIn,
  type RelayCodexVmStartSignInResponse,
  type RelayOrganizationMembership,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type Intent = RelayCodexVmStartSignIn["intent"];
export class CodexVmSignInClientError extends Schema.TaggedError<CodexVmSignInClientError>()(
  "CodexVmSignInClientError",
  { reason: Schema.Literals(["signed_out", "unavailable", "browser_unavailable"]) },
) {
  override get message() {
    return this.reason === "signed_out"
      ? "Sign in to Launchpad Connect first."
      : this.reason === "browser_unavailable"
        ? "Could not open ChatGPT in your browser. Allow opening links, then start again."
        : "Could not reach Launchpad Connect. Check the connection, then retry.";
  }
}
export type CodexVmSignInFailure =
  | CodexVmSignInClientError
  | CodexVmSignInError
  | CodexVmConnectionError;
export interface CodexVmSignInState {
  readonly connection: RelayCodexVmConnection | null;
  readonly supported: boolean | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly connectionReadError: string | null;
  readonly error: string | null;
  readonly warning: string | null;
  readonly attempt: RelayCodexVmSignInAttempt | null;
  readonly authorizationUrl: string | null;
  readonly retryable: boolean;
  readonly needsPlanConfirmation: boolean;
}

/** Dependencies capture one user, organization and local environment; no callback is persisted. */
export interface CodexVmSignInDependencies {
  readonly capability: Effect.Effect<boolean, CodexVmSignInFailure>;
  readonly startBridge: Effect.Effect<CodexVmSignInBridge, CodexVmSignInFailure>;
  readonly waitBridge: (
    bridgeId: string,
  ) => Effect.Effect<CodexVmSignInCallback, CodexVmSignInFailure>;
  readonly cancelBridge: (bridgeId: string) => Effect.Effect<void, CodexVmSignInFailure>;
  readonly readConnection: Effect.Effect<RelayCodexVmConnection, CodexVmSignInFailure>;
  readonly startAttempt: (
    payload: RelayCodexVmStartSignIn,
  ) => Effect.Effect<RelayCodexVmStartSignInResponse, CodexVmSignInFailure>;
  readonly completeAttempt: (
    payload: RelayCodexVmCompleteSignIn,
  ) => Effect.Effect<RelayCodexVmConnection, CodexVmSignInFailure>;
  readonly readAttempt: (
    attemptId: string,
  ) => Effect.Effect<RelayCodexVmSignInAttempt | null, CodexVmSignInFailure>;
  readonly cancelAttempt: (
    attemptId: string,
  ) => Effect.Effect<RelayCodexVmConnection, CodexVmSignInFailure>;
  readonly disconnect: Effect.Effect<RelayCodexVmConnection, CodexVmSignInFailure>;
  readonly openAuthorization: (url: string) => Effect.Effect<void, CodexVmSignInFailure>;
}

const revocationWarning =
  "Previous session revocation could not be confirmed. Review Launchpad in ChatGPT Settings.";
const isConnectionError = Schema.is(CodexVmConnectionError);
const isBridgeError = Schema.is(CodexVmSignInError);
const isClientError = Schema.is(CodexVmSignInClientError);
/** Transport wrappers retain typed causes; arbitrary upstream text is never UI copy. */
const knownError = (
  error: unknown,
  depth = 0,
): CodexVmConnectionError | CodexVmSignInError | CodexVmSignInClientError | null => {
  if (isConnectionError(error) || isBridgeError(error) || isClientError(error)) return error;
  return depth < 5 && typeof error === "object" && error !== null && "cause" in error
    ? knownError(error.cause, depth + 1)
    : null;
};
const failureMessage = (error: unknown) =>
  knownError(error)?.message ??
  "Could not complete Codex sign-in. Check Launchpad Connect, then retry.";
export const codexVmSignInFailure = (error: unknown): CodexVmSignInFailure =>
  knownError(error) ?? new CodexVmSignInClientError({ reason: "unavailable" });
/** Relay mutations select an organization implicitly; a stale settings card must not target another one. */
export const requireCodexVmOrganization = <E, R>(
  membership: Effect.Effect<RelayOrganizationMembership, E, R>,
  expected: {
    readonly organizationId: string;
    readonly userId: string | null | undefined;
    readonly current: () => boolean;
  },
) =>
  membership.pipe(
    Effect.flatMap((value) =>
      expected.current() &&
      value.userId === expected.userId &&
      value.organization.organizationId === expected.organizationId
        ? Effect.void
        : Effect.fail(new CodexVmSignInClientError({ reason: "signed_out" })),
    ),
  );
const cancelled = () => new CodexVmSignInError({ reason: "cancelled" });
const terminal = (attempt: RelayCodexVmSignInAttempt) =>
  !["pending", "exchanging"].includes(attempt.phase);

interface Flow {
  readonly intent: Intent;
  readonly previousConnectionId: string | null;
  bridge?: CodexVmSignInBridge;
  attempt?: RelayCodexVmSignInAttempt;
  completionDispatched: boolean;
  cancellationUnconfirmed?: boolean;
}

/** One in-memory owner prevents stale reads, callbacks and cancellation from replacing newer UI state. */
export function makeCodexVmSignInController(deps: CodexVmSignInDependencies) {
  let state: CodexVmSignInState = {
    connection: null,
    supported: null,
    loading: false,
    busy: false,
    connectionReadError: null,
    error: null,
    warning: null,
    attempt: null,
    authorizationUrl: null,
    retryable: false,
    needsPlanConfirmation: false,
  };
  let active = true,
    revision = 0;
  let flow: Flow | null = null;
  let unconfirmedRevocation = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CodexVmSignInState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const current = (owner: Flow) => active && flow === owner;
  const check = (owner: Flow) =>
    Effect.suspend(() => (current(owner) ? Effect.void : Effect.fail(cancelled())));
  const rememberWarning = (error: unknown) => {
    const known = knownError(error);
    if (known && isConnectionError(known) && known.revocationUnconfirmed)
      unconfirmedRevocation = true;
  };
  const applyConnection = (connection: RelayCodexVmConnection) => {
    const previous = state.connection;
    if (
      previous &&
      (connection.epoch < previous.epoch ||
        (connection.epoch === previous.epoch && connection.tokenRevision < previous.tokenRevision))
    )
      return;
    update({
      connection,
      connectionReadError: null,
      warning:
        unconfirmedRevocation ||
        connection.revocationUnconfirmed ||
        connection.errorCode === "revocation_unconfirmed"
          ? revocationWarning
          : null,
    });
  };
  const readConnection = (isCurrent: () => boolean) =>
    deps.readConnection.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isCurrent()) return;
          rememberWarning(error);
          update({
            connectionReadError: failureMessage(error),
            ...(unconfirmedRevocation ? { warning: revocationWarning } : {}),
          });
        }),
      ),
    );
  const closeBridge = (owner: Flow) =>
    Effect.suspend(() => {
      const bridge = owner.bridge;
      delete owner.bridge;
      return bridge
        ? deps.cancelBridge(bridge.bridgeId).pipe(Effect.timeoutOption("3 seconds"), Effect.ignore)
        : Effect.void;
    });
  const cleanup = (owner: Flow | null) =>
    owner
      ? Effect.all(
          [
            closeBridge(owner),
            owner.attempt && !terminal(owner.attempt)
              ? deps.cancelAttempt(owner.attempt.attemptId).pipe(
                  Effect.timeout("3 seconds"),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      owner.cancellationUnconfirmed = true;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
          ],
          { concurrency: "unbounded", discard: true },
        )
      : Effect.void;
  const succeed = (owner: Flow, connection: RelayCodexVmConnection) => {
    if (!current(owner) || !owner.completionDispatched) return;
    owner.completionDispatched = false;
    applyConnection(connection);
    update({
      error: null,
      retryable: false,
      authorizationUrl: null,
      needsPlanConfirmation: owner.intent === "connect" && owner.previousConnectionId === null,
    });
  };
  const recoverCompletion = (owner: Flow, started = revision) =>
    Effect.gen(function* () {
      if (!owner.attempt) return false;
      const attempt = yield* deps.readAttempt(owner.attempt.attemptId);
      const isCurrent = () => current(owner) && started === revision;
      if (!isCurrent()) return false;
      if (!attempt) return false;
      owner.attempt = attempt;
      update({ attempt, retryable: attempt.phase === "failed" });
      if (attempt.phase !== "completed") return false;
      const connection = yield* readConnection(isCurrent);
      if (!isCurrent()) return false;
      succeed(owner, connection);
      return true;
    });
  const refresh = Effect.suspend(() => {
    if (!active || state.busy) return Effect.void;
    const started = ++revision;
    update({ loading: true });
    return Effect.gen(function* () {
      const [connection, supported] = yield* Effect.all(
        [
          readConnection(() => active && started === revision).pipe(Effect.result),
          deps.capability.pipe(Effect.orElseSucceed(() => false)),
        ],
        {
          concurrency: "unbounded",
        },
      );
      if (!active || started !== revision) return;
      if (connection._tag === "Failure") {
        update({ supported });
        return;
      }
      applyConnection(connection.success);
      update({ supported, error: null });
      if (flow?.completionDispatched) yield* recoverCompletion(flow, started);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (active && started === revision) {
            rememberWarning(error);
            update({
              error: failureMessage(error),
              ...(unconfirmedRevocation ? { warning: revocationWarning } : {}),
            });
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (active && started === revision) update({ loading: false });
        }),
      ),
    );
  });

  const begin = (intent: Intent, retryAttemptId?: string) =>
    Effect.suspend(() => {
      if (!active) return Effect.void;
      const old = flow;
      const owner: Flow = {
        intent,
        previousConnectionId: state.connection?.connectionId ?? null,
        completionDispatched: false,
      };
      flow = owner;
      revision++;
      update({
        busy: true,
        loading: false,
        error: null,
        attempt: null,
        retryable: false,
        authorizationUrl: null,
      });
      return Effect.gen(function* () {
        yield* cleanup(old);
        yield* check(owner);
        const supported = yield* deps.capability.pipe(Effect.orElseSucceed(() => false));
        yield* check(owner);
        update({ supported });
        if (!supported) return yield* new CodexVmSignInError({ reason: "unsupported_surface" });
        const bridge = yield* deps.startBridge;
        owner.bridge = bridge;
        yield* check(owner);
        const response = yield* deps.startAttempt({
          state: bridge.state,
          redirectUri: bridge.redirectUri,
          intent,
          ...(retryAttemptId ? { retryAttemptId } : {}),
        });
        owner.attempt = response.attempt;
        yield* check(owner);
        update({ attempt: response.attempt });
        const url = yield* Effect.try({
          try: () => new URL(response.authorizationUrl),
          catch: () => new CodexVmConnectionError({ reason: "invalid_request" }),
        });
        if (url.origin !== "https://auth.openai.com" || url.username || url.password)
          return yield* new CodexVmConnectionError({ reason: "invalid_request" });
        yield* check(owner);
        update({ authorizationUrl: response.authorizationUrl });
        yield* deps.openAuthorization(response.authorizationUrl);
        yield* check(owner);
        const remaining =
          Math.min(Date.parse(bridge.expiresAt), Date.parse(response.attempt.expiresAt)) -
          (yield* DateTime.now).epochMilliseconds;
        if (!Number.isFinite(remaining) || remaining <= 0)
          return yield* new CodexVmSignInError({ reason: "expired" });
        const callback = yield* deps.waitBridge(bridge.bridgeId).pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () => Effect.fail(new CodexVmSignInError({ reason: "expired" })),
          }),
        );
        yield* check(owner);
        if (callback.state !== bridge.state)
          return yield* new CodexVmConnectionError({ reason: "invalid_request" });
        owner.attempt = { ...response.attempt, phase: "exchanging" };
        update({ attempt: owner.attempt, authorizationUrl: null });
        owner.completionDispatched = true;
        const connection = yield* deps
          .completeAttempt({ attemptId: response.attempt.attemptId, ...callback })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                rememberWarning(error);
                if (
                  current(owner) &&
                  (yield* recoverCompletion(owner).pipe(Effect.orElseSucceed(() => false)))
                )
                  return state.connection!;
                return yield* Effect.fail(error);
              }),
            ),
          );
        yield* check(owner);
        owner.attempt = { ...response.attempt, phase: "completed" };
        update({ attempt: owner.attempt });
        succeed(owner, connection);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!current(owner)) return;
            rememberWarning(error);
            if (!owner.completionDispatched && owner.attempt && !terminal(owner.attempt)) {
              yield* deps
                .cancelAttempt(owner.attempt.attemptId)
                .pipe(Effect.timeoutOption("3 seconds"), Effect.ignore);
              if (owner.attempt) owner.attempt = { ...owner.attempt, phase: "cancelled" };
            }
            if (current(owner))
              update({
                error: failureMessage(error),
                authorizationUrl: null,
                attempt: owner.attempt ?? null,
                retryable: owner.attempt?.phase === "failed",
                ...(unconfirmedRevocation ? { warning: revocationWarning } : {}),
              });
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* closeBridge(owner);
            if (!current(owner)) yield* cleanup(owner);
            else update({ busy: false });
          }),
        ),
        Effect.withTracerEnabled(false),
      );
    });
  const cancel = Effect.suspend(() => {
    const old = flow;
    flow = null;
    const started = ++revision;
    update({
      busy: false,
      loading: false,
      attempt: null,
      retryable: false,
      error: null,
      authorizationUrl: null,
    });
    return cleanup(old).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const connection = yield* readConnection(() => active && revision === started).pipe(
            Effect.result,
          );
          if (!active || revision !== started) return;
          if (connection._tag === "Success") applyConnection(connection.success);
          if (connection._tag === "Failure" || old?.cancellationUnconfirmed)
            update({
              error:
                "Could not confirm cancellation. Refresh to verify the current Codex connection.",
            });
        }),
      ),
    );
  });
  const retry = Effect.suspend(() => {
    if (state.busy || !state.retryable || !flow) return Effect.void;
    return begin(
      flow.intent,
      flow.attempt?.phase === "failed" ? flow.attempt.attemptId : undefined,
    );
  });
  const disconnect = Effect.suspend(() => {
    if (!active) return Effect.void;
    const old = flow;
    flow = null;
    const started = ++revision;
    update({
      busy: true,
      loading: false,
      error: null,
      attempt: null,
      retryable: false,
      authorizationUrl: null,
    });
    return Effect.gen(function* () {
      yield* cleanup(old);
      if (!active || started !== revision) return;
      yield* deps.disconnect.pipe(
        Effect.tap((connection) =>
          Effect.sync(() => {
            if (active && revision === started) applyConnection(connection);
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            rememberWarning(error);
            // A lost reply must be read back, never replayed as another disconnect.
            const connection = yield* readConnection(() => active && revision === started).pipe(
              Effect.result,
            );
            if (active && revision === started) {
              if (connection._tag === "Success") applyConnection(connection.success);
              update({
                error: failureMessage(error),
                ...(unconfirmedRevocation ? { warning: revocationWarning } : {}),
              });
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (active && revision === started) update({ busy: false });
          }),
        ),
      );
    });
  });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    connect: begin("connect"),
    reconnect: begin("reconnect"),
    replace: begin("replace"),
    retry,
    cancel,
    disconnect,
    dismissPlanConfirmation: () => update({ needsPlanConfirmation: false }),
    activate: () => {
      active = true;
      update({
        busy: false,
        loading: false,
        attempt: null,
        retryable: false,
        authorizationUrl: null,
      });
    },
    dispose: Effect.suspend(() => {
      active = false;
      state = { ...state, authorizationUrl: null };
      revision++;
      const old = flow;
      flow = null;
      return cleanup(old);
    }),
  };
}
