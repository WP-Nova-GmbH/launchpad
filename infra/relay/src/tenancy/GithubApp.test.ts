import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as RelaySecretBox from "../auth/SecretBox.ts";
import * as RelayConfiguration from "../Config.ts";
import * as GithubApp from "./GithubApp.ts";
import * as GithubAppRecords from "./GithubAppRecords.ts";

// PKCS#1, the format GitHub hands out, so the PKCS#8 wrapping is exercised.
const keyPair = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  github: {
    appId: "12345",
    appSlug: "launchpad-test",
    privateKey: Redacted.make(keyPair.privateKey),
  },
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const decodeJwtClaims = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ iss: Schema.String })),
);

function makeApp(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  options?: {
    readonly settings?: RelayConfiguration.RelayConfiguration["Service"];
    readonly record?: (seal: {
      readonly seal: (plaintext: string) => Effect.Effect<string, RelaySecretBox.SecretBoxError>;
    }) => Effect.Effect<GithubAppRecords.GithubAppRecord | null, RelaySecretBox.SecretBoxError>;
  },
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const configLayer = Layer.succeed(
    RelayConfiguration.RelayConfiguration,
    options?.settings ?? relaySettings,
  );
  const app = Effect.gen(function* () {
    const secretBox = yield* RelaySecretBox.make;
    const record = yield* options?.record?.(secretBox) ?? Effect.succeed(null);
    return yield* GithubApp.make.pipe(
      Effect.provideService(RelaySecretBox.RelaySecretBox, secretBox),
      Effect.provideService(
        GithubAppRecords.GithubAppRecords,
        GithubAppRecords.GithubAppRecords.of({
          get: Effect.succeed(record),
          save: () => Effect.die("unexpected save"),
        }),
      ),
    );
  }).pipe(
    Effect.provide(configLayer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(request, respond(request));
        }),
      ),
    ),
  );
  return { requests, app };
}

