import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MACHINE_IDENTITY,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { reconcileMachineEnrollment } from "./machineEnrollment.ts";
import * as NodeCrypto from "node:crypto";

const relayMintKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
  const values = new Map<string, Uint8Array>(
    Array.from(initial, ([name, value]) => [name, encoder.encode(value)] as const),
  );
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.suspend(() =>
        values.has(name)
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: new Error("exists"),
              }),
            )
          : Effect.sync(() => {
              values.set(name, value);
            }),
      ),
    getOrCreateRandom: () => Effect.die("unused getOrCreateRandom"),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
  const read = (name: string) => {
    const bytes = values.get(name);
    return bytes === undefined ? null : decoder.decode(bytes);
  };
  return { store, values, read };
}

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const descriptor = {
  environmentId: EnvironmentId.make("env-machine-test"),
  label: "Machine Test Environment",
  platform: { os: "linux", arch: "arm64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

interface EnrollmentHarness {
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly applyConfigCalls: Array<unknown>;
  readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Record<string, string>;
}

const enrollResponseBody = {
  ok: true,
  machineId: "machine-1",
  organizationId: "organization-1",
  role: "agent_executor",
  environmentId: "env-machine-test",
  endpoint: {
    httpBaseUrl: "http://127.0.0.1:24123",
    wsBaseUrl: "ws://127.0.0.1:24123",
    providerKind: "manual",
  },
  endpointRuntime: null,
  relayIssuer: "http://127.0.0.1:8610",
  environmentCredential: "t3env_machine_credential",
  cloudMintPublicKey: relayMintKeyPair.publicKey,
};

const provideEnrollmentHarness =
  (harness: EnrollmentHarness) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
      Effect.provideService(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
        ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: (config) =>
            Effect.sync(() => {
              harness.applyConfigCalls.push(config);
              return {
                status: "disabled",
              } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            harness.requests.push(request);
            return HttpClientResponse.fromWeb(
              request,
              (harness.respond ?? (() => Response.json(enrollResponseBody)))(request),
            );
          }),
        ),
      ),
      Effect.provide(Layer.mergeAll(cryptoLayer, NodeServices.layer)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: harness.env ?? {} }))),
    );

const machineEnv = {
  T3CODE_MACHINE_ENROLLMENT_SEED: "t3mseed_test_seed",
  T3CODE_MACHINE_ENROLLMENT_RELAY_URL: "http://127.0.0.1:8610",
  T3CODE_MACHINE_ADVERTISED_ORIGIN: "http://127.0.0.1:24123",
};

function requestBodyJson(request: HttpClientRequest.HttpClientRequest): unknown {
  const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
  if (body._tag !== "Uint8Array" || body.body === undefined) {
    throw new Error(`unexpected request body tag: ${body._tag}`);
  }
  return JSON.parse(decoder.decode(body.body));
}

