import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayThreadVmCodexAuthSource } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import {
  makeThreadVmCodexAuthContext,
  readThreadVmCodexAuthSource,
} from "./ThreadVmCodexAuthSource.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const vm = {
  operationId: "move",
  environmentId: "vm",
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "vm-credential-canary",
  cloudMintPublicKey: "public-key",
  scope: { allocationId: "allocation", threadId: "thread", repositoryId: "repo", generation: 4 },
};
const managed = (connectionId = "connection-one", epoch = 1): RelayThreadVmCodexAuthSource => ({
  mode: "organization",
  connectionId,
  connection: {
    connectionId,
    label: "VM account",
    epoch,
    tokenRevision: 1,
    status: "connected",
    errorCode: null,
    refreshing: false,
  },
});
function fixture(beforeResponse?: (requestNumber: number) => Effect.Effect<void>) {
  let stored: string | undefined = json(vm);
  let response: unknown = managed();
  let status = 200;
  const calls: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name) =>
          Effect.sync(() =>
            name === THREAD_VM_IDENTITY_SECRET && stored !== undefined
              ? Option.some(new TextEncoder().encode(stored))
              : Option.none(),
          ),
        set: () => Effect.die("Source selection must not write credentials"),
        create: () => Effect.die("Source selection must not write credentials"),
        remove: () => Effect.die("Source selection must not remove credentials"),
        getOrCreateRandom: () => Effect.die("Source selection must not create an identity"),
      }),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("vm")),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            calls.push({
              url: request.url,
              authorization: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "",
            });
            const snapshot = Response.json(response, { status });
            if (beforeResponse) yield* beforeResponse(calls.length);
            return HttpClientResponse.fromWeb(request, snapshot);
          }),
        ),
      ),
    );
  return {
    provide,
    calls,
    stored: (value: string | undefined) => {
      stored = value;
    },
    response: (value: unknown, code = 200) => {
      response = value;
      status = code;
    },
  };
}

it.effect("keeps ordinary non-VM providers personal without contacting the relay", () => {
  const f = fixture();
  f.stored(undefined);
  return f.provide(
    Effect.gen(function* () {
      const source = yield* makeThreadVmCodexAuthContext;
      expect(yield* source.current).toBeNull();
      expect(f.calls).toEqual([]);
    }),
  );
});

it.effect("uses the current installed generation and explicit personal selection", () => {
  const f = fixture();
  f.response({ mode: "personal" });
  return f.provide(
    Effect.gen(function* () {
      expect(yield* readThreadVmCodexAuthSource()).toEqual({ mode: "personal" });
      expect(f.calls).toEqual([
        {
          url: "https://relay.test/v1/environments/vm/threads/thread/provider-auth/source",
          authorization: "Bearer vm-credential-canary",
          body: '{"generation":4}',
        },
      ]);
    }),
  );
});

it.effect("fails closed for an installed VM when source discovery is unavailable", () => {
  const f = fixture();
  f.response({ error: "private-error-canary" }, 503);
  return f.provide(
    Effect.gen(function* () {
      const source = yield* makeThreadVmCodexAuthContext;
      const failure = yield* source.current.pipe(Effect.flip);
      expect(failure.reason).toBe("unavailable");
      expect(failure.message).not.toContain("private-error-canary");
      f.response({ mode: "personal" });
      expect(yield* source.refresh).toBe(true);
      expect(yield* source.current).toBeNull();
      expect(yield* source.refresh).toBe(true);
      yield* source.markApplied;
      expect(yield* source.refresh).toBe(false);
    }),
  );
});

it.effect("checks a managed connection before each new operation without fetching tokens", () => {
  const f = fixture();
  return f.provide(
    Effect.gen(function* () {
      const source = yield* makeThreadVmCodexAuthContext,
        context = yield* source.current;
      if (!context) throw new Error("Expected managed Codex");
      yield* context.preflight;
      const disconnected = managed();
      if (disconnected.mode !== "organization") throw new Error("Expected organization source");
      f.response({
        ...disconnected,
        connection: { ...disconnected.connection, status: "disconnected" },
      });
      expect((yield* context.preflight.pipe(Effect.flip)).reason).toBe("reconnect_required");
      expect((yield* context.status).status).toBe("disconnected");
      expect(f.calls.every((call) => call.url.endsWith("/provider-auth/source"))).toBe(true);
    }),
  );
});

