import {
  act,
  cloneElement,
  createElement,
  StrictMode,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  WorkflowInvalidError,
  type WorkflowJobListView,
  type WorkflowJobPage,
} from "@t3tools/contracts/workflows";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId, RelayTenancyForbiddenError } from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { workflowSessionKey } from "@t3tools/client-runtime/relay/workflow-session";
import type { WorkflowRunsReturn } from "./workflowRunsNavigation";

type FixtureHistoryState = {
  __TSR_key?: string;
  __TSR_index?: number;
  workflowRunsReturn?: WorkflowRunsReturn;
};

type PageQuery = {
  view: WorkflowJobListView;
  cursor?: string;
};

type PageOperation = (
  client: { pageWorkflowJobs(input: { query: PageQuery }): Promise<WorkflowJobPage> },
  token: string,
) => Promise<WorkflowJobPage>;

const fixture = vi.hoisted(() => ({
  call: vi.fn<(operation: PageOperation) => Promise<WorkflowJobPage>>(),
  navigate: vi.fn(),
  historyState: {} as FixtureHistoryState,
}));
vi.mock("./workflowState", () => ({
  useWorkflowClient: () => fixture.call,
  workflowError: (cause: Error) => cause.message,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { state: FixtureHistoryState }) => unknown }) =>
    select({ state: fixture.historyState }),
  useNavigate: () => fixture.navigate,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
import { WorkflowJobs } from "./WorkflowJobs";
const scope = {
  accountId: "user",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const refreshWorkflows = () => Promise.resolve();
const screen = () => (
  <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />
);
const row = (jobId: string, createdAt = "2026-01-01") => ({
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
  createdAt,
  updatedAt: "2026-01-01",
});
let renderer: ReactTestRenderer;
const content = () => JSON.stringify(renderer.toJSON());
const press = (label: string) =>
  act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === label || button.props.children === label)!
      .props.onClick();
  });
function trackPageRequests() {
  const readPage = vi.fn<(query: PageQuery) => Promise<WorkflowJobPage>>();
  fixture.call.mockImplementation((operation) =>
    operation({ pageWorkflowJobs: ({ query }) => readPage(query) }, "fixture-token"),
  );
  return readPage;
}
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
  fixture.historyState = {};
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

