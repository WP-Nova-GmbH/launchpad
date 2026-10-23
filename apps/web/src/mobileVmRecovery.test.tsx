import { act, useSyncExternalStore, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { RelayThreadVmStatus } from "@t3tools/contracts/relay";
import type { ThreadVmActionSubmission } from "@t3tools/client-runtime/relay/threadVmActionSubmission";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
interface QueuedThreadMessage {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
  commandId: CommandId;
  text: string;
  attachments: ReadonlyArray<{
    id: string;
    type: "file";
    name: string;
    mimeType: string;
    sizeBytes: number;
    fileUri: string;
  }>;
  submissionProtocol: "shared" | "unattempted";
  createdAt: string;
}
interface OutboxManager {
  queuedMessagesByThreadKeyAtom: Atom.Writable<Record<string, ReadonlyArray<QueuedThreadMessage>>>;
  load(): Promise<boolean>;
  enqueue(message: QueuedThreadMessage): Promise<void>;
  confirmQueued(message: QueuedThreadMessage): Promise<boolean>;
  revisionOf(id: MessageId): number;
  update(message: QueuedThreadMessage, revision?: number): Promise<boolean>;
  remove(message: QueuedThreadMessage, revision?: number): Promise<QueuedThreadMessage | null>;
}

// Run the mobile hooks with the web test renderer's React, keeping the real effects and atoms.
vi.mock("../../mobile/node_modules/react/index.js", async () => import("react"));
const fixture = vi.hoisted(() => ({
  manager: null as unknown as OutboxManager,
  configs: new Map(),
  connected: [{ environmentId: "mac", connectionState: "connected" }],
  navigation: [] as ReadonlyArray<EnvironmentThreadShell>,
  send: vi.fn(),
  receipt: vi.fn(),
  prepare: vi.fn(),
  backup: vi.fn(),
  preview: vi.fn(),
  auth: vi.fn(),
  removeFile: vi.fn(),
  removeCloud: vi.fn(async () => undefined),
  loaded: vi.fn(async () => undefined),
  vmLifecycle: {
    entries: [] as ThreadVmActionSubmission[],
    ready: false,
    busy: false,
    error: "Storage unavailable" as string | null,
    run: vi.fn(),
  },
}));
vi.mock("../../mobile/node_modules/@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return {
    RegistryContext: createContext(null),
    useAtomValue: (atom: Atom.Atom<unknown>) =>
      useSyncExternalStore(
        (notify) => appAtomRegistry.subscribe(atom, notify),
        () => appAtomRegistry.get(atom),
      ),
  };
});
vi.mock("../../mobile/node_modules/react-native", () => ({
  Alert: { alert: vi.fn() },
  View: "div",
  Text: "span",
  Pressable: "button",
  ScrollView: "section",
  Modal: ({ visible, children, ...props }: React.PropsWithChildren<{ visible: boolean }>) =>
    visible ? <dialog {...props}>{children}</dialog> : null,
  Platform: { OS: "android" },
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../mobile/node_modules/expo-crypto", () => ({ randomUUID: () => "test-operation" }));
vi.mock("../../mobile/node_modules/expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../../mobile/node_modules/react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../mobile/src/components/ContextSheetSize", () => ({ ContextSheetSize: () => null }));
vi.mock("../../mobile/src/components/AppText", () => ({ AppText: "span", AppTextInput: "input" }));
vi.mock("../../mobile/src/state/entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => fixture.configs,
  useThreadShells: () => fixture.navigation,
}));
vi.mock("../../mobile/src/state/server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  // useServerConfigs normally mounts the config. Its fixture returns a map,
  // so retain the value across the protocol-capture and delivery effects.
  return {
    serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null).pipe(Atom.keepAlive)) },
  };
});
vi.mock("../../mobile/src/state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentThreadShells: { threadShellsAtom: Atom.make([]).pipe(Atom.keepAlive) },
    threadEnvironment: { enqueuePrompt: "enqueue", getCommandReceipt: "receipt" },
    threadVmControls: {
      viewAtom: () => vmViewAtom,
      checkBackupRecovery: "backup",
      openPreview: "preview",
      providerAuthAction: "auth",
      refresh: vi.fn(),
      capabilitiesAtom: Atom.make({
        data: {
          configured: true,
          replacement: true,
          restore: true,
          reset: true,
          permanentDelete: true,
          privatePreview: true,
        },
        isPending: false,
        error: null,
      }),
    },
    threadVmActionJournal: {},
  };
});
vi.mock("../../mobile/src/state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
}));
vi.mock("../../mobile/src/state/use-thread-vm-actions", () => ({
  useThreadVmActionJournal: () => fixture.vmLifecycle,
}));
vi.mock("../../mobile/src/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "enqueue"
      ? fixture.send
      : command === "receipt"
        ? fixture.receipt
        : command === "backup"
          ? fixture.backup
          : command === "preview"
            ? fixture.preview
            : command === "auth"
              ? fixture.auth
              : vi.fn(),
}));
vi.mock("../../mobile/src/state/use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    dispatchingQueuedMessageIdAtom: Atom.make(null).pipe(Atom.keepAlive),
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => useAtomValue(fixture.manager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["mac", "live"]]),
  };
});
vi.mock("../../mobile/src/state/use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: fixture.connected }),
}));
vi.mock("../../mobile/src/lib/attachmentUpload", () => ({
  prepareTurnAttachments: fixture.prepare,
}));
vi.mock("../../mobile/src/lib/composerImages", () => ({
  isFileBackedComposerAttachment: () => true,
  toUploadChatImageAttachments: () => [],
}));
vi.mock("../../mobile/src/lib/uuid", () => ({ randomHex: () => "abcd" }));
vi.mock("../../mobile/src/state/use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: fixture.removeCloud,
    waitForComposerDraftsLoaded: fixture.loaded,
  };
});
vi.mock("../../mobile/src/state/thread-outbox", async () => {
  const managerPath = "../../mobile/src/state/thread-outbox-manager";
  const { createThreadOutboxManager } = await vi.importActual<{
    createThreadOutboxManager(input: {
      registry: AtomRegistry.AtomRegistry;
      storage: {
        load(): Promise<{
          messages: ReadonlyArray<QueuedThreadMessage>;
          errors: ReadonlyArray<unknown>;
        }>;
        write(): Promise<void>;
        remove(): Promise<void>;
      };
    }): OutboxManager;
  }>(managerPath);
  const registryPath = "../../mobile/src/state/atom-registry";
  const { appAtomRegistry } = await vi.importActual<{ appAtomRegistry: AtomRegistry.AtomRegistry }>(
    registryPath,
  );
  fixture.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: async () => undefined,
    },
  });
  return {
    threadOutboxManager: fixture.manager,
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      fixture.manager.confirmQueued(message),
    threadOutboxRevision: (id: MessageId) => fixture.manager.revisionOf(id),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      fixture.manager.update(message, revision),
  };
});
vi.mock("../../mobile/src/state/thread-outbox-removal", () => ({
  removeThreadOutboxMessage: async (message: QueuedThreadMessage, revision?: number) => {
    const removed = await fixture.manager.remove(message, revision);
    if (removed) fixture.removeFile(message.attachments);
    return removed;
  },
}));

