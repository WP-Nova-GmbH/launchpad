import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import type {
  RelayPortableThreadPlacement,
  RelayThreadVmCodexAuthSource,
  RelayThreadVmCodexAuthSelection,
  RelayCodexVmConnection,
  RelayThreadVmStatus,
  RelayThreadVmProviderAuth,
  ThreadMoveWaitingForAuth,
} from "@t3tools/contracts/relay";
import { act, useState, type ComponentProps, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ThreadVmActionSubmission } from "@t3tools/client-runtime/relay/threadVmActionSubmission";
import type { ThreadVmProviderAuthDialogEvidence } from "@t3tools/client-runtime/relay/threadVmControls";

const fixture = vi.hoisted(() => ({
  backup: vi.fn(),
  preview: vi.fn(),
  openLink: vi.fn(),
  run: vi.fn(),
  enqueue: vi.fn(),
  expired: false,
  local: false,
  defaultCodex: false,
  cloudConfigured: false,
  vmAccountPending: false,
  localThread: null as Record<string, unknown> | null,
  queue: null as ThreadPromptQueue | null,
  route: null as {
    phase: "active" | "retired";
    relayUrl: string;
    generation: number;
  } | null,
  status: {} as Record<string, unknown>,
  candidates: [] as Record<string, unknown>[],
  auth: null as Record<string, unknown> | null,
  authSource: null as RelayThreadVmCodexAuthSource | null,
  accountSelectionRequired: false,
  authSelection: {
    phase: "idle" as "idle" | "saving" | "confirmed" | "unknown" | "rejected",
    requested: null as RelayThreadVmCodexAuthSelection | null,
    error: null as string | null,
  },
  authSourceError: null as string | null,
  authReadError: null as string | null,
  workerAuth: undefined as ThreadMoveWaitingForAuth | null | undefined,
  authTransitionKey: "initial",
  dialogEvidence: null as ThreadVmProviderAuthDialogEvidence | null,
  dialogCompleted: false,
  selectionRevision: 0,
  codexConnection: null as RelayCodexVmConnection | null,
  queuePaused: false,
  replacementEnabled: true,
  readError: null as string | null,
  authAction: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  signedIn: false,
  session: { accountId: "owner" },
  checkLocation: vi.fn(),
  openThread: vi.fn(),
  location: null as {
    placement?: RelayPortableThreadPlacement;
    recoveryRequested: boolean;
    isPending: boolean;
    movePending: boolean;
    destination: { environmentId: string; generation: number } | null;
    error: string | null;
  } | null,
  readMove: vi.fn(),
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
vi.mock("@t3tools/client-runtime/relay", () => ({
  get managedRelaySessionAtom() {
    return fixture.signedIn ? fixture.session : null;
  },
}));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
  threadMoveSubmissions: { read: fixture.readMove },
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
          : command === "location"
            ? fixture.checkLocation
            : command === "enqueue"
              ? fixture.enqueue
              : command === "open"
                ? fixture.openThread
                : vi.fn(),
}));
vi.mock("../../state/threads", async () => {
  const { deriveThreadVmProviderAuthDialog, threadVmPresentation } =
    await import("@t3tools/client-runtime/relay/threadVmControls");
  return {
    openPortableThreadChat: "open",
    threadVmActionJournal: {},
    threadEnvironment: { enqueueMove: "enqueue" },
    environmentThreadDetails: {
      stateAtom: () => ({
        status: "live",
        data: fixture.cloudConfigured
          ? { _tag: "Some", value: { promptQueue: fixture.queue ?? emptyThreadPromptQueue() } }
          : { _tag: "None" },
      }),
    },
    threadVmControls: {
      codexPreferencePendingAtom: () => fixture.vmAccountPending,
      locationViewAtom: () => fixture.location,
      routeAtom: () => fixture.route,
      confirmedLocationAtom: () => null,
      checkLocation: "location",
      hostConfigurationAtom: { isPending: false, unavailableReason: null },
      providerAuthAction: "auth",
      providerAuthDialogViewAtom: () => {
        const status = {
          threadId: "thread",
          generation: 2,
          ...fixture.status,
        } as RelayThreadVmStatus;
        const canManage = threadVmPresentation({
          status,
          workerAuth: fixture.workerAuth,
        }).canManageProviderAuth;
        const ready = canManage || fixture.workerAuth === "verification";
        const auth = ready ? (fixture.auth as RelayThreadVmProviderAuth | null) : null;
        const source =
          fixture.authSource ?? auth?.authSource ?? (auth ? { mode: "personal" as const } : null);
        const result = deriveThreadVmProviderAuthDialog(
          {
            binding: status.pendingProviderAuth ?? null,
            source,
            connection: fixture.codexConnection,
            sourceKnown: source !== null || fixture.accountSelectionRequired,
            connectionKnown: fixture.codexConnection !== null,
            auth: auth
              ? { requirement: auth.requirement, source, message: auth.auth.message ?? null }
              : null,
            selectionPhase: fixture.authSelection.phase,
            selectionRevision: fixture.selectionRevision,
            accountSelectionRequired: fixture.accountSelectionRequired,
            attempt: null,
            canManage,
            error: ready
              ? (fixture.authSelection.error ?? fixture.authReadError ?? fixture.authSourceError)
              : null,
            completed: fixture.dialogCompleted,
          },
          fixture.dialogEvidence,
        );
        fixture.dialogEvidence = result.evidence;
        return result.view;
      },
      providerAuthSourceViewAtom: () => ({
        selection: fixture.authSelection,
        data: {
          source: fixture.authSource,
          connection: fixture.codexConnection,
          unsupported: false,
          accountSelectionRequired: fixture.accountSelectionRequired,
          selectionRevision: fixture.selectionRevision,
          error: fixture.authSourceError,
        },
        isPending: false,
        error: null,
      }),
      checkBackupRecovery: "backup",
      openPreview: "preview",
      refresh: fixture.refresh,
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
        providerAuthError: fixture.authReadError,
        providerAuthPending: false,
        workerAuth: fixture.workerAuth,
        authTransitionKey: fixture.authTransitionKey,
        queuePaused: fixture.queuePaused,
        data: {
          candidates: fixture.candidates,
          status: {
            threadId: "thread",
            generation: 2,
            allocation: fixture.expired ? null : { state: "running", allocationId: "allocation" },
            activity: "idle",
            setupPhase: "ready",
            sourceActivationPending: false,
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
  };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useLocation: () => ({ state: null }),
}));
vi.mock("@t3tools/client-runtime/relay/portableThreadPresentation", () => ({
  portableThreadPlacementsAtom: [],
}));
vi.mock("../../composerDraftStore", () => ({ handoffMovedThreadDraft: vi.fn() }));
vi.mock("../../lib/movedThreadDraft", () => ({ recoverMovedDraftFile: vi.fn() }));
vi.mock("../../state/projects", () => ({
  environmentProjects: {
    get projectsAtom() {
      return fixture.localThread
        ? [
            {
              id: "project",
              environmentId: "vm",
              title: "Project",
              workspaceRoot: "/project",
              repositoryIdentity: { canonicalKey: "github.com/org/project" },
            },
          ]
        : [];
    },
  },
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateValueAtom: () => ({ status: "live", snapshot: { _tag: "None" } }) },
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => fixture.localThread }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({
      environment: {
        threadVm: fixture.local ? null : { threadId: "thread" },
        capabilities: fixture.cloudConfigured ? { threadMoves: true } : {},
        platform: { machine: "cloud" },
      },
      providers: fixture.defaultCodex ? [{ instanceId: "codex", driver: "codex" }] : [],
    }),
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: fixture.cloudConfigured
      ? [{ environmentId: "vm", label: "Akina", connection: { phase: "connected" } }]
      : [],
  }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (value: unknown) => value, refresh: vi.fn() },
}));
vi.mock("../../cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => fixture.cloudConfigured,
}));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("./MovedThreadDraftRecovery", () => ({ MovedThreadDraftRecovery: () => null }));
vi.mock("./ThreadVmAccountPreference", () => ({
  ThreadVmAccountPreference: ({ onClose }: { onClose: () => void }) => (
    <dialog open>
      <button onClick={onClose}>Close account editor</button>
    </dialog>
  ),
}));
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