it("opens attention rows for input, review, and specific blockers", async () => {
  const withdrawnAccess =
    "The original repository source permission was withdrawn. Cancel this job; a different grant cannot replace it.";
  const unconfirmedCleanup =
    "Launchpad could not confirm deletion of the previous workflow VM. Cleanup will retry automatically. Saved results are still available.";
  fixture.call.mockResolvedValueOnce({ jobs: [], nextCursor: null }).mockResolvedValueOnce({
    jobs: [
      { ...row("Answer before preparing"), status: "awaiting_input", needsAttention: true },
      { ...row("Review the changes"), status: "awaiting_review", needsAttention: true },
      {
        ...row("Recover the workspace"),
        targetKind: "vm",
        runtime: { kind: "vm", threadId: ThreadId.make("workflow:review") },
        status: "awaiting_review",
        vmRecovery: { state: "recovery_error", detail: unconfirmedCleanup },
        needsAttention: true,
      },
      {
        ...row("Publish release notes"),
        runtime: null,
        targetKind: "vm",
        status: "queued",
        queueReason: { code: "vm_limit_disabled", retryAt: null },
        detail: "Ask an organization admin to raise the Workflow VMs limit to start this run.",
        needsAttention: true,
      },
      {
        ...row("Publish after retry"),
        runtime: null,
        targetKind: "vm",
        status: "queued",
        queueReason: { code: "vm_limit_disabled", retryAt: null },
        detail: "GitHub verification failed while retrying.",
        needsAttention: true,
      },
      {
        ...row("Publish from Linear"),
        runtime: null,
        targetKind: "vm",
        status: "queued",
        queueReason: { code: "source_withdrawn", retryAt: null },
        detail: withdrawnAccess,
        needsAttention: true,
      },
      {
        ...row("Reconnect the original account"),
        targetKind: "vm",
        runtime: { kind: "vm", threadId: ThreadId.make("workflow:waiting-codex") },
        status: "awaiting_input",
        vmRecovery: { state: "waiting_codex" },
        checkpointResponsePending: true,
        needsAttention: false,
      },
      {
        ...row("Restore the workspace"),
        targetKind: "vm",
        runtime: { kind: "vm", threadId: ThreadId.make("workflow:pending") },
        status: "awaiting_review",
        vmRecovery: { state: "restoring" },
        needsAttention: false,
      },
      {
        ...row("Wait for capacity"),
        runtime: null,
        targetKind: "vm",
        status: "queued",
        queueReason: { code: "vm_waiting_capacity", retryAt: null },
        needsAttention: true,
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(screen());
  });

  await press("Needs attention");
  expect(content()).toContain("Needs input");
  expect(content()).toContain("Needs review");
  expect(content()).toContain("Recovery needs attention");
  expect(content()).toContain(unconfirmedCleanup);
  expect(content()).toContain("Workflow VMs disabled");
  expect(content()).toContain("GitHub verification failed while retrying.");
  expect(
    renderer.root
      .findByProps({ children: "Publish from Linear" })
      .parent?.findByProps({ children: withdrawnAccess }),
  ).toBeDefined();
  expect(content()).toContain("Reconnect Codex to continue");
  expect(content()).toContain("Restoring workspace");
  expect(content()).toContain("Waiting for a VM slot");

  await press("View input for Workflow run: Answer before preparing");
  await press("Open review for Workflow run: Review the changes");
  await press("View blocker for Workflow run: Recover the workspace");
  await press("View blocker for Workflow run: Publish release notes");
  await press("View blocker for Workflow run: Publish after retry");
  await press("View blocker for Workflow run: Publish from Linear");
  await press("View blocker for Workflow run: Reconnect the original account");
  await press("View run for Workflow run: Restore the workspace");
  await press("View run for Workflow run: Wait for capacity");
  expect(fixture.navigate.mock.calls.map(([route]) => route.params.jobId)).toEqual([
    "Answer before preparing",
    "Review the changes",
    "Recover the workspace",
    "Publish release notes",
    "Publish after retry",
    "Publish from Linear",
    "Reconnect the original account",
    "Restore the workspace",
    "Wait for capacity",
  ]);
});

it("shows pending manual controls in both active and attention views until the checkpoint reopens", async () => {
  const review = {
    ...row("Review held run"),
    status: "awaiting_review",
    needsAttention: true,
  } as const;
  const input = {
    ...row("Answer held run"),
    status: "awaiting_input",
    needsAttention: true,
  } as const;
  const pending = [
    { ...review, manualPauseState: "pause_requested" },
    { ...input, manualPauseState: "resume_requested" },
  ] satisfies WorkflowJobPage["jobs"];
  fixture.call.mockResolvedValue({ jobs: pending, nextCursor: null });
  await act(async () => {
    renderer = create(screen());
  });
  for (const view of ["Active", "Needs attention"]) {
    if (view === "Needs attention") await press(view);
    expect(content()).toContain("Pause requested");
    expect(content()).toContain("Resume requested");
    expect(content()).not.toContain("Needs review");
    expect(content()).not.toContain("Needs input");
    await press("View run for Workflow run: Review held run");
    await press("View run for Workflow run: Answer held run");
  }
  fixture.call.mockResolvedValue({ jobs: [review, input], nextCursor: null });
  await press("Refresh runs");
  await press("Open review for Workflow run: Review held run");
  await press("View input for Workflow run: Answer held run");
});

it("opens cancellation blockers and shows a pending retry on the next attention refresh", async () => {
  const cleanup = { ...row("Stop the run"), status: "cancelling", needsAttention: true } as const;
  fixture.call.mockResolvedValue({
    jobs: [{ ...cleanup, cancellationState: "retry_needed" }],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(screen());
  });
  expect(content()).toContain("Cancellation needs attention");
  await press("Needs attention");
  await press("View blocker for Workflow run: Stop the run");
  fixture.call.mockResolvedValue({
    jobs: [{ ...cleanup, cancellationState: "pending" }],
    nextCursor: null,
  });
  await press("Refresh runs");
  expect(content()).toContain("Cancellation pending");
  expect(content()).not.toContain("View blocker");
  await press("View run for Workflow run: Stop the run");
});

it("shows submitted checkpoints as pending until a refresh makes them actionable", async () => {
  const input = { ...row("Answer during preparation"), status: "awaiting_input" as const };
  const review = { ...row("Review the result"), status: "awaiting_review" as const };
  const saved = {
    ...row("Review the saved workspace"),
    status: "awaiting_review" as const,
    runtime: { kind: "vm" as const, threadId: ThreadId.make("workflow:saved-review") },
    vmRecovery: { state: "saved" as const },
  };
  const jobs = [input, review, saved];
  fixture.call
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce({
      jobs: jobs.map((job) => ({ ...job, needsAttention: true, checkpointResponsePending: true })),
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      jobs: jobs.map((job) => ({ ...job, needsAttention: true })),
      nextCursor: null,
    });
  await act(async () => {
    renderer = create(screen());
  });

  await press("Needs attention");
  expect(content()).toContain("Waiting for confirmation");
  expect(content()).toContain("Response queued");
  expect(content()).not.toContain("Needs input");
  expect(content()).not.toContain("Needs review");
  await press("View run for Workflow run: Answer during preparation");
  await press("View run for Workflow run: Review the result");
  await press("View run for Workflow run: Review the saved workspace");

  await press("Refresh runs");
  await press("View input for Workflow run: Answer during preparation");
  await press("Open review for Workflow run: Review the result");
  await press("Open review for Workflow run: Review the saved workspace");
  expect(fixture.navigate.mock.calls.map(([route]) => route.params.jobId)).toEqual([
    ...jobs.map((job) => job.jobId),
    ...jobs.map((job) => job.jobId),
  ]);
});

it("opens save and completion recovery instead of an unavailable Review checkpoint", async () => {
  const jobs = [
    {
      ...row("Save the result"),
      status: "awaiting_review",
      detail: "Response saved; waiting for the environment.",
      completionState: "saving_result",
      checkpointResponsePending: true,
      runtime: { kind: "vm", threadId: ThreadId.make("workflow:saving") },
      vmRecovery: { state: "saved" },
    },
    {
      ...row("Recover the result"),
      status: "awaiting_review",
      completionState: "save_failed",
      completionDetail: "The workspace snapshot could not be saved. Retry saving to continue.",
    },
    {
      ...row("Retry the save"),
      status: "awaiting_review",
      completionState: "retrying_save",
    },
    {
      ...row("Finish final checks"),
      status: "awaiting_review",
      completionState: "finishing",
      checkpointResponsePending: true,
    },
    {
      ...row("Resolve final checks"),
      status: "awaiting_review",
      completionState: "completion_blocked",
      completionDetail: "Result verification could not finish. Retry approval.",
    },
  ] satisfies WorkflowJobPage["jobs"];
  fixture.call.mockResolvedValueOnce({ jobs: [], nextCursor: null }).mockResolvedValueOnce({
    jobs: jobs.map((job) => ({ ...job, needsAttention: true })),
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(screen());
  });

  await press("Needs attention");
  expect(content()).toContain("Saving run data");
  expect(content()).toContain("Save failed");
  expect(content()).toContain("The workspace snapshot could not be saved.");
  expect(content()).toContain("Waiting for retry confirmation");
  expect(content()).toContain("Finishing run");
  expect(content()).toContain("Completion blocked");
  expect(content()).toContain("The environment couldn’t verify the final result.");
  expect(content()).not.toContain("Retry saving to continue.");
  expect(content()).not.toContain("Retry approval.");
  expect(content()).not.toContain("Open review");
  expect(content()).not.toContain("Response queued");
  expect(content()).not.toContain("Waiting for confirmation");
  expect(content()).not.toContain("Response saved; waiting for the environment.");

  await press("View run for Workflow run: Save the result");
  await press("View blocker for Workflow run: Recover the result");
  await press("View run for Workflow run: Retry the save");
  await press("View run for Workflow run: Finish final checks");
  await press("View blocker for Workflow run: Resolve final checks");
  expect(fixture.navigate.mock.calls.map(([route]) => route.params.jobId)).toEqual(
    jobs.map((job) => job.jobId),
  );
});

it("lets viewers distinguish runs awaiting input and open the intended run", async () => {
  fixture.call.mockResolvedValueOnce({
    jobs: [
      {
        ...row("first"),
        instruction: "Check checkout",
        status: "awaiting_input",
        originSummary: { kind: "manual", workflowName: "Run smoke checks" },
      },
      {
        ...row("second"),
        instruction: "Check pairing",
        status: "awaiting_input",
        originSummary: { kind: "manual", workflowName: "Run smoke checks" },
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await press("View run for Run smoke checks: Check checkout");
  await press("View run for Run smoke checks: Check pairing");
  expect(fixture.navigate.mock.calls.map(([route]) => route.params.jobId)).toEqual([
    "first",
    "second",
  ]);
});

function liveBrowser() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const media = Object.assign(new EventTarget(), { matches: false });
  const browser = Object.assign(new EventTarget(), {
    setInterval,
    clearInterval,
    matchMedia: () => media,
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  return { browser, document };
}

function runsHistory() {
  const { browser, document } = liveBrowser();
  const history = {
    state: fixture.historyState,
    replaceState: vi.fn((state: FixtureHistoryState) => {
      history.state = state;
      fixture.historyState = state;
    }),
  };
  Object.assign(browser, { history });
  const scroll = { scrollTop: 0 };
  const focus = vi.fn();
  const retry = { ownerDocument: document };
  const olderRuns = { ownerDocument: document };
  const createAction = (id: string) => ({
    dataset: { workflowRunId: id },
    ownerDocument: document,
    get isConnected() {
      return content().includes(`"data-workflow-run-id":"${id}"`);
    },
    focus: vi.fn((_options?: FocusOptions) => focus(id)),
    scrollIntoView: vi.fn(),
  });
  const actions = new Map<string, ReturnType<typeof createAction>>();
  const action = (id: string) => {
    const existing = actions.get(id);
    if (existing) return existing;
    const next = createAction(id);
    actions.set(id, next);
    return next;
  };
  const node = {
    ownerDocument: document,
    closest: () => scroll,
    focus: () => focus("Workflow runs"),
    querySelectorAll: () =>
      renderer.root.findAllByType("button").flatMap(({ props }) => {
        const id = props["data-workflow-run-id"];
        return id ? [action(id)] : [];
      }),
  };
  const options = {
    createNodeMock: ({ type, props }: ReactElement<Record<string, unknown>>) => {
      if (type === "section") return node;
      if (type === "button" && props.children === "Retry loading runs") return retry;
      if (type === "button" && props["aria-label"] === "Load older runs") return olderRuns;
      if (type === "button" && typeof props["data-workflow-run-id"] === "string")
        return action(props["data-workflow-run-id"]);
      if (type === "button") return { focus: () => focus(props.children) };
      return null;
    },
  };
  return { browser, document, history, scroll, focus, options, retry, olderRuns, actions };
}

const returnMarker = (overrides: Partial<WorkflowRunsReturn> = {}): WorkflowRunsReturn => ({
  scopeKey: workflowSessionKey(scope, "runs"),
  view: "active",
  row: null,
  loadedCount: 0,
  scrollTop: 0,
  ...overrides,
});

it("retries the same older History page without replacing the loaded rows or scroll", async () => {
  const { document, scroll, focus, options, olderRuns, actions } = runsHistory();
  const nextPage = deferred();
  const retry = deferred();
  const recentPage = { jobs: [row("Recent run", "2026-01-03")], nextCursor: "older" };
  const olderPage = { jobs: [row("Older run", "2026-01-02")], nextCursor: "oldest" };
  const readPage = trackPageRequests()
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce(recentPage)
    .mockReturnValueOnce(nextPage.promise)
    .mockRejectedValueOnce(new Error("The relay timed out."))
    .mockResolvedValueOnce(recentPage)
    .mockResolvedValueOnce(olderPage)
    .mockReturnValueOnce(retry.promise);
  await act(() => {
    renderer = create(screen(), options);
  });
  await press("History");
  const recent = renderer.root.findByType("li");
  expect(content()).toContain("Load older runs");

  await press("Load older runs");
  expect(content()).toContain("Loading older runs…");
  expect(renderer.root.findByType("li")).toBe(recent);
  await act(() => nextPage.resolve(olderPage));
  scroll.scrollTop = 430;
  await press("Load older runs");
  expect(content()).toContain("Couldn’t load older runs");
  expect(content()).not.toContain("Retry loading runs");
  expect(content()).not.toContain("Could not refresh runs");
  expect(renderer.root.findAllByType("li")[0]).toBe(recent);
  expect(renderer.root.findAllByType("li")).toHaveLength(2);
  expect(scroll.scrollTop).toBe(430);

  await act(() => vi.advanceTimersByTime(5_000));
  expect(content()).toContain("Couldn’t load older runs");
  expect(content()).toContain("Retry loading older runs");
  expect(renderer.root.findAllByType("li")).toHaveLength(2);
  expect(scroll.scrollTop).toBe(430);

  Object.defineProperty(document, "activeElement", { value: olderRuns });
  await press("Retry loading older runs");
  expect(content()).toContain("Loading older runs…");
  expect(renderer.root.findAllByType("li")).toHaveLength(2);
  expect(scroll.scrollTop).toBe(430);
  await act(() => {
    retry.resolve({ jobs: [row("Oldest run", "2026-01-01")], nextCursor: null });
  });
  expect(readPage.mock.calls.map(([query]) => query)).toEqual([
    { view: "active" },
    { view: "history" },
    { view: "history", cursor: "older" },
    { view: "history", cursor: "oldest" },
    { view: "history" },
    { view: "history", cursor: "older" },
    { view: "history", cursor: "oldest" },
  ]);
  expect(renderer.root.findAllByType("li")[0]).toBe(recent);
  expect(renderer.root.findAllByType("li")).toHaveLength(3);
  expect(content()).toContain("Oldest run");
  expect(focus).toHaveBeenCalledExactlyOnceWith("Oldest run");
  expect(actions.get("Oldest run")?.focus).toHaveBeenCalledExactlyOnceWith({
    preventScroll: true,
  });
  expect(actions.get("Oldest run")?.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "nearest",
  });
  expect(content()).not.toContain("Couldn’t load older runs");
  expect(content()).not.toContain("Retry loading older runs");
  expect(scroll.scrollTop).toBe(430);
});

it.each(["footer", "focus"])("recovers a rejected History cursor via %s", async (source) => {
  const { browser, scroll, options } = runsHistory();
  const refreshFirst = deferred();
  const newer = row("New run", "2026-01-04");
  const recent = row("Recent run", "2026-01-03");
  const older = row("Older run", "2026-01-02");
  const readPage = trackPageRequests()
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [recent], nextCursor: "older" })
    .mockResolvedValueOnce({ jobs: [older], nextCursor: "rejected" })
    .mockRejectedValueOnce(
      ManagedRelay.relayRequestError("pageWorkflowJobs")(
        new WorkflowInvalidError({ message: "Invalid run-list cursor. Refresh the list." }),
      ),
    )
    .mockReturnValueOnce(refreshFirst.promise)
    .mockResolvedValueOnce({ jobs: [recent], nextCursor: "replacement-older" })
    .mockResolvedValueOnce({ jobs: [older], nextCursor: "replacement-oldest" })
    .mockResolvedValueOnce({ jobs: [row("Oldest run", "2026-01-01")], nextCursor: null });
  await act(() => {
    renderer = create(screen(), options);
  });
  await press("History");
  await press("Load older runs");
  const loadedRows = renderer.root.findAllByType("li");
  expect(loadedRows).toHaveLength(2);
  scroll.scrollTop = 430;

  await press("Load older runs");
  expect(content()).toContain("Couldn’t load older runs");
  expect(content()).toContain("Refresh runs to load older runs");
  expect(content()).not.toContain("Retry loading older runs");
  expect(content()).not.toContain("Retry loading runs");
  expect(renderer.root.findAllByType("li")).toEqual(loadedRows);

  if (source === "footer") await press("Refresh runs to load older runs");
  else await act(() => browser.dispatchEvent(new Event("focus")));
  expect(readPage).toHaveBeenLastCalledWith({ view: "history" });
  expect(renderer.root.findAllByType("li")).toEqual(loadedRows);
  expect(scroll.scrollTop).toBe(430);
  await act(() => refreshFirst.resolve({ jobs: [newer], nextCursor: "replacement-recent" }));
  expect(readPage).toHaveBeenLastCalledWith({ view: "history", cursor: "replacement-older" });
  const refreshedRows = renderer.root.findAllByType("li");
  expect(refreshedRows[1]).toBe(loadedRows[0]);
  expect(refreshedRows[2]).toBe(loadedRows[1]);
  expect(refreshedRows).toHaveLength(3);
  expect(content()).not.toContain("Couldn’t load older runs");
  expect(scroll.scrollTop).toBe(430);

  await press("Load older runs");
  expect(readPage.mock.calls.map(([query]) => query)).toEqual([
    { view: "active" },
    { view: "history" },
    { view: "history", cursor: "older" },
    { view: "history", cursor: "rejected" },
    { view: "history" },
    { view: "history", cursor: "replacement-recent" },
    { view: "history", cursor: "replacement-older" },
    { view: "history", cursor: "replacement-oldest" },
  ]);
  expect(renderer.root.findAllByType("li")).toHaveLength(4);
  expect(content()).toContain("Oldest run");
  expect(scroll.scrollTop).toBe(430);
});

it("keeps initial and refresh errors at the top of History", async () => {
  const readPage = trackPageRequests()
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockRejectedValueOnce(new Error("History is unavailable."))
    .mockResolvedValueOnce({ jobs: [row("Recent run")], nextCursor: "older" })
    .mockRejectedValueOnce(new Error("Older page timed out."))
    .mockRejectedValueOnce(new Error("Refresh timed out."))
    .mockResolvedValueOnce({ jobs: [row("Refreshed run")], nextCursor: null });
  await act(() => {
    renderer = create(screen());
  });
  await press("History");
  expect(content()).toContain("Could not load runs");
  expect(content()).toContain("History is unavailable.");
  expect(content()).not.toContain("Retry loading older runs");
  await press("Retry loading runs");

  await press("Load older runs");
  expect(content()).toContain("Couldn’t load older runs");
  await press("Refresh runs");
  expect(content()).toContain("Could not refresh runs");
  expect(content()).toContain("Refresh timed out.");
  expect(content()).toContain("Recent run");
  expect(content()).not.toContain("Retry loading older runs");
  await press("Retry loading runs");
  expect(content()).toContain("Refreshed run");
  expect(content()).not.toContain("Recent run");
  expect(readPage.mock.calls.map(([query]) => query)).toEqual([
    { view: "active" },
    { view: "history" },
    { view: "history" },
    { view: "history", cursor: "older" },
    { view: "history" },
    { view: "history" },
  ]);
});

it("drops an older-page failure when an automatic refresh changes the History cursor", async () => {
  const { browser } = liveBrowser();
  const readPage = trackPageRequests()
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [row("Recent run")], nextCursor: "old-cursor" })
    .mockRejectedValueOnce(new Error("Older page timed out."))
    .mockResolvedValueOnce({ jobs: [row("Recent run")], nextCursor: "new-cursor" })
    .mockResolvedValueOnce({ jobs: [row("Older run")], nextCursor: null });
  await act(() => {
    renderer = create(screen());
  });
  await press("History");
  await press("Load older runs");
  expect(content()).toContain("Retry loading older runs");

  await act(() => browser.dispatchEvent(new Event("focus")));
  expect(content()).not.toContain("Retry loading older runs");
  expect(content()).not.toContain("Couldn’t load older runs");
  await press("Load older runs");
  expect(readPage).toHaveBeenLastCalledWith({ view: "history", cursor: "new-cursor" });
  expect(content()).toContain("Recent run");
  expect(content()).toContain("Older run");
});

it("clears loaded History when an older page confirms access loss", async () => {
  fixture.call
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [row("Private run")], nextCursor: "older" })
    .mockRejectedValueOnce(
      new Error("Repository access was revoked.", {
        cause: new RelayTenancyForbiddenError({
          code: "tenancy_forbidden",
          reason: "no_repository_access",
          traceId: "fixture-access-revocation",
        }),
      }),
    );
  await act(() => {
    renderer = create(screen());
  });
  await press("History");
  expect(content()).toContain("Private run");
  await press("Load older runs");

  expect(content()).toContain("Could not load runs");
  expect(content()).toContain("Repository access was revoked.");
  expect(content()).toContain("Retry loading runs");
  expect(renderer.root.findAllByType("li")).toHaveLength(0);
  expect(content()).not.toContain("Private run");
  expect(content()).not.toContain("Couldn’t load older runs");
  expect(content()).not.toContain("Retry loading older runs");
});

