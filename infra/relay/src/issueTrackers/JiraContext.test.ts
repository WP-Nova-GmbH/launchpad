import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RelaySecretBox, make as makeSecretBox } from "../auth/SecretBox.ts";
import { RelayConfiguration } from "../Config.ts";
import { openJiraSource, sealJiraSource, validateJiraSource } from "./JiraContext.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const source = {
  organizationId: "organization-1",
  connectionVersion: "connection-1",
  cloudId: "site-1",
  issueId: "12345",
};
const box = makeSecretBox.pipe(
  Effect.provideService(RelayConfiguration, {
    relayIssuer: "https://relay.test",
    apns: null,
    clerkSecretKey: Redacted.make("test"),
    clerkPublishableKey: "test",
    clerkJwtAudience: "test",
    apnsDeliveryJobSigningSecret: Redacted.make("test"),
    cloudMintPrivateKey: Redacted.make("jira-source-test-key"),
    cloudMintPublicKey: "test",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  }),
);

describe("Jira issue source references", () => {
  it.effect("round-trips immutable identity through the relay's actual secret box", () =>
    Effect.gen(function* () {
      const secrets = yield* box;
      const reference = yield* sealJiraSource(source).pipe(
        Effect.provideService(RelaySecretBox, secrets),
      );
      expect(reference).not.toContain(source.organizationId);
      expect(reference.length).toBeLessThan(16_384);
      expect(
        yield* openJiraSource(reference).pipe(Effect.provideService(RelaySecretBox, secrets)),
      ).toEqual({
        ...source,
        service: "jira",
        kind: "issue",
      });
    }),
  );

  it.effect("rejects tampering without exposing decrypted context", () =>
    Effect.gen(function* () {
      const secrets = yield* box;
      const reference = yield* sealJiraSource(source).pipe(
        Effect.provideService(RelaySecretBox, secrets),
      );
      const tampered = `${reference.slice(0, -2)}${reference.endsWith("AA") ? "BB" : "AA"}`;
      const failure = yield* openJiraSource(tampered).pipe(
        Effect.provideService(RelaySecretBox, secrets),
        Effect.flip,
      );
      expect(failure.code).toBe("invalid_input");
      expect(encodeJson(failure)).not.toContain(source.organizationId);
    }),
  );

  it.effect.each([
    { ...source, service: "linear", kind: "issue" },
    { ...source, service: "jira", kind: "image" },
    { service: "jira", accessToken: "private-access-token", cloudId: "site-1" },
    { ...source, service: "jira", kind: "issue", issueId: "" },
    { ...source, service: "jira", kind: "issue", issueId: "x".repeat(129) },
  ])("rejects sealed values outside the issue-source contract", (value) =>
    Effect.gen(function* () {
      const secrets = yield* box;
      const reference = yield* secrets.seal(encodeJson(value));
      const failure = yield* openJiraSource(reference).pipe(
        Effect.provideService(RelaySecretBox, secrets),
        Effect.flip,
      );
      expect(failure.code).toBe("invalid_input");
      expect(encodeJson(failure)).not.toContain("private-api-key");
    }),
  );

  it.effect.each(["organizationId", "connectionVersion", "cloudId"] as const)(
    "rejects a change to %s even if the same issue ID exists",
    (field) =>
      Effect.gen(function* () {
        expect(
          (yield* validateJiraSource(source, { ...source, [field]: "other" }).pipe(Effect.flip))
            .code,
        ).toBe("conflict");
        yield* validateJiraSource(source, source);
      }),
  );

  it.effect("rejects oversized references before attempting decryption", () =>
    Effect.gen(function* () {
      const secrets = yield* box;
      let opened = false;
      const failure = yield* openJiraSource("x".repeat(16_385)).pipe(
        Effect.provideService(RelaySecretBox, {
          ...secrets,
          open: (value) => {
            opened = true;
            return secrets.open(value);
          },
        }),
        Effect.flip,
      );
      expect(failure.code).toBe("invalid_input");
      expect(opened).toBe(false);
    }),
  );
});
