import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  getCodexVmSignInReturnUrl,
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

describe("Codex sign-in return destination", () => {
  it.each([
    ["http://localhost:6280", "http://localhost:6280/settings/organization"],
    ["http://127.0.0.1:3773", "http://127.0.0.1:3773/settings/organization"],
    ["http://[::1]:3773", "http://[::1]:3773/settings/organization"],
    ["https://localhost:6280", "https://localhost:6280/settings/organization"],
    ["t3code://app", "t3code://codex-vm-sign-in"],
    ["t3code-dev://app", "t3code-dev://codex-vm-sign-in"],
  ])("returns to the client that started sign-in at %s", (origin, destination) => {
    expect(getCodexVmSignInReturnUrl(origin)).toBe(destination);
  });

  it.each([
    undefined,
    "null",
    "https://app.example.com",
    "http://localhost.example.com",
    "http://localhost@evil.example.com",
    "http://user:password@localhost:6280",
    "http://localhost:6280/elsewhere",
    "http://localhost:6280/?return_to=https://evil.example.com",
    "http://localhost:6280/#fragment",
    "javascript:alert(1)",
    "t3code://app/elsewhere",
    "t3code://app?return_to=elsewhere",
    "t3code://other",
    "t3code-alpha://app",
  ])("does not create a return link for %s", (origin) => {
    expect(getCodexVmSignInReturnUrl(origin)).toBeUndefined();
  });
});

const fetchCallback = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({
          status: response.status,
          cache: response.headers["cache-control"],
          contentType: response.headers["content-type"],
          referrerPolicy: response.headers["referrer-policy"],
          contentSecurityPolicy: response.headers["content-security-policy"],
          body,
        })),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

it.layer(NodeServices.layer)("Codex VM sign-in listener", (it) => {
  it.effect("rejects invalid callbacks, receives once, and isolates other connections", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(true, "http://localhost:6280");
      const other = yield* makeCodexVmSignIn(true);
      const bridge = yield* owner.start;
      const wrong = yield* fetchCallback(`${bridge.redirectUri}?state=wrong&code=code`);
      assert.equal(wrong.status, 400);
      assert.include(wrong.contentType ?? "", "text/html");
      assert.include(wrong.body, "This sign-in link is invalid");
      assert.equal(wrong.cache, "no-store");
      assert.equal(wrong.referrerPolicy, "no-referrer");
      const foreign = yield* other.wait(bridge.bridgeId).pipe(Effect.flip);
      assert.equal(foreign.reason, "not_found");
      const response = yield* fetchCallback(
        `${bridge.redirectUri}?state=${bridge.state}&code=authorization-code-secret&client_id=issued-client&return_to=https://evil.example.com`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.cache, "no-store");
      assert.include(response.contentType ?? "", "text/html");
      assert.equal(response.referrerPolicy, "no-referrer");
      assert.include(response.contentSecurityPolicy ?? "", "default-src 'none'");
      assert.include(response.body, "Sign-in received");
      assert.include(response.body, 'href="http://localhost:6280/settings/organization"');
      assert.notInclude(response.body, "authorization-code-secret");
      assert.notInclude(response.body, "issued-client");
      assert.notInclude(response.body, bridge.state);
      assert.notInclude(response.body, "evil.example.com");
      assert.deepEqual(yield* owner.wait(bridge.bridgeId), {
        state: bridge.state,
        code: "authorization-code-secret",
        clientId: "issued-client",
      });
    }).pipe(Effect.scoped),
  );

  for (const [origin, destination] of [
    ["t3code://app", "t3code://codex-vm-sign-in"],
    ["t3code-dev://app", "t3code-dev://codex-vm-sign-in"],
  ])
    it.effect(`returns ${origin} to the matching desktop app`, () =>
      Effect.gen(function* () {
        const owner = yield* makeCodexVmSignIn(true, origin);
        const bridge = yield* owner.start;
        const response = yield* fetchCallback(
          `${bridge.redirectUri}?state=${bridge.state}&code=desktop-code-secret`,
        );
        assert.equal(response.status, 200);
        assert.include(response.body, `href="${destination}"`);
        assert.notInclude(response.body, "desktop-code-secret");
        assert.deepEqual(yield* owner.wait(bridge.bridgeId), {
          state: bridge.state,
          code: "desktop-code-secret",
        });
      }).pipe(Effect.scoped),
    );

  it.effect("shows a failed sign-in without hiding a denied callback from the client", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(true, "http://localhost:6280");
      const bridge = yield* owner.start;
      const errorDescription = "untrusted-description-<script>alert(1)</script>";
      const response = yield* fetchCallback(
        `${bridge.redirectUri}?state=${bridge.state}&error=access_denied&error_description=${encodeURIComponent(errorDescription)}`,
      );
      assert.equal(response.status, 200);
      assert.match(response.body, /Sign-in (?:was not|wasn[’']t) completed/u);
      assert.notInclude(response.body, "Sign-in received");
      assert.notInclude(response.body, errorDescription);
      assert.notInclude(response.body, "access_denied");
      assert.notInclude(response.body, bridge.state);
      assert.equal(response.cache, "no-store");
      assert.equal(response.referrerPolicy, "no-referrer");
      assert.include(response.body, 'href="http://localhost:6280/settings/organization"');
      assert.deepEqual(yield* owner.wait(bridge.bridgeId), {
        state: bridge.state,
        error: "access_denied",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not turn an untrusted origin into a browser return destination", () =>
    Effect.gen(function* () {
      const owner = yield* makeCodexVmSignIn(true, "https://evil.example.com");
      const bridge = yield* owner.start;
      const response = yield* fetchCallback(
        `${bridge.redirectUri}?state=${bridge.state}&code=code`,
      );
      assert.equal(response.status, 200);
      assert.notInclude(response.body, "evil.example.com");
      assert.notMatch(response.body, /href=/u);
      assert.deepEqual(yield* owner.wait(bridge.bridgeId), { state: bridge.state, code: "code" });
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