it("reopens History and finds the original row past the previous page boundary", async () => {
  fixture.historyState = { __TSR_key: "history", __TSR_index: 2 };
  const { history, scroll, focus, options } = runsHistory();
  fixture.call
    .mockResolvedValueOnce({ jobs: [], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [row("Recent run", "2026-01-02")], nextCursor: "older" })
    .mockResolvedValueOnce({ jobs: [row("Older run")], nextCursor: null })
    .mockResolvedValueOnce({ jobs: [row("New run", "2026-01-03")], nextCursor: "new-next" })
    .mockResolvedValueOnce({
      jobs: [row("Recent run", "2026-01-02")],
      nextCursor: "older-again",
    })
    .mockResolvedValueOnce({ jobs: [row("Older run")], nextCursor: "keep-older-available" });

  await act(async () => {
    renderer = create(screen(), options);
  });
  await press("History");
  await press("Load older runs");
  scroll.scrollTop = 430;
  await press("View run for Workflow run: Older run");
  const marker = returnMarker({
    view: "history",
    loadedCount: 2,
    row: {
      jobId: "Older run",
      createdAt: "2026-01-01",
      index: 1,
      previousJobId: "Recent run",
    },
    scrollTop: 430,
  });
  expect(history.replaceState).toHaveBeenCalledWith(
    { __TSR_key: "history", __TSR_index: 2, workflowRunsReturn: marker },
    "",
  );
  expect(fixture.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ state: { workflowRunsReturn: marker } }),
  );
  await act(async () => renderer.update(screen()));
  expect(fixture.call).toHaveBeenCalledTimes(3);
  expect(focus).not.toHaveBeenCalled();

  // Back can read the same-key native marker even if the router snapshot omits it.
  await act(async () => renderer.unmount());
  scroll.scrollTop = 0;
  fixture.historyState = { __TSR_key: "history", __TSR_index: 2 };
  await act(async () => {
    renderer = create(screen(), options);
  });
  expect(fixture.call).toHaveBeenCalledTimes(6);
  expect(content()).toContain("Older run");
  expect(content()).toContain("Load older runs");
  expect(focus).toHaveBeenCalledExactlyOnceWith("Older run");
  expect(scroll.scrollTop).toBe(430);
});

