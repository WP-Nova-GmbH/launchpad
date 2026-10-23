import { act, useState, type ComponentProps, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ThreadVmActionSubmission } from "@t3tools/client-runtime/relay/threadVmActionSubmission";

const fixture = vi.hoisted(() => ({
  backup: vi.fn(),
  preview: vi.fn(),
  openLink: vi.fn(),
  run: vi.fn(),
  expired: false,
  local: false,
  status: {} as Record<string, unknown>,
  candidates: [] as Record<string, unknown>[],
  auth: null as Record<string, unknown> | null,
  queuePaused: false,
  replacementEnabled: true,
  readError: null as string | null,
  authAction: vi.fn(),
  lifecycle: {
    entries: [] as ThreadVmActionSubmission[],
    ready: true,
    busy: false,
    error: null as string | null,
  },
}));
vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return {
    RegistryContext: createContext(null),
    useAtomValue: (value: unknown, select?: (value: unknown) => unknown) =>
      select ? select(value) : value,
  };
});
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: null }));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
}));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => fixture.openLink }));
vi.mock("../../state/use-thread-vm-actions", () => ({
  useThreadVmActionJournal: () => ({ ...fixture.lifecycle, run: fixture.run }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "backup"
      ? fixture.backup
      : command === "preview"
        ? fixture.preview
        : command === "auth"
          ? fixture.authAction
          : vi.fn(),
}));
vi.mock("../../state/threads", () => ({
  threadVmActionJournal: {},
  threadEnvironment: {},
  environmentThreadDetails: {
    stateAtom: () => ({ status: "live", data: { _tag: "None" } }),
  },
  threadVmControls: {
    locationViewAtom: () => null,
    routeAtom: () => null,
    confirmedLocationAtom: () => null,
    hostConfigurationAtom: { isPending: false, unavailableReason: null },
    providerAuthAction: "auth",
    checkBackupRecovery: "backup",
    openPreview: "preview",
    refresh: vi.fn(),
    capabilitiesAtom: {
      data: {
        configured: true,
        get replacement() {
          return fixture.replacementEnabled;
        },
        restore: true,
        reset: true,
        permanentDelete: true,
        privatePreview: true,
      },
      isPending: false,
      error: null,
    },
    viewAtom: () => ({
      accountId: "owner",
      error: fixture.readError,
      providerAuth: fixture.auth,
      providerAuthError: null,
      providerAuthPending: false,
      queuePaused: fixture.queuePaused,
      data: {
        candidates: fixture.candidates,
        status: {
          threadId: "thread",
          generation: 2,
          allocation: fixture.expired ? null : { state: "running", allocationId: "allocation" },
          activity: "idle",
          setupPhase: "ready",
          lastVerifiedBackupAt: "2026-10-22T10:00:00Z",
          savedDisk: fixture.expired
            ? { phase: "expired", expiresAt: "2026-10-21T10:00:00Z" }
            : null,
          repository: { canonicalKey: "test-repo", branch: "main", revision: "abcdef012345" },
          ...fixture.status,
        },
      },
    }),
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@t3tools/client-runtime/relay/portableThreadPresentation", () => ({
  portableThreadPlacementsAtom: [],
}));
vi.mock("../../composerDraftStore", () => ({ handoffMovedThreadDraft: vi.fn() }));
vi.mock("../../lib/movedThreadDraft", () => ({ recoverMovedDraftFile: vi.fn() }));
vi.mock("../../state/projects", () => ({ environmentProjects: { projectsAtom: [] } }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({
      environment: {
        threadVm: fixture.local ? null : { threadId: "thread" },
        capabilities: {},
        platform: { machine: "cloud" },
      },
      providers: [],
    }),
  },
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (value: unknown) => value, refresh: vi.fn() },
}));
vi.mock("../../cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("./MovedThreadDraftRecovery", () => ({ MovedThreadDraftRecovery: () => null }));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ children }: PropsWithChildren) => children,
  TooltipPopup: () => null,
}));
vi.mock("./ComposerControl", () => ({ ComposerControl: "button" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/popover", async () => {
  const { createContext, useContext, useMemo } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean): void => undefined });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: PropsWithChildren<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>) => {
      const value = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
      return (
        <Context.Provider value={value}>
          <div
            data-testid="management"
            onKeyDown={(event) => {
              if (event.key === "Escape") onOpenChange(false);
            }}
          >
            {children}
          </div>
        </Context.Provider>
      );
    },
    PopoverTrigger: ({ children, "aria-label": label }: ComponentProps<"button">) => {
      const { open, onOpenChange } = useContext(Context);
      return (
        <button aria-label={label} onClick={() => onOpenChange(!open)}>
          {children}
        </button>
      );
    },
    PopoverPopup: ({ children }: PropsWithChildren) =>
      useContext(Context).open ? <section>{children}</section> : null,
    PopoverTitle: "h2",
  };
});
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
    onOpenChange,
  }: PropsWithChildren<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>) =>
    open ? (
      <dialog open onCancel={() => onOpenChange(false)}>
        {children}
      </dialog>
    ) : null,
  AlertDialogPopup: "div",
  AlertDialogHeader: "div",
  AlertDialogTitle: "h2",
  AlertDialogDescription: "p",
  AlertDialogFooter: "div",
}));

