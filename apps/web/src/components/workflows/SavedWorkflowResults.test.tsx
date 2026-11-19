import {
  act,
  createContext,
  createElement,
  useContext,
  type PropsWithChildren,
  type Ref,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  RelayRepositoryId,
  RelayTenancyConflictError,
  RelayTenancyNotFoundError,
  type RelayThreadHistoryPage,
} from "@t3tools/contracts/relay";
import { OrchestrationEvent, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import type { RepositoryWorkflowJob, WorkflowSavedResult } from "@t3tools/contracts/workflows";
import {
  setWorkflowSessionAccount,
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  settleWorkflowJobRequest,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { Atom } from "effect/unstable/reactivity";
import { ManagedRelay, type ManagedRelaySnapshotState } from "@t3tools/client-runtime/relay";
import type { RelayThreadDeletion, ThreadVmCapabilities } from "@t3tools/contracts/relay";
const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  history: vi.fn(),
  download: vi.fn(),
  deletion: vi.fn(),
  refresh: vi.fn(),
  target: vi.fn(),
  renderChange: vi.fn(),
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
vi.mock("./workflowState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workflowState")>()),
  useWorkflowClient: () => fixture.call,
}));
vi.mock("../diffs/StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: Record<string, unknown>) => createElement("pre", props),
}));
vi.mock("../chat/SavedConversationMessage", () => ({
  SavedConversationMessage: ({
    message,
    onDownload,
  }: {
    message: { text: string; attachments?: ReadonlyArray<ChatAttachment> };
    onDownload: (attachment: ChatAttachment) => void;
  }) => (
    <>
      <p>{message.text}</p>
      {message.attachments?.map((attachment) => (
        <button key={attachment.id} onClick={() => onDownload(attachment)}>
          {attachment.name}
        </button>
      ))}
    </>
  ),
}));
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
vi.mock("../ui/combobox", () => {
  type PickerState = {
    value: WorkflowSavedResult | null;
    items: ReadonlyArray<WorkflowSavedResult>;
    onValueChange: (value: WorkflowSavedResult) => void;
    inputValue: string;
    onInputValueChange: (
      value: string,
      details: { reason: "input-change" | "input-clear" },
    ) => void;
  };
  const PickerContext = createContext<PickerState | null>(null);
  const part = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Combobox: ({ children, ...state }: PropsWithChildren<PickerState>) =>
      createElement(
        PickerContext.Provider,
        { value: state },
        createElement(
          "div",
          { "data-result-picker": true, "data-selection": state.value?.resultId },
          children,
        ),
      ),
    ComboboxTrigger: ({
      children,
      render: _render,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => createElement("button", props, children),
    ComboboxPopup: ({ children, ref }: PropsWithChildren<{ ref?: Ref<HTMLDivElement> }>) =>
      createElement("div", { ref, "data-result-picker-popup": true }, children),
    ComboboxList: part,
    ComboboxItem: ({ children, value }: PropsWithChildren<{ value: WorkflowSavedResult }>) => {
      const picker = useContext(PickerContext)!;
      return createElement(
        "button",
        {
          role: "option",
          "aria-selected": picker.value?.resultId === value.resultId,
          "data-result-id": value.resultId,
          onClick: () => {
            picker.onValueChange(value);
            if (picker.inputValue) picker.onInputValueChange("", { reason: "input-clear" });
          },
        },
        children,
      );
    },
    ComboboxSearchInput: (props: Record<string, unknown>) => {
      const picker = useContext(PickerContext)!;
      return createElement("input", {
        value: picker.inputValue,
        onChange: (event: { target: { value: string } }) =>
          picker.onInputValueChange(event.target.value, { reason: "input-change" }),
        ...props,
      });
    },
    ComboboxStatus: ({ children }: PropsWithChildren) =>
      createElement("div", { role: "status" }, children),
    ComboboxEmpty: ({ children }: PropsWithChildren) =>
      useContext(PickerContext)!.items.length === 0
        ? createElement("div", { role: "status" }, children)
        : null,
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
import { SavedWorkflowResults } from "./SavedWorkflowResults";
import { WorkflowRequestNotSentError } from "./workflowOperations";
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
const decodeHistoryEvent = Schema.decodeUnknownSync(OrchestrationEvent);
function historyEntry(cursor: number, type: OrchestrationEvent["type"], payload: object) {
  const threadId = job.progress!.threadId;
  return {
    cursor,
    environmentId: "environment",
    event: decodeHistoryEvent({
      type,
      payload: { threadId, updatedAt: result.createdAt, ...payload },
      sequence: cursor,
      eventId: `event-${cursor}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: result.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    }),
  };
}
const savedConversationStart = () =>
  historyEntry(1, "thread.created", {
    projectId: "project",
    title: "Release notes",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    branch: null,
    worktreePath: null,
    createdAt: result.createdAt,
  });
const savedMessage = (cursor: number, text: string, attachments?: ReadonlyArray<unknown>) =>
  historyEntry(cursor, "thread.message-sent", {
    messageId: `message-${cursor}`,
    role: "assistant",
    text,
    ...(attachments ? { attachments } : {}),
    turnId: result.turnId,
    streaming: false,
    createdAt: result.createdAt,
  });
let renderer: ReactTestRenderer;
const view = (currentJob = job, canConfigure = true, showCancellationDetail = true) =>
  createElement(
    AppAtomRegistryProvider,
    null,
    createElement(SavedWorkflowResults, {
      scope,
      job: currentJob,
      refresh: fixture.refresh,
      canConfigure,
      onReviewTargetChange: fixture.target,
      onReviewRenderChange: fixture.renderChange,
      showCancellationDetail,
    }),
  );
async function mount(
  currentJob = job,
  canConfigure = true,
  options?: Parameters<typeof create>[1],
) {
  await act(async () => {
    renderer = create(view(currentJob, canConfigure), options);
  });
}
const findButton = (label: string, root = renderer.root) =>
  root
    .findAllByType("button")
    .find((button) => button.props["aria-label"] === label || button.children.includes(label));
const findPicker = () => renderer.root.findAllByProps({ "data-result-picker": true })[0];
const pickerOptions = () => findPicker()?.findAllByProps({ role: "option" }) ?? [];
const pickerSearch = () => findPicker()!.findByType("input");
async function selectSavedResult(resultId: string) {
  const option = pickerOptions().find((entry) => entry.props["data-result-id"] === resultId);
  expect(option).toBeDefined();
  await act(() => option!.props.onClick());
}
async function searchSavedResults(value: string) {
  await act(() => pickerSearch().props.onChange({ target: { value } }));
}
const deleteDialog = () => renderer.root.findAllByProps({ role: "alertdialog" })[0];
async function press(label: string, root = renderer.root) {
  const button = findButton(label, root);
  expect(button).toBeDefined();
  await act(async () => {
    await button!.props.onClick();
  });
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  fixture.download.mockReset().mockResolvedValue(new Uint8Array([42]));
  fixture.deletion.mockImplementation(async ({ threadId, payload }) => ({
    threadId,
    operationId: payload.operationId,
    generation: payload.expectedGeneration,
    phase: "stopping",
    errorCode: null,
  }));
  fixture.refresh.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const withClient = async (test: (client: { relayUrl: string }) => Promise<void>) => {
  // Model the HTTP transport boundary with promises; the component owns no Effect runtime.
  let response: unknown;
  const transport = (method: typeof fixture.list) => (input: unknown) => {
    response = method(input);
    return Effect.void;
  };
  const client = {
    relayUrl: "https://relay.invalid",
    listSavedWorkflowResults: (input: unknown) => {
      const relayUrl = client.relayUrl;
      response = Promise.resolve(fixture.list(input)).then((data) => ({ ...data, relayUrl }));
      return Effect.void;
    },
    readSavedWorkflowResult: transport(fixture.read),
    getSavedWorkflowHistory: transport(fixture.history),
    downloadSavedWorkflowAttachment: transport(fixture.download),
    permanentlyDeleteThread: transport(fixture.deletion),
  };
  fixture.call.mockImplementation(
    (operation: (transportClient: typeof client, token: string) => unknown) => {
      operation(client, "test");
      return Promise.resolve(response);
    },
  );
  await test(client);
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

it("requires a fresh render when returning to the same saved review result", () =>
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
    });
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === earlier.resultId ? earlier : result,
      patch,
    }));
    await mount();
    const renderFirstReview = renderer.root.findByType("pre").props.options.onPostRender;
    await act(() => renderFirstReview());
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.renderChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpointId: "checkpoint" }),
    );

    await searchSavedResults("unmatched");
    expect(pickerOptions().map((option) => option.props["data-result-id"])).toEqual([
      result.resultId,
    ]);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.renderChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpointId: "checkpoint" }),
    );
    await searchSavedResults("");

    await selectSavedResult(earlier.resultId);
    expect(fixture.renderChange).toHaveBeenLastCalledWith(null);
    const renderEarlier = renderer.root.findByType("pre").props.options.onPostRender;
    await selectSavedResult(result.resultId);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.renderChange).toHaveBeenLastCalledWith(null);
    await act(() => {
      renderFirstReview();
      renderEarlier();
    });
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.renderChange).toHaveBeenLastCalledWith(null);

    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
    expect(fixture.renderChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpointId: "checkpoint" }),
    );
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
    await selectSavedResult(next.resultId);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(next.resultId);
    await act(async () => {
      resolve({ result, patch });
    });
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(next.resultId);
    expect(fixture.refresh).not.toHaveBeenCalled();
  }));

const completedJob: RepositoryWorkflowJob = {
  ...job,
  status: "done",
  progress: { ...job.progress!, status: "done", revision: 2 },
};
const completedWithCheckpoint: RepositoryWorkflowJob = {
  ...completedJob,
  progress: {
    ...completedJob.progress!,
    checkpoint: { ...job.progress!.checkpoint!, checkpointId: "completion-checkpoint" },
  },
};

it("keeps the selected diff visible when completing with an available saved result", () =>
  withClient(async () => {
    await mount();
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    fixture.list.mockRejectedValue(new Error("The result index is temporarily unavailable."));

    await act(() => renderer.update(view(completedWithCheckpoint)));

    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    expect(findButton("Retry loading results")).toBeDefined();

    await press("Conversation");
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
    const historyReads = fixture.history.mock.calls.length;
    fixture.list.mockResolvedValueOnce({
      results: [result],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
    });
    await press("Retry loading results");

    expect(findButton("Retry loading results")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
    expect(fixture.history).toHaveBeenCalledTimes(historyReads);
  }));

it("keeps the selected patch error retryable when the completion index refresh succeeds", () =>
  withClient(async () => {
    const patchError = "The selected patch could not be opened.";
    fixture.read.mockRejectedValueOnce(new Error(patchError));
    await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain(patchError);

    await act(() => renderer.update(view(completedWithCheckpoint)));

    expect(JSON.stringify(renderer.toJSON())).toContain(patchError);
    await press("Retry changes");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
  }));

it("keeps the open conversation and loaded pages of earlier results when the run completes", () =>
  withClient(async () => {
    const earlier = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      stepId: "Earlier Agent",
    };
    const oldest = {
      ...result,
      resultId: "44444444-4444-4444-8444-444444444444",
      stepId: "Oldest Agent",
    };
    const finalResult = {
      ...result,
      resultId: "55555555-5555-4555-8555-555555555555",
      stepId: "Final Agent",
    };
    const firstPage = { results: [result], nextCursor: 10, threadId: "thread", generation: 1 };
    fixture.list.mockImplementation(async ({ before }) =>
      before === 10 ? { ...firstPage, results: [earlier, oldest], nextCursor: null } : firstPage,
    );
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === earlier.resultId ? earlier : result,
      patch,
    }));
    await mount();
    await press("Load older results");
    await selectSavedResult(earlier.resultId);
    await press("Conversation");

    const content = () => JSON.stringify(renderer.toJSON());
    expect(content()).toContain("No saved messages for this Agent result.");
    expect(content()).toContain("Oldest Agent");
    expect(content()).not.toContain("Final Agent");

    fixture.list.mockResolvedValueOnce({
      ...firstPage,
      generation: 2,
      results: [finalResult, result],
    });
    await act(() => renderer.update(view(completedWithCheckpoint)));

    expect(findPicker()?.props["data-selection"]).toBe(earlier.resultId);
    expect(content()).toContain("No saved messages for this Agent result.");
    expect(content()).toContain("Final Agent");
    expect(content()).toContain("Oldest Agent");
    expect(findButton("Load older results")).toBeUndefined();
  }));

it.each([null, 4] as const)(
  "skips retained results after filling the gap with cached cursor %s",
  (cachedCursor) =>
    withClient(async () => {
      const oldest = {
        ...result,
        resultId: "33333333-3333-4333-8333-333333333333",
        stepId: "Oldest Agent",
      };
      const middle = {
        ...result,
        resultId: "44444444-4444-4444-8444-444444444444",
        stepId: "Middle Agent",
      };
      const finalResult = {
        ...result,
        resultId: "55555555-5555-4555-8555-555555555555",
        stepId: "Final Agent",
      };
      const uncached = {
        ...result,
        resultId: "66666666-6666-4666-8666-666666666666",
        stepId: "Previously unloaded Agent",
      };
      const firstPage = { results: [result], nextCursor: 10, threadId: "thread", generation: 1 };
      const finalPage = { ...firstPage, results: [finalResult], nextCursor: 30 };
      fixture.list.mockImplementation(async ({ before }) => {
        if (before === 10) return { ...firstPage, results: [oldest], nextCursor: cachedCursor };
        if (before === 30) return { ...firstPage, results: [middle, result], nextCursor: 10 };
        if (before === 4) return { ...firstPage, results: [uncached], nextCursor: null };
        return firstPage;
      });
      await mount();
      await press("Load older results");
      fixture.list.mockResolvedValueOnce(finalPage);
      await act(() => renderer.update(view(completedWithCheckpoint)));
      fixture.list.mockResolvedValueOnce(finalPage);
      await act(() =>
        renderer.update(
          view({
            ...completedWithCheckpoint,
            progress: {
              ...completedWithCheckpoint.progress!,
              revision: 3,
              resultSaving: {
                publicationId: "77777777-7777-4777-8777-777777777777",
                resultId: null,
                state: "saved",
                detail: null,
                retryable: false,
              },
            },
          }),
        ),
      );

      const resultIds = () => pickerOptions().map((option) => option.props["data-result-id"]);
      expect(resultIds()).toEqual([finalResult.resultId, result.resultId, oldest.resultId]);

      await press("Load older results");

      expect(resultIds()).toEqual([
        finalResult.resultId,
        middle.resultId,
        result.resultId,
        oldest.resultId,
      ]);
      expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
      if (cachedCursor !== null) {
        await press("Load older results");
        expect(fixture.list).toHaveBeenLastCalledWith(
          expect.objectContaining({ before: cachedCursor }),
        );
        expect(resultIds().at(-1)).toBe(uncached.resultId);
      }
      expect(findButton("Load older results")).toBeUndefined();
    }),
);

it("hides loaded results when the completion refresh reports that the thread is gone", () =>
  withClient(async () => {
    await mount();
    expect(renderer.root.findByType("pre")).toBeDefined();
    fixture.list.mockRejectedValueOnce(
      ManagedRelay.relayRequestError("listSavedWorkflowResults")(
        new RelayTenancyNotFoundError({
          code: "tenancy_not_found",
          reason: "thread_not_found",
          traceId: "deleted-thread",
        }),
      ),
    );

    await act(() => renderer.update(view(completedWithCheckpoint)));

    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    expect(findPicker()).toBeUndefined();
  }));

it("checks again for saved results when a run finishes with an empty index", () =>
  withClient(async () => {
    const page = { results: [result], nextCursor: null, threadId: "thread", generation: 1 };
    fixture.list.mockResolvedValueOnce({ ...page, results: [] }).mockResolvedValue(page);
    await mount();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);

    await act(() => renderer.update(view(completedJob)));

    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
  }));

it("retries the exact deletion after an uncertain reply, even if the result index changes", () =>
  withClient(async () => {
    fixture.deletion.mockRejectedValueOnce(new Error("Reply lost"));
    const finished = { ...job, status: "done" } as const;
    await mount(finished);
    await press("Delete thread permanently");

    expect(deleteDialog()).toBeDefined();
    expect(fixture.deletion).not.toHaveBeenCalled();
    await press("Delete thread", deleteDialog());
    expect(deleteDialog()).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Deletion not confirmed");
    expect(renderer.root.findByType("pre")).toBeDefined();

    expect(fixture.deletion).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "test",
      threadId: "thread",
      payload: {
        operationId: expect.any(String),
        expectedGeneration: 1,
        confirmWorkspaceLoss: true,
      },
    });
    const submitted = fixture.deletion.mock.calls[0]![0];

    fixture.call.mockRejectedValueOnce(
      new WorkflowRequestNotSentError("The workflow connection changed."),
    );
    await press("Retry deletion");
    expect(deleteDialog()).toBeUndefined();
    expect(fixture.deletion).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/deletion.{0,24}not sent/i);

    const reads = fixture.list.mock.calls.length;
    fixture.list.mockResolvedValue({
      results: [result],
      nextCursor: null,
      threadId: "updated-thread",
      generation: 2,
      relayUrl: "https://relay.invalid",
    });
    await act(() =>
      renderer.update(
        view({
          ...finished,
          progress: {
            ...job.progress!,
            checkpoint: { ...job.progress!.checkpoint!, checkpointId: "refreshed-checkpoint" },
          },
        }),
      ),
    );
    expect(fixture.list.mock.calls.length).toBeGreaterThan(reads);

    let accept!: (receipt: RelayThreadDeletion) => void;
    fixture.deletion.mockImplementationOnce(
      () => new Promise<RelayThreadDeletion>((resolve) => (accept = resolve)),
    );
    const retry = findButton("Retry deletion");
    expect(retry).toBeDefined();
    await act(async () => {
      void retry!.props.onClick();
    });
    expect(deleteDialog()).toBeUndefined();
    expect(fixture.deletion.mock.calls).toEqual([[submitted], [submitted]]);
    const pending = JSON.stringify(renderer.toJSON());
    expect(pending).toContain("Requesting deletion…");
    expect(pending).not.toContain("Deletion requested");
    await act(() =>
      accept({
        threadId: ThreadId.make("thread"),
        operationId: submitted.payload.operationId,
        generation: 1,
        phase: "stopping",
        errorCode: null,
      }),
    );
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain("Deletion requested");
    expect(content).not.toContain("Deletion not confirmed");
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  }));

const deletionFailure = ManagedRelay.relayRequestError("permanently delete thread");

it.each([
  ["thread", 1],
  ["thread", 2],
  ["replacement-thread", 2],
] as const)(
  "checks thread %s generation %s after the relay blocks deletion",
  (threadId, generation) =>
    withClient(async () => {
      await mount({ ...job, status: "done" });
      const reads = fixture.list.mock.calls.length;
      const freshResult =
        threadId === "thread"
          ? result
          : {
              ...result,
              resultId: "77777777-7777-4777-8777-777777777777",
              stepId: "Replacement Agent",
            };
      fixture.list.mockResolvedValue({
        results: [freshResult],
        nextCursor: null,
        threadId,
        generation,
      });
      fixture.read.mockResolvedValue({ result: freshResult, patch });
      fixture.deletion.mockRejectedValueOnce(
        deletionFailure(
          new RelayTenancyConflictError({
            code: "tenancy_conflict",
            reason: "thread_deletion_conflict",
            traceId: "deletion-conflict",
          }),
        ),
      );
      await press("Delete thread permanently");
      await press("Delete thread", deleteDialog());

      expect(fixture.list.mock.calls.length).toBeGreaterThan(reads);
      expect(fixture.deletion).toHaveBeenCalledOnce();
      const submitted = fixture.deletion.mock.calls[0]![0];
      expect(submitted.payload.expectedGeneration).toBe(1);
      if (generation === 1) {
        expect(JSON.stringify(renderer.toJSON())).toMatch(/blocked|could not request deletion/i);
        await press("Retry deletion");
        expect(deleteDialog()).toBeUndefined();
        expect(fixture.deletion.mock.calls).toEqual([[submitted], [submitted]]);
      } else {
        expect(findButton("Retry deletion")).toBeUndefined();
        expect(renderer.root.findByType("pre").props.items[0].id).toContain(freshResult.resultId);
        await press("Delete thread permanently");
        expect(deleteDialog()).toBeDefined();
        expect(fixture.deletion).toHaveBeenCalledOnce();
        await press("Delete thread", deleteDialog());
        expect(fixture.deletion).toHaveBeenLastCalledWith({
          ...submitted,
          threadId,
          payload: { ...submitted.payload, operationId: expect.any(String), expectedGeneration: 2 },
        });
        expect(fixture.deletion.mock.calls[1]![0].payload.operationId).not.toBe(
          submitted.payload.operationId,
        );
      }
    }),
);

it("hides cached results while reconciling a deletion the relay can no longer find", () =>
  withClient(async () => {
    const finished = { ...job, status: "done" } as const;
    await mount(finished);
    expect(renderer.root.findByType("pre")).toBeDefined();
    const unavailable = deletionFailure(
      new RelayTenancyNotFoundError({
        code: "tenancy_not_found",
        reason: "thread_not_found",
        traceId: "deleted-thread",
      }),
    );
    fixture.deletion.mockRejectedValueOnce(unavailable);
    fixture.list.mockRejectedValue(unavailable);
    await press("Delete thread permanently");
    await press("Delete thread", deleteDialog());

    expect(fixture.refresh).toHaveBeenCalled();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    expect(findButton("Retry deletion")).toBeUndefined();
    expect(findButton("Delete thread permanently")?.props.disabled ?? true).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Deletion requested");

    await act(() =>
      renderer.update(
        view({
          ...finished,
          progress: { ...job.progress!, threadDeletionRequested: true },
        }),
      ),
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Deletion requested");
    expect(fixture.deletion).toHaveBeenCalledOnce();
  }));

it("restores only read access when the deletion endpoint hides lost maintainer authority", () =>
  withClient(async () => {
    await mount({ ...job, status: "done" });
    fixture.deletion.mockRejectedValueOnce(
      deletionFailure(
        new RelayTenancyNotFoundError({
          code: "tenancy_not_found",
          reason: "thread_not_found",
          traceId: "demoted-maintainer",
        }),
      ),
    );
    await press("Delete thread permanently");
    await press("Delete thread", deleteDialog());

    expect(fixture.refresh).toHaveBeenCalled();
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    expect(JSON.stringify(renderer.toJSON())).toContain("Deletion unavailable");
    expect(findButton("Retry deletion")).toBeUndefined();
    expect(findButton("Delete thread permanently")).toBeUndefined();
  }));

it("only retries an uncertain request when reconnected to its original relay", () =>
  withClient(async (client) => {
    const originalRelay = client.relayUrl;
    fixture.deletion.mockRejectedValueOnce(new Error("Reply lost"));
    await mount({ ...job, status: "done" });
    await press("Delete thread permanently");
    await press("Delete thread", deleteDialog());
    const submitted = fixture.deletion.mock.calls[0]![0];

    client.relayUrl = "https://replacement.invalid";
    await press("Retry deletion");
    expect(fixture.deletion).toHaveBeenCalledOnce();
    expect(findButton("Retry deletion")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("original relay");

    client.relayUrl = originalRelay;
    await press("Refresh saved results");
    await press("Retry deletion");
    expect(fixture.deletion.mock.calls).toEqual([[submitted], [submitted]]);
  }));

it("requires fresh confirmation when the first deletion request was never sent", () =>
  withClient(async () => {
    await mount({ ...job, status: "done" });
    await press("Delete thread permanently");
    fixture.call.mockRejectedValueOnce(
      new WorkflowRequestNotSentError("The workflow connection changed."),
    );
    await press("Delete thread", deleteDialog());

    expect(fixture.refresh).toHaveBeenCalled();
    expect(fixture.deletion).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toMatch(
      /deletion.{0,24}not sent|request was not sent/i,
    );
    expect(findButton("Retry deletion")).toBeUndefined();

    await press("Delete thread permanently");
    expect(deleteDialog()).toBeDefined();
    expect(fixture.deletion).not.toHaveBeenCalled();
    await press("Delete thread", deleteDialog());
    expect(fixture.deletion).toHaveBeenCalledOnce();
  }));

it("rechecks a different thread returned by a page before showing its saved results", () =>
  withClient(async () => {
    const currentPage = { results: [result], nextCursor: 1, threadId: "thread", generation: 1 };
    const replacement = { ...result, resultId: "66666666-6666-4666-8666-666666666666" };
    const replacementPage = {
      results: [replacement],
      nextCursor: null,
      threadId: "replacement-thread",
      generation: 2,
    };
    const recheck = deferred<typeof replacementPage>();
    fixture.list
      .mockResolvedValueOnce(currentPage)
      .mockResolvedValueOnce(replacementPage)
      .mockReturnValueOnce(recheck.promise);
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === replacement.resultId ? replacement : result,
      patch,
    }));
    await mount({ ...job, status: "done" });

    await press("Load older results");
    expect(findPicker()).toBeUndefined();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    expect(fixture.list.mock.calls.map(([input]) => input.before)).toEqual([
      undefined,
      1,
      undefined,
    ]);

    await act(() => recheck.resolve(replacementPage));
    expect(pickerOptions().map((option) => option.props["data-result-id"])).toEqual([
      replacement.resultId,
    ]);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(replacement.resultId);
  }));

it("retries the same older page without reloading a conversation selected while paging", () =>
  withClient(async () => {
    const earlier = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      stepId: "Earlier Agent",
    };
    const oldest = {
      ...result,
      resultId: "44444444-4444-4444-8444-444444444444",
      stepId: "Oldest Agent",
    };
    const page = { results: [result, earlier], nextCursor: 10, threadId: "thread", generation: 1 };
    const attempt = deferred<typeof page>();
    fixture.list
      .mockResolvedValueOnce(page)
      .mockReturnValueOnce(attempt.promise)
      .mockResolvedValueOnce({
        ...page,
        results: [{ ...earlier, patch: { ...earlier.patch } }, oldest],
        nextCursor: null,
      });
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === earlier.resultId ? earlier : result,
      patch,
    }));
    await mount();
    await searchSavedResults("agent");
    await press("Load older results");
    expect(JSON.stringify(renderer.toJSON())).toContain("Loading older results…");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);

    await selectSavedResult(earlier.resultId);
    await press("Conversation");
    const conversation = renderer.root.findByProps({ role: "tabpanel" });
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
    expect(fixture.history).toHaveBeenLastCalledWith(
      expect.objectContaining({ resultId: earlier.resultId }),
    );
    const historyReads = fixture.history.mock.calls.length;

    await act(() => attempt.reject(new Error("Temporarily disconnected")));
    expect(JSON.stringify(renderer.toJSON())).toContain("Couldn’t load older results");
    expect(pickerSearch().props.value).toBe("agent");
    expect(findButton("Retry", conversation)).toBeUndefined();
    await press("Retry loading older results");

    expect(fixture.list.mock.calls.slice(1).map(([input]) => input.before)).toEqual([10, 10]);
    expect(findPicker()?.props["data-selection"]).toBe(earlier.resultId);
    expect(pickerSearch().props.value).toBe("agent");
    expect(pickerOptions().map((option) => option.props["data-result-id"])).toEqual([
      result.resultId,
      earlier.resultId,
      oldest.resultId,
    ]);
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
    expect(fixture.history).toHaveBeenCalledTimes(historyReads);
    expect(findButton("Retry loading older results")).toBeUndefined();
    expect(findButton("Load older results")).toBeUndefined();
    await searchSavedResults("");
    expect(pickerSearch().props.value).toBe("");
  }));

it("keeps a late index refresh from restoring saved results after paging reports loss of access", () =>
  withClient(async () => {
    const firstPage = { results: [result], nextCursor: 10, threadId: "thread", generation: 1 };
    const refresh = deferred<typeof firstPage>();
    const olderPage = deferred<typeof firstPage>();
    fixture.list
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(olderPage.promise);
    await mount(completedJob);
    await act(() => renderer.update(view(completedWithCheckpoint)));
    await press("Load older results");

    await act(() =>
      olderPage.reject(
        ManagedRelay.relayRequestError("listSavedWorkflowResults")(
          new RelayTenancyNotFoundError({
            code: "tenancy_not_found",
            reason: "thread_not_found",
            traceId: "deleted-thread",
          }),
        ),
      ),
    );
    expect(findPicker()).toBeUndefined();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);

    await act(() => refresh.resolve(firstPage));
    expect(findPicker()).toBeUndefined();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
  }));

it.each(["open popup", "closed trigger", "elsewhere"] as const)(
  "clears saved results after an obsolete-cursor denial with focus on %s",
  (focusBeforeDenial) =>
    withClient(async () => {
      const firstPage = { results: [result], nextCursor: 10, threadId: "thread", generation: 1 };
      const olderPage = deferred<typeof firstPage>();
      fixture.list
        .mockResolvedValueOnce(firstPage)
        .mockReturnValueOnce(olderPage.promise)
        .mockResolvedValueOnce({ ...firstPage, nextCursor: 30 });

      const body = {};
      const ownerDocument = { ...document, body, activeElement: body };
      vi.stubGlobal("document", ownerDocument);
      const focusTarget = () => {
        const node = {
          ownerDocument,
          focus: vi.fn(() => {
            ownerDocument.activeElement = node;
          }),
        };
        return node;
      };
      const trigger = focusTarget();
      const search = focusTarget();
      const section = focusTarget();
      const popup = { ownerDocument, contains: (node: unknown) => node === search };
      await mount(completedJob, true, {
        createNodeMock: ({ type, props }) => {
          const host = props as { "aria-label"?: string; "data-result-picker-popup"?: boolean };
          const label = host["aria-label"];
          if (type === "input") return search;
          if (host["data-result-picker-popup"]) return popup;
          if (type === "button" && typeof label === "string" && label.startsWith("Saved result:"))
            return trigger;
          return label === "Saved workflow results" ? section : null;
        },
      });
      await press("Load older results");
      expect(ownerDocument.activeElement).toBe(search);
      // Base UI returns focus to the trigger when Escape closes the popup.
      if (focusBeforeDenial !== "open popup") trigger.focus();
      const outside = focusTarget();
      if (focusBeforeDenial === "elsewhere") outside.focus();

      await act(() => renderer.update(view(completedWithCheckpoint)));
      expect(fixture.list.mock.calls.map(([input]) => input.before)).toEqual([
        undefined,
        10,
        undefined,
      ]);
      expect(findPicker()).toBeDefined();
      expect(renderer.root.findByType("pre")).toBeDefined();

      await act(() =>
        olderPage.reject(
          ManagedRelay.relayRequestError("listSavedWorkflowResults")(
            new RelayTenancyNotFoundError({
              code: "tenancy_not_found",
              reason: "thread_not_found",
              traceId: "deleted-thread",
            }),
          ),
        ),
      );
      expect(findPicker()).toBeUndefined();
      expect(renderer.root.findAllByType("pre")).toHaveLength(0);
      expect(ownerDocument.activeElement).toBe(
        focusBeforeDenial === "elsewhere" ? outside : section,
      );
    }),
);

it("keeps replacement thread results visible after a late denial from the previous thread", () =>
  withClient(async () => {
    const firstPage = { results: [result], nextCursor: 10, threadId: "thread", generation: 1 };
    const replacement = { ...result, resultId: "66666666-6666-4666-8666-666666666666" };
    const olderPage = deferred<typeof firstPage>();
    fixture.list
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValueOnce({
        results: [replacement],
        nextCursor: 30,
        threadId: "replacement-thread",
        generation: 2,
      });
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === replacement.resultId ? replacement : result,
      patch,
    }));
    await mount(completedJob);
    await press("Load older results");
    await act(() => renderer.update(view(completedWithCheckpoint)));
    await selectSavedResult(replacement.resultId);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(replacement.resultId);

    await act(() =>
      olderPage.reject(
        ManagedRelay.relayRequestError("listSavedWorkflowResults")(
          new RelayTenancyNotFoundError({
            code: "tenancy_not_found",
            reason: "thread_not_found",
            traceId: "replaced-thread",
          }),
        ),
      ),
    );
    expect(findPicker()?.props["data-selection"]).toBe(replacement.resultId);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(replacement.resultId);
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
    expect(JSON.stringify(renderer.toJSON())).toContain('"Read-only"');
    await selectSavedResult(earlier.resultId);
    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.target).toHaveBeenLastCalledWith(false);
    expect(JSON.stringify(renderer.toJSON())).toContain('"Read-only result"');
    await press("Return to current review");
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    expect(fixture.target).toHaveBeenLastCalledWith(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('"Read-only"');
    await act(() => renderer.root.findByType("pre").props.options.onPostRender());
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
  }));
it("keeps an opened diff in place when a new checkpoint arrives until Review latest", () =>
  withClient(async () => {
    const earlier = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      turnId: "earlier",
    };
    fixture.list.mockResolvedValue({
      results: [result, earlier],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
    });
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === earlier.resultId ? earlier : result,
      patch,
    }));
    await mount();
    await selectSavedResult(earlier.resultId);
    await selectSavedResult(result.resultId);
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

      await selectSavedResult(earlier.resultId);
      expect(renderer.root.findByType("pre").props.items[0].id).toContain(earlier.resultId);
      const content = JSON.stringify(renderer.toJSON());
      expect(content).not.toContain("A newer result needs review");
      expect(content).not.toContain("Return to current review");
      expect(content).not.toContain("Decisions apply to the current review");
      await press("Open result for final checks");
      expect(renderer.root.findByType("pre").props.items[0].id).toContain(result.resultId);
    }),
);

it("retries the initial results list before loading the selected patch", () =>
  withClient(async () => {
    fixture.list.mockRejectedValueOnce(new Error("Saved storage unavailable."));
    await mount(completedJob);

    expect(JSON.stringify(renderer.toJSON())).toContain("Couldn’t load the results list");
    expect(fixture.read).not.toHaveBeenCalled();

    await press("Retry loading results");
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(fixture.read).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resultId: result.resultId }),
    );
    expect(findPicker()?.props["data-selection"]).toBe(result.resultId);
    expect(findButton("Retry loading results")).toBeUndefined();
  }));

it("retries Changes for the selected result and keeps its previously loaded conversation", () =>
  withClient(async () => {
    const earlier = {
      ...result,
      resultId: "33333333-3333-4333-8333-333333333333",
      stepId: "Earlier Agent",
    };
    fixture.list.mockResolvedValue({
      results: [result, earlier],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
    });
    fixture.read
      .mockResolvedValueOnce({ result, patch })
      .mockRejectedValueOnce(new Error("Saved patch unavailable."))
      .mockResolvedValueOnce({ result: earlier, patch });
    await mount(completedJob);
    await selectSavedResult(earlier.resultId);

    expect(JSON.stringify(renderer.toJSON())).toContain("Couldn’t load changes");
    await press("Conversation");
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
    expect(findButton("Retry changes")).toBeUndefined();

    await press("Changes");
    await press("Retry changes");
    expect(findPicker()?.props["data-selection"]).toBe(earlier.resultId);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(earlier.resultId);
    expect(fixture.list).toHaveBeenCalledOnce();
    expect(fixture.read.mock.calls.map(([input]) => input.resultId)).toEqual([
      result.resultId,
      earlier.resultId,
      earlier.resultId,
    ]);
    await press("Conversation");
    expect(fixture.history).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resultId: earlier.resultId }),
    );
  }));

const savedThreadNotFound = (
  action: "getSavedWorkflowHistory" | "listSavedWorkflowResults" | "read saved thread attachment",
) =>
  ManagedRelay.relayRequestError(action)(
    new RelayTenancyNotFoundError({
      code: "tenancy_not_found",
      reason: "thread_not_found",
      traceId: "missing-thread-read",
    }),
  );

it("keeps the selected result when a missing conversation rechecks accessible results", () =>
  withClient(async () => {
    fixture.history.mockRejectedValueOnce(savedThreadNotFound("getSavedWorkflowHistory"));
    await mount(completedJob);
    await press("Conversation");

    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(findPicker()?.props["data-selection"]).toBe(result.resultId);
    expect(findButton("Retry conversation")).toBeDefined();
    expect(findButton("Retry loading results")).toBeUndefined();

    await press("Retry conversation");
    expect(fixture.history.mock.calls.map(([input]) => [input.resultId, input.after])).toEqual([
      [result.resultId, 0],
      [result.resultId, 0],
    ]);
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(fixture.read).toHaveBeenCalledOnce();
    expect(findButton("Retry conversation")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("No saved messages for this Agent result.");
  }));

it("clears cached results when a previous selection's denial is confirmed for the same thread", () =>
  withClient(async () => {
    const other = { ...result, resultId: "33333333-3333-4333-8333-333333333333" };
    fixture.list
      .mockResolvedValueOnce({
        results: [result, other],
        nextCursor: null,
        threadId: "thread",
        generation: 1,
      })
      .mockRejectedValueOnce(savedThreadNotFound("listSavedWorkflowResults"));
    fixture.read.mockImplementation(async ({ resultId }) => ({
      result: resultId === other.resultId ? other : result,
      patch,
    }));
    const firstConversation = deferred<RelayThreadHistoryPage>();
    fixture.history.mockReturnValueOnce(firstConversation.promise);
    await mount(completedJob);
    await selectSavedResult(other.resultId);
    await selectSavedResult(result.resultId);
    await press("Conversation");
    await selectSavedResult(other.resultId);
    await press("Changes");

    expect(findPicker()?.props["data-selection"]).toBe(other.resultId);
    expect(renderer.root.findByType("pre").props.items[0].id).toContain(other.resultId);
    expect(fixture.read).toHaveBeenCalledTimes(2);

    await act(() => firstConversation.reject(savedThreadNotFound("getSavedWorkflowHistory")));

    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(findPicker()).toBeUndefined();
    expect(renderer.root.findAllByType("pre")).toHaveLength(0);
    expect(findButton("Retry loading results")).toBeDefined();
  }));

it("checks a later ambiguous denial even while an earlier access check is pending", () =>
  withClient(async () => {
    const accessibleIndex = {
      results: [result],
      nextCursor: null,
      threadId: "thread",
      generation: 1,
    };
    const firstProof = deferred<typeof accessibleIndex>();
    fixture.list
      .mockResolvedValueOnce(accessibleIndex)
      .mockReturnValueOnce(firstProof.promise)
      .mockRejectedValueOnce(savedThreadNotFound("listSavedWorkflowResults"));
    const attachments = ["release-notes", "rollback-steps"].map((id) => ({
      type: "file",
      id,
      name: `${id}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
    }));
    fixture.history.mockResolvedValue({
      entries: [savedConversationStart(), savedMessage(2, "Release report", attachments)],
    } satisfies RelayThreadHistoryPage);
    fixture.download.mockRejectedValue(savedThreadNotFound("read saved thread attachment"));
    await mount(completedJob);
    await press("Conversation");
    await act(async () => {
      void findButton("release-notes.txt")!.props.onClick();
    });
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(findPicker()?.props["data-selection"]).toBe(result.resultId);

    await act(async () => {
      void findButton("rollback-steps.txt")!.props.onClick();
    });
    expect(fixture.list).toHaveBeenCalledTimes(3);
    expect(findPicker()).toBeUndefined();
    expect(findButton("Retry loading results")).toBeDefined();

    await act(() => firstProof.resolve(accessibleIndex));
    expect(findPicker()).toBeUndefined();
    expect(findButton("release-notes.txt")).toBeUndefined();
    expect(findButton("Retry download")).toBeUndefined();
    expect(findButton("Retry loading results")).toBeDefined();
  }));

it("coalesces concurrent downloads of the same attachment and allows retry after failure", () =>
  withClient(async () => {
    const attachment = {
      type: "file",
      id: "release-report",
      name: "release-report.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    };
    const attempt = deferred<Uint8Array>();
    fixture.history.mockResolvedValue({
      entries: [savedConversationStart(), savedMessage(2, "Release report", [attachment])],
    } satisfies RelayThreadHistoryPage);
    fixture.download.mockReturnValueOnce(attempt.promise);
    const link = { click: vi.fn(), href: "", download: "" };
    vi.stubGlobal("document", { ...document, createElement: vi.fn(() => link) });
    await mount(completedJob);
    await press("Conversation");
    await act(() => {
      const download = findButton(attachment.name)!.props.onClick;
      void download();
      void download();
    });

    expect(fixture.download).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        resultId: result.resultId,
        attachmentId: attachment.id,
      }),
    );
    await act(() => attempt.reject(new Error("Download timed out.")));

    await press("Retry download");
    expect(fixture.download).toHaveBeenCalledTimes(2);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.download).toBe(attachment.name);
    expect(findButton("Retry download")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Release report");
  }));