it.each([true, false])(
  "returns to the nearest surviving Needs attention row when a successor is present %s",
  async (hasSuccessor) => {
    fixture.historyState = {
      __TSR_key: "attention-changed",
      workflowRunsReturn: returnMarker({
        view: "attention",
        loadedCount: 2,
        row: {
          jobId: "review-b",
          createdAt: "2026-01-02",
          index: 1,
          nextJobId: "review-c",
          previousJobId: "earlier",
        },
      }),
    };
    const { focus, options } = runsHistory();
    fixture.call.mockResolvedValueOnce({
      jobs: [
        { ...row("earlier", "2026-01-01"), status: "awaiting_input" },
        { ...row("review-a", "2026-01-02"), status: "awaiting_review" },
      ],
      nextCursor: hasSuccessor ? "later" : null,
    });
    if (hasSuccessor)
      fixture.call.mockResolvedValueOnce({
        jobs: [{ ...row("review-d", "2026-01-02"), status: "awaiting_review" }],
        nextCursor: null,
      });
    await act(async () => {
      renderer = create(screen(), options);
    });
    expect(fixture.call).toHaveBeenCalledTimes(hasSuccessor ? 2 : 1);
    expect(focus).toHaveBeenCalledExactlyOnceWith(hasSuccessor ? "review-d" : "review-a");
  },
);