import { ThreadVmControls, ThreadVmControlsProvider, ThreadVmNotice } from "./ThreadVmControls";
import { ThreadRunOnPicker } from "./ThreadMoveControls";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer | undefined;
const env = EnvironmentId.make("vm"),
  thread = ThreadId.make("thread");
const view = (chat = false) =>
  chat ? (
    <ThreadVmControlsProvider environmentId={env} threadId={thread}>
      <ThreadVmNotice />
      <ThreadRunOnPicker environmentId={env} threadId={thread} />
    </ThreadVmControlsProvider>
  ) : (
    <ThreadVmControls environmentId={env} threadId={thread} />
  );
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const dialogs = () => renderer!.root.findAllByType("dialog");
const dialogButton = (label: string) =>
  dialogs()[0]!
    .findAllByType("button")
    .find((node) => node.children.join("") === label)!;
const openRunOn = async () => {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((node) => node.props["aria-label"]?.startsWith("Run on:"))!
      .props.onClick();
  });
};
const closeDialog = async () => {
  await act(async () => button("Close").props.onClick());
};
const backup = {
  available: true,
  generation: 2,
  sourceAllocationId: "allocation",
  backupOperationId: "backup-id",
  capturedAt: "2026-10-22T10:00:00Z",
  nativeCheckpointOperationId: "checkpoint-id",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.backup.mockReset();
  fixture.preview.mockReset();
  fixture.openLink.mockReset();
  fixture.run.mockReset();
  fixture.run.mockResolvedValue(true);
  fixture.backup.mockResolvedValue(AsyncResult.success(backup));
  fixture.authAction.mockResolvedValue(AsyncResult.success({}));
  fixture.expired = false;
  fixture.local = false;
  fixture.status = {};
  fixture.candidates = [];
  fixture.auth = null;
  fixture.queuePaused = false;
  fixture.replacementEnabled = true;
  fixture.readError = null;
  fixture.lifecycle.entries = [];
  fixture.lifecycle.ready = true;
  fixture.lifecycle.busy = false;
  fixture.lifecycle.error = null;
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount(chat = false) {
  await act(async () => {
    renderer = create(view(chat));
  });
}
async function openConfirmation(kind: "reset" | "delete" | "backup", chat = false) {
  fixture.expired = kind === "reset";
  await mount(chat);
  if (chat) await openRunOn();
  await act(async () => {
    const label =
      kind === "backup"
        ? "Recover from backup…"
        : kind === "delete"
          ? "Permanently delete thread"
          : "Reset VM…";
    const target = chat
      ? renderer!.root
          .findByType("section")
          .findAllByType("button")
          .find((node) => node.children.join("") === label)!
      : button(label);
    target.props.onClick();
  });
  expect(dialogs()).toHaveLength(1);
}

describe("simplified VM controls", () => {
  it("keeps a ready chat quiet and exposes tools directly in Run on", async () => {
    await mount(true);
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
    expect(button("Manage VM")).toBeUndefined();
    await openRunOn();
    expect(button("Open preview…")).toBeDefined();
    expect(button("Recover from backup…")).toBeDefined();
    expect(button("Reset VM…")).toBeUndefined();
    expect(button("Permanently delete thread")).toBeUndefined();
  });
  it("does not treat an explicitly paused queue as a VM problem", async () => {
    fixture.queuePaused = true;
    await mount(true);
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
    expect(fixture.run).not.toHaveBeenCalled();
  });
  it("preserves the composer subtree when a local thread first acquires a VM", async () => {
    function Draft() {
      const [value, setValue] = useState("");
      return <input value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    fixture.status = { allocation: null };
    const draftView = () => (
      <ThreadVmControlsProvider environmentId={env} threadId={thread}>
        <Draft />
        <ThreadVmNotice />
      </ThreadVmControlsProvider>
    );
    await act(async () => {
      renderer = create(draftView());
    });
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "Unsent draft" } }),
    );
    fixture.status = {};
    await act(async () => renderer!.update(draftView()));
    expect(renderer!.root.findByType("input").props.value).toBe("Unsent draft");
  });
  it("lets the move queue own ordinary preparation progress while keeping failures visible", async () => {
    fixture.status = { setupPhase: "running" };
    const moving = () => (
      <ThreadVmControlsProvider environmentId={env} threadId={thread}>
        <ThreadVmNotice moving />
      </ThreadVmControlsProvider>
    );
    await act(async () => {
      renderer = create(moving());
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
    fixture.status = { finalSave: { errorCode: "save_failed" } };
    await act(async () => renderer!.update(moving()));
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(1);
  });
  it("resumes a paused VM from the compact notice", async () => {
    fixture.status = { allocation: { allocationId: "allocation", state: "paused" } };
    await mount(true);
    await act(async () => button("Resume VM").props.onClick());
    expect(fixture.run).toHaveBeenCalledWith({
      environmentId: env,
      threadId: thread,
      action: { type: "resume" },
    });
  });
  it("keeps destination sign-in reachable while the current machine is local", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: { allocationId: "new-vm", operationId: "move" },
      setupPhase: "running",
    };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    await mount(true);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((node) => node.props["aria-label"] === "Run on: Current machine"),
    ).toBe(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    expect(dialogs()).toHaveLength(1);
    await act(async () => dialogButton("Sign in to Codex").props.onClick());
    expect(fixture.authAction).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { allocationId: "new-vm", operationId: "move" },
        action: { type: "start" },
      }),
    );
  });
  it("chooses and confirms a replacement from a local source", async () => {
    fixture.local = true;
    fixture.status = { replacement: { phase: "awaiting_choice", requestId: "request" } };
    fixture.candidates = [{ allocationId: "old-vm", title: "Other thread", state: "paused" }];
    await mount(true);
    await act(async () => button("Choose a VM to replace").props.onClick());
    expect(button("Cancel VM request")).toBeDefined();
    await act(async () => button("Replace…").props.onClick());
    expect(button("Save and replace VM").props.disabled).toBe(false);
    await act(async () => button("Save and replace VM").props.onClick());
    expect(fixture.run).toHaveBeenCalledWith({
      environmentId: env,
      threadId: thread,
      action: { type: "select_replacement", requestId: "request", victimAllocationId: "old-vm" },
    });
  });
  it("can cancel a capacity request when no VM is available to replace", async () => {
    fixture.status = { replacement: { phase: "awaiting_choice", requestId: "request" } };
    await mount(true);
    await act(async () => button("Choose a VM to replace").props.onClick());
    expect(
      dialogs()[0]!
        .findAllByType("p")
        .some((node) => node.children.join("").includes("All VMs are busy")),
    ).toBe(true);
    await act(async () => button("Cancel VM request").props.onClick());
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "cancel_replacement", requestId: "request" } }),
    );
  });
  it("keeps capacity cancellation available when replacement is inactive", async () => {
    fixture.replacementEnabled = false;
    fixture.status = { replacement: { phase: "awaiting_choice", requestId: "request" } };
    fixture.candidates = [{ allocationId: "old-vm", title: "Other thread", state: "paused" }];
    await mount(true);
    expect(button("Choose a VM to replace").props.disabled).toBe(false);
    await act(async () => button("Choose a VM to replace").props.onClick());
    expect(button("Replace…").props.disabled).toBe(true);
    expect(dialogButton("Cancel VM request").props.disabled).toBe(false);
    await act(async () => dialogButton("Cancel VM request").props.onClick());
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "cancel_replacement", requestId: "request" } }),
    );
  });
  it("can retry a failed backup lookup inside its focused dialog", async () => {
    fixture.backup.mockRejectedValueOnce(new Error("Backup lookup failed"));
    await mount(true);
    await openRunOn();
    await act(async () => button("Recover from backup…").props.onClick());
    expect(dialogs()[0]!.findByProps({ role: "alert" }).children).toEqual(["Backup lookup failed"]);
    await act(async () => dialogButton("Retry backup check").props.onClick());
    expect(dialogButton("Restore this backup").props.disabled).toBe(false);
    expect(fixture.backup).toHaveBeenCalledTimes(2);
  });
  it("shows refresh failure rather than silently claiming the VM is ready", async () => {
    fixture.readError = "Relay unavailable";
    await mount(true);
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(1);
    expect(button("Check status")).toBeDefined();
  });
  it("opens a custom preview port and keeps failures inside its focused dialog", async () => {
    fixture.preview
      .mockResolvedValueOnce(AsyncResult.success({ url: "https://preview.example.test" }))
      .mockRejectedValueOnce(new Error("Preview unavailable"));
    await mount(true);
    await openRunOn();
    await act(async () => button("Open preview…").props.onClick());
    expect(renderer!.root.findAllByType("section")).toHaveLength(0);
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "5173" } }),
    );
    await act(async () => button("Open private preview").props.onClick());
    expect(fixture.preview).toHaveBeenCalledWith({
      environmentId: env,
      threadId: thread,
      port: 5173,
    });
    expect(fixture.openLink).toHaveBeenCalledWith("https://preview.example.test", {
      recordHistory: false,
    });
    await act(async () => button("Open private preview").props.onClick());
    expect(dialogs()[0]!.findByProps({ role: "alert" }).children).toEqual([
      "The VM preview could not be opened.",
    ]);
  });
});