it("retries the failed conversation page without replacing the messages already shown", () =>
  withClient(async () => {
    const firstMessage = "The release notes are ready.";
    const nextMessage = "The rollback steps are included.";
    fixture.history
      .mockResolvedValueOnce({
        entries: [
          savedConversationStart(),
          savedMessage(2, firstMessage),
          ...Array.from({ length: 198 }, (_, index) =>
            historyEntry(index + 3, "thread.meta-updated", { title: "Release notes" }),
          ),
        ],
      } satisfies RelayThreadHistoryPage)
      .mockRejectedValueOnce(new Error("The next history page was unavailable."));
    const retry = deferred<RelayThreadHistoryPage>();
    fixture.history.mockReturnValueOnce(retry.promise);
    const body = {};
    const ownerDocument = { ...document, body, activeElement: body };
    const focusTarget = () => {
      const node = {
        ownerDocument,
        focus: vi.fn(() => {
          ownerDocument.activeElement = node;
        }),
      };
      return node;
    };
    const retryControl = focusTarget();
    const continuation = focusTarget();
    const pane = focusTarget();
    await mount(completedJob, true, {
      createNodeMock: ({ type, props }) => {
        const host = props as { children?: unknown; "aria-label"?: string };
        const children = Array.isArray(host.children) ? host.children : [host.children];
        if (type === "button" && children.includes("Retry loading more messages"))
          return retryControl;
        if (type === "button" && children.includes("Load more messages")) {
          // The browser blurs the old retry control when the next page replaces it.
          if (ownerDocument.activeElement === retryControl) ownerDocument.activeElement = body;
          return continuation;
        }
        return host["aria-label"] === "Saved workflow results" ? pane : null;
      },
    });
    await press("Conversation");
    await press("Load more messages");

    const content = () =>
      JSON.stringify(renderer.toJSON(), (key, value) => (key === "ref" ? undefined : value));
    expect(content()).toContain("Couldn’t load more messages");
    expect(content()).toContain(firstMessage);
    retryControl.focus();
    await act(() => {
      void findButton("Retry loading more messages")!.props.onClick();
    });
    expect(content()).toContain(firstMessage);

    await act(() =>
      retry.resolve({
        entries: [
          savedMessage(201, nextMessage),
          ...Array.from({ length: 199 }, (_, index) =>
            historyEntry(index + 202, "thread.meta-updated", { title: "Release notes" }),
          ),
        ],
      }),
    );
    expect(ownerDocument.activeElement).toBe(continuation);
    expect(content()).toContain(firstMessage);
    expect(content()).toContain(nextMessage);
    expect(findButton("Retry loading more messages")).toBeUndefined();
    expect(fixture.history.mock.calls.map(([input]) => input.after)).toEqual([0, 200, 200]);
    expect(fixture.read).toHaveBeenCalledOnce();
    expect(fixture.list).toHaveBeenCalledOnce();
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
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/deletion requested/i);
    await act(() => renderer.update(view(job)));
    expect(fixture.list).toHaveBeenCalled();
    expect(renderer.root.findAllByType("pre")).toHaveLength(1);
  }));
