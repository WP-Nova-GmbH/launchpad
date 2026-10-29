import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { createLocalJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const INITIAL_CLIENT_ID = "dynamic_agent_client";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
const MAX_BODY_SIZE = 65_536;
const Secret = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const CodexVmOAuthIdentity = Schema.Struct({
  issuer: Schema.Literal(ISSUER),
  subject: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.NonEmptyString),
});
export type CodexVmOAuthIdentity = typeof CodexVmOAuthIdentity.Type;

/** Private relay payload: seal before persisting; never send it to an environment. */
export const CodexVmOAuthBundle = Schema.Struct({
  accessToken: Secret,
  refreshToken: Secret,
  idToken: Secret,
  tokenType: Schema.Literal("Bearer"),
  scopes: Schema.Array(Schema.NonEmptyString),
  obtainedAt: Timestamp,
  expiresAt: Timestamp,
  earliestRefreshAt: Schema.NullOr(Timestamp),
});
export type CodexVmOAuthBundle = typeof CodexVmOAuthBundle.Type;
export const CodexVmTokenBundle = CodexVmOAuthBundle;
export type CodexVmTokenBundle = CodexVmOAuthBundle;

const Registration = Schema.Struct({
  ...CodexVmOAuthIdentity.fields,
  // An issued ID survives a failed initial exchange, before there is a verified subject.
  subject: Schema.optionalKey(Schema.NonEmptyString),
  idTokenHint: Schema.optionalKey(Secret),
});
export const CodexVmOAuthAttempt = Schema.Struct({
  stateHash: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
  callbackUri: Schema.NonEmptyString,
  hostId: Schema.NonEmptyString,
  registration: Schema.optionalKey(Registration),
});
export type CodexVmOAuthAttempt = typeof CodexVmOAuthAttempt.Type;
export const CodexVmOAuthAttemptMaterial = CodexVmOAuthAttempt;
export type CodexVmOAuthAttemptMaterial = CodexVmOAuthAttempt;

export class CodexVmOAuthError extends Schema.TaggedError<CodexVmOAuthError>()(
  "CodexVmOAuthError",
  {
    operation: Schema.Literals(["prepare", "exchange", "refresh", "revoke"]),
    reason: Schema.Literals([
      "invalid_request",
      "access_denied",
      "identity_mismatch",
      "invalid_token",
      "missing_scope",
      "invalid_grant",
      "configuration",
      "uncertain",
      "unavailable",
    ]),
    revocationUnconfirmed: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return `Codex sign-in ${this.operation} failed (${this.reason}).`;
  }
}

type Operation = CodexVmOAuthError["operation"];
const failure = (operation: Operation, reason: CodexVmOAuthError["reason"]) =>
  new CodexVmOAuthError({
    operation,
    reason,
    ...(reason === "uncertain" ? { revocationUnconfirmed: true } : {}),
  });

// Another sign-in may now own this registration. Only the coordinator can authorize revocation;
// blindly retiring a rejected response here could revoke its newer working session.
const unconfirmedSession = (error: CodexVmOAuthError) =>
  new CodexVmOAuthError({
    operation: error.operation,
    reason: error.reason,
    revocationUnconfirmed: true,
  });
const isOAuthError = Schema.is(CodexVmOAuthError);

export class CodexVmOAuth extends Context.Service<
  CodexVmOAuth,
  {
    readonly createAttempt: (input: {
      readonly state: string;
      readonly callbackUri: string;
      readonly hostId: string;
      readonly registration?: typeof Registration.Type;
    }) => Effect.Effect<
      CodexVmOAuthAttempt & { readonly authorizationUrl: string },
      CodexVmOAuthError
    >;
    readonly completeAuthorization: (input: {
      readonly attempt: CodexVmOAuthAttempt;
      readonly callback: {
        readonly state: string;
        readonly code?: string;
        readonly clientId?: string;
        readonly error?: string;
      };
    }) => Effect.Effect<
      { readonly identity: CodexVmOAuthIdentity; readonly bundle: CodexVmOAuthBundle },
      CodexVmOAuthError
    >;
    readonly refresh: (input: {
      readonly identity: CodexVmOAuthIdentity;
      readonly bundle: CodexVmOAuthBundle;
    }) => Effect.Effect<CodexVmOAuthBundle, CodexVmOAuthError>;
    readonly revoke: (input: {
      readonly clientId: string;
      readonly refreshToken: string;
    }) => Effect.Effect<{ readonly confirmed: boolean }>;
  }
>()("launchpad-relay/tenancy/CodexVmOAuth") {}

