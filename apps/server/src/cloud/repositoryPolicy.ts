import {
  EnvironmentHttpUnauthorizedError,
  RepositoryPolicyProof,
  RepositoryPolicyProofClaims,
  REPOSITORY_POLICY_PROOF_TYPE,
  REPOSITORY_POLICY_ACK_TYPE,
} from "@t3tools/contracts";
import { normalizeRelayIssuer, signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
} from "./config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";

export const applyRepositoryPolicyProof = Effect.fn("cloud.applyRepositoryPolicyProof")(
  function* (input: typeof RepositoryPolicyProof.Type, activate = false) {
    const secrets = yield* ServerSecretStore;
    const access = yield* RepositoryAccess;
    const env = yield* ServerEnvironment;
    const environmentId = yield* env.getEnvironmentId;
    const read = (name: string) =>
      secrets
        .get(name)
        .pipe(
          Effect.map((value) =>
            Option.isSome(value) ? new TextDecoder().decode(value.value) : "",
          ),
        );
    const issuer = normalizeRelayIssuer(yield* read(RELAY_ISSUER_SECRET));
    const key = yield* read(CLOUD_MINT_PUBLIC_KEY);
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const claims = yield* verifyRelayJwt({
      token: input.proof,
      publicKey: key,
      typ: REPOSITORY_POLICY_PROOF_TYPE,
      issuer,
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: now,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RepositoryPolicyProofClaims)));
    if (
      claims.environmentId !== environmentId ||
      claims.exp - claims.iat > 120 ||
      claims.sub !== claims.policy.organizationId
    )
      return yield* new EnvironmentHttpUnauthorizedError({ message: "Invalid repository policy." });
    const revision = yield* access.apply(claims.policy, activate);
    const keys = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    const proof = yield* signRelayJwt({
      privateKey: keys.privateKey,
      typ: REPOSITORY_POLICY_ACK_TYPE,
      payload: {
        iss: `t3-env:${environmentId}`,
        aud: issuer,
        sub: environmentId,
        jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        iat: now,
        exp: now + 120,
        environmentId,
        organizationId: claims.policy.organizationId,
        revision,
      },
    });
    return { revision, proof };
  },
  Effect.mapError(
    () =>
      new EnvironmentHttpUnauthorizedError({ message: "Repository policy could not be applied." }),
  ),
);

/** Startup calls this after enrollment. Until it succeeds only trusted accepted work runs. */
export const synchronizeRepositoryPolicy = Effect.gen(function* () {
  const access = yield* RepositoryAccess;
  if (!(yield* access.status).enabled) return;
  const secrets = yield* ServerSecretStore;
  const read = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((value) => (Option.isSome(value) ? new TextDecoder().decode(value.value) : "")),
      );
  const url = yield* read(RELAY_URL_SECRET);
  const credential = yield* read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
  const environment = yield* ServerEnvironment;
  const id = yield* environment.getEnvironmentId;
  const client = yield* HttpClient.HttpClient;
  const endpoint = `${url.replace(/\/$/, "")}/v1/environments/${encodeURIComponent(id)}/repository-policy`;
  const payload = yield* client
    .execute(HttpClientRequest.get(endpoint).pipe(HttpClientRequest.bearerToken(credential)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RepositoryPolicyProof)));
  const ack = yield* applyRepositoryPolicyProof(payload, true);
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${endpoint}/ack`).pipe(HttpClientRequest.bearerToken(credential)),
    ack,
  );
  yield* client.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});
