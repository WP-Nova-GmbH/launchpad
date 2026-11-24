import {
  act,
  cloneElement,
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type Ref,
  createElement,
} from "react";
import {
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  workflowResultCheckpoint,
  type WorkflowResultCheckpoint,
} from "@t3tools/client-runtime/relay/workflow-result";
import {
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  beginMachineWorkflowReview,
  recordMachineWorkflowReviewDiff,
  recordSavedWorkflowReviewDiff,
  requireFreshWorkflowReviewRead,
  beginWorkflowReview,
  settleWorkflowJobRequest,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowJobReadAtom,
  workflowReviewApprovalState,
  workflowSessionKey,
  setWorkflowSessionAccount,
} from "@t3tools/client-runtime/relay/workflow-session";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import type { WorkflowRunsReturn } from "./workflowRunsNavigation";

const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  refreshCatalog: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn(),
  select: vi.fn(),
  panel: vi.fn(),
  locationHash: "",
  locationKey: "workflow-run",
  workflowMachineReviewVisitId: undefined as string | undefined,
  workflowReviewReturn: undefined as WorkflowResultCheckpoint | undefined,
  workflowRunsReturn: undefined as WorkflowRunsReturn | undefined,
}));
const fixtureRouter = {
  history: {
    get location() {
      return { state: { __TSR_key: fixture.locationKey } };
    },
  },
};
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useRouter: () => fixtureRouter,
  useLocation: ({
    select,
  }: {
    select: (location: {
      hash: string;
      state: {
        __TSR_key: string;
        workflowMachineReviewVisitId: string | undefined;
        workflowReviewReturn: WorkflowResultCheckpoint | undefined;
        workflowRunsReturn: WorkflowRunsReturn | undefined;
      };
    }) => unknown;
  }) =>
    select({
      hash: fixture.locationHash,
      state: {
        __TSR_key: fixture.locationKey,
        workflowMachineReviewVisitId: fixture.workflowMachineReviewVisitId,
        workflowReviewReturn: fixture.workflowReviewReturn,
        workflowRunsReturn: fixture.workflowRunsReturn,
      },
    }),
  Link: ({
    to,
    hash,
    children,
    ref,
  }: PropsWithChildren<{ to: string; hash?: string; ref?: Ref<HTMLAnchorElement> }>) =>
    createElement("a", { href: hash ? `${to}#${hash}` : to, ref }, children),
}));
vi.mock("../../state/threads", () => ({ openPortableThreadChat: "open" }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.open }));
vi.mock("../../diffPanelStore", () => ({
  useDiffPanelStore: { getState: () => ({ selectTurn: fixture.select }) },
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: fixture.panel }) },
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("./workflowState", async () => ({
  ...(await vi.importActual("./workflowState")),
  useWorkflowClient: () => fixture.call,
}));
vi.mock("./SavedWorkflowResults", () => ({
  SavedWorkflowResults: ({
    job,
    resultsRef,
    showCancellationDetail = true,
  }: {
    job: RepositoryWorkflowJob;
    resultsRef?: Ref<HTMLElement>;
    showCancellationDetail?: boolean;
  }) =>
    createElement(
      "section",
      { ref: resultsRef, "aria-label": "Saved workflow results" },
      "Saved results",
      showCancellationDetail && job.status === "cancelled"
        ? (job.detail ?? job.progress?.detail)
        : null,
    ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    render,
    ...props
  }: PropsWithChildren<Record<string, unknown> & { render?: ReactElement }>) =>
    render ? cloneElement(render, props) : createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/menu", () => {
  const MenuState = createContext<[boolean, (open: boolean) => void]>([false, () => {}]);
  return {
    Menu: ({ children }: PropsWithChildren) => {
      const state = useState(false);
      return <MenuState.Provider value={state}>{children}</MenuState.Provider>;
    },
    MenuTrigger: ({
      render,
      children,
    }: PropsWithChildren<{
      render: ReactElement<{ onClick: () => void; children?: ReactElement }>;
    }>) => {
      const [open, setOpen] = useContext(MenuState);
      return cloneElement(
        render,
        { onClick: () => setOpen(!open) },
        children ?? render.props.children,
      );
    },
    MenuPopup: ({ children }: PropsWithChildren) =>
      useContext(MenuState)[0] ? <div role="menu">{children}</div> : null,
    MenuItem: ({
      children,
      onClick,
      disabled,
    }: PropsWithChildren<{ onClick: () => void; disabled?: boolean }>) => {
      const [, setOpen] = useContext(MenuState);
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setOpen(false);
            onClick();
          }}
        >
          {children}
        </button>
      );
    },
    MenuItemLabel: ({ children }: PropsWithChildren) => children,
  };
});
vi.mock("../ui/alert-dialog", () => {
  const part = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? createElement("section", { role: "alertdialog" }, children) : null,
    AlertDialogPopup: part,
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: part,
  };
});
import { WorkflowJob } from "./WorkflowJob";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { SavedWorkflowResults } from "./SavedWorkflowResults";

const scope = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const job: RepositoryWorkflowJob = {
  jobId: "job",
  repositoryId: "repo",
  workflowId: "workflow",
  runtime: {
    kind: "machine",
    environmentId: EnvironmentId.make("original"),
    projectId: ProjectId.make("project"),
  },
  instruction: "Implement",
  status: "done",
  detail: null,
  workflow: null,
  progress: {
    revision: 3,
    status: "done",
    threadId: ThreadId.make("thread"),
    detail: null,
    checkpoint: {
      checkpointId: "checkpoint",
      turnId: "saved-turn",
      checkpointRef: "ref",
      checkpointTurnCount: 3,
    },
  },
  createdAt: "2026-10-27",
  updatedAt: "2026-10-27",
};
let renderer: ReactTestRenderer | undefined;
function text(
  node: ReactTestInstance | ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return Array.isArray(node) ? node.map(text).join(" ") : (node.children ?? []).map(text).join(" ");
}
const view = (
  jobId = "job",
  canConfigure = true,
  organizationAdmin = false,
  workflowScope = scope,
) => (
  <AppAtomRegistryProvider>
    <WorkflowJob
      scope={workflowScope}
      jobId={jobId}
      projects={[]}
      canConfigure={canConfigure}
      organizationAdmin={organizationAdmin}
      refreshCatalog={fixture.refreshCatalog}
    />
  </AppAtomRegistryProvider>
);
async function mount(
  canConfigure = true,
  options?: Parameters<typeof create>[1],
  organizationAdmin = false,
) {
  await act(async () => {
    renderer = create(view("job", canConfigure, organizationAdmin), options);
  });
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const findButton = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find(
      (button) =>
        button.props["aria-label"] === label ||
        button.children.filter((child) => typeof child === "string").join("") === label,
    )!;
const headerStatus = () =>
  renderer!.root
    .findAllByType("header")
    .flatMap((header) => header.findAllByType("span"))
    .find((span) => span.props.role === "status")!;
function conversationOpeningIsBlocked() {
  const button = findButton("Opening conversation…") ?? findButton("Open conversation");
  return button.props.disabled === true || button.props["aria-disabled"] === true;
}
async function press(label: string) {
  await act(async () => {
    findButton(label).props.onClick();
  });
}
const cancelDialog = () => renderer!.root.findByProps({ role: "alertdialog" });
async function confirmCancellation() {
  const button = cancelDialog()
    .findAllByType("button")
    .find((node) => text(node) === "Cancel run");
  expect(button).toBeDefined();
  await act(() => button!.props.onClick());
}
async function pollRun() {
  const poll = vi.mocked(window.setInterval).mock.lastCall?.[0];
  if (typeof poll !== "function") throw new Error("Expected a live run poll");
  await act(() => poll());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  });
  appAtomRegistry.set(managedRelaySessionAtom, null);
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  fixture.call.mockReset().mockResolvedValue(job);
  fixture.refreshCatalog.mockReset();
  fixture.open.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { environmentId: "moved-vm", threadId: "thread", workflowVmGeneration: 1 },
  });
  fixture.navigate.mockReset();
  fixture.select.mockReset();
  fixture.panel.mockReset();
  fixture.locationHash = "";
  fixture.locationKey = "workflow-run";
  fixture.workflowMachineReviewVisitId = undefined;
  fixture.workflowReviewReturn = undefined;
  fixture.workflowRunsReturn = undefined;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each([
  { label: "History", view: "history", current: true },
  { label: "Needs attention", view: "attention", current: true },
  { label: "another run", view: "history", current: false, wrongJob: true },
  { label: "another scope", view: "history", current: false, wrongScope: true },
  { label: "a direct link", view: undefined, current: false },
] as const)("returns from $label to the correct runs list", async (entry) => {
  const scopeKey = workflowSessionKey(scope, "runs");
  fixture.workflowRunsReturn = entry.view
    ? {
        scopeKey: "wrongScope" in entry ? "other-scope" : scopeKey,
        view: entry.view,
        row: { jobId: "wrongJob" in entry ? "other-job" : job.jobId, index: 13 },
        loadedCount: 20,
        scrollTop: 360,
      }
    : undefined;
  await mount();
  await press("Back to runs");

  expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/workflows/$repositoryId",
    params: { repositoryId: scope.repositoryId },
    search: { tab: "runs" },
    state: {
      workflowRunsReturn: entry.current
        ? fixture.workflowRunsReturn
        : { scopeKey, view: "active", row: null, loadedCount: 0, scrollTop: 0 },
    },
  });
});