function useAtomValue<A>(atom: Atom.Atom<A>): A {
  return useSyncExternalStore(
    (notify) => appAtomRegistry.subscribe(atom, notify),
    () => appAtomRegistry.get(atom),
  );
}
const registryPath = "../../mobile/src/state/atom-registry";
const { appAtomRegistry } = await vi.importActual<{ appAtomRegistry: AtomRegistry.AtomRegistry }>(
  registryPath,
);
const { environmentThreadShells } = await vi.importMock<{
  environmentThreadShells: {
    threadShellsAtom: Atom.Writable<ReadonlyArray<EnvironmentThreadShell>>;
  };
}>("../../mobile/src/state/threads");
const { serverEnvironment } = await vi.importMock<{
  serverEnvironment: {
    configValueAtom(environmentId: EnvironmentId): Atom.Writable<ServerConfig | null>;
  };
}>("../../mobile/src/state/server");
const drainPath = "../../mobile/src/state/use-thread-outbox-drain";
const { useThreadOutboxDrain } = await vi.importActual<{ useThreadOutboxDrain(): void }>(drainPath);
const vmControlsPath = "../../mobile/src/features/threads/ThreadVmControls";
const { ThreadVmControls, ThreadVmControlsProvider, ThreadVmNotice, ThreadVmMenuActions } =
  await vi.importActual<{
    ThreadVmControls: React.ComponentType<{
      environmentId: EnvironmentId;
      threadId: ThreadId;
    }>;
    ThreadVmControlsProvider: React.ComponentType<
      PropsWithChildren<{ environmentId: EnvironmentId; threadId: ThreadId }>
    >;
    ThreadVmNotice: React.ComponentType;
    ThreadVmMenuActions: React.ComponentType<{ onAction: (action: () => void) => void }>;
  }>(vmControlsPath);