import {
  ThreadVmControls,
  ThreadVmControlsProvider,
  ThreadVmRecoveryControls,
  ThreadVmNotice,
} from "./ThreadVmControls";
import { CurrentThreadLocation, ThreadRunOnPicker } from "./ThreadMoveControls";
import { ThreadMoveQueueItem } from "./ThreadMoveQueueItem";

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
const moveAuthBinding = {
  allocationId: "new-vm",
  operationId: "move",
  environmentId: EnvironmentId.make("guest"),
  generation: 3,
  instanceId: "codex" as const,
};
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
const dialogText = () =>
  dialogs()[0]!
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join("\n");
const accountPicker = () =>
  dialogs()[0]!
    .findAllByProps({ "aria-label": "Codex account for this VM" })
    .find((node) => typeof node.props.onValueChange === "function")!;
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
  fixture.navigate.mockReset();
  fixture.signedIn = false;
  fixture.checkLocation.mockReset();
  fixture.checkLocation.mockResolvedValue(AsyncResult.success({}));
  fixture.location = null;
  fixture.readMove.mockReset();
  fixture.readMove.mockResolvedValue(null);
  fixture.expired = false;
  fixture.local = false;
  fixture.defaultCodex = false;
  fixture.cloudConfigured = false;
  fixture.vmAccountPending = false;
  fixture.localThread = null;
  fixture.queue = null;
  fixture.route = null;
  fixture.status = {};
  fixture.candidates = [];
  fixture.auth = null;
  fixture.authSource = null;
  fixture.accountSelectionRequired = false;
  fixture.authSelection = { phase: "idle", requested: null, error: null };
  fixture.authSourceError = null;
  fixture.authReadError = null;
  fixture.workerAuth = undefined;
  fixture.authTransitionKey = "initial";
  fixture.dialogEvidence = null;
  fixture.dialogCompleted = false;
  fixture.selectionRevision = 0;
  fixture.codexConnection = null;
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
  it("does not reopen the same destination or show a second notice while opening a moved thread", async () => {
    fixture.signedIn = true;
    fixture.location = {
      recoveryRequested: false,
      isPending: false,
      movePending: false,
      destination: { environmentId: env, generation: 3 },
      error: null,
    };

    await act(async () => {
      renderer = create(
        <CurrentThreadLocation
          environmentId={env}
          threadId={thread}
          recoverUnavailable
          observeOnly
        />,
      );
    });

    expect(renderer!.root.findAllByType("section")).toHaveLength(0);
    expect(fixture.openThread).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("shows a real location retry as checking, then lets the user retry a failed check", async () => {
    fixture.signedIn = true;
    fixture.location = {
      recoveryRequested: true,
      isPending: false,
      movePending: false,
      destination: null,
      error: "This thread is unavailable or you no longer have access.",
    };
    const pending = deferred();
    fixture.checkLocation.mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("The latest status is unavailable.");
    });
    await act(async () => {
      renderer = create(<CurrentThreadLocation environmentId={env} threadId={thread} />);
    });
    const action = (label: string) =>
      renderer!.root
        .findAllByType("button")
        .find((node) => node.children.some((child) => child === label))!;
    await act(async () => {
      void action("Retry").props.onClick();
    });
    expect(fixture.checkLocation).toHaveBeenCalledExactlyOnceWith({
      environmentId: env,
      threadId: thread,
      accountId: "owner",
      relayUrl: "https://relay.example.test",
    });
    expect(action("Checking…").props.disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(action("Retry").props.disabled).toBe(false);
    expect(renderer!.root.findByType("details").findByType("p").children).toEqual([
      "The latest status is unavailable.",
    ]);
    await act(async () => action("Retry").props.onClick());
    expect(fixture.checkLocation).toHaveBeenCalledTimes(2);
  });

  it("checks the original project when saved-move loading finishes with Run on still open", async () => {
    fixture.signedIn = true;
    const savedMove = deferred();
    fixture.readMove.mockReturnValueOnce(savedMove.promise.then(() => null));
    fixture.checkLocation.mockRejectedValueOnce(new Error("Origin lookup failed after startup"));
    await mount(true);
    await openRunOn();
    expect(fixture.checkLocation).not.toHaveBeenCalled();
    await act(async () => savedMove.resolve());
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).toContain("Origin lookup failed after startup");
    expect(fixture.checkLocation).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.update(view(true)));
    expect(fixture.checkLocation).toHaveBeenCalledTimes(1);
  });
  it("checks the original project when VM details arrive with Run on still open", async () => {
    fixture.signedIn = true;
    fixture.local = true;
    fixture.checkLocation.mockRejectedValueOnce(new Error("Origin lookup failed after VM load"));
    await mount(true);
    await openRunOn();
    expect(fixture.checkLocation).not.toHaveBeenCalled();
    fixture.local = false;
    await act(async () => renderer!.update(view(true)));
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).toContain("Origin lookup failed after VM load");
    expect(fixture.checkLocation).toHaveBeenCalledTimes(1);
  });
  it("waits for Run on to reopen if saved-move loading finishes after it closes", async () => {
    fixture.signedIn = true;
    const savedMove = deferred();
    fixture.readMove.mockReturnValueOnce(savedMove.promise.then(() => null));
    fixture.checkLocation.mockRejectedValueOnce(new Error("Origin lookup failed after reopening"));
    await mount(true);
    await openRunOn();
    await openRunOn();
    await act(async () => savedMove.resolve());
    expect(fixture.checkLocation).not.toHaveBeenCalled();
    await openRunOn();
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).toContain("Origin lookup failed after reopening");
  });
  it("keeps saved-move storage failures visible when Run on is opened", async () => {
    fixture.signedIn = true;
    fixture.readMove.mockRejectedValueOnce(new Error("Storage unavailable"));
    await mount(true);
    await openRunOn();
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).toContain("Could not read the saved move. Resolve storage before sending another.");
    expect(fixture.checkLocation).not.toHaveBeenCalled();
  });
  it("shows a failed original-project lookup and retries when Run on is reopened", async () => {
    fixture.signedIn = true;
    fixture.checkLocation.mockRejectedValueOnce(new Error("Original project lookup failed"));
    await mount(true);
    await openRunOn();
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).toContain("Original project lookup failed");
    await openRunOn();
    await openRunOn();
    expect(fixture.checkLocation).toHaveBeenCalledTimes(2);
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join("")),
    ).not.toContain("Original project lookup failed");
  });
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
  it("shows the relay's reopening state in Run on over a retired machine's old move", async () => {
    fixture.signedIn = true;
    fixture.local = true;
    fixture.cloudConfigured = true;
    fixture.localThread = {
      id: thread,
      projectId: "project",
      modelSelection: { instanceId: "codex" },
      archivedAt: null,
      relayRouting: { generation: 1 },
    };
    fixture.queue = {
      ...emptyThreadPromptQueue(),
      entries: [
        {
          kind: "move",
          messageId: MessageId.make("old-message"),
          operationId: CommandId.make("old-move"),
          destination: { kind: "vm" },
          state: "blocked",
          detail: "Old VM setup failure",
          revision: 1,
          acceptedSequence: 2,
          createdAt: "2026-10-22T10:00:00Z",
        },
      ],
    };
    fixture.location = {
      placement: {
        threadId: thread,
        environmentId: "guest",
        projectId: "vm-project",
        ownerUserId: "owner",
        organizationId: "org",
        repositoryId: "repo",
        generation: 2,
        operationId: null,
        activeMove: {
          operationId: "return-move",
          sourceEnvironmentId: "guest",
          sourceGeneration: 2,
          sourceKind: "vm",
          destinationEnvironmentId: env,
          destinationProjectId: "project",
          destinationKind: "environment",
          phase: "reopening",
          cancellationMode: "legacy",
        },
      },
      destination: null,
      recoveryRequested: false,
      isPending: false,
      movePending: true,
      error: null,
    };
    await mount(true);
    await openRunOn();
    const status = renderer!.root.findAllByProps({ role: "status" });
    expect(
      status.some((node) => node.children.join("").includes("Reopening source… → Akina")),
    ).toBe(true);
    expect(status.some((node) => node.children.join("").includes("Move blocked"))).toBe(false);
    expect(status.some((node) => node.children.join("").includes("Old VM setup failure"))).toBe(
      false,
    );
  });
  it("offers the next VM account editor only for a registered current local chat", async () => {
    fixture.signedIn = true;
    fixture.local = true;
    fixture.defaultCodex = true;
    fixture.localThread = {
      id: "thread",
      projectId: "project",
      modelSelection: { instanceId: "codex" },
      archivedAt: null,
    };
    await mount(true);
    await openRunOn();
    expect(button("VM account…")).toBeUndefined();
    fixture.route = { phase: "active", relayUrl: "https://relay.example.test", generation: 3 };
    await act(async () => renderer!.update(view(true)));
    expect(button("VM account…")).toBeDefined();
    fixture.route.phase = "retired";
    await act(async () => renderer!.update(view(true)));
    expect(button("VM account…")).toBeUndefined();
    fixture.route.phase = "active";
    fixture.local = false;
    await act(async () => renderer!.update(view(true)));
    expect(button("VM account…")).toBeUndefined();
  });
  it("keeps a pending VM account recoverable after closing its editor and blocks only the VM move", async () => {
    fixture.signedIn = true;
    fixture.local = true;
    fixture.defaultCodex = true;
    fixture.cloudConfigured = true;
    fixture.vmAccountPending = true;
    fixture.route = { phase: "active", relayUrl: "https://relay.example.test", generation: 3 };
    fixture.localThread = {
      id: "thread",
      projectId: "project",
      modelSelection: { instanceId: "codex" },
      archivedAt: null,
    };
    const vmDestination = () =>
      renderer!.root
        .findAllByType("button")
        .find((node) =>
          node.findAllByType("span").some((span) => span.children.includes("Private VM")),
        )!;
    await mount(true);
    await openRunOn();
    expect(vmDestination().props.disabled).toBe(true);
    expect(button("VM account…").props.disabled).toBe(false);
    await act(async () => button("VM account…").props.onClick());
    await act(async () => button("Close account editor").props.onClick());
    await openRunOn();
    expect(vmDestination().props.disabled).toBe(true);
    expect(button("VM account…").props.disabled).toBe(false);
    fixture.vmAccountPending = false;
    await act(async () => renderer!.update(view(true)));
    expect(vmDestination().props.disabled).toBe(false);
    const sendToVm = vmDestination().props.onClick;
    // A command that outlives its render still checks the current pending choice.
    fixture.vmAccountPending = true;
    await act(async () => sendToVm());
    expect(fixture.enqueue).not.toHaveBeenCalled();
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
  it("lets the move queue own progress and attention while a move is active", async () => {
    fixture.status = { setupPhase: "running" };
    const placement = {
      threadId: thread,
      environmentId: env,
      projectId: "project",
      generation: 2,
      organizationId: "org",
      repositoryId: "repo",
      ownerUserId: "owner",
      operationId: "move",
    };
    fixture.location = {
      placement,
      recoveryRequested: false,
      isPending: false,
      movePending: true,
      destination: null,
      error: null,
    };
    const queue = {
      ...emptyThreadPromptQueue(),
      entries: [
        {
          kind: "move" as const,
          state: "moving" as const,
          messageId: MessageId.make("message"),
          operationId: CommandId.make("move"),
          revision: 1,
          acceptedSequence: 1,
          destination: { kind: "vm" as const },
          createdAt: "2026-10-26T09:00:00Z",
        },
      ],
    };
    const moving = () => (
      <ThreadVmControlsProvider environmentId={env} threadId={thread}>
        <ThreadVmNotice queue={queue} />
      </ThreadVmControlsProvider>
    );
    await act(async () => {
      renderer = create(moving());
    });
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
    fixture.status = { finalSave: { errorCode: "save_failed" } };
    await act(async () => renderer!.update(moving()));
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
    await act(async () =>
      renderer!.update(
        <ThreadVmControlsProvider environmentId={env} threadId={thread}>
          <ThreadVmNotice />
        </ThreadVmControlsProvider>,
      ),
    );
    expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(1);
  });
  it.each([
    ["account_selection", "Choose a Codex account", "Choose account", undefined],
    ["personal_sign_in", "Waiting for Codex sign-in", "Sign in to Codex", undefined],
    ["organization_connection", "Connect organization Codex", "Connect Codex", undefined],
    ["verification", "Checking Codex sign-in", null, undefined],
    ["personal_sign_in", "Downloading files", null, null],
    ["personal_sign_in", "Waiting for Codex sign-in", "Sign in to Codex", "personal_sign_in"],
  ] as const)(
    "presents %s as %s with one notice and the appropriate action (%s, %s)",
    async (reason, label, action, workerAuth) => {
      const binding = {
        operationId: "move",
        allocationId: "allocation",
        environmentId: EnvironmentId.make("guest"),
        generation: 3,
        instanceId: "codex",
      };
      fixture.status = { allocation: null, setupPhase: "pending", pendingProviderAuth: binding };
      fixture.workerAuth = workerAuth;
      fixture.auth = {
        ...binding,
        requirement: "provider_unavailable",
        auth: {
          instanceId: "codex",
          phase: "error",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: "Earlier Codex read failed",
          interaction: null,
        },
      };
      const placement: RelayPortableThreadPlacement = {
        threadId: thread,
        environmentId: env,
        projectId: "project",
        generation: 2,
        organizationId: "org",
        repositoryId: "repo",
        ownerUserId: "owner",
        operationId: "move",
        moveProgress:
          typeof workerAuth === "string"
            ? []
            : [
                {
                  threadId: thread,
                  operationId: "move",
                  environmentId: "guest",
                  generation: 3,
                  participant: "destination",
                  attempt: 1,
                  revision: 1,
                  stage: "downloading",
                  completedBytes: 0,
                  totalBytes: null,
                  completedArtifacts: 0,
                  totalArtifacts: null,
                  waitingForAuth: reason,
                  updatedAt: "2026-10-30T09:00:00Z",
                },
              ],
      };
      fixture.location = {
        placement,
        recoveryRequested: false,
        isPending: false,
        movePending: true,
        destination: null,
        error: null,
      };
      const entry = {
        kind: "move" as const,
        state: "moving" as const,
        messageId: MessageId.make("message"),
        operationId: CommandId.make("move"),
        revision: 1,
        acceptedSequence: 1,
        destination: { kind: "vm" as const },
        createdAt: "2026-10-30T09:00:00Z",
      };
      const queue = { ...emptyThreadPromptQueue(), entries: [entry] };
      await act(async () => {
        renderer = create(
          <ThreadVmControlsProvider environmentId={env} threadId={thread}>
            <ThreadVmNotice queue={queue} />
            <ThreadVmRecoveryControls hideRefresh queue={queue} />
            <ThreadMoveQueueItem environmentId={env} threadId={thread} entry={entry} />
          </ThreadVmControlsProvider>,
        );
      });
      expect(JSON.stringify(renderer!.toJSON()).split(label)).toHaveLength(2);
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Earlier Codex read failed");
      expect(renderer!.root.findAllByProps({ "aria-label": "VM needs attention" })).toHaveLength(0);
      if (action === null) {
        expect(button("Sign in to Codex")).toBeUndefined();
      } else {
        const actions = renderer!.root
          .findAllByType("button")
          .filter((node) => node.children.join("") === action);
        expect(actions).toHaveLength(1);
        await act(async () => actions[0]!.props.onClick());
        expect(dialogs()).toHaveLength(1);
      }
      expect(fixture.authAction).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      "restore",
      "Cancel restore",
      {
        restore: {
          operationId: "lifecycle",
          phase: "preparing",
          canCancel: true,
          errorCode: "failed",
        },
      },
    ],
    [
      "reset",
      "Cancel reset",
      { reset: { operationId: "lifecycle", phase: "creating", errorCode: null } },
    ],
  ])("keeps %s recovery available with an empty queue", async (_kind, label, status) => {
    fixture.status = status;
    fixture.location = {
      placement: {
        threadId: thread,
        environmentId: env,
        projectId: "project",
        generation: 2,
        organizationId: "org",
        repositoryId: "repo",
        ownerUserId: "owner",
        operationId: "lifecycle",
      },
      recoveryRequested: false,
      isPending: false,
      movePending: true,
      destination: null,
      error: null,
    };
    await act(async () => {
      renderer = create(
        <ThreadVmControlsProvider environmentId={env} threadId={thread}>
          <ThreadVmRecoveryControls hideRefresh queue={emptyThreadPromptQueue()} />
        </ThreadVmControlsProvider>,
      );
    });
    expect(button(label)).toBeDefined();
    await act(async () => button(label).props.onClick());
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          type: _kind === "restore" ? "cancel_restore" : "cancel_reset",
          operationId: "lifecycle",
        }),
      }),
    );
  });
  it("keeps final-save failures visible when no VM allocation remains", async () => {
    fixture.status = {
      allocation: null,
      savedDisk: null,
      finalSave: { operationId: "save", phase: "saving", reason: "idle", errorCode: "failed" },
    };
    await act(async () => {
      renderer = create(
        <ThreadVmControlsProvider environmentId={env} threadId={thread}>
          <ThreadVmRecoveryControls hideRefresh queue={emptyThreadPromptQueue()} />
        </ThreadVmControlsProvider>,
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saving VM needs attention");
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
  it.each([false, true])(
    "keeps account controls hidden while the move has no destination auth wait (chat: %s)",
    async (chat) => {
      fixture.local = true;
      fixture.status = {
        pendingProviderAuth: {
          allocationId: "new-vm",
          operationId: "move",
          environmentId: EnvironmentId.make("guest"),
          generation: 3,
          instanceId: "codex",
        },
        setupPhase: "pending",
      };
      fixture.auth = {
        requirement: "sign_in_required",
        auth: { phase: "waiting", expiresAt: null },
      };
      fixture.authReadError = "Earlier sign-in read failed.";
      await mount(chat);
      if (chat) await openRunOn();
      expect(button("Sign in to Codex") !== undefined).toBe(false);
      expect(button("Finish Codex sign-in") !== undefined).toBe(false);
      expect(button("Codex account…") !== undefined).toBe(false);
      expect(dialogs()).toHaveLength(0);
      expect(JSON.stringify(renderer!.toJSON()).includes("Earlier sign-in read failed.")).toBe(
        false,
      );
      expect(fixture.authAction).not.toHaveBeenCalled();
    },
  );
  it("replaces an open move sign-in dialog with preparation when the auth wait clears", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: {
        allocationId: "new-vm",
        operationId: "move",
        environmentId: EnvironmentId.make("guest"),
        generation: 3,
        instanceId: "codex",
      },
      setupPhase: "pending",
    };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.authReadError = "Earlier sign-in read failed.";
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        flowId: "old-flow",
        authorizationUrl: "https://chatgpt.com/activate",
        interaction: {
          type: "deviceCode",
          id: "old-flow",
          url: "https://chatgpt.com/activate",
          userCode: "OLD-MOVE-CODE",
        },
      },
    };
    await mount(true);
    await act(async () => button("Finish Codex sign-in").props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).toContain("OLD-MOVE-CODE");
    fixture.workerAuth = null;
    fixture.authTransitionKey = "preparing";
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(1);
    const preparing = JSON.stringify(renderer!.toJSON());
    expect(preparing.includes("Account connected")).toBe(false);
    expect(preparing.includes("Checking whether Codex is ready in this VM.")).toBe(true);
    expect(preparing.includes("OLD-MOVE-CODE")).toBe(false);
    expect(preparing.includes("Earlier sign-in read failed.")).toBe(false);
    expect(dialogButton("Check sign-in status")).toBeUndefined();
    expect(dialogButton("Open Codex sign-in page")).toBeUndefined();
    fixture.workerAuth = "personal_sign_in";
    fixture.authTransitionKey = "waiting-again";
    fixture.authReadError = null;
    fixture.auth = {
      requirement: "sign_in_required",
      auth: { phase: "idle", expiresAt: null },
    };
    await act(async () => renderer!.update(view(true)));
    expect(dialogButton("Sign in to Codex")).toBeDefined();
    expect(fixture.authAction).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "keeps current verification failures visible and retryable in an open dialog (chat: %s)",
    async (chat) => {
      fixture.local = true;
      fixture.status = {
        pendingProviderAuth: {
          allocationId: "new-vm",
          operationId: "move",
          environmentId: EnvironmentId.make("guest"),
          generation: 3,
          instanceId: "codex",
        },
        setupPhase: "pending",
      };
      fixture.workerAuth = "personal_sign_in";
      fixture.authSource = { mode: "personal" };
      fixture.auth = {
        requirement: "sign_in_required",
        auth: { phase: "idle", expiresAt: null },
      };
      await mount(chat);
      if (chat) await openRunOn();
      await act(async () => button("Sign in to Codex").props.onClick());
      fixture.workerAuth = "verification";
      fixture.authTransitionKey = "verification";
      fixture.authReadError = "The VM could not be reached.";
      await act(async () => renderer!.update(view(chat)));
      const dialogText = () =>
        dialogs()[0]!
          .findAllByType("p")
          .map((node) => node.children.join(""))
          .join("\n");
      expect(dialogText()).toContain("The VM could not be reached.");
      expect(dialogButton("Sign in to Codex")).toBeUndefined();
      expect(button("Codex account…")).toBeUndefined();
      await act(async () => dialogButton("Check status").props.onClick());
      expect(fixture.refresh).toHaveBeenCalledWith(null, env, thread);
      expect(fixture.authAction).not.toHaveBeenCalled();
      fixture.authReadError = null;
      await act(async () => renderer!.update(view(chat)));
      expect(dialogText()).toContain("Checking whether Codex is ready");
      expect(dialogButton("Check status")).toBeUndefined();
    },
  );
  it("keeps destination sign-in reachable while the current machine is local", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: moveAuthBinding,
      setupPhase: "running",
    };
    fixture.workerAuth = "personal_sign_in";
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
        binding: moveAuthBinding,
        action: { type: "start" },
      }),
    );
  });
  it("shows account selection as a normal step before offering provider actions", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: moveAuthBinding,
      setupPhase: "running",
    };
    fixture.accountSelectionRequired = true;
    fixture.workerAuth = "account_selection";
    await mount(true);
    await act(async () => button("Choose account").props.onClick());
    const dialog = dialogs()[0]!;
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose a Codex account");
    expect(dialog.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(dialogButton("Check sign-in status")).toBeUndefined();
    expect(dialogButton("Sign in to Codex")).toBeUndefined();
    expect(fixture.authAction).not.toHaveBeenCalled();
    fixture.accountSelectionRequired = false;
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    await act(async () => renderer!.update(view(true)));
    expect(dialogButton("Sign in to Codex")).toBeDefined();
    await act(async () => dialogButton("Sign in to Codex").props.onClick());
    expect(fixture.authAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "start" } }),
    );
  });
  it("replaces the account choices with one connected identity only after Codex is verified", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "account_selection";
    fixture.accountSelectionRequired = true;
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "account@example.test",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSelection = {
        phase: "confirmed",
        requested: { mode: "organization", connectionId: "org-codex" },
        error: null,
      };
      fixture.authSource = {
        mode: "organization",
        connectionId: "org-codex",
        connection: fixture.codexConnection!,
      };
      fixture.accountSelectionRequired = false;
      return AsyncResult.success(null);
    });
    await mount(true);
    await act(async () => button("Choose account").props.onClick());
    expect(dialogText().split("account@example.test")).toHaveLength(2);
    expect(dialogText()).toContain("Your choice will be used for future VM moves.");
    expect(dialogText()).not.toContain("Account connected");
    await act(async () => accountPicker().props.onValueChange("organization:org-codex"));
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).not.toContain("Account connected");
    expect(accountPicker()).toBeDefined();
    fixture.auth = {
      requirement: "authenticated",
      auth: { phase: "idle", expiresAt: null },
      authSource: fixture.authSource,
    };
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Account connected");
    expect(dialogText().split("account@example.test")).toHaveLength(2);
    expect(dialogText().split("VM preparation continues automatically.")).toHaveLength(2);
    expect(accountPicker()).toBeUndefined();
    expect(dialogButton("Manage usage")).toBeUndefined();
    expect(dialogButton("Check sign-in status")).toBeUndefined();
    expect(dialogs()[0]!.findAllByType("button")).toHaveLength(2);
    expect(dialogButton("Close")).toBeDefined();
    await act(async () =>
      dialogs()[0]!.findByProps({ "aria-label": "Close Codex account" }).props.onClick(),
    );
    expect(dialogs()).toHaveLength(0);
  });
  it("retains the same connected dialog through verification and completed move handoff", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    await mount(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    fixture.auth = {
      requirement: "authenticated",
      auth: { phase: "idle", expiresAt: null },
      authSource: fixture.authSource,
    };
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Account connected");
    fixture.workerAuth = "verification";
    fixture.authTransitionKey = "verification";
    fixture.auth = null;
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(1);
    expect(dialogText()).toContain("Account connected");
    expect(dialogText().split("Personal sign-in")).toHaveLength(2);
    expect(accountPicker()).toBeUndefined();
    fixture.dialogCompleted = true;
    fixture.workerAuth = undefined;
    fixture.status = { generation: 3, setupPhase: "ready", pendingProviderAuth: null };
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()).toHaveLength(1);
    expect(dialogText()).toContain("Account connected");
    expect(dialogText().split("VM preparation continues automatically.")).toHaveLength(2);
    await closeDialog();
    expect(dialogs()).toHaveLength(0);
  });
  it("does not turn a finished personal device flow into success before the authenticated probe", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    await mount(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    fixture.auth = {
      requirement: "sign_in_required",
      auth: { phase: "succeeded", expiresAt: null },
    };
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Checking whether Codex is ready in this VM.");
    expect(dialogText()).not.toContain("Account connected");
    expect(dialogText()).not.toContain("Codex signed in");
    expect(dialogText()).not.toContain("Signed in to Codex.");
    expect(dialogText()).not.toContain("VM preparation continues automatically.");
  });
  it("clears a former account confirmation on cancellation and does not carry it to a new VM", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    await mount(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    fixture.auth = { requirement: "authenticated", auth: { phase: "idle", expiresAt: null } };
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Account connected");
    fixture.status = { pendingProviderAuth: null, setupPhase: "ready" };
    fixture.auth = null;
    fixture.authSource = null;
    fixture.workerAuth = null;
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("This VM request changed");
    expect(dialogText()).not.toContain("Account connected");
    expect(dialogText()).not.toContain("Personal sign-in");
    fixture.status = {
      pendingProviderAuth: {
        ...moveAuthBinding,
        allocationId: "replacement-vm",
        operationId: "replacement-move",
      },
      setupPhase: "running",
    };
    fixture.workerAuth = "account_selection";
    fixture.accountSelectionRequired = true;
    fixture.authTransitionKey = "replacement";
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).not.toContain("Account connected");
    expect(accountPicker().props.value).toBeNull();
    expect(dialogText()).toContain("Choose an account for this chat.");
  });
  it("consumes Change account through saving, a form remount, and an unknown reply", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "authenticated", auth: { phase: "idle", expiresAt: null } };
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "account@example.test",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    const pending = deferred();
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.selectionRevision++;
      fixture.authSelection = {
        phase: "saving",
        requested: { mode: "organization", connectionId: "org-codex" },
        error: null,
      };
      await pending.promise;
      fixture.authSelection = {
        ...fixture.authSelection,
        phase: "unknown",
        error: "The choice could not be confirmed.",
      };
      return AsyncResult.fail(new Error("The choice could not be confirmed."));
    });
    await mount(true);
    await openRunOn();
    await act(async () => button("Change Codex account…").props.onClick());
    expect(accountPicker()).toBeDefined();
    expect(dialogText()).toContain("Choose an account for this chat.");
    await act(async () => accountPicker().props.onValueChange("organization:org-codex"));
    expect(dialogText()).toContain("Saving choice…");
    fixture.authTransitionKey = "new-selection";
    fixture.auth = null;
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Saving choice…");
    await act(async () => pending.resolve());
    await act(async () => renderer!.update(view(true)));
    expect(dialogButton("Check selection")).toBeDefined();
    fixture.authSelection = { ...fixture.authSelection, phase: "confirmed", error: null };
    fixture.authSource = {
      mode: "organization",
      connectionId: "org-codex",
      connection: fixture.codexConnection,
    };
    fixture.auth = {
      requirement: "authenticated",
      auth: { phase: "idle", expiresAt: null },
      authSource: fixture.authSource,
    };
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).toContain("Account connected");
    expect(dialogText()).not.toContain("Choose an account for this chat.");
    expect(accountPicker()).toBeUndefined();
  });
  it("does not reopen a closed account dialog when its old selection reply arrives", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "account_selection";
    fixture.accountSelectionRequired = true;
    const pending = deferred();
    fixture.authAction.mockImplementationOnce(async () => {
      await pending.promise;
      return AsyncResult.success(null);
    });
    await mount(true);
    await act(async () => button("Choose account").props.onClick());
    await act(async () => accountPicker().props.onValueChange("personal"));
    await closeDialog();
    await act(async () => pending.resolve());
    expect(dialogs()).toHaveLength(0);
  });
  it("keeps the personal device-code copy, open, cancel, and retry flow available", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        flowId: "personal-flow",
        interaction: {
          type: "deviceCode",
          url: "https://auth.openai.com/codex/device",
          userCode: "PERSONAL-CODE",
        },
      },
    };
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    fixture.openLink.mockResolvedValue(undefined);
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.auth = {
        requirement: "sign_in_required",
        auth: { phase: "cancelled", expiresAt: null },
      };
      return AsyncResult.success(null);
    });
    await mount(true);
    await act(async () => button("Finish Codex sign-in").props.onClick());
    expect(dialogText()).toContain("PERSONAL-CODE");
    await act(async () => dialogButton("Copy code").props.onClick());
    expect(copy).toHaveBeenCalledWith("PERSONAL-CODE");
    await act(async () => dialogButton("Open Codex sign-in page").props.onClick());
    expect(fixture.openLink).toHaveBeenCalledWith("https://auth.openai.com/codex/device", {
      recordHistory: false,
    });
    await act(async () => dialogButton("Cancel sign-in").props.onClick());
    await act(async () => renderer!.update(view(true)));
    expect(fixture.authAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "cancel", flowId: "personal-flow" } }),
    );
    expect(dialogText()).not.toContain("PERSONAL-CODE");
    await act(async () => dialogButton("Retry Codex sign-in").props.onClick());
    expect(fixture.authAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { type: "start" } }),
    );
    expect(dialogText()).not.toContain("Account connected");
  });
  it("discards a late personal-page error after switching to the organization account", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        flowId: "personal-flow",
        interaction: {
          type: "deviceCode",
          url: "https://auth.openai.com/codex/device",
          userCode: "PERSONAL-CODE",
        },
      },
    };
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "account@example.test",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    const pending = deferred();
    fixture.openLink.mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("Old link failed");
    });
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSource = {
        mode: "organization",
        connectionId: "org-codex",
        connection: fixture.codexConnection!,
      };
      fixture.auth = { ...fixture.auth, authSource: fixture.authSource };
      return AsyncResult.success(null);
    });
    await mount(true);
    await act(async () => button("Finish Codex sign-in").props.onClick());
    await act(async () => dialogButton("Open Codex sign-in page").props.onClick());
    await act(async () => accountPicker().props.onValueChange("organization:org-codex"));
    await act(async () => renderer!.update(view(true)));
    await act(async () => pending.resolve());
    expect(dialogText()).not.toContain("Could not open the Codex sign-in page");
    expect(dialogText()).not.toContain("PERSONAL-CODE");
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(accountPicker().props.value).toBe("organization:org-codex");
  });
  it("hides a visible personal-page failure when external account selection changes without a form remount", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        interaction: {
          type: "deviceCode",
          url: "https://auth.openai.com/codex/device",
          userCode: "PERSONAL-CODE",
        },
      },
    };
    fixture.openLink.mockRejectedValueOnce(new Error("Browser unavailable"));
    await mount(true);
    await act(async () => button("Finish Codex sign-in").props.onClick());
    await act(async () => dialogButton("Open Codex sign-in page").props.onClick());
    expect(dialogText()).toContain("Could not open the Codex sign-in page");
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "account@example.test",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    fixture.authSource = {
      mode: "organization",
      connectionId: "org-codex",
      connection: fixture.codexConnection,
    };
    fixture.selectionRevision++;
    fixture.auth = { ...fixture.auth, authSource: fixture.authSource };
    fixture.authReadError = "The current VM could not be reached.";
    await act(async () => renderer!.update(view(true)));
    expect(dialogText()).not.toContain("Could not open the Codex sign-in page");
    expect(dialogText()).toContain("The current VM could not be reached.");
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(fixture.authTransitionKey).toBe("initial");
    expect(fixture.authAction).not.toHaveBeenCalled();
  });
  it("shows a saving choice across an auth remount and keeps its acknowledgment when verification fails", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        interaction: {
          type: "deviceCode",
          url: "https://chatgpt.com/activate",
          userCode: "PREVIOUS-ACCOUNT-CODE",
        },
      },
    };
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "VM account",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    const requested = { mode: "organization", connectionId: "org-codex" } as const;
    const pending = deferred();
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSelection = { phase: "saving", requested, error: null };
      await pending.promise;
      fixture.authSelection = { phase: "confirmed", requested, error: null };
      fixture.authSource = {
        ...requested,
        connection: fixture.codexConnection!,
      };
      fixture.auth = null;
      fixture.accountSelectionRequired = false;
      return AsyncResult.success(null);
    });
    await mount(true);
    await act(async () => button("Finish Codex sign-in").props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).toContain("PREVIOUS-ACCOUNT-CODE");
    await act(async () => accountPicker().props.onValueChange("organization:org-codex"));
    expect(accountPicker().props.value).toBe("organization:org-codex");
    expect(accountPicker().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saving choice…");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("PREVIOUS-ACCOUNT-CODE");
    expect(
      dialogs()[0]!
        .findAllByType("p")
        .filter((node) => node.props.role === "status" && node.children.includes("Saving choice…")),
    ).toHaveLength(1);

    fixture.authTransitionKey = "same-binding-new-worker-state";
    await act(async () => renderer!.update(view(true)));
    expect(accountPicker().props.value).toBe("organization:org-codex");
    expect(accountPicker().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saving choice…");
    await act(async () => accountPicker().props.onValueChange("personal"));
    expect(fixture.authAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
      await pending.promise;
      renderer!.update(view(true));
    });
    expect(accountPicker().props.value).toBe("organization:org-codex");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Your account choice is saved.");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Checking Codex sign-in");
    expect(dialogButton("Open Codex sign-in page")).toBeUndefined();

    fixture.authReadError = "The VM could not be reached.";
    await act(async () => renderer!.update(view(true)));
    expect(accountPicker().props.value).toBe("organization:org-codex");
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Your account choice is saved.");
    expect(text).toContain("Could not check Codex sign-in");
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(dialogButton("Check sign-in status")).toBeDefined();
    expect(fixture.authAction).toHaveBeenCalledTimes(1);
  });
  it("keeps an unknown choice actionable without allowing a different account or duplicating its error", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.accountSelectionRequired = true;
    fixture.workerAuth = "account_selection";
    const message = "The relay did not confirm the saved choice.";
    fixture.authSelection = {
      phase: "unknown",
      requested: { mode: "personal" },
      error: message,
    };
    fixture.authSourceError = message;
    fixture.authReadError = message;
    await mount(true);
    await act(async () => button("Choose account").props.onClick());
    expect(accountPicker().props.value).toBe("personal");
    expect(accountPicker().props.disabled).toBe(true);
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(dialogButton("Sign in to Codex")).toBeUndefined();
    expect(dialogButton("Check sign-in status")).toBeUndefined();
    await act(async () => accountPicker().props.onValueChange("organization:other"));
    expect(fixture.authAction).not.toHaveBeenCalled();

    await act(async () => dialogButton("Check selection").props.onClick());
    expect(fixture.authAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "check_selection" } }),
    );
    const pending = deferred();
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSelection = {
        phase: "saving",
        requested: { mode: "personal" },
        error: null,
      };
      await pending.promise;
      fixture.authSelection = {
        phase: "confirmed",
        requested: { mode: "personal" },
        error: null,
      };
      fixture.authSource = { mode: "personal" };
      fixture.accountSelectionRequired = false;
      fixture.authSourceError = null;
      fixture.authReadError = null;
      fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
      return AsyncResult.success(null);
    });
    await act(async () => dialogButton("Retry same choice").props.onClick());
    expect(fixture.authAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { type: "retry_selection" } }),
    );
    expect(accountPicker().props.value).toBe("personal");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saving choice…");
    await act(async () => {
      pending.resolve();
      await pending.promise;
      renderer!.update(view(true));
    });
    expect(accountPicker().props.value).toBe("personal");
    expect(dialogButton("Sign in to Codex")).toBeDefined();
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it("retains the confirmed account and shows one selection failure after a rejected choice", async () => {
    fixture.local = true;
    fixture.status = { pendingProviderAuth: moveAuthBinding, setupPhase: "running" };
    fixture.workerAuth = "personal_sign_in";
    fixture.authSource = { mode: "personal" };
    fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "VM account",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    const message = "The organization account is no longer available.";
    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSelection = {
        phase: "rejected",
        requested: { mode: "organization", connectionId: "org-codex" },
        error: message,
      };
      fixture.authSourceError = message;
      return AsyncResult.fail(new Error(message));
    });
    await mount(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    await act(async () => accountPicker().props.onValueChange("organization:org-codex"));
    await act(async () => renderer!.update(view(true)));
    expect(accountPicker().props.value).toBe("personal");
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain(message);
    expect(dialogButton("Sign in to Codex")).toBeDefined();

    fixture.authAction.mockImplementationOnce(async () => {
      fixture.authSelection = { phase: "idle", requested: null, error: null };
      fixture.authSourceError = null;
      fixture.auth = {
        requirement: "sign_in_required",
        auth: {
          phase: "waiting",
          expiresAt: null,
          interaction: {
            type: "deviceCode",
            url: "https://chatgpt.com/activate",
            userCode: "NEW-PERSONAL-CODE",
          },
        },
      };
      return AsyncResult.success(null);
    });
    await act(async () => dialogButton("Sign in to Codex").props.onClick());
    await act(async () => renderer!.update(view(true)));
    expect(fixture.authAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: { type: "start" } }),
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("NEW-PERSONAL-CODE");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(message);
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it("opens organization account setup without selecting an account or changing the move", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: moveAuthBinding,
      setupPhase: "running",
    };
    fixture.accountSelectionRequired = true;
    fixture.workerAuth = "organization_connection";
    await mount(true);
    await act(async () => button("Connect Codex").props.onClick());
    await act(async () => dialogButton("Open organization settings").props.onClick());
    expect(dialogs()).toHaveLength(0);
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings/organization",
      hash: "organization-codex-vms",
      hashScrollIntoView: false,
    });
    expect(fixture.authAction).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });
  it("shows each real sign-in error once while keeping different failures visible", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: moveAuthBinding,
      setupPhase: "running",
    };
    fixture.authSourceError = "Could not reach the relay.";
    fixture.workerAuth = "personal_sign_in";
    fixture.authReadError = "Could not reach the relay.";
    await mount(true);
    await act(async () => button("Sign in to Codex").props.onClick());
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(1);
    fixture.authSourceError = "Could not read the organization account.";
    await act(async () => renderer!.update(view(true)));
    expect(dialogs()[0]!.findAllByProps({ role: "alert" })).toHaveLength(2);
  });
  it.each([false, true])(
    "discards an earlier sign-in action failure when worker preparation resumes (late reply: %s)",
    async (lateReply) => {
      fixture.local = true;
      fixture.status = {
        pendingProviderAuth: moveAuthBinding,
        setupPhase: "running",
      };
      fixture.authSource = { mode: "personal" };
      fixture.auth = { requirement: "sign_in_required", auth: { phase: "idle", expiresAt: null } };
      fixture.workerAuth = "personal_sign_in";
      const pending = deferred();
      fixture.authAction.mockImplementationOnce(async () => {
        if (lateReply) await pending.promise;
        return AsyncResult.fail(new Error("Earlier sign-in request failed."));
      });
      await mount(true);
      await act(async () => button("Sign in to Codex").props.onClick());
      await act(async () => dialogButton("Sign in to Codex").props.onClick());
      if (!lateReply)
        expect(JSON.stringify(renderer!.toJSON())).toContain("Earlier sign-in request failed.");
      fixture.workerAuth = null;
      fixture.authTransitionKey = "new-work-attempt";
      fixture.auth = null;
      await act(async () => renderer!.update(view(true)));
      await act(async () => pending.resolve());
      expect(dialogs()).toHaveLength(1);
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Earlier sign-in request failed.");
      expect(fixture.authAction).toHaveBeenCalledTimes(1);
    },
  );
  it("hides an old personal challenge when an account choice is required", async () => {
    fixture.local = true;
    fixture.status = {
      pendingProviderAuth: moveAuthBinding,
      setupPhase: "running",
    };
    fixture.accountSelectionRequired = true;
    fixture.workerAuth = "account_selection";
    fixture.auth = {
      requirement: "sign_in_required",
      auth: {
        phase: "waiting",
        expiresAt: null,
        flowId: "old-flow",
        authorizationUrl: "https://chatgpt.com/activate",
        interaction: {
          type: "deviceCode",
          url: "https://chatgpt.com/activate",
          userCode: "OLD-CODE",
        },
      },
    };
    await mount(true);
    await act(async () => button("Choose account").props.onClick());
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("OLD-CODE");
    expect(dialogButton("Open Codex sign-in page")).toBeUndefined();
    expect(dialogButton("Cancel sign-in")).toBeUndefined();
  });
  it("lets a managed VM import with a failed probe reopen account selection without personal device actions", async () => {
    fixture.status = {
      pendingProviderAuth: { ...moveAuthBinding, generation: 2 },
      setupPhase: "running",
    };
    fixture.codexConnection = {
      connectionId: "org-codex",
      label: "VM account",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    };
    fixture.authSource = {
      mode: "organization",
      connectionId: "org-codex",
      connection: fixture.codexConnection,
    };
    fixture.auth = {
      requirement: "provider_unavailable",
      auth: {
        phase: "waiting",
        expiresAt: null,
        flowId: "stale-personal",
        authorizationUrl: "https://chatgpt.com/activate",
        interaction: {
          type: "deviceCode",
          url: "https://chatgpt.com/activate",
          userCode: "STALE-CODE",
        },
        message: "Codex probe failed.",
      },
    };
    await mount();
    await act(async () => button("Codex account…").props.onClick());
    expect(dialogs()).toHaveLength(1);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Codex probe failed.");
    expect(text).not.toContain("STALE-CODE");
    expect(dialogButton("Cancel sign-in")).toBeUndefined();
    expect(dialogButton("Open Codex sign-in page")).toBeUndefined();
    expect(dialogButton("Manage usage")).toBeUndefined();
    expect(fixture.authAction).not.toHaveBeenCalled();
    fixture.codexConnection = { ...fixture.codexConnection, connectionId: "replacement" };
    fixture.auth = { ...fixture.auth, requirement: "authenticated" };
    await act(async () => renderer!.update(view()));
    const replaced = dialogs()[0]!
      .findAllByType("p")
      .map((node) => node.children.join(" "))
      .join(" ");
    expect(replaced).toContain("Choose the replacement account or personal sign-in");
    expect(replaced).not.toContain("VM preparation continues automatically");
    expect(replaced).not.toContain("Using organization ChatGPT plan");
    expect(dialogButton("Manage usage")).toBeUndefined();
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