it.each([
  [patch, "Partial changes saved", "View saved changes", true],
  ["", "Partial result saved", "View saved result", true],
  ["", "Partial result saved", "View saved result", false],
])(
  "discloses the confirmed partial result with the right action (%s, %s, %s, show detail: %s)",
  (savedPatch, title, label, showCancellationDetail) =>
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
      const detail = "Canceled before the Agent step completed.";
      await act(async () => {
        renderer = create(
          view(
            {
              ...job,
              status: "cancelled",
              detail,
              progress: { ...job.progress!, status: "cancelled", checkpoint: null },
            },
            true,
            showCancellationDetail,
          ),
        );
      });

      const outcome = JSON.stringify(renderer.toJSON());
      expect(outcome).toContain(title);
      if (showCancellationDetail) {
        expect(outcome).toContain(detail);
      } else {
        expect(outcome).not.toContain(detail);
        expect(outcome).toContain("The run ended before the workflow completed.");
      }
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
        await press("Delete thread", deleteDialog());
        const deletionError = renderer.root.findAll(
          (node) =>
            typeof node.type === "string" && node.children.includes("Deletion not confirmed"),
        )[0]!;
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
      else expect(JSON.stringify(renderer.toJSON())).toContain("No file changes");
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
    expect(findPicker()?.props["data-selection"]).toBe(result.resultId);
    expect(fixture.history).toHaveBeenCalledOnce();
    const disclosure = renderer.root
      .findAllByType("button")
      .find((button) => typeof button.props["aria-expanded"] === "boolean")!;
    expect(disclosure.props["aria-expanded"]).toBe(true);
    expect(renderer.root.findByProps({ id: disclosure.props["aria-controls"] }).props.hidden).toBe(
      false,
    );

    await press("Hide saved result");
    expect(findPicker()).toBeUndefined();
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
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/deletion requested/i);
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
    expect(JSON.stringify(renderer.toJSON())).toContain("Deletion requested");
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
it("cannot submit a delete confirmation after permission becomes unavailable", () =>
  withClient(async () => {
    await mount({ ...job, status: "done" });
    await press("Delete thread permanently");
    const confirm = findButton("Delete thread", deleteDialog())?.props.onClick;
    expect(confirm).toBeTypeOf("function");

    await act(() => {
      appAtomRegistry.set(capabilitiesAtom, {
        data: null,
        error: null,
        errorTraceId: null,
        isPending: false,
      });
    });
    expect(findButton("Delete thread permanently")).toBeUndefined();
    const dialog = deleteDialog();
    const visibleConfirm = dialog && findButton("Delete thread", dialog);
    expect(visibleConfirm?.props.disabled ?? true).toBe(true);
    await act(async () => {
      await confirm();
    });
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
    await press("Delete thread permanently");
    expect(deleteDialog()).toBeDefined();
    await press("Keep thread", deleteDialog());
    expect(deleteDialog()).toBeUndefined();
    expect(renderer.root.findByType("pre")).toBeDefined();
    expect(fixture.deletion).not.toHaveBeenCalled();
  }));
