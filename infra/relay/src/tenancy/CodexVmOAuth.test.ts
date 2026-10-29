import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { importPKCS8, SignJWT } from "jose";

import * as OAuth from "./CodexVmOAuth.ts";

const issuer = "https://auth.openai.com";
const clientId = "oaiapp_synthetic_client";
const state = "s".repeat(43);
const callbackUri = "http://127.0.0.1:54321/auth/callback";
const identity: OAuth.CodexVmOAuthIdentity = { issuer, subject: "verified-subject", clientId };
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const pair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = importPKCS8(
  String(pair.privateKey.export({ type: "pkcs8", format: "pem" })),
  "RS256",
);
const publicKey = { ...pair.publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test-key" };

function tokenResponse(nonce: string, overrides?: { readonly claims?: Record<string, unknown> }) {
  return Effect.promise(async () => ({
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    id_token: await new SignJWT({
      iss: issuer,
      sub: identity.subject,
      aud: clientId,
      exp: 3600,
      iat: 0,
      nonce,
      email: "member@example.test",
      ...overrides?.claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(await privateKey),
    token_type: "Bearer",
    expires_in: 3600,
    earliest_refresh_at: 1800,
    scope: scopes,
  }));
}

const bundle: OAuth.CodexVmOAuthBundle = {
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token-canary",
  idToken: "old-id-token-canary",
  tokenType: "Bearer",
  scopes: scopes.split(" "),
  obtainedAt: 0,
  expiresAt: 1000,
  earliestRefreshAt: null,
};

function fixture(options?: {
  readonly metadata?: object;
  readonly discovery?: () => Effect.Effect<Response>;
  readonly token?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>;
  readonly revoke?: () => Effect.Effect<Response>;
}) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const fetchOptions: globalThis.RequestInit[] = [];
  let token: unknown = {};
  const service = OAuth.make.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request);
          fetchOptions.push(
            Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({})),
          );
          let response: Response;
          if (request.url.endsWith("/.well-known/openid-configuration")) {
            response = options?.discovery
              ? yield* options.discovery()
              : Response.json(
                  options?.metadata ?? {
                    issuer,
                    jwks_uri: `${issuer}/.well-known/jwks.json`,
                    revocation_endpoint: `${issuer}/oauth/revoke`,
                  },
                );
          } else if (request.url.endsWith("/.well-known/jwks.json")) {
            response = Response.json({ keys: [publicKey] });
          } else if (request.url.endsWith("/oauth/revoke")) {
            response = options?.revoke
              ? yield* options.revoke()
              : new Response(null, { status: 200 });
          } else {
            response = options?.token ? yield* options.token(request) : Response.json(token);
          }
          return HttpClientResponse.fromWeb(request, response);
        }),
      ),
    ),
  );
  return { requests, fetchOptions, service, setToken: (value: unknown) => (token = value) };
}

const encodeError = Schema.encodeEffect(Schema.fromJsonString(OAuth.CodexVmOAuthError));

const form = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  expect(request?.body._tag).toBe("Uint8Array");
  if (request?.body._tag !== "Uint8Array") throw new Error("expected form body");
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body.body)));
};
const attemptInput = { state, callbackUri, hostId: "urn:uuid:stable-installation-host" };

