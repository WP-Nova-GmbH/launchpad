import { type EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { type RelayCloudMintCredentialProofPayload } from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_MINT_REQUEST_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { verifyEnvironmentResponse } from "../environments/EnvironmentConnector.ts";
import type { E2BThreadVmIdentity } from "../machines/E2BThreadVmConnection.ts";
import type { makeE2BThreadVmEndpoint } from "../machines/E2BThreadVmEndpoint.ts";

export interface ThreadVmConnectionTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environmentPublicKey: string;
  readonly credentialId: string;
  readonly sandboxId: string;
  readonly identity: E2BThreadVmIdentity;
}

export class ThreadVmConnectionUnavailable extends Schema.TaggedError<ThreadVmConnectionUnavailable>()(
  "ThreadVmConnectionUnavailable",
  {},
) {
  override get message() {
    return "The private VM connection is unavailable or no longer authorized.";
  }
}

/** Authorization reads complete before network I/O, then run again before releasing the credential. */
export const mintThreadVmConnection = <E, R>(input: {
  readonly threadId: ThreadId;
  readonly userId: string;
  readonly clientProofKeyThumbprint: string;
  readonly relayIssuer: string;
  readonly deviceId?: string;
  readonly profile?: { readonly displayName?: string | null; readonly imageUrl?: string | null };
  readonly cloudMintPrivateKey: Redacted.Redacted<string>;
  readonly authorize: (
    userId: string,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadVmConnectionTarget, E, R>;
  readonly endpoint: ReturnType<typeof makeE2BThreadVmEndpoint>;
}) =>
  Effect.gen(function* () {
    if (!input.clientProofKeyThumbprint.trim()) return yield* new ThreadVmConnectionUnavailable();
    const target = yield* input.authorize(input.userId, input.threadId);
    if (target.identity.scope.threadId !== input.threadId)
      return yield* new ThreadVmConnectionUnavailable();
    const crypto = yield* Crypto.Crypto;
    const now = yield* DateTime.now;
    const nonce = yield* crypto.randomUUIDv4;
    const relayIssuer = normalizeRelayIssuer(input.relayIssuer);
    const payload: RelayCloudMintCredentialProofPayload = {
      iss: relayIssuer,
      aud: `t3-env:${target.environmentId}`,
      sub: input.userId,
      jti: yield* crypto.randomUUIDv4,
      iat: Math.floor(now.epochMilliseconds / 1000),
      exp: Math.floor(now.epochMilliseconds / 1000) + 120,
      environmentId: target.environmentId,
      clientProofKeyThumbprint: input.clientProofKeyThumbprint,
      cnf: { jkt: input.clientProofKeyThumbprint },
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.profile?.displayName ? { name: input.profile.displayName } : {}),
      ...(input.profile?.imageUrl ? { picture: input.profile.imageUrl } : {}),
      nonce,
      scope: ["environment:connect"],
    };
    const proof = yield* signRelayJwt({
      privateKey: Redacted.value(input.cloudMintPrivateKey),
      typ: RELAY_MINT_REQUEST_TYP,
      payload,
    });
    const response = yield* input.endpoint.mintCredential(target.sandboxId, target.identity, proof);
    const checkedAt = yield* DateTime.now;
    const verified = yield* verifyEnvironmentResponse({
      response,
      environmentId: target.environmentId,
      requestNonce: nonce,
      clientProofKeyThumbprint: input.clientProofKeyThumbprint,
      environmentPublicKeys: [target.environmentPublicKey],
      relayIssuer,
      nowEpochSeconds: Math.floor(checkedAt.epochMilliseconds / 1000),
    });
    if (
      !verified ||
      DateTime.makeUnsafe(response.expiresAt).epochMilliseconds <= checkedAt.epochMilliseconds
    )
      return yield* new ThreadVmConnectionUnavailable();
    const current = yield* input.authorize(input.userId, input.threadId);
    if (!sameThreadVmTarget(current, target)) return yield* new ThreadVmConnectionUnavailable();
    return {
      target,
      credential: Redacted.make(response.credential),
      expiresAt: response.expiresAt,
    };
  }).pipe(Effect.mapError(() => new ThreadVmConnectionUnavailable()));

export function sameThreadVmTarget(
  current: ThreadVmConnectionTarget,
  target: ThreadVmConnectionTarget,
) {
  return !(
    current.environmentId !== target.environmentId ||
    current.projectId !== target.projectId ||
    current.environmentPublicKey !== target.environmentPublicKey ||
    current.credentialId !== target.credentialId ||
    current.sandboxId !== target.sandboxId ||
    current.identity.operationId !== target.identity.operationId ||
    current.identity.scope.allocationId !== target.identity.scope.allocationId ||
    current.identity.scope.threadId !== target.identity.scope.threadId ||
    current.identity.scope.repositoryId !== target.identity.scope.repositoryId ||
    current.identity.scope.generation !== target.identity.scope.generation
  );
}
