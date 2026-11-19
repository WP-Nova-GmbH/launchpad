// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  RelayApi,
  RelayAccessTokenType,
  RelayDpopAccessTokenResponse,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
} from "@t3tools/contracts/relay";
import {
  computeDpopJwkThumbprint,
  verifyDpopProof,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayConfiguration, RelayTokenResourceAliases } from "../Config.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import { tokenApi } from "./Api.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const alias = "http://127.0.0.1:18610";
const canonical = "https://persisted-relay.example.test";
const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const proofKeys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = proofKeys.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = Schema.decodeUnknownEffect(RelayDpopAccessTokenResponse);
function proof(url = `${alias}/v1/client/dpop-token`) {
  const header = Buffer.from(
    encodeJson({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
  ).toString("base64url");
  const body = Buffer.from(
    encodeJson({ htm: "POST", htu: url, jti: NodeCrypto.randomUUID(), iat: 0 }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${body}`), {
    key: proofKeys.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${body}.${signature}`;
}
const config: RelayConfiguration["Service"] = {
  relayIssuer: canonical,
  apns: null,
  clerkSecretKey: Redacted.make("clerk-test"),
  clerkPublishableKey: "pk_test",
  clerkJwtAudience: "test-audience",
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const makeApp = (aliases: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    let verifiedProofs = 0;
    const seen = new Set<string>();
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user",
      aud: config.clerkJwtAudience,
    } as never);
    const clock = yield* Clock.Clock;
    const configLayer = Layer.succeed(RelayConfiguration, config);
    const dependencies = Layer.mergeAll(
      configLayer,
      Layer.succeed(Clock.Clock, clock),
      NodeCryptoLayer.layer,
      Layer.succeed(RelayTokenResourceAliases, aliases),
      RelayTokens.layer.pipe(Layer.provide(configLayer)),
      Layer.mock(DpopProofs.DpopProofReplay, {
        verifyAndConsume: (input) =>
          Effect.gen(function* () {
            verifiedProofs++;
            expect(input.url).toBe(`${alias}/v1/client/dpop-token`);
            const result = verifyDpopProof({
              proof: input.proof,
              method: input.method,
              url: input.url,
              nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1000),
            });
            if (!result.ok) return yield* new DpopProofs.DpopProofRejected({ code: result.code });
            if (seen.has(result.jti))
              return yield* new DpopProofs.DpopProofRejected({ code: "replayed" });
            seen.add(result.jti);
            return result.thumbprint;
          }),
      }),
    );
    const tokens = yield* RelayTokens.RelayTokens.pipe(
      Effect.provide(RelayTokens.layer.pipe(Layer.provide(configLayer))),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.token)).pipe(
            Layer.provide(tokenApi.pipe(Layer.provide(dependencies))),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (app) => Effect.promise(() => app.dispose()),
    );
    const exchange = (resource: string, dpop: string = proof(), scope = "environment:connect") =>
      Effect.promise(() =>
        app.handler(
          new Request(`${alias}/v1/client/dpop-token`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: new URL(alias).host,
              dpop,
            },
            body: new URLSearchParams({
              grant_type: RelayDpopTokenExchangeGrantType,
              subject_token: "clerk-subject-token",
              subject_token_type: RelayJwtSubjectTokenType,
              requested_token_type: RelayAccessTokenType,
              resource,
              client_id: "t3-web",
              scope,
            }),
          }),
        ),
      );
    return { exchange, tokens, verifiedProofs: () => verifiedProofs };
  });

describe("local dev token resource alias", () => {
  it.effect(
    "rejects a loopback resource by default while preserving the canonical issuer exchange",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeApp();
          expect((yield* f.exchange(alias)).status).toBe(401);
          expect(f.verifiedProofs()).toBe(0);
          expect((yield* f.exchange(canonical)).status).toBe(200);
          expect(f.verifiedProofs()).toBe(1);
        }),
      ),
  );
  it.effect(
    "accepts only the explicit local alias and still issues canonical proof-bound tokens",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeApp([alias]);
          const response = yield* f.exchange(alias);
          expect(response.status, yield* Effect.promise(() => response.clone().text())).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const body = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(decodeResponse),
          );
          const claims = yield* f.tokens.verifyDpopAccessToken({
            token: body.access_token,
            nowEpochSeconds: 0,
          });
          expect(claims).toMatchObject({
            iss: canonical,
            aud: canonical,
            sub: "user",
            cnf: { jkt: computeDpopJwkThumbprint(publicJwk) },
          });
          expect(f.verifiedProofs()).toBe(1);
        }),
      ),
  );
  it.effect("keeps bad resources, scopes, signatures, URL proofs and replays rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeApp([alias]);
        for (const bad of [
          "http://127.0.0.1:18611",
          "http://user@127.0.0.1:18610",
          `${alias}/api`,
          `${alias}?x=1`,
          `${alias}#fragment`,
          "https://unrelated.example.test",
        ])
          expect((yield* f.exchange(bad)).status).toBe(401);
        expect(f.verifiedProofs()).toBe(0);
        vi.mocked(verifyToken).mockRejectedValueOnce(new Error("invalid test subject token"));
        expect((yield* f.exchange(alias)).status).toBe(401);
        expect(f.verifiedProofs()).toBe(0);
        expect((yield* f.exchange(alias, proof(), "unrecognized:scope")).status).toBe(401);
        expect((yield* f.exchange(alias, "invalid-signature")).status).toBe(401);
        const invalidSignature = proof().split(".");
        invalidSignature[2] = Buffer.alloc(64).toString("base64url");
        expect((yield* f.exchange(alias, invalidSignature.join("."))).status).toBe(401);
        expect((yield* f.exchange(alias, proof(`${canonical}/v1/client/dpop-token`))).status).toBe(
          401,
        );
        const replay = proof();
        expect((yield* f.exchange(alias, replay)).status).toBe(200);
        expect((yield* f.exchange(alias, replay)).status).toBe(401);
      }),
    ),
  );
});