it.effect("pins active contexts to their selected account and waits for a rebuild receipt", () => {
  const f = fixture();
  return f.provide(
    Effect.gen(function* () {
      const source = yield* makeThreadVmCodexAuthContext,
        old = yield* source.current;
      if (!old) throw new Error("Expected managed Codex");
      f.response(managed("connection-two"));
      expect((yield* old.preflight.pipe(Effect.flip)).reason).toBe("selection_changed");
      expect(yield* source.refresh).toBe(true);
      expect((yield* source.current)?.connectionId).toBe("connection-two");
      expect(yield* source.refresh).toBe(true);
      yield* source.markApplied;
      expect(yield* source.refresh).toBe(false);
      f.response(managed("connection-two", 2));
      expect(yield* source.refresh).toBe(false);
      expect((yield* (yield* source.current)!.status).epoch).toBe(2);
    }),
  );
});

for (const firstFails of [false, true])
  it.effect(
    `serializes overlapping source refreshes when the older lookup ${firstFails ? "fails" : "succeeds"}`,
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const f = fixture((requestNumber) =>
          requestNumber === 2
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        return yield* f.provide(
          Effect.gen(function* () {
            const source = yield* makeThreadVmCodexAuthContext;
            f.response(
              firstFails ? { error: "unavailable" } : managed("older-selection"),
              firstFails ? 503 : 200,
            );
            const older = yield* source.refresh.pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(entered);
            f.response(firstFails ? managed("latest-selection") : { mode: "personal" });
            const latest = yield* source.refresh.pipe(Effect.forkChild({ startImmediately: true }));
            // The second lookup cannot overtake an in-flight lookup and publish stale state.
            expect(f.calls).toHaveLength(2);
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(older))._tag).toBe(firstFails ? "Failure" : "Success");
            expect(yield* Fiber.join(latest)).toBe(true);
            expect((yield* source.current)?.connectionId ?? null).toBe(
              firstFails ? "latest-selection" : null,
            );
            yield* source.markApplied;
            expect(yield* source.refresh).toBe(false);
          }),
        );
      }),
  );

it.effect("keeps a healthy applied provider after a transient source lookup failure", () => {
  const f = fixture();
  return f.provide(
    Effect.gen(function* () {
      const source = yield* makeThreadVmCodexAuthContext;
      f.response({ error: "temporary-failure" }, 503);
      expect((yield* source.refresh.pipe(Effect.flip)).reason).toBe("unavailable");
      expect((yield* source.current.pipe(Effect.flip)).reason).toBe("unavailable");
      f.response(managed());
      expect(yield* source.refresh).toBe(false);
      const context = yield* source.current;
      if (!context) throw new Error("Expected managed Codex");
      yield* context.preflight;
    }),
  );
});

it.effect("keeps source refresh and its rebuild receipt together across concurrent controls", () =>
  Effect.gen(function* () {
    const rebuilding = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const f = fixture();
    return yield* f.provide(
      Effect.gen(function* () {
        const source = yield* makeThreadVmCodexAuthContext;
        f.response(managed("second-selection"));
        const first = yield* source
          .withReloadLock(
            Effect.gen(function* () {
              expect(yield* source.refresh).toBe(true);
              yield* Deferred.succeed(rebuilding, undefined);
              yield* Deferred.await(release);
              expect((yield* source.current)?.connectionId).toBe("second-selection");
              yield* source.markApplied;
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(rebuilding);
        f.response({ mode: "personal" });
        const second = yield* source
          .withReloadLock(
            Effect.gen(function* () {
              expect(yield* source.refresh).toBe(true);
              expect(yield* source.current).toBeNull();
              yield* source.markApplied;
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(f.calls).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* source.refresh).toBe(false);
      }),
    );
  }),
);

it.effect("never treats corrupt or stale VM identities as personal mode", () => {
  const f = fixture();
  return f.provide(
    Effect.gen(function* () {
      for (const stored of ["corrupt-identity-canary", json({ ...vm, environmentId: "old-vm" })]) {
        f.stored(stored);
        expect((yield* readThreadVmCodexAuthSource().pipe(Effect.flip)).reason).toBe("unavailable");
      }
      expect(f.calls).toEqual([]);
    }),
  );
});

it.effect(
  "blocks an old personal provider after preparation selects an organization account",
  () => {
    const f = fixture();
    f.response({ mode: "personal" });
    return f.provide(
      Effect.gen(function* () {
        const source = yield* makeThreadVmCodexAuthContext;
        expect(yield* source.current).toBeNull();
        yield* source.personalPreflight;
        f.response(managed());
        expect((yield* source.personalPreflight.pipe(Effect.flip)).reason).toBe(
          "selection_changed",
        );
      }),
    );
  },
);