const TokenResponse = Schema.Struct({
  access_token: Secret,
  refresh_token: Secret,
  id_token: Secret,
  token_type: Schema.String,
  expires_in: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  scope: Schema.String,
  earliest_refresh_at: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
  ),
});
const Discovery = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  revocation_endpoint: Schema.String,
});
const Jwks = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeToken = Schema.decodeUnknownEffect(TokenResponse);
const decodeDiscovery = Schema.decodeUnknownEffect(Discovery);
const decodeJwks = Schema.decodeUnknownEffect(Jwks);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOAuthError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
);

const base64url = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const hashCodexVmState = (text: string) =>
  Effect.promise(async () =>
    base64url(
      new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    ),
  );
const random = (size: number) => base64url(globalThis.crypto.getRandomValues(new Uint8Array(size)));
const validClientId = (id: string) => id !== INITIAL_CLIENT_ID && /^[\x21-\x7e]{1,512}$/.test(id);
const safeEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    return url.origin === ISSUER && !url.username && !url.password && !url.hash && !url.search;
  } catch {
    return false;
  }
};
const validCallback = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === "/auth/callback" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

// Neither these errors nor their causes contain provider bodies or credentials.
const withDeadline = <A>(
  effect: Effect.Effect<A, CodexVmOAuthError>,
  operation: Operation,
  timeoutReason: () => CodexVmOAuthError["reason"] = () => "unavailable",
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(failure(operation, timeoutReason())),
    }),
    Effect.withTracerEnabled(false),
  );