it("returns to the next actionable row when an approved run leaves Needs attention", async () => {
  fixture.historyState = {
    __TSR_key: "attention",
    workflowRunsReturn: returnMarker({
      view: "attention",
      loadedCount: 3,
      row: { jobId: "Just approved", index: 1, nextJobId: "Next review", previousJobId: "Earlier" },
    }),
  };
  const { focus, options } = runsHistory();
  fixture.call.mockResolvedValueOnce({
    jobs: [
      { ...row("Earlier"), status: "awaiting_input" },
      { ...row("Next review"), status: "awaiting_review" },
    ],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(screen(), options);
  });
  expect(content()).not.toContain("Just approved");
  expect(focus).toHaveBeenCalledExactlyOnceWith("Next review");
});

it.each([false, true])(
  "hands off the returned review focus after approval settles unless focus moved (%s)",
  async (moveFocus) => {
    fixture.historyState = {
      __TSR_key: "late-approval",
      workflowRunsReturn: returnMarker({
        view: "attention",
        loadedCount: 1,
        row: { jobId: "review-b", createdAt: "2026-01-02", index: 0 },
      }),
    };
    const { actions, document, focus, options } = runsHistory();
    const body = {};
    const otherControl = {};
    let focusMoved = false;
    Object.defineProperties(document, {
      body: { value: body },
      activeElement: {
        get: () => {
          if (focusMoved) return otherControl;
          const action = actions.get("review-b");
          return action?.isConnected ? action : body;
        },
      },
    });
    const refresh = deferred();
    const awaitingReview: WorkflowJobPage = {
      jobs: [{ ...row("review-b", "2026-01-02"), status: "awaiting_review" }],
      nextCursor: null,
    };
    fixture.call
      .mockResolvedValueOnce(awaitingReview)
      .mockResolvedValueOnce(awaitingReview)
      .mockResolvedValueOnce(awaitingReview)
      .mockRejectedValueOnce(new Error("Offline"))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce({
        jobs: [{ ...row("review-c", "2026-01-03"), status: "awaiting_review" }],
        nextCursor: null,
      });
    await act(async () => {
      renderer = create(<StrictMode>{screen()}</StrictMode>, options);
    });
    expect(focus).toHaveBeenCalledExactlyOnceWith("review-b");

    await act(() => vi.advanceTimersByTime(5000));
    expect(focus).toHaveBeenCalledExactlyOnceWith("review-b");
    await act(() => vi.advanceTimersByTime(5000));
    expect(content()).toContain("Offline");
    await act(() => vi.advanceTimersByTime(5000));
    focusMoved = moveFocus;
    await act(async () => {
      refresh.resolve({
        jobs: [{ ...row("review-a", "2026-01-01"), status: "awaiting_review" }],
        nextCursor: "later",
      });
      await refresh.promise;
    });
    expect(content()).not.toContain("review-b");
    expect(fixture.call).toHaveBeenCalledTimes(moveFocus ? 5 : 6);
    expect(focus.mock.calls.flat()).toEqual(moveFocus ? ["review-b"] : ["review-b", "review-c"]);
  },
);

