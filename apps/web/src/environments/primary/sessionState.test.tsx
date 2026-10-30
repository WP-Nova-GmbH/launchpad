import {
  AuthSessionId,
  type AuthCurrentSessionPresentation,
  type AuthSessionState,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { usePrimarySessionState } from "./sessionState";

const fixture = vi.hoisted(() => ({
  live: { isSuccess: false, data: null as AuthCurrentSessionPresentation | null },
  readSession: vi.fn<() => Promise<AuthSessionState>>(),
}));
vi.mock("./auth", () => ({ fetchSessionState: fixture.readSession }));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../../state/auth", () => ({ authEnvironment: { currentSession: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ ...fixture.live }) }));

const anonymous: AuthSessionState = {
  authenticated: false,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
};
const currentSession: AuthCurrentSessionPresentation = {
  sessionId: AuthSessionId.make("new-session"),
  client: { label: "Test browser", deviceType: "desktop" },
  needsClientLabel: false,
};
const paired: AuthSessionState = {
  ...anonymous,
  authenticated: true,
  sessionMethod: "browser-session-cookie",
  currentSession,
};
let renderer: ReactTestRenderer | null;
let observed: ReturnType<typeof usePrimarySessionState> | null;

function Probe() {
  const state = usePrimarySessionState();
  useLayoutEffect(() => {
    observed = state;
  });
  return null;
}
function view(secondConsumer = true) {
  return (
    <AppAtomRegistryProvider>
      {secondConsumer && <Probe />}
      <Probe />
    </AppAtomRegistryProvider>
  );
}

beforeEach(() => {
  renderer = null;
  observed = null;
  appAtomRegistry.reset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.live = { isSuccess: false, data: null };
  fixture.readSession.mockReset().mockResolvedValue(anonymous);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  appAtomRegistry.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains the shared refresh while a later consumer mounts during a pending read", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
  let finishRead: (session: AuthSessionState) => void = () => {};
  const pending = new Promise<AuthSessionState>((resolve) => {
    finishRead = resolve;
  });
  fixture.readSession
    .mockResolvedValueOnce(anonymous)
    .mockReturnValueOnce(pending)
    .mockResolvedValue(paired);
  await act(async () => {
    renderer = create(view(false));
  });
  fixture.live = { isSuccess: true, data: currentSession };
  await act(async () => renderer?.update(view(false)));
  expect(fixture.readSession).toHaveBeenCalledTimes(2);

  await act(() => vi.runOnlyPendingTimers());
  await act(() => renderer?.update(view()));
  expect(fixture.readSession).toHaveBeenCalledTimes(2);

  await act(async () => finishRead(paired));
  expect(observed?.data?.authenticated).toBe(true);
});

it.each([
  anonymous,
  {
    ...paired,
    currentSession: { ...currentSession, sessionId: AuthSessionId.make("old-session") },
    user: { userId: "old-account", displayName: null, imageUrl: null },
  },
])(
  "refreshes stale authentication when a newly paired socket becomes available: %j",
  async (initial) => {
    fixture.readSession.mockResolvedValueOnce(initial).mockResolvedValue(paired);
    await act(async () => {
      renderer = create(view());
    });
    expect(observed?.data?.authenticated).toBe(initial.authenticated);

    fixture.live = { isSuccess: true, data: currentSession };
    await act(async () => renderer?.update(view()));

    expect(observed?.data).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
      currentSession,
    });
    expect(observed?.data?.user).toBeUndefined();
    expect(fixture.readSession).toHaveBeenCalledTimes(2);
  },
);

it("keeps the session value stable across renders with unchanged HTTP and socket data", async () => {
  fixture.readSession.mockResolvedValue(paired);
  fixture.live = { isSuccess: true, data: currentSession };
  await act(async () => {
    renderer = create(view());
  });
  const first = observed?.data;
  await act(() => renderer?.update(view()));

  expect(observed?.data).toBe(first);
});

it("retries a failed refresh on socket reconnection without retrying on renders", async () => {
  fixture.readSession
    .mockResolvedValueOnce(anonymous)
    .mockRejectedValueOnce(new Error("temporarily offline"))
    .mockResolvedValue(paired);
  await act(async () => {
    renderer = create(view());
  });
  fixture.live = { isSuccess: true, data: currentSession };
  await act(async () => renderer?.update(view()));
  expect(fixture.readSession).toHaveBeenCalledTimes(2);
  await act(() => renderer?.update(view()));
  expect(fixture.readSession).toHaveBeenCalledTimes(2);

  fixture.live = { isSuccess: false, data: null };
  await act(() => renderer?.update(view()));
  fixture.live = { isSuccess: true, data: currentSession };
  await act(async () => renderer?.update(view()));

  expect(observed?.data?.authenticated).toBe(true);
  expect(fixture.readSession).toHaveBeenCalledTimes(3);
});
