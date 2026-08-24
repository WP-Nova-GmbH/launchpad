import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  RelayProjectCatalogPublishProofPayload,
  RelayProjectCatalogPublishRequest,
} from "@t3tools/contracts/relay";
import { RELAY_PROJECT_CATALOG_PUBLISH_TYP } from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentProjectCatalogSignatures from "./EnvironmentProjectCatalogSignatures.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentId = EnvironmentId.make("environment-1");
const projects = [
  {
    projectId: ProjectId.make("project-1"),
    title: "Catalog project",
    repositoryCanonicalKey: "github.com/acme/catalog",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
  },
] as const;
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  github: undefined,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

function signTestJwt(payload: object): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_PROJECT_CATALOG_PUBLISH_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), keyPair.privateKey).toString("base64url")}`;
}

const freshRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const payload = {
    iss: `t3-env:${environmentId}`,
    aud: "https://relay.example.test",
    sub: environmentId,
    jti: "catalog-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
    environmentId,
    revision: 7,
    projects,
  } satisfies RelayProjectCatalogPublishProofPayload;
  return {
    revision: payload.revision,
    projects,
    proof: signTestJwt(payload),
  } satisfies RelayProjectCatalogPublishRequest;
});

function layer(replay?: Partial<DpopProofs.DpopProofReplay["Service"]>) {
  return EnvironmentProjectCatalogSignatures.layer.pipe(
    Layer.provide(
      Layer.merge(
        RelayConfiguration.layer(config),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume:
            replay?.verifyAndConsume ?? (() => Effect.die("unexpected DPoP verification")),
          consume: replay?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: replay?.pruneExpired ?? Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("EnvironmentProjectCatalogSignatures", () => {
  it.effect("verifies the snapshot and scopes replay storage to its purpose and key", () => {
    let replayThumbprint: string | null = null;
    return Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures =
        yield* EnvironmentProjectCatalogSignatures.EnvironmentProjectCatalogSignatures;
      yield* signatures.verify({
        environmentId,
        environmentPublicKey: keyPair.publicKey,
        request,
      });

      expect(replayThumbprint).toBe(
        `env-project-catalog:${NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              purpose: "organization-project-catalog",
              environmentId,
              environmentPublicKey: keyPair.publicKey,
            }),
          )
          .digest("base64url")}`,
      );
    }).pipe(
      Effect.provide(
        layer({
          consume: (input) =>
            Effect.sync(() => {
              replayThumbprint = input.thumbprint;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects project data changed after signing", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures =
        yield* EnvironmentProjectCatalogSignatures.EnvironmentProjectCatalogSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId,
          environmentPublicKey: keyPair.publicKey,
          request: {
            ...request,
            projects: [{ ...request.projects[0]!, title: "Tampered" }],
          },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProjectCatalogPublishSignatureInvalid",
          reason: "invalid_signature_or_payload",
          stage: "validate_claims",
        });
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects a replayed catalog proof", () =>
    Effect.gen(function* () {
      const request = yield* freshRequest;
      const signatures =
        yield* EnvironmentProjectCatalogSignatures.EnvironmentProjectCatalogSignatures;
      const result = yield* Effect.result(
        signatures.verify({
          environmentId,
          environmentPublicKey: keyPair.publicKey,
          request,
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProjectCatalogPublishSignatureInvalid",
          reason: "replayed_nonce",
          stage: "consume_nonce",
        });
      }
    }).pipe(Effect.provide(layer({ consume: () => Effect.succeed(false) }))),
  );
});