it.each([
  { trigger: "Retry button", movedFocus: false },
  { trigger: "Retry button", movedFocus: true },
  { trigger: "window refocus", movedFocus: false },
  { trigger: "window refocus", movedFocus: true },
])(
  "restores History from $trigger and respects later focus movement ($movedFocus)",
  async ({ trigger, movedFocus }) => {
    fixture.historyState = {
      __TSR_key: "retry-history",
      workflowRunsReturn: returnMarker({
        view: "history",
        loadedCount: 2,
        row: { jobId: "Older run", index: 1 },
        scrollTop: 360,
      }),
    };
    const { browser, document, focus, options, retry, scroll } = runsHistory();
    const firstPage = deferred();
    fixture.call
      .mockRejectedValueOnce(new Error("Offline"))
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce({ jobs: [row("Older run")], nextCursor: null });
    await act(async () => {
      renderer = create(screen(), options);
    });
    expect(content()).toContain("Offline");
    Object.defineProperty(document, "activeElement", { value: retry });
    document.dispatchEvent(new Event("focusin"));
    if (trigger === "Retry button") {
      await press("Retry loading runs");
    } else {
      await act(() => {
        browser.dispatchEvent(new Event("focus"));
      });
    }
    expect(content()).not.toContain("Retry loading runs");
    expect(focus).toHaveBeenCalledExactlyOnceWith("History");

    if (movedFocus) document.dispatchEvent(new Event("focusin"));
    await act(async () => {
      firstPage.resolve({ jobs: [row("Recent run")], nextCursor: "older" });
      await firstPage.promise;
    });

    expect(content()).toContain("Older run");
    expect(focus.mock.calls.flat()).toEqual(movedFocus ? ["History"] : ["History", "Older run"]);
    expect(scroll.scrollTop).toBe(movedFocus ? 0 : 360);
  },
);

