import {
  bootstrapRemoteBearerSession,
  replaceDesktopSessionIdentity,
} from "@t3tools/client-runtime/authorization";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  AuthStandardClientScopes,
  type DesktopLocalSession,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
    readonly getSession: (
      backendId: string,
    ) => Effect.Effect<DesktopLocalSession, DesktopLocalEnvironmentAuthError>;
    readonly setAccount: (
      accountId: string | null,
    ) => Effect.Effect<void, DesktopLocalEnvironmentAuthError>;
    readonly attachIdentity: (input: {
      backendId: string;
      generation: number;
      token: string;
    }) => Effect.Effect<DesktopLocalSession | null, DesktopLocalEnvironmentAuthError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

/** Owns credentials for every desktop-local backend, including WSL. */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const httpClient = yield* HttpClient.HttpClient;
  const mutex = yield* Semaphore.make(1);
  const verificationMutex = yield* Semaphore.make(1);
  let accountId: string | null = null;
  let generation = 0;
  const sessions = new Map<
    string,
    {
      signature: string;
      httpBaseUrl: string;
      credential: string;
      session: DesktopLocalSession;
    }
  >();

  const bootstrap = Effect.fn("desktop.localAuth.bootstrap")(function* (
    backendId: string,
    httpBaseUrl: string,
    credential: string,
  ) {
    const access = yield* bootstrapRemoteBearerSession({
      httpBaseUrl,
      credential,
      ...(backendId === PRIMARY_LOCAL_ENVIRONMENT_ID ? {} : { scopes: AuthStandardClientScopes }),
      clientMetadata: { label: "Launchpad Desktop", deviceType: "desktop" },
    });
    return {
      token: access.access_token,
      expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1000,
      user: null,
      accountId,
      generation,
    } satisfies DesktopLocalSession;
  });

  const getSessionLocked = Effect.fn("desktop.localAuth.getSession")(function* (backendId: string) {
    const instance = (yield* pool.list).find((entry) => entry.id === backendId);
    const config = instance === undefined ? Option.none() : yield* instance.currentConfig;
    if (Option.isNone(config) || !config.value.bootstrap.desktopBootstrapToken) {
      return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
    }
    const httpBaseUrl = config.value.httpBaseUrl.href;
    const credential = config.value.bootstrap.desktopBootstrapToken;
    const signature = `${httpBaseUrl}|${credential}`;
    const cached = sessions.get(backendId);
    const now = yield* Clock.currentTimeMillis;
    if (
      cached?.signature === signature &&
      cached.session.generation === generation &&
      cached.session.expiresAtEpochMs > now + 5000
    )
      return cached.session;
    const session = yield* bootstrap(backendId, httpBaseUrl, credential);
    sessions.set(backendId, { signature, httpBaseUrl, credential, session });
    return session;
  });

  const withClient = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError((cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause })),
    );
  const getSession = (backendId: string) =>
    withClient(mutex.withPermits(1)(getSessionLocked(backendId)));

  const setAccount = Effect.fn("desktop.localAuth.setAccount")(function* (next: string | null) {
    if (accountId === next) return;
    accountId = next;
    const version = ++generation;
    yield* mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (version !== generation) return;
          for (const [backendId, cached] of sessions) {
            // No relay call here. This also invalidates an attachment currently
            // verifying the previous account: its compare-and-replace will fail.
            const detached = yield* replaceDesktopSessionIdentity({
              httpBaseUrl: cached.httpBaseUrl,
              bearerToken: cached.session.token,
              identity: null,
            }).pipe(
              Effect.map((access) => ({
                ...cached.session,
                token: access.access_token,
                user: null,
                accountId: next,
                generation: version,
              })),
              // A response may have been lost after a replacement committed. The
              // trusted bootstrap retires all sessions from this desktop backend.
              Effect.catch(() => bootstrap(backendId, cached.httpBaseUrl, cached.credential)),
              Effect.option,
            );
            if (Option.isSome(detached)) cached.session = detached.value;
            else sessions.delete(backendId);
          }
        }),
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  });

  const attachIdentity = Effect.fn("desktop.localAuth.attachIdentity")(function* (input: {
    backendId: string;
    generation: number;
    token: string;
  }) {
    return yield* verificationMutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (input.generation !== generation || accountId === null) return null;
          const expectedAccount = accountId;
          const previous = yield* getSession(input.backendId);
          if (input.generation !== generation) return null;
          if (previous.user?.userId === expectedAccount) return previous;
          const cached = sessions.get(input.backendId)!;
          // Verification deliberately runs outside the credential mutex so signing
          // out never waits for the relay. The server replaces only this exact session.
          const result = yield* replaceDesktopSessionIdentity({
            httpBaseUrl: cached.httpBaseUrl,
            bearerToken: previous.token,
            identity: { accountId: expectedAccount, token: input.token },
          }).pipe(Effect.result);
          return yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              if (input.generation !== generation || sessions.get(input.backendId) !== cached)
                return null;
              if (result._tag === "Failure") {
                // A declared verification failure happens before mutation. Keep
                // that anonymous session stable during an outage. An ambiguous
                // response needs bootstrap recovery in case replacement committed.
                if (
                  result.failure._tag !== "EnvironmentInternalError" ||
                  result.failure.reason !== "identity_verification_failed"
                ) {
                  cached.session = yield* bootstrap(
                    input.backendId,
                    cached.httpBaseUrl,
                    cached.credential,
                  );
                }
                return yield* new DesktopLocalEnvironmentAuthSessionBootstrapError({
                  cause: "Identity verification failed",
                });
              }
              cached.session = {
                ...previous,
                token: result.success.access_token,
                user: result.success.user,
              };
              return cached.session;
            }),
          );
        }),
      )
      .pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError((cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause })),
      );
  });

  return DesktopLocalEnvironmentAuth.of({
    getSession,
    setAccount,
    attachIdentity,
    getBearerToken: getSession(PRIMARY_LOCAL_ENVIRONMENT_ID).pipe(
      Effect.map((session) => session.token),
    ),
  });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
