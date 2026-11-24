import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import {
  emptyWorkflowRun,
  setWorkflowResponseDraft,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowSessionKey,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { WorkflowWindowCloseGuard } from "./WorkflowWindowCloseGuard";

vi.mock("../ui/alert-dialog", () => {
  const part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? <section aria-label="Close window confirmation">{children}</section> : null,
    AlertDialogPopup: part,
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: ({ children }: PropsWithChildren) => <footer>{children}</footer>,
  };
});
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));

const scope = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const editKey = workflowSessionKey(scope, "triage");
const runKey = workflowSessionKey(scope, "publish");
const edit: WorkflowEditorDraft = {
  workflowId: "triage",
  definition: {
    name: "Triage Linear issues",
    target: {
      kind: "machine",
      environmentId: EnvironmentId.make("machine"),
      projectId: ProjectId.make("project"),
    },
    steps: [],
  },
  baseline: null,
  operation: null,
  selectedStepId: "",
  targetConfirmed: true,
  error: null,
};

type CloseListener = () => void;

let renderer: ReactTestRenderer | undefined;
let closeBlocked: CloseListener | undefined;
const confirmWindowClose = vi.fn<() => Promise<void>>();
const confirm = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  confirmWindowClose.mockReset();
  confirmWindowClose.mockResolvedValue(undefined);
  confirm.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  setWorkflowSessionAccount(appAtomRegistry, null);
  closeBlocked = undefined;
  vi.unstubAllGlobals();
});

async function mount(desktop = false) {
  const browserWindow = Object.assign(new EventTarget(), {
    confirm,
    desktopBridge: desktop
      ? {
          confirmWindowClose,
          onWindowCloseBlocked: (listener: CloseListener) => {
            closeBlocked = listener;
            return () => {
              closeBlocked = undefined;
            };
          },
        }
      : undefined,
  });
  vi.stubGlobal("window", browserWindow);
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowWindowCloseGuard />
      </AppAtomRegistryProvider>,
    );
  });
  return browserWindow;
}

function addEdit() {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: { ...state.editors, [editKey]: edit },
  }));
}

function dialog() {
  return renderer!.root.findAllByProps({ "aria-label": "Close window confirmation" })[0];
}

function content(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : content(child)))
    .join(" ");
}

async function click(label: string) {
  const button = dialog()!
    .findAllByType("button")
    .find((node) => content(node) === label)!;
  await act(() => button.props.onClick());
}

it.each([false, true])(
  "vetoes dirty non-close unloads without opening a dialog (desktop=%s)",
  async (desktop) => {
    const browserWindow = await mount(desktop);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    await act(() => browserWindow.dispatchEvent(cleanUnload));
    expect(cleanUnload.defaultPrevented).toBe(false);

    await act(() => addEdit());
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    await act(() => browserWindow.dispatchEvent(dirtyUnload));

    expect(dirtyUnload.defaultPrevented).toBe(true);
    expect(dialog()).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmWindowClose).not.toHaveBeenCalled();
  },
);

it("lists unsaved edits and keeps them when the user stays open", async () => {
  addEdit();
  await mount(true);
  expect(dialog()).toBeUndefined();

  await act(() => closeBlocked!());
  expect(content(dialog()!)).toContain("Close window with unsaved edits?");
  expect(content(dialog()!)).toContain("Triage Linear issues");

  await click("Keep window open");

  expect(dialog()).toBeUndefined();
  expect(appAtomRegistry.get(workflowDraftAtom).editors[editKey]).toBe(edit);
  expect(confirmWindowClose).not.toHaveBeenCalled();

  await act(() => closeBlocked!());
  expect(content(dialog()!)).toContain("Triage Linear issues");
});

it("shows an unsent checkpoint response without exposing its text", async () => {
  const draftResponse = "Please change the private deployment note.";
  setWorkflowResponseDraft(appAtomRegistry, scope, "run", "checkpoint", draftResponse, {
    workflowName: "Triage Linear issues",
    stepTitle: "Review changes",
    kind: "review",
  });
  await mount(true);
  await act(() => closeBlocked!());

  const details = content(dialog()!);
  expect(details).toContain("Close window with an unsent response?");
  expect(details).toContain("Review feedback");
  expect(details).toContain("Review changes in Triage Linear issues");
  expect(details).not.toContain(draftResponse);
  expect(confirmWindowClose).not.toHaveBeenCalled();
});