describe("VM focused dialog recovery", () => {
  it("keeps saved recovery controls reachable when the VM disappears", async () => {
    await openConfirmation("backup", true);
    fixture.run.mockImplementationOnce(async (request: ThreadVmActionSubmission) => {
      fixture.lifecycle.entries = [request];
      fixture.lifecycle.error = "Relay did not confirm the request";
      return false;
    });
    await act(async () => dialogButton("Restore this backup").props.onClick());
    fixture.status = { allocation: null };
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(0);
    expect(button("Retry saved VM request").props.disabled).toBe(false);
    expect(button("Cancel saved recovery request").props.disabled).toBe(false);
    const saved = fixture.run.mock.calls[0]![0];
    await act(async () => button("Retry saved VM request").props.onClick());
    expect(fixture.run.mock.calls[1]![0]).toBe(saved);
  });

  it("does not reopen an old confirmation when VM status returns", async () => {
    await openConfirmation("backup", true);
    fixture.status = { allocation: null };
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(0);
    fixture.status = {};
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(0);
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("ignores a backup failure after VM status disappears and returns", async () => {
    const check = deferred();
    fixture.backup.mockImplementation(async () => {
      await check.promise;
      throw new Error("Stale backup failure");
    });
    await mount(true);
    await openRunOn();
    await act(async () => button("Recover from backup…").props.onClick());
    fixture.status = { allocation: null };
    await act(async () => renderer!.update(view(true)));
    fixture.status = {};
    await act(async () => renderer!.update(view(true)));
    await act(async () => check.resolve());
    expect(dialogs()).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it.each(["success", "failure"])(
    "ignores a late backup %s after the dialog was dismissed",
    async (result) => {
      const check = deferred();
      fixture.backup.mockImplementation(async () => {
        await check.promise;
        if (result === "failure") throw new Error("Backup unavailable");
        return AsyncResult.success(backup);
      });
      await mount(true);
      await openRunOn();
      await act(async () => button("Recover from backup…").props.onClick());
      expect(dialogs()).toHaveLength(1);
      await closeDialog();
      await act(async () => check.resolve());
      expect(dialogs()).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      expect(fixture.run).not.toHaveBeenCalled();
    },
  );
  it("ignores a late preview URL after its dialog was dismissed", async () => {
    const check = deferred();
    fixture.preview.mockImplementation(async () => {
      await check.promise;
      return AsyncResult.success({ url: "https://preview.example.test" });
    });
    await mount(true);
    await openRunOn();
    await act(async () => button("Open preview…").props.onClick());
    await act(async () => button("Open private preview").props.onClick());
    await closeDialog();
    await act(async () => check.resolve());
    expect(fixture.openLink).not.toHaveBeenCalled();
  });
  it.each(["reset", "delete", "backup"] as const)(
    "keeps failed %s requests retryable after the menu closes",
    async (kind) => {
      await openConfirmation(kind, kind !== "delete");
      expect(renderer!.root.findAllByType("section")).toHaveLength(0);
      fixture.run.mockImplementationOnce(async (request: ThreadVmActionSubmission) => {
        fixture.lifecycle.entries = [request];
        fixture.lifecycle.error = "Relay did not confirm the request";
        return false;
      });
      await act(async () =>
        dialogButton(
          kind === "reset"
            ? "Reset VM"
            : kind === "delete"
              ? "Permanently delete thread"
              : "Restore this backup",
        ).props.onClick(),
      );
      await act(async () => renderer!.update(view(kind !== "delete")));
      expect(dialogs()[0]!.findByProps({ role: "alert" }).children).toEqual([
        "Relay did not confirm the request",
      ]);
      const saved = fixture.run.mock.calls[0]![0];
      await act(async () => button("Retry saved VM request").props.onClick());
      expect(fixture.run.mock.calls[1]![0]).toBe(saved);
      expect(dialogs()).toHaveLength(0);
    },
  );
  it.each(["close", "escape"])(
    "can %s a confirmation when journal storage fails without losing the request",
    async (dismiss) => {
      await openConfirmation("backup", true);
      fixture.lifecycle.ready = false;
      fixture.lifecycle.error = "Storage unavailable";
      await act(async () => renderer!.update(view(true)));
      expect(dialogs()[0]!.findByProps({ role: "alert" }).children).toEqual([
        "Storage unavailable",
      ]);
      await act(async () => {
        if (dismiss === "close") {
          expect(button("Close").props.disabled).not.toBe(true);
          button("Close").props.onClick();
        } else dialogs()[0]!.props.onCancel();
      });
      expect(dialogs()).toHaveLength(0);
      expect(fixture.run).not.toHaveBeenCalled();
    },
  );
});
