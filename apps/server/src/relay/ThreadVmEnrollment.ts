import {
  RelayThreadVmCredentialScope,
  RelayThreadVmBootstrap,
  RelayThreadVmEnrollRequest,
  RelayThreadVmEnrollResponse,
} from "@t3tools/contracts/relay";
import { EnvironmentId } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { RELAY_THREAD_VM_ENROLL_PROOF_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MACHINE_IDENTITY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";

export const THREAD_VM_IDENTITY_SECRET = "thread-vm-enrollment";
export const ThreadVmEnrollmentInput = RelayThreadVmBootstrap;
export type ThreadVmEnrollmentInput = RelayThreadVmBootstrap;
const InstalledThreadVm = Schema.Struct({
  operationId: Schema.NonEmptyString,
  scope: RelayThreadVmCredentialScope,
  relayUrl: Schema.NonEmptyString,
  relayIssuer: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  environmentCredential: Schema.NonEmptyString,
  cloudMintPublicKey: Schema.NonEmptyString,
});
export type InstalledThreadVm = typeof InstalledThreadVm.Type;
const decodeInstalled = Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledThreadVm));
const encodeInstalled = Schema.encodeEffect(Schema.fromJsonString(InstalledThreadVm));

export class ThreadVmEnrollmentError extends Schema.TaggedError<ThreadVmEnrollmentError>()(
  "ThreadVmEnrollmentError",
  { stage: Schema.Literals(["configuration", "identity", "request", "response", "persist"]) },
) {
  override get message() {
    return `VM enrollment failed during ${this.stage}. The server has not been activated.`;
  }
}
const failed = (stage: ThreadVmEnrollmentError["stage"]) => () =>
  new ThreadVmEnrollmentError({ stage });
const sameScope = (a: InstalledThreadVm["scope"], b: InstalledThreadVm["scope"]) =>
  a.allocationId === b.allocationId &&
  a.threadId === b.threadId &&
  a.repositoryId === b.repositoryId &&
  a.generation === b.generation;

export const readInstalledThreadVm = Effect.fn("ThreadVmEnrollment.readInstalled")(function* () {
  const secrets = yield* ServerSecretStore;
  const raw = yield* secrets
    .get(THREAD_VM_IDENTITY_SECRET)
    .pipe(Effect.mapError(failed("identity")));
  if (Option.isNone(raw)) return null;
  return yield* decodeInstalled(new TextDecoder().decode(raw.value)).pipe(
    Effect.mapError(failed("identity")),
  );
});

/** Enrollment installs one atomic secret record. It never starts the server or grants execution ownership. */
export const enrollThreadVm = Effect.fn("ThreadVmEnrollment.enroll")(function* (
  input: ThreadVmEnrollmentInput,
) {
  const relayUrl = normalizeSecureRelayUrl(input.relayUrl);
  const relayIssuer = normalizeSecureRelayUrl(input.relayIssuer);
  if (!relayUrl || !relayIssuer)
    return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
  const secrets = yield* ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const prior = yield* readInstalledThreadVm();
  if (prior) {
    if (
      prior.environmentId !== environmentId ||
      prior.operationId !== input.operationId ||
      !sameScope(prior.scope, input.scope) ||
      prior.relayUrl !== relayUrl ||
      prior.relayIssuer !== relayIssuer
    )
      return yield* new ThreadVmEnrollmentError({ stage: "identity" });
    return prior;
  }
  for (const name of [
    CLOUD_LINKED_USER_ID,
    CLOUD_MACHINE_IDENTITY,
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  ]) {
    if (Option.isSome(yield* secrets.get(name).pipe(Effect.mapError(failed("identity")))))
      return yield* new ThreadVmEnrollmentError({ stage: "identity" });
  }
  const keys = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
    Effect.mapError(failed("identity")),
  );
  const crypto = yield* Crypto.Crypto;
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  const proof = yield* signRelayJwt({
    privateKey: keys.privateKey,
    typ: RELAY_THREAD_VM_ENROLL_PROOF_TYP,
    payload: {
      iss: `t3-env:${environmentId}`,
      aud: relayIssuer,
      sub: environmentId,
      jti: yield* crypto.randomUUIDv4,
      iat: now,
      exp: now + 120,
      allocationId: input.scope.allocationId,
      operationId: input.operationId,
      seed: Redacted.value(input.seed),
      environmentId,
      environmentPublicKey: keys.publicKey,
    },
  }).pipe(Effect.mapError(failed("identity")));
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(`${relayUrl}/v1/thread-vms/enroll`).pipe(
    HttpClientRequest.schemaBodyJson(RelayThreadVmEnrollRequest)({ proof }),
    Effect.mapError(failed("request")),
  );
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayThreadVmEnrollResponse)),
      Effect.timeout("30 seconds"),
      Effect.mapError(failed("request")),
    );
  if (
    response.environmentId !== environmentId ||
    !sameScope(response.scope, input.scope) ||
    response.relayIssuer !== relayIssuer
  )
    return yield* new ThreadVmEnrollmentError({ stage: "response" });
  const installed = { ...response, relayUrl, operationId: input.operationId };
  const encoded = yield* encodeInstalled(installed).pipe(Effect.mapError(failed("persist")));
  yield* secrets
    .create(THREAD_VM_IDENTITY_SECRET, new TextEncoder().encode(encoded))
    .pipe(Effect.mapError(failed("persist")));
  return installed;
});