describe("successful run outcome", () => {
  const outcome = () => renderer!.root.findByType(WorkflowOutcome);

  it("opens the pull request from the outcome and still offers Machine result actions", async () => {
    const pullRequestUrl = "https://github.com/example/launchpad/pull/42";
    fixture.call.mockResolvedValue({
      ...job,
      progress: { ...job.progress!, pullRequestUrl },
    } satisfies RepositoryWorkflowJob);
    await mount();

    expect(text(outcome().findByType("h2"))).toBe("Pull request opened");
    const link = outcome().findByType("a");
    expect(text(link)).toContain("Open pull request");
    expect(link.props.href).toBe(pullRequestUrl);
    expect(findButton("Inspect result")).toBeDefined();
    expect(findButton("Open conversation")).toBeDefined();
  });

  it.each([
    { hasDiff: true, action: "Inspect result" },
    { hasDiff: false, action: "Open conversation" },
  ])("puts $action in the completed Machine outcome", async ({ hasDiff, action }) => {
    fixture.call.mockResolvedValue({
      ...job,
      progress: {
        ...job.progress!,
        hasThread: true,
        checkpoint: hasDiff ? job.progress!.checkpoint : null,
      },
    } satisfies RepositoryWorkflowJob);
    await mount();

    expect(text(outcome().findByType("h2"))).toBe("Workflow completed");
    expect(outcome().findAllByType("button")).toContain(findButton(action));
    if (!hasDiff) expect(findButton("Inspect result")).toBeUndefined();
  });

  it("jumps to available read-only VM results and hides the shortcut when the result goes away", async () => {
    const vmJob = {
      ...job,
      runtime: { kind: "vm", threadId: job.progress!.threadId },
      progress: { ...job.progress!, hasThread: true },
    } satisfies RepositoryWorkflowJob;
    const results = { scrollIntoView: vi.fn(), focus: vi.fn() };
    fixture.call.mockResolvedValue(vmJob);
    await mount(true, {
      createNodeMock: ({ props }) =>
        (props as { "aria-label"?: string })["aria-label"] === "Saved workflow results"
          ? results
          : null,
    });
    const reportAvailability = (available: boolean) =>
      act(() =>
        renderer!.root.findByType(SavedWorkflowResults).props.onResultsAvailableChange(available),
      );

    expect(findButton("Open saved results")).toBeUndefined();
    await reportAvailability(true);
    expect(outcome().findAllByType("button")).toContain(findButton("Open saved results"));
    await press("Open saved results");
    expect(results.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(results.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fixture.open).not.toHaveBeenCalled();

    await reportAvailability(false);
    expect(findButton("Open saved results")).toBeUndefined();

    await reportAvailability(true);
    const otherJob = { ...vmJob, jobId: "other" };
    fixture.call.mockResolvedValue(otherJob);
    await act(async () => renderer!.update(view("other")));
    expect(findButton("Open saved results")).toBeUndefined();

    await reportAvailability(true);
    fixture.call.mockResolvedValue({
      ...otherJob,
      progress: { ...otherJob.progress, threadDeletionRequested: true },
    } satisfies RepositoryWorkflowJob);
    await press("Refresh run");
    expect(findButton("Open saved results")).toBeUndefined();
  });
});

describe("workflow result location navigation", () => {
  const vmReview = {
    ...job,
    runtime: { kind: "vm", threadId: ThreadId.make("thread") },
    status: "awaiting_review",
    progress: { ...job.progress!, status: "awaiting_review" },
    viewerControls: { canApprove: true, canRespond: false, canCancel: true },
  } satisfies RepositoryWorkflowJob;

  const branchUrl = "https://github.com/acme/project/tree/launchpad%2Fjob";
  const pullRequestUrl = "https://github.com/acme/project/pull/17";

  it.each([
    {
      title: "Branch published",
      state: "confirmed",
      hasPullRequest: false,
      detail: "The branch was pushed before cancellation.",
    },
    {
      title: "Pull request confirmed",
      state: "confirmed",
      hasPullRequest: true,
      detail: "The pull request was opened before cancellation.",
    },
    {
      title: "Last publishing action unconfirmed",
      state: "unknown",
      hasPullRequest: false,
      detail: "Could not verify whether the pull request was opened before cancellation.",
    },
  ] as const)(
    "shows $title with the confirmed artifacts and saved results",
    async ({ title, state, hasPullRequest, detail }) => {
      fixture.call.mockResolvedValue({
        ...vmReview,
        status: "cancelled",
        detail: state === "confirmed" ? detail : null,
        progress: { ...vmReview.progress, status: "cancelled", checkpoint: null, detail },
        publicationOutcome: {
          state,
          branchUrl,
          pullRequestUrl: hasPullRequest ? pullRequestUrl : null,
        },
      } satisfies RepositoryWorkflowJob);
      await mount(false);
      const content = text(renderer!.toJSON());
      expect(renderer!.root.findAllByType("h2").map(text)).toContain(title);
      expect(text(renderer!.root.findByType(WorkflowOutcome))).toContain(detail);
      expect(content.split(detail)).toHaveLength(2);
      expect(content).toContain("launchpad/job");
      expect(content).toContain("Saved results");
      if (hasPullRequest) expect(content).toMatch(/PR #\s*17/);
      if (state === "unknown") expect(content).toContain("Previously published branch");

      const actions = renderer!.root
        .findAllByType("a")
        .filter(({ props }) => props.href === branchUrl || props.href === pullRequestUrl)
        .map((link) => [link.props.href, text(link).trim()]);
      expect(actions).toEqual(
        hasPullRequest
          ? [
              [pullRequestUrl, "Open pull request"],
              [branchUrl, "Open branch"],
            ]
          : [[branchUrl, "Open branch"]],
      );
      expect(fixture.open).not.toHaveBeenCalled();
    },
  );

  it("keeps unrelated cancellation detail with saved results after a confirmed publication", async () => {
    const detail = "Canceled before the Agent step completed.";
    fixture.call.mockResolvedValue({
      ...vmReview,
      status: "cancelled",
      detail,
      progress: { ...vmReview.progress, status: "cancelled", checkpoint: null },
      publicationOutcome: { state: "confirmed", branchUrl, pullRequestUrl: null },
    } satisfies RepositoryWorkflowJob);
    await mount(false);

    expect(text(renderer!.root.findByType(WorkflowOutcome))).not.toContain(detail);
    expect(text(renderer!.root.findByProps({ "aria-label": "Saved workflow results" }))).toContain(
      detail,
    );
  });

  it("keeps the recorded PR link while the publication receipt is unconfirmed", async () => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      status: "cancelled",
      progress: {
        ...vmReview.progress,
        status: "cancelled",
        checkpoint: null,
        pullRequestUrl,
      },
      publicationOutcome: { state: "unknown", branchUrl, pullRequestUrl: null },
    } satisfies RepositoryWorkflowJob);
    await mount(false);

    const content = text(renderer!.toJSON());
    expect(content).toContain("Last publishing action unconfirmed");
    expect(content).not.toContain("Previously confirmed PR");
    expect(content).not.toContain("Pull request confirmed");
    const pullRequestLinks = renderer!.root
      .findAllByType("a")
      .filter(({ props }) => props.href === pullRequestUrl);
    expect(pullRequestLinks.map((link) => text(link).trim())).toEqual([
      "Open recorded pull request",
    ]);
  });

  it("retains a cancelled VM's progress-only pull request link", async () => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      status: "cancelled",
      progress: {
        ...vmReview.progress,
        status: "cancelled",
        checkpoint: null,
        pullRequestUrl,
      },
    } satisfies RepositoryWorkflowJob);
    await mount(false);

    const pullRequestLinks = renderer!.root
      .findAllByType("a")
      .filter(({ props }) => props.href === pullRequestUrl);
    expect(pullRequestLinks.map(text)).toEqual(["Open pull request"]);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("inspects VM results passively without registering or opening a live environment", async () => {
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    expect(text(renderer!.toJSON())).toContain("Saved results");
    expect(text(renderer!.toJSON())).toContain("Approve result");
    expect(text(renderer!.toJSON())).not.toContain("Inspect live diff");
    expect(text(renderer!.toJSON())).not.toContain("Open conversation");
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    const approval = renderer!.root
      .findAllByType("button")
      .find((b) => b.props.children === "Approve result")!;
    expect(approval.props.disabled).toBe(true);
  });

  it("keeps the VM review check neutral for a member who cannot approve", async () => {
    const review = {
      ...vmReview,
      progress: {
        ...vmReview.progress,
        checkpoint: {
          ...workflowResultCheckpoint(vmReview.progress.checkpoint)!,
          checkpointRef: "ref",
          kind: "review",
          role: "maintainer",
        },
      },
      viewerControls: { canApprove: false, canRespond: false, canCancel: false },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(review);
    await mount(false);

    const pending = deferred();
    fixture.call.mockReturnValueOnce(pending.promise);
    await act(() =>
      beginWorkflowReview(
        appAtomRegistry,
        scope,
        review.jobId,
        "read-only-review",
        workflowResultCheckpoint(review.progress.checkpoint)!,
      ),
    );
    await pollRun();

    expect(text(renderer!.toJSON())).toContain(
      "Checking whether the result you inspected is still current.",
    );
    expect(text(renderer!.toJSON())).not.toContain("Approval is available");
    expect(findButton("Approve result")).toBeUndefined();

    await act(() =>
      pending.resolve({
        ...review,
        progress: { ...review.progress, revision: review.progress.revision - 1 },
      }),
    );
    expect(text(renderer!.toJSON())).toContain(
      "Retry the check to see if the result you inspected is still current.",
    );
    expect(text(renderer!.toJSON())).not.toContain("Approval needs a fresh check");
    expect(findButton("Retry check")).toBeDefined();
  });

  it("keeps a previously inspected version from approving a new VM review", async () => {
    beginWorkflowReview(appAtomRegistry, scope, job.jobId, "previous-visit", {
      checkpointId: "previous",
      turnId: "old-turn",
      checkpointTurnCount: 2,
    });
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    expect(text(renderer!.toJSON())).not.toContain("Review changed");
    const approval = renderer!.root
      .findAllByType("button")
      .find((b) => b.props.children === "Approve result")!;
    expect(approval.props.disabled).toBe(true);
    const before = fixture.call.mock.calls.length;
    await press("Approve result");
    expect(fixture.call).toHaveBeenCalledTimes(before);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("hides decisions while an earlier result is displayed and restores them on return", async () => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      viewerControls: { ...vmReview.viewerControls, canRespond: true },
    });
    await mount(false);
    const saved = renderer!.root.findByType(SavedWorkflowResults);
    await act(() => saved.props.onReviewTargetChange(false));
    expect(text(renderer!.toJSON())).not.toContain("Approve result");
    expect(text(renderer!.toJSON())).not.toContain("Request changes");
    await act(() => saved.props.onReviewTargetChange(true));
    expect(text(renderer!.toJSON())).toContain("Approve result");
    expect(text(renderer!.toJSON())).toContain("Request changes");
    const approval = renderer!.root
      .findAllByType("button")
      .find((b) => b.props.children === "Approve result")!;
    expect(approval.props.disabled).toBe(true);
  });

  it.each([
    ["paused", /applied when the VM is ready/i],
    ["waiting_capacity", /waiting for a VM slot/i],
  ] as const)("shows a queued VM approval as pending while %s", async (state, waitingText) => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      responsePending: true,
      pendingResponseOperation: "approve",
      vmRecovery: { state },
    });
    await mount(false);
    const content = text(renderer!.toJSON());
    expect(content).toContain("Response queued");
    expect(content).toMatch(waitingText);
    expect(content).toContain("Saved results");
    expect(content).not.toContain("waiting for the environment");
    expect(fixture.open).not.toHaveBeenCalled();
    const approval = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Approval pending")!;
    expect(approval.props.disabled).toBe(true);
  });

  it("keeps acknowledged review feedback visible while the saved VM waits and recovers", async () => {
    const saved = {
      ...vmReview,
      progress: { ...vmReview.progress, hasThread: true },
      viewerControls: { ...vmReview.viewerControls, canRespond: true },
      vmRecovery: { state: "saved" },
    } satisfies RepositoryWorkflowJob;
    const queued = {
      ...saved,
      responsePending: true,
      pendingResponseOperation: "request_changes",
      pendingResponseId: "accepted-feedback",
    } satisfies RepositoryWorkflowJob;
    const feedback = "Add rollback verification before publishing.";
    const task = () => text(renderer!.root.findByProps({ "aria-label": "Current workflow task" }));
    const announcement = () => text(headerStatus());
    const results = { scrollIntoView: vi.fn(), focus: vi.fn() };
    fixture.call.mockResolvedValue(saved);
    await mount(true, {
      createNodeMock: ({ props }) =>
        (props as { "aria-label"?: string })["aria-label"] === "Saved workflow results"
          ? results
          : null,
    });

    expect(task()).toContain("Workspace saved");
    expect(task()).not.toContain("Response queued");
    expect(findButton("Request changes").props.disabled).toBe(false);
    await press("Request changes");
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({ target: { value: feedback } }),
    );

    const receipt = deferred();
    const send = vi.fn().mockReturnValue(receipt.promise);
    fixture.call
      .mockResolvedValue(queued)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: send }, "token"));
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          operation: "request_changes",
          checkpointId: "checkpoint",
          expectedRevision: vmReview.progress.revision,
          text: feedback,
        },
      }),
    );
    expect(task()).toContain("Feedback being sent");
    expect(task()).not.toContain("Saved feedback");
    await act(async () => receipt.resolve(queued));

    expect(task()).toContain("Response queued");
    expect(announcement()).toMatch(/Response queued.*applied when the VM is ready/i);
    expect(task()).toContain("Saved feedback");
    expect(task()).toContain(feedback);
    expect(findButton("Request changes")).toBeUndefined();
    expect(findButton("Approve result")).toBeUndefined();

    const waitingForSlot = {
      ...queued,
      vmRecovery: { state: "waiting_capacity" },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(waitingForSlot);
    await pollRun();
    expect(task()).toContain("Response queued");
    expect(announcement()).toMatch(/Response queued.*waiting for a VM slot/i);
    expect(task()).toContain("Saved feedback");

    const blocker = "There is no verified VM backup for this workflow checkpoint.";
    const failedRecovery = {
      ...queued,
      vmRecovery: { state: "recovery_error", detail: blocker },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(failedRecovery);
    await pollRun();

    expect(task()).toContain("Recovery needs attention");
    expect(task()).toContain(blocker);
    expect(announcement()).toContain(blocker);
    expect(task()).toContain("Saved feedback");
    expect(task()).toContain(feedback);
    expect(task()).toContain("Saved results");
    expect(task()).toContain("Open saved results");
    await press("Open saved results");
    expect(results.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(results.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(findButton("Retry recovery")).toBeUndefined();
    expect(fixture.open).not.toHaveBeenCalled();

    fixture.call.mockResolvedValue({
      ...failedRecovery,
      progress: { ...failedRecovery.progress, threadDeletionRequested: true },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(task()).not.toContain("Open saved results");

    // The original feedback was withdrawn and another maintainer responded before our next poll.
    const { pendingResponseId: _previousResponse, ...otherMaintainerResponse } = waitingForSlot;
    fixture.call.mockResolvedValue(otherMaintainerResponse);
    await pollRun();
    expect(task()).toContain("Response queued");
    expect(task()).not.toContain("Saved feedback");
    expect(task()).not.toContain(feedback);
  });

  it("keeps the Input question and the acknowledged answer in the recovery card", async () => {
    const question = "Which environment should get the migration first?";
    const answer = "Start with staging.";
    const saved = {
      ...vmReview,
      status: "awaiting_input",
      progress: {
        ...vmReview.progress,
        status: "awaiting_input",
        hasThread: true,
        checkpoint: {
          kind: "input",
          checkpointId: "checkpoint",
          stepId: "rollout",
          generation: 0,
          role: "member",
          question,
        },
      },
      viewerControls: { canApprove: false, canRespond: true, canCancel: true },
      vmRecovery: { state: "saved" },
    } satisfies RepositoryWorkflowJob;
    const task = () => text(renderer!.root.findByProps({ "aria-label": "Current workflow task" }));
    fixture.call.mockResolvedValue(saved);
    await mount();

    expect(task()).toContain("Workspace saved");
    expect(task()).toContain(question);
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({ target: { value: answer } }),
    );
    fixture.call.mockResolvedValue({
      ...saved,
      responsePending: true,
      pendingResponseOperation: "input",
      pendingResponseId: "accepted-answer",
      vmRecovery: { state: "waiting_capacity" },
    } satisfies RepositoryWorkflowJob);
    await act(async () =>
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }),
    );

    expect(task()).toContain("Response queued");
    expect(task()).toContain(question);
    expect(task()).toContain("Saved answer");
    expect(task()).toContain(answer);
    expect(findButton("Submit answer")).toBeUndefined();
  });

  it("directs organization admins to the original Codex connection while keeping another viewer’s feedback private", async () => {
    const otherFeedback = "Feedback from another maintainer.";
    const key = workflowSessionKey(scope, job.jobId);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (drafts) => ({
      ...drafts,
      submitted: {
        ...drafts.submitted,
        [key]: {
          checkpoint: {
            checkpointId: "checkpoint",
            operation: "request_changes",
            userId: "other-maintainer",
            text: otherFeedback,
            requestEpoch: 1,
            acceptedPending: true,
          },
        },
      },
    }));
    const reconnectable = {
      ...vmReview,
      progress: { ...vmReview.progress, hasThread: true },
      responsePending: true,
      pendingResponseOperation: "request_changes",
      vmRecovery: { state: "waiting_codex" },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(reconnectable);
    const links = () =>
      renderer!.root
        .findAllByType("a")
        .filter((link) => link.props.href === "/settings/organization#organization-codex-vms");
    const content = () => text(renderer!.toJSON());
    await mount(true);

    expect(content()).toContain("Reconnect Codex to continue");
    expect(content()).toMatch(/organization admin/i);
    expect(content()).toMatch(/original.*account|original.*connection/i);
    expect(content()).not.toContain("Saved feedback");
    expect(content()).not.toContain(otherFeedback);
    expect(links()).toHaveLength(0);

    await act(() => renderer!.update(view("job", true, true)));
    expect(links()).toHaveLength(1);
    expect(text(links()[0]!)).toMatch(/Codex for VMs/i);
    expect(content()).not.toContain("Saved feedback");
    expect(content()).not.toContain(otherFeedback);
    expect(fixture.open).not.toHaveBeenCalled();

    fixture.call.mockResolvedValue({
      ...reconnectable,
      vmRecovery: { state: "recovery_error", reason: "codex_connection_replaced" },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(content()).toContain("Original Codex connection unavailable");
    expect(content()).not.toContain("Recovery continues automatically");
    expect(links()).toHaveLength(0);
    expect(findButton("Open saved results")).toBeDefined();
  });

  it.each([
    ["Approve result", "awaiting_review"],
    ["Retry completion", "finishing"],
  ] as const)(
    "requires an active saved diff render and a fresh run read for %s",
    async (label, status) => {
      const active = {
        ...vmReview,
        status,
        progress: {
          ...vmReview.progress,
          status,
          retryableApproval: status === "finishing",
        },
      } satisfies RepositoryWorkflowJob;
      const checkpoint = workflowResultCheckpoint(active.progress.checkpoint)!;
      const key = workflowSessionKey(scope, active.jobId);
      const saved = () => renderer!.root.findByType(SavedWorkflowResults);
      const disabled = () => {
        const { disabled, "aria-disabled": ariaDisabled } = findButton(label).props;
        return disabled || ariaDisabled;
      };
      function recordVisit(visitId: string) {
        beginWorkflowReview(appAtomRegistry, scope, active.jobId, visitId, checkpoint);
        expect(
          recordSavedWorkflowReviewDiff(appAtomRegistry, scope, active.jobId, visitId, {
            resultId: "11111111-1111-4111-8111-111111111111",
            stepId: "agent",
            turnId: checkpoint.turnId,
            turnCount: checkpoint.checkpointTurnCount,
            outcome: "completed",
            createdAt: "now",
            checkpointRef: "ref",
            baselineCommitId: "base",
            commitId: "commit",
            treeId: "tree",
            patch: {
              artifactId: "22222222-2222-4222-8222-222222222222",
              sha256: "a".repeat(64),
              sizeBytes: 0,
            },
          }),
        ).toBe(true);
        requireFreshWorkflowReviewRead(appAtomRegistry, scope, active.jobId);
      }
      fixture.call.mockResolvedValue(active);
      await mount();
      await act(() => recordVisit("previous-visit"));
      await pollRun();

      expect(
        workflowReviewApprovalState(
          appAtomRegistry.get(workflowDraftAtom).reviews[key],
          appAtomRegistry.get(workflowJobReadAtom).jobs[key]!,
        ),
      ).toBe("allowed");
      expect(disabled()).toBe(true);
      const callsBeforeRendering = fixture.call.mock.calls.length;
      await press(label);
      expect(fixture.call).toHaveBeenCalledTimes(callsBeforeRendering);

      await act(() => {
        recordVisit("current-render");
        saved().props.onReviewRenderChange(checkpoint);
      });
      expect(disabled()).toBe(true);
      await pollRun();
      expect(disabled()).toBeFalsy();
      const previousSubmit = findButton(label).props.onClick;

      await act(() => {
        saved().props.onReviewRenderChange(null);
        saved().props.onReviewTargetChange(false);
      });
      await act(() => saved().props.onReviewTargetChange(true));
      expect(disabled()).toBe(true);
      const callsAfterSelection = fixture.call.mock.calls.length;
      await act(() => previousSubmit());
      await press(label);
      expect(fixture.call).toHaveBeenCalledTimes(callsAfterSelection);

      await act(() => {
        recordVisit("new-render");
        saved().props.onReviewRenderChange(checkpoint);
      });
      expect(disabled()).toBe(true);
      await pollRun();
      expect(disabled()).toBeFalsy();
      const submit = vi.fn().mockResolvedValue(active);
      fixture.call.mockImplementationOnce((request) =>
        request({ respondToWorkflowJob: submit }, "token"),
      );
      await press(label);
      expect(submit).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "token",
        repositoryId: scope.repositoryId,
        jobId: active.jobId,
        payload: {
          operation: "approve",
          checkpointId: checkpoint.checkpointId,
          expectedRevision: active.progress.revision,
        },
      });
    },
  );

  it("opens conversation and retries the exact completed result at the current destination", async () => {
    fixture.workflowRunsReturn = {
      scopeKey: workflowSessionKey(scope, "runs"),
      view: "history",
      row: { jobId: job.jobId, index: 13 },
      loadedCount: 20,
      scrollTop: 360,
    };
    fixture.open.mockRejectedValueOnce(new Error("Location unavailable"));
    await mount();
    await press("Inspect result");
    expect(fixture.navigate).not.toHaveBeenCalled();
    await press("Retry saved diff");
    expect(fixture.select).toHaveBeenCalledWith(
      { environmentId: "moved-vm", threadId: "thread" },
      "saved-turn",
    );
    expect(fixture.panel).toHaveBeenCalledWith(
      { environmentId: "moved-vm", threadId: "thread" },
      "diff",
    );
    const destination = fixture.navigate.mock.calls[0]![0];
    expect(destination.params).toEqual({ environmentId: "moved-vm", threadId: "thread" });
    expect(destination.state({}).workflowRunsReturn).toEqual(fixture.workflowRunsReturn);
    expect(destination.state({}).workflowOrigin).toEqual({
      ...scope,
      jobId: "job",
      threadId: "thread",
      workflowVmResultReader: true,
      savedDiffCheckpoint: {
        checkpointId: "checkpoint",
        turnId: "saved-turn",
        checkpointTurnCount: 3,
      },
    });
    expect(fixture.open).toHaveBeenCalledWith(
      expect.objectContaining({ workflowResult: { ...scope, originalEnvironmentId: "original" } }),
    );
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(2);
    const conversationState = fixture.navigate.mock.calls[1]![0].state({});
    expect(conversationState.workflowRunsReturn).toEqual(fixture.workflowRunsReturn);
    expect(conversationState.workflowOrigin.savedDiffCheckpoint).toBeUndefined();
    expect(job.runtime).toMatchObject({ kind: "machine", environmentId: "original" });
  });
  it("opens the active Machine review at its checkpoint without requiring a VM review visit", async () => {
    const review = {
      ...job,
      status: "awaiting_review",
      progress: { ...job.progress!, status: "awaiting_review" },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(review);
    fixture.open.mockResolvedValue({
      _tag: "Success",
      value: { environmentId: "original", threadId: "thread" },
    });
    await mount();
    await press("Inspect saved diff");

    expect(fixture.select).toHaveBeenCalledWith(
      { environmentId: "original", threadId: "thread" },
      "saved-turn",
    );
    expect(fixture.navigate.mock.calls[0]![0].state({}).workflowOrigin).toEqual({
      ...scope,
      jobId: "job",
      threadId: "thread",
      reviewCheckpoint: {
        checkpointId: "checkpoint",
        turnId: "saved-turn",
        checkpointTurnCount: 3,
      },
    });
  });
  it.each([false, true])(
    "lands at the review after loading and preserves focus moved during the read (%s)",
    async (movedFocus) => {
      const reply = deferred();
      const review = {
        ...job,
        status: "awaiting_review",
        progress: { ...job.progress!, status: "awaiting_review" },
      } satisfies RepositoryWorkflowJob;
      const body = {};
      const ownerDocument = { body, activeElement: body };
      const section = { ownerDocument, scrollIntoView: vi.fn(), focus: vi.fn() };
      fixture.locationHash = "workflow-review";
      fixture.call.mockReturnValueOnce(reply.promise).mockResolvedValue(review);
      await mount(true, {
        createNodeMock: ({ props }) =>
          (props as { id?: string }).id === "workflow-review" ? section : null,
      });
      expect(text(renderer!.toJSON())).toContain("Loading run");
      expect(section.focus).not.toHaveBeenCalled();

      if (movedFocus) ownerDocument.activeElement = {};
      await act(async () => reply.resolve(review));
      if (movedFocus) {
        expect(section.scrollIntoView).not.toHaveBeenCalled();
      } else {
        expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
        expect(section.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      }

      await pollRun();
      expect(section.focus).toHaveBeenCalledTimes(movedFocus ? 0 : 1);
    },
  );
  function cacheMachineReview() {
    const review = {
      ...job,
      status: "awaiting_review",
      progress: {
        ...job.progress!,
        status: "awaiting_review",
        checkpoint: {
          checkpointId: "checkpoint",
          turnId: "saved-turn",
          checkpointRef: "ref",
          checkpointTurnCount: 3,
          kind: "review",
          role: "member",
        },
      },
      viewerControls: { canApprove: true, canRespond: true, canCancel: true },
    } satisfies RepositoryWorkflowJob;
    activateWorkflowJobView(appAtomRegistry, scope, job.jobId);
    const request = beginWorkflowJobRequest(appAtomRegistry, scope, job.jobId)!;
    settleWorkflowJobRequest(appAtomRegistry, request, review);
    return review;
  }
  function recordMachineDiff(
    checkpoint: WorkflowResultCheckpoint,
    visitId: string,
    targetTurnId = checkpoint.turnId,
  ) {
    const threadId = ThreadId.make("thread");
    recordMachineWorkflowReviewDiff(
      appAtomRegistry,
      { ...scope, jobId: job.jobId, threadId, reviewCheckpoint: checkpoint },
      visitId,
      {
        threadId,
        fromTurnCount: checkpoint.checkpointTurnCount - 1,
        toTurnCount: checkpoint.checkpointTurnCount,
        targetTurnId: TurnId.make(targetTurnId),
        diff: "",
        completeWorkflowReview: true,
      },
    );
  }
  function returnToMachineReview() {
    const review = cacheMachineReview();
    const checkpoint = workflowResultCheckpoint(review.progress.checkpoint)!;
    const visitId = "inspected-review";
    beginMachineWorkflowReview(
      appAtomRegistry,
      scope,
      job.jobId,
      visitId,
      "source-run",
      checkpoint,
    );
    recordMachineDiff(checkpoint, visitId);
    fixture.locationHash = "workflow-review";
    fixture.workflowMachineReviewVisitId = visitId;
    fixture.workflowReviewReturn = checkpoint;
    return review;
  }
  it.each([false, true])(
    "handles focus on a direct jump between returns to the same review (focus moved: %s)",
    async (movedFocus) => {
      const review = returnToMachineReview();
      const body = {};
      const ownerDocument = { body, activeElement: body };
      const section = { ownerDocument, scrollIntoView: vi.fn(), focus: vi.fn() };
      fixture.call.mockResolvedValue(review);
      await mount(true, {
        createNodeMock: ({ props }) =>
          (props as { id?: string }).id === "workflow-review" ? section : null,
      });
      expect(section.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });

      const reply = deferred();
      fixture.call.mockReturnValueOnce(reply.promise);
      await act(() => {
        fixture.locationKey = "earlier-review-return";
        renderer!.update(view());
      });
      expect(text(renderer!.toJSON())).toContain("Checking the current review");
      expect(section.focus).toHaveBeenCalledTimes(1);

      if (movedFocus) ownerDocument.activeElement = {};
      await act(async () => reply.resolve(review));
      const expectedFocusCount = movedFocus ? 1 : 2;
      expect(section.focus).toHaveBeenCalledTimes(expectedFocusCount);
      expect(section.scrollIntoView).toHaveBeenCalledTimes(expectedFocusCount);

      ownerDocument.activeElement = body;
      await pollRun();
      expect(section.focus).toHaveBeenCalledTimes(expectedFocusCount);
    },
  );
  it.each([
    "same checkpoint",
    "changed checkpoint",
    "earlier explicit link",
    "earlier Browser Back",
  ] as const)(
    "checks the returned checkpoint before moving focus or allowing approval (%s)",
    async (returnPath) => {
      const reply = deferred();
      const review = returnToMachineReview();

      const refreshed = {
        ...review,
        progress: {
          ...review.progress,
          revision: review.progress.revision + 1,
          checkpoint:
            returnPath !== "same checkpoint"
              ? {
                  ...review.progress.checkpoint,
                  checkpointId: "later",
                  turnId: "updated-review-turn",
                  checkpointTurnCount: 4,
                }
              : review.progress.checkpoint,
        },
      } satisfies RepositoryWorkflowJob;
      if (returnPath === "earlier explicit link" || returnPath === "earlier Browser Back") {
        const latest = workflowResultCheckpoint(refreshed.progress.checkpoint)!;
        const latestVisitId = "latest-inspected-review";
        beginMachineWorkflowReview(
          appAtomRegistry,
          scope,
          job.jobId,
          latestVisitId,
          "other-return-entry",
          latest,
        );
        recordMachineDiff(latest, latestVisitId);
        fixture.workflowMachineReviewVisitId = undefined;
        if (returnPath === "earlier Browser Back") {
          fixture.locationKey = "source-run";
          fixture.locationHash = "";
          fixture.workflowReviewReturn = undefined;
        }
      }
      fixture.call.mockReturnValueOnce(reply.promise).mockResolvedValue(refreshed);
      const body = {};
      const ownerDocument = { body, activeElement: body };
      const heading = { ownerDocument, scrollIntoView: vi.fn(), focus: vi.fn() };
      const section = { ownerDocument, scrollIntoView: vi.fn(), focus: vi.fn() };
      await mount(true, {
        createNodeMock: ({ type, props }) =>
          type === "h1"
            ? heading
            : (props as { id?: string }).id === "workflow-review"
              ? section
              : null,
      });
      expect(text(renderer!.toJSON())).toContain("Checking the current review");
      expect(findButton("Approve result").props.disabled).toBe(true);
      await press("Approve result");
      expect(fixture.call).toHaveBeenCalledTimes(1);
      expect(section.focus).not.toHaveBeenCalled();
      expect(heading.focus).not.toHaveBeenCalled();

      await act(async () => reply.resolve(refreshed));

      const changed = returnPath !== "same checkpoint";
      if (returnPath === "earlier Browser Back") {
        expect(heading.focus).not.toHaveBeenCalled();
        expect(section.focus).not.toHaveBeenCalled();
      } else {
        const target = changed ? heading : section;
        expect(target.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
        expect(target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect((changed ? section : heading).focus).not.toHaveBeenCalled();
      }
      expect(text(renderer!.toJSON())).not.toContain("Checking the current review");
      if (changed) {
        expect(text(renderer!.toJSON())).toContain("Review changed");
        expect(findButton("Approve result").props.disabled).toBe(true);
        await press("Approve result");
        expect(fixture.call).toHaveBeenCalledTimes(1);

        await press("Inspect updated diff");
        expect(fixture.select).toHaveBeenCalledWith(
          { environmentId: "moved-vm", threadId: "thread" },
          "updated-review-turn",
        );
        expect(
          fixture.navigate.mock.calls[0]![0].state({}).workflowOrigin.reviewCheckpoint,
        ).toEqual(workflowResultCheckpoint(refreshed.progress.checkpoint));
      } else {
        expect(text(renderer!.toJSON())).not.toContain("Review changed");
        expect(findButton("Approve result").props.disabled).not.toBe(true);
      }
    },
  );
  it("uses the exact earlier visit proof for an explicit return to the same checkpoint", async () => {
    const review = returnToMachineReview();
    const checkpoint = workflowResultCheckpoint(review.progress.checkpoint)!;
    beginMachineWorkflowReview(
      appAtomRegistry,
      scope,
      job.jobId,
      "another-uninspected-visit",
      "other-entry",
      checkpoint,
    );
    fixture.call.mockResolvedValue(review);
    await mount();

    expect(text(renderer!.toJSON())).not.toContain("Current diff needs inspection");
    expect(findButton("Approve result").props.disabled).not.toBe(true);
  });
  it.each(["unloaded diff", "wrong turn", "visible matching diff"] as const)(
    "gates approval after Browser Back to the first Run entry (%s)",
    async (diffState) => {
      const review = cacheMachineReview();
      const checkpoint = workflowResultCheckpoint(review.progress.checkpoint)!;
      fixture.call.mockResolvedValue(review);
      fixture.open.mockResolvedValue(
        Exit.succeed({ environmentId: "original", threadId: "thread" }),
      );
      await mount();
      await press("Inspect saved diff");

      const destination = fixture.navigate.mock.calls[0]![0].state({});
      expect(destination.workflowOrigin.reviewCheckpoint).toEqual(checkpoint);
      expect(destination.workflowMachineReviewVisitId).toEqual(expect.any(String));
      if (diffState === "wrong turn") {
        recordMachineDiff(checkpoint, destination.workflowMachineReviewVisitId, "earlier-turn");
      } else if (diffState === "visible matching diff") {
        recordMachineDiff(checkpoint, destination.workflowMachineReviewVisitId);
      }

      await act(() => renderer!.unmount());
      renderer = undefined;
      const fresh = deferred();
      fixture.call.mockClear().mockReturnValueOnce(fresh.promise);
      await mount();

      expect(text(renderer!.toJSON())).toContain("Checking the current review");
      expect(findButton("Approve result").props.disabled).toBe(true);
      await press("Approve result");
      expect(fixture.call).toHaveBeenCalledTimes(1);

      await act(async () => fresh.resolve(review));
      expect(text(renderer!.toJSON())).not.toContain("Checking the current review");
      if (diffState === "visible matching diff") {
        expect(findButton("Approve result").props.disabled).not.toBe(true);
      } else {
        expect(text(renderer!.toJSON())).toContain("Current diff needs inspection");
        expect(findButton("Inspect saved diff").props.disabled).not.toBe(true);
        expect(findButton("Approve result").props.disabled).toBe(true);
        await press("Approve result");
        expect(fixture.call).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["proof cleared", "freshly inspected", "review changed"] as const)(
    "checks the original Machine visit after reload and Back (%s)",
    async (outcome) => {
      const review = cacheMachineReview();
      const checkpoint = workflowResultCheckpoint(review.progress.checkpoint)!;
      const originalHistoryState = {
        __TSR_key: fixture.locationKey,
        __TSR_index: 3,
        unrelatedState: true,
      };
      let sourceState: unknown = originalHistoryState;
      const history = {
        get state() {
          return sourceState;
        },
        replaceState: vi.fn((state: unknown) => {
          sourceState = structuredClone(state);
        }),
      };
      Object.assign(window, { history });
      fixture.call.mockResolvedValue(review);
      await mount();
      await press("Inspect saved diff");

      const destination = fixture.navigate.mock.calls[0]![0].state(sourceState);
      expect(destination.workflowMachineReviewSource).toBeUndefined();
      recordMachineDiff(checkpoint, destination.workflowMachineReviewVisitId);
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(sourceState).toEqual({
        ...originalHistoryState,
        workflowMachineReviewSource: {
          runKey: workflowSessionKey(scope, job.jobId),
          id: destination.workflowMachineReviewVisitId,
          checkpoint,
        },
      });

      await act(() => renderer!.unmount());
      renderer = undefined;
      setWorkflowSessionAccount(appAtomRegistry, null);
      setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
      if (outcome !== "proof cleared")
        recordMachineDiff(checkpoint, destination.workflowMachineReviewVisitId);
      const fresh = deferred();
      fixture.call.mockClear().mockReturnValueOnce(fresh.promise);
      await mount();
      expect(findButton("Approve result")).toBeUndefined();

      await act(() =>
        fresh.resolve(
          outcome === "review changed"
            ? {
                ...review,
                progress: {
                  ...review.progress,
                  revision: review.progress.revision + 1,
                  checkpoint: {
                    ...review.progress.checkpoint,
                    checkpointId: "new-review",
                    turnId: "new-turn",
                  },
                },
              }
            : review,
        ),
      );

      if (outcome === "freshly inspected") {
        expect(findButton("Approve result").props.disabled).not.toBe(true);
        expect(text(renderer!.toJSON())).not.toContain("Current diff needs inspection");
        const respond = vi.fn().mockResolvedValue(review);
        fixture.call.mockImplementationOnce((operation) =>
          operation({ respondToWorkflowJob: respond }, "token"),
        );
        await press("Approve result");
        expect(respond).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: {
              operation: "approve",
              checkpointId: checkpoint.checkpointId,
              expectedRevision: review.progress.revision,
            },
          }),
        );
        return;
      }
      expect(text(renderer!.toJSON())).toContain(
        outcome === "review changed" ? "Review changed" : "Current diff needs inspection",
      );
      expect(findButton("Approve result").props.disabled).toBe(true);
      await press("Approve result");
      expect(fixture.call).toHaveBeenCalledTimes(1);
    },
  );
  it("does not open a Machine review diff after leaving its Run history entry", async () => {
    const review = cacheMachineReview();
    const opening = deferred();
    fixture.call.mockResolvedValue(review);
    fixture.open.mockReturnValueOnce(opening.promise);
    await mount();
    await press("Inspect saved diff");

    fixture.locationKey = "other-run-entry";
    await act(async () => {
      opening.resolve(Exit.succeed({ environmentId: "original", threadId: "thread" }));
      await opening.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.select).not.toHaveBeenCalled();
  });
  it("clears an old diff open and checks a new history entry for the same Run immediately", async () => {
    const review = cacheMachineReview();
    const checkpoint = workflowResultCheckpoint(review.progress.checkpoint)!;
    const oldOpening = deferred();
    const oldRead = deferred();
    const fresh = deferred();
    fixture.call
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(fresh.promise);
    fixture.open.mockReturnValueOnce(oldOpening.promise);
    await mount();
    await press("Inspect saved diff");
    expect(findButton("Opening saved diff…")).toBeDefined();
    await pollRun();

    await act(() => {
      beginMachineWorkflowReview(
        appAtomRegistry,
        scope,
        job.jobId,
        "returned-visit",
        "original-visit-source",
        checkpoint,
      );
      recordMachineDiff(checkpoint, "returned-visit");
      fixture.locationKey = "other-run-entry";
      fixture.locationHash = "workflow-review";
      fixture.workflowReviewReturn = checkpoint;
      fixture.workflowMachineReviewVisitId = "returned-visit";
      renderer!.update(view());
    });

    expect(fixture.call).toHaveBeenCalledTimes(3);
    expect(findButton("Opening saved diff…")).toBeUndefined();
    expect(text(renderer!.toJSON())).toContain("Checking the current review");
    expect(findButton("Approve result").props.disabled).toBe(true);

    const staleInstruction = "Only from the older history entry";
    await act(async () => oldRead.resolve({ ...review, instruction: staleInstruction }));
    expect(text(renderer!.toJSON())).not.toContain(staleInstruction);
    expect(findButton("Approve result").props.disabled).toBe(true);

    await act(async () => fresh.resolve(review));
    expect(findButton("Approve result").props.disabled).not.toBe(true);
    const currentOpening = deferred();
    fixture.open.mockReturnValueOnce(currentOpening.promise);
    await press("Inspect saved diff");
    expect(fixture.open).toHaveBeenCalledTimes(2);

    const location = Exit.succeed({ environmentId: "original", threadId: "thread" });
    await act(async () => oldOpening.resolve(location));
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(findButton("Opening saved diff…")).toBeDefined();

    await act(async () => currentOpening.resolve(location));
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });
  it.each(["transport failure", "stale response"])(
    "keeps approval blocked after a failed return check until a successful retry (%s)",
    async (failure) => {
      const review = returnToMachineReview();
      const retry = deferred();
      if (failure === "transport failure") {
        fixture.call.mockRejectedValueOnce(new Error("Could not reach the relay"));
      } else {
        fixture.call.mockResolvedValueOnce({
          ...review,
          progress: { ...review.progress, revision: review.progress.revision - 1 },
        } satisfies RepositoryWorkflowJob);
      }
      fixture.call.mockReturnValueOnce(retry.promise).mockResolvedValue(review);
      await mount();

      const notice = renderer!.root
        .findAllByProps({ role: "alert" })
        .find((alert) => text(alert).includes("Couldn’t verify the current review"));
      expect(text(notice ?? null)).toContain(
        failure === "transport failure"
          ? "Could not reach the relay"
          : "Approval needs a fresh check of the result you inspected.",
      );
      expect(findButton("Approve result").props.disabled).toBe(true);
      await press("Approve result");
      expect(fixture.call).toHaveBeenCalledTimes(1);

      await press("Retry check");
      expect(fixture.call).toHaveBeenCalledTimes(2);
      expect(text(renderer!.toJSON())).toContain("Checking the current review");
      expect(text(renderer!.toJSON())).not.toContain("Couldn’t verify the current review");
      expect(findButton("Approve result").props.disabled).toBe(true);
      await press("Approve result");
      expect(fixture.call).toHaveBeenCalledTimes(2);

      await act(async () => retry.resolve(review));
      expect(text(renderer!.toJSON())).not.toContain("Couldn’t verify the current review");
      expect(findButton("Retry check")).toBeUndefined();
      expect(findButton("Approve result").props.disabled).not.toBe(true);
    },
  );
  it.each([
    {
      action: "Inspect saved diff",
      retry: "Retry saved diff",
      pending: "Opening saved diff…",
      otherAction: "Open conversation",
    },
    {
      action: "Open conversation",
      retry: "Retry conversation",
      pending: "Opening conversation…",
      otherAction: "Inspect saved diff",
    },
  ])(
    "retries $action at the same Machine destination",
    async ({ action, retry, pending, otherAction }) => {
      const review = {
        ...job,
        status: "awaiting_review",
        progress: { ...job.progress!, status: "awaiting_review" },
      } satisfies RepositoryWorkflowJob;
      const reply = deferred();
      fixture.call.mockResolvedValue(review);
      fixture.open
        .mockRejectedValueOnce(new Error("Location unavailable"))
        .mockReturnValueOnce(reply.promise);
      await mount();
      await press(action);
      expect(text(renderer!.toJSON())).toContain("Location unavailable");
      expect(fixture.navigate).not.toHaveBeenCalled();
      expect(fixture.select).not.toHaveBeenCalled();

      fixture.call.mockResolvedValue({
        ...review,
        progress: {
          ...review.progress,
          revision: review.progress.revision + 1,
          checkpoint: {
            ...review.progress.checkpoint!,
            checkpointId: "new-checkpoint",
            turnId: "new-turn",
          },
        },
      });
      await press("Refresh run");
      expect(findButton("Inspect saved diff").props.disabled).toBe(false);
      await press(retry);
      expect(findButton(pending)).toBeDefined();
      expect(findButton(otherAction).props.disabled).toBe(true);
      expect(text(renderer!.toJSON())).not.toContain("Location unavailable");

      const destination = { environmentId: "original", threadId: "thread" };
      await act(async () => reply.resolve({ _tag: "Success", value: destination }));
      expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ to: "/$environmentId/$threadId", params: destination }),
      );
      const { workflowOrigin } = fixture.navigate.mock.calls[0]![0].state({});
      if (action === "Inspect saved diff") {
        expect(fixture.select).toHaveBeenCalledExactlyOnceWith(destination, "saved-turn");
        expect(fixture.panel).toHaveBeenCalledExactlyOnceWith(destination, "diff");
        expect(workflowOrigin.reviewCheckpoint).toEqual({
          checkpointId: "checkpoint",
          turnId: "saved-turn",
          checkpointTurnCount: 3,
        });
      } else {
        expect(fixture.select).not.toHaveBeenCalled();
        expect(fixture.panel).not.toHaveBeenCalled();
        expect(workflowOrigin.reviewCheckpoint).toBeUndefined();
      }
    },
  );
  it.each(["awaiting_review", "done"] as const)(
    "keeps the same retry control mounted when a running Machine run becomes %s",
    async (status) => {
      fixture.call.mockResolvedValue({
        ...job,
        status: "running",
        progress: { ...job.progress!, status: "running", checkpoint: null },
      } satisfies RepositoryWorkflowJob);
      fixture.open.mockRejectedValueOnce(new Error("Location unavailable"));
      await mount();
      await press("Open conversation");
      const retry = findButton("Retry conversation");
      expect(retry).toBeDefined();

      fixture.call.mockResolvedValue({
        ...job,
        status,
        progress: { ...job.progress!, revision: job.progress!.revision + 1, status },
      } satisfies RepositoryWorkflowJob);
      await pollRun();

      expect(findButton("Retry conversation")).toBe(retry);
      await press("Retry conversation");
      expect(fixture.navigate).toHaveBeenCalledOnce();
    },
  );
  it("clears a failed result lookup when another run is selected", async () => {
    fixture.open.mockRejectedValueOnce(new Error("Previous run location unavailable"));
    await mount();
    await press("Open conversation");
    expect(text(renderer!.toJSON())).toContain("Previous run location unavailable");
    fixture.call.mockResolvedValue({ ...job, jobId: "other" });
    await act(async () => renderer!.update(view("other")));
    expect(text(renderer!.toJSON())).not.toContain("Previous run location unavailable");
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
    expect(fixture.navigate.mock.calls[0]![0].state({}).workflowOrigin.jobId).toBe("other");
  });
  it("releases its busy state when the relay session changes during lookup", async () => {
    const reply = deferred();
    fixture.open.mockReturnValueOnce(reply.promise);
    await mount();
    await press("Open conversation");
    expect(conversationOpeningIsBlocked()).toBe(true);
    appAtomRegistry.set(managedRelaySessionAtom, {
      accountId: scope.accountId,
      readClerkToken: () => Effect.succeed("replacement-token"),
    });
    await act(async () => {
      reply.resolve({ _tag: "Success", value: { environmentId: "moved-vm", threadId: "thread" } });
      await reply.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(conversationOpeningIsBlocked()).toBe(false);
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
  });
  it("lets another run open while the older lookup finishes without clearing its busy state", async () => {
    const oldReply = deferred();
    const newReply = deferred();
    fixture.open.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
    await mount();
    await press("Open conversation");
    fixture.call.mockResolvedValue({ ...job, jobId: "other" });
    await act(async () => renderer!.update(view("other")));
    expect(conversationOpeningIsBlocked()).toBe(false);
    await press("Open conversation");
    expect(fixture.open).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldReply.resolve({ _tag: "Success", value: { environmentId: "old-vm", threadId: "thread" } });
      await oldReply.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(conversationOpeningIsBlocked()).toBe(true);
    await act(async () => {
      newReply.resolve({ _tag: "Success", value: { environmentId: "new-vm", threadId: "thread" } });
      await newReply.promise;
    });
    expect(conversationOpeningIsBlocked()).toBe(false);
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
    expect(fixture.navigate.mock.calls[0]![0].state({}).workflowOrigin.jobId).toBe("other");
  });
  it("does not navigate after a result lookup outlives the job view", async () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((done) => {
      resolve = done;
    });
    const reply = { promise, resolve };
    fixture.open.mockReturnValue(reply.promise);
    await mount();
    await press("Open conversation");
    await act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      reply.resolve({ _tag: "Success", value: { environmentId: "moved-vm", threadId: "thread" } });
      await reply.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});

describe("workflow run presentation", () => {
  const review = {
    ...job,
    status: "awaiting_review",
    progress: {
      ...job.progress!,
      status: "awaiting_review",
      checkpoint: {
        checkpointId: "checkpoint",
        turnId: "saved-turn",
        checkpointRef: "ref",
        checkpointTurnCount: 3,
        kind: "review",
        role: "member",
      },
    },
    viewerControls: { canApprove: true, canRespond: true, canCancel: true },
  } satisfies RepositoryWorkflowJob;
  const maintainerReview = {
    ...job,
    status: "awaiting_review",
    progress: {
      ...review.progress,
      checkpoint: { ...review.progress.checkpoint, role: "maintainer" },
    },
  } satisfies RepositoryWorkflowJob;
  it("keeps saved diff opening and recovery visible while composing feedback", async () => {
    const lookup = deferred();
    const retry = deferred();
    fixture.call.mockResolvedValue(review);
    fixture.open.mockReturnValueOnce(lookup.promise).mockReturnValueOnce(retry.promise);
    await mount();
    await press("Inspect saved diff");
    await press("Request changes");
    const editor = () => renderer!.root.findByType("textarea");
    await act(() => editor().props.onChange({ target: { value: "Add a regression test" } }));
    expect(findButton("Opening saved diff…")).toBeDefined();

    await act(async () =>
      lookup.resolve(
        Exit.fail(new OrchestrationDispatchCommandError({ message: "Location unavailable" })),
      ),
    );
    const recovery = renderer!.root
      .findAllByProps({ role: "alert" })
      .find((alert) => text(alert).includes("Location unavailable"));
    expect(text(recovery ?? null)).toContain("Retry saved diff");
    expect(editor().props.value).toBe("Add a regression test");

    await press("Retry saved diff");
    expect(findButton("Opening saved diff…")).toBeDefined();
    expect(editor().props.value).toBe("Add a regression test");
    expect(fixture.navigate).not.toHaveBeenCalled();

    await act(async () =>
      retry.resolve(
        Exit.fail(new OrchestrationDispatchCommandError({ message: "Location still unavailable" })),
      ),
    );
    expect(text(renderer!.toJSON())).toContain("Location still unavailable");
  });
  it("returns to review without losing feedback, stays closed on refresh, and restores it on request", async () => {
    fixture.call.mockResolvedValue(review);
    await mount();
    await press("Request changes");
    await act(() =>
      renderer!.root
        .findByType("textarea")
        .props.onChange({ target: { value: "Add a regression test" } }),
    );
    expect(text(renderer!.toJSON())).not.toContain("Approve result");
    await press("Back to review");
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    expect(text(renderer!.toJSON())).toContain("Approve result");
    await press("Refresh run");
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    await press("Request changes");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Add a regression test");
    expect(fixture.call).toHaveBeenCalledTimes(2);
  });
  const checkpointQuestion = "Who should receive the migration first?";
  const inputCheckpoint = {
    ...review,
    status: "awaiting_input",
    progress: {
      ...review.progress!,
      status: "awaiting_input",
      checkpoint: {
        checkpointId: "checkpoint",
        stepId: "rollout",
        generation: 0,
        kind: "input",
        role: "member",
        question: checkpointQuestion,
      },
    },
  } satisfies RepositoryWorkflowJob;
  const maintainerInput = {
    ...job,
    status: inputCheckpoint.status,
    progress: {
      ...inputCheckpoint.progress,
      checkpoint: { ...inputCheckpoint.progress.checkpoint, role: "maintainer" },
    },
  } satisfies RepositoryWorkflowJob;
  const noCheckpointAccess = { canApprove: false, canRespond: false, canCancel: false };
  const currentTask = () =>
    renderer!.root
      .findAllByType("section")
      .find((section) => section.props["aria-label"] === "Current workflow task")!;
  const submitCheckpoint = () =>
    act(async () => {
      currentTask().findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });

  it("shows the Input question and maintainer requirement without a response form for a member", async () => {
    fixture.call.mockResolvedValue({
      ...maintainerInput,
      viewerControls: noCheckpointAccess,
    } satisfies RepositoryWorkflowJob);
    await mount(false);

    expect(text(currentTask())).toContain(checkpointQuestion);
    expect(text(currentTask())).toContain("Waiting for a repository maintainer to answer.");
    expect(currentTask().findAllByType("form")).toHaveLength(0);
    expect(findButton("Submit answer")).toBeUndefined();
  });

  it("lets a member inspect a maintainer-only Machine review without responding", async () => {
    fixture.call.mockResolvedValue(maintainerReview);
    fixture.open.mockResolvedValue({
      _tag: "Success",
      value: { environmentId: "original", threadId: "thread" },
    });
    await mount(false);

    expect(text(currentTask())).toContain(
      "Waiting for a repository maintainer to review the result.",
    );
    expect(findButton("Request changes")).toBeUndefined();
    expect(findButton("Approve result")).toBeUndefined();
    expect(currentTask().findAllByType("form")).toHaveLength(0);

    await press("Inspect saved diff");
    expect(fixture.select).toHaveBeenCalledWith(
      { environmentId: "original", threadId: "thread" },
      "saved-turn",
    );
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(2);
  });

  const unconfirmedAccess = "Response access couldn’t be confirmed. Refresh the run to try again.";
  const checkingAccess = "Checking who can respond…";
  const maintainerAnswerRequired = "Waiting for a repository maintainer to answer.";

  it.each([
    {
      outcome: "maintainer required",
      controls: noCheckpointAccess,
      announcement: maintainerAnswerRequired,
    },
    {
      outcome: "access confirmed",
      controls: { ...noCheckpointAccess, canRespond: true },
      announcement: "Your response access is confirmed.",
    },
    { outcome: "access unresolved", controls: undefined, announcement: unconfirmedAccess },
    {
      outcome: "checkpoint replaced",
      controls: noCheckpointAccess,
      announcement: "",
      replaceCheckpoint: true,
    },
  ])(
    "announces a manual VM checkpoint access check ($outcome), while polling stays quiet",
    async ({ controls, announcement, replaceCheckpoint }) => {
      const vmInput = {
        ...maintainerInput,
        runtime: { kind: "vm", threadId: ThreadId.make("thread") },
      } satisfies RepositoryWorkflowJob;
      fixture.call.mockResolvedValue(vmInput);
      await mount(false);

      const status = () =>
        text(
          renderer!.root.findByProps({
            role: "status",
            "aria-label": "Checkpoint response access",
          }),
        );
      expect(text(currentTask())).toContain(checkpointQuestion);
      expect(text(currentTask())).toContain(unconfirmedAccess);
      expect(text(currentTask())).not.toContain("repository maintainer");
      expect(currentTask().findAllByType("form")).toHaveLength(0);
      expect(status()).toBe("");

      const background = deferred();
      fixture.call.mockReturnValueOnce(background.promise);
      await pollRun();

      expect(text(currentTask())).toContain(checkingAccess);
      expect(status()).toBe("");
      await act(async () => {
        background.resolve(vmInput);
        await background.promise;
      });
      expect(status()).toBe("");

      const refreshed = {
        ...vmInput,
        ...(controls ? { viewerControls: controls } : {}),
        progress: {
          ...vmInput.progress,
          checkpoint: {
            ...vmInput.progress.checkpoint,
            checkpointId: replaceCheckpoint
              ? "another-checkpoint"
              : vmInput.progress.checkpoint.checkpointId,
          },
        },
      } satisfies RepositoryWorkflowJob;
      const reply = deferred();
      fixture.call.mockResolvedValue(refreshed).mockReturnValueOnce(reply.promise);
      await press("Refresh run");

      expect(text(currentTask())).toContain(checkpointQuestion);
      expect(text(currentTask())).toContain(checkingAccess);
      expect(text(currentTask())).not.toContain(unconfirmedAccess);
      expect(status()).toBe(checkingAccess);

      // Completing the parent catalog refresh supplies a new object with the same repository scope.
      await act(() => renderer!.update(view("job", false, false, { ...scope })));
      expect(status()).toBe(checkingAccess);

      await act(async () => {
        reply.resolve(refreshed);
        await reply.promise;
      });

      expect(text(currentTask())).not.toContain(checkingAccess);
      expect(status()).toBe(announcement);
      if (controls?.canRespond) {
        expect(findButton("Submit answer")).toBeDefined();
      } else {
        expect(text(currentTask())).toContain(
          controls ? maintainerAnswerRequired : unconfirmedAccess,
        );
        expect(findButton("Submit answer")).toBeUndefined();
      }
      await pollRun();
      expect(status()).toBe("");
    },
  );

  it.each(["input", "request_changes"] as const)(
    "shows the exact submitted %s while waiting and preserves a newer draft after acknowledgement",
    async (operation) => {
      const active = operation === "input" ? inputCheckpoint : review;
      const pending: RepositoryWorkflowJob = {
        ...active,
        responsePending: true,
        pendingResponseOperation: operation,
      };
      const key = workflowSessionKey(scope, job.jobId);
      const submitted = "Use staging first.\nAdd coverage for the retry path.";
      const newerDraft = "A newer draft kept while delivery is pending.";
      fixture.call.mockResolvedValue(active);
      await mount();
      const liveStatus = headerStatus();
      expect(liveStatus).toBeDefined();

      if (operation === "request_changes") {
        await press("Request changes");
        expect(text(currentTask())).toContain("Send feedback");
        expect(text(currentTask())).toContain("Back to review");
      }
      const editor = currentTask().findByType("textarea");
      if (operation === "input") {
        expect(text(currentTask())).toContain(checkpointQuestion);
        expect(text(currentTask())).toContain("Submit answer");
        // An overriding ARIA label would hide the visible question from assistive technology.
        expect(editor.props["aria-label"] ?? checkpointQuestion).toBe(checkpointQuestion);
      }
      await act(() => editor.props.onChange({ target: { value: submitted } }));

      const send = vi.fn().mockResolvedValue(pending);
      fixture.call
        .mockResolvedValue(pending)
        .mockImplementationOnce((request) => request({ respondToWorkflowJob: send }, "token"));
      await submitCheckpoint();
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            checkpointId: "checkpoint",
            expectedRevision: active.progress!.revision,
            operation,
            text: submitted,
          },
        }),
      );

      await act(() => {
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          responses: { ...state.responses, [key]: { checkpoint: newerDraft } },
        }));
      });
      fixture.call.mockResolvedValue({ ...pending, progress: { ...pending.progress! } });
      await pollRun();
      const waiting = text(currentTask());
      expect(headerStatus()).toBe(liveStatus);
      expect(text(liveStatus!)).toMatch(/confirmation|pending/i);
      expect(waiting.match(/Waiting for confirmation/g)).toHaveLength(1);
      const lastSubmitted =
        operation === "input" ? "Your last submitted answer" : "Your last submitted feedback";
      expect(waiting).toContain(lastSubmitted);
      expect(waiting).toContain(submitted);
      expect(waiting).not.toContain(newerDraft);
      expect(currentTask().findAllByType("textarea")).toHaveLength(0);
      expect(findButton("Back to review")).toBeUndefined();
      expect(findButton(operation === "input" ? "Submit answer" : "Send feedback")).toBeUndefined();
      expect(findButton("Open conversation")).toBeDefined();
      if (operation === "request_changes") {
        expect(findButton("Inspect saved diff")).toBeDefined();
        expect(findButton("Approve result")).toBeUndefined();
      }

      // A relay retry can update the job timestamp while the same checkpoint is still waiting.
      fixture.call.mockResolvedValue({
        ...pending,
        updatedAt: "2026-10-28",
        progress: { ...pending.progress! },
      });
      await pollRun();
      expect(text(currentTask())).toContain(lastSubmitted);
      expect(text(currentTask())).toContain(submitted);

      await act(() => renderer!.unmount());
      await mount();
      expect(text(currentTask())).toContain(lastSubmitted);
      expect(text(currentTask())).toContain(submitted);
      expect(text(currentTask())).not.toContain(newerDraft);

      fixture.call.mockResolvedValue({
        ...job,
        progress: {
          ...job.progress!,
          revision: active.progress!.revision + 1,
          checkpoint: null,
          responses: [
            {
              checkpointId: "checkpoint",
              stepId: operation === "input" ? "rollout" : "review",
              generation: 0,
              operation,
              userId: scope.accountId,
              text: submitted,
              createdAt: job.updatedAt,
            },
          ],
        },
      } satisfies RepositoryWorkflowJob);
      await pollRun();

      expect(text(currentTask())).not.toContain("Waiting for confirmation");
      expect(appAtomRegistry.get(workflowDraftAtom).responses[key]?.checkpoint).toBe(newerDraft);
    },
  );

  it.each(["request_changes", undefined] as const)(
    "keeps a failed local draft separate from a pending %s response",
    async (operation) => {
      const pending: RepositoryWorkflowJob = {
        ...review,
        responsePending: true,
        ...(operation === undefined ? {} : { pendingResponseOperation: operation }),
      };
      const key = workflowSessionKey(scope, job.jobId);
      const localDraft = "Private feedback in the unsent draft.";
      fixture.call.mockResolvedValue(review);
      await mount();
      await press("Request changes");
      await act(() =>
        currentTask()
          .findByType("textarea")
          .props.onChange({ target: { value: localDraft } }),
      );
      const reject = vi.fn().mockRejectedValue(new Error("A response is already pending."));
      fixture.call
        .mockResolvedValue(pending)
        .mockImplementationOnce((request) => request({ respondToWorkflowJob: reject }, "token"));
      await submitCheckpoint();
      await pollRun();

      expect(text(currentTask())).toContain("Waiting for confirmation");
      expect(text(currentTask())).not.toMatch(/submitted feedback/i);
      expect(text(currentTask())).not.toContain(localDraft);
      expect(currentTask().findAllByType("textarea")).toHaveLength(0);
      expect(findButton("Send feedback")).toBeUndefined();
      expect(findButton("Copy draft")).toBeDefined();
      expect(text(renderer!.toJSON())).toContain(localDraft);
      expect(appAtomRegistry.get(workflowDraftAtom).responses[key]?.checkpoint).toBe(localDraft);
    },
  );

  it("keeps review feedback reachable during a manual hold and shows the role requirement after access changes", async () => {
    const vmReview: RepositoryWorkflowJob = {
      ...maintainerReview,
      runtime: { kind: "vm", threadId: ThreadId.make("thread") },
      viewerControls: review.viewerControls,
    };
    const paused: RepositoryWorkflowJob = {
      ...vmReview,
      status: "paused",
      progress: {
        ...vmReview.progress!,
        revision: 4,
        status: "paused",
        underlyingStatus: "awaiting_review",
        manualPauseSupported: true,
        manualPause: { state: "paused" },
      },
    };
    fixture.call.mockResolvedValue(vmReview);
    await mount();
    await press("Request changes");
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: "Add a regression test" },
      }),
    );
    await press("Back to review");

    fixture.call.mockResolvedValue(paused);
    await pollRun();

    const draft = renderer!.root
      .findAllByType("details")
      .find((disclosure) => text(disclosure).includes("Feedback draft"));
    expect(draft?.findByType("textarea").props.value).toBe("Add a regression test");
    expect(text(renderer!.toJSON())).toContain("Saved results");
    expect(findButton("Back to review")).toBeUndefined();
    expect(findButton("Send feedback")).toBeUndefined();

    fixture.call.mockResolvedValue({
      ...paused,
      viewerControls: { canApprove: false, canRespond: false, canCancel: true },
    });
    await act(() => renderer!.update(view("job", false)));
    await pollRun();

    const requirement = "Only a repository maintainer can review the result.";
    expect(text(renderer!.toJSON())).toContain(requirement);
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    expect(
      renderer!.root
        .findAllByType("details")
        .some((disclosure) => text(disclosure).includes(requirement)),
    ).toBe(false);
  });

  it("reopens a retained draft for a new checkpoint instead of inheriting the previous Back choice", async () => {
    const key = workflowSessionKey(scope, job.jobId);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { checkpoint: "First draft", next: "Next review feedback" } },
    }));
    fixture.call.mockResolvedValue(review);
    await mount();
    await press("Back to review");
    fixture.call.mockResolvedValue({
      ...review,
      progress: {
        ...review.progress!,
        revision: 4,
        checkpoint: { ...review.progress!.checkpoint!, checkpointId: "next" },
      },
    });
    await press("Refresh run");
    expect(
      renderer!.root
        .findAllByType("textarea")
        .some((node) => node.props.value === "Next review feedback"),
    ).toBe(true);
    expect(appAtomRegistry.get(workflowDraftAtom).responses[key]?.checkpoint).toBe("First draft");
  });
  it.each(["no conflict", "newer draft", "acknowledged response"] as const)(
    "discards only the confirmed draft and guards undo against %s",
    async (stateAtUndo) => {
      const key = workflowSessionKey(scope, job.jobId);
      const original = "Earlier feedback";
      const untouched = { checkpoint: "Current feedback", another: "Another retained draft" };
      const context = {
        workflowName: "Triage",
        stepTitle: "Earlier Review",
        kind: "review",
      } as const;
      const currentDrafts = () => appAtomRegistry.get(workflowDraftAtom).responses[key];
      const earlierContext = () =>
        appAtomRegistry.get(workflowDraftAtom).responseContexts?.[key]?.earlier;
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        responses: { [key]: { ...untouched, earlier: original } },
        responseContexts: { [key]: { earlier: context } },
        submitted: {
          [key]: {
            earlier: {
              checkpointId: "earlier",
              operation: "request_changes",
              userId: scope.accountId,
              text: original,
            },
          },
        },
      }));
      fixture.call.mockResolvedValue(review);
      await mount();
      const reads = fixture.call.mock.calls.length;
      const discardEarlier = async () => {
        const row = renderer!.root
          .findAllByType("p")
          .find((paragraph) => paragraph.children.includes(original))!.parent!;
        await act(() =>
          row
            .findAllByType("button")
            .find((button) => button.children.includes("Discard draft"))!
            .props.onClick(),
        );
      };

      await discardEarlier();
      expect(text(renderer!.toJSON())).toContain("Discard this draft?");
      expect(currentDrafts()).toEqual({ ...untouched, earlier: original });
      await press("Keep draft");
      expect(currentDrafts()).toEqual({ ...untouched, earlier: original });

      await discardEarlier();
      await discardEarlier();
      expect(currentDrafts()).toEqual(untouched);
      expect(earlierContext()).toBeUndefined();
      expect(text(renderer!.toJSON())).toContain("Draft discarded");
      expect(fixture.call).toHaveBeenCalledTimes(reads);

      if (stateAtUndo === "newer draft") {
        await act(() =>
          updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
            ...state,
            responses: { [key]: { ...untouched, earlier: "New feedback" } },
          })),
        );
      } else if (stateAtUndo === "acknowledged response") {
        fixture.call.mockResolvedValue({
          ...review,
          progress: {
            ...review.progress!,
            revision: 4,
            responses: [
              {
                checkpointId: "earlier",
                stepId: "review",
                generation: 0,
                operation: "request_changes",
                userId: scope.accountId,
                text: original,
                createdAt: job.createdAt,
              },
            ],
          },
        });
        await press("Refresh run");
        expect(text(renderer!.toJSON())).toContain("Changes requested");
      }

      await press("Undo");
      expect(currentDrafts()).toEqual(
        stateAtUndo === "acknowledged response"
          ? untouched
          : { ...untouched, earlier: stateAtUndo === "newer draft" ? "New feedback" : original },
      );
      expect(earlierContext()).toEqual(stateAtUndo === "no conflict" ? context : undefined);
    },
  );

  it("expands a long retained draft and copies its exact text from the preview", async () => {
    const key = workflowSessionKey(scope, job.jobId);
    const draft = "First line\rSecond line\rThird line\rFeedback after the preview";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { earlier: draft } },
    }));
    fixture.call.mockResolvedValue(review);
    await mount();

    const content = () => text(renderer!.toJSON());
    expect(content()).toContain("Third line");
    expect(content()).not.toContain("Feedback after the preview");
    await press("Copy draft");
    expect(writeText).toHaveBeenCalledWith(draft);

    await press("Show full draft");
    expect(content()).toContain(draft);
    await press("Show preview");
    expect(content()).not.toContain("Feedback after the preview");
  });

  it("keeps focus on the drafts section when polling removes a row with an unrelated Undo", async () => {
    const key = workflowSessionKey(scope, job.jobId);
    const nextDraft = "Feedback for the next checkpoint";
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      responses: { [key]: { earlier: "Feedback to discard", next: nextDraft } },
    }));
    fixture.call.mockResolvedValue(review);

    const body = {};
    let focused = body;
    const rowActions: object[] = [];
    const ownerDocument = {
      body,
      get activeElement() {
        // A focused control loses DOM focus once its draft row has been removed.
        const content = text(renderer?.toJSON() ?? null);
        if (focused === rowActions[0] && !content.includes("Feedback to discard")) return body;
        if (focused === rowActions[1] && !content.includes(nextDraft)) return body;
        return focused;
      },
    };
    const focusTarget = () => {
      const node = {
        ownerDocument,
        focus() {
          focused = node;
        },
      };
      return node;
    };
    const heading = focusTarget();
    const undo = focusTarget();
    await mount(true, {
      createNodeMock(element) {
        const props = element.props as PropsWithChildren<{ role?: string }>;
        if (element.type === "h2") return heading;
        if (element.type === "button" && props.children === "Undo") return undo;
        if (props.role !== "group") return null;
        const action = {};
        rowActions.push(action);
        return { ownerDocument, contains: (target: unknown) => target === action };
      },
    });
    expect(rowActions).toHaveLength(2);

    await press("Discard draft");
    focused = rowActions[0]!;
    await press("Discard draft");
    expect(ownerDocument.activeElement).toBe(undo);
    focused = rowActions[1]!;

    fixture.call.mockResolvedValue({
      ...review,
      progress: {
        ...review.progress!,
        revision: 4,
        checkpoint: { ...review.progress!.checkpoint!, checkpointId: "next" },
      },
    });
    await pollRun();

    expect(findButton("Undo")).toBeDefined();
    expect(renderer!.root.findByType("textarea").props.value).toBe(nextDraft);
    expect(ownerDocument.activeElement).toBe(heading);
  });

  it("shows capture progress and preserves focus when an automatic VM start is refused", async () => {
    const preparing: RepositoryWorkflowJob = {
      ...job,
      status: "preparing",
      runtime: { kind: "vm", threadId: ThreadId.make("workflow-vm") },
      progress: null,
      startAttempted: false,
      origin: {
        kind: "automation",
        organizationId: "org",
        repositoryId: "repo",
        workflowId: "workflow",
        source: {
          provider: "linear",
          applicationId: "app",
          workspaceId: "workspace",
          connectionId: "connection",
          grantId: "grant",
        },
        occurrenceId: "event",
      },
      event: {
        issueId: "issue",
        teamId: "team",
        stateId: "ready",
        labelIds: [],
        identifier: "ENG-284",
        title: "Title from the trigger",
        url: "https://linear.app/example/issue/ENG-284",
        occurredAt: job.createdAt,
        issueUpdatedAt: job.createdAt,
      },
    };
    const body = {};
    let focused = body;
    const ownerDocument = {
      body,
      get activeElement() {
        const content = text(renderer?.toJSON() ?? null);
        return focused === disclosure && !content.includes("Saved issue details") ? body : focused;
      },
    };
    const disclosure = { ownerDocument };
    const heading = {
      ownerDocument,
      focus() {
        focused = heading;
      },
    };
    fixture.call.mockResolvedValue(preparing);
    await mount(true, {
      createNodeMock(element) {
        if (element.type === "h2") return heading;
        if (element.type === "summary") return disclosure;
        return null;
      },
    });

    const content = () => text(renderer!.toJSON());
    const issueStatus = () =>
      renderer!.root.findByProps({ "aria-label": "Linear issue" }).findByProps({ role: "status" });
    const initialStatus = issueStatus();
    expect(initialStatus.children).toEqual(["Waiting to capture Linear issue details"]);
    expect(content()).toContain("Title from the trigger");
    expect(content()).toContain("Waiting to capture");
    expect(content()).not.toContain("Run instructions");

    fixture.call.mockResolvedValue({
      ...preparing,
      startAttempted: true,
      issueSnapshot: {
        workspaceId: "workspace",
        issueId: "issue",
        identifier: "ENG-284",
        title: "Title captured before execution",
        url: "https://linear.app/example/issue/ENG-284",
        description: "Saved requirements",
        team: { id: "team", name: "Engineering" },
        status: { id: "ready", name: "Ready" },
        labels: [],
        issueUpdatedAt: job.createdAt,
        retrievedAt: "2026-10-27T13:32:00.000Z",
        authorizationEpoch: 1,
        credentialVersion: 1,
      },
    });
    await press("Refresh run");

    expect(issueStatus()).toBe(initialStatus);
    expect(issueStatus().children).toEqual(["Linear issue snapshot saved"]);
    expect(content()).toContain("Title captured before execution");
    expect(content()).toContain("Saved for this run");
    expect(content()).toContain("Saved issue details");
    expect(content()).not.toContain("Waiting to capture");
    expect(content()).not.toContain("Title from the trigger");

    focused = disclosure;
    fixture.call.mockResolvedValue(preparing);
    await pollRun();

    expect(content()).toContain("Waiting to capture");
    expect(content()).not.toContain("Saved issue details");
    expect(issueStatus().children).toEqual(["Waiting to capture Linear issue details"]);
    expect(ownerDocument.activeElement).toBe(heading);
  });

  it("keeps the generic waiting state and relay detail for other queue reasons", async () => {
    fixture.call.mockResolvedValue({
      ...job,
      status: "queued",
      progress: null,
      workflow: null,
      detail: "The machine is offline.",
      queueReason: { code: "environment_offline", retryAt: null },
    });
    await mount();
    const content = text(renderer!.toJSON());
    expect(content).toContain("Waiting for execution");
    expect(content).toContain("No steps have started");
    expect(content).toContain("The machine is offline.");
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Run progress"),
    ).toHaveLength(0);
  });

  it("labels capped checkpoint history and distinguishes response previews", async () => {
    const preview = "x".repeat(500);
    fixture.call.mockResolvedValue({
      ...job,
      progress: {
        ...job.progress!,
        responses: Array.from({ length: 100 }, (_, index) => ({
          checkpointId: `checkpoint-${index}`,
          stepId: "review",
          generation: index,
          operation: "request_changes",
          userId: scope.accountId,
          text: index === 99 ? preview : `Response ${index + 1}`,
          createdAt: job.createdAt,
        })),
      },
    });
    await mount();

    const content = text(renderer!.toJSON());
    expect(content).toMatch(/100\s+recent responses/);
    expect(content).toContain("Response 99");
    expect(content).toContain(preview);
    expect(content.match(/Response preview/g)).toEqual(["Response preview"]);
  });
});

