import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { CodexVmConnectionError, type RelayCodexVmToken } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { mintThreadVmCodexToken, waitForThreadVmCodexToken } from "./ThreadVmCodexToken.ts";

const ready: RelayCodexVmToken = {
  status: "ready",
  connectionId: "connection",
  label: "Organization Codex",
  epoch: 2,
  tokenRevision: 3,
  token: "access-token-canary",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeError = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const vm = {
  operationId: "00000000-0000-4000-8000-000000000001",
  scope: { allocationId: "allocation", threadId: "thread", repositoryId: "repo", generation: 2 },
  environmentId: "vm-environment",
  relayUrl: "https://relay.test",
  relayIssuer: "https://issuer.test",
  environmentCredential: "vm-credential",
  cloudMintPublicKey: "key",
};
function fixture(options?: {
  readonly token?: unknown;
  readonly status?: number;
  readonly enrolled?: boolean;
  readonly environmentId?: string;
}) {
  const requests: { url: string; body: unknown; authorization: string | undefined }[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name) =>
          Effect.succeed(
            name === THREAD_VM_IDENTITY_SECRET && options?.enrolled !== false
              ? Option.some(new TextEncoder().encode(encode(vm)))
              : Option.none(),
          ),
        set: () => Effect.die("Codex helper must not store a token"),
        create: () => Effect.die("Codex helper must not store a token"),
        remove: () => Effect.die("Codex helper must not modify secrets"),
        getOrCreateRandom: () => Effect.die("Codex helper must not create identity"),
      }),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make(options?.environmentId ?? vm.environmentId),
        ),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({
              url: request.url,
              authorization: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : null,
            });
            return HttpClientResponse.fromWeb(
              request,
              Response.json(options?.token ?? ready, { status: options?.status ?? 200 }),
            );
          }),
        ),
      ),
    );
  return { requests, provide };
}

describe("VM Codex access-token helper", () => {
  it.effect(
    "uses only the installed VM scope and returns an access token without storing credentials",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* mintThreadVmCodexToken("connection").pipe(f.provide);
        expect(Redacted.value(result)).toBe("access-token-canary");
        expect(f.requests.map((r) => r.url)).toEqual([
          "https://relay.test/v1/environments/vm-environment/threads/thread/credentials/codex",
        ]);
        expect(f.requests.every((r) => r.authorization === "Bearer vm-credential")).toBe(true);
        expect(f.requests[0]?.body).toBe('{"generation":2,"connectionId":"connection"}');
      }),
  );

  it.effect("does not borrow personal authentication outside an enrolled VM", () =>
    Effect.gen(function* () {
      const f = fixture({ enrolled: false });
      const error = yield* mintThreadVmCodexToken("connection").pipe(f.provide, Effect.flip);
      expect(error.reason).toBe("not_managed");
      expect(f.requests).toHaveLength(0);
    }),
  );

  it.effect("blocks stale environment identity before requesting any credentials", () =>
    Effect.gen(function* () {
      const f = fixture({ environmentId: "another-environment" });
      const error = yield* mintThreadVmCodexToken("connection").pipe(f.provide, Effect.flip);
      expect(error.reason).toBe("selection_changed");
      expect(f.requests).toHaveLength(0);
    }),
  );

  it.effect(
    "returns the relay's confirmed disconnection without falling back to another account",
    () =>
      Effect.gen(function* () {
        const f = fixture({
          token: { _tag: "CodexVmConnectionError", reason: "not_connected" },
          status: 409,
        });
        const error = yield* mintThreadVmCodexToken("connection").pipe(f.provide, Effect.flip);
        expect(error.reason).toBe("not_connected");
        expect(f.requests).toHaveLength(1);
      }),
  );

  it.effect("waits for one shared renewal then uses the committed access-token revision", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let requests = 0;
      const request = Effect.gen(function* () {
        requests++;
        if (requests === 1) {
          yield* Deferred.succeed(entered, undefined);
          return { status: "pending", retryAfterMs: 100 } as const;
        }
        return ready;
      });
      const work = yield* waitForThreadVmCodexToken("connection", request).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(100);
      expect(Redacted.value(yield* Fiber.join(work))).toBe("access-token-canary");
      expect(requests).toBe(2);
    }),
  );

  it.effect("bounds waiting without repeatedly exchanging or printing secrets", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const request = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const work = yield* waitForThreadVmCodexToken("connection", request).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(work)).reason).toBe("unavailable");
    }),
  );

  for (const invalid of [
    { ...ready, connectionId: "changed" },
    { ...ready, token: "credential\ncanary" },
    { ...ready, expiresAt: "1960-01-01T00:00:00.000Z" },
  ]) {
    it.effect("rejects invalid delivery metadata and token output", () =>
      Effect.gen(function* () {
        yield* waitForThreadVmCodexToken("connection", Effect.succeed(invalid)).pipe(Effect.flip);
      }),
    );
  }

  it.effect("sanitizes transport and confirmed disconnect failures", () =>
    Effect.gen(function* () {
      const failure = yield* waitForThreadVmCodexToken(
        "connection",
        Effect.fail({ accessToken: "secret-body-canary", cause: "credential-canary" }),
      ).pipe(Effect.flip);
      expect(yield* encodeError(failure)).not.toContain("canary");
      expect("cause" in failure).toBe(false);
      const disconnected = yield* waitForThreadVmCodexToken(
        "connection",
        Effect.fail(new CodexVmConnectionError({ reason: "not_connected" })),
      ).pipe(Effect.flip);
      expect(disconnected.reason).toBe("not_connected");
    }),
  );
});
