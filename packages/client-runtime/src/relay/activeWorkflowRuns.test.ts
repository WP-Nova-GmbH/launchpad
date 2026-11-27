import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ActiveWorkflowRun,
  ActiveWorkflowRunPage,
  ActiveWorkflowRunPageQuery,
} from "@t3tools/contracts/workflows";
import { createActiveWorkflowRuns } from "./activeWorkflowRuns.ts";
import { workflowRunStatus } from "./workflowSession.ts";

const job = (
  index: number,
  status: ActiveWorkflowRun["status"] = "running",
): ActiveWorkflowRun => ({
  jobId: String(index),
  repositoryId: "repo",
  repositoryName: "launchpad",
  title: "Implement issue",
  issueIdentifier: "WP-331",
  status,
  createdAt: "2026-11-27T12:00:00Z",
});
const page = (
  jobs: ActiveWorkflowRun[],
  query: ActiveWorkflowRunPageQuery,
): ActiveWorkflowRunPage => {
  const start = Number(query.cursor ?? 0);
  const end = start + (query.limit ?? 20);
  return {
    organizationId: "org",
    total: jobs.length,
    jobs: jobs.slice(start, end),
    nextCursor: end < jobs.length ? String(end) : null,
  };
};

describe("active workflow runs", () => {
  it("refreshes an expanded shelf through running, review and removal without notifying on identical polls", async () => {
    vi.useFakeTimers();
    let rows = [job(1)];
    const read = vi.fn(async (query: ActiveWorkflowRunPageQuery) => page(rows, query));
    const store = createActiveWorkflowRuns(read);
    const stop = store.watch(true);
    try {
      await store.refresh();
      const listener = vi.fn();
      store.subscribe(listener);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(listener).not.toHaveBeenCalled();
      rows = [job(1, "awaiting_review")];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.getSnapshot().jobs).toEqual(rows);
      rows = [];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.getSnapshot()).toMatchObject({ jobs: [], total: 0, error: null });
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("reads only the count when collapsed and ignores a delayed response after hiding the shelf", async () => {
    const stale = Promise.withResolvers<ActiveWorkflowRunPage>();
    const rows = [job(1), job(2)];
    const read = vi
      .fn(async (query: ActiveWorkflowRunPageQuery, _signal: AbortSignal) => page(rows, query))
      .mockReturnValueOnce(stale.promise);
    const store = createActiveWorkflowRuns(read);
    const hide = store.watch(true);
    const original = store.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    hide();
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    const stop = store.watch(false);
    try {
      await store.refresh();
      expect(read.mock.calls.at(-1)![0]).toEqual({ limit: 1 });
      expect(store.getSnapshot()).toMatchObject({ jobs: [], total: 2, nextCursor: null });
      stale.resolve(page([job(9)], {}));
      await original;
      expect(store.getSnapshot()).toMatchObject({ jobs: [], total: 2 });
    } finally {
      stop();
    }
    await store.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps all requested rows current across pages and drops stale access on a later page", async () => {
    let rows = Array.from({ length: 121 }, (_, index) => job(index + 1));
    let tailOrganization = "org";
    const read = vi.fn(async (query: ActiveWorkflowRunPageQuery) => ({
      ...page(rows, query),
      organizationId: query.cursor ? tailOrganization : "org",
    }));
    const store = createActiveWorkflowRuns(read);
    const stop = store.watch(true);
    try {
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ jobs: rows.slice(0, 20), total: 121 });
      for (let i = 0; i < 5; i++) await store.loadMore();
      expect(read.mock.lastCall?.[0]).toEqual({ cursor: "100", limit: 20 });
      expect(store.getSnapshot().jobs).toEqual(rows.slice(0, 120));
      rows = rows.slice(1);
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ jobs: rows, total: 120, nextCursor: null });
      tailOrganization = "new organization";
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({
        jobs: [],
        total: null,
        nextCursor: null,
        error: "Could not load workflow runs.",
      });
    } finally {
      stop();
    }
  });

  it("restarts a refresh if runs disappear between pages and retries persistent churn on the next refresh", async () => {
    let rows = Array.from({ length: 8 }, (_, index) => job(index + 1));
    let removals = 1;
    const read = vi.fn(async (query: ActiveWorkflowRunPageQuery) => {
      if (query.cursor && removals > 0) {
        rows = rows.slice(1);
        removals--;
      }
      return page(rows, { ...query, limit: 2 });
    });
    const store = createActiveWorkflowRuns(read);
    const stop = store.watch(true);
    try {
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ jobs: rows, total: 7, error: null });
      expect(read.mock.calls.filter(([query]) => !query.cursor)).toHaveLength(2);

      removals = 2;
      read.mockClear();
      await store.refresh();
      expect(read).toHaveBeenCalledTimes(4);
      expect(store.getSnapshot()).toMatchObject({ jobs: [], total: null, pending: false });
      expect(store.getSnapshot().error).toBeTruthy();

      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ jobs: rows, total: 5, error: null });
      read.mockResolvedValue({ ...page(rows, {}), total: 0 });
      await store.refresh();
      expect(store.getSnapshot()).toMatchObject({ jobs: [], total: null });
    } finally {
      stop();
    }
  });
});