describe("workflow run outcomes", () => {
  const workflow: NonNullable<RepositoryWorkflowJob["workflow"]> = {
    workflowId: job.workflowId,
    repositoryId: job.repositoryId,
    organizationId: scope.organizationId,
    archived: false,
    revision: 1,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    definition: {
      name: "Reviewed implementation",
      target: {
        kind: "machine",
        environmentId: EnvironmentId.make("original"),
        projectId: ProjectId.make("project"),
      },
      steps: [
        {
          id: "agent",
          title: "Agent",
          kind: "agent",
          instruction: "Implement",
          modelSelection: null,
        },
        { id: "push", title: "Push branch", kind: "action", action: "push" },
      ],
    },
  };

  it("updates the ordered progress rows as a run moves through checkpoints and fails", async () => {
    const runWorkflow = {
      ...workflow,
      definition: {
        ...workflow.definition,
        steps: [
          workflow.definition.steps[0]!,
          {
            id: "scope",
            title: "Confirm rollout scope",
            kind: "input",
            question: "Which rollout scope should we use?",
            role: "member",
          },
          { id: "review", title: "Review changes", kind: "review", role: "member" },
          {
            id: "prepare",
            title: "Prepare publishing",
            kind: "agent",
            instruction: "Prepare the reviewed change for publishing",
            modelSelection: null,
          },
          workflow.definition.steps[1]!,
          { id: "pr", title: "Open PR", kind: "action", action: "open_pull_request" },
        ],
      },
    } satisfies NonNullable<RepositoryWorkflowJob["workflow"]>;
    const phases = [
      {
        status: "awaiting_input",
        completed: 1,
        rowStatus: "waiting",
        label: "Waiting for input",
        summary: "Confirm rollout scope needs an answer",
        checkpoint: {
          kind: "input",
          checkpointId: "scope-checkpoint",
          stepId: "scope",
          generation: 0,
          role: "member",
          question: "Which rollout scope should we use?",
        },
      },
      {
        status: "awaiting_review",
        completed: 2,
        rowStatus: "waiting",
        label: "Waiting for review",
        summary: "Review changes needs a decision",
        checkpoint: {
          ...job.progress!.checkpoint!,
          stepId: "review",
          generation: 0,
          role: "member",
        },
      },
      {
        status: "running",
        completed: 3,
        rowStatus: "running",
        label: "Running",
        summary: "Prepare publishing is running",
        checkpoint: null,
      },
      {
        status: "running",
        completed: 4,
        rowStatus: "running",
        label: "Running",
        summary: "Push branch is running",
        checkpoint: null,
      },
      {
        status: "failed",
        completed: 4,
        rowStatus: "pending",
        label: "Failed",
        summary: "Failed at Push branch",
        checkpoint: null,
      },
    ] as const;

    let liveProgress: ReactTestInstance | undefined;
    for (const [index, phase] of phases.entries()) {
      const { completed, status } = phase;
      const stepId = runWorkflow.definition.steps[completed]!.id;
      fixture.call.mockResolvedValue({
        ...job,
        workflow: runWorkflow,
        status,
        progress: {
          ...job.progress!,
          revision: job.progress!.revision + index,
          status,
          stepId: status === "awaiting_review" ? undefined : stepId,
          checkpoint: phase.checkpoint,
          steps: runWorkflow.definition.steps.map((step, stepIndex) => ({
            stepId: step.id,
            generation: 0,
            status:
              stepIndex < completed
                ? "completed"
                : step.id === stepId
                  ? phase.rowStatus
                  : "pending",
          })),
        },
      } satisfies RepositoryWorkflowJob);
      if (index === 0) await mount();
      else await pollRun();

      const progress = renderer!.root.findByProps({ "aria-label": "Run progress" });
      const summary = text(progress.findByType("summary")).replace(/\s+/g, " ");
      const count = `${completed} of ${runWorkflow.definition.steps.length} steps complete`;
      expect(summary).toContain(count);
      expect(summary).toContain(phase.summary);
      const currentAnnouncement = progress.parent!.findByProps({ role: "status" });
      expect(currentAnnouncement.parent).toBe(progress.parent);
      liveProgress ??= currentAnnouncement;
      expect(currentAnnouncement).toBe(liveProgress);
      const announcement = text(currentAnnouncement).replace(/\s+/g, " ");
      expect(announcement).toContain(count);
      expect(announcement).toContain(phase.summary);
      const rows = progress.findByProps({ "aria-label": "Workflow steps" }).findAllByType("li");
      expect(rows).toHaveLength(runWorkflow.definition.steps.length);
      for (const [stepIndex, step] of runWorkflow.definition.steps.entries()) {
        const row = text(rows[stepIndex]!);
        expect(row).toContain(step.title);
        expect(row).toContain(
          stepIndex < completed
            ? "Completed"
            : stepIndex === completed
              ? phase.label
              : status === "failed"
                ? "Not reached"
                : "Upcoming",
        );
      }
      const activeRows = progress.findAllByProps({ "aria-current": "step" });
      expect(activeRows).toEqual(status === "failed" ? [] : [rows[completed]]);
    }
  });

  it("does not infer a completion count or current step from missing legacy progress", async () => {
    fixture.call.mockResolvedValue({
      ...job,
      workflow,
      status: "running",
      progress: { ...job.progress!, status: "running", checkpoint: null },
    } satisfies RepositoryWorkflowJob);
    await mount();

    const progress = renderer!.root.findByProps({ "aria-label": "Run progress" });
    expect(text(progress.findByType("summary"))).not.toMatch(/steps complete/);
    expect(progress.findAllByProps({ "aria-current": "step" })).toHaveLength(0);
  });

  const reviewWorkflow = {
    ...workflow,
    definition: {
      ...workflow.definition,
      steps: [
        workflow.definition.steps[0]!,
        { id: "review", title: "Review changes", kind: "review", role: "member" },
      ],
    },
  } satisfies NonNullable<RepositoryWorkflowJob["workflow"]>;
  const awaitingReview = {
    ...job,
    workflow: reviewWorkflow,
    status: "awaiting_review",
    progress: {
      ...job.progress!,
      status: "awaiting_review",
      stepId: "review",
      checkpoint: {
        kind: "review",
        checkpointId: "checkpoint",
        turnId: "saved-turn",
        checkpointRef: "ref",
        checkpointTurnCount: 3,
        stepId: "review",
      },
      steps: [
        { stepId: "agent", generation: 0, status: "completed" },
        { stepId: "review", generation: 0, status: "waiting" },
      ],
    },
  } satisfies RepositoryWorkflowJob;
  const vmAwaitingReview = {
    ...awaitingReview,
    runtime: { kind: "vm", threadId: awaitingReview.progress.threadId },
    workflow: {
      ...reviewWorkflow,
      definition: {
        ...reviewWorkflow.definition,
        target: { kind: "vm", baseBranch: "main" },
      },
    },
  } satisfies RepositoryWorkflowJob;
  const savingAgentResult = (state: "saving" | "failed") =>
    ({
      ...vmAwaitingReview,
      progress: {
        ...vmAwaitingReview.progress,
        stepId: "agent",
        checkpoint: { ...awaitingReview.progress.checkpoint, stepId: "agent" },
        hasThread: true,
        resultSaving: {
          publicationId: "c5540cf3-802e-41c9-b6b6-832d2f6ba867",
          resultId: "11111111-1111-4111-8111-111111111111",
          stepId: "agent",
          state,
          detail: null,
          retryable: state === "failed",
        },
        steps: [
          { stepId: "agent", generation: 0, status: "waiting" },
          { stepId: "review", generation: 0, status: "pending" },
        ],
      },
    }) satisfies RepositoryWorkflowJob;
  const finishing = (needsRetry: boolean) =>
    ({
      ...awaitingReview,
      status: "awaiting_review",
      progress: {
        ...awaitingReview.progress,
        stepId: undefined,
        approvalPending: !needsRetry,
        retryableApproval: needsRetry,
        steps: [
          { stepId: "agent", generation: 0, status: "completed" },
          { stepId: "review", generation: 0, status: "completed" },
        ],
      },
    }) satisfies RepositoryWorkflowJob;

  const currentRunTask = () =>
    renderer!.root
      .findAllByType("section")
      .find((section) => section.props["aria-label"] === "Current workflow task")!;

  const preparationFailure = {
    ...job,
    workflow,
    status: "paused",
    progress: {
      ...job.progress!,
      revision: 17,
      status: "paused",
      underlyingStatus: "paused",
      detail: "The workspace setup command exited with code 1.",
      checkpoint: null,
      stepId: "agent",
      generation: 0,
      retryablePreparation: true,
      manualPauseSupported: true,
      steps: [
        { stepId: "agent", generation: 0, status: "waiting" },
        { stepId: "push", generation: 0, status: "pending" },
      ],
    },
  } satisfies RepositoryWorkflowJob;

  it("retries the current preparation and distinguishes local, relay, and executor states", async () => {
    fixture.call.mockResolvedValue(preparationFailure);
    await mount();

    const runStatus = () => renderer!.root.findByType("header").findByProps({ role: "status" });
    const statusRegion = runStatus();
    expect(text(statusRegion)).toContain("Couldn’t prepare the workspace");
    expect(text(currentRunTask())).toContain(preparationFailure.progress.detail);
    expect(currentRunTask().findAllByType("button")).toContain(findButton("Retry preparation"));

    const requested = {
      ...preparationFailure,
      detail: "Response saved; waiting for the environment.",
      responsePending: true,
    } satisfies RepositoryWorkflowJob;
    const reply = deferred();
    const retry = vi.fn().mockReturnValue(reply.promise);
    fixture.call
      .mockResolvedValue(requested)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: retry }, "token"));
    await press("Retry preparation");

    expect(text(currentRunTask())).toContain("Requesting retry…");
    expect(runStatus()).toBe(statusRegion);
    expect(text(runStatus())).toContain("Requesting retry…");
    expect(findButton("Retry preparation")).toBeUndefined();
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "token",
      repositoryId: scope.repositoryId,
      jobId: job.jobId,
      payload: {
        operation: "retry_preparation",
        expectedRevision: preparationFailure.progress.revision,
      },
    });
    await act(async () => {
      reply.resolve(requested);
      await reply.promise;
    });
    expect(text(currentRunTask())).toContain("Retry requested");
    expect(runStatus()).toBe(statusRegion);
    expect(text(runStatus())).toContain("Retry requested");
    expect(text(currentRunTask())).not.toContain("Requesting retry…");
    expect(findButton("Retry preparation")).toBeUndefined();

    fixture.call.mockResolvedValue({
      ...preparationFailure,
      status: "preparing",
      progress: {
        ...preparationFailure.progress,
        status: "preparing",
        underlyingStatus: "preparing",
        revision: 18,
        detail: null,
        retryablePreparation: false,
        steps: [
          { stepId: "agent", generation: 0, status: "running" },
          { stepId: "push", generation: 0, status: "pending" },
        ],
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();

    expect(text(currentRunTask())).toContain("Preparing the workspace");
    expect(text(currentRunTask())).not.toContain("Retry requested");
    expect(text(currentRunTask())).not.toContain(preparationFailure.progress.detail);
    expect(findButton("Retry preparation")).toBeUndefined();
  });

  it("shows preparation errors to viewers and keeps manual pause ahead of recovery", async () => {
    fixture.call.mockResolvedValue(preparationFailure);
    await mount(false);
    expect(text(currentRunTask())).toContain("Couldn’t prepare the workspace");
    expect(text(currentRunTask())).toContain(preparationFailure.progress.detail);
    expect(findButton("Retry preparation")).toBeUndefined();

    await act(() => renderer!.update(view()));
    fixture.call.mockResolvedValue({
      ...preparationFailure,
      responsePending: true,
      pendingManualControl: {
        operation: "pause",
        controlId: "pause-during-preparation",
        expectedRevision: preparationFailure.progress.revision,
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(renderer!.toJSON())).toContain("Pause requested");
    expect(text(currentRunTask())).not.toContain("Retry requested");

    fixture.call.mockResolvedValue({
      ...preparationFailure,
      progress: {
        ...preparationFailure.progress,
        revision: 18,
        manualPause: { state: "requested" },
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(findButton("Resume workflow")).toBeDefined();
    expect(findButton("Retry preparation")).toBeUndefined();
    expect(text(currentRunTask())).not.toContain("Retry requested");
  });

  it("keeps VM preparation retry available alongside independent result storage", async () => {
    const vmFailure = {
      ...preparationFailure,
      runtime: { kind: "vm", threadId: preparationFailure.progress.threadId },
      workflow: {
        ...workflow,
        definition: {
          ...workflow.definition,
          target: { kind: "vm", baseBranch: "main" },
          steps: [workflow.definition.steps[0]!],
        },
      },
      progress: {
        ...preparationFailure.progress,
        steps: [preparationFailure.progress.steps[0]!],
      },
    } satisfies RepositoryWorkflowJob;
    const publication = {
      publicationId: "c5540cf3-802e-41c9-b6b6-832d2f6ba867",
      resultId: null,
    };
    const saving = {
      ...vmFailure,
      progress: {
        ...vmFailure.progress,
        resultSaving: { ...publication, state: "saving", retryable: false, detail: null },
      },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(saving);
    await mount();

    expect(text(currentRunTask())).toContain("Couldn’t prepare the workspace");
    expect(text(renderer!.toJSON())).toContain("Saving run state");
    expect(findButton("Retry preparation").props.disabled).not.toBe(true);

    const failed = {
      ...vmFailure,
      progress: {
        ...vmFailure.progress,
        revision: 18,
        resultSaving: {
          ...publication,
          state: "failed",
          retryable: true,
          detail: "Storage offline",
        },
      },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(failed);
    await pollRun();
    expect(text(currentRunTask())).toContain(preparationFailure.progress.detail);
    expect(text(renderer!.root.findByType("header").findByProps({ role: "status" }))).toContain(
      "Couldn’t save run state",
    );
    expect(findButton("Retry preparation").props.disabled).not.toBe(true);
    expect(findButton("Retry saving")).toBeDefined();

    fixture.call.mockResolvedValue({
      ...failed,
      responsePending: true,
      resultSaveRetryPending: true,
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).not.toContain("Retry requested");
    expect(text(renderer!.toJSON())).toContain("Waiting for retry confirmation");
    const retry = findButton("Retry preparation");
    expect(!retry || retry.props.disabled || retry.props["aria-disabled"]).toBe(true);

    fixture.call.mockResolvedValue({
      ...failed,
      responsePending: true,
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).toContain("Waiting for confirmation");
    expect(text(currentRunTask())).not.toContain("Retry requested");
    expect(findButton("Retry preparation").props.disabled).toBe(true);
  });

  it("shows the first setup before any steps and names the current Agent on later preparation", async () => {
    const firstPreparation = {
      ...preparationFailure,
      status: "preparing",
      progress: {
        ...preparationFailure.progress,
        status: "preparing",
        underlyingStatus: "preparing",
        detail: null,
        hasThread: true,
        retryablePreparation: false,
        steps: [
          { stepId: "agent", generation: 0, status: "running" },
          { stepId: "push", generation: 0, status: "pending" },
        ],
      },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(firstPreparation);
    await mount();

    const progressPanel = () => renderer!.root.findByProps({ "aria-label": "Run progress" });
    const progressSummary = () => text(progressPanel().findByType("summary"));
    expect(progressSummary()).toContain("No steps started");
    expect(progressPanel().findAllByProps({ "aria-current": "step" })).toHaveLength(0);

    fixture.call.mockResolvedValue({
      ...preparationFailure,
      progress: { ...preparationFailure.progress, revision: 18, hasThread: true },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(progressSummary()).toContain("No steps started");

    fixture.call.mockResolvedValue({
      ...firstPreparation,
      progress: { ...firstPreparation.progress, revision: 19, steps: undefined },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(progressSummary()).not.toContain("No steps started");

    fixture.call.mockResolvedValue({
      ...firstPreparation,
      workflow: {
        ...workflow,
        definition: {
          ...workflow.definition,
          steps: [
            {
              id: "scope",
              title: "Set scope",
              kind: "input",
              question: "Which scope?",
              role: "member",
            },
            workflow.definition.steps[0]!,
          ],
        },
      },
      progress: {
        ...firstPreparation.progress,
        revision: 20,
        steps: [
          { stepId: "scope", generation: 0, status: "completed" },
          { stepId: "agent", generation: 0, status: "running" },
        ],
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).toContain("Preparing the workspace");
    expect(progressSummary()).toContain("1 of 2 steps complete");

    const laterAgent = {
      id: "verify",
      title: "Verify deployment",
      kind: "agent",
      instruction: "Check the deployed result.",
      modelSelection: null,
    } as const;
    fixture.call.mockResolvedValue({
      ...firstPreparation,
      workflow: {
        ...workflow,
        definition: {
          ...workflow.definition,
          steps: [workflow.definition.steps[0]!, laterAgent],
        },
      },
      progress: {
        ...firstPreparation.progress,
        revision: 21,
        stepId: laterAgent.id,
        steps: [
          { stepId: "agent", generation: 0, status: "completed" },
          { stepId: laterAgent.id, generation: 0, status: "running" },
        ],
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).toContain(`Preparing “${laterAgent.title}”`);
    expect(progressSummary()).toContain("1 of 2 steps complete");
    expect(progressSummary()).not.toContain("No steps started");

    fixture.call.mockResolvedValue({
      ...firstPreparation,
      progress: {
        ...firstPreparation.progress,
        revision: 22,
        generation: 1,
        steps: firstPreparation.progress.steps.map((step) => ({ ...step, generation: 1 })),
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).not.toContain("Preparing the workspace");
    expect(progressSummary()).not.toContain("No steps started");
  });

  it("shows the saved-result blocker and lets only maintainers retry the current publication", async () => {
    const saving = savingAgentResult("saving");
    const failedResult = savingAgentResult("failed");
    const failed = {
      ...failedResult,
      progress: {
        ...failedResult.progress,
        revision: 9,
        manualPauseSupported: true,
        resultSaving: {
          ...failedResult.progress.resultSaving,
          publicationId: "84cb8223-35eb-4105-88d6-6a19f293e311",
          detail: "The result store could not confirm the write.",
        },
      },
    } satisfies RepositoryWorkflowJob;
    fixture.call.mockResolvedValue(saving);
    await mount(false);

    expect(text(currentRunTask())).toContain("Saving step result");
    expect(text(currentRunTask())).toContain("Agent");
    expect(text(currentRunTask())).toContain("Review changes");
    expect(findButton("Retry saving")).toBeUndefined();

    fixture.call.mockResolvedValue(failed);
    await pollRun();
    expect(text(currentRunTask())).toContain("Couldn’t save step result");
    expect(text(currentRunTask())).toContain("The result store could not confirm the write.");
    expect(text(currentRunTask())).toContain("Agent");
    expect(text(currentRunTask())).toContain("Review changes");
    expect(findButton("Retry saving")).toBeUndefined();
    expect(findButton("Approve result")).toBeUndefined();
    expect(findButton("Request changes")).toBeUndefined();
    expect(renderer!.root.findByType(SavedWorkflowResults)).toBeDefined();

    await act(() => renderer!.update(view()));
    await press("Run controls");
    expect(findButton("Pause at this checkpoint")).toBeDefined();
    expect(findButton("Pause after current step")).toBeUndefined();
    await press("Run controls");

    fixture.call.mockResolvedValue({
      ...failed,
      responsePending: true,
      pendingManualControl: {
        operation: "pause",
        controlId: "pause",
        expectedRevision: failed.progress.revision,
      },
    } satisfies RepositoryWorkflowJob);
    await pollRun();
    expect(text(currentRunTask())).toContain("Couldn’t save step result");
    expect(text(currentRunTask())).toContain("Pause requested");
    expect(text(currentRunTask())).not.toContain("Waiting for retry confirmation");
    expect(findButton("Retrying…")).toBeUndefined();

    fixture.call.mockResolvedValue(failed);
    await pollRun();
    const queued = {
      ...failed,
      responsePending: true,
      resultSaveRetryPending: true,
    } satisfies RepositoryWorkflowJob;
    const retrying = {
      ...failed,
      progress: {
        ...failed.progress,
        revision: 10,
        resultSaving: {
          ...failed.progress.resultSaving,
          state: "saving",
          detail: null,
          retryable: false,
        },
      },
    } satisfies RepositoryWorkflowJob;
    const reply = deferred();
    const retry = vi.fn().mockReturnValue(reply.promise);
    fixture.call
      .mockResolvedValue(queued)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: retry }, "token"));
    await press("Retry saving");

    expect(findButton("Retrying…").props["aria-disabled"]).toBe(true);
    await press("Retrying…");
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "token",
      repositoryId: scope.repositoryId,
      jobId: job.jobId,
      payload: {
        operation: "retry_saving",
        publicationId: failed.progress.resultSaving.publicationId,
        expectedRevision: failed.progress.revision,
      },
    });
    await act(async () => {
      reply.resolve(queued);
      await reply.promise;
    });
    expect(text(currentRunTask())).toContain("Waiting for retry confirmation");
    expect(findButton("Retry saving")).toBeUndefined();
    expect(findButton("Retrying…").props["aria-disabled"]).toBe(true);
    await press("Retrying…");
    expect(retry).toHaveBeenCalledOnce();

    fixture.call.mockResolvedValue(retrying);
    await pollRun();
    expect(text(currentRunTask())).toContain("Saving step result");
    expect(findButton("Retrying…")).toBeUndefined();
  });

  it.each([
    ["saving", "Saving run state"],
    ["failed", "Couldn’t save run state"],
  ] as const)("labels %s metadata without claiming the Agent finished", async (state, title) => {
    const publication = savingAgentResult(state);
    fixture.call.mockResolvedValue({
      ...publication,
      status: "running",
      progress: {
        ...publication.progress,
        status: "running",
        checkpoint: null,
        resultSaving: {
          publicationId: publication.progress.resultSaving.publicationId,
          resultId: null,
          state,
          detail: null,
          retryable: state === "failed",
        },
        steps: [
          { stepId: "agent", generation: 0, status: "running" },
          { stepId: "review", generation: 0, status: "pending" },
        ],
      },
    } satisfies RepositoryWorkflowJob);
    await mount();

    const task = text(currentRunTask());
    expect(task).toContain(title);
    expect(task).not.toMatch(/step finished|waiting for this result|starts once the result/);
    expect(Boolean(findButton("Retry saving"))).toBe(state === "failed");
  });

  it.each(["finishing", "awaiting_review"] as const)(
    "retries completion from %s without reopening the finished review",
    async (status) => {
      const finalizing = finishing(true);
      const blocked = {
        ...finalizing,
        status,
        progress: {
          ...finalizing.progress,
          revision: 12,
          status,
          detail: "The environment couldn’t verify the final result.",
        },
      } satisfies RepositoryWorkflowJob;
      fixture.call.mockResolvedValue(blocked);
      await mount();

      const task = text(currentRunTask());
      expect(task).toContain("Completion blocked");
      expect(task).toMatch(/2 of 2 steps (?:finished|complete)/);
      expect(task).toContain("The environment couldn’t verify the final result.");
      expect(findButton("Request changes")).toBeUndefined();
      expect(findButton("Approve result")).toBeUndefined();
      expect(findButton("Retry approval")).toBeUndefined();
      expect(findButton("Inspect saved diff").props.disabled).not.toBe(true);
      expect(findButton("Open conversation").props.disabled).not.toBe(true);

      const pending = {
        ...blocked,
        responsePending: true,
        pendingResponseOperation: "approve",
        progress: { ...blocked.progress, revision: 13, approvalPending: true },
      } satisfies RepositoryWorkflowJob;
      const retry = vi.fn().mockResolvedValue(pending);
      fixture.call
        .mockResolvedValue(pending)
        .mockImplementationOnce((request) => request({ respondToWorkflowJob: retry }, "token"));
      await press("Retry completion");

      expect(retry).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "token",
        repositoryId: scope.repositoryId,
        jobId: job.jobId,
        payload: {
          operation: "approve",
          checkpointId: blocked.progress.checkpoint.checkpointId,
          expectedRevision: blocked.progress.revision,
        },
      });
      expect(text(currentRunTask())).not.toContain("Completion blocked");
      expect(text(currentRunTask())).toContain("Finishing run");
      expect(findButton("Retry completion")).toBeUndefined();
      expect(findButton("Request changes")).toBeUndefined();
      expect(findButton("Approve result")).toBeUndefined();
    },
  );

  it("keeps a relay reconnect reason visible during final verification", async () => {
    const reconnect = "Waiting for the selected environment to reconnect or acknowledge the job.";
    fixture.call.mockResolvedValue({ ...finishing(false), detail: reconnect });
    await mount();

    expect(text(currentRunTask())).toContain("Finishing run");
    expect(text(currentRunTask())).toContain(reconnect);
    expect(findButton("Retry completion")).toBeUndefined();
  });

  it.each([
    [false, "The saved review changed. Cancel the job and run it again."],
    [true, "The saved workflow checkpoint is unavailable. Cancel the run and start again."],
    [true, "The VM no longer owns this workflow. Cancel the run."],
  ] as const)(
    "hides completion retry for a cancel-only outcome with retryableApproval=%s",
    async (retryableApproval, stop) => {
      const finishingRun = finishing(false);
      fixture.call.mockResolvedValue({
        ...finishingRun,
        status: "finishing",
        progress: {
          ...finishingRun.progress,
          status: "finishing",
          approvalPending: false,
          retryableApproval,
          detail: stop,
        },
      } satisfies RepositoryWorkflowJob);
      await mount();

      expect(text(currentRunTask())).toContain("Completion blocked");
      expect(text(currentRunTask())).toContain(stop);
      expect(findButton("Retry completion")).toBeUndefined();
      expect(findButton("Request changes")).toBeUndefined();
    },
  );

  it("does not treat a partially recorded review as finished", async () => {
    fixture.call.mockResolvedValue({
      ...awaitingReview,
      progress: {
        ...awaitingReview.progress,
        retryableApproval: true,
        steps: [awaitingReview.progress.steps[0]!],
      },
    } satisfies RepositoryWorkflowJob);
    await mount();

    expect(text(currentRunTask())).not.toContain("Completion blocked");
    expect(findButton("Retry completion")).toBeUndefined();
    expect(findButton("Retry approval")).toBeDefined();
  });

  it.each([
    [
      "Pause requested",
      {
        ...awaitingReview,
        responsePending: true,
        pendingManualControl: { operation: "pause", controlId: "pause", expectedRevision: 3 },
      },
    ],
    [
      "Resume requested",
      {
        ...awaitingReview,
        status: "paused",
        pendingManualControl: { operation: "resume", controlId: "resume", expectedRevision: 3 },
        progress: {
          ...awaitingReview.progress,
          status: "paused",
          underlyingStatus: "awaiting_review",
          manualPause: { state: "paused" },
        },
      },
    ],
    ["Saving step result", savingAgentResult("saving"), "Agent"],
    ["Couldn’t save step result", savingAgentResult("failed"), "Agent"],
    [
      "Workflow VM recovery needs attention",
      { ...vmAwaitingReview, vmRecovery: { state: "recovery_error" } },
    ],
    ["Finishing", finishing(false)],
    ["Completion blocked", finishing(true)],
    [
      "Finishing",
      { ...finishing(true), responsePending: true, pendingResponseOperation: "approve" },
    ],
  ] satisfies readonly (readonly [string, RepositoryWorkflowJob, string?])[])(
    "shows %s in workflow progress",
    async (label, run, activeStep?: string) => {
      fixture.call.mockResolvedValue(run);
      await mount();

      const progress = renderer!.root.findByProps({ "aria-label": "Run progress" });
      const summary = text(progress.findByType("summary"));
      expect(summary).toContain(label);
      expect(summary).not.toContain("needs a decision");
      if (activeStep) {
        const current = progress.findByProps({ "aria-current": "step" });
        expect(text(current)).toContain(activeStep);
        expect(text(current)).toContain(label);
      }
    },
  );

  it("labels later steps as not reached on this attempt after a rework failure", async () => {
    fixture.call.mockResolvedValue({
      ...awaitingReview,
      status: "failed",
      progress: {
        ...awaitingReview.progress,
        status: "failed",
        checkpoint: null,
        stepId: "agent",
        generation: 1,
        hasThread: true,
        steps: [
          { stepId: "agent", generation: 1, status: "pending" },
          { stepId: "review", generation: 1, status: "pending" },
        ],
        responses: [
          {
            checkpointId: "first-review",
            stepId: "review",
            generation: 0,
            operation: "request_changes",
            userId: scope.accountId,
            text: "Refine the implementation",
            createdAt: job.createdAt,
          },
        ],
      },
    } satisfies RepositoryWorkflowJob);
    await mount();

    const progress = renderer!.root.findByProps({ "aria-label": "Run progress" });
    const [agent, review] = progress
      .findByProps({ "aria-label": "Workflow steps" })
      .findAllByType("li");
    expect(text(agent!)).toContain("Failed");
    expect(text(review!)).toContain("Not reached on this attempt");
  });

  it("marks later steps not reached when cancellation precedes the first Agent", async () => {
    fixture.call.mockResolvedValue({
      ...awaitingReview,
      status: "cancelled",
      progress: {
        ...awaitingReview.progress,
        status: "cancelled",
        checkpoint: null,
        stepId: "agent",
        hasThread: false,
        steps: reviewWorkflow.definition.steps.map((step) => ({
          stepId: step.id,
          generation: 0,
          status: "pending",
        })),
      },
    } satisfies RepositoryWorkflowJob);
    await mount();

    const progress = renderer!.root.findByProps({ "aria-label": "Run progress" });
    expect(text(progress.findByType("summary"))).toContain("Canceled");
    expect(text(progress.findByType("summary"))).not.toContain("Canceled at");
    expect(text(progress.findAllByType("li")[1]!)).toContain("Not reached");
  });

  const publishingFailure = (state: "failed" | "uncertain"): RepositoryWorkflowJob => ({
    ...job,
    workflow,
    status: "paused",
    detail: "The remote is unavailable.",
    progress: {
      ...job.progress!,
      status: "paused",
      checkpoint: null,
      stepId: "push",
      generation: 2,
      actions: [
        {
          actionId: "push-attempt",
          stepId: "push",
          operation: "push",
          generation: 2,
          state,
          detail: "The remote stopped responding.",
          commitSha: null,
          pullRequestUrl: null,
          retryable: true,
        },
      ],
    },
  });

  it("offers the failed step's conversation from the outcome", async () => {
    fixture.call.mockResolvedValue({
      ...job,
      workflow,
      status: "failed",
      detail: "The provider connection closed.",
      progress: {
        ...job.progress!,
        status: "failed",
        checkpoint: null,
        stepId: "agent",
        hasThread: true,
      },
    } satisfies RepositoryWorkflowJob);
    await mount(false);

    const content = text(renderer!.toJSON());
    expect(content).toContain("Agent failed");
    expect(content).toContain("The provider connection closed.");
    expect(content.match(/Back to runs/g)).toHaveLength(1);
    await press("Open conversation");

    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.navigate.mock.calls[0]![0].state({}).workflowOrigin.jobId).toBe(job.jobId);
  });

  it.each([
    ["failed", "Couldn’t push branch"],
    ["uncertain", "Couldn’t confirm the branch push"],
  ] as const)(
    "retries the exact %s publishing action only for maintainers",
    async (state, title) => {
      const paused = publishingFailure(state);
      fixture.call.mockResolvedValue(paused);
      await mount(false);

      expect(text(renderer!.toJSON())).toContain(title);
      expect(text(renderer!.toJSON())).not.toContain("Retry publishing action");
      await act(() => renderer!.update(view("job", true)));
      expect(text(renderer!.toJSON())).toContain("The remote is unavailable.");
      expect(text(renderer!.toJSON())).not.toContain("The remote stopped responding.");

      const resumed: RepositoryWorkflowJob = {
        ...paused,
        status: "running",
        progress: { ...paused.progress!, status: "running", revision: 4 },
      };
      const reply = deferred();
      const retry = vi.fn().mockReturnValue(reply.promise);
      fixture.call
        .mockResolvedValue(resumed)
        .mockImplementationOnce((request) => request({ respondToWorkflowJob: retry }, "token"));
      await press("Retry publishing action");

      expect(retry).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "token",
        repositoryId: scope.repositoryId,
        jobId: job.jobId,
        payload: { operation: "retry_action", actionId: "push-attempt", expectedRevision: 3 },
      });
      expect(findButton("Retry publishing action").props.disabled).toBe(true);
      await act(async () => {
        reply.resolve(resumed);
        await reply.promise;
      });
      expect(text(renderer!.toJSON())).not.toContain("Retry publishing action");
    },
  );

  it("resumes a manual hold before retrying a failed publishing action", async () => {
    const failed = publishingFailure("failed");
    const paused: RepositoryWorkflowJob = {
      ...failed,
      progress: {
        ...failed.progress!,
        manualPauseSupported: true,
        manualPause: { state: "paused" },
      },
    };
    fixture.call.mockResolvedValue(paused);
    await mount();

    expect(text(renderer!.toJSON())).toContain("Couldn’t push branch");
    expect(text(renderer!.toJSON())).not.toContain("Retry publishing action");

    const resumed: RepositoryWorkflowJob = {
      ...failed,
      progress: { ...failed.progress!, revision: 4, manualPauseSupported: true },
    };
    const resume = vi.fn().mockResolvedValue(resumed);
    fixture.call
      .mockResolvedValue(resumed)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: resume }, "token"));
    await press("Resume workflow");

    expect(resume).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "token",
      repositoryId: scope.repositoryId,
      jobId: job.jobId,
      payload: {
        operation: "resume",
        controlId: expect.any(String),
        expectedRevision: 3,
      },
    });
    expect(text(renderer!.toJSON())).toContain("Retry publishing action");
  });
});

describe("workflow cancellation", () => {
  const running: RepositoryWorkflowJob = {
    ...job,
    status: "running",
    progress: { ...job.progress!, status: "running" },
    viewerControls: { canApprove: false, canRespond: false, canCancel: true },
  };
  const cancellationFailed: RepositoryWorkflowJob = {
    ...running,
    status: "cancelling",
    progress: {
      ...running.progress!,
      revision: 4,
      status: "cancelling",
      retryableCancellation: true,
    },
  };

  it("keeps the unresolved VM recovery warning visible during cancellation", async () => {
    const recoveryDetail =
      "Launchpad couldn’t confirm the VM resume. Saved results are still available.";
    fixture.call.mockResolvedValue({
      ...running,
      status: "cancelling",
      progress: { ...running.progress!, status: "cancelling" },
      vmRecovery: { state: "recovery_error", detail: recoveryDetail },
    });
    await mount(false);

    const rendered = text(renderer!.toJSON());
    expect(rendered).toContain("Canceling run");
    expect(rendered).toContain(recoveryDetail);
    expect(findButton("Retry cancellation")).toBeUndefined();
  });

  it("closes confirmation when the viewer loses permission while it is open", async () => {
    fixture.call.mockResolvedValue(running);
    await mount(false);
    const beforeOpening = fixture.call.mock.calls.length;
    await press("Run controls");
    await press("Cancel run");
    expect(text(cancelDialog())).toContain(running.instruction);
    expect(fixture.call).toHaveBeenCalledTimes(beforeOpening);

    fixture.call.mockResolvedValue({
      ...running,
      viewerControls: { ...running.viewerControls!, canCancel: false },
    });
    await pollRun();

    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    expect(findButton("Cancel run")).toBeUndefined();
  });

  it("shows pending cancellation and gives authorized viewers a retry after it fails", async () => {
    const recoveryDetail =
      "Cancellation is not confirmed. Update the environment to finish cancelling this job.";
    fixture.call.mockResolvedValue({
      ...running,
      status: "cancelling",
      detail: recoveryDetail,
      responsePending: true,
    });
    await mount(false);

    expect(
      renderer!.root
        .findAllByProps({ role: "status" })
        .some(
          (status) =>
            text(status).includes("Canceling run") && text(status).includes(recoveryDetail),
        ),
    ).toBe(true);
    expect(findButton("Retry cancellation")).toBeUndefined();

    fixture.call.mockResolvedValue({
      ...cancellationFailed,
      viewerControls: { ...running.viewerControls!, canCancel: false },
    });
    await pollRun();

    expect(text(renderer!.toJSON())).toContain("Cancellation needs attention");
    expect(findButton("Retry cancellation")).toBeUndefined();

    fixture.call.mockResolvedValue(cancellationFailed);
    await pollRun();
    const retryButton = findButton("Retry cancellation");
    expect(retryButton).toBeDefined();
    expect(
      renderer!.root
        .findAllByProps({ role: "alert" })
        .some(
          (alert) =>
            text(alert).includes("Cancellation needs attention") &&
            alert.findAllByType("button").includes(retryButton),
        ),
    ).toBe(true);

    const retryPending: RepositoryWorkflowJob = {
      ...cancellationFailed,
      responsePending: true,
    };
    const retry = vi.fn().mockResolvedValue(retryPending);
    fixture.call
      .mockResolvedValue(retryPending)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: retry }, "token"));
    await press("Retry cancellation");

    expect(retry).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "token",
      repositoryId: scope.repositoryId,
      jobId: job.jobId,
      payload: { operation: "retry_cancellation", expectedRevision: 4 },
    });
    expect(text(renderer!.toJSON())).toContain("Canceling run");
    expect(text(renderer!.toJSON())).not.toContain("Cancellation needs attention");
    expect(findButton("Retry cancellation")).toBeUndefined();
  });
});

