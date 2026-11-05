import { beforeEach, expect, it, vi } from "vite-plus/test";
import { fetchSessionState, replaceBrowserIdentity } from "./auth";
import { synchronizeBrowserIdentity } from "./browserIdentity";

vi.mock("./auth", () => ({ fetchSessionState: vi.fn(), replaceBrowserIdentity: vi.fn() }));
const session = {
  authenticated: true,
  sessionMethod: "browser-session-cookie" as const,
  auth: {
    policy: "loopback-browser" as const,
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
};
const alice = { id: "alice", readToken: async () => "verified-token" };
beforeEach(() => {
  vi.resetAllMocks();
});

it("verifies a paired anonymous browser and avoids rotating an already verified cookie", async () => {
  vi.mocked(fetchSessionState).mockResolvedValue(session);
  expect(await synchronizeBrowserIdentity(alice, () => true)).toBe(true);
  expect(replaceBrowserIdentity).toHaveBeenCalledWith({
    accountId: "alice",
    token: "verified-token",
  });
  vi.mocked(fetchSessionState).mockResolvedValue({
    ...session,
    user: { userId: "alice", displayName: null, imageUrl: null },
  });
  vi.mocked(replaceBrowserIdentity).mockClear();
  expect(await synchronizeBrowserIdentity(alice, () => true)).toBe(false);
  expect(replaceBrowserIdentity).not.toHaveBeenCalled();
});
it("detaches the previous account before binding a new one and clears it at sign-out", async () => {
  vi.mocked(fetchSessionState).mockResolvedValue({
    ...session,
    user: { userId: "bob", displayName: null, imageUrl: null },
  });
  await synchronizeBrowserIdentity(alice, () => true);
  expect(vi.mocked(replaceBrowserIdentity).mock.calls.map(([identity]) => identity)).toEqual([
    null,
    { accountId: "alice", token: "verified-token" },
  ]);
  vi.mocked(replaceBrowserIdentity).mockClear();
  await synchronizeBrowserIdentity(null, () => true);
  expect(replaceBrowserIdentity).toHaveBeenCalledExactlyOnceWith(null);
});
it("drops a token that resolves after the account changes", async () => {
  vi.mocked(fetchSessionState).mockResolvedValue(session);
  let current = true;
  await synchronizeBrowserIdentity(
    {
      id: "alice",
      readToken: async () => {
        current = false;
        return "old-token";
      },
    },
    () => current,
  );
  expect(replaceBrowserIdentity).not.toHaveBeenCalled();
});
it("recovers a cookie concurrently rotated by another tab but does not hide a failed verification", async () => {
  vi.mocked(fetchSessionState)
    .mockResolvedValueOnce(session)
    .mockResolvedValueOnce({
      ...session,
      user: { userId: "alice", displayName: null, imageUrl: null },
    });
  vi.mocked(replaceBrowserIdentity).mockRejectedValue(new Error("cookie revoked"));
  expect(await synchronizeBrowserIdentity(alice, () => true)).toBe(true);
  vi.mocked(fetchSessionState).mockResolvedValue(session);
  await expect(synchronizeBrowserIdentity(alice, () => true)).rejects.toThrow("cookie revoked");
});
it("does not bind an unpaired browser or a bearer session", async () => {
  vi.mocked(fetchSessionState).mockResolvedValue({ ...session, authenticated: false });
  await synchronizeBrowserIdentity(alice, () => true);
  vi.mocked(fetchSessionState).mockResolvedValue({
    ...session,
    sessionMethod: "bearer-access-token",
  });
  await synchronizeBrowserIdentity(alice, () => true);
  expect(replaceBrowserIdentity).not.toHaveBeenCalled();
});
