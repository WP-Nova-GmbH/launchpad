import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { RepositoryWorkflowJob, WorkflowSavedResult } from "@t3tools/contracts/workflows";
import {
  setWorkflowSessionAccount,
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  settleWorkflowJobRequest,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { Atom } from "effect/unstable/reactivity";
import type { ManagedRelaySnapshotState } from "@t3tools/client-runtime/relay";
import type { ThreadVmCapabilities } from "@t3tools/contracts/relay";
const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  confirm: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  history: vi.fn(),
  deletion: vi.fn(),
  refresh: vi.fn(),
  target: vi.fn(),
}));
const capability = (permanentDelete = true): ThreadVmCapabilities => ({
  configured: true,
  autoPause: true,
  autoBackup: true,
  autoDelete: true,
  replacement: true,
  restore: true,
  reset: true,
  permanentDelete,
  privatePreview: true,
});
const capabilitiesAtom = Atom.make<ManagedRelaySnapshotState<ThreadVmCapabilities | null>>({
  data: capability(),
  error: null,
  errorTraceId: null,
  isPending: false,
});
vi.mock("../../state/threads", () => ({
  threadVmControls: {
    get capabilitiesAtom() {
      return capabilitiesAtom;
    },
  },
}));
vi.mock("./workflowState", () => ({
  useWorkflowClient: () => fixture.call,
  confirmWorkflow: fixture.confirm,
}));
vi.mock("../diffs/StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: Record<string, unknown>) => createElement("pre", props),
}));
vi.mock("../chat/SavedConversationMessage", () => ({ SavedConversationMessage: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({ diffLayout: "split" }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children }: PropsWithChildren) => children,
  Toggle: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../ui/button", () => ({
  Button: (props: PropsWithChildren<Record<string, unknown>>) => createElement("button", props),
}));
vi.mock("../ui/select", () => ({
  Select: (props: PropsWithChildren<Record<string, unknown>>) => createElement("select", props),
  SelectItem: ({ children }: PropsWithChildren) => children,
  SelectPopup: ({ children }: PropsWithChildren) => children,
  SelectTrigger: ({ children }: PropsWithChildren) => children,
  SelectValue: ({ children }: PropsWithChildren) => children,
}));
import { SavedWorkflowResults } from "./SavedWorkflowResults";
const scope = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
const result: WorkflowSavedResult = {
  resultId: "11111111-1111-4111-8111-111111111111",
  stepId: "Agent 1",
  turnId: "turn",
  turnCount: 1,
  outcome: "completed",
  createdAt: "2026-11-10T11:00:00Z",
  checkpointRef: "ref",
  baselineCommitId: "base",
  commitId: "commit",
  treeId: "tree",
  patch: {
    artifactId: "22222222-2222-4222-8222-222222222222",
    sha256: "a".repeat(64),
    sizeBytes: new TextEncoder().encode(patch).length,
  },
};
const job: RepositoryWorkflowJob = {
  jobId: "job",
  repositoryId: "repo",
  workflowId: "workflow",
  runtime: { kind: "vm", threadId: ThreadId.make("thread") },
  instruction: "test",
  status: "awaiting_review",
  detail: null,
  workflow: null,
  createdAt: "now",
  updatedAt: "now",
  progress: {
    revision: 1,
    status: "awaiting_review",
    threadId: ThreadId.make("thread"),
    hasThread: true,
    detail: null,
    checkpoint: {
      checkpointId: "checkpoint",
      turnId: "turn",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
    },
    executionReleased: true,
  },
};
let renderer: ReactTestRenderer;
const view = (currentJob = job, canConfigure = true) =>
  createElement(
    AppAtomRegistryProvider,
    null,
    createElement(SavedWorkflowResults, {
      scope,
      job: currentJob,
      refresh: fixture.refresh,
      canConfigure,
      onReviewTargetChange: fixture.target,
    }),
  );
