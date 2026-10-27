import {
  act,
  cloneElement,
  type ComponentProps,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import type { RelayPortableThreadSummary } from "@t3tools/contracts/relay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fixture = vi.hoisted(() => ({
  session: { accountId: "owner" },
  relayUrl: "https://relay.example.test",
  index: { entries: [] as RelayPortableThreadSummary[], next: null },
  detail: {
    history: { thread: { messages: [] }, deleted: false },
    hasMore: false,
  },
  capabilities: { data: { configured: true, restore: true }, isPending: false, error: null },
  commands: {
    loadIndex: vi.fn(),
    loadHistory: vi.fn(),
    refreshPlacement: vi.fn(),
    refreshStatus: vi.fn(),
    loadQueue: vi.fn(),
    queueReceipt: vi.fn(),
    queueControl: vi.fn(),
    downloadAttachment: vi.fn(),
    openChat: vi.fn(),
    action: vi.fn(),
  },
  run: vi.fn(),
  readJournal: vi.fn(),
  navigate: vi.fn(),
  refreshCancellations: vi.fn(),
  observeCancellations: vi.fn(),
}));
function readAtom(atom: unknown) {
  switch (atom) {
    case "session":
      return fixture.session;
    case "index":
      return fixture.index;
    case "detail":
      return fixture.detail;
    case "capabilities":
      return fixture.capabilities;
    default:
      return null;
  }
}
function command(name: unknown) {
  if (typeof name !== "string" || !(name in fixture.commands))
    throw new Error(`Unexpected command: ${String(name)}`);
  return fixture.commands[name as keyof typeof fixture.commands];
}
function threads() {
  return {
    portableThreadLibrary: {
      indexAtom: "index",
      detailAtom: () => "detail",
      queueAtom: () => "queue",
      loadIndex: "loadIndex",
      loadHistory: "loadHistory",
      refreshPlacement: "refreshPlacement",
      loadQueue: "loadQueue",
      queueReceipt: "queueReceipt",
      queueControl: "queueControl",
      downloadAttachment: "downloadAttachment",
    },
    openPortableThreadChat: "openChat",
    threadVmControls: {
      action: "action",
      capabilitiesAtom: "capabilities",
      refreshStatus: "refreshStatus",
    },
    threadVmActionJournal: {},
    threadQueueControlJournal: {
      read: fixture.readJournal,
      refresh: async (_scope: unknown, read: () => Promise<unknown>) => {
        await read();
        return null;
      },
    },
  };
}
function useJournal() {
  return { entries: [], error: null, ready: true, busy: false, run: fixture.run };
}
vi.mock("@effect/atom-react", () => ({ useAtomValue: readAtom }));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: "session" }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("../../state/threads", threads);
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: command }));
vi.mock("../../state/use-thread-vm-actions", () => ({ useThreadVmActionJournal: useJournal }));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => fixture.relayUrl,
}));
vi.mock("./ThreadVmControls", () => ({
  ThreadVmControlsProvider: ({ children }: PropsWithChildren) => children,
  ThreadVmRecoveryControls: () => <div>VM controls</div>,
}));
vi.mock("./ThreadMoveQueueItem", () => ({
  useThreadMovePlacement: (_environmentId: string, threadId: string) =>
    fixture.index.entries.find((row) => row.placement.threadId === threadId)?.placement,
  useSavedThreadMoveCancellation: () => ({
    refresh: fixture.refreshCancellations,
    observe: fixture.observeCancellations,
  }),
  SavedThreadQueue: () => <div>Move queue</div>,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/collapsible", async () => {
  const { createContext, use, useMemo } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Collapsible: ({
      children,
      open,
      onOpenChange,
    }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => {
      const value = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
      return <Context value={value}>{children}</Context>;
    },
    CollapsibleTrigger: (props: ComponentProps<"button">) => {
      const { open, onOpenChange } = use(Context);
      return <button {...props} aria-expanded={open} onClick={() => onOpenChange(!open)} />;
    },
    CollapsiblePanel: ({ children }: PropsWithChildren) =>
      use(Context).open ? <section>{children}</section> : null,
  };
});

// Native behavior runs with the renderer's React; no simulator or live app state is needed.
vi.mock("../../../../mobile/node_modules/react/index.js", async () => import("react"));
vi.mock("../../../../mobile/node_modules/@effect/atom-react", () => ({ useAtomValue: readAtom }));
vi.mock("../../../../mobile/node_modules/react-native", () => ({
  View: "div",
  Pressable: "button",
  ScrollView: "section",
  FlatList: ({
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    ListHeaderComponent: ReactElement;
    ListFooterComponent: ReactElement;
  }) => (
    <section>
      {ListHeaderComponent}
      {ListFooterComponent}
    </section>
  ),
}));
vi.mock("../../../../mobile/node_modules/@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: fixture.navigate }),
}));
vi.mock("../../../../mobile/node_modules/expo-crypto", () => ({ randomUUID: () => "operation" }));
vi.mock("../../../../mobile/src/components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../../mobile/src/components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../../mobile/src/components/StatusPill", () => ({
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../../../mobile/src/lib/attachmentDownload", () => ({ shareAttachmentBytes: vi.fn() }));
vi.mock("../../../../mobile/src/state/threads", threads);
vi.mock("../../../../mobile/src/state/use-atom-command", () => ({ useAtomCommand: command }));
vi.mock("../../../../mobile/src/state/use-thread-vm-actions", () => ({
  useThreadVmActionJournal: useJournal,
}));
vi.mock("../../../../mobile/src/state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => fixture.relayUrl,
}));
vi.mock("../../../../mobile/src/features/threads/ThreadVmControls", () => ({
  ThreadVmControlsProvider: ({ children }: PropsWithChildren) => children,
  ThreadVmRecoveryControls: () => <div>VM controls</div>,
}));
vi.mock("../../../../mobile/src/features/threads/ThreadMoveQueueItem", () => ({
  useThreadMovePlacement: (_environmentId: string, threadId: string) =>
    fixture.index.entries.find((row) => row.placement.threadId === threadId)?.placement,
  useSavedThreadMoveCancellation: () => ({
    refresh: fixture.refreshCancellations,
    observe: fixture.observeCancellations,
  }),
  SavedThreadQueue: () => <div>Move queue</div>,
}));
vi.mock("../../../../mobile/src/features/threads/SavedConversationMessage", () => ({
  SavedConversationMessage: ({ message }: { message: { text: string } }) => (
    <div>{message.text}</div>
  ),
}));

import { PortableThreadLibrary } from "./PortableThreadLibrary";
const { PortableThreadLibrary: MobilePortableThreadLibrary } = await vi.importActual<{
  PortableThreadLibrary: typeof PortableThreadLibrary;
}>("../../../../mobile/src/features/threads/PortableThreadLibrary");

const at = "2026-10-23T09:00:00.000Z";
function entry(
  threadId: string,
  state: NonNullable<RelayPortableThreadSummary["vm"]>["state"] = "running",
): RelayPortableThreadSummary {
  return {
    title: threadId,
    modelSelection: null,
    createdAt: at,
    updatedAt: at,
    placement: {
      threadId,
      organizationId: "org",
      repositoryId: "repo",
      ownerUserId: "owner",
      environmentId: "vm",
      projectId: "project",
      generation: 2,
      operationId: null,
    },
    vm: {
      state,
      projectName: "launchpad",
      activity: "idle",
      observedAt: at,
      lastWorkAt: at,
      lastVerifiedBackupAt: null,
      savedDiskExpiresAt: null,
      savedDiskOperationId: "saved-disk",
    },
  };
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "children" in node) return text(node.children);
  if (node && typeof node === "object" && "props" in node) {
    return text((node.props as { children?: unknown }).children);
  }
  return "";
}