export const make = Effect.gen(function* () {
  // Use the relay's raw injectable client. In particular, never wrap rotating grants in HTTP retry.
  const http = yield* HttpClient.HttpClient;

  const request = (
    outgoing: HttpClientRequest.HttpClientRequest,
    operation: Operation,
    ambiguous = false,
  ) =>
    Effect.gen(function* () {
      const response = yield* http.execute(outgoing);
      if (response.status >= 300 && response.status < 400)
        return yield* failure(operation, ambiguous ? "uncertain" : "unavailable");
      const bytes = yield* response.stream.pipe(
        Stream.catchTag("HttpClientError", (error) =>
          error.reason._tag === "EmptyBodyError" ? Stream.empty : Stream.fail(error),
        ),
        Stream.runFoldEffect(
          () => new Uint8Array(0),
          (previous, chunk) => {
            if (previous.length + chunk.length > MAX_BODY_SIZE)
              return Effect.fail(failure(operation, ambiguous ? "uncertain" : "unavailable"));
            const next = new Uint8Array(previous.length + chunk.length);
            next.set(previous);
            next.set(chunk, previous.length);
            return Effect.succeed(next);
          },
        ),
      );
      return { status: response.status, text: new TextDecoder().decode(bytes) };
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
      }),
      Effect.mapError((error) =>
        isOAuthError(error) ? error : failure(operation, ambiguous ? "uncertain" : "unavailable"),
      ),
      Effect.withTracerEnabled(false),
    );

  const discovery = (operation: Operation) =>
    Effect.gen(function* () {
      const response = yield* request(HttpClientRequest.get(DISCOVERY), operation);
      if (response.status !== 200) return yield* failure(operation, "unavailable");
      const metadata = yield* decodeJson(response.text).pipe(
        Effect.flatMap(decodeDiscovery),
        Effect.mapError(() => failure(operation, "configuration")),
      );
      if (
        metadata.issuer !== ISSUER ||
        !safeEndpoint(metadata.jwks_uri) ||
        !safeEndpoint(metadata.revocation_endpoint)
      )
        return yield* failure(operation, "configuration");
      return metadata;
    });

  const signingKeys = (operation: "exchange" | "refresh") =>
    Effect.gen(function* () {
      const metadata = yield* discovery(operation);
      const response = yield* request(HttpClientRequest.get(metadata.jwks_uri), operation);
      if (response.status !== 200) return yield* failure(operation, "unavailable");
      return yield* decodeJson(response.text).pipe(
        Effect.flatMap(decodeJwks),
        Effect.mapError(() => failure(operation, "configuration")),
      );
    });

  const exchange = (form: Readonly<Record<string, string>>, operation: "exchange" | "refresh") =>
    Effect.gen(function* () {
      const response = yield* request(
        HttpClientRequest.post(TOKEN_ENDPOINT).pipe(HttpClientRequest.bodyUrlParams(form)),
        operation,
        true,
      );
      if (response.status !== 200) {
        const error = decodeOAuthError(response.text);
        if (Option.isSome(error)) {
          if (error.value.error === "invalid_grant")
            return yield* failure(operation, "invalid_grant");
          if (
            [
              "invalid_client",
              "invalid_request",
              "unauthorized_client",
              "unsupported_grant_type",
              "invalid_scope",
              "invalid_target",
            ].includes(error.value.error)
          )
            return yield* failure(operation, "configuration");
        }
        return yield* failure(operation, "uncertain");
      }
      const body = yield* decodeJson(response.text).pipe(
        Effect.mapError(() => failure(operation, "uncertain")),
      );
      return yield* decodeToken(body).pipe(Effect.mapError(() => failure(operation, "uncertain")));
    });

  const verify = (
    token: typeof TokenResponse.Type,
    keys: typeof Jwks.Type,
    clientId: string,
    now: number,
    operation: "exchange" | "refresh",
    expected?: { readonly subject?: string; readonly nonce?: string },
  ) =>
    Effect.gen(function* () {
      if (
        token.token_type.toLowerCase() !== "bearer" ||
        !/^[\x21-\x7e]+$/.test(token.access_token) ||
        !/^[\x21-\x7e]+$/.test(token.refresh_token)
      )
        return yield* failure(operation, "invalid_token");
      const scopes = [...new Set(token.scope.split(/\s+/).filter(Boolean))];
      if (SCOPES.some((scope) => !scopes.includes(scope)))
        return yield* failure(operation, "missing_scope");
      const payload = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(
            token.id_token,
            createLocalJWKSet({ keys: keys.keys.map((key) => ({ ...key })) }),
            {
              issuer: ISSUER,
              audience: clientId,
              algorithms: ["RS256"],
              requiredClaims: ["iss", "sub", "aud", "exp"],
              currentDate: DateTime.toDate(DateTime.makeUnsafe(now)),
            },
          ),
        catch: () => failure(operation, "invalid_token"),
      });
      if (
        !payload.payload.sub ||
        (expected?.nonce !== undefined && payload.payload.nonce !== expected.nonce) ||
        (Array.isArray(payload.payload.aud) &&
          payload.payload.aud.length > 1 &&
          payload.payload.azp !== clientId)
      )
        return yield* failure(operation, "invalid_token");
      if (expected?.subject !== undefined && payload.payload.sub !== expected.subject)
        return yield* failure(operation, "identity_mismatch");
      const expiresAt = now + token.expires_in * 1000;
      let earliestRefreshAt: number | null = null;
      if (token.earliest_refresh_at !== undefined && token.earliest_refresh_at !== null) {
        const value = token.earliest_refresh_at;
        earliestRefreshAt =
          typeof value === "number"
            ? value * 1000
            : /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
              ? Date.parse(value)
              : NaN;
        if (!Number.isSafeInteger(earliestRefreshAt) || earliestRefreshAt < 0)
          return yield* failure(operation, "invalid_token");
      }
      if (
        !Number.isSafeInteger(expiresAt) ||
        (earliestRefreshAt !== null && earliestRefreshAt >= expiresAt)
      )
        return yield* failure(operation, "invalid_token");
      const identity: CodexVmOAuthIdentity = {
        issuer: ISSUER,
        subject: payload.payload.sub,
        clientId,
        ...(typeof payload.payload.email === "string" && payload.payload.email.trim()
          ? { email: payload.payload.email }
          : {}),
      };
      const bundle: CodexVmOAuthBundle = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        idToken: token.id_token,
        tokenType: "Bearer",
        scopes,
        obtainedAt: now,
        expiresAt,
        earliestRefreshAt,
      };
      return { identity, bundle };
    });

  const revoke = ({
    clientId,
    refreshToken,
  }: {
    readonly clientId: string;
    readonly refreshToken: string;
  }) =>
    withDeadline(
      Effect.gen(function* () {
        if (!validClientId(clientId) || !refreshToken)
          return yield* failure("revoke", "configuration");
        const metadata = yield* discovery("revoke");
        yield* Effect.gen(function* () {
          const response = yield* request(
            HttpClientRequest.post(metadata.revocation_endpoint).pipe(
              HttpClientRequest.bodyUrlParams({
                client_id: clientId,
                token: refreshToken,
                token_type_hint: "refresh_token",
              }),
            ),
            "revoke",
          );
          if (response.status !== 200 || response.text !== "")
            return yield* failure(
              "revoke",
              response.status >= 500 ? "unavailable" : "configuration",
            );
        }).pipe(
          Effect.retry({
            times: 1,
            schedule: Schedule.spaced("250 millis"),
            while: (error) => error.reason === "unavailable",
          }),
        );
        return { confirmed: true };
      }),
      "revoke",
    ).pipe(Effect.orElseSucceed(() => ({ confirmed: false })));

  return CodexVmOAuth.of({
    createAttempt: (input) =>
      Effect.gen(function* () {
        if (
          !validCallback(input.callbackUri) ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(input.state) ||
          !/^[\x21-\x7e]{1,256}$/.test(input.hostId) ||
          (input.registration &&
            (input.registration.issuer !== ISSUER || !validClientId(input.registration.clientId)))
        )
          return yield* failure("prepare", "invalid_request");
        const nonce = random(32);
        const codeVerifier = random(64);
        const stateHash = yield* hashCodexVmState(input.state);
        const url = new URL(AUTHORIZE);
        url.search = new URLSearchParams({
          client_id: input.registration?.clientId ?? INITIAL_CLIENT_ID,
          ext_agent_host_id: input.hostId,
          ...(!input.registration ? { agent_name_hint: "Launchpad" } : {}),
          ...(input.registration?.idTokenHint
            ? { id_token_hint: input.registration.idTokenHint }
            : {}),
          ...(input.registration?.email ? { login_hint: input.registration.email } : {}),
          response_type: "code",
          redirect_uri: input.callbackUri,
          scope: SCOPES.join(" "),
          resource: RESOURCE,
          state: input.state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: yield* hashCodexVmState(codeVerifier),
        }).toString();
        return {
          stateHash,
          nonce,
          codeVerifier,
          callbackUri: input.callbackUri,
          hostId: input.hostId,
          ...(input.registration ? { registration: input.registration } : {}),
          authorizationUrl: url.href,
        };
      }).pipe(Effect.withTracerEnabled(false)),
    completeAuthorization: ({ attempt, callback }) =>
      Effect.suspend(() => {
        let dispatched = false;
        return withDeadline(
          Effect.gen(function* () {
            if (
              !/^[A-Za-z0-9_-]{43,128}$/.test(callback.state) ||
              (yield* hashCodexVmState(callback.state)) !== attempt.stateHash ||
              !validCallback(attempt.callbackUri)
            )
              return yield* failure("exchange", "invalid_request");
            if (callback.error)
              return yield* failure(
                "exchange",
                callback.error === "access_denied" ? "access_denied" : "invalid_request",
              );
            const clientId = callback.clientId ?? attempt.registration?.clientId;
            if (
              !clientId ||
              !validClientId(clientId) ||
              !callback.code ||
              callback.code.length > 8192
            )
              return yield* failure("exchange", "invalid_request");
            if (attempt.registration && clientId !== attempt.registration.clientId)
              return yield* failure("exchange", "identity_mismatch");
            const keys = yield* signingKeys("exchange");
            dispatched = true;
            const token = yield* exchange(
              {
                grant_type: "authorization_code",
                client_id: clientId,
                code: callback.code,
                code_verifier: attempt.codeVerifier,
                redirect_uri: attempt.callbackUri,
                resource: RESOURCE,
              },
              "exchange",
            );
            const now = (yield* DateTime.now).epochMilliseconds;
            return yield* verify(token, keys, clientId, now, "exchange", {
              ...(attempt.registration?.subject ? { subject: attempt.registration.subject } : {}),
              nonce: attempt.nonce,
            }).pipe(Effect.mapError(unconfirmedSession));
          }),
          "exchange",
          () => (dispatched ? "uncertain" : "unavailable"),
        );
      }),
    refresh: ({ identity, bundle }) =>
      Effect.suspend(() => {
        let dispatched = false;
        return withDeadline(
          Effect.gen(function* () {
            if (identity.issuer !== ISSUER || !validClientId(identity.clientId))
              return yield* failure("refresh", "configuration");
            const keys = yield* signingKeys("refresh");
            dispatched = true;
            const token = yield* exchange(
              {
                grant_type: "refresh_token",
                client_id: identity.clientId,
                refresh_token: bundle.refreshToken,
                resource: RESOURCE,
              },
              "refresh",
            );
            const now = (yield* DateTime.now).epochMilliseconds;
            return (yield* verify(token, keys, identity.clientId, now, "refresh", {
              subject: identity.subject,
            }).pipe(Effect.mapError(unconfirmedSession))).bundle;
          }),
          "refresh",
          () => (dispatched ? "uncertain" : "unavailable"),
        );
      }),
    revoke,
  });
});

export const layer = Layer.effect(CodexVmOAuth, make);