async function mount(currentJob = job, canConfigure = true) {
  await act(async () => {
    renderer = create(view(currentJob, canConfigure));
  });
}
async function press(label: string) {
  await act(async () => {
    await renderer.root
      .findAllByType("button")
      .find((b) => b.props.children === label)!
      .props.onClick();
  });
}
beforeEach(() => {
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  activateWorkflowJobView(appAtomRegistry, scope, job.jobId);
  settleWorkflowJobRequest(
    appAtomRegistry,
    beginWorkflowJobRequest(appAtomRegistry, scope, job.jobId)!,
    job,
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  appAtomRegistry.set(capabilitiesAtom, {
    data: capability(),
    error: null,
    errorTraceId: null,
    isPending: false,
  });
  fixture.list.mockResolvedValue({
    results: [result],
    nextCursor: null,
    threadId: "thread",
    generation: 1,
    relayUrl: "https://relay.invalid",
  });
  fixture.read.mockResolvedValue({ result, patch });
  fixture.history.mockResolvedValue({ entries: [] });
  fixture.deletion.mockResolvedValue(undefined);
  fixture.confirm.mockResolvedValue(true);
  fixture.refresh.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const withClient = async (test: () => Promise<void>) => {
  // Model the HTTP transport boundary with promises; the component owns no Effect runtime.
  let response: unknown;
  const transport = (method: typeof fixture.list) => (input: unknown) => {
    response = method(input);
    return Effect.void;
  };
  const client = {
    relayUrl: "https://relay.invalid",
    listSavedWorkflowResults: transport(fixture.list),
    readSavedWorkflowResult: transport(fixture.read),
    getSavedWorkflowHistory: transport(fixture.history),
    permanentlyDeleteThread: transport(fixture.deletion),
  };
  fixture.call.mockImplementation(
    (operation: (transportClient: typeof client, token: string) => unknown) => {
      operation(client, "test");
      return Promise.resolve(response);
    },
  );
  await test();
};
it("requires the current saved diff to render before recording a Review visit", () =>
  withClient(async () => {
    await mount();
    expect(fixture.refresh).not.toHaveBeenCalled();
    const diff = renderer.root.findByType("pre");
    await act(() => diff.props.options.onPostRender());
    expect(fixture.refresh).toHaveBeenCalledOnce();
    await act(() => diff.props.options.onPostRender());
    expect(fixture.refresh).toHaveBeenCalledOnce();
  }));
it("does not replace a selected result with a late reply for an older selection", () =>
  withClient(async () => {
    const next = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      stepId: "Agent 2",
      turnId: "turn-2",
    };
    fixture.list.mockResolvedValue({
      results: [result, next],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
      relayUrl: "https://relay.invalid",
    });
    let resolve!: (read: { result: WorkflowSavedResult; patch: string }) => void;
    fixture.read.mockImplementation(({ resultId }: { resultId: string }) =>
      resultId === result.resultId
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve({ result: next, patch }),
    );
    await mount();
    await act(() => renderer.root.findByType("select").props.onValueChange(next.resultId));
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(next.resultId);
    await act(async () => {
      resolve({ result, patch });
    });
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(next.resultId);
    expect(fixture.refresh).not.toHaveBeenCalled();
  }));
it("reconciles deletion with the same operation after an uncertain reply", () =>
  withClient(async () => {
    fixture.deletion.mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue(undefined);
    await mount({ ...job, status: "done" });
    await press("Delete thread permanently");
    await press("Delete thread permanently");
    expect(fixture.deletion).toHaveBeenCalledTimes(2);
    expect(fixture.deletion.mock.calls[0]![0].payload).toEqual(
      fixture.deletion.mock.calls[1]![0].payload,
    );
    expect(fixture.confirm).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain("Thread deletion requested");
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  }));

it("keeps earlier results read-only and returns to the exact current review", () =>
  withClient(async () => {
    const earlier = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      turnId: "earlier",
      turnCount: 2,
      createdAt: "2026-11-10T10:40:00Z",
    };
    fixture.list.mockResolvedValue({
      results: [result, earlier],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
      relayUrl: "https://relay.invalid",
    });
    fixture.read.mockImplementation(({ resultId }: { resultId: string }) =>
      Promise.resolve({ result: resultId === result.resultId ? result : earlier, patch }),
    );
    await mount();
    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.target).toHaveBeenLastCalledWith(true);
    await act(() => renderer.root.findByType("select").props.onValueChange(earlier.resultId));
    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.target).toHaveBeenLastCalledWith(false);
    expect(JSON.stringify(renderer.toJSON())).toContain("This saved result is read-only");
    await press("Return to current review");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    expect(fixture.target).toHaveBeenLastCalledWith(true);
    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
  }));
