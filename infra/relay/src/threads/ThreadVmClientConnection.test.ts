// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayCloudMintCredentialProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { ThreadVmEndpointError } from "../machines/E2BThreadVmEndpoint.ts";
import {
  connectThreadVmIfBound,
  DevThreadVmClientEndpoint,
  getThreadVmStatusIfBound,
} from "./ThreadVmClientConnection.ts";

const keys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
const guest = keys(),
  relay = keys();
const decodeClaims = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);
const endpoint = {
  providerKind: "manual" as const,
  httpBaseUrl: "http://3773-sandbox.localhost:12345",
  wsBaseUrl: "ws://3773-sandbox.localhost:12345",
};

function fixture(local: boolean, initialState: "running" | "paused" = "running") {
  let state = initialState,
    revoked = false,
    managedReads = 0,
    mints = 0,
    localReads = 0;
  let afterMint: (() => void) | undefined;
  // Row-store protocol double: authorization still runs the production access functions.
  // SQL locking/joins are covered by the Postgres admission suites.
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        const query = strings.join("?").replace(/\s+/gu, " ").trim();
        if (query.includes("FROM relay_thread_vm_bindings WHERE environment_id"))
          return [{ threadId: "thread" }];
        if (query.includes("FROM relay_thread_placements")) {
          if (query.startsWith("SELECT thread_id FROM")) return [{ thread_id: "thread" }];
          return [
            {
              threadId: "thread",
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: "owner",
              environmentId: "env",
              projectId: "project",
              generation: 1,
              operationId: null,
            },
          ];
        }
        if (
          query.includes("FROM relay_thread_deletions") ||
          query.includes("FROM relay_thread_local_enrollments")
        )
          return [];
        if (query.includes("FROM relay_organization_members")) return [{ role: "admin" }];
        if (query.includes("FROM relay_repositories")) return [{ repository_id: "repo" }];
        if (query.includes("FROM relay_thread_vm_allocations"))
          return state === "running" || values[1] === true
            ? [{ allocationId: "allocation", sandboxId: "sandbox", templateId: "template", state }]
            : [];
        if (query.includes("FROM relay_thread_vm_bindings b"))
          return revoked
            ? []
            : [
                {
                  environmentPublicKey: guest.publicKey,
                  credentialId: "credential",
                  operationId: "operation",
                },
              ];
        throw new Error("Unexpected connection query");
      }),
    { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
  ) as unknown as RelayDb["Service"]["$client"];
  const allocation = {
    userId: "thread-vm",
    environmentId: "env",
    hostname: "vm.example.test",
    tunnelId: "real-tunnel",
    tunnelName: "real-tunnel",
    dnsRecordId: "real-dns",
    readyAt: "now",
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    updatedAt: "now",
    generation: 1,
  };
  const control = {
    mintCredential: (_sandbox: string, _identity: unknown, proof: string) =>
      Effect.gen(function* () {
        mints++;
        const claims = yield* verifyRelayJwt({
          publicKey: relay.publicKey,
          token: proof,
          typ: RELAY_MINT_REQUEST_TYP,
          issuer: "https://relay.test",
          audience: "t3-env:env",
          nowEpochSeconds: 0,
        }).pipe(Effect.flatMap(decodeClaims));
        afterMint?.();
        return {
          credential: "one-time-credential",
          expiresAt: "1970-01-01T00:01:00Z",
          proof: yield* signRelayJwt({
            privateKey: guest.privateKey,
            typ: RELAY_MINT_RESPONSE_TYP,
            payload: {
              iss: "t3-env:env",
              aud: "https://relay.test",
              sub: "owner",
              jti: "guest-response",
              iat: 0,
              exp: 60,
              environmentId: "env",
              requestNonce: claims.nonce,
              clientProofKeyThumbprint: claims.clientProofKeyThumbprint,
              credential: "one-time-credential",
            },
          }),
        };
      }).pipe(Effect.mapError(() => new ThreadVmEndpointError())),
    health: () => Effect.die("paused status must not call private ingress"),
  };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        DevThreadVmClientEndpoint,
        local
          ? () =>
              Effect.sync(() => {
                localReads++;
                return { endpoint, control };
              })
          : undefined,
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(RelayDb, { $client: sql } as unknown as RelayDb["Service"]),
          Layer.succeed(RelayConfiguration, {
            relayIssuer: "https://relay.test",
            apns: null,
            clerkSecretKey: Redacted.make("clerk-test"),
            clerkPublishableKey: "pk_test",
            clerkJwtAudience: "test",
            apnsDeliveryJobSigningSecret: Redacted.make("test"),
            cloudMintPrivateKey: Redacted.make(relay.privateKey),
            cloudMintPublicKey: relay.publicKey,
            managedEndpointBaseDomain: "example.test",
            managedEndpointNamespace: undefined,
          }),
          Layer.mock(ManagedEndpointAllocations)({
            get: () =>
              Effect.sync(() => {
                if (local) throw new Error("local mode read Cloudflare allocation");
                managedReads++;
                return allocation;
              }),
          }),
          Layer.mock(UserDirectory)({ lookup: () => Effect.succeed(new Map()) }),
          NodeCryptoLayer.layer,
        ),
      ),
    );
  return {
    provide,
    counts: () => ({ managedReads, mints, localReads }),
    revoke: () => (revoked = true),
    pause: () => (state = "paused"),
    afterMint: (action: () => void) => (afterMint = action),
  };
}

describe("VM client endpoint selection", () => {
  it.effect("keeps the default Cloudflare allocation path for paused status without waking", () =>
    Effect.gen(function* () {
      const f = fixture(false, "paused");
      expect(
        yield* f.provide(getThreadVmStatusIfBound({ userId: "owner", environmentId: "env" })),
      ).toMatchObject({
        status: "offline",
        endpoint: { providerKind: "cloudflare_tunnel", httpBaseUrl: "https://vm.example.test/" },
      });
      expect(f.counts()).toEqual({ managedReads: 2, mints: 0, localReads: 0 });
    }),
  );
  it.effect("uses the local endpoint without any Cloudflare read or wake for paused status", () =>
    Effect.gen(function* () {
      const f = fixture(true, "paused");
      expect(
        yield* f.provide(getThreadVmStatusIfBound({ userId: "owner", environmentId: "env" })),
      ).toMatchObject({ status: "offline", endpoint });
      expect(f.counts()).toEqual({ managedReads: 0, mints: 0, localReads: 1 });
    }),
  );
  it.effect("mints and verifies the normal proof-key-bound guest credential in local mode", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      expect(
        yield* f.provide(
          connectThreadVmIfBound({
            userId: "owner",
            environmentId: "env",
            clientProofKeyThumbprint: "client-key",
          }),
        ),
      ).toMatchObject({ environmentId: "env", endpoint, credential: "one-time-credential" });
      expect(f.counts()).toEqual({ managedReads: 0, mints: 1, localReads: 1 });
    }),
  );
  it.effect(
    "rejects revoked or paused identity after minting instead of returning a stale credential",
    () =>
      Effect.gen(function* () {
        for (const change of ["revoke", "pause"] as const) {
          const f = fixture(true);
          f.afterMint(f[change]);
          yield* f
            .provide(
              connectThreadVmIfBound({
                userId: "owner",
                environmentId: "env",
                clientProofKeyThumbprint: "client-key",
              }),
            )
            .pipe(Effect.flip);
          expect(f.counts()).toEqual({ managedReads: 0, mints: 1, localReads: 1 });
        }
      }),
  );
});
