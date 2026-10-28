import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import type { RelayThreadVmGitMetadata } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | Effect.Effect<Response>,
  options?: {
    readonly settings?: RelayConfiguration.RelayConfiguration["Service"];
    readonly record?: (seal: {
      readonly seal: (plaintext: string) => Effect.Effect<string, RelaySecretBox.SecretBoxError>;
    }) => Effect.Effect<GithubAppRecords.GithubAppRecord | null, RelaySecretBox.SecretBoxError>;
    readonly readRecord?: GithubAppRecords.GithubAppRecords["Service"]["get"];
  },
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const configLayer = Layer.succeed(
    RelayConfiguration.RelayConfiguration,
    options?.settings ?? relaySettings,
  );
  const construction = GithubApp.make();
  const app = Effect.gen(function* () {
    const secretBox = yield* RelaySecretBox.make;
    const record = yield* options?.record?.(secretBox) ?? Effect.succeed(null);
    return yield* construction.pipe(
      Effect.provideService(RelaySecretBox.RelaySecretBox, secretBox),
      Effect.provideService(
        GithubAppRecords.GithubAppRecords,
        GithubAppRecords.GithubAppRecords.of({
          get: options?.readRecord ?? Effect.succeed(record),
          save: () => Effect.die("unexpected save"),
        }),
      ),
    );
  }).pipe(
    Effect.provide(configLayer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request);
          const response = respond(request);
          return HttpClientResponse.fromWeb(
            request,
            Effect.isEffect(response) ? yield* response : response,
          );
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
  it.effect("discards tokens when the App is removed or replaced while minting", () =>
    Effect.gen(function* () {
      for (const remove of [false, true]) {
        let current: GithubAppRecords.GithubAppRecord | null = null;
        const github = yield* makeApp(
          () => {
            current = remove ? null : { ...current!, appId: "456" };
            return Response.json(scopedTokenResponse);
          },
          {
            settings: { ...relaySettings, github: undefined },
            record: (box) =>
              box.seal(keyPair.privateKey).pipe(
                Effect.map((privateKeySealed) => {
                  current = {
                    appId: "12345",
                    appSlug: "initial",
                    privateKeySealed,
                    createdByUserId: "user",
                    createdAt: "2026-01-01T00:00:00Z",
                  };
                  return current;
                }),
              ),
            readRecord: Effect.sync(() => current),
          },
        ).app;
        const rejected = yield* github
          .mintRepositoryToken({
            installationId: "42",
            canonicalKey: "github.com/acme/project",
          })
          .pipe(Effect.flip);
        expect(rejected._tag).toBe(remove ? "GithubAppNotConfigured" : "GithubRequestFailed");
        expect(String(rejected)).not.toContain(scopedTokenResponse.token);
      }
    }),
  );

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
      expect(new TextDecoder().decode(request.body.body)).toBe('{"repositories":["project"]}');
    }),
  );

  it.effect(
    "accepts Contents-only and older installation permissions without requiring PR grants",
    () =>
      Effect.gen(function* () {
        for (const permissions of [
          { contents: "write" },
          { contents: "write", pull_requests: "read" },
        ]) {
          const { app } = makeApp(() => Response.json({ ...scopedTokenResponse, permissions }));
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
        }
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

const verifiedBot = {
  status: "ready",
  appId: "12345",
  appSlug: "actual-app",
  botUserId: 98765,
  name: "actual-app[bot]",
  email: "98765+actual-app[bot]@users.noreply.github.com",
};
const botResponse = (request: HttpClientRequest.HttpClientRequest) =>
  Response.json(
    request.url.endsWith("/app")
      ? { id: 12345, slug: "actual-app" }
      : { id: 98765, login: "actual-app[bot]", type: "Bot" },
  );

let metadataFixture = 0;

// Rebuild the exported production layer in a new scope for each HTTP request.
function makeMetadataRequests() {
  const settings = {
    ...relaySettings,
    relayIssuer: `https://request-cache-${metadataFixture++}.test`,
  };
  const services: Array<GithubApp.GithubApp["Service"]> = [];
  const clients: Array<Array<HttpClientRequest.HttpClientRequest>> = [];
  const request = (options?: {
    readonly settings?: RelayConfiguration.RelayConfiguration["Service"];
    readonly respond?: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Response | Effect.Effect<Response>;
    readonly readRecord?: GithubAppRecords.GithubAppRecords["Service"]["get"];
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let active = true;
        let metadata: RelayThreadVmGitMetadata | undefined;
        const config = options?.settings ?? settings;
        const requests: Array<HttpClientRequest.HttpClientRequest> = [];
        clients.push(requests);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            active = false;
          }),
        );
        const secretBox = yield* RelaySecretBox.make.pipe(
          Effect.provideService(RelayConfiguration.RelayConfiguration, config),
        );
        const route = HttpRouter.add(
          "GET",
          "/metadata",
          Effect.gen(function* () {
            const github = yield* GithubApp.GithubApp;
            services.push(github);
            metadata = yield* github.gitMetadata;
            return yield* HttpServerResponse.json(metadata);
          }),
        ).pipe(HttpRouter.provideRequest(GithubApp.layer));
        const handler = yield* HttpRouter.toHttpEffect(route).pipe(
          Effect.provideService(RelayConfiguration.RelayConfiguration, config),
          Effect.provideService(RelaySecretBox.RelaySecretBox, secretBox),
          Effect.provideService(
            GithubAppRecords.GithubAppRecords,
            GithubAppRecords.GithubAppRecords.of({
              get: options?.readRecord ?? Effect.succeed(null),
              save: () => Effect.die("unexpected save"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                expect(active).toBe(true);
                requests.push(request);
                const response = (options?.respond ?? botResponse)(request);
                return HttpClientResponse.fromWeb(
                  request,
                  Effect.isEffect(response) ? yield* response : response,
                );
              }),
            ),
          ),
        );
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(new URL("/metadata", config.relayIssuer))),
          ),
        );
        expect(response.status).toBe(200);
        return metadata;
      }),
    );
  return { settings, services, clients, request };
}

