import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelaySecretBox from "./SecretBox.ts";

function settings(cloudMintPrivateKey: string): RelayConfiguration.RelayConfiguration["Service"] {
  return {
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
    cloudMintPrivateKey: Redacted.make(cloudMintPrivateKey),
    cloudMintPublicKey: "cloud-mint-public-key",
    github: undefined,
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  };
}

const boxFor = (cloudMintPrivateKey: string) =>
  RelaySecretBox.make.pipe(
    Effect.provide(
      Layer.succeed(RelayConfiguration.RelayConfiguration, settings(cloudMintPrivateKey)),
    ),
  );

describe("RelaySecretBox", () => {
  it.effect("opens what it sealed, and never seals the same way twice", () =>
    Effect.gen(function* () {
      const box = yield* boxFor("mint-key-1");
      const first = yield* box.seal(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      );
      const second = yield* box.seal(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      );

      expect(first).not.toBe(second);
      expect(first).not.toContain("abc");
      expect(yield* box.open(first)).toBe(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      );
    }),
  );

  it.effect("refuses a sealed value from a relay with a different mint key", () =>
    Effect.gen(function* () {
      const sealed = yield* (yield* boxFor("mint-key-1")).seal("secret");
      const other = yield* boxFor("mint-key-2");

      const error = yield* other.open(sealed).pipe(Effect.flip);

      expect(error).toBeInstanceOf(RelaySecretBox.SecretBoxError);
      expect(error).toMatchObject({ operation: "open" });
    }),
  );

  it.effect("refuses a tampered value", () =>
    Effect.gen(function* () {
      const box = yield* boxFor("mint-key-1");
      const sealed = yield* box.seal("secret");
      const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;

      const error = yield* box.open(tampered).pipe(Effect.flip);

      expect(error).toBeInstanceOf(RelaySecretBox.SecretBoxError);
    }),
  );
});
