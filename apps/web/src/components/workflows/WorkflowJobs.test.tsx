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
import type { WorkflowJobPage } from "@t3tools/contracts/workflows";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { workflowSessionKey } from "@t3tools/client-runtime/relay/workflow-session";
import type { WorkflowRunsReturn } from "./workflowRunsNavigation";

type FixtureHistoryState = {
  __TSR_key?: string;
  __TSR_index?: number;
  workflowRunsReturn?: WorkflowRunsReturn;
};

const fixture = vi.hoisted(() => ({
  call: vi.fn<() => Promise<WorkflowJobPage>>(),
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

it("shows a workflow VM recovery error alongside the current checkpoint in Needs attention", async () => {
  fixture.call.mockResolvedValueOnce({ jobs: [], nextCursor: null }).mockResolvedValueOnce({
    jobs: [
      {
        ...row("Answer before preparing"),
        targetKind: "vm",
        runtime: { kind: "vm", threadId: ThreadId.make("workflow:input") },
        status: "awaiting_input",
        vmRecovery: { state: "recovery_error" },
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    renderer = create(
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />,
    );
  });
  await press("Needs attention");
  expect(content()).toContain("Workflow VM recovery needs attention");
  expect(content()).toContain("Needs input");
  await press("View run for Workflow run: Answer before preparing");
  expect(fixture.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: { repositoryId: "repo", jobId: "Answer before preparing" } }),
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
  const browser = Object.assign(new EventTarget(), { setInterval, clearInterval });
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
  const createAction = (id: string) => ({
    dataset: { workflowRunId: id },
    ownerDocument: document,
    get isConnected() {
      return content().includes(`"data-workflow-run-id":"${id}"`);
    },
    focus: () => focus(id),
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
      if (type === "button" && typeof props["data-workflow-run-id"] === "string")
        return action(props["data-workflow-run-id"]);
      if (type === "button") return { focus: () => focus(props.children) };
      return null;
    },
  };
  return { browser, document, history, scroll, focus, options, retry, actions };
}

const returnMarker = (overrides: Partial<WorkflowRunsReturn> = {}): WorkflowRunsReturn => ({
  scopeKey: workflowSessionKey(scope, "runs"),
  view: "active",
  row: null,
  loadedCount: 0,
  scrollTop: 0,
  ...overrides,
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
  await press("Load more runs");
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
  expect(content()).toContain("Load more runs");
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