const storedApp = RelaySecretBox.make.pipe(
  Effect.flatMap((box) => box.seal(keyPair.privateKey)),
  Effect.map((privateKeySealed) => ({
    appId: "12345",
    appSlug: "launchpad-test",
    privateKeySealed,
    createdByUserId: "user",
    createdAt: "2026-01-01T00:00:00Z",
  })),
  Effect.provideService(RelayConfiguration.RelayConfiguration, relaySettings),
);

describe("GithubApp.gitMetadata", () => {
  it.effect("reuses exported-layer metadata across independent HTTP request scopes", () =>
    Effect.gen(function* () {
      const { services, clients, request } = makeMetadataRequests();
      expect(yield* request()).toEqual(verifiedBot);
      yield* TestClock.adjust("4 minutes");
      expect(yield* request()).toEqual(verifiedBot);
      expect(services).toHaveLength(2);
      expect(services[0]).not.toBe(services[1]);
      expect(clients.map((requests) => requests.length)).toEqual([2, 0]);
      yield* TestClock.adjust("1 minute");
      expect(
        yield* request({
          respond: (request) =>
            Response.json(
              request.url.endsWith("/app")
                ? { id: 12345, slug: "renamed-app" }
                : { id: 765, login: "renamed-app[bot]", type: "Bot" },
            ),
        }),
      ).toMatchObject({
        status: "ready",
        appSlug: "renamed-app",
        botUserId: 765,
      });
      expect(clients.map((requests) => requests.length)).toEqual([2, 0, 2]);
    }),
  );

  it.effect("expires pending entries after 30 seconds without extending on a hit", () =>
    Effect.gen(function* () {
      const { clients, request } = makeMetadataRequests();
      expect(yield* request({ respond: () => new Response(null, { status: 503 }) })).toEqual({
        status: "pending",
        appId: "12345",
      });
      yield* TestClock.adjust("29 seconds");
      expect(yield* request()).toEqual({ status: "pending", appId: "12345" });
      yield* TestClock.adjust("1 second");
      expect(yield* request()).toEqual(verifiedBot);
      expect(clients.map((requests) => requests.length)).toEqual([1, 0, 2]);
    }),
  );

  it.effect("partitions metadata by relay issuer, App id, and configured slug", () =>
    Effect.gen(function* () {
      for (const key of ["relayIssuer", "appId", "appSlug"]) {
        const { settings, clients, request } = makeMetadataRequests();
        expect(yield* request()).toEqual(verifiedBot);
        const config =
          key === "relayIssuer"
            ? { ...settings, relayIssuer: `${settings.relayIssuer}/other` }
            : {
                ...settings,
                github: { ...settings.github!, [key]: key === "appId" ? "456" : "changed-config" },
              };
        expect(
          yield* request({
            settings: config,
            respond: (request) =>
              request.url.endsWith("/app")
                ? Response.json({ id: Number(config.github!.appId), slug: "actual-app" })
                : botResponse(request),
          }),
        ).toEqual({ ...verifiedBot, appId: config.github!.appId });
        expect(clients.map((requests) => requests.length)).toEqual([2, 2]);
      }
    }),
  );

  it.effect(
    "invalidates matching-issuer cached metadata when either App read confirms removal",
    () =>
      Effect.gen(function* () {
        const record = yield* storedApp;
        for (const finalRead of [false, true]) {
          const { settings, clients, request } = makeMetadataRequests();
          const config = { ...settings, github: undefined };
          expect(yield* request()).toEqual(verifiedBot);
          let reads = 0;
          expect(
            yield* request({
              settings: config,
              readRecord: Effect.sync(() => (finalRead && ++reads === 1 ? record : null)),
            }),
          ).toEqual({ status: "unconfigured" });
          expect(yield* request({ respond: () => new Response(null, { status: 503 }) })).toEqual({
            status: "pending",
            appId: "12345",
          });
          expect(clients.map((requests) => requests.length)).toEqual([2, 0, 1]);
        }
      }),
  );

  it.effect("does not clear another issuer's public metadata when an App is removed", () =>
    Effect.gen(function* () {
      const { settings, clients, request } = makeMetadataRequests();
      expect(yield* request()).toEqual(verifiedBot);
      expect(
        yield* request({
          settings: {
            ...settings,
            relayIssuer: `${settings.relayIssuer}/other`,
            github: undefined,
          },
        }),
      ).toEqual({ status: "unconfigured" });
      expect(yield* request()).toEqual(verifiedBot);
      expect(clients.map((requests) => requests.length)).toEqual([2, 0, 0]);
    }),
  );

  it.effect("rechecks a replacement on a cache hit using the current request's storage", () =>
    Effect.gen(function* () {
      const record = yield* storedApp;
      const { settings, clients, request } = makeMetadataRequests();
      expect(
        yield* request({
          settings: { ...settings, github: undefined },
          readRecord: Effect.succeed(record),
        }),
      ).toEqual(verifiedBot);
      let reads = 0;
      expect(
        yield* request({
          settings: { ...settings, github: undefined },
          readRecord: Effect.sync(() =>
            ++reads === 1 ? record : { ...record, appId: "456", appSlug: "replacement" },
          ),
        }),
      ).toEqual({ status: "pending", appId: "456" });
      expect(reads).toBe(2);
      expect(clients.map((requests) => requests.length)).toEqual([2, 0]);
    }),
  );

  it.effect("never caches unknown state or metadata whose final App read failed", () =>
    Effect.gen(function* () {
      const record = yield* storedApp;
      for (const finalRead of [false, true]) {
        const { settings, clients, request } = makeMetadataRequests();
        let reads = 0;
        expect(
          yield* request({
            settings: { ...settings, github: undefined },
            readRecord: Effect.suspend(() =>
              finalRead && ++reads === 1
                ? Effect.succeed(record)
                : Effect.fail(
                    new GithubAppRecords.GithubAppPersistenceError({
                      operation: "load",
                      cause: "offline",
                    }),
                  ),
            ),
          }),
        ).toEqual(
          finalRead
            ? { status: "pending", appId: "12345", appSlug: "actual-app" }
            : { status: "unknown" },
        );
        expect(yield* request()).toEqual(verifiedBot);
        expect(clients.map((requests) => requests.length)).toEqual([finalRead ? 2 : 0, 2]);
      }
    }),
  );

  it.effect("verifies the actual App slug and uses its bot USER id, without minting tokens", () =>
    Effect.gen(function* () {
      const { app, requests } = makeApp(botResponse);
      const github = yield* app;
      expect(yield* github.gitMetadata).toEqual(verifiedBot);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.github.com/app",
        "https://api.github.com/users/actual-app%5Bbot%5D",
      ]);
      expect(requests[0]?.headers.authorization).toMatch(/^Bearer /);
      expect(requests[1]?.headers.authorization).toBeUndefined();
      expect(yield* github.gitMetadata).toEqual(verifiedBot);
      expect(requests).toHaveLength(2);
      // Cache hits must not extend the original expiry forever.
      yield* TestClock.adjust("4 minutes");
      expect(yield* github.gitMetadata).toEqual(verifiedBot);
      expect(requests).toHaveLength(2);
      yield* TestClock.adjust("1 minute");
      expect(yield* github.gitMetadata).toEqual(verifiedBot);
      expect(requests).toHaveLength(4);
    }),
  );

  it.effect(
    "uses configuration ahead of a stored App and verifies stored credentials otherwise",
    () =>
      Effect.gen(function* () {
        const record = (box: {
          seal: (pem: string) => Effect.Effect<string, RelaySecretBox.SecretBoxError>;
        }) =>
          box.seal(keyPair.privateKey).pipe(
            Effect.map((privateKeySealed) => ({
              appId: "777",
              appSlug: "stored-app",
              privateKeySealed,
              createdByUserId: "user",
              createdAt: "2026-01-01T00:00:00Z",
            })),
          );
        const configured = yield* makeApp(botResponse, { record }).app;
        expect(yield* configured.gitMetadata).toEqual(verifiedBot);
        const stored = yield* makeApp(
          (request) =>
            Response.json(
              request.url.endsWith("/app")
                ? { id: 777, slug: "stored-app" }
                : { id: 888, login: "stored-app[bot]", type: "Bot" },
            ),
          {
            settings: { ...relaySettings, github: undefined },
            record,
          },
        ).app;
        expect(yield* stored.gitMetadata).toMatchObject({
          status: "ready",
          appId: "777",
          botUserId: 888,
        });
      }),
  );

  it.effect("distinguishes absent, unreadable, and unresolved App metadata", () =>
    Effect.gen(function* () {
      const missing = yield* makeApp(botResponse, {
        settings: { ...relaySettings, github: undefined },
      }).app;
      expect(yield* missing.gitMetadata).toEqual({ status: "unconfigured" });
      const unreadable = yield* makeApp(botResponse, {
        settings: { ...relaySettings, github: undefined },
        readRecord: Effect.fail(
          new GithubAppRecords.GithubAppPersistenceError({ operation: "load", cause: "offline" }),
        ),
      }).app;
      expect(yield* unreadable.gitMetadata).toEqual({ status: "unknown" });
      const corrupt = yield* makeApp(botResponse, {
        settings: { ...relaySettings, github: undefined },
        readRecord: Effect.succeed({
          appId: "12345",
          appSlug: "app",
          privateKeySealed: "corrupt",
          createdByUserId: "user",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      }).app;
      expect(yield* corrupt.gitMetadata).toEqual({ status: "unknown" });
      const pending = yield* makeApp(() => new Response(null, { status: 503 })).app;
      expect(yield* pending.gitMetadata).toEqual({ status: "pending", appId: "12345" });
    }),
  );

  it.effect("never accepts a wrong App, human account, mismatched bot, or invalid user id", () =>
    Effect.gen(function* () {
      const wrong = yield* makeApp(() => Response.json({ id: 99999, slug: "wrong" })).app;
      expect(yield* wrong.gitMetadata).toEqual({ status: "pending", appId: "12345" });
      for (const invalid of [
        { id: 98765, login: "actual-app[bot]", type: "User" },
        { id: 98765, login: "another-app[bot]", type: "Bot" },
        { id: 0, login: "actual-app[bot]", type: "Bot" },
        { id: -1, login: "actual-app[bot]", type: "Bot" },
        { id: 1.5, login: "actual-app[bot]", type: "Bot" },
      ]) {
        const github = yield* makeApp((request) =>
          request.url.endsWith("/app")
            ? Response.json({ id: 12345, slug: "actual-app" })
            : Response.json(invalid),
        ).app;
        expect(yield* github.gitMetadata).toEqual({
          status: "pending",
          appId: "12345",
          appSlug: "actual-app",
        });
      }
    }),
  );

  it.effect(
    "discards an in-flight App-A result when the stored App changes to B or is removed",
    () =>
      Effect.gen(function* () {
        for (const remove of [false, true]) {
          let current: GithubAppRecords.GithubAppRecord | null = null;
          const github = yield* makeApp(
            (request) => {
              const response = botResponse(request);
              if (request.url.includes("/users/"))
                current = remove ? null : { ...current!, appId: "456", appSlug: "replacement" };
              return response;
            },
            {
              settings: { ...relaySettings, github: undefined },
              record: (box) =>
                box.seal(keyPair.privateKey).pipe(
                  Effect.map((privateKeySealed) => {
                    current = {
                      appId: "12345",
                      appSlug: "initial",
                      privateKeySealed,
                      createdByUserId: "user",
                      createdAt: "2026-01-01T00:00:00Z",
                    };
                    return current;
                  }),
                ),
              readRecord: Effect.sync(() => current),
            },
          ).app;
          expect(yield* github.gitMetadata).toEqual(
            remove ? { status: "unconfigured" } : { status: "pending", appId: "456" },
          );
        }
      }),
  );

  it.effect("reserves time to confirm a replacement App when GitHub hangs", () =>
    Effect.gen(function* () {
      let current: GithubAppRecords.GithubAppRecord | null = null,
        slowReads = false,
        reads = 0;
      const lookupEntered = yield* Deferred.make<void>();
      let readEntered = yield* Deferred.make<void>(),
        recheckEntered = yield* Deferred.make<void>();
      const { app, requests } = makeApp(
        (request) =>
          current?.appId === "456"
            ? Deferred.succeed(lookupEntered, undefined).pipe(Effect.andThen(Effect.never))
            : botResponse(request),
        {
          settings: { ...relaySettings, github: undefined },
          record: (box) =>
            box.seal(keyPair.privateKey).pipe(
              Effect.map((privateKeySealed) => {
                current = {
                  appId: "12345",
                  appSlug: "initial",
                  privateKeySealed,
                  createdByUserId: "user",
                  createdAt: "2026-01-01T00:00:00Z",
                };
                return current;
              }),
            ),
          readRecord: Effect.gen(function* () {
            if (slowReads) {
              reads++;
              yield* Deferred.succeed(reads === 1 ? readEntered : recheckEntered, undefined);
              yield* Effect.sleep("1 second");
            }
            return current;
          }),
        },
      );
      const github = yield* app;
      expect(yield* github.gitMetadata).toEqual(verifiedBot);
      current = { ...current!, appId: "456", appSlug: "replacement" };
      slowReads = true;
      const bindingMetadata = github.gitMetadata.pipe(
        Effect.timeoutOrElse({
          duration: "7 seconds",
          orElse: () => Effect.succeed({ status: "unknown" as const }),
        }),
      );
      const startedAt = (yield* DateTime.now).epochMilliseconds;
      const pending = yield* bindingMetadata.pipe(Effect.forkChild);
      yield* Deferred.await(readEntered);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(lookupEntered);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Deferred.isDone(recheckEntered)).toBe(true);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(pending)).toEqual({ status: "pending", appId: "456" });
      expect((yield* DateTime.now).epochMilliseconds - startedAt).toBe(4000);
      const requestCount = requests.length;
      reads = 0;
      readEntered = yield* Deferred.make<void>();
      recheckEntered = yield* Deferred.make<void>();
      const cached = yield* bindingMetadata.pipe(Effect.forkChild);
      yield* Deferred.await(readEntered);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(recheckEntered);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(cached)).toEqual({ status: "pending", appId: "456" });
      expect(requests).toHaveLength(requestCount);
    }),
  );

  it.effect("rechecks App replacement and removal after a hung GitHub request", () =>
    Effect.gen(function* () {
      for (const remove of [false, true]) {
        let current: GithubAppRecords.GithubAppRecord | null = null;
        const entered = yield* Deferred.make<void>();
        const github = yield* makeApp(
          () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          {
            settings: { ...relaySettings, github: undefined },
            record: (box) =>
              box.seal(keyPair.privateKey).pipe(
                Effect.map((privateKeySealed) => {
                  current = {
                    appId: "12345",
                    appSlug: "initial",
                    privateKeySealed,
                    createdByUserId: "user",
                    createdAt: "2026-01-01T00:00:00Z",
                  };
                  return current;
                }),
              ),
            readRecord: Effect.sync(() => current),
          },
        ).app;
        const pending = yield* github.gitMetadata.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        current = remove ? null : { ...current!, appId: "456", appSlug: "replacement" };
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(pending)).toEqual(
          remove ? { status: "unconfigured" } : { status: "pending", appId: "456" },
        );
      }
    }),
  );

  it.effect("reports unknown App state when storage hangs within the binding budget", () =>
    Effect.gen(function* () {
      const { app, requests } = makeApp(botResponse, {
        settings: { ...relaySettings, github: undefined },
        readRecord: Effect.never,
      });
      const github = yield* app;
      const pending = yield* github.gitMetadata.pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(pending)).toEqual({ status: "unknown" });
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect(
    "retains an observed replacement or verified rename when the final App read fails",
    () =>
      Effect.gen(function* () {
        for (const rename of [false, true]) {
          for (const timeout of [false, true]) {
            let current: GithubAppRecords.GithubAppRecord | null = null,
              changed = false,
              reads = 0;
            const entered = yield* Deferred.make<void>();
            const github = yield* makeApp(
              (request) => {
                if (!changed) return botResponse(request);
                if (rename && request.url.endsWith("/app"))
                  return Response.json({ id: 12345, slug: "renamed-app" });
                return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
              },
              {
                settings: { ...relaySettings, github: undefined },
                record: (box) =>
                  box.seal(keyPair.privateKey).pipe(
                    Effect.map((privateKeySealed) => {
                      current = {
                        appId: "12345",
                        appSlug: "initial",
                        privateKeySealed,
                        createdByUserId: "user",
                        createdAt: "2026-01-01T00:00:00Z",
                      };
                      return current;
                    }),
                  ),
                readRecord: Effect.suspend(() => {
                  if (!changed || ++reads === 1) return Effect.succeed(current);
                  return timeout
                    ? Effect.never
                    : Effect.fail(
                        new GithubAppRecords.GithubAppPersistenceError({
                          operation: "load",
                          cause: "offline",
                        }),
                      );
                }),
              },
            ).app;
            expect(yield* github.gitMetadata).toEqual(verifiedBot);
            yield* TestClock.adjust("5 minutes");
            changed = true;
            if (!rename) current = { ...current!, appId: "456", appSlug: "replacement" };
            const pending = yield* github.gitMetadata.pipe(
              Effect.timeoutOrElse({
                duration: "7 seconds",
                orElse: () => Effect.succeed({ status: "unknown" as const }),
              }),
              Effect.forkChild,
            );
            yield* Deferred.await(entered);
            yield* TestClock.adjust("2 seconds");
            if (timeout) yield* TestClock.adjust("2 seconds");
            expect(yield* Fiber.join(pending)).toEqual(
              rename
                ? { status: "pending", appId: "12345", appSlug: "renamed-app" }
                : { status: "pending", appId: "456" },
            );
          }
        }
      }),
  );

  it.effect("bounds slow optional GitHub requests", () =>
    Effect.gen(function* () {
      const github = yield* makeApp(() => Effect.never).app;
      const pending = yield* github.gitMetadata.pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(pending)).toEqual({ status: "pending", appId: "12345" });
    }),
  );
});