const { dispatchingQueuedMessageIdAtom } = await vi.importMock<{
  dispatchingQueuedMessageIdAtom: Atom.Writable<MessageId | null>;
}>("../../mobile/src/state/use-thread-outbox");
const dispatchingAtom = dispatchingQueuedMessageIdAtom as Atom.Writable<MessageId | null>;

const initialVmStatus: RelayThreadVmStatus = {
  threadId: ThreadId.make("thread"),
  generation: 2,
  allocation: { state: "running", allocationId: "allocation", ownerUserId: "owner" },
  activity: "idle",
  setupPhase: "ready",
  capacityState: null,
  pausePhase: null,
  resumePhase: null,
  backupPhase: null,
  lastVerifiedBackupAt: "2026-10-22T10:00:00Z",
  repository: { canonicalKey: "test-repo", branch: "main", revision: "abcdef012345" },
};
const initialVmView: {
  accountId: string;
  error: string | null;
  isPending: boolean;
  queuePaused: boolean;
  providerAuth: import("@t3tools/contracts/relay").RelayThreadVmProviderAuth | null;
  providerAuthError: string | null;
  providerAuthPending: boolean;
  data: {
    candidates: import("@t3tools/contracts/relay").RelayThreadVmReplacementCandidate[];
    status: RelayThreadVmStatus;
  };
} = {
  accountId: "owner",
  error: null,
  isPending: false,
  queuePaused: false,
  providerAuth: null,
  providerAuthError: null,
  providerAuthPending: false,
  data: { candidates: [], status: initialVmStatus },
};
const vmViewAtom = Atom.make(initialVmView);
const source: EnvironmentThreadShell = {
  id: ThreadId.make("thread"),
  environmentId: EnvironmentId.make("mac"),
  projectId: ProjectId.make("project"),
  title: "Moved thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-10-22T10:00:00Z",
  updatedAt: "2026-10-22T10:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  relayRouting: { relayUrl: "https://relay.example.test", generation: 1, phase: "retired" },
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | undefined;
const vmView = (chat = false) =>
  chat ? (
    <ThreadVmControlsProvider environmentId={EnvironmentId.make("mac")} threadId={source.id}>
      <ThreadVmNotice />
      <ThreadVmMenuActions onAction={(action) => action()} />
    </ThreadVmControlsProvider>
  ) : (
    <ThreadVmControls environmentId={EnvironmentId.make("vm")} threadId={source.id} />
  );
const modal = () => renderer!.root.findByType("dialog");
const anyButton = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.props.accessibilityLabel === label)!;
const modalButton = (label: string) =>
  modal()
    .findAllByType("button")
    .find((node) => node.props.accessibilityLabel === label)!;
const modalText = () =>
  modal()
    .findAllByType("span")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join("");
