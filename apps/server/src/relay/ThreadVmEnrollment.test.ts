import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  RelayThreadVmEnrollProofPayload,
  RelayThreadVmEnrollRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  RELAY_THREAD_VM_ENROLL_PROOF_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { CLOUD_MACHINE_IDENTITY, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  enrollThreadVm,
  readInstalledThreadVm,
  THREAD_VM_IDENTITY_SECRET,
  type ThreadVmEnrollmentInput,
} from "./ThreadVmEnrollment.ts";

const input: ThreadVmEnrollmentInput = {
  version: 1,
  operationId: "operation",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repository",
    generation: 2,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  seed: Redacted.make("seed-secret"),
};
const response = {
  environmentId: EnvironmentId.make("environment"),
  scope: input.scope,
  relayIssuer: input.relayIssuer,
  cloudMintPublicKey: "mint-public-key",
  environmentCredential: "scoped-token",
};
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmEnrollRequest));
const decodeProof = Schema.decodeUnknownEffect(RelayThreadVmEnrollProofPayload);
function harness() {
  const values = new Map<string, Uint8Array>();
  const requests: Array<typeof RelayThreadVmEnrollProofPayload.Type> = [];
  let reply = response;
  let failPersistence = false;
  let status = 200;
  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: () => Effect.die("Enrollment must publish one atomic record"),
    create: (name, value) =>
      Effect.suspend(() => {
        if (values.has(name) || (name === THREAD_VM_IDENTITY_SECRET && failPersistence))
          return Effect.fail(new SecretStorePersistError({ resource: name, cause: "injected" }));
        values.set(name, value);
        return Effect.void;
      }),
    remove: () => Effect.die("Enrollment must not erase an existing identity"),
    getOrCreateRandom: () => Effect.die("unexpected"),
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      expect(request.url).toBe("https://relay.test/v1/thread-vms/enroll");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("expected JSON body");
      const { proof } = decodeRequest(new TextDecoder().decode(request.body.body));
      const payload = yield* decodeProof(decodeRelayJwt(proof));
      yield* verifyRelayJwt({
        token: proof,
        publicKey: payload.environmentPublicKey,
        typ: RELAY_THREAD_VM_ENROLL_PROOF_TYP,
        issuer: "t3-env:environment",
        audience: input.relayIssuer,
        nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
      }).pipe(Effect.orDie);
      requests.push(payload);
      return HttpClientResponse.fromWeb(request, Response.json(reply, { status }));
    }).pipe(Effect.orDie),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, store),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(response.environmentId),
      }),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(NodeServices.layer),
    );
  return {
    values,
    requests,
    provide,
    setReply: (value: typeof response) => {
      reply = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    failPersistence: (value: boolean) => {
      failPersistence = value;
    },
  };
}

describe("thread VM enrollment", () => {
  it.effect(
    "signs the assigned enrollment and persists one narrow record without starting the server",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const enrolled = yield* enrollThreadVm(input);
        expect(enrolled.scope).toEqual(input.scope);
        expect(h.requests[0]).toMatchObject({
          allocationId: "allocation",
          operationId: "operation",
          seed: "seed-secret",
          environmentId: "environment",
        });
        expect(yield* readInstalledThreadVm()).toEqual(enrolled);
        expect(yield* enrollThreadVm(input)).toEqual(enrolled);
        expect(h.requests).toHaveLength(1);
        expect(h.values.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(false);
        expect(h.values.has(CLOUD_MACHINE_IDENTITY)).toBe(false);
        expect(new TextDecoder().decode(h.values.get(THREAD_VM_IDENTITY_SECRET))).not.toContain(
          "seed-secret",
        );
      }).pipe(h.provide);
    },
  );
  it.effect("keeps its identity across a lost reply and a failed local write", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.setStatus(503);
      expect(yield* Effect.flip(enrollThreadVm(input))).toMatchObject({ stage: "request" });
      expect(h.values.has(THREAD_VM_IDENTITY_SECRET)).toBe(false);
      h.setStatus(200);
      h.failPersistence(true);
      expect(yield* Effect.flip(enrollThreadVm(input))).toMatchObject({ stage: "persist" });
      h.failPersistence(false);
      const enrolled = yield* enrollThreadVm(input);
      expect(enrolled.environmentCredential).toBe("scoped-token");
      expect(new Set(h.requests.map((r) => r.environmentPublicKey)).size).toBe(1);
      expect(new Set(h.requests.map((r) => r.jti)).size).toBe(3);
    }).pipe(h.provide);
  });
  it.effect("rejects another thread, generation, environment or relay in the response", () => {
    const h = harness();
    return Effect.gen(function* () {
      for (const reply of [
        { ...response, scope: { ...input.scope, threadId: ThreadId.make("other") } },
        { ...response, scope: { ...input.scope, generation: 3 } },
        { ...response, environmentId: EnvironmentId.make("other") },
        { ...response, relayIssuer: "https://other.test" },
      ]) {
        h.setReply(reply);
        expect(yield* Effect.flip(enrollThreadVm(input))).toMatchObject({ stage: "response" });
        expect(h.values.has(THREAD_VM_IDENTITY_SECRET)).toBe(false);
      }
    }).pipe(h.provide);
  });
  it.effect(
    "rejects a changed installed assignment, corrupt record and pre-existing broad credentials",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        h.values.set(CLOUD_MACHINE_IDENTITY, new TextEncoder().encode("existing-machine"));
        expect(yield* Effect.flip(enrollThreadVm(input))).toMatchObject({ stage: "identity" });
        h.values.delete(CLOUD_MACHINE_IDENTITY);
        yield* enrollThreadVm(input);
        expect(
          yield* Effect.flip(
            enrollThreadVm({ ...input, scope: { ...input.scope, generation: 3 } }),
          ),
        ).toMatchObject({ stage: "identity" });
        h.values.set(THREAD_VM_IDENTITY_SECRET, new TextEncoder().encode("corrupt"));
        expect(yield* Effect.flip(enrollThreadVm(input))).toMatchObject({ stage: "identity" });
        expect(h.requests).toHaveLength(1);
      }).pipe(h.provide);
    },
  );
});