it("lets the window close after a durable response receipt and protects a replacement draft", async () => {
  const jobKey = workflowSessionKey(scope, "run");
  const context = {
    workflowName: "Publish weekly updates",
    stepTitle: "Choose a date",
    kind: "input",
  } as const;
  const response = "2026-12-01";
  setWorkflowResponseDraft(appAtomRegistry, scope, "run", "checkpoint", response, context);
  const browserWindow = await mount(true);
  await act(() => closeBlocked!());
  expect(content(dialog()!)).toContain("Close window with an unsent response?");

  await act(() => {
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      submitted: {
        [jobKey]: {
          checkpoint: {
            checkpointId: "checkpoint",
            operation: "input",
            userId: scope.accountId,
            text: response,
            acceptedPendingResponseId: "durable-response",
          },
        },
      },
    }));
  });

  const acknowledgedUnload = new Event("beforeunload", { cancelable: true });
  browserWindow.dispatchEvent(acknowledgedUnload);
  expect(acknowledgedUnload.defaultPrevented).toBe(false);
  expect(content(dialog()!)).toContain("Your workflow work is up to date.");

  await act(() => {
    setWorkflowResponseDraft(appAtomRegistry, scope, "run", "checkpoint", "2026-12-02", context);
  });
  const editedUnload = new Event("beforeunload", { cancelable: true });
  browserWindow.dispatchEvent(editedUnload);
  expect(editedUnload.defaultPrevented).toBe(true);
  expect(content(dialog()!)).toContain("Input answer");
  expect(confirmWindowClose).not.toHaveBeenCalled();
});

it("protects Machine checkpoint text when the queued response has no identity", async () => {
  const jobKey = workflowSessionKey(scope, "run");
  const response = "Check the deployment date";
  setWorkflowResponseDraft(appAtomRegistry, scope, "run", "checkpoint", response, {
    workflowName: "Publish weekly updates",
    stepTitle: "Choose a date",
    kind: "input",
  });
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    submitted: {
      [jobKey]: {
        checkpoint: {
          checkpointId: "checkpoint",
          operation: "input",
          userId: scope.accountId,
          text: response,
          acceptedPending: true,
        },
      },
    },
  }));
  const browserWindow = await mount(true);
  const unload = new Event("beforeunload", { cancelable: true });
  browserWindow.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  await act(() => closeBlocked!());
  expect(content(dialog()!)).toContain("Checkpoint response awaiting confirmation");
  await click("Keep window open");
  expect(appAtomRegistry.get(workflowDraftAtom).responses[jobKey]?.checkpoint).toBe(response);
});

it("shows where to check pending requests and closes only after explicit confirmation", async () => {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: {
      [editKey]: {
        ...edit,
        operation: {
          requestId: "save",
          state: "pending",
          definition: edit.definition,
          archived: false,
          expectedRevision: 0,
        },
      },
    },
    runs: {
      [runKey]: {
        ...emptyWorkflowRun,
        workflowName: "Publish weekly updates",
        operation: { requestId: "run", state: "pending", instruction: "Publish this week" },
        recovery: {
          kind: "additional",
          previous: { requestId: "original", state: "uncertain", instruction: "Publish this week" },
        },
      },
    },
  }));
  await mount(true);
  await act(() => closeBlocked!());

  const details = content(dialog()!);
  expect(details).toContain("Close window before confirmation?");
  expect(details).toContain("Closing discards the local drafts.");
  expect(details).toContain("Triage Linear issues");
  expect(details).toContain("Workflows");
  expect(details).toContain("Unconfirmed run 1 of 2 for Publish weekly updates");
  expect(details).toContain("Unconfirmed run 2 of 2 for Publish weekly updates");
  expect(details).toContain("Runs");
  expect(confirmWindowClose).not.toHaveBeenCalled();

  await click("Close anyway");

  expect(confirmWindowClose).toHaveBeenCalledTimes(1);
});

it("keeps drafts and offers an exit from the dialog if native close fails", async () => {
  addEdit();
  confirmWindowClose.mockRejectedValueOnce(new Error("Close request expired"));
  await mount(true);
  await act(() => closeBlocked!());

  await click("Close window");

  expect(content(dialog()!.findByType("footer"))).toContain("Could not close the window");
  await click("Keep window open");
  expect(dialog()).toBeUndefined();
  expect(appAtomRegistry.get(workflowDraftAtom).editors[editKey]).toBe(edit);
});