async function mountVm(chat = false) {
  await act(async () => {
    renderer = create(vmView(chat));
  });
}
async function press(label: string, inside = false) {
  await act(async () => {
    (inside ? modalButton(label) : anyButton(label)).props.onPress();
  });
}
const availableBackup = {
  available: true,
  blockedReason: null,
  generation: 2,
  sourceAllocationId: "allocation",
  backupOperationId: "backup-operation",
  capturedAt: "2026-10-22T10:00:00Z",
  nativeCheckpointOperationId: "checkpoint-operation",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  appAtomRegistry.set(dispatchingAtom, null);
  fixture.vmLifecycle.run.mockReset();
  fixture.vmLifecycle.run.mockResolvedValue(true);
  fixture.vmLifecycle.entries = [];
  fixture.vmLifecycle.ready = false;
  fixture.vmLifecycle.busy = false;
  fixture.vmLifecycle.error = "Storage unavailable";
  appAtomRegistry.set(vmViewAtom, initialVmView);
  appAtomRegistry.set(
    environmentThreadShells.threadShellsAtom as Atom.Writable<
      ReadonlyArray<EnvironmentThreadShell>
    >,
    [source],
  );
  fixture.navigation = [{ ...source, environmentId: EnvironmentId.make("vm") }];
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  appAtomRegistry.set(fixture.manager.queuedMessagesByThreadKeyAtom, {});
  vi.unstubAllGlobals();
});

