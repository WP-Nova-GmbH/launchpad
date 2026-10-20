// @effect-diagnostics globalDate:off - E2B SDK fixtures use native Dates and Vitest controls the host clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SandboxNotFoundError, type SandboxInfo } from "e2b";

import { renewRunningAllocations } from "./e2b-keepalive.ts";

const running: SandboxInfo = {
  sandboxId: "running",
  templateId: "launchpad",
  state: "running",
  metadata: { "launchpad.managed": "thread-vm-v1" },
  startedAt: new Date(0),
  endAt: new Date(900_000),
  cpuCount: 2,
  memoryMB: 4096,
  envdVersion: "test",
};

function fixture(pages: SandboxInfo[][]) {
  let index = 0;
  return {
    list: vi.fn(() => ({
      get hasNext() {
        return index < pages.length;
      },
      nextItems: async () => pages[index++]!,
    })),
    setTimeout: vi.fn(async (_id: string, _timeoutMs: number) => {}),
    getInfo: vi.fn(async (sandboxId: string): Promise<SandboxInfo> => ({ ...running, sandboxId })),
  };
}

describe("E2B host lease renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());
  it("renews running thread allocations across pages without a relay connection", async () => {
    const client = fixture([[running], [{ ...running, sandboxId: "second" }]]);
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 2,
      failures: [],
      limited: [],
    });
    expect(client.setTimeout.mock.calls.map((call) => call[0])).toEqual(["running", "second"]);
  });

  it("never wakes paused VMs or renews unrelated sandboxes", async () => {
    const client = fixture([
      [
        { ...running, state: "paused" },
        { ...running, metadata: {} },
      ],
    ]);
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 0,
      failures: [],
      limited: [],
    });
    expect(client.setTimeout).not.toHaveBeenCalled();
  });

  it("tolerates a concurrent pause and continues renewing after a single failure", async () => {
    const client = fixture([
      [running, { ...running, sandboxId: "failed" }, { ...running, sandboxId: "next" }],
    ]);
    client.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError("paused"));
    client.setTimeout.mockRejectedValueOnce(new Error("transport unavailable"));
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 1,
      failures: ["failed"],
      limited: [],
    });
    expect(client.setTimeout).toHaveBeenCalledTimes(3);
  });

  it("does not report renewal when E2B silently caps the VM lifetime", async () => {
    const client = fixture([[running, { ...running, sandboxId: "next" }]]);
    client.getInfo.mockResolvedValueOnce({ ...running, endAt: new Date(60_000) });
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 1,
      failures: [],
      limited: [{ sandboxId: "running", expiresAt: "1970-01-01T00:01:00.000Z" }],
    });
    expect(client.setTimeout).toHaveBeenCalledTimes(2);
  });

  it("does not count a renewal which cannot be verified", async () => {
    const client = fixture([[running]]);
    client.getInfo.mockRejectedValueOnce(new Error("reply lost"));
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 0,
      failures: ["running"],
      limited: [],
    });
  });

  it("allows a relay pause between the update and its verification", async () => {
    const client = fixture([[running]]);
    client.getInfo.mockResolvedValueOnce({ ...running, state: "paused" });
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 0,
      failures: [],
      limited: [],
    });
  });

  it("rejects an invalid deadline instead of reporting success", async () => {
    const client = fixture([[running]]);
    client.getInfo.mockResolvedValueOnce({ ...running, endAt: new Date(Number.NaN) });
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 0,
      failures: ["running"],
      limited: [],
    });
  });

  it("allows API timestamp rounding without mistaking it for a lifetime cap", async () => {
    const client = fixture([[running]]);
    client.getInfo.mockResolvedValueOnce({ ...running, endAt: new Date(899_999) });
    expect(await renewRunningAllocations(client, {}, 900_000)).toEqual({
      renewed: 1,
      failures: [],
      limited: [],
    });
  });
});