it("keeps an opened diff in place when a new checkpoint arrives until Review latest", () =>
  withClient(async () => {
    await mount();
    const next = {
      ...result,
      resultId: "44444444-4444-4444-8444-444444444444",
      turnId: "new-turn",
      turnCount: 5,
      checkpointRef: "new-ref",
      createdAt: "2026-11-10T11:15:00Z",
    };
    fixture.list.mockResolvedValue({
      results: [next, result],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
      relayUrl: "https://relay.invalid",
    });
    fixture.read.mockImplementation(({ resultId }: { resultId: string }) =>
      Promise.resolve({ result: resultId === next.resultId ? next : result, patch }),
    );
    const nextJob = {
      ...job,
      progress: {
        ...job.progress!,
        checkpoint: {
          ...job.progress!.checkpoint!,
          checkpointId: "next",
          turnId: next.turnId,
          checkpointTurnCount: next.turnCount,
          checkpointRef: next.checkpointRef,
        },
      },
    };
    await act(() => renderer.update(view(nextJob)));
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    expect(JSON.stringify(renderer.toJSON())).toContain("A newer result needs review");
    expect(fixture.target).toHaveBeenLastCalledWith(false);
    await press("Review latest");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(next.resultId);
    expect(fixture.target).toHaveBeenLastCalledWith(true);
  }));
it.each(["awaiting_review", "finishing"] as const)(
  "keeps the exact saved diff inspectable without prompting for another review during %s completion",
  (status) =>
    withClient(async () => {
      const earlier = {
        ...result,
        resultId: "33333333-3333-4333-8333-333333333333",
        turnId: "earlier",
        createdAt: "2026-11-10T10:40:00Z",
      };
      fixture.list.mockResolvedValue({
        results: [result, earlier],
        nextCursor: null,
        threadId: "thread",
        generation: 1,
        relayUrl: "https://relay.invalid",
      });
      fixture.read.mockImplementation(({ resultId }: { resultId: string }) =>
        Promise.resolve({ result: resultId === result.resultId ? result : earlier, patch }),
      );
      const finalizing = {
        ...job,
        status,
        workflow: {
          workflowId: job.workflowId,
          repositoryId: job.repositoryId,
          organizationId: scope.organizationId,
          archived: false,
          revision: 1,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          definition: {
            name: "Review implementation",
            target: { kind: "vm", baseBranch: "main" },
            steps: [
              {
                id: result.stepId,
                title: "Implement",
                kind: "agent",
                instruction: "Make the change",
                modelSelection: null,
              },
              { id: "review", title: "Review changes", kind: "review", role: "member" },
            ],
          },
        },
        progress: {
          ...job.progress!,
          status,
          retryableApproval: true,
          steps: [
            { stepId: result.stepId, generation: 0, status: "completed" },
            { stepId: "review", generation: 0, status: "completed" },
          ],
        },
      } satisfies RepositoryWorkflowJob;
      settleWorkflowJobRequest(
        appAtomRegistry,
        beginWorkflowJobRequest(appAtomRegistry, scope, job.jobId)!,
        finalizing,
      );
      await mount(finalizing);
      await act(() => renderer.root.findByType("pre").props.options.onPostRender());
      expect(JSON.stringify(renderer.toJSON())).toContain("Latest result");
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Current review result");
      expect(fixture.refresh).toHaveBeenCalledOnce();

      await act(() => renderer.root.findByType("select").props.onValueChange(earlier.resultId));
      expect(renderer.root.findByType("pre").props.items[0].id).toContain(earlier.resultId);
      const content = JSON.stringify(renderer.toJSON());
      expect(content).not.toContain("A newer result needs review");
      expect(content).not.toContain("Return to current review");
      expect(content).not.toContain("Decisions apply to the current review");
      await press("Open result for final checks");
      expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    }),
);

