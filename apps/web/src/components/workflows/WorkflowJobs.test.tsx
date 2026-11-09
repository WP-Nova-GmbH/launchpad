import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { WorkflowJobPage } from "@t3tools/contracts/workflows";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";

const fixture = vi.hoisted(() => ({
  call: vi.fn<() => Promise<WorkflowJobPage>>(),
  navigate: vi.fn(),
}));
vi.mock("./workflowState", () => ({
  useWorkflowClient: () => fixture.call,
  workflowError: (cause: Error) => cause.message,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
import { WorkflowJobs } from "./WorkflowJobs";
const scope = {
  accountId: "user",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const refreshWorkflows = () => Promise.resolve();
const row = (jobId: string) => ({
  jobId,
  repositoryId: "repo",
  workflowId: "workflow",
  runtime: {
    kind: "machine" as const,
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
  },
  instruction: jobId,
  status: "running" as const,
  detail: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
let renderer: ReactTestRenderer;
const content = () => JSON.stringify(renderer.toJSON());
const press = (label: string) =>
  act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick();
  });
function deferred() {
  let resolve!: (value: WorkflowJobPage) => void;
  const promise = new Promise<WorkflowJobPage>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.call.mockReset();
  fixture.navigate.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("loads further pages and refresh replaces stale loaded pages", async () => {
  fixture.call
    .mockResolvedValueOnce({ jobs: [row("Old waiting job")], nextCursor: "next" })
    .mockResolvedValueOnce({ jobs: [row("Further active job")], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [row("Current active job")], nextCursor: null });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  expect(content()).toContain("Old waiting job");
  await press("Load more runs");
  expect(content()).toContain("Further active job");
  await press("Refresh runs");
  expect(content()).toContain("Current active job");
  expect(content()).not.toContain("Old waiting job");
  expect(content()).not.toContain("Further active job");
});
it("ignores a delayed old-view reply after switching to history", async () => {
  const old = deferred();
  fixture.call
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ jobs: [row("History job")], nextCursor: null });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await press("History");
  await act(async () => {
    old.resolve({ jobs: [row("Late active job")], nextCursor: null });
    await old.promise;
  });
  expect(content()).toContain("History job");
  expect(content()).not.toContain("Late active job");
});

it("retains loaded runs on a failed refresh and lets the user retry", async () => {
  fixture.call
    .mockResolvedValueOnce({ jobs: [row("Last known run")], nextCursor: "next" })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ jobs: [], nextCursor: null });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await press("Refresh runs");
  expect(content()).toContain("Last known run");
  expect(content()).toContain("Offline");
  await press("Refresh runs");
  expect(content()).toContain("No active runs");
  expect(content()).not.toContain("Last known run");
});

it("keeps the frozen automatic workflow name when catalog metadata is unavailable", async () => {
  fixture.call.mockResolvedValueOnce({
    jobs: [
      {
        ...row("Automatic job"),
        originSummary: { kind: "automation", workflowName: "Frozen workflow" },
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  expect(content()).toContain("Frozen workflow");
  expect(content()).toContain("Started by workflow");
});

function liveBrowser() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const browser = Object.assign(new EventTarget(), { setInterval, clearInterval });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  return { browser, document };
}

it("refreshes visible runs through every loaded page and removes runs that left the view", async () => {
  liveBrowser();
  fixture.call
    .mockResolvedValueOnce({ jobs: [row("Finished run")], nextCursor: "next" })
    .mockResolvedValueOnce({ jobs: [row("Further run")], nextCursor: null })
    .mockResolvedValueOnce({
      jobs: [{ ...row("New review"), status: "awaiting_review" }],
      nextCursor: "new-next",
    })
    .mockResolvedValueOnce({ jobs: [row("Further run")], nextCursor: null });
  await act(() => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await press("Load more runs");
  await act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(content()).toContain("New review");
  expect(content()).toContain("Needs review");
  expect(content()).toContain("Further run");
  expect(content()).not.toContain("Finished run");
  expect(fixture.call).toHaveBeenCalledTimes(4);
});

it("skips hidden and overlapping list refreshes, refreshes on return, and stops on unmount", async () => {
  const { browser, document } = liveBrowser();
  const pending = deferred();
  fixture.call
    .mockResolvedValueOnce({ jobs: [row("Old status")], nextCursor: null })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ jobs: [row("Current status")], nextCursor: null });
  await act(() => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await act(() => {
    vi.advanceTimersByTime(10000);
  });
  expect(fixture.call).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending.resolve({ jobs: [row("Settled status")], nextCursor: null });
    await pending.promise;
  });
  document.visibilityState = "hidden";
  await act(() => {
    vi.advanceTimersByTime(10000);
  });
  expect(fixture.call).toHaveBeenCalledTimes(2);
  document.visibilityState = "visible";
  await act(() => {
    browser.dispatchEvent(new Event("focus"));
  });
  expect(content()).toContain("Current status");
  await act(() => renderer.unmount());
  const calls = fixture.call.mock.calls.length;
  await act(() => {
    vi.advanceTimersByTime(10000);
    browser.dispatchEvent(new Event("focus"));
  });
  expect(fixture.call).toHaveBeenCalledTimes(calls);
});
