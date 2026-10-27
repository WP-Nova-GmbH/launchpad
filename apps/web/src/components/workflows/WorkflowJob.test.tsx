import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { setWorkflowSessionAccount } from "@t3tools/client-runtime/relay/workflow-session";
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
  environmentId: EnvironmentId.make("original"),
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
const view = (jobId = "job") => (
  <AppAtomRegistryProvider>
    <WorkflowJob scope={scope} jobId={jobId} projects={[]} canConfigure />
  </AppAtomRegistryProvider>
);
async function mount() {
  await act(async () => {
    renderer = create(view());
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
    value: { environmentId: "moved-vm", threadId: "thread" },
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
    });
    expect(fixture.open).toHaveBeenCalledWith(
      expect.objectContaining({ workflowResult: { ...scope, originalEnvironmentId: "original" } }),
    );
    await press("Open conversation");
    expect(fixture.navigate).toHaveBeenCalledTimes(2);
    expect(job.environmentId).toBe("original");
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