it("retries the selected result after a load failure without jumping to another result", () =>
  withClient(async () => {
    fixture.read.mockRejectedValueOnce(new Error("Disconnected"));
    await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain("Disconnected");
    await press("Retry");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
  }));

it("keeps Input-first runs empty until an Agent creates results, rather than calling them deleted", () =>
  withClient(async () => {
    await mount({
      ...job,
      status: "awaiting_input",
      progress: { ...job.progress!, hasThread: false },
    });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("No Agent result has been saved yet");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("deletion requested");
    await act(() => renderer.update(view(job)));
    expect(fixture.list).toHaveBeenCalled();
    expect(renderer.root.findAllByType("pre")).toHaveLength(1);
  }));
it.each([
  [patch, "Partial changes saved", "View saved changes"],
  ["", "Partial result saved", "View saved result"],
])(
  "discloses the confirmed partial result with the right action (%s)",
  (savedPatch, title, label) =>
    withClient(async () => {
      const partial: WorkflowSavedResult = {
        ...result,
        outcome: "cancelled",
        patch: { ...result.patch, sizeBytes: new TextEncoder().encode(savedPatch).length },
      };
      fixture.list.mockResolvedValue({
        results: [partial],
        nextCursor: null,
        threadId: "thread",
        generation: 1,
      });
      fixture.read.mockResolvedValue({ result: partial, patch: savedPatch });
      await mount({
        ...job,
        status: "cancelled",
        detail: "Canceled before the Agent step completed.",
        progress: { ...job.progress!, status: "cancelled", checkpoint: null },
      });

      const outcome = JSON.stringify(renderer.toJSON());
      expect(outcome).toContain(title);
      expect(outcome).toContain("Canceled before the Agent step completed.");
      const disclosure = () =>
        renderer.root
          .findAllByType("button")
          .find((button) => typeof button.props["aria-expanded"] === "boolean")!;
      const savedResults = () =>
        renderer.root.findByProps({ id: disclosure().props["aria-controls"] });
      expect(disclosure().children).toContain(label);
      expect(disclosure().props["aria-expanded"]).toBe(false);
      expect(savedResults().props.hidden).toBe(true);
      const cleanup = renderer.root
        .findAllByType("button")
        .find((button) => button.props.children === "Delete thread permanently")!;
      for (let node: typeof cleanup | null = cleanup; node; node = node.parent) {
        expect(node.props.hidden).not.toBe(true);
      }
      if (savedPatch) {
        fixture.deletion.mockRejectedValueOnce(new Error("Reply lost"));
        await press("Delete thread permanently");
        const deletionError = renderer.root
          .findAllByType("div")
          .find((node) =>
            node.children.some(
              (child) =>
                typeof child === "string" && /could not confirm thread deletion/i.test(child),
            ),
          )!;
        for (let node: typeof deletionError | null = deletionError; node; node = node.parent) {
          expect(node.props.hidden).not.toBe(true);
        }
        expect(deletionError).toBeDefined();
        expect(savedResults().props.hidden).toBe(true);
      }

      await act(() => disclosure().props.onClick());
      expect(disclosure().props["aria-expanded"]).toBe(true);
      expect(savedResults().props.hidden).toBe(false);
      if (savedPatch)
        expect(savedResults().findByType("pre").props.items[0].id).toContain(partial.resultId);
      else expect(JSON.stringify(renderer.toJSON())).toContain("No file changes.");
      expect(fixture.refresh).not.toHaveBeenCalled();
    }),
);

