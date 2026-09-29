import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopLocalSession,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  __resetDesktopPrimaryAuthForTests,
  readDesktopPrimaryBearerToken,
  readDesktopLocalSession,
  setDesktopLocalAccount,
  DESKTOP_PRIMARY_AUTH_CHANGED,
} from "./desktopAuth";

function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const makeBridge = () => {
  let session: DesktopLocalSession = {
    token: "anonymous-0",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    accountId: null,
    generation: 0,
    user: null,
  };
  const bridge = {
    getLocalEnvironmentBootstraps: () => [],
    getLocalEnvironmentSession: vi.fn(async () => session),
    setLocalEnvironmentAccount: vi.fn(async (accountId: string | null) => {
      session = {
        ...session,
        accountId,
        generation: session.generation + 1,
        user: null,
        token: `anonymous-${session.generation + 1}`,
      };
    }),
    attachLocalEnvironmentIdentity: vi.fn(async (input: { generation: number; token: string }) => {
      if (input.generation !== session.generation || !session.accountId) return null;
      session = {
        ...session,
        token: "identified",
        user: { userId: session.accountId, displayName: "Alice", imageUrl: null },
      };
      return session;
    }),
  };
  window.desktopBridge = bridge as unknown as DesktopBridge;
  return bridge;
};

describe("desktop local identity", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  });
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reads current credentials from their main-process owner", async () => {
    const bridge = makeBridge();
    const first = await readDesktopPrimaryBearerToken();
    await bridge.setLocalEnvironmentAccount(null);
    expect(await readDesktopPrimaryBearerToken()).not.toBe(first);
  });

  it("keeps anonymous access available while verifying, then reconnects with the verified session", async () => {
    makeBridge();
    const token = deferred<string>();
    setDesktopLocalAccount({ id: "alice", readToken: () => token.promise });
    const anonymous = await readDesktopPrimaryBearerToken();
    expect(anonymous).toMatch(/^anonymous/);
    const changed = deferred<void>();
    window.addEventListener(DESKTOP_PRIMARY_AUTH_CHANGED, () => changed.resolve(undefined), {
      once: true,
    });
    token.resolve("clerk-alice");
    await changed.promise;
    expect(await readDesktopPrimaryBearerToken()).toBe("identified");
  });

  it("discards a token read that finishes after signout", async () => {
    const bridge = makeBridge();
    const token = deferred<string>();
    setDesktopLocalAccount({ id: "alice", readToken: () => token.promise });
    await readDesktopPrimaryBearerToken();
    setDesktopLocalAccount(null);
    const anonymous = await readDesktopLocalSession(PRIMARY_LOCAL_ENVIRONMENT_ID);
    expect(anonymous.user).toBeNull();
    token.resolve("old-alice-token");
    await readDesktopPrimaryBearerToken();
    expect(bridge.attachLocalEnvironmentIdentity).not.toHaveBeenCalled();
  });

  it("verifies the next account without waiting for the previous Clerk token read", async () => {
    const bridge = makeBridge();
    const previousToken = deferred<string>();
    setDesktopLocalAccount({ id: "alice", readToken: () => previousToken.promise });
    await readDesktopPrimaryBearerToken();
    const attached = deferred<void>();
    const implementation = bridge.attachLocalEnvironmentIdentity.getMockImplementation()!;
    bridge.attachLocalEnvironmentIdentity.mockImplementation(async (input) => {
      const result = await implementation(input);
      attached.resolve(undefined);
      return result;
    });
    setDesktopLocalAccount({ id: "bob", readToken: async () => "bob-token" });
    await readDesktopPrimaryBearerToken();
    await attached.promise;
    expect((await readDesktopLocalSession(PRIMARY_LOCAL_ENVIRONMENT_ID)).user?.userId).toBe("bob");
    previousToken.resolve("late-alice-token");
    expect((await readDesktopLocalSession(PRIMARY_LOCAL_ENVIRONMENT_ID)).user?.userId).toBe("bob");
  });

  it("recovers from a failed IPC transition on the next connection read", async () => {
    const bridge = makeBridge();
    bridge.setLocalEnvironmentAccount.mockRejectedValueOnce(new Error("IPC interrupted"));
    await expect(readDesktopPrimaryBearerToken()).rejects.toThrow("IPC interrupted");
    expect(await readDesktopPrimaryBearerToken()).toMatch(/^anonymous/);
  });

  it("reports failed identity verification and retains local access", async () => {
    const bridge = makeBridge();
    bridge.attachLocalEnvironmentIdentity.mockRejectedValue(new Error("relay unavailable"));
    const warning = deferred<void>();
    setDesktopLocalAccount({ id: "alice", readToken: async () => "clerk" }, () =>
      warning.resolve(undefined),
    );
    expect(await readDesktopPrimaryBearerToken()).toMatch(/^anonymous/);
    await warning.promise;
    expect(await readDesktopPrimaryBearerToken()).toMatch(/^anonymous/);
  });

  it("does not require desktop auth in a browser", async () => {
    expect(await readDesktopPrimaryBearerToken()).toBeNull();
  });
});
