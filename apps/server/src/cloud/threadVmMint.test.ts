import * as Schema from "effect/Schema";
import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/unstable/http";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { makeThreadVmRepositoryAccess } from "../auth/ThreadVmRepositoryAccess.ts";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { THREAD_VM_IDENTITY_SECRET, type InstalledThreadVm } from "../relay/ThreadVmEnrollment.ts";
import {
  cloudEnvironmentHealthHandler,
  cloudMintCredentialHandler,
  type CloudMintDependencies,
} from "./http.ts";
import { CLOUD_LINKED_USER_ID, CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "./config.ts";

const keys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
const relay = keys();
const environment = keys();
const legacy = keys();
const vm: InstalledThreadVm = {
  operationId: "operation",
  environmentId: EnvironmentId.make("private-vm"),
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repository",
    generation: 1,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  cloudMintPublicKey: relay.publicKey,
  environmentCredential: "thread-credential",
};
const projectId = ProjectId.make("vm:thread");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encode = (value: string) => new TextEncoder().encode(value);
const fixture = Effect.gen(function* () {
  const values = new Map<string, Uint8Array>([
    [THREAD_VM_IDENTITY_SECRET, encode(encodeJson(vm))],
    ["cloud-link-ed25519-key-pair", encode(encodeJson(environment))],
    // A stray old link must not change who may mint a private VM connection.
    [CLOUD_MINT_PUBLIC_KEY, encode(legacy.publicKey)],
    [RELAY_ISSUER_SECRET, encode("https://legacy.test")],
    [CLOUD_LINKED_USER_ID, encode("other-user")],
  ]);
  const secrets: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    create: (name, value) =>
      Effect.suspend(() => {
        if (values.has(name))
          return Effect.fail(
            new SecretStorePersistError({
              resource: name,
              cause: PlatformError.systemError({
                module: "FileSystem",
                method: "writeFile",
                _tag: "AlreadyExists",
              }),
            }),
          );
        values.set(name, value);
        return Effect.void;
      }),
    set: () => Effect.die("must not install broad identity"),
    remove: () => Effect.die("must not change identity"),
    getOrCreateRandom: () => Effect.die("must not change identity"),
  };
  let allowed = true;
  const access = yield* makeThreadVmRepositoryAccess(vm, {
    version: 1,
    operationId: vm.operationId,
    environmentId: vm.environmentId,
    projectId,
    scope: vm.scope,
    workspaceRoot: "/workspace/project",
    revision: "a".repeat(40),
    sequence: 2,
    execution: "frozen",
  }).pipe(
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(vm.environmentId),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            allowed
              ? Response.json({
                  environmentId: vm.environmentId,
                  threadId: vm.scope.threadId,
                  projectId,
                  repositoryId: vm.scope.repositoryId,
                  generation: 1,
                  userId: "owner",
                })
              : new Response("revoked", { status: 403 }),
          ),
        ),
      ),
    ),
  );
  const issued: Array<
    Parameters<CloudMintDependencies["environmentAuth"]["createPairingLink"]>[0]
  > = [];
  const dependencies: CloudMintDependencies = {
    secrets,
    environment: { getEnvironmentId: Effect.succeed(vm.environmentId) },
    environmentAuth: {
      createPairingLink: (input) =>
        Effect.gen(function* () {
          issued.push(input);
          const now = yield* DateTime.now;
          return {
            id: "pairing",
            credential: "one-time-credential",
            scopes: AuthStandardClientScopes,
            subject: "cloud-connect",
            createdAt: now,
            expiresAt: DateTime.add(now, { minutes: 2 }),
          };
        }),
    },
  };
  const sign = (
    input: {
      userId?: string;
      key?: string;
      issuer?: string;
      nonce?: string;
      proofKey?: string;
      health?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      return yield* signRelayJwt({
        privateKey: input.key ?? relay.privateKey,
        typ: input.health ? RELAY_HEALTH_REQUEST_TYP : RELAY_MINT_REQUEST_TYP,
        payload: {
          iss: input.issuer ?? vm.relayIssuer,
          aud: `t3-env:${vm.environmentId}`,
          sub: input.userId ?? "owner",
          iat,
          exp: iat + 120,
          jti: NodeCrypto.randomUUID(),
          nonce: input.nonce ?? NodeCrypto.randomUUID(),
          environmentId: vm.environmentId,
          scope: [input.health ? "environment:status" : "environment:connect"],
          clientProofKeyThumbprint: "client-key",
          cnf: { jkt: input.proofKey ?? "client-key" },
          name: "Owner",
        },
      });
    });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(NodeEffectCrypto.layer),
      Effect.provideService(RepositoryAccess, access),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://vm.test/api/t3-connect/mint-credential")),
      ),
    );
  return {
    values,
    access,
    issued,
    dependencies,
    sign,
    provide,
    revoke: () => {
      allowed = false;
    },
    health: (proof: string) =>
      cloudEnvironmentHealthHandler(
        {
          secrets,
          environment: {
            ...dependencies.environment,
            getDescriptor: Effect.succeed({
              environmentId: vm.environmentId,
              label: "Private VM",
              platform: { os: "linux", arch: "arm64" },
              serverVersion: "test",
              capabilities: { repositoryIdentity: true },
            }),
          },
        },
        { proof },
      ).pipe(provide),
    mint: (proof: string) => cloudMintCredentialHandler(dependencies, { proof }).pipe(provide),
  };
});