describe("reconcileMachineEnrollment", () => {
  it.effect("does nothing on an environment with no enrollment seed", () => {
    const { store } = makeMemorySecretStore();
    const harness: EnrollmentHarness = { store, requests: [], applyConfigCalls: [] };
    return Effect.gen(function* () {
      const result = yield* reconcileMachineEnrollment("http://127.0.0.1:4483");
      expect(result).toEqual({ outcome: "not-a-machine" });
      expect(harness.requests).toHaveLength(0);
    }).pipe(provideEnrollmentHarness(harness));
  });

  it.effect("never re-enrolls once a machine identity is installed", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_MACHINE_IDENTITY,
        JSON.stringify({
          machineId: "machine-1",
          organizationId: "organization-1",
          role: "agent_executor",
        }),
      ],
    ]);
    const harness: EnrollmentHarness = {
      store,
      requests: [],
      applyConfigCalls: [],
      env: machineEnv,
    };
    return Effect.gen(function* () {
      const result = yield* reconcileMachineEnrollment("http://127.0.0.1:4483");
      expect(result.outcome).toBe("already-enrolled");
      expect(harness.requests).toHaveLength(0);
    }).pipe(provideEnrollmentHarness(harness));
  });

  it.effect("refuses to enroll an environment already linked to a cloud account", () => {
    const { store } = makeMemorySecretStore([[CLOUD_LINKED_USER_ID, "user_123"]]);
    const harness: EnrollmentHarness = {
      store,
      requests: [],
      applyConfigCalls: [],
      env: machineEnv,
    };
    return Effect.gen(function* () {
      const result = yield* reconcileMachineEnrollment("http://127.0.0.1:4483");
      expect(result).toEqual({ outcome: "linked-environment" });
      expect(harness.requests).toHaveLength(0);
    }).pipe(provideEnrollmentHarness(harness));
  });

  it.effect("enrolls, persists the relay configuration, and applies the endpoint runtime", () => {
    const memory = makeMemorySecretStore();
    const harness: EnrollmentHarness = {
      store: memory.store,
      requests: [],
      applyConfigCalls: [],
      env: machineEnv,
    };
    return Effect.gen(function* () {
      const result = yield* reconcileMachineEnrollment("http://127.0.0.1:4483");
      expect(result.outcome).toBe("enrolled");

      expect(harness.requests).toHaveLength(1);
      const request = harness.requests[0]!;
      expect(request.url).toBe("http://127.0.0.1:8610/v1/machines/enroll");
      const body = requestBodyJson(request) as { readonly proof: string };
      const claims = JSON.parse(
        Buffer.from(body.proof.split(".")[1] ?? "", "base64url").toString(),
      ) as Record<string, unknown>;
      expect(claims.seed).toBe("t3mseed_test_seed");
      expect(claims.environmentId).toBe("env-machine-test");
      // The advertised origin, not the loopback bind, is what other parties
      // can reach — the Docker driver maps the container port onto the host.
      expect(claims.endpoint).toMatchObject({ httpBaseUrl: "http://127.0.0.1:24123" });
      expect(claims.origin).toEqual({ localHttpHost: "127.0.0.1", localHttpPort: 4483 });

      expect(memory.read(RELAY_URL_SECRET)).toBe("http://127.0.0.1:8610");
      expect(memory.read(RELAY_ISSUER_SECRET)).toBe("http://127.0.0.1:8610");
      expect(memory.read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe("t3env_machine_credential");
      // The response schema trims string fields, so the stored PEM has no
      // trailing newline.
      expect(memory.read(CLOUD_MINT_PUBLIC_KEY)).toBe(relayMintKeyPair.publicKey.trim());
      expect(memory.read(PUBLISH_AGENT_ACTIVITY_SECRET)).toBe("true");
      expect(memory.read(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBeNull();
      expect(JSON.parse(memory.read(CLOUD_MACHINE_IDENTITY) ?? "{}")).toEqual({
        machineId: "machine-1",
        organizationId: "organization-1",
        role: "agent_executor",
      });
      expect(harness.applyConfigCalls).toEqual([null]);
    }).pipe(provideEnrollmentHarness(harness));
  });

  it.effect("treats a relay refusal as permanent rather than retryable", () => {
    const memory = makeMemorySecretStore();
    const harness: EnrollmentHarness = {
      store: memory.store,
      requests: [],
      applyConfigCalls: [],
      env: machineEnv,
      respond: () =>
        Response.json(
          { code: "machine_enroll_proof_invalid", reason: "seed_invalid" },
          { status: 400 },
        ),
    };
    return Effect.gen(function* () {
      const error = yield* Effect.flip(reconcileMachineEnrollment("http://127.0.0.1:4483"));
      expect(error).toMatchObject({ _tag: "MachineEnrollmentRejected", status: 400 });
      expect(memory.read(CLOUD_MACHINE_IDENTITY)).toBeNull();
      expect(memory.read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBeNull();
    }).pipe(provideEnrollmentHarness(harness));
  });
});
