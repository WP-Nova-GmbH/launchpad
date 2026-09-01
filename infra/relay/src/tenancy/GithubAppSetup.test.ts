import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as RelaySecretBox from "../auth/SecretBox.ts";
import * as RelayConfiguration from "../Config.ts";
import * as GithubAppRecords from "./GithubAppRecords.ts";
import * as GithubAppSetup from "./GithubAppSetup.ts";

const mintKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test/",
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
  cloudMintPrivateKey: Redacted.make(mintKeyPair.privateKey),
  cloudMintPublicKey: mintKeyPair.publicKey,
  github: undefined,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const configLayer = Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings);

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      redirect_url: Schema.String,
      setup_url: Schema.String,
      default_permissions: Schema.Struct({ contents: Schema.String, pull_requests: Schema.String }),
    }),
  ),
);

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const saved: Array<GithubAppRecords.GithubAppRecord> = [];
  const records = GithubAppRecords.GithubAppRecords.of({
    get: Effect.sync(() => saved[0] ?? null),
    save: (input) =>
      Effect.sync(() => {
        const record = { ...input, createdAt: "2026-09-01T00:00:00.000Z" };
        saved.push(record);
        return record;
      }),
  });
  const setup = Effect.gen(function* () {
    const secretBox = yield* RelaySecretBox.make;
    const service = yield* GithubAppSetup.make.pipe(
      Effect.provideService(RelaySecretBox.RelaySecretBox, secretBox),
      Effect.provideService(GithubAppRecords.GithubAppRecords, records),
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
    return { service, secretBox };
  }).pipe(Effect.provide(Layer.mergeAll(configLayer, cryptoLayer)));
  return { requests, saved, setup };
}

const noGithub = () => new Response(null, { status: 500 });

const beginInput = {
  userId: "user-1",
  organizationId: "organization-1",
  returnUrl: "https://app.example.test/settings/organization",
  githubOrganization: "acme",
};

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

describe("GithubAppSetup", () => {
  it.effect("starts on a relay page whose manifest points GitHub back at the relay", () =>
    Effect.gen(function* () {
      const { setup } = harness(noGithub);
      const { service } = yield* setup;

      const begun = yield* service.begin(beginInput);
      expect(
        begun.startUrl.startsWith(
          "https://relay.example.test/v1/organization/github-app/start?state=",
        ),
      ).toBe(true);

      const start = yield* service.renderStart(stateOf(begun.startUrl));
      expect(
        start.action.startsWith("https://github.com/organizations/acme/settings/apps/new?state="),
      ).toBe(true);
      expect(start.claims).toEqual({
        userId: "user-1",
        organizationId: "organization-1",
        returnUrl: beginInput.returnUrl,
      });
      const manifest = yield* decodeManifest(start.manifest);
      expect(manifest.name).toBe("Launchpad");
      expect(manifest.redirect_url).toBe(
        "https://relay.example.test/v1/organization/github-app/created",
      );
      // GitHub needs an https setup URL; the desktop app has none, so the relay is it.
      expect(manifest.setup_url).toBe(
        "https://relay.example.test/v1/organization/github-app/installed",
      );
      expect(manifest.default_permissions).toEqual({ contents: "write", pull_requests: "write" });
    }),
  );

  it.effect("reads back the claims it signed, and refuses a forged or mistyped state", () =>
    Effect.gen(function* () {
      const { setup } = harness(noGithub);
      const { service } = yield* setup;
      const state = stateOf((yield* service.begin(beginInput)).startUrl);

      expect(yield* service.readState(state)).toEqual({
        userId: "user-1",
        organizationId: "organization-1",
        returnUrl: beginInput.returnUrl,
      });
      const forged = yield* service.readState(`${state.slice(0, -3)}xyz`).pipe(Effect.flip);
      expect(forged).toBeInstanceOf(GithubAppSetup.GithubAppSetupStateInvalid);
      // A setup state is not an install state, however valid its signature.
      const mistyped = yield* service.readInstallState(state).pipe(Effect.flip);
      expect(mistyped).toBeInstanceOf(GithubAppSetup.GithubAppSetupStateInvalid);
    }),
  );

  it.effect("accepts the desktop app as a return address but nothing exotic", () =>
    Effect.gen(function* () {
      const { setup } = harness(noGithub);
      const { service } = yield* setup;

      const desktop = yield* service.begin({ ...beginInput, returnUrl: "t3code://app/settings" });
      expect(desktop.startUrl).toContain("state=");
      expect(GithubAppSetup.isDesktopReturnUrl("t3code://app/settings")).toBe(true);
      expect(GithubAppSetup.isDesktopReturnUrl(beginInput.returnUrl)).toBe(false);

      for (const returnUrl of [
        "javascript:alert(1)",
        "https://user:secret@app.example.test/",
        "nope",
      ]) {
        const error = yield* service.begin({ ...beginInput, returnUrl }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(GithubAppSetup.GithubAppSetupReturnUrlInvalid);
      }
    }),
  );

  it.effect("converts GitHub's code, stores the App sealed, and hands on the install page", () =>
    Effect.gen(function* () {
      const { requests, saved, setup } = harness(
        () =>
          new Response(JSON.stringify({ id: 77, slug: "launchpad-acme", pem: "PEM-BODY" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
      const { service, secretBox } = yield* setup;
      const claims = {
        userId: "user-1",
        organizationId: "organization-1",
        returnUrl: beginInput.returnUrl,
      };

      const created = yield* service.complete({ code: "code-123", claims });

      expect(created.appSlug).toBe("launchpad-acme");
      expect(
        created.installUrl.startsWith(
          "https://github.com/apps/launchpad-acme/installations/new?state=",
        ),
      ).toBe(true);
      expect(yield* service.readInstallState(stateOf(created.installUrl))).toEqual(claims);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("https://api.github.com/app-manifests/code-123/conversions");
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        appId: "77",
        appSlug: "launchpad-acme",
        createdByUserId: "user-1",
      });
      expect(saved[0]?.privateKeySealed).not.toContain("PEM-BODY");
      expect(yield* secretBox.open(saved[0]?.privateKeySealed ?? "")).toBe("PEM-BODY");
    }),
  );

  it.effect("offers the install page for a stored App, and nothing when there is none", () =>
    Effect.gen(function* () {
      const { saved, setup } = harness(noGithub);
      const { service } = yield* setup;
      const input = {
        userId: "user-1",
        organizationId: "organization-1",
        returnUrl: "t3code://app",
      };

      const missing = yield* service.beginInstall(input).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(GithubAppSetup.GithubAppNotAvailable);

      saved.push({
        appId: "77",
        appSlug: "launchpad-acme",
        privateKeySealed: "sealed",
        createdByUserId: "user-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      const install = yield* service.beginInstall(input);
      expect(
        install.installUrl.startsWith(
          "https://github.com/apps/launchpad-acme/installations/new?state=",
        ),
      ).toBe(true);
      expect(yield* service.readInstallState(stateOf(install.installUrl))).toEqual({
        ...input,
        returnUrl: "t3code://app",
      });
    }),
  );

  it.effect("reports a refused conversion instead of storing anything", () =>
    Effect.gen(function* () {
      const { saved, setup } = harness(() => new Response("nope", { status: 404 }));
      const { service } = yield* setup;
      const claims = {
        userId: "user-1",
        organizationId: "organization-1",
        returnUrl: beginInput.returnUrl,
      };

      const error = yield* service.complete({ code: "stale", claims }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(GithubAppSetup.GithubAppSetupConversionFailed);
      expect(error).toMatchObject({ status: 404 });
      expect(saved).toHaveLength(0);
    }),
  );
});
