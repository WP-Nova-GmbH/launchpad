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
    mocks.runPromise
      .mockRejectedValueOnce(new Error("Admin access required"))
      .mockResolvedValueOnce(connected);
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

const pending: RelayIssueTrackerConnections = {
  linearAvailable: true,
  connections: [
    {
      service: "linear",
      status: "connected",
      accountLabel: "Company A",
      updatedAt: "2026-10-01",
      replacement: {
        id: "proposal",
        workspaceId: "b",
        currentWorkspaceId: "a",
        accountLabel: "Company B",
        currentAccountLabel: "Company A",
        expiresAt: "2026-10-01T12:00:00Z",
      },
    },
  ],
};
const replaced: RelayIssueTrackerConnections = {
  linearAvailable: true,
  connections: [
    { service: "linear", status: "connected", accountLabel: "Company B", updatedAt: "2026-10-01" },
  ],
};
const cancelled: RelayIssueTrackerConnections = {
  ...replaced,
  connections: [{ ...replaced.connections[0]!, accountLabel: "Company A" }],
};

describe("issue tracker mutation reconciliation", () => {
  beforeEach(async () => {
    mocks.runPromise.mockResolvedValueOnce(pending);
    await act(async () => state.refresh());
  });

  it.each(["replace", "cancel", "disconnect", "authorize"] as const)(
    "reconciles a lost %s response without repeating the mutation",
    async (action) => {
      const expected =
        action === "replace"
          ? replaced
          : action === "disconnect"
            ? { ...pending, connections: [] }
            : cancelled;
      mocks.runPromise
        .mockClear()
        .mockRejectedValueOnce(new Error("Response lost"))
        .mockResolvedValueOnce(expected);
      await act(async () => {
        await expect(
          action === "replace"
            ? state.confirmLinearReplacement("proposal")
            : action === "cancel"
              ? state.cancelLinearReplacement("proposal")
              : action === "authorize"
                ? state.startLinear()
                : state.disconnect("linear"),
        ).rejects.toThrow("Response lost");
      });
      expect(state.snapshot).toEqual(expected);
      expect(state.unverified).toBe(false);
      expect(state.mutating).toBe(false);
      expect(mocks.runPromise).toHaveBeenCalledTimes(2);
    },
  );

  it("blocks changes after failed reconciliation and recovers through refresh", async () => {
    mocks.runPromise
      .mockClear()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new Error("Offline"));
    await act(async () => {
      await expect(state.confirmLinearReplacement("proposal")).rejects.toThrow("Response lost");
    });
    expect(state.snapshot).toEqual(pending);
    expect(state.unverified).toBe(true);
    await expect(state.cancelLinearReplacement("proposal")).rejects.toThrow("Refresh to verify");
    expect(mocks.runPromise).toHaveBeenCalledTimes(2);
    mocks.runPromise.mockResolvedValueOnce(replaced);
    await act(async () => state.refresh());
    expect(state.unverified).toBe(false);
    expect(state.snapshot).toEqual(replaced);
  });

  it.each(["reconciled", "unverified"] as const)(
    "ignores stale reads and focus events during a mutation that becomes %s",
    async (outcome) => {
      let resolveOld!: (value: RelayIssueTrackerConnections) => void;
      let rejectMutation!: (error: Error) => void;
      mocks.runPromise
        .mockClear()
        .mockImplementationOnce(
          () =>
            new Promise<RelayIssueTrackerConnections>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<never>((_, reject) => {
              rejectMutation = reject;
            }),
        );
      if (outcome === "reconciled") mocks.runPromise.mockResolvedValueOnce(replaced);
      else mocks.runPromise.mockRejectedValueOnce(new Error("Offline"));
      let oldRead!: Promise<void>;
      let mutation!: Promise<void>;
      await act(async () => {
        oldRead = state.refresh();
      });
      await act(async () => {
        mutation = state.confirmLinearReplacement("proposal").catch(() => undefined);
      });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(mocks.runPromise).toHaveBeenCalledTimes(2);
      await act(async () => {
        rejectMutation(new Error("Response lost"));
        await mutation;
      });
      await act(async () => {
        resolveOld(pending);
        await oldRead;
      });
      expect(state.snapshot).toEqual(outcome === "reconciled" ? replaced : pending);
      expect(state.unverified).toBe(outcome === "unverified");
      expect(mocks.runPromise).toHaveBeenCalledTimes(3);
    },
  );

  it("prevents duplicate mutations while one request is pending", async () => {
    let resolve!: (value: RelayIssueTrackerConnections) => void;
    mocks.runPromise.mockClear().mockImplementationOnce(
      () =>
        new Promise<RelayIssueTrackerConnections>((done) => {
          resolve = done;
        }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = state.confirmLinearReplacement("proposal");
    });
    await expect(state.confirmLinearReplacement("proposal")).rejects.toThrow("Refresh to verify");
    expect(mocks.runPromise).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(replaced);
      await first;
    });
    expect(state.snapshot).toEqual(replaced);
  });
});