describe("CodexVmOAuth", () => {
  it.effect("prepares dynamic registration with fresh PKCE and bridge-owned state", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const first = yield* oauth.createAttempt(attemptInput);
      const second = yield* oauth.createAttempt(attemptInput);
      const url = new URL(first.authorizationUrl);
      expect(url.origin + url.pathname).toBe(`${issuer}/api/accounts/authorize`);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: "dynamic_agent_client",
        agent_name_hint: "Launchpad",
        ext_agent_host_id: attemptInput.hostId,
        state,
        nonce: first.nonce,
        code_challenge_method: "S256",
        code_challenge: yield* OAuth.hashCodexVmState(first.codeVerifier),
        redirect_uri: callbackUri,
        resource: "https://api.openai.com/v1",
      });
      expect(first.stateHash).toBe(yield* OAuth.hashCodexVmState(state));
      expect(first.nonce).not.toBe(second.nonce);
      expect(first.codeVerifier).not.toBe(second.codeVerifier);
      expect(f.requests).toHaveLength(0);
    }),
  );

  it.effect("reauthorizes the issued registration with bound hints", () =>
    Effect.gen(function* () {
      const oauth = yield* fixture().service;
      const attempt = yield* oauth.createAttempt({
        ...attemptInput,
        registration: {
          ...identity,
          email: "member@example.test",
          idTokenHint: "retained-id-token",
        },
      });
      const params = new URL(attempt.authorizationUrl).searchParams;
      expect(params.get("client_id")).toBe(clientId);
      expect(params.has("agent_name_hint")).toBe(false);
      expect(params.get("id_token_hint")).toBe("retained-id-token");
      expect(params.get("login_hint")).toBe("member@example.test");
    }),
  );

  it.effect(
    "reuses an issued registration after a failed first exchange without inventing a subject",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const oauth = yield* f.service;
        const attempt = yield* oauth.createAttempt({
          ...attemptInput,
          registration: { issuer, clientId },
        });
        const params = new URL(attempt.authorizationUrl).searchParams;
        expect(params.get("client_id")).toBe(clientId);
        expect(params.has("agent_name_hint")).toBe(false);
        f.setToken(yield* tokenResponse(attempt.nonce));
        const connected = yield* oauth.completeAuthorization({
          attempt,
          callback: { state, code: "retry-code" },
        });
        expect(connected.identity.subject).toBe(identity.subject);
        expect(form(f.requests.at(-1)).client_id).toBe(clientId);
      }),
  );

  for (const uri of [
    "http://localhost:54321/auth/callback",
    "https://127.0.0.1:54321/auth/callback",
    "http://127.0.0.1:54321/callback",
    "http://127.0.0.1:54321/auth/callback?token=canary",
  ]) {
    it.effect(`rejects a noncanonical loopback callback: ${uri}`, () =>
      Effect.gen(function* () {
        const oauth = yield* fixture().service;
        expect(
          (yield* oauth.createAttempt({ ...attemptInput, callbackUri: uri }).pipe(Effect.flip))
            .reason,
        ).toBe("invalid_request");
      }),
    );
  }

  it.effect("exchanges once with issued client ID and verifies the signed identity", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt(attemptInput);
      f.setToken(yield* tokenResponse(attempt.nonce));
      const result = yield* oauth.completeAuthorization({
        attempt,
        callback: { state, code: "code-canary", clientId },
      });
      expect(result.identity).toEqual({ ...identity, email: "member@example.test" });
      expect(result.bundle).toMatchObject({
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        expiresAt: 3_600_000,
        earliestRefreshAt: 1_800_000,
        obtainedAt: 0,
      });
      expect(form(f.requests.at(-1))).toEqual({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "code-canary",
        code_verifier: attempt.codeVerifier,
        redirect_uri: callbackUri,
        resource: "https://api.openai.com/v1",
      });
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(
        f.fetchOptions.every((init) => init.redirect === "error" && init.credentials === "omit"),
      ).toBe(true);
    }),
  );

  it.effect("requires the issued initial client and validates state before denied callbacks", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt(attemptInput);
      for (const callback of [
        { state, code: "code-canary" },
        { state, code: "code-canary", clientId: "dynamic_agent_client" },
        { state: "different".repeat(6), error: "access_denied" },
      ]) {
        expect(
          (yield* oauth.completeAuthorization({ attempt, callback }).pipe(Effect.flip)).reason,
        ).toBe("invalid_request");
      }
      expect(
        (yield* oauth
          .completeAuthorization({ attempt, callback: { state, error: "access_denied" } })
          .pipe(Effect.flip)).reason,
      ).toBe("access_denied");
      expect(f.requests).toHaveLength(0);
    }),
  );

  it.effect("allows omitted returning client ID and rejects replacement registrations", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt({ ...attemptInput, registration: identity });
      f.setToken(yield* tokenResponse(attempt.nonce));
      expect(
        (yield* oauth.completeAuthorization({ attempt, callback: { state, code: "code-canary" } }))
          .identity.clientId,
      ).toBe(clientId);
      const count = f.requests.length;
      expect(
        (yield* oauth
          .completeAuthorization({
            attempt,
            callback: { state, code: "code-canary", clientId: "oaiapp_other" },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("identity_mismatch");
      expect(f.requests).toHaveLength(count);
      f.setToken(yield* tokenResponse(attempt.nonce, { claims: { sub: "other-subject" } }));
      expect(
        (yield* oauth
          .completeAuthorization({ attempt, callback: { state, code: "code-canary" } })
          .pipe(Effect.flip)).reason,
      ).toBe("identity_mismatch");
    }),
  );

  for (const claims of [
    { iss: "https://untrusted.example" },
    { aud: "oaiapp_other" },
    { exp: -1 },
    { nonce: "other-nonce" },
    { sub: "" },
    { aud: [clientId, "other-client"], azp: "other-client" },
  ]) {
    it.effect(`rejects invalid signed ID-token claims ${Object.keys(claims).join(",")}`, () =>
      Effect.gen(function* () {
        const f = fixture();
        const oauth = yield* f.service;
        const attempt = yield* oauth.createAttempt(attemptInput);
        f.setToken(yield* tokenResponse(attempt.nonce, { claims }));
        const error = yield* oauth
          .completeAuthorization({ attempt, callback: { state, code: "code-canary", clientId } })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid_token");
        expect(String(error)).not.toContain("code-canary");
      }),
    );
  }

  it.effect("rejects a forged signature and absent plan permission", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt(attemptInput);
      const token = yield* tokenResponse(attempt.nonce);
      f.setToken({ ...token, id_token: token.id_token.slice(0, -10) + "forged" });
      expect(
        (yield* oauth
          .completeAuthorization({ attempt, callback: { state, code: "code", clientId } })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid_token");
      f.setToken({ ...token, scope: "openid profile email offline_access resource.invoke" });
      expect(
        (yield* oauth
          .completeAuthorization({ attempt, callback: { state, code: "code", clientId } })
          .pipe(Effect.flip)).reason,
      ).toBe("missing_scope");
    }),
  );

  it.effect(
    "renews once without a scope replacement and retains the complete rotating bundle",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const oauth = yield* f.service;
        f.setToken(yield* tokenResponse("not-required-on-refresh"));
        const refreshed = yield* oauth.refresh({ identity, bundle });
        expect(form(f.requests.at(-1))).toEqual({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: bundle.refreshToken,
          resource: "https://api.openai.com/v1",
        });
        expect(refreshed.refreshToken).toBe("synthetic-refresh-token");
        expect(refreshed.idToken).not.toBe(bundle.idToken);
        expect(refreshed.expiresAt).toBe(3_600_000);
        expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      }),
  );

  for (const response of [
    new Response('{"error":"invalid_grant","error_description":"old-refresh-token-canary"}', {
      status: 400,
    }),
    new Response('{"error":"invalid_client"}', { status: 401 }),
    new Response("body-canary", { status: 502 }),
    new Response("not-json-canary", { status: 200 }),
    Response.json({ access_token: "missing-replacement-token-canary" }),
  ]) {
    it.effect(
      `classifies grant failure ${response.status} without retrying or exposing bodies`,
      () =>
        Effect.gen(function* () {
          const f = fixture({ token: () => Effect.succeed(response.clone()) });
          const oauth = yield* f.service;
          const error = yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip);
          expect(error.reason).toBe(
            response.status === 400
              ? "invalid_grant"
              : response.status === 401
                ? "configuration"
                : "uncertain",
          );
          expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
          expect(yield* encodeError(error)).not.toContain("canary");
          expect("cause" in error).toBe(false);
        }),
    );
  }

  it.effect("treats lost grant responses as uncertain and never repeats the exchange", () =>
    Effect.gen(function* () {
      const f = fixture({
        token: (request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: "secret-transport-canary",
              }),
            }),
          ),
      });
      const oauth = yield* f.service;
      const error = yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip);
      expect(error.reason).toBe("uncertain");
      expect(yield* encodeError(error)).not.toContain("canary");
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    }),
  );

  it.effect("keeps a preflight outage retryable because no grant was dispatched", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const f = fixture({
        discovery: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const oauth = yield* f.service;
      const work = yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(work);
      expect(error.reason).toBe("unavailable");
      expect(error.revocationUnconfirmed).toBeUndefined();
      expect(f.requests.some((request) => request.method === "POST")).toBe(false);
    }),
  );

  it.effect("bounds an unanswered dispatched grant with the Effect clock", () =>
    Effect.gen(function* () {
      const dispatched = yield* Deferred.make<void>();
      const f = fixture({
        token: () => Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const oauth = yield* f.service;
      const work = yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(work)).reason).toBe("uncertain");
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    }),
  );

  it.effect("rejects oversized responses without retaining the secret body", () =>
    Effect.gen(function* () {
      const f = fixture({
        token: () => Effect.succeed(new Response("secret-canary".repeat(10_000))),
      });
      const oauth = yield* f.service;
      const error = yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip);
      expect(error.reason).toBe("uncertain");
      expect(yield* encodeError(error)).not.toContain("canary");
    }),
  );

  it.effect("revokes through trusted discovery and accepts an empty HTTP200", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      expect(yield* oauth.revoke({ clientId, refreshToken: bundle.refreshToken })).toEqual({
        confirmed: true,
      });
      expect(form(f.requests.at(-1))).toEqual({
        token: bundle.refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      });
    }),
  );

  it.effect("retries transient revocation once within its bounded budget", () =>
    Effect.gen(function* () {
      const dispatched = yield* Deferred.make<void>();
      let tries = 0;
      const f = fixture({
        revoke: () =>
          Effect.gen(function* () {
            tries++;
            if (tries === 1) {
              yield* Deferred.succeed(dispatched, undefined);
              return new Response(null, { status: 503 });
            }
            return new Response(null, { status: 200 });
          }),
      });
      const oauth = yield* f.service;
      const work = yield* oauth
        .revoke({ clientId, refreshToken: bundle.refreshToken })
        .pipe(Effect.forkChild);
      yield* Deferred.await(dispatched);
      yield* TestClock.adjust("250 millis");
      expect(yield* Fiber.join(work)).toEqual({ confirmed: true });
      expect(tries).toBe(2);
    }),
  );

  it.effect("flags a rejected session without revoking a potentially newer registration", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt(attemptInput);
      f.setToken(yield* tokenResponse("wrong-nonce"));
      const error = yield* oauth
        .completeAuthorization({ attempt, callback: { state, code: "code", clientId } })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid_token");
      expect(error.revocationUnconfirmed).toBe(true);
      expect(f.requests.some((request) => request.url.endsWith("/oauth/revoke"))).toBe(false);
    }),
  );

  it.effect("reports unconfirmed remote state without exposing rejected grant credentials", () =>
    Effect.gen(function* () {
      const f = fixture({
        revoke: () => Effect.succeed(new Response("unconfirmed-response-canary", { status: 400 })),
      });
      const oauth = yield* f.service;
      const attempt = yield* oauth.createAttempt(attemptInput);
      f.setToken(yield* tokenResponse("wrong-nonce"));
      const error = yield* oauth
        .completeAuthorization({ attempt, callback: { state, code: "code", clientId } })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid_token");
      expect(error.revocationUnconfirmed).toBe(true);
      expect(yield* encodeError(error)).not.toContain("canary");
    }),
  );

  it.effect("rejects refresh timing at or after expiry without revoking a different owner", () =>
    Effect.gen(function* () {
      const f = fixture();
      const oauth = yield* f.service;
      f.setToken({ ...(yield* tokenResponse("nonce")), earliest_refresh_at: 3600 });
      expect((yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip)).reason).toBe(
        "invalid_token",
      );
      expect(f.requests.some((request) => request.url.endsWith("/oauth/revoke"))).toBe(false);
    }),
  );

  it.effect("does not send credentials to discovered cross-origin endpoints", () =>
    Effect.gen(function* () {
      const f = fixture({
        metadata: {
          issuer,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          revocation_endpoint: "https://attacker.example/revoke",
        },
      });
      const oauth = yield* f.service;
      expect(yield* oauth.revoke({ clientId, refreshToken: bundle.refreshToken })).toEqual({
        confirmed: false,
      });
      expect(f.requests).toHaveLength(1);
      expect((yield* oauth.refresh({ identity, bundle }).pipe(Effect.flip)).reason).toBe(
        "configuration",
      );
      expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    }),
  );
});