it("focuses Active on a direct return but ignores a marker from another account", async () => {
  const initial = returnMarker();
  fixture.historyState = { __TSR_key: "direct", workflowRunsReturn: initial };
  const { history, focus, options } = runsHistory();
  fixture.call.mockResolvedValue({ jobs: [row("Active run")], nextCursor: null });
  await act(async () => {
    renderer = create(screen(), options);
  });
  expect(content()).toContain("Active run");
  expect(focus).toHaveBeenCalledExactlyOnceWith("Active");

  focus.mockClear();
  await act(async () => renderer.unmount());
  fixture.historyState = {
    __TSR_key: "another-link",
    workflowRunsReturn: { ...initial, scopeKey: "other-account", view: "history" },
  };
  history.state = fixture.historyState;
  await act(async () => {
    renderer = create(screen(), options);
  });
  expect(content()).toContain("Active run");
  expect(focus).not.toHaveBeenCalled();
});

it("keeps focus moved during catalog loading when the Runs list mounts", async () => {
  fixture.historyState = {
    __TSR_key: "return",
    workflowRunsReturn: returnMarker({
      view: "history",
      row: { jobId: "Returned run", index: 0 },
      loadedCount: 1,
      scrollTop: 260,
    }),
  };
  const { document, focus, options, scroll } = runsHistory();
  Object.defineProperty(document, "activeElement", { value: { tagName: "BUTTON" } });
  fixture.call.mockResolvedValueOnce({ jobs: [row("Returned run")], nextCursor: null });
  await act(async () => {
    renderer = create(screen(), options);
  });
  expect(content()).toContain("Returned run");
  expect(focus).not.toHaveBeenCalled();
  expect(scroll.scrollTop).toBe(0);
});

it.each(["navigation", "focus"])(
  "leaves the current focus alone after %s during a return",
  async (change) => {
    fixture.historyState = { __TSR_key: "return", workflowRunsReturn: returnMarker() };
    const { document, history, focus, options } = runsHistory();
    const request = deferred();
    fixture.call.mockReturnValueOnce(request.promise);
    await act(async () => {
      renderer = create(screen(), options);
    });
    if (change === "navigation") history.state = { __TSR_key: "other-entry" };
    else document.dispatchEvent(new Event("focusin"));
    await act(async () => {
      request.resolve({ jobs: [row("Current run")], nextCursor: null });
      await request.promise;
    });
    expect(focus).not.toHaveBeenCalled();
  },
);

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
