import {
  act,
  cloneElement,
  type PropsWithChildren,
  type ReactElement,
  type Ref,
  createElement,
} from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
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
  confirm: vi.fn(),
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
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: fixture.confirm }));
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
vi.mock("./WorkflowFlow", () => ({ WorkflowFlow: () => null }));
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
function text(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
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
  fixture.confirm.mockReset().mockResolvedValue(true);
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
    expect(content).toContain("More controls");
    expect(findButton("Cancel run").props.disabled).toBe(false);

    const cancelled = { ...queued, status: "cancelled", detail: null };
    const cancel = vi.fn().mockResolvedValue(cancelled);
    fixture.call
      .mockResolvedValue(cancelled)
      .mockImplementationOnce((request) => request({ respondToWorkflowJob: cancel }, "token"));
    await press("Cancel run");

    expect(fixture.confirm).toHaveBeenCalledOnce();
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
  fixture.call.mockResolvedValue(paused);
  await mount();
  const answer = () => renderer!.root.findByType("textarea");
  const submit = () => renderer!.root.findByProps({ type: "submit" });
  await act(() => answer().props.onChange({ target: { value: "Staging first." } }));
  expect(submit().props.disabled).toBe(true);

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
