import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  recordWorkflowReviewDiff,
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
vi.mock("./WorkflowFlow", () => ({ WorkflowFlow: () => null }));
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
      .find((button) => button.props.children === label)!
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

  it("opens the exact VM checkpoint and carries its identity back to the run", async () => {
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    expect(text(renderer!.toJSON())).toContain("Approve result");
    expect(text(renderer!.toJSON())).toContain("Cancel run");
    expect(text(renderer!.toJSON())).not.toContain("Request changes");
    await press("Inspect live diff");
    expect(fixture.open).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowResult: { ...scope, jobId: job.jobId },
      }),
    );
    expect(fixture.select).toHaveBeenCalledWith(
      { environmentId: "moved-vm", threadId: "thread" },
      "saved-turn",
      undefined,
      3,
    );
    const destination = fixture.navigate.mock.calls[0]![0];
    expect(destination.state({}).workflowOrigin.reviewCheckpoint).toEqual({
      checkpointId: "checkpoint",
      turnId: "saved-turn",
      checkpointTurnCount: 3,
    });
  });

  it("keeps stale approval blocked after opening the conversation and returning", async () => {
    fixture.call.mockResolvedValue({
      ...vmReview,
      progress: {
        ...vmReview.progress,
        checkpoint: {
          checkpointId: "previous",
          turnId: "old-turn",
          checkpointTurnCount: 2,
          checkpointRef: "old-ref",
        },
      },
    });
    await mount(false);
    await press("Inspect live diff");
    await act(() => renderer!.unmount());
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    expect(text(renderer!.toJSON())).toContain("Review changed");
    const approval = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Approve result")!;
    expect(approval.props.disabled).toBe(true);
    const before = fixture.call.mock.calls.length;
    await press("Approve result");
    expect(fixture.call).toHaveBeenCalledTimes(before);
    await press("Open conversation");
    expect(
      fixture.navigate.mock.lastCall![0].state({}).workflowOrigin.reviewCheckpoint,
    ).toBeUndefined();
    await act(() => renderer!.unmount());
    await mount(false);
    expect(text(renderer!.toJSON())).toContain("Review changed");
    await press("Inspect live diff");
    expect(fixture.select).toHaveBeenCalledWith(expect.anything(), "saved-turn", undefined, 3);
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

  it("refreshes a cached matching checkpoint before enabling approval on return", async () => {
    fixture.call.mockResolvedValue(vmReview);
    await mount(false);
    await press("Inspect live diff");
    const origin = fixture.navigate.mock.lastCall![0].state({}).workflowOrigin;
    await act(() => {
      expect(
        recordWorkflowReviewDiff(
          appAtomRegistry,
          origin,
          {
            environmentId: EnvironmentId.make("moved-vm"),
            threadId: ThreadId.make("thread"),
            generation: 1,
          },
          {
            threadId: ThreadId.make("thread"),
            fromTurnCount: 2,
            toTurnCount: 3,
            diff: "",
            completeWorkflowReview: true,
            targetTurnId: TurnId.make("saved-turn"),
          },
        ),
      ).toBe(true);
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
    await press("Inspect saved diff");
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
    await press("Inspect saved diff");
    expect(text(renderer!.toJSON())).toContain("Location unavailable");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.select).not.toHaveBeenCalled();
    await press("Inspect saved diff");
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
