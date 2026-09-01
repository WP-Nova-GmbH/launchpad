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