describe("private VM cloud connection credentials", () => {
  it.effect(
    "uses only the narrow enrollment and authenticates the owner before issuing a proof-bound credential",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const proof = yield* f.sign();
        const result = yield* f.mint(proof);
        assert.equal(result.credential, "one-time-credential");
        assert.equal(f.issued.length, 1);
        assert.deepEqual(f.issued[0]?.user, {
          userId: "owner",
          displayName: "Owner",
          imageUrl: null,
        });
        assert.equal(f.issued[0]?.proofKeyThumbprint, "client-key");
        const response = yield* verifyRelayJwt({
          publicKey: environment.publicKey,
          token: result.proof,
          typ: RELAY_MINT_RESPONSE_TYP,
          issuer: `t3-env:${vm.environmentId}`,
          audience: vm.relayIssuer,
          nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
        });
        assert.equal(response.sub, vm.environmentId);
        assert.equal((yield* f.mint(proof).pipe(Effect.flip))._tag, "EnvironmentHttpConflictError");
        assert.equal(f.issued.length, 1);
      }),
  );

  it.effect(
    "rejects other users, legacy keys, malformed identity and missing private access wiring",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const options of [
          { userId: "other-user" },
          { key: legacy.privateKey, issuer: "https://legacy.test" },
          { proofKey: "wrong-key" },
        ])
          assert.equal(
            (yield* f.mint(yield* f.sign(options)).pipe(Effect.flip))._tag,
            "EnvironmentHttpUnauthorizedError",
          );
        const proof = yield* f.sign();
        const broad = yield* RepositoryAccess;
        yield* cloudMintCredentialHandler(f.dependencies, { proof }).pipe(
          Effect.provideService(RepositoryAccess, broad),
          f.provide,
          Effect.flip,
        );
        f.values.set(THREAD_VM_IDENTITY_SECRET, encode("corrupt"));
        assert.equal(
          (yield* f.mint(proof).pipe(Effect.flip))._tag,
          "EnvironmentHttpUnauthorizedError",
        );
        assert.equal(f.issued.length, 0);
      }),
  );

  it.effect("refuses new credentials after the owner loses repository access", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.mint(yield* f.sign());
      f.revoke();
      yield* TestClock.adjust("5 seconds");
      yield* f.mint(yield* f.sign()).pipe(Effect.flip);
      assert.equal(f.issued.length, 1);
    }),
  );
});

describe("private VM signed health", () => {
  it.effect("uses the installed VM key and authorizes the owner without minting a credential", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const proof = yield* f.sign({ health: true });
      const response = yield* f.health(proof);
      assert.equal(response.status, "online");
      const verified = yield* verifyRelayJwt({
        publicKey: environment.publicKey,
        token: response.proof,
        typ: RELAY_HEALTH_RESPONSE_TYP,
        issuer: `t3-env:${vm.environmentId}`,
        audience: vm.relayIssuer,
        nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
      });
      assert.equal(verified.environmentId, vm.environmentId);
      assert.equal(f.issued.length, 0);
      assert.equal((yield* f.health(proof).pipe(Effect.flip))._tag, "EnvironmentHttpConflictError");
    }),
  );
  it.effect("rejects stale identity, other users, legacy proofs and removed access", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const options of [
        { userId: "other-user" },
        { key: legacy.privateKey, issuer: "https://legacy.test" },
        { health: false },
      ]) {
        const proof = yield* f.sign({ health: true, ...options });
        assert.equal(
          (yield* f.health(proof).pipe(Effect.flip))._tag,
          "EnvironmentHttpUnauthorizedError",
        );
      }
      yield* f.health(yield* f.sign({ health: true }));
      f.revoke();
      yield* TestClock.adjust("5 seconds");
      yield* f.health(yield* f.sign({ health: true })).pipe(Effect.flip);
      f.values.set(THREAD_VM_IDENTITY_SECRET, encode("corrupt"));
      yield* f.health(yield* f.sign({ health: true })).pipe(Effect.flip);
      assert.equal(f.issued.length, 0);
    }),
  );
});
