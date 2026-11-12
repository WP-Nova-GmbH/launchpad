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
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  recordSavedWorkflowReviewDiff,
  requireFreshWorkflowReviewRead,
  beginWorkflowReview,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowSessionKey,
  setWorkflowSessionAccount,
} from "@t3tools/client-runtime/relay/workflow-session";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  refreshCatalog: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn(),
  select: vi.fn(),
  panel: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
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
  SavedWorkflowResults: () => createElement("section", {}, "Saved results"),
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
const view = (jobId = "job", canConfigure = true, organizationAdmin = false) => (
  <AppAtomRegistryProvider>
    <WorkflowJob
      scope={scope}
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
const conversationButton = () => findButton("Open conversation");
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
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("workflow result location navigation", () => {
  const vmReview = {
    ...job,
    runtime: { kind: "vm", threadId: ThreadId.make("thread") },
    status: "awaiting_review",
    progress: { ...job.progress!, status: "awaiting_review" },
    viewerControls: { canApprove: true, canRespond: false, canCancel: true },
  } satisfies RepositoryWorkflowJob;

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

  it("shows a queued VM approval as pending before the guest acknowledges it", async () => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      responsePending: true,
      pendingResponseOperation: "approve",
    });
    await mount(false);
    const approval = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Approval pending")!;
    expect(approval.props.disabled).toBe(true);
  });

  it("refreshes a matching saved checkpoint before enabling approval", async () => {
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    await act(() => {
      beginWorkflowReview(appAtomRegistry, scope, "job", "saved-visit", {
        checkpointId: "checkpoint",
        turnId: "saved-turn",
        checkpointTurnCount: 3,
      });
      expect(
        recordSavedWorkflowReviewDiff(appAtomRegistry, scope, "job", "saved-visit", {
          resultId: "11111111-1111-4111-8111-111111111111",
          stepId: "agent",
          turnId: "saved-turn",
          turnCount: 3,
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
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, "job");
    });
    await act(() => renderer!.unmount());
    const reply = deferred();
    fixture.call.mockReturnValue(reply.promise);
    await mount(false);
    const approval = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.children === "Approve result")!;
    expect(approval().props.disabled).toBe(true);
    expect(text(renderer!.toJSON())).toContain("Checking the current review");
    await act(async () => {
      reply.resolve(vmReview);
      await reply.promise;
    });
    expect(approval().props.disabled).toBe(false);
  });

  it("opens conversation and the original saved turn at the current destination", async () => {
    await mount();
    await press("Inspect result");
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
    expect(destination.state({}).workflowOrigin).toEqual({
      ...scope,
      jobId: "job",
      threadId: "thread",
      workflowVmResultReader: true,
    });
    expect(fixture.open).toHaveBeenCalledWith(
      expect.objectContaining({ workflowResult: { ...scope, originalEnvironmentId: "original" } }),
    );
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(2);
    expect(job.runtime).toMatchObject({ kind: "machine", environmentId: "original" });
  });
  it("keeps a failed location lookup visible and retries without opening a stale route", async () => {
    fixture.open.mockRejectedValueOnce(new Error("Location unavailable"));
    await mount();
    await press("Inspect result");
    expect(text(renderer!.toJSON())).toContain("Location unavailable");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.select).not.toHaveBeenCalled();
    await press("Inspect result");
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
  });
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
    expect(conversationButton().props.disabled).toBe(true);
    appAtomRegistry.set(managedRelaySessionAtom, {
      accountId: scope.accountId,
      readClerkToken: () => Effect.succeed("replacement-token"),
    });
    await act(async () => {
      reply.resolve({ _tag: "Success", value: { environmentId: "moved-vm", threadId: "thread" } });
      await reply.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(conversationButton().props.disabled).toBe(false);
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
    expect(conversationButton().props.disabled).toBe(false);
    await press("Open conversation");
    expect(fixture.open).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldReply.resolve({ _tag: "Success", value: { environmentId: "old-vm", threadId: "thread" } });
      await oldReply.promise;
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(conversationButton().props.disabled).toBe(true);
    await act(async () => {
      newReply.resolve({ _tag: "Success", value: { environmentId: "new-vm", threadId: "thread" } });
      await newReply.promise;
    });
    expect(conversationButton().props.disabled).toBe(false);
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
  const review: RepositoryWorkflowJob = {
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
  };
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
  const inputCheckpoint: RepositoryWorkflowJob = {
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
  };
  const currentTask = () =>
    renderer!.root
      .findAllByType("section")
      .find((section) => section.props["aria-label"] === "Current workflow task")!;
  const submitCheckpoint = () =>
    act(async () => {
      currentTask().findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
  const headerStatus = () =>
    renderer!.root
      .findAllByType("header")
      .flatMap((header) => header.findAllByType("span"))
      .find((span) => span.props.role === "status");

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
      ...review,
      runtime: { kind: "vm", threadId: ThreadId.make("thread") },
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
    await pollRun();

    const requirement = "This checkpoint requires a repository maintainer.";
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
      const currentDrafts = () => appAtomRegistry.get(workflowDraftAtom).responses[key];
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        responses: { [key]: { ...untouched, earlier: original } },
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
          resultId: null,
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
    ["Saving result", savingAgentResult("saving"), "Agent"],
    ["Couldn’t save result", savingAgentResult("failed"), "Agent"],
    ["Finishing", finishing(false)],
    ["Completion needs attention", finishing(true)],
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
    const status = () => renderer!.root.findByProps({ role: "status" });
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