it("shows a review only while a response is still needed and prioritizes recovery and save blockers", () => {
  const open = job(1, "awaiting_review");
  const accepted = { ...open, checkpointResponsePending: true };
  expect(workflowRunStatus(open)).toEqual({ label: "Needs review", kind: "checkpoint" });
  expect(workflowRunStatus(accepted)).toEqual({
    label: "Waiting for confirmation",
    kind: "waiting",
  });
  expect(workflowRunStatus({ ...accepted, vmRecovery: { state: "paused" } }).label).toBe(
    "Response queued",
  );
  expect(workflowRunStatus({ ...accepted, vmRecovery: { state: "restoring" } }).label).toBe(
    "Restoring workspace",
  );
  expect(workflowRunStatus({ ...accepted, completionState: "finishing" }).label).toBe(
    "Finishing run",
  );
  expect(
    workflowRunStatus({
      ...accepted,
      completionState: "save_failed",
      vmRecovery: { state: "resuming" },
    }),
  ).toEqual({ label: "Save failed", kind: "blocked" });
  expect(
    workflowRunStatus({
      ...accepted,
      completionState: "completion_blocked",
      vmRecovery: { state: "recovery_error" },
    }),
  ).toEqual({ label: "Blocked", kind: "blocked" });
});

it("distinguishes actionable queue blockers from automatic waits and prioritizes manual controls over checkpoints", () => {
  const queued = job(1, "queued");
  expect(workflowRunStatus(queued).label).toBe("Queued");
  expect(workflowRunStatus({ ...queued, needsAttention: true })).toEqual({
    label: "Blocked",
    kind: "blocked",
  });
  expect(
    workflowRunStatus({
      ...queued,
      needsAttention: true,
      queueReason: { code: "vm_waiting_capacity" },
    }),
  ).toEqual({ label: "Waiting for a VM slot", kind: "waiting" });
  const review = job(2, "awaiting_review");
  expect(workflowRunStatus({ ...review, manualPauseState: "pause_requested" })).toEqual({
    label: "Pause requested",
    kind: "waiting",
  });
  expect(workflowRunStatus({ ...review, manualPauseState: "paused" })).toEqual({
    label: "Paused",
    kind: "paused",
  });
  expect(workflowRunStatus({ ...review, manualPauseState: "resume_requested" })).toEqual({
    label: "Resume requested",
    kind: "waiting",
  });
  expect(
    workflowRunStatus({
      ...review,
      manualPauseState: "pause_requested",
      completionState: "save_failed",
    }).label,
  ).toBe("Save failed");
});

it("shows cancellation blockers and accepted retries while keeping VM recovery errors visible", () => {
  const cancelling = job(1, "cancelling");
  expect(workflowRunStatus(cancelling)).toEqual({ label: "Cancelling", kind: "waiting" });
  expect(workflowRunStatus({ ...cancelling, cancellationState: "retry_needed" })).toEqual({
    label: "Cancellation needs attention",
    kind: "blocked",
  });
  const pending = { ...cancelling, cancellationState: "pending" as const };
  expect(workflowRunStatus(pending)).toEqual({ label: "Cancellation pending", kind: "waiting" });
  expect(workflowRunStatus({ ...pending, vmRecovery: { state: "recovery_error" } })).toEqual({
    label: "Blocked",
    kind: "blocked",
  });
});