describe("mobile VM recovery", () => {
  it.each(["shared", "unattempted"] as const)(
    "delivers a %s unsent message from a source hidden in navigation and retains its file until accepted",
    async (submissionProtocol) => {
      const config = {
        providers: [],
        environment: {
          capabilities: {
            sharedPromptQueue: true,
            attachmentUploads: true,
            inlineMessageContext: true,
            fileAttachments: { maxUploadBytes: 1000 },
          },
        },
      };
      fixture.configs = new Map([["mac", config]]);
      appAtomRegistry.set(
        serverEnvironment.configValueAtom(EnvironmentId.make("mac")),
        config as unknown as ServerConfig,
      );
      const message: QueuedThreadMessage = {
        environmentId: source.environmentId,
        threadId: source.id,
        messageId: MessageId.make("unsent"),
        commandId: CommandId.make("original-command"),
        text: "Keep this prompt",
        attachments: [
          {
            id: "file",
            type: "file",
            name: "proof.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: "file:///proof.txt",
          },
        ],
        submissionProtocol,
        createdAt: "2026-10-22T10:00:00Z",
      };
      await fixture.manager.enqueue(message);
      const submitted = gate(),
        accepted = gate();
      fixture.send.mockImplementation(async () => {
        submitted.resolve();
        await accepted.promise;
        return AsyncResult.success({});
      });
      fixture.prepare.mockResolvedValue({
        status: "ready",
        attachments: [
          {
            type: "file",
            attachmentId: "uploaded",
            name: "proof.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
      });
      fixture.receipt.mockResolvedValue(AsyncResult.success(null));
      function Drain() {
        useThreadOutboxDrain();
        return null;
      }
      const captured = submissionProtocol === "unattempted" ? gate() : null;
      const unsubscribe = captured
        ? appAtomRegistry.subscribe(dispatchingAtom, (id) => {
            const current = Object.values(
              appAtomRegistry.get(fixture.manager.queuedMessagesByThreadKeyAtom),
            ).flat()[0];
            if (id === null && current?.submissionProtocol === "shared") captured.resolve();
          })
        : () => undefined;
      await act(async () => {
        renderer = create(<Drain />);
      });
      if (captured)
        await act(async () => {
          await captured.promise;
        });
      unsubscribe();
      expect(fixture.send).toHaveBeenCalledTimes(1);
      await submitted.promise;
      expect(fixture.send).toHaveBeenCalledTimes(1);
      expect(fixture.send.mock.calls[0]?.[0].input).toMatchObject({
        commandId: "original-command",
        message: { text: "Keep this prompt", attachments: [{ attachmentId: "uploaded" }] },
      });
      expect(fixture.removeFile).not.toHaveBeenCalled();
      expect(
        Object.values(appAtomRegistry.get(fixture.manager.queuedMessagesByThreadKeyAtom)).flat(),
      ).toHaveLength(1);
      await act(async () => {
        accepted.resolve();
      });
      expect(
        Object.values(appAtomRegistry.get(fixture.manager.queuedMessagesByThreadKeyAtom)).flat(),
      ).toHaveLength(0);
      expect(fixture.removeFile).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer!.update(<Drain />);
      });
      expect(fixture.send).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a ready VM quiet and exposes actions without Manage VM", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    await mountVm(true);
    expect(
      renderer!.root.findAllByProps({ accessibilityLabel: "VM needs attention" }),
    ).toHaveLength(0);
    expect(anyButton("Manage VM")).toBeUndefined();
    expect(anyButton("Open preview…")).toBeDefined();
    expect(anyButton("Permanently delete thread")).toBeUndefined();
  });

  it.each(["success", "failure"])(
    "ignores a late backup %s after closing its focused dialog",
    async (outcome) => {
      fixture.vmLifecycle.ready = true;
      fixture.vmLifecycle.error = null;
      const result = gate();
      fixture.backup.mockImplementation(async () => {
        await result.promise;
        if (outcome === "failure") throw new Error("Stale failure");
        return AsyncResult.success(availableBackup);
      });
      await mountVm();
      await press("Recover from backup…");
      expect(renderer!.root.findAllByType("dialog")).toHaveLength(1);
      await press("Close", true);
      await act(async () => result.resolve());
      expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
      expect(fixture.vmLifecycle.run).not.toHaveBeenCalled();
    },
  );

  it.each(["reset", "delete", "backup"] as const)(
    "keeps failed %s requests visible and retries the same saved operation",
    async (kind) => {
      fixture.vmLifecycle.ready = true;
      fixture.vmLifecycle.error = null;
      fixture.backup.mockResolvedValue(AsyncResult.success(availableBackup));
      if (kind === "reset")
        appAtomRegistry.set(vmViewAtom, {
          ...initialVmView,
          data: {
            ...initialVmView.data,
            status: {
              ...initialVmStatus,
              allocation: null,
              savedDisk: {
                phase: "expired",
                savedAt: "2026-10-20T10:00:00Z",
                expiresAt: "2026-10-21T10:00:00Z",
              },
            },
          },
        });
      await mountVm();
      await press(
        kind === "reset"
          ? "Reset VM…"
          : kind === "delete"
            ? "Permanently delete thread"
            : "Recover from backup…",
      );
      fixture.vmLifecycle.run.mockImplementationOnce(async (input: ThreadVmActionSubmission) => {
        fixture.vmLifecycle.entries = [input];
        fixture.vmLifecycle.error = "Relay admission failed. The request is saved.";
        return false;
      });
      await press(
        kind === "reset"
          ? "Reset VM"
          : kind === "delete"
            ? "Permanently delete thread"
            : "Restore this backup",
        true,
      );
      await act(async () => renderer!.update(vmView()));
      const saved = fixture.vmLifecycle.entries[0]!;
      expect(modalText()).toContain("Relay admission failed. The request is saved.");
      expect(modalButton("Retry saved VM request").props.disabled).toBe(false);
      if (kind === "backup") {
        fixture.vmLifecycle.run.mockResolvedValueOnce(false);
        await press("Cancel saved recovery request", true);
        expect(fixture.vmLifecycle.run).toHaveBeenLastCalledWith({
          environmentId: "vm",
          threadId: "thread",
          action: {
            type: "cancel_backup_recovery",
            payload: "payload" in saved.action ? saved.action.payload : null,
          },
        });
      }
      fixture.vmLifecycle.run.mockResolvedValueOnce(true);
      await press("Retry saved VM request", true);
      expect(fixture.vmLifecycle.run).toHaveBeenLastCalledWith(saved);
      expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
    },
  );

  it.each(["close", "android-back"])(
    "can dismiss a confirmation with %s after storage fails",
    async (dismiss) => {
      fixture.vmLifecycle.ready = true;
      fixture.vmLifecycle.error = null;
      await mountVm();
      await press("Permanently delete thread");
      fixture.vmLifecycle.ready = false;
      fixture.vmLifecycle.error = "Storage unavailable";
      await act(async () => renderer!.update(vmView()));
      expect(modalText()).toContain("Storage unavailable");
      await act(async () => {
        if (dismiss === "close") {
          expect(modalButton("Close").props.disabled).toBe(false);
          modalButton("Close").props.onPress();
        } else modal().props.onRequestClose();
      });
      expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
      expect(fixture.vmLifecycle.run).not.toHaveBeenCalled();
    },
  );

  it("keeps saved recovery controls reachable after VM status disappears", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    fixture.backup.mockResolvedValue(AsyncResult.success(availableBackup));
    await mountVm();
    await press("Recover from backup…");
    fixture.vmLifecycle.run.mockImplementationOnce(async (request: ThreadVmActionSubmission) => {
      fixture.vmLifecycle.entries = [request];
      fixture.vmLifecycle.error = "Relay did not confirm the request";
      return false;
    });
    await press("Restore this backup", true);
    await act(async () => {
      appAtomRegistry.set(vmViewAtom, {
        ...initialVmView,
        data: { ...initialVmView.data, status: { ...initialVmStatus, allocation: null } },
      });
    });
    expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
    expect(anyButton("Retry saved VM request").props.disabled).toBe(false);
    expect(anyButton("Cancel saved recovery request").props.disabled).toBe(false);
    const saved = fixture.vmLifecycle.entries[0]!;
    await press("Retry saved VM request");
    expect(fixture.vmLifecycle.run).toHaveBeenLastCalledWith(saved);
  });

  it("does not reopen a dismissed confirmation when VM status returns", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    fixture.backup.mockResolvedValue(AsyncResult.success(availableBackup));
    await mountVm();
    await press("Recover from backup…");
    await act(async () => {
      appAtomRegistry.set(vmViewAtom, {
        ...initialVmView,
        data: { ...initialVmView.data, status: { ...initialVmStatus, allocation: null } },
      });
    });
    expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
    await act(async () => appAtomRegistry.set(vmViewAtom, initialVmView));
    expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
    expect(fixture.vmLifecycle.run).not.toHaveBeenCalled();
  });

  it("lets the user edit the preview port and shows preview failures in that dialog", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    fixture.preview.mockRejectedValueOnce(new Error("Preview unavailable"));
    await mountVm();
    await press("Open preview…");
    await act(async () => renderer!.root.findByType("input").props.onChangeText("5173"));
    await press("Open private preview", true);
    expect(fixture.preview).toHaveBeenCalledWith({
      environmentId: "vm",
      threadId: "thread",
      port: 5173,
    });
    expect(modalText()).toContain("The VM preview could not be opened.");
    expect(modalButton("Open private preview").props.disabled).toBe(false);
  });

  it("keeps destination Codex sign-in available while the thread is on the Mac", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    fixture.auth.mockResolvedValue(AsyncResult.success({}));
    const binding = {
      operationId: "move",
      allocationId: "destination-vm",
      environmentId: EnvironmentId.make("new-vm"),
      generation: 3,
      instanceId: "codex" as const,
    };
    appAtomRegistry.set(vmViewAtom, {
      ...initialVmView,
      providerAuth: {
        ...binding,
        requirement: "sign_in_required",
        auth: {
          instanceId: ProviderInstanceId.make("codex"),
          phase: "idle",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
          interaction: null,
        },
      },
      data: { ...initialVmView.data, status: { ...initialVmStatus, pendingProviderAuth: binding } },
    });
    await mountVm(true);
    await press("Sign in to Codex");
    await press("Sign in to Codex", true);
    expect(fixture.auth).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "mac", binding, action: { type: "start" } }),
    );
  });
  it("exposes replacement and cancellation while the source thread is still on the Mac", async () => {
    fixture.vmLifecycle.ready = true;
    fixture.vmLifecycle.error = null;
    appAtomRegistry.set(vmViewAtom, {
      ...initialVmView,
      data: {
        ...initialVmView.data,
        status: {
          ...initialVmStatus,
          replacement: {
            phase: "awaiting_choice",
            requestId: "request",
            threadId: source.id,
            victimAllocationId: null,
            errorCode: null,
          },
        },
      },
    });
    await mountVm(true);
    await press("Choose a VM to replace");
    expect(modalText()).toContain("All VMs are busy");
    await press("Cancel VM request", true);
    expect(fixture.vmLifecycle.run).toHaveBeenCalledWith({
      environmentId: "mac",
      threadId: "thread",
      action: { type: "cancel_replacement", requestId: "request" },
    });
  });
});
