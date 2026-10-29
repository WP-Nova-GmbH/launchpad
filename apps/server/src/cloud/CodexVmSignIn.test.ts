import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  makeCodexVmSignIn,
  parseCodexVmSignInCallback,
  supportsCodexVmSignIn,
} from "./CodexVmSignIn.ts";

describe("Codex VM sign-in callback validation", () => {
  const state = "expected-state";
  it("forwards only state, code and issued client ID", () => {
    expect(
      parseCodexVmSignInCallback(
        "GET",
        "/auth/callback?state=expected-state&code=code-value&client_id=issued-client&other=ignored",
        state,
      ),
    ).toEqual({ state, code: "code-value", clientId: "issued-client" });
  });
  it("accepts a denied response only with the expected state", () => {
    expect(
      parseCodexVmSignInCallback(
        "GET",
        "/auth/callback?state=expected-state&error=access_denied&error_description=untrusted",
        state,
      ),
    ).toEqual({ state, error: "access_denied" });
    expect(
      parseCodexVmSignInCallback("GET", "/auth/callback?state=wrong&error=access_denied", state),
    ).toBeNull();
  });
  it.each([
    ["POST", "/auth/callback?state=expected-state&code=code"],
    ["GET", "/elsewhere?state=expected-state&code=code"],
    ["GET", "http://127.0.0.1/auth/callback?state=expected-state&code=code"],
    ["GET", "/auth/callback?state=expected-state&code=code&state=expected-state"],
    ["GET", "/auth/callback?state=expected-state&code=code&client_id=first&client_id=second"],
    ["GET", "/auth/callback?state=expected-state&code=code&error=access_denied"],
    ["GET", "/auth/callback?state=expected-state&code="],
    ["GET", "/auth/callback?state=expected-state&code=code%0Ainjected"],
    ["GET", "/auth/callback?state=wrong&code=code"],
  ])("rejects %s %s", (method, target) => {
    expect(parseCodexVmSignInCallback(method, target, state)).toBeNull();
  });
});

describe("local callback capability", () => {
  const local = {
    origin: "http://localhost:6280",
    host: "127.0.0.1:3773",
    remoteAddress: "127.0.0.1",
    forwarded: false,
  };
  it.each([
    "http://localhost:6280",
    "http://127.0.0.1:3773",
    "http://[::1]:3773",
    "t3code://app",
    "t3code-dev://app",
  ])("supports %s on the loopback host", (origin) => {
    expect(supportsCodexVmSignIn({ ...local, origin })).toBe(true);
  });
  it("rejects remote browser, remote server, tunnel, proxy and missing origins", () => {
    for (const override of [
      { origin: "https://app.example.com" },
      { host: "remote.example.com" },
      { remoteAddress: "192.168.1.2" },
      { forwarded: true },
      { origin: undefined },
      { origin: "null" },
    ])
      expect(supportsCodexVmSignIn({ ...local, ...override })).toBe(false);
  });
});

const fetchCallback = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.as({
          status: response.status,
          cache: response.headers["cache-control"],
        }),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

it.layer(NodeServices.layer)("Codex VM sign-in listener", (it) => {
  it.effect("rejects invalid callbacks, receives once, and isolates other connections", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(true);
      const other = yield* makeCodexVmSignIn(true);
      const bridge = yield* owner.start;
      const wrong = yield* fetchCallback(`${bridge.redirectUri}?state=wrong&code=code`);
      assert.equal(wrong.status, 400);
      const foreign = yield* other.wait(bridge.bridgeId).pipe(Effect.flip);
      assert.equal(foreign.reason, "not_found");
      const response = yield* fetchCallback(
        `${bridge.redirectUri}?state=${bridge.state}&code=code&client_id=issued-client`,
      );
      assert.deepEqual(response, { status: 200, cache: "no-store" });
      assert.deepEqual(yield* owner.wait(bridge.bridgeId), {
        state: bridge.state,
        code: "code",
        clientId: "issued-client",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("new attempts cancel old waiters without exposing their callback", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(true);
      const first = yield* owner.start;
      const waiting = yield* owner
        .wait(first.bridgeId)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      const second = yield* owner.start;
      assert.notEqual(second.state, first.state);
      assert.equal((yield* Fiber.join(waiting)).reason, "cancelled");
      assert.equal((yield* owner.cancel(first.bridgeId).pipe(Effect.flip)).reason, "not_found");
      yield* owner.cancel(second.bridgeId);
      assert.equal((yield* owner.wait(second.bridgeId).pipe(Effect.flip)).reason, "cancelled");
    }).pipe(Effect.scoped),
  );

  it.effect("expires under the test clock and cleans up on connection shutdown", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const owner = yield* makeCodexVmSignIn(true).pipe(Effect.provideService(Scope.Scope, scope));
      const bridge = yield* owner.start;
      yield* TestClock.adjust("10 minutes");
      assert.equal((yield* owner.wait(bridge.bridgeId).pipe(Effect.flip)).reason, "expired");
      const next = yield* owner.start;
      const waiting = yield* owner
        .wait(next.bridgeId)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Scope.close(scope, Exit.void);
      assert.equal((yield* Fiber.join(waiting)).reason, "cancelled");
      assert.equal((yield* owner.wait(next.bridgeId).pipe(Effect.flip)).reason, "not_found");
    }),
  );

  it.effect("does not open a listener for unsupported clients", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(false);
      assert.equal((yield* owner.start.pipe(Effect.flip)).reason, "unsupported_surface");
    }).pipe(Effect.scoped),
  );
});