describe("queued workflow recovery", () => {
  const queued = {
    ...job,
    runtime: null,
    progress: null,
    workflow: null,
    status: "queued",
    detail: null,
    viewerControls: { canApprove: false, canRespond: false, canCancel: true },
  } satisfies RepositoryWorkflowJob;

  it("explains an initially queued VM run and keeps cancellation usable", async () => {
    fixture.call.mockResolvedValue({
      ...queued,
      vmAdmission: { codexConnectionId: "codex", hasSecrets: false },
      detail: "Waiting for a VM slot.",
      queueReason: { code: "vm_waiting_capacity", retryAt: null },
    });
    await mount(false);

    const content = text(renderer!.toJSON());
    expect(content).toContain("Waiting for a VM slot");
    expect(content).not.toContain("Waiting for execution");
    expect(content).not.toContain("Waiting for an execution target");
    expect(content).toContain("This run will start automatically when a slot becomes available.");
    expect(content).not.toContain("Waiting for a VM slot.");
    expect(content).toContain("Run controls");
    await press("Run controls");
    expect(findButton("Cancel run").props.disabled).toBe(false);

    const cancelled = { ...queued, status: "cancelled", detail: null };
    const cancel = vi.fn().mockResolvedValue(cancelled);
    fixture.call
      .mockResolvedValue(cancelled)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: cancel }, "token"));
    await press("Cancel run");
    expect(text(cancelDialog())).toContain(queued.instruction);
    expect(cancel).not.toHaveBeenCalled();
    await press("Keep run");
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
    await press("Run controls");
    await press("Cancel run");
    await confirmCancellation();

    expect(cancel).toHaveBeenCalledWith({
      clerkToken: "token",
      repositoryId: scope.repositoryId,
      jobId: job.jobId,
      payload: { operation: "cancel" },
    });
  });

  const linearReconnect = {
    code: "source_reconnect",
    title: "Linear needs reconnecting",
    detail: "An organization admin must reconnect Linear before this job can start.",
    hash: "workflow-sources",
    label: "Open Workflow sources",
  } as const;

  it.each([
    {
      status: "queued",
      code: "vm_limit_disabled",
      title: "Workflow VMs disabled",
      detail: "Ask an organization admin to raise the Workflow VMs limit to start this run.",
      hash: "workflow-vms",
      label: "Open Workflow VMs settings",
    },
    { ...linearReconnect, status: "queued" },
    { ...linearReconnect, status: "preparing" },
  ] as const)(
    "shows organization recovery for $code on $status runs only to admins",
    async ({ code, status, title, detail, hash, label }) => {
      fixture.call.mockResolvedValue({
        ...queued,
        status,
        runtime: status === "preparing" ? { kind: "vm", threadId: ThreadId.make("thread") } : null,
        detail,
        queueReason: { code, retryAt: null },
      });
      // A repository maintainer can configure the workflow but cannot administer the organization.
      await mount(true);

      const memberContent = text(renderer!.toJSON());
      expect(memberContent).toContain(title);
      expect(memberContent).toMatch(/organization admin/i);
      expect(memberContent).not.toContain("Waiting for execution");
      expect(memberContent).not.toContain("Waiting for an execution target");
      expect(memberContent).not.toContain(detail);
      expect(memberContent).not.toContain(label);
      const href = `/settings/organization#${hash}`;
      const recoveryLinks = () =>
        renderer!.root.findAllByType("a").filter((link) => link.props.href === href);
      expect(recoveryLinks()).toHaveLength(0);

      await act(() => renderer!.update(view("job", true, true)));

      expect(text(renderer!.toJSON())).toContain(title);
      expect(recoveryLinks()).toHaveLength(1);
      expect(text(renderer!.toJSON())).toContain(label);
    },
  );

  it("announces a new blocker in the same status region when a queued run is polled", async () => {
    fixture.call.mockResolvedValue(queued);
    await mount();
    const status = headerStatus;
    const initialStatus = status();
    expect(initialStatus.children.join("")).toBe("Queued");

    fixture.call.mockResolvedValue({
      ...queued,
      queueReason: { code: linearReconnect.code, retryAt: null },
      detail: linearReconnect.detail,
    });
    await pollRun();

    expect(status()).toBe(initialStatus);
    expect(status().children.join("")).toMatch(/Queued.*Linear needs reconnecting/);
  });

  it("moves focus to the run heading when a poll removes the focused recovery link", async () => {
    fixture.call.mockResolvedValue({
      ...queued,
      queueReason: { code: linearReconnect.code, retryAt: null },
      detail: linearReconnect.detail,
    });
    const body = {};
    let focused = body;
    const ownerDocument = {
      body,
      get activeElement() {
        // The browser moves focus to the body once it removes a focused link.
        const content = text(renderer?.toJSON() ?? null);
        return focused === recoveryLink && !content.includes(linearReconnect.label)
          ? body
          : focused;
      },
    };
    const recoveryLink = { ownerDocument };
    const heading = {
      ownerDocument,
      focus() {
        focused = heading;
      },
    };
    await mount(
      true,
      {
        createNodeMock(element) {
          if (element.type === "h1") return heading;
          if (
            element.type === "a" &&
            (element.props as { href?: string }).href === "/settings/organization#workflow-sources"
          )
            return recoveryLink;
          return null;
        },
      },
      true,
    );

    expect(text(renderer!.toJSON())).toContain(linearReconnect.label);
    focused = recoveryLink;
    fixture.call.mockResolvedValue({
      ...queued,
      detail: "Waiting for a workflow VM slot.",
      queueReason: { code: "vm_waiting_capacity", retryAt: null },
    });
    await pollRun();

    expect(text(renderer!.toJSON())).not.toContain(linearReconnect.label);
    expect(ownerDocument.activeElement).toBe(heading);
  });

  it("preserves a newer relay error when a queued reason remains after a failed retry", async () => {
    const queueReason = { code: "vm_waiting_capacity", retryAt: null } as const;
    fixture.call.mockResolvedValue({
      ...queued,
      queueReason,
      detail: "Waiting for a workflow VM slot.",
    });
    await mount();
    expect(text(renderer!.toJSON())).toContain("Waiting for a VM slot");

    const detail =
      "Could not reach the workflow VM or confirm its response. Launchpad will retry automatically.";
    fixture.call.mockResolvedValue({ ...queued, queueReason, detail });
    await press("Refresh run");

    const content = text(renderer!.toJSON());
    expect(content).toContain(detail);
    expect(content).not.toContain(
      "This run will start automatically when a slot becomes available.",
    );
  });

  it("returns to the running view when a queued reason remains on an acknowledged running run", async () => {
    const queueReason = { code: "vm_limit_disabled", retryAt: null } as const;
    fixture.call.mockResolvedValue({ ...queued, queueReason });
    await mount();
    expect(text(renderer!.toJSON())).toContain("Workflow VMs disabled");

    fixture.call.mockResolvedValue({
      ...job,
      status: "running",
      progress: { ...job.progress!, status: "running", checkpoint: null },
      detail: "The agent started.",
      queueReason,
    });
    await press("Refresh run");

    const content = text(renderer!.toJSON());
    expect(content).toContain("Running");
    expect(content).toContain("The agent started.");
    expect(content).not.toContain("Workflow VMs disabled");
  });
});

