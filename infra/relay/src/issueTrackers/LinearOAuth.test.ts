import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fixture } from "./Connections.test-fixture.ts";
import {
  beginLinearOAuth,
  exchangeLinearCode,
  refreshLinearTokens,
  LINEAR_MCP_RESOURCE,
} from "./LinearOAuth.ts";

const issuer = "https://mcp.linear.app";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  authorization_response_iss_parameter_supported: true,
};
const client = { client_id: "dynamic-client", token_endpoint_auth_method: "none" as const };
const pending = {
  server: { ...metadata, authorization_response_iss_parameter_supported: true as const },
  client,
  redirectUri: "https://relay.test/v1/organization/issue-trackers/linear/callback",
  codeVerifier: "private-verifier",
};
const tokens = {
  access_token: "private-access",
  refresh_token: "private-refresh",
  expires_in: 3600,
  token_type: "Bearer",
  scope: "read",
};
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      scope: Schema.String,
      redirect_uris: Schema.Array(Schema.String),
      token_endpoint_auth_method: Schema.String,
    }),
  ),
);

function response(url: string) {
  if (url === `${issuer}/.well-known/oauth-protected-resource/mcp/readonly`)
    return Response.json({
      resource: LINEAR_MCP_RESOURCE,
      authorization_servers: [issuer],
      scopes_supported: ["read", "write"],
    });
  if (url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json(metadata);
  if (url === `${issuer}/register`)
    return Response.json({ ...client, redirect_uris: [pending.redirectUri] }, { status: 201 });
  if (url === `${issuer}/token`) return Response.json(tokens);
  return new Response(null, { status: 404 });
}

describe("Linear MCP OAuth", () => {
  it.effect("dynamically registers a read-only PKCE client without configured credentials", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: (request) => Effect.succeed(response(request.url)),
      });
      const started = yield* beginLinearOAuth({
        redirectUri: pending.redirectUri,
        state: "private-state",
      }).pipe(test.provide);
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
      expect(url.searchParams.get("scope")).toBe("read");
      expect(url.searchParams.get("resource")).toBe(LINEAR_MCP_RESOURCE);
      expect(url.searchParams.get("state")).toBe("private-state");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
      expect(started.pending.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(url.searchParams.has("code_verifier")).toBe(false);
      const registration = test.requests.find((request) => request.url === `${issuer}/register`)!;
      if (registration.body._tag !== "Uint8Array") throw new Error("Missing registration body");
      expect(decodeRegistration(new TextDecoder().decode(registration.body.body))).toEqual({
        scope: "read",
        redirect_uris: [pending.redirectUri],
        token_endpoint_auth_method: "none",
      });
      expect(started.pending.client).toEqual(client);
    }),
  );

  it.effect("exchanges a code bound to the discovered issuer, verifier and resource", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: (request) => Effect.succeed(response(request.url)),
      });
      expect(
        yield* exchangeLinearCode({ ...pending, code: "private-code", iss: issuer }).pipe(
          test.provide,
        ),
      ).toEqual({
        accessToken: "private-access",
        refreshToken: "private-refresh",
        expiresIn: 3600,
      });
      const request = test.requests[0]!;
      expect(request.url).toBe(`${issuer}/token`);
      if (request.body._tag !== "Uint8Array") throw new Error("Missing token request");
      const fields = new URLSearchParams(new TextDecoder().decode(request.body.body));
      expect(fields.get("code_verifier")).toBe(pending.codeVerifier);
      expect(fields.get("resource")).toBe(LINEAR_MCP_RESOURCE);
      expect(fields.get("client_secret")).toBeNull();
    }),
  );

  it.effect("rejects missing or foreign callback issuers before exchanging credentials", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: (request) => Effect.succeed(response(request.url)),
      });
      for (const iss of [undefined, "https://attacker.example"]) {
        yield* exchangeLinearCode({
          ...pending,
          code: "private-code",
          ...(iss ? { iss } : {}),
        }).pipe(test.provide, Effect.flip);
      }
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("rejects foreign discovery endpoints before registration", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: (request) =>
          Effect.succeed(
            request.url.endsWith("oauth-authorization-server")
              ? Response.json({ ...metadata, token_endpoint: "https://attacker.example/token" })
              : response(request.url),
          ),
      });
      yield* beginLinearOAuth({ redirectUri: pending.redirectUri, state: "state" }).pipe(
        test.provide,
        Effect.flip,
      );
      expect(test.requests).toHaveLength(2);
    }),
  );

  it.effect("refreshes without opening authorization and retains a non-rotated refresh token", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: () => Effect.succeed(Response.json({ ...tokens, refresh_token: undefined })),
      });
      expect(
        yield* refreshLinearTokens({ oauth: pending, refreshToken: "previous-refresh" }).pipe(
          test.provide,
        ),
      ).toMatchObject({ accessToken: "private-access", refreshToken: "previous-refresh" });
      expect(test.requests.map((request) => request.url)).toEqual([`${issuer}/token`]);
    }),
  );

  it.effect("rejects write grants and missing initial refresh tokens", () =>
    Effect.gen(function* () {
      for (const payload of [
        { ...tokens, scope: "read write" },
        { ...tokens, refresh_token: undefined },
      ]) {
        const test = yield* fixture({
          rawHttp: true,
          respond: () => Effect.succeed(Response.json(payload)),
        });
        yield* exchangeLinearCode({ ...pending, code: "code", iss: issuer }).pipe(
          test.provide,
          Effect.flip,
        );
      }
    }),
  );

  it.effect("maps revocation to reconnect without interactive fallback", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        rawHttp: true,
        respond: () =>
          Effect.succeed(
            Response.json(
              { error: "invalid_grant", error_description: "private-upstream-content" },
              { status: 400 },
            ),
          ),
      });
      expect(
        yield* refreshLinearTokens({ oauth: pending, refreshToken: "refresh" }).pipe(
          test.provide,
          Effect.flip,
        ),
      ).toMatchObject({ code: "auth_required" });
      expect(test.requests).toHaveLength(1);
    }),
  );
});