for (const [surface, Component] of [
  ["web", PortableThreadLibrary],
  ["mobile", MobilePortableThreadLibrary],
] as const) {
  describe(`${surface} VM conversation list`, () => {
    let renderer: ReactTestRenderer | undefined;
    const render = async () => {
      await act(async () => {
        if (renderer) renderer.update(<Component />);
        else renderer = create(<Component />);
      });
    };
    const click = async (label: string) => {
      const button = renderer!.root
        .findAllByType("button")
        .find(
          (node) =>
            (node.props["aria-label"] ??
              node.props.accessibilityLabel ??
              text(node.props.children)) === label,
        );
      if (!button) throw new Error(`Missing button ${label}`);
      expect(button.props.disabled).not.toBe(true);
      await act(async () => {
        await (button.props.onClick ?? button.props.onPress)();
      });
    };
    const content = () => text(renderer!.toJSON());

    beforeEach(() => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.clearAllMocks();
      fixture.session = { accountId: "owner" };
      fixture.relayUrl = "https://relay.example.test";
      fixture.index = { entries: [entry("First"), entry("Second")], next: null };
      for (const fn of Object.values(fixture.commands))
        fn.mockResolvedValue({ _tag: "Success", value: null });
      fixture.commands.loadQueue.mockImplementation(async ({ threadId }) => ({
        _tag: "Success",
        value: { threadId, generation: 2, queue: emptyThreadPromptQueue() },
      }));
      fixture.refreshCancellations.mockResolvedValue(undefined);
      fixture.commands.refreshPlacement.mockResolvedValue({
        _tag: "Success",
        value: entry("First").placement,
      });
      fixture.commands.openChat.mockResolvedValue({
        _tag: "Success",
        value: { environmentId: "vm", threadId: "First" },
      });
      fixture.run.mockResolvedValue(true);
      fixture.readJournal.mockResolvedValue(null);
    });
    afterEach(async () => {
      if (renderer) await act(async () => renderer!.unmount());
      renderer = undefined;
      vi.unstubAllGlobals();
    });

    it("expands one row at a time without fetching history or starting a VM", async () => {
      await render();
      expect(content()).not.toContain("Workspace backup");
      await click("Details for First");
      expect(content()).toContain("Workspace backup");
      expect(content()).toContain("No verified backup");
      await click("Details for Second");
      const expanded = renderer!.root
        .findAllByType("button")
        .filter((node) => node.props["aria-expanded"] ?? node.props.accessibilityState?.expanded);
      expect(expanded).toHaveLength(1);
      expect(expanded[0]!.props["aria-label"] ?? expanded[0]!.props.accessibilityLabel).toBe(
        "Details for Second",
      );
      await click("Details for Second");
      expect(content()).not.toContain("Workspace backup");
      expect(fixture.commands.loadIndex).toHaveBeenCalledTimes(1);
      expect(fixture.commands.loadHistory).not.toHaveBeenCalled();
      expect(fixture.commands.openChat).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    });

    it("retains expansion on refresh and clears it when the entry is removed", async () => {
      await render();
      await click("Details for First");
      fixture.index = { ...fixture.index, entries: [entry("First"), entry("Second")] };
      await render();
      expect(content()).toContain("Workspace backup");
      fixture.index = { ...fixture.index, entries: [entry("Second")] };
      await render();
      fixture.index = { ...fixture.index, entries: [entry("First"), entry("Second")] };
      await render();
      expect(content()).not.toContain("Workspace backup");
    });

    it("clears expanded details when the account or relay changes", async () => {
      await render();
      await click("Details for First");
      fixture.session = { accountId: "other-owner" };
      await render();
      expect(content()).not.toContain("Workspace backup");
      await click("Details for First");
      fixture.relayUrl = "https://other-relay.example.test";
      await render();
      expect(content()).not.toContain("Workspace backup");
    });

    it("reads saved history without opening chat and returns to the expanded row", async () => {
      await render();
      await click("Details for First");
      await click("Read conversation");
      expect(fixture.commands.loadHistory).toHaveBeenCalledWith({ threadId: "First" });
      expect(content()).toContain("VM controls");
      expect(fixture.commands.openChat).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
      await click("All threads");
      expect(content()).toContain("Workspace backup");
      expect(fixture.commands.loadHistory).toHaveBeenCalledTimes(1);
    });

    it("offers one refresh in the saved view and waits for the current VM read", async () => {
      await render();
      await click("Details for First");
      await click("Read conversation");
      expect(
        renderer!.root
          .findAllByType("button")
          .filter(
            (node) =>
              (node.props["aria-label"] ?? node.props.accessibilityLabel) === "Refresh thread",
          ),
      ).toHaveLength(1);
      expect(content()).not.toContain("Refresh conversation");
      expect(renderer!.root.findAllByProps({ "aria-label": "Refresh VM threads" })).toHaveLength(0);
      const next = deferred<{ _tag: "Success"; value: null }>();
      fixture.commands.refreshStatus.mockImplementation(() => next.promise);
      await click("Refresh thread");
      const refresh = renderer!.root
        .findAllByType("button")
        .find(
          (node) =>
            (node.props["aria-label"] ?? node.props.accessibilityLabel) === "Refresh thread",
        )!;
      expect(refresh.props.disabled).toBe(true);
      await act(async () => {
        (refresh.props.onClick ?? refresh.props.onPress)();
      });
      expect(fixture.commands.refreshPlacement).toHaveBeenCalledTimes(1);
      expect(fixture.commands.refreshStatus).toHaveBeenCalledWith({
        environmentId: "vm",
        threadId: "First",
      });
      expect(fixture.commands.loadHistory).toHaveBeenCalledWith({
        threadId: "First",
        refresh: true,
      });
      await act(async () => next.resolve({ _tag: "Success", value: null }));
      expect(refresh.props.disabled).toBe(false);
      expect(fixture.commands.openChat).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    });

    it("keeps the header busy until pending cancellation receipts have been reconciled", async () => {
      await render();
      await click("Details for First");
      await click("Read conversation");
      const next = deferred<void>();
      const previousReads = fixture.commands.loadQueue.mock.calls.length;
      fixture.refreshCancellations.mockImplementation(() => next.promise);
      await click("Refresh thread");
      const refresh = renderer!.root
        .findAllByType("button")
        .find(
          (node) =>
            (node.props["aria-label"] ?? node.props.accessibilityLabel) === "Refresh thread",
        )!;
      expect(refresh.props.disabled).toBe(true);
      expect(fixture.commands.loadQueue).toHaveBeenCalledTimes(previousReads);
      await act(async () => next.resolve(undefined));
      expect(fixture.commands.loadQueue).toHaveBeenCalledTimes(previousReads + 1);
      expect(refresh.props.disabled).toBe(false);
    });
    it("refreshes retained history even when the queue read fails", async () => {
      await render();
      await click("Details for First");
      await click("Read conversation");
      fixture.commands.loadQueue.mockRejectedValue(new Error("Queue offline"));
      await click("Refresh thread");
      expect(fixture.commands.loadHistory).toHaveBeenCalledWith({
        threadId: "First",
        refresh: true,
      });
      expect(content()).toContain("Queue: Queue offline");
      expect(fixture.commands.refreshStatus).toHaveBeenCalledTimes(1);
      expect(fixture.commands.openChat).not.toHaveBeenCalled();
    });

    it("opens the current placement without dispatching a VM action", async () => {
      fixture.index.entries = [entry("First")];
      await render();
      await click("Open chat");
      expect(fixture.commands.openChat).toHaveBeenCalledWith({
        threadId: "First",
        title: "First",
        expectedPlacement: { environmentId: "vm", generation: 2 },
      });
      expect(fixture.navigate).toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    });

    it.each([
      ["paused", "Resume VM", "resume"],
      ["saved", "Restore VM", "restore"],
    ] as const)(
      "preserves the %s recovery action and opens the saved view afterward",
      async (state, label, action) => {
        fixture.index.entries = [entry("First", state)];
        await render();
        await click(label);
        expect(fixture.run).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "First",
            environmentId: "vm",
            action: expect.objectContaining({ type: action }),
          }),
        );
        if (action === "restore")
          expect(fixture.run).toHaveBeenCalledWith(
            expect.objectContaining({
              action: expect.objectContaining({
                payload: expect.objectContaining({
                  savedDiskOperationId: "saved-disk",
                  expectedGeneration: 2,
                }),
              }),
            }),
          );
        expect(fixture.commands.loadIndex).toHaveBeenCalledTimes(2);
        expect(fixture.commands.loadHistory).toHaveBeenCalledWith({ threadId: "First" });
        expect(fixture.commands.openChat).not.toHaveBeenCalled();
      },
    );

    it("keeps pending operations in management rather than showing Ready", async () => {
      const first = entry("First");
      fixture.index.entries = [
        { ...first, placement: { ...first.placement, operationId: "moving" } },
      ];
      await render();
      expect(content()).toContain("Updating");
      expect(content()).not.toContain("Ready");
      await click("Manage VM");
      expect(content()).not.toContain("Move queue");
      expect(content()).toContain("VM controls");
      expect(fixture.commands.openChat).not.toHaveBeenCalled();
      expect(fixture.run).not.toHaveBeenCalled();
    });
  });
}