it("resumes a paused input checkpoint with its answer draft intact", async () => {
  const question = "Which environment should we roll out to first?";
  const checkpoint = {
    checkpointId: "rollout",
    kind: "input",
    role: "member",
    stepId: "rollout",
    generation: 0,
    question,
  } as const;
  const paused: RepositoryWorkflowJob = {
    ...job,
    status: "paused",
    workflow: {
      workflowId: job.workflowId!,
      repositoryId: job.repositoryId,
      organizationId: scope.organizationId,
      archived: false,
      revision: 1,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      definition: {
        name: "Reviewed implementation",
        target: {
          kind: "machine",
          environmentId: EnvironmentId.make("original"),
          projectId: ProjectId.make("project"),
        },
        steps: [
          {
            id: "prepare",
            title: "Prepare changes",
            kind: "agent",
            instruction: "Prepare the fix.",
            modelSelection: null,
          },
          { id: "rollout", title: "Confirm rollout", kind: "input", role: "member", question },
        ],
      },
    },
    progress: {
      ...job.progress!,
      status: "paused",
      underlyingStatus: "awaiting_input",
      manualPause: { state: "paused" },
      manualPauseSupported: true,
      checkpoint,
    },
  };
  const resumed: RepositoryWorkflowJob = {
    ...paused,
    status: "awaiting_input",
    progress: {
      ...paused.progress!,
      revision: paused.progress!.revision + 1,
      status: "awaiting_input",
      manualPause: null,
    },
  };
  fixture.call.mockResolvedValue({
    ...resumed,
    progress: { ...resumed.progress!, revision: paused.progress!.revision - 1 },
  });
  await mount();
  const answer = () => renderer!.root.findByType("textarea");
  const submit = () => renderer!.root.findByProps({ type: "submit" });
  const draftEditor = answer();
  await act(() => draftEditor.props.onChange({ target: { value: "Staging first." } }));

  fixture.call.mockResolvedValue(paused);
  await pollRun();

  expect(answer()).toBe(draftEditor);
  expect(text(renderer!.toJSON())).toContain("Answer draft");
  expect(renderer!.root.findAllByProps({ type: "submit" })).toHaveLength(0);

  const resume = vi.fn().mockResolvedValue(resumed);
  fixture.call
    .mockResolvedValue(resumed)
    .mockImplementationOnce((request) => request({ respondToWorkflowJob: resume }, "token"));
  await press("Resume workflow");

  expect(resume).toHaveBeenCalledWith(
    expect.objectContaining({
      jobId: job.jobId,
      payload: expect.objectContaining({
        operation: "resume",
        expectedRevision: paused.progress!.revision,
      }),
    }),
  );
  expect(answer()).toBe(draftEditor);
  expect(answer().props.value).toBe("Staging first.");
  expect(submit().props.disabled).toBe(false);
});

