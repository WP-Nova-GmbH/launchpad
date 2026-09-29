import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveVisibleWorktreeSetup } from "./worktreeSetup.ts";

const failed: WorktreeSetupSnapshot = {
  threadId: ThreadId.make("setup-thread"),
  phase: "failed",
  startedAt: "2026-09-28T00:00:00.000Z",
  endedAt: "2026-09-28T00:00:01.000Z",
  branch: "work",
  baseRef: "main",
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: "Setup failed",
  sequence: 3,
};

describe("shared preparation visibility", () => {
  it("keeps required failure visible after a teammate queues a follow-up", () => {
    expect(
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: failed,
        turnStarted: false,
        followUpSent: true,
        preparation: { state: "failed" },
      }),
    ).toBe(failed);
  });

  it("retains existing historical behavior for nonblocking setup", () => {
    expect(
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: failed,
        turnStarted: true,
        followUpSent: true,
        preparation: { state: "ready" },
      }),
    ).toBeNull();
  });
});
