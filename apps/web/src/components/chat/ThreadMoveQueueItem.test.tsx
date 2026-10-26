import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ThreadMoveQueueEntry,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement, RelayThreadVmStatus } from "@t3tools/contracts/relay";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";

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
  actionDisabled: false,
  sourceIsVm: false,
  status: null as RelayThreadVmStatus | null,
  dispatch: vi.fn(),
  receipt: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
  uuid: vi.fn(),
}));
function read(atom: unknown) {
  if (atom === "session") return fixture.session;
  if (atom === "view") return { data: { status: fixture.status }, providerAuth: null };
  return null;
}
function commands(atom: unknown) {
  return atom === "cancel" ? fixture.dispatch : fixture.receipt;
}
function threads() {
  return {
    threadVmControls: { viewAtom: () => "view", locationViewAtom: () => "location" },
    portableThreadLibrary: { queueControl: "cancel", queueReceipt: "receipt" },
  };
}
function vmUi() {
  return {
    moveAction: {
      label: "Sign in to Codex",
      disabled: fixture.actionDisabled,
      onPress: fixture.signIn,
    },
  };
}
function environments() {
  return {
    environments: [
      {
        environmentId: "mac",
        label: "Akina",
        serverConfig: {
          environment: { threadVm: fixture.sourceIsVm ? { threadId: "thread" } : undefined },
        },
      },
      { environmentId: "other", label: "Other machine" },
    ],
  };
}
vi.mock("@effect/atom-react", () => ({ useAtomValue: read }));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: "session" }));
vi.mock("@t3tools/client-runtime/relay/portableThreadPresentation", () => ({
  portableThreadPlacementsAtom: "proofs",
}));
vi.mock("../../state/threads", threads);
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: commands }));
vi.mock("../../state/environments", () => ({ useEnvironments: environments }));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => fixture.relayUrl,
}));
vi.mock("../../lib/utils", () => ({ randomUUID: fixture.uuid }));
vi.mock("./ThreadVmControls", () => ({ useThreadVmUi: vmUi, useThreadMovePlacement: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../../../../mobile/node_modules/react/index.js", async () => import("react"));
vi.mock("../../../../mobile/node_modules/@effect/atom-react", () => ({ useAtomValue: read }));
vi.mock("../../../../mobile/node_modules/react-native", () => ({
  View: "div",
  Pressable: "button",
}));
vi.mock("../../../../mobile/node_modules/expo-crypto", () => ({ randomUUID: fixture.uuid }));
vi.mock("../../../../mobile/src/state/threads", threads);
vi.mock("../../../../mobile/src/state/use-atom-command", () => ({ useAtomCommand: commands }));
vi.mock("../../../../mobile/src/state/environments", () => ({ useEnvironments: environments }));
vi.mock("../../../../mobile/src/state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => fixture.relayUrl,
}));
vi.mock("../../../../mobile/src/components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../../mobile/src/components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../../mobile/src/features/threads/ThreadVmControls", () => ({
  useThreadVmUi: vmUi,
  useThreadMovePlacement: () => null,
}));

import {
  SavedThreadQueue,
  useSavedThreadMoveCancellation,
  ThreadMoveQueueItem,
} from "./ThreadMoveQueueItem";
const {
  SavedThreadQueue: NativeSavedThreadQueue,
  useSavedThreadMoveCancellation: useNativeCancellation,
  ThreadMoveQueueItem: NativeThreadMoveQueueItem,
} = await vi.importActual<{
  SavedThreadQueue: typeof SavedThreadQueue;
  useSavedThreadMoveCancellation: typeof useSavedThreadMoveCancellation;
  ThreadMoveQueueItem: typeof ThreadMoveQueueItem;
}>("../../../../mobile/src/features/threads/ThreadMoveQueueItem");
const environmentId = EnvironmentId.make("mac"),
  threadId = ThreadId.make("thread");
const placement: RelayPortableThreadPlacement = {
  threadId,
  environmentId,
  projectId: "project",
  ownerUserId: "owner",
  organizationId: "org",
  repositoryId: "repo",
  generation: 2,
  operationId: "move",
};
const initialMove = {
  kind: "move",
  messageId: MessageId.make("message"),
  revision: 1,
  operationId: CommandId.make("move"),
  destination: { kind: "vm" },
  state: "moving",
  acceptedSequence: 1,
  createdAt: "2026-10-26T09:00:00Z",
} satisfies ThreadMoveQueueEntry;
const initialQueue: ThreadPromptQueue = {
  ...emptyThreadPromptQueue(),
  entries: [initialMove],
};

for (const [surface, Component, useCancellation, MoveItem] of [
  ["web", SavedThreadQueue, useSavedThreadMoveCancellation, ThreadMoveQueueItem],
  ["native", NativeSavedThreadQueue, useNativeCancellation, NativeThreadMoveQueueItem],
] as const) {
  describe(`${surface} move queue interactions`, () => {
    let renderer: ReactTestRenderer | undefined;
    function Harness({
      queue,
      environment = environmentId,
      logicalThread = threadId,
    }: {
      queue: ThreadPromptQueue;
      environment?: EnvironmentId;
      logicalThread?: ThreadId;
    }) {
      const cancellation = useCancellation(logicalThread);
      const refresh = async () => {
        await cancellation.refresh(new AbortController().signal);
        await fixture.refresh();
        cancellation.observe(queue);
      };
      return (
        <>
          <button onClick={() => refresh().catch(() => undefined)}>Refresh thread</button>
          <Component
            environmentId={environment}
            threadId={logicalThread}
            queue={queue}
            placement={placement}
            cancellation={cancellation}
            onChange={refresh}
          />
        </>
      );
    }
    const render = async (
      queue: ThreadPromptQueue | undefined = initialQueue,
      environment = environmentId,
      logicalThread = threadId,
    ) => {
      await act(async () => {
        const view = (
          <Harness
            queue={queue ?? initialQueue}
            environment={environment}
            logicalThread={logicalThread}
          />
        );
        if (renderer) renderer.update(view);
        else renderer = create(view);
      });
    };
    const button = (label: string) =>
      renderer!.root
        .findAllByType("button")
        .find((node) => (node.props.accessibilityLabel ?? node.children.join("")) === label);
    const click = async (label: string) => {
      const node = button(label)!;
      expect(node.props.disabled).not.toBe(true);
      await act(async () => {
        await (node.props.onClick ?? node.props.onPress)();
      });
    };
    beforeEach(() => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.clearAllMocks();
      fixture.session = { accountId: "owner" };
      fixture.relayUrl = "https://relay.example.test";
      fixture.actionDisabled = false;
      fixture.sourceIsVm = false;
      fixture.status = null;
      let id = 0;
      fixture.uuid.mockImplementation(() => `cancel-${++id}`);
      fixture.dispatch.mockImplementation(async ({ command }) => ({
        _tag: "Success",
        value: { commandId: command.commandId, position: 1, receipt: null },
      }));
      fixture.receipt.mockResolvedValue({ _tag: "Success", value: null });
      fixture.refresh.mockResolvedValue(undefined);
    });
    afterEach(async () => {
      if (renderer) await act(async () => renderer!.unmount());
      renderer = undefined;
      vi.unstubAllGlobals();
    });
    it("keeps prompts before and after a move in execution order", async () => {
      const prompt = (id: string) => ({
        kind: "prompt" as const,
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        revision: 1,
        acceptedSequence: 1,
        createdAt: "2026-10-26T09:00:00Z",
        state: "pending" as const,
      });
      await render({
        ...initialQueue,
        entries: [
          prompt("Before move"),
          { ...initialMove, state: "pending" },
          prompt("After move"),
        ],
      });
      const content = JSON.stringify(renderer!.toJSON());
      expect(content).toContain("Before move");
      expect(content).toContain("Waiting in queue");
      expect(content).toContain("After move");
      expect(content.indexOf("Before move")).toBeLessThan(content.indexOf("Waiting in queue"));
      expect(content.indexOf("Waiting in queue")).toBeLessThan(content.indexOf("After move"));
    });
    it.each([false, true])(
      "labels a move to a machine using source VM metadata (%s)",
      async (isVm) => {
        fixture.sourceIsVm = isVm;
        await render({
          ...initialQueue,
          entries: [
            {
              ...initialMove,
              destination: {
                kind: "environment" as const,
                environmentId: EnvironmentId.make("other"),
                projectId: ProjectId.make("other-project"),
              },
            },
          ],
        });
        const content = JSON.stringify(renderer!.toJSON());
        expect(content).toContain("Other machine");
        expect(content).toContain(isVm ? "Private VM" : "Akina");
        if (!isVm) expect(content).not.toContain("Private VM");
      },
    );
    it("shows cancellation while a paused move is still pending", async () => {
      const reply = deferred<unknown>();
      fixture.dispatch.mockImplementation(() => reply.promise);
      await render({
        ...initialQueue,
        enabled: false,
        entries: [{ ...initialMove, state: "pending" }],
      });
      await click("Cancel move");
      expect(JSON.stringify(renderer!.toJSON())).toContain("Requesting cancellation…");
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Waiting for the queue to resume");
      await act(async () => {
        reply.resolve({
          _tag: "Success",
          value: {
            commandId: "cancel-1",
            position: 1,
            receipt: { status: "accepted", sequence: 3 },
          },
        });
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("Cancelling move…");
      expect(button("Cancelling…")?.props.disabled).toBe(true);
    });
    it("retries an uncertain cancellation with the exact command, without enqueuing another move", async () => {
      await render();
      await click("Cancel move");
      await click("Retry cancellation");
      const first = fixture.dispatch.mock.calls[0]![0],
        second = fixture.dispatch.mock.calls[1]![0];
      expect(second).toEqual(first);
      expect(first.command).toMatchObject({
        type: "thread.move.cancel",
        messageId: "message",
        expectedRevision: 1,
      });
      expect(fixture.uuid).toHaveBeenCalledTimes(1);
    });
    it("keeps confirmed cancellation while queue refresh is offline", async () => {
      fixture.dispatch.mockImplementation(async ({ command }) => ({
        _tag: "Success",
        value: {
          commandId: command.commandId,
          position: 1,
          receipt: { status: "accepted", sequence: 3 },
        },
      }));
      fixture.refresh.mockRejectedValue(new Error("offline"));
      await render();
      await click("Cancel move");
      expect(button("Cancelling…")?.props.disabled).toBe(true);
      expect(button("Retry cancellation")).toBeUndefined();
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    });
    it("keeps a missing queue projection display-only", async () => {
      await render({ ...initialQueue, entries: [] });
      expect(button("Cancel move")).toBeUndefined();
      expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it("keeps relay sign-in usable when the source queue is unavailable", async () => {
      fixture.status = {
        threadId,
        generation: 2,
        allocation: null,
        setupPhase: "pending",
        capacityState: "started",
        activity: "unknown",
        pausePhase: null,
        resumePhase: null,
        backupPhase: null,
        lastVerifiedBackupAt: null,
        pendingProviderAuth: {
          operationId: "move",
          allocationId: "vm",
          environmentId: EnvironmentId.make("vm"),
          generation: 3,
          instanceId: "codex",
        },
      };
      await act(async () => {
        renderer = create(
          <MoveItem
            environmentId={environmentId}
            threadId={threadId}
            entry={initialMove}
            placement={placement}
            disabled
            onCancel={() => {}}
          />,
        );
      });
      expect(button("Cancel move")?.props.disabled).toBe(true);
      await click("Sign in to Codex");
      expect(fixture.signIn).toHaveBeenCalledTimes(1);
    });
    it("reads delayed cancellation acceptance during refresh without declaring completion", async () => {
      await render();
      await click("Cancel move");
      fixture.receipt.mockResolvedValue({
        _tag: "Success",
        value: { commandId: "cancel-1", position: 1, receipt: { status: "accepted", sequence: 3 } },
      });
      await click("Refresh thread");
      expect(fixture.receipt).toHaveBeenCalledWith({ threadId, commandId: "cancel-1" });
      expect(button("Cancelling…")?.props.disabled).toBe(true);
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    });
    it("surfaces a delayed rejection and releases only that cancellation for a new attempt", async () => {
      await render();
      await click("Cancel move");
      fixture.receipt.mockResolvedValue({
        _tag: "Success",
        value: {
          commandId: "cancel-1",
          position: 1,
          receipt: { status: "rejected", detail: "Move revision changed" },
        },
      });
      await click("Refresh thread");
      expect(JSON.stringify(renderer!.toJSON())).toContain("Move revision changed");
      expect(button("Cancel move")?.props.disabled).not.toBe(true);
      fixture.receipt.mockResolvedValue({ _tag: "Success", value: null });
      await click("Cancel move");
      expect(fixture.dispatch.mock.calls[1]![0].command.commandId).toBe("cancel-2");
    });
    it("retains accepted receipt state when the subsequent queue read fails", async () => {
      await render();
      await click("Cancel move");
      fixture.receipt.mockResolvedValue({
        _tag: "Success",
        value: { commandId: "cancel-1", position: 1, receipt: { status: "accepted", sequence: 3 } },
      });
      fixture.refresh.mockRejectedValue(new Error("Queue offline"));
      await click("Refresh thread");
      expect(button("Cancelling…")?.props.disabled).toBe(true);
      expect(button("Retry cancellation")).toBeUndefined();
    });
    it("keeps the original command across a generation/location change and failed receipt read", async () => {
      await render();
      await click("Cancel move");
      fixture.receipt.mockRejectedValue(new Error("Receipt offline"));
      const nextQueue = {
        ...initialQueue,
        entries: initialQueue.entries.map((entry) => ({ ...entry, revision: 8 })),
      };
      await render(nextQueue, EnvironmentId.make("new-location"));
      await click("Refresh thread");
      await click("Retry cancellation");
      expect(fixture.dispatch.mock.calls[1]![0]).toEqual(fixture.dispatch.mock.calls[0]![0]);
      expect(fixture.uuid).toHaveBeenCalledTimes(1);
    });
    it("rejects receipts for a different command without releasing the pending cancellation", async () => {
      await render();
      await click("Cancel move");
      fixture.receipt.mockResolvedValue({
        _tag: "Success",
        value: {
          commandId: "different",
          position: 1,
          receipt: { status: "rejected", detail: "Unrelated" },
        },
      });
      await click("Refresh thread");
      expect(button("Retry cancellation")).toBeDefined();
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Unrelated");
    });
    it("uses the existing Codex sign-in action within the move item", async () => {
      fixture.status = {
        threadId,
        generation: 2,
        allocation: null,
        setupPhase: "pending",
        capacityState: "started",
        activity: "unknown",
        pausePhase: null,
        resumePhase: null,
        backupPhase: null,
        lastVerifiedBackupAt: null,
        pendingProviderAuth: {
          operationId: "move",
          allocationId: "vm",
          environmentId: EnvironmentId.make("vm"),
          generation: 3,
          instanceId: "codex",
        },
      };
      await render();
      await click("Sign in to Codex");
      expect(fixture.signIn).toHaveBeenCalledTimes(1);
      expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it.each(["account", "relay", "thread"] as const)(
      "ignores a late cancellation response after the %s changes",
      async (change) => {
        const reply = deferred<unknown>();
        fixture.dispatch.mockImplementation(() => reply.promise);
        await render();
        let pending: Promise<void>;
        await act(async () => {
          const node = button("Cancel move")!;
          pending = (node.props.onClick ?? node.props.onPress)();
        });
        if (change === "account") fixture.session = { accountId: "other" };
        else if (change === "relay") fixture.relayUrl = "https://other-relay.example.test";
        await render(
          initialQueue,
          environmentId,
          change === "thread" ? ThreadId.make("other-thread") : threadId,
        );
        await act(async () => {
          reply.resolve({
            _tag: "Success",
            value: { commandId: "cancel-1", receipt: { status: "accepted", sequence: 3 } },
          });
          await pending!;
        });
        expect(fixture.refresh).not.toHaveBeenCalled();
        expect(button("Cancel move")?.props.disabled).not.toBe(true);
      },
    );
  });
}
