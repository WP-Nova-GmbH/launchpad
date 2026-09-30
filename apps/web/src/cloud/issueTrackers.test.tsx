import type { RelayIssueTrackerConnections } from "@t3tools/contracts/relay";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => "clerk-token"),
  runPromise: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: mocks.getToken }) }));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: mocks.runPromise } }));
vi.mock("./linkEnvironment", () => ({ decodedRelayClientError: () => (error: unknown) => error }));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { useIssueTrackers } from "./issueTrackers";

const connected: RelayIssueTrackerConnections = {
  linearAvailable: true,
  connections: [
    {
      service: "jira",
      status: "connected",
      accountLabel: "Team Jira",
      updatedAt: "2026-09-30T10:00:00Z",
    },
  ],
};
let state: ReturnType<typeof useIssueTrackers>;
let renderer: ReactTestRenderer;

function Probe() {
  const current = useIssueTrackers();
  useLayoutEffect(() => {
    state = current;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  mocks.runPromise.mockReset().mockResolvedValueOnce(connected);
  await act(async () => {
    renderer = create(<Probe />);
  });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("organization issue tracker state", () => {
  it("does not let an older read restore a disconnected connection", async () => {
    let resolveRead!: (value: RelayIssueTrackerConnections) => void;
    const read = new Promise<RelayIssueTrackerConnections>((resolve) => {
      resolveRead = resolve;
    });
    mocks.runPromise.mockReturnValueOnce(read).mockResolvedValueOnce({ ok: true });
    let pendingRead: Promise<void>;
    await act(async () => {
      pendingRead = state.refresh();
    });
    await act(async () => state.disconnect("jira"));
    expect(state.snapshot?.connections).toEqual([]);
    await act(async () => {
      resolveRead(connected);
      await pendingRead;
    });
    expect(state.snapshot?.connections).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("keeps connection metadata visible when a refresh fails", async () => {
    mocks.runPromise.mockRejectedValueOnce(new Error("Relay unavailable"));
    await act(async () => state.refresh());
    expect(state.snapshot).toEqual(connected);
    expect(state.error).toBe("Relay unavailable");
    expect(state.loading).toBe(false);
  });

  it("keeps a connection when disconnect fails", async () => {
    mocks.runPromise.mockRejectedValueOnce(new Error("Admin access required"));
    await act(async () => {
      await expect(state.disconnect("jira")).rejects.toThrow("Admin access required");
    });
    expect(state.snapshot).toEqual(connected);
  });

  it("refreshes connection status when returning from authorization", async () => {
    const updated: RelayIssueTrackerConnections = {
      ...connected,
      connections: [
        ...connected.connections,
        {
          service: "linear",
          status: "connected",
          accountLabel: "Team · Launchpad",
          updatedAt: "2026-09-30T11:00:00Z",
        },
      ],
    };
    mocks.runPromise.mockResolvedValueOnce(updated);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(state.snapshot).toEqual(updated);
  });
});