describe("GithubApp.mintInstallationToken", () => {
  it.effect("posts to the installation's access-token endpoint with an App JWT", () =>
    Effect.gen(function* () {
      const { requests, app } = makeApp(
        () =>
          new Response(
            JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-01T18:00:00Z" }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      );
      const github = yield* app;

      const minted = yield* github.mintInstallationToken({ installationId: "42" });

      expect(minted).toEqual({ token: "ghs_minted", expiresAt: "2026-09-01T18:00:00Z" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("https://api.github.com/app/installations/42/access_tokens");

      const authorization = requests[0]?.headers.authorization ?? "";
      expect(authorization.startsWith("Bearer ")).toBe(true);
      const [header, payload, signature] = authorization.slice("Bearer ".length).split(".");
      expect(
        NodeCrypto.verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          keyPair.publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      const claims = yield* decodeJwtClaims(Buffer.from(payload ?? "", "base64url").toString());
      expect(claims.iss).toBe("12345");
    }),
  );

  it.effect("uses an App created from Organization settings when configuration has none", () =>
    Effect.gen(function* () {
      const { requests, app } = makeApp(
        () =>
          new Response(JSON.stringify({ token: "ghs_from_record" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        {
          settings: { ...relaySettings, github: undefined },
          record: (secretBox) =>
            Effect.map(secretBox.seal(keyPair.privateKey), (privateKeySealed) => ({
              appId: "777",
              appSlug: "launchpad-from-settings",
              privateKeySealed,
              createdByUserId: "user-1",
              createdAt: "2026-09-01T00:00:00.000Z",
            })),
        },
      );
      const github = yield* app;

      expect(yield* github.installUrl).toBe(
        "https://github.com/apps/launchpad-from-settings/installations/new",
      );
      const minted = yield* github.mintInstallationToken({ installationId: "42" });
      expect(minted.token).toBe("ghs_from_record");
      const [, payload] = (requests[0]?.headers.authorization ?? "")
        .slice("Bearer ".length)
        .split(".");
      expect((yield* decodeJwtClaims(Buffer.from(payload ?? "", "base64url").toString())).iss).toBe(
        "777",
      );
    }),
  );

  it.effect("reports no install link when nothing is configured or stored", () =>
    Effect.gen(function* () {
      const { app } = makeApp(() => new Response(null, { status: 500 }), {
        settings: { ...relaySettings, github: undefined },
      });
      const github = yield* app;

      expect(yield* github.installUrl).toBeNull();
    }),
  );

  it.effect("describes an App by its key and refuses a key for a different App", () =>
    Effect.gen(function* () {
      const { requests, app } = makeApp(
        () =>
          new Response(
            JSON.stringify({ id: 4648576, slug: "launchpad-code", name: "Launchpad Code" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const github = yield* app;

      const described = yield* github.describe({
        appId: "4648576",
        privateKey: keyPair.privateKey,
      });
      expect(described).toEqual({
        appId: "4648576",
        appSlug: "launchpad-code",
        name: "Launchpad Code",
      });
      expect(requests[0]?.url).toBe("https://api.github.com/app");

      const mismatch = yield* github
        .describe({ appId: "1", privateKey: keyPair.privateKey })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ operation: "read-app" });
    }),
  );

  it.effect("lists every account the App is installed on", () =>
    Effect.gen(function* () {
      const { app } = makeApp(
        () =>
          new Response(
            JSON.stringify([
              {
                id: 11,
                created_at: "2026-09-01T10:00:00Z",
                account: { login: "wp-nova-gmbh", type: "Organization" },
              },
              {
                id: 12,
                created_at: "2026-09-01T11:00:00Z",
                account: { login: "customer", type: "Organization" },
              },
              { id: 13 },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const github = yield* app;

      expect(yield* github.listInstallations).toEqual([
        {
          installationId: "11",
          accountLogin: "wp-nova-gmbh",
          accountType: "Organization",
          createdAt: "2026-09-01T10:00:00Z",
        },
        {
          installationId: "12",
          accountLogin: "customer",
          accountType: "Organization",
          createdAt: "2026-09-01T11:00:00Z",
        },
      ]);
    }),
  );

  it.effect("fails when GitHub answers without a token", () =>
    Effect.gen(function* () {
      const { app } = makeApp(
        () =>
          new Response(JSON.stringify({}), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const github = yield* app;

      const error = yield* github.mintInstallationToken({ installationId: "42" }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(GithubApp.GithubRequestFailed);
      expect(error).toMatchObject({ operation: "mint-token" });
    }),
  );
});

const scopedTokenResponse = {
  token: "ghs_repository_only",
  expires_at: "2099-01-01T00:00:00Z",
  repositories: [{ full_name: "acme/project" }],
};
const decodeRepositoryTokenRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ repositories: Schema.Array(Schema.String) })),
);

describe("GithubApp.mintRepositoryToken", () => {
  it.effect("requests one repository and returns only a matching unexpired token", () =>
    Effect.gen(function* () {
      const { app, requests } = makeApp(() => Response.json(scopedTokenResponse, { status: 201 }));
      const github = yield* app;
      expect(
        yield* github.mintRepositoryToken({
          installationId: "42",
          canonicalKey: "github.com/acme/project",
        }),
      ).toEqual({
        token: scopedTokenResponse.token,
        expiresAt: scopedTokenResponse.expires_at,
      });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe("https://api.github.com/app/installations/42/access_tokens");
      expect(request.method).toBe("POST");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
      expect(decodeRepositoryTokenRequest(new TextDecoder().decode(request.body.body))).toEqual({
        repositories: ["project"],
      });
    }),
  );

  it.effect("never falls back to installation access for an empty or malformed scope", () =>
    Effect.gen(function* () {
      const { app, requests } = makeApp(() => Response.json(scopedTokenResponse));
      const github = yield* app;
      for (const canonicalKey of [
        "",
        "github.com/acme",
        "github.com/acme/",
        "github.com/acme/..",
        "github.com/acme/project/extra",
        "gitlab.com/acme/project",
      ]) {
        expect(
          yield* Effect.flip(github.mintRepositoryToken({ installationId: "42", canonicalKey })),
        ).toMatchObject({ _tag: "GithubRequestFailed" });
      }
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect(
    "rejects broad, wrong-owner, missing, expired and malformed scopes without leaking a token",
    () =>
      Effect.gen(function* () {
        for (const response of [
          { ...scopedTokenResponse, repositories: [] },
          {
            ...scopedTokenResponse,
            repositories: [...scopedTokenResponse.repositories, { full_name: "acme/other" }],
          },
          { ...scopedTokenResponse, repositories: [{ full_name: "another-owner/project" }] },
          { ...scopedTokenResponse, repositories: undefined },
          { ...scopedTokenResponse, expires_at: "1970-01-01T00:00:00Z" },
          { ...scopedTokenResponse, expires_at: "invalid" },
          { ...scopedTokenResponse, token: 42 },
        ]) {
          const { app, requests } = makeApp(() => Response.json(response));
          const github = yield* app;
          const error = yield* Effect.flip(
            github.mintRepositoryToken({
              installationId: "42",
              canonicalKey: "github.com/acme/project",
            }),
          );
          expect(error._tag).toBe("GithubRequestFailed");
          expect(String(error)).not.toContain("ghs_repository_only");
          if (error._tag === "GithubRequestFailed")
            expect(String(error.cause)).not.toContain("ghs_repository_only");
          expect(requests).toHaveLength(1);
        }
      }),
  );
});
