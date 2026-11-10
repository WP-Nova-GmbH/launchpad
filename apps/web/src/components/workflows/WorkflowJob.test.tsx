import { act, cloneElement, type PropsWithChildren, type ReactElement, createElement } from "react";
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
  open: vi.fn(),
  navigate: vi.fn(),
  select: vi.fn(),
  panel: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
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
  Button: (props: PropsWithChildren<Record<string, unknown>>) => createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
import { WorkflowJob } from "./WorkflowJob";

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
const view = (jobId = "job", canConfigure = true) => (
  <AppAtomRegistryProvider>
    <WorkflowJob scope={scope} jobId={jobId} projects={[]} canConfigure={canConfigure} />
  </AppAtomRegistryProvider>
);
async function mount(canConfigure = true) {
  await act(async () => {
    renderer = create(view("job", canConfigure));
  });
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const conversationButton = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.props.children === "Open conversation")!;
async function press(label: string) {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === label || button.props.children === label)!
      .props.onClick();
  });
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
    expect(text(renderer!.toJSON())).toContain("Review changed");
    const approval = renderer!.root
      .findAllByType("button")
      .find((b) => b.props.children === "Approve result")!;
    expect(approval.props.disabled).toBe(true);
    const before = fixture.call.mock.calls.length;
    await press("Approve result");
    expect(fixture.call).toHaveBeenCalledTimes(before);
    expect(fixture.open).not.toHaveBeenCalled();
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
  it("explains an accepted queued run without displaying a speculative step plan", async () => {
    fixture.call.mockResolvedValue({ ...job, status: "queued", progress: null, workflow: null });
    await mount();
    expect(text(renderer!.toJSON())).toContain("Waiting for execution");
    expect(text(renderer!.toJSON())).toContain("No steps have started");
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Run progress"),
    ).toHaveLength(0);
  });
});