it("reloads the catalog with a manual run refresh", async () => {
  await mount();
  expect(fixture.refreshCatalog).not.toHaveBeenCalled();
  const reads = fixture.call.mock.calls.length;

  await press("Refresh run");

  expect(fixture.refreshCatalog).toHaveBeenCalledOnce();
  expect(fixture.call).toHaveBeenCalledTimes(reads + 1);
});

it.each([
  { action: "Open conversation", status: "awaiting_input" },
  { action: "Resume workflow", status: "paused" },
] as const)("keeps focus on $action when the run becomes $status", async ({ action, status }) => {
  const pausing = status === "paused";
  fixture.call.mockResolvedValue({
    ...job,
    status: "running",
    progress: {
      ...job.progress!,
      status: "running",
      checkpoint: null,
      manualPauseSupported: true,
      manualPause: pausing ? { state: "requested" } : null,
    },
  });
  const body = {};
  const ownerDocument = { body, activeElement: body };
  const nodes: object[] = [];
  await mount(true, {
    createNodeMock(element) {
      const { children } = element.props as PropsWithChildren;
      if (element.type !== "button" || !Array.isArray(children) || !children.includes(action))
        return null;
      // Detaching the old focused element sends DOM focus back to the body.
      if (nodes.includes(ownerDocument.activeElement)) ownerDocument.activeElement = body;
      const node = {
        ownerDocument,
        disabled: false,
        focus() {
          ownerDocument.activeElement = node;
        },
      };
      nodes.push(node);
      return node;
    },
  });
  expect(nodes).toHaveLength(1);
  ownerDocument.activeElement = nodes[0]!;
  fixture.call.mockResolvedValue({
    ...job,
    status,
    progress: {
      ...job.progress!,
      revision: job.progress!.revision + 1,
      status,
      underlyingStatus: pausing ? "waiting_capacity" : status,
      checkpoint: pausing
        ? null
        : {
            kind: "input",
            checkpointId: "rollout",
            role: "member",
            generation: 0,
            stepId: "rollout",
            question: "Where should this run first?",
          },
      manualPauseSupported: true,
      manualPause: pausing ? { state: "paused" } : null,
    },
  });
  await pollRun();

  expect(nodes).toHaveLength(2);
  expect(ownerDocument.activeElement).toBe(nodes[1]);
  expect(fixture.refreshCatalog).not.toHaveBeenCalled();
});

it("shows the manual hold instead of a stale capacity wait and keeps recovery details", async () => {
  const capacityDetail = "Waiting for executor capacity.";
  const paused = {
    ...job,
    status: "paused",
    detail: capacityDetail,
    progress: {
      ...job.progress!,
      status: "paused",
      checkpoint: null,
      detail: capacityDetail,
      underlyingStatus: "waiting_capacity",
      manualPauseSupported: true,
      manualPause: { state: "paused" },
    },
  } satisfies RepositoryWorkflowJob;
  fixture.call.mockResolvedValue(paused);
  await mount();
  const content = () => text(renderer!.toJSON());
  expect(content()).toContain("Resume workflow");
  expect(content()).not.toContain(capacityDetail);

  const recoveryDetail = "The environment lost access to this checkout.";
  fixture.call.mockResolvedValue({
    ...paused,
    detail: recoveryDetail,
    progress: {
      ...paused.progress,
      revision: paused.progress.revision + 1,
      detail: recoveryDetail,
    },
  });
  await press("Refresh run");
  expect(content()).toContain(recoveryDetail);
});