it("keeps an open saved conversation in place when a live run is canceled", () =>
  withClient(async () => {
    await mount({
      ...job,
      status: "running",
      progress: { ...job.progress!, status: "running", checkpoint: null },
    });
    await press("Conversation");
    const panel = renderer.root.findByProps({ role: "tabpanel" });
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");

    const partial: WorkflowSavedResult = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      stepId: "Agent 2",
      outcome: "cancelled",
    };
    let publish!: () => void;
    const publication = new Promise<void>((resolve) => {
      publish = resolve;
    });
    fixture.list.mockImplementation(async () => {
      await publication;
      return {
        results: [partial, { ...result, patch: { ...result.patch } }],
        nextCursor: null,
        threadId: "thread",
        generation: 1,
        relayUrl: "https://relay.invalid",
      };
    });
    await act(() =>
      renderer.update(
        view({
          ...job,
          status: "cancelled",
          progress: { ...job.progress!, status: "cancelled", checkpoint: null },
        }),
      ),
    );
    expect(renderer.root.findByProps({ role: "tabpanel" })).toBe(panel);

    await act(async () => {
      publish();
      await publication;
    });
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain("Partial changes saved");
    expect(content).toContain("No saved messages for this Agent result.");
    expect(renderer.root.findByProps({ role: "tabpanel" })).toBe(panel);
    expect(renderer.root.findByType("select").props.value).toBe(result.resultId);
    expect(fixture.history).toHaveBeenCalledOnce();
    const disclosure = renderer.root
      .findAllByType("button")
      .find((button) => typeof button.props["aria-expanded"] === "boolean")!;
    expect(disclosure.props["aria-expanded"]).toBe(true);
    expect(renderer.root.findByProps({ id: disclosure.props["aria-controls"] }).props.hidden).toBe(
      false,
    );
  }));

it("does not label an earlier completed result as partial when a run is canceled", () =>
  withClient(async () => {
    await mount({
      ...job,
      status: "cancelled",
      progress: { ...job.progress!, status: "cancelled", checkpoint: null },
    });
    const content = JSON.stringify(renderer.toJSON());
    expect(content).not.toMatch(/View saved (changes|result)/);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
  }));

it("allows cleanup metadata for a cancellation before the first Agent without calling it deleted", () =>
  withClient(async () => {
    fixture.list.mockResolvedValue({
      results: [],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
    });
    await mount({ ...job, status: "cancelled", progress: { ...job.progress!, hasThread: false } });
    expect(fixture.list).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain("No safely captured Agent result");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("deletion requested");
    expect(
      renderer.root
        .findAllByType("button")
        .some((b) => b.props.children === "Delete thread permanently"),
    ).toBe(true);
  }));
it("preserves explicit deletion when reopening a run and makes no saved-result read", () =>
  withClient(async () => {
    await mount({
      ...job,
      status: "done",
      progress: { ...job.progress!, threadDeletionRequested: true },
    });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("Thread deletion requested");
  }));
for (const state of [
  { data: capability(false), error: null, isPending: false },
  { data: null, error: null, isPending: false },
  { data: capability(), error: null, isPending: true },
  { data: capability(), error: "Offline", isPending: false },
])
  it(`does not offer deletion for unavailable capability ${JSON.stringify(state)}`, () =>
    withClient(async () => {
      appAtomRegistry.set(capabilitiesAtom, { ...state, errorTraceId: null });
      await mount({ ...job, status: "done" });
      expect(
        renderer.root
          .findAllByType("button")
          .some((b) => b.props.children === "Delete thread permanently"),
      ).toBe(false);
      expect(fixture.deletion).not.toHaveBeenCalled();
    }));
it("rechecks capabilities after confirmation before sending deletion", () =>
  withClient(async () => {
    fixture.confirm.mockImplementation(async () => {
      appAtomRegistry.set(capabilitiesAtom, {
        data: null,
        error: null,
        errorTraceId: null,
        isPending: false,
      });
      return true;
    });
    await mount({ ...job, status: "done" });
    await press("Delete thread permanently");
    expect(fixture.deletion).not.toHaveBeenCalled();
  }));
it("keeps deletion behind repository authority, completed cleanup and confirmation", () =>
  withClient(async () => {
    await mount({ ...job, status: "done" }, false);
    expect(
      renderer.root
        .findAllByType("button")
        .some((b) => b.props.children === "Delete thread permanently"),
    ).toBe(false);
    await act(() =>
      renderer.update(
        view({ ...job, status: "done", progress: { ...job.progress!, executionReleased: false } }),
      ),
    );
    expect(
      renderer.root
        .findAllByType("button")
        .some((b) => b.props.children === "Delete thread permanently"),
    ).toBe(false);
    await act(() => renderer.update(view({ ...job, status: "done" })));
    fixture.confirm.mockResolvedValue(false);
    await press("Delete thread permanently");
    expect(fixture.deletion).not.toHaveBeenCalled();
  }));
