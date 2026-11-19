import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import * as SecretBox from "../auth/SecretBox.ts";
import {
  sealThreadVmTrafficAccessToken,
  ThreadVmIngressTokenUnavailable,
} from "./ThreadVmIngressToken.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const identity = {
  allocationId: "allocation",
  computeRef: "sandbox",
  operationId: "operation",
  threadId: "thread",
  generation: 3,
};

const ingressTokenTestLayer = SecretBox.layer.pipe(
  Layer.provide(
    Layer.succeed(RelayConfiguration, {
      relayIssuer: "https://relay.test",
      apns: null,
      clerkSecretKey: Redacted.make("clerk"),
      clerkPublishableKey: "public",
      clerkJwtAudience: "relay",
      apnsDeliveryJobSigningSecret: Redacted.make("push"),
      cloudMintPrivateKey: Redacted.make("private-ingress-test-key"),
      cloudMintPublicKey: "public",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    }),
  ),
);

layer(ingressTokenTestLayer)((it) => {
  it.effect("seals the routing token with its complete immutable identity", () =>
    Effect.gen(function* () {
      const token = "private-native-routing-token";
      const first = yield* sealThreadVmTrafficAccessToken(identity, Redacted.make(token));
      const second = yield* sealThreadVmTrafficAccessToken(identity, Redacted.make(token));
      expect(first).not.toBe(second);
      expect(first).not.toContain(token);
      const box = yield* SecretBox.RelaySecretBox;
      expect(yield* decodeJson(yield* box.open(first))).toEqual({ version: 1, ...identity, token });
    }),
  );

  it.effect("rejects invalid identity and tokens without retaining their contents in errors", () =>
    Effect.gen(function* () {
      for (const invalid of [
        { ...identity, generation: 0 },
        { ...identity, computeRef: "" },
      ]) {
        const error = yield* sealThreadVmTrafficAccessToken(
          invalid,
          Redacted.make("private-token-never-in-errors"),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
        expect(encodeJson(error)).not.toContain("private-token-never-in-errors");
      }
      expect(
        yield* sealThreadVmTrafficAccessToken(identity, Redacted.make("")).pipe(Effect.flip),
      ).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
    }),
  );
});
