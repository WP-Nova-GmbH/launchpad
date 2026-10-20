import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayCloudMintCredentialProofPayload,
  type RelayEnvironmentMintResponse,
} from "@t3tools/contracts/relay";
import {
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ThreadVmEndpointError } from "../machines/E2BThreadVmEndpoint.ts";
import {
  mintThreadVmConnection,
  ThreadVmConnectionUnavailable,
  type ThreadVmConnectionTarget,
} from "./ThreadVmConnection.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const keys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
const relay = keys(),
  guest = keys(),
  wrong = keys();
const target: ThreadVmConnectionTarget = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  environmentPublicKey: guest.publicKey,
  credentialId: "credential-id",
  sandboxId: "sandbox",
  identity: {
    operationId: "operation",
    scope: {
      allocationId: "allocation",
      threadId: ThreadId.make("thread"),
      repositoryId: "repository",
      generation: 1,
    },
  },
};
function fixture(
  options: {
    afterMint?: () => void;
    response?: (response: RelayEnvironmentMintResponse) => RelayEnvironmentMintResponse;
    privateKey?: string;
    nonce?: string;
    thumbprint?: string;
    waitPastExpiry?: boolean;
  } = {},
) {
  let current = target;
  let allowed = true;
  let reads = 0;
  let mints = 0;
  const run = mintThreadVmConnection({
    threadId: target.identity.scope.threadId,
    userId: "owner",
    clientProofKeyThumbprint: options.thumbprint ?? "client-key",
    relayIssuer: "https://relay.test/",
    cloudMintPrivateKey: Redacted.make(relay.privateKey),
    authorize: (userId, threadId) =>
      Effect.gen(function* () {
        reads++;
        expect(userId).toBe("owner");
        expect(threadId).toBe("thread");
        if (!allowed) return yield* new ThreadVmConnectionUnavailable();
        return current;
      }),
    endpoint: {
      mintCredential: (sandboxId, identity, proof) =>
        Effect.gen(function* () {
          mints++;
          expect(sandboxId).toBe(target.sandboxId);
          expect(identity).toEqual(target.identity);
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          const payload = yield* verifyRelayJwt({
            publicKey: relay.publicKey,
            token: proof,
            typ: RELAY_MINT_REQUEST_TYP,
            issuer: "https://relay.test",
            audience: "t3-env:env",
            nowEpochSeconds: now,
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload)));
          expect(payload.sub).toBe("owner");
          expect(payload.scope).toEqual(["environment:connect"]);
          expect(payload.cnf.jkt).toBe("client-key");
          const response: RelayEnvironmentMintResponse = {
            credential: "one-time-secret",
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe((now + 60) * 1000)),
            proof: yield* signRelayJwt({
              privateKey: options.privateKey ?? guest.privateKey,
              typ: RELAY_MINT_RESPONSE_TYP,
              payload: {
                iss: "t3-env:env",
                aud: "https://relay.test",
                sub: "owner",
                jti: "response-id",
                iat: now,
                exp: now + 60,
                environmentId: "env",
                requestNonce: options.nonce ?? payload.nonce,
                clientProofKeyThumbprint: payload.clientProofKeyThumbprint,
                credential: "one-time-secret",
              },
            }),
          };
          options.afterMint?.();
          if (options.waitPastExpiry) yield* TestClock.adjust("2 minutes");
          return options.response ? options.response(response) : response;
        }).pipe(Effect.mapError(() => new ThreadVmEndpointError())),
    },
  }).pipe(Effect.provide(NodeCryptoLayer.layer));
  return {
    run,
    revoke: () => {
      allowed = false;
    },
    change: (next: ThreadVmConnectionTarget) => {
      current = next;
    },
    counts: () => ({ reads, mints }),
  };
}

describe("private VM credential exchange", () => {
  it.effect(
    "signs for the owner and client key, verifies the guest, and rechecks before returning",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* test.run;
        expect(Redacted.value(result.credential)).toBe("one-time-secret");
        expect(yield* encodeJson(result)).not.toContain("one-time-secret");
        expect(test.counts()).toEqual({ reads: 2, mints: 1 });
      }),
  );
  it.effect("does not contact compute when access is denied or the client key is absent", () =>
    Effect.gen(function* () {
      const denied = fixture();
      denied.revoke();
      yield* denied.run.pipe(Effect.flip);
      expect(denied.counts().mints).toBe(0);
      const noKey = fixture({ thumbprint: " " });
      yield* noKey.run.pipe(Effect.flip);
      expect(noKey.counts()).toEqual({ reads: 0, mints: 0 });
    }),
  );
  it.effect("discards a credential when permission is revoked during minting", () =>
    Effect.gen(function* () {
      const test = fixture({ afterMint: () => test.revoke() });
      yield* test.run.pipe(Effect.flip);
      expect(test.counts()).toEqual({ reads: 2, mints: 1 });
    }),
  );
  it.effect("discards credentials from a changed placement, allocation, or key", () =>
    Effect.gen(function* () {
      for (const changed of [
        { ...target, environmentId: EnvironmentId.make("new-env") },
        { ...target, projectId: ProjectId.make("new-project") },
        { ...target, environmentPublicKey: wrong.publicKey },
        { ...target, credentialId: "rotated" },
        { ...target, sandboxId: "new-sandbox" },
        { ...target, identity: { ...target.identity, operationId: "new-op" } },
        ...["allocationId", "threadId", "repositoryId"].map((field) => ({
          ...target,
          identity: { ...target.identity, scope: { ...target.identity.scope, [field]: "other" } },
        })),
        {
          ...target,
          identity: { ...target.identity, scope: { ...target.identity.scope, generation: 2 } },
        },
      ]) {
        const test = fixture({ afterMint: () => test.change(changed) });
        yield* test.run.pipe(Effect.flip);
        expect(test.counts()).toEqual({ reads: 2, mints: 1 });
      }
    }),
  );
  it.effect("rejects wrong signatures, replayed responses, tampered credentials and expiry", () =>
    Effect.gen(function* () {
      for (const options of [
        { privateKey: wrong.privateKey },
        { nonce: "earlier-request" },
        {
          response: (response: RelayEnvironmentMintResponse) => ({
            ...response,
            credential: "injected-secret",
          }),
        },
        {
          response: (response: RelayEnvironmentMintResponse) => ({
            ...response,
            expiresAt: "2099-01-01T00:00:00Z",
          }),
        },
        { waitPastExpiry: true },
      ]) {
        const test = fixture(options);
        const error = yield* test.run.pipe(Effect.flip);
        expect(error._tag).toBe("ThreadVmConnectionUnavailable");
        expect(error).not.toHaveProperty("cause");
        expect(test.counts()).toEqual({ reads: 1, mints: 1 });
      }
    }),
  );
});
