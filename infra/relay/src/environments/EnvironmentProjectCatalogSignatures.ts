import {
  RelayProjectCatalogPublishProofInvalidReason,
  RelayProjectCatalogPublishProofPayload,
  type RelayProjectCatalogPublishRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_PROJECT_CATALOG_PUBLISH_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";

export class ProjectCatalogPublishSignatureExpired extends Schema.TaggedErrorClass<ProjectCatalogPublishSignatureExpired>()(
  "ProjectCatalogPublishSignatureExpired",
  {
    environmentId: Schema.String,
    expiresAt: Schema.String,
  },
) {}

export class ProjectCatalogPublishSignatureInvalid extends Schema.TaggedErrorClass<ProjectCatalogPublishSignatureInvalid>()(
  "ProjectCatalogPublishSignatureInvalid",
  {
    environmentId: Schema.String,
    reason: RelayProjectCatalogPublishProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "verify_proof",
      "validate_claims",
      "validate_expiration",
      "generate_replay_thumbprint",
      "consume_nonce",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ProjectCatalogPublishSignatureError =
  | ProjectCatalogPublishSignatureExpired
  | ProjectCatalogPublishSignatureInvalid
  | DpopProofs.DpopProofReplayPersistenceError;

export class EnvironmentProjectCatalogSignatures extends Context.Service<
  EnvironmentProjectCatalogSignatures,
  {
    readonly verify: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly request: RelayProjectCatalogPublishRequest;
    }) => Effect.Effect<void, ProjectCatalogPublishSignatureError>;
  }
>()("t3code-relay/environments/EnvironmentProjectCatalogSignatures") {}

const decodeProof = Schema.decodeUnknownEffect(RelayProjectCatalogPublishProofPayload);

function replayThumbprintData(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return new TextEncoder().encode(
    stableStringify({
      purpose: "organization-project-catalog",
      environmentId: input.environmentId,
      environmentPublicKey: input.environmentPublicKey,
    }),
  );
}

const make = Effect.gen(function* () {
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;

  return EnvironmentProjectCatalogSignatures.of({
    verify: Effect.fn("relay.environment_project_catalog_signatures.verify")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const now = yield* DateTime.now;
      const decoded = yield* Effect.try({
        try: () => decodeRelayJwt(input.request.proof),
        catch: (cause) =>
          new ProjectCatalogPublishSignatureInvalid({
            environmentId: input.environmentId,
            reason: "invalid_signature_or_payload",
            stage: "decode_token",
            cause,
          }),
      });
      if (
        typeof decoded.exp === "number" &&
        decoded.exp <= Math.floor(now.epochMilliseconds / 1_000)
      ) {
        return yield* new ProjectCatalogPublishSignatureExpired({
          environmentId: input.environmentId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(decoded.exp * 1_000)),
        });
      }

      const proof = yield* verifyRelayJwt({
        publicKey: input.environmentPublicKey,
        token: input.request.proof,
        typ: RELAY_PROJECT_CATALOG_PUBLISH_TYP,
        issuer: `t3-env:${input.environmentId}`,
        audience: normalizeRelayIssuer(config.relayIssuer),
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      }).pipe(
        Effect.flatMap(decodeProof),
        Effect.mapError(
          (cause) =>
            new ProjectCatalogPublishSignatureInvalid({
              environmentId: input.environmentId,
              reason: "invalid_signature_or_payload",
              stage: "verify_proof",
              cause,
            }),
        ),
      );

      if (
        proof.environmentId !== input.environmentId ||
        proof.sub !== input.environmentId ||
        proof.revision !== input.request.revision ||
        stableStringify(proof.projects) !== stableStringify(input.request.projects)
      ) {
        return yield* new ProjectCatalogPublishSignatureInvalid({
          environmentId: input.environmentId,
          reason: "invalid_signature_or_payload",
          stage: "validate_claims",
        });
      }

      const expiresAt = DateTime.make(proof.exp * 1_000);
      if (expiresAt._tag === "None") {
        return yield* new ProjectCatalogPublishSignatureInvalid({
          environmentId: input.environmentId,
          reason: "invalid_signature_or_payload",
          stage: "validate_expiration",
        });
      }

      const thumbprint = yield* crypto
        .digest(
          "SHA-256",
          replayThumbprintData({
            environmentId: input.environmentId,
            environmentPublicKey: input.environmentPublicKey,
          }),
        )
        .pipe(
          Effect.map((digest) => `env-project-catalog:${Encoding.encodeBase64Url(digest)}`),
          Effect.mapError(
            (cause) =>
              new ProjectCatalogPublishSignatureInvalid({
                environmentId: input.environmentId,
                reason: "invalid_signature_or_payload",
                stage: "generate_replay_thumbprint",
                cause,
              }),
          ),
        );
      const consumed = yield* proofReplay.consume({
        thumbprint,
        jti: proof.jti,
        iat: proof.iat,
        expiresAt: expiresAt.value,
      });
      if (!consumed) {
        return yield* new ProjectCatalogPublishSignatureInvalid({
          environmentId: input.environmentId,
          reason: "replayed_nonce",
          stage: "consume_nonce",
        });
      }
    }),
  });
});

export const layer = Layer.effect(EnvironmentProjectCatalogSignatures, make);
