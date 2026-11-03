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
import type {
  RelayPortableThreadPlacement,
  RelayThreadVmStatus,
  ThreadMoveWaitingForAuth,
} from "@t3tools/contracts/relay";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import * as Cause from "effect/Cause";

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
  providerAuthError: null as string | null,
  dispatch: vi.fn(),
  receipt: vi.fn(),
  cancelActive: vi.fn(),
  retryActive: vi.fn(),
  checkActive: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
  uuid: vi.fn(),
}));
function read(atom: unknown) {
  if (atom === "session") return fixture.session;
  if (atom === "view")
    return {
      data: { status: fixture.status },
      providerAuth: null,
      providerAuthError: fixture.providerAuthError,
    };
  return null;
}
function commands(atom: unknown) {
  if (atom === "cancel") return fixture.dispatch;
  if (atom === "cancel-active") return fixture.cancelActive;
  if (atom === "retry-active") return fixture.retryActive;
  if (atom === "check-active") return fixture.checkActive;
  return fixture.receipt;
}
function threads() {
  return {
    threadVmControls: { viewAtom: () => "view", locationViewAtom: () => "location" },
    portableThreadLibrary: {
      queueControl: "cancel",
      queueReceipt: "receipt",
      cancelActiveMove: "cancel-active",
      retryActiveMove: "retry-active",
      checkMoveCancellation: "check-active",
    },
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
const activeReturnMove = {
  operationId: "return",
  sourceEnvironmentId: "vm",
  sourceGeneration: 3,
  sourceKind: "vm",
  destinationEnvironmentId: "mac",
  destinationProjectId: "project",
  destinationKind: "environment",
  phase: "preparing",
  cancellationMode: "direct",
} satisfies NonNullable<RelayPortableThreadPlacement["activeMove"]>;
const activeReturnPlacement: RelayPortableThreadPlacement = {
  ...placement,
  environmentId: "vm",
  generation: 3,
  operationId: "return",
  activeMove: activeReturnMove,
  moveFailureDetail: "Could not save the current history.",
};
function withWorkerAuth(waitingForAuth: ThreadMoveWaitingForAuth): RelayPortableThreadPlacement {
  fixture.status = {
    threadId,
    generation: 2,
    allocation: null,
    setupPhase: "pending",
    capacityState: "started",
    activity: "unknown",
    sourceActivationPending: false,
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
  return {
    ...placement,
    moveProgress: [
      {
        threadId,
        operationId: "move",
        environmentId: "vm",
        generation: 3,
        participant: "destination",
        attempt: 2,
        revision: 1,
        stage: "downloading",
        completedBytes: 0,
        totalBytes: null,
        completedArtifacts: 0,
        totalArtifacts: null,
        waitingForAuth,
        updatedAt: "2026-10-26T09:01:00Z",
      },
    ],
  };
}

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
      movePlacement = placement,
    }: {
      queue: ThreadPromptQueue;
      environment?: EnvironmentId;
      logicalThread?: ThreadId;
      movePlacement?: RelayPortableThreadPlacement;
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
            placement={movePlacement}
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
      movePlacement = placement,
    ) => {
      await act(async () => {
        const view = (
          <Harness
            queue={queue ?? initialQueue}
            environment={environment}
            logicalThread={logicalThread}
            movePlacement={movePlacement}
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
      fixture.providerAuthError = null;
      let id = 0;
      fixture.uuid.mockImplementation(() => `cancel-${++id}`);
      fixture.dispatch.mockImplementation(async ({ command }) => ({
        _tag: "Success",
        value: { commandId: command.commandId, position: 1, receipt: null },
      }));
      fixture.receipt.mockResolvedValue({ _tag: "Success", value: null });
      fixture.cancelActive.mockResolvedValue({
        _tag: "Success",
        value: { ...activeReturnMove, phase: "aborting" },
      });
      fixture.checkActive.mockResolvedValue({
        _tag: "Success",
        value: { ...activeReturnMove, phase: "aborting" },
      });
      fixture.refresh.mockResolvedValue(undefined);
    });
    afterEach(async () => {
      if (renderer) await act(async () => renderer!.unmount());
      renderer = undefined;
      vi.unstubAllGlobals();
    });
    it("shows current verification read failures in the move row that owns the notice", async () => {
      const current = withWorkerAuth("verification");
      fixture.providerAuthError = "The VM could not be reached.";
      await render(initialQueue, environmentId, threadId, current);
      const content = JSON.stringify(renderer!.toJSON());
      expect(content).toContain("Could not check Codex sign-in");
      expect(content).toContain("The VM could not be reached.");
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
    it("cancels the relay's failed return move from a stale outbound queue", async () => {
      await render(initialQueue, environmentId, threadId, activeReturnPlacement);
      const content = JSON.stringify(renderer!.toJSON());
      expect(content).toContain("Could not save the current history.");
      expect(button("Retry move")).toBeUndefined();
      expect(content.indexOf("Private VM")).toBeLessThan(content.indexOf("Akina"));
      const rows = renderer!.root
        .findAllByType("div")
        .filter(
          (row) => (row.props["aria-label"] ?? row.props.accessibilityLabel) === "Thread move",
        );
      expect(rows).toHaveLength(1);
      await click("Cancel move");
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.cancelActive).toHaveBeenCalledWith({
        accountId: "owner",
        relayUrl: "https://relay.example.test",
        threadId,
        operationId: "return",
        sourceGeneration: 3,
      });
      // A successful reply can arrive before the scoped placement read.
      await click("Check status");
      expect(fixture.checkActive).toHaveBeenCalledWith(fixture.cancelActive.mock.calls[0]![0]);
      expect(fixture.cancelActive).toHaveBeenCalledTimes(1);
      await render(initialQueue, environmentId, threadId, {
        ...activeReturnPlacement,
        activeMove: { ...activeReturnMove, phase: "reopening" },
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("Reopening source…");
      expect(button("Cancel move")).toBeUndefined();
      fixture.checkActive.mockResolvedValueOnce({
        _tag: "Success",
        value: { ...activeReturnMove, phase: "aborted" },
      });
      await click("Check status");
      expect(JSON.stringify(renderer!.toJSON())).toContain("Move cancelled");
      await render(
        { ...initialQueue, entries: [{ ...initialMove, operationId: CommandId.make("return") }] },
        EnvironmentId.make("vm"),
        threadId,
        {
          ...activeReturnPlacement,
          operationId: null,
          activeMove: { ...activeReturnMove, phase: "aborted" },
        },
      );
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Thread move");
      expect(button("Check status")).toBeUndefined();
    });
    it("retries a rejected legacy cancel against the same move during source reopen", async () => {
      await render(initialQueue, environmentId, threadId, {
        ...activeReturnPlacement,
        operationId: null,
        activeMove: {
          ...activeReturnMove,
          phase: "reopening",
          cancellationMode: "legacy",
          cancellationBlocker: "legacy_cancel_rejected",
        },
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain("Reopening source…");
      await click("Retry cancellation");
      expect(fixture.cancelActive).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "return", sourceGeneration: 3 }),
      );
      expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it("retries only the exact failed save from a retired view and keeps Cancel available", async () => {
      const reply = deferred<unknown>();
      fixture.retryActive.mockImplementationOnce(() => reply.promise);
      const failed = {
        ...activeReturnPlacement,
        activeMove: { ...activeReturnMove, retryRequiredAttempt: 4 },
        moveFailures: [
          {
            environmentId: "vm",
            generation: 3,
            attempt: 4,
            active: true,
            detail: "The Codex history changed while saving.",
            reportedAt: "2026-10-26T09:01:00.000Z",
          },
        ],
      } satisfies RelayPortableThreadPlacement;
      await render(initialQueue, environmentId, threadId, failed);
      const action = button("Retry move")!;
      await act(async () => {
        const press = action.props.onClick ?? action.props.onPress;
        press();
        press();
      });
      expect(fixture.retryActive).toHaveBeenCalledExactlyOnceWith({
        accountId: "owner",
        relayUrl: "https://relay.example.test",
        threadId,
        operationId: "return",
        sourceGeneration: 3,
        failedAttempt: 4,
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        "The Codex history changed while saving.",
      );
      expect(button("Requesting retry…")?.props.disabled).toBe(true);
      expect(button("Cancel move")?.props.disabled).not.toBe(true);
      await act(async () => {
        reply.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Retry reply lost")) });
      });
      expect(button("Retry move")).toBeDefined();
      expect(JSON.stringify(renderer!.toJSON())).toContain("Retry reply lost");
      const retryRequested = { ...activeReturnMove, retryRequestedAttempt: 4 };
      fixture.retryActive.mockResolvedValueOnce({ _tag: "Success", value: retryRequested });
      await click("Retry move");
      expect(button("Retry requested")?.props.disabled).toBe(true);
      expect(fixture.retryActive.mock.calls[1]).toEqual(fixture.retryActive.mock.calls[0]);
      await render(initialQueue, environmentId, threadId, {
        ...failed,
        activeMove: retryRequested,
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        "Waiting for the source to try saving again.",
      );
      expect(button("Retry move")).toBeUndefined();
      expect(button("Cancel move")).toBeDefined();
      expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it("cancels a relay move while the source socket is unavailable", async () => {
      await act(async () => {
        renderer = create(
          <MoveItem
            environmentId={environmentId}
            threadId={threadId}
            placement={activeReturnPlacement}
            disabled
          />,
        );
      });
      await click("Cancel move");
      expect(fixture.cancelActive).toHaveBeenCalledTimes(1);
    });
    it("ignores a lost reply for an operation that the relay already replaced", async () => {
      const reply = deferred<unknown>();
      fixture.cancelActive.mockImplementationOnce(() => reply.promise);
      await render(initialQueue, environmentId, threadId, activeReturnPlacement);
      await click("Cancel move");
      await render(initialQueue, environmentId, threadId, {
        ...activeReturnPlacement,
        operationId: "replacement",
        activeMove: { ...activeReturnMove, operationId: "replacement" },
      });
      await act(async () => {
        reply.resolve({ _tag: "Failure", cause: Cause.fail(new Error("lost reply")) });
      });
      expect(fixture.checkActive).not.toHaveBeenCalled();
      expect(fixture.cancelActive).toHaveBeenCalledTimes(1);
      await click("Cancel move");
      expect(fixture.cancelActive).toHaveBeenLastCalledWith(
        expect.objectContaining({ operationId: "replacement" }),
      );
    });
    it("keeps relay sign-in usable when the source queue is unavailable", async () => {
      fixture.status = {
        threadId,
        generation: 2,
        allocation: null,
        setupPhase: "pending",
        capacityState: "started",
        activity: "unknown",
        sourceActivationPending: false,
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
      const newLocation = EnvironmentId.make("new-location");
      await render(nextQueue, newLocation, threadId, {
        ...placement,
        environmentId: newLocation,
        generation: placement.generation + 1,
      });
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
        sourceActivationPending: false,
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
    it.each([
      ["account_selection", "Choose a Codex account"],
      ["personal_sign_in", "Waiting for Codex sign-in"],
      ["organization_connection", "Connect organization Codex"],
    ] as const)("keeps the neutral %s wait actionable", async (reason, label) => {
      const movePlacement = withWorkerAuth(reason);
      await render(initialQueue, environmentId, threadId, movePlacement);
      expect(JSON.stringify(renderer!.toJSON())).toContain(label);
      await click("Sign in to Codex");
      expect(fixture.signIn).toHaveBeenCalledTimes(1);
      expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it("keeps superseded failures in a passive disclosure and resets it for another move", async () => {
      const earlierError = "Earlier VM connection failed";
      const movePlacement: RelayPortableThreadPlacement = {
        ...withWorkerAuth("personal_sign_in"),
        moveFailures: [
          {
            environmentId: "vm",
            generation: 3,
            attempt: 1,
            detail: earlierError,
            reportedAt: "2026-10-26T09:00:00Z",
            active: false,
          },
        ],
      };
      await render(initialQueue, environmentId, threadId, movePlacement);
      expect(JSON.stringify(renderer!.toJSON())).toContain("Waiting for Codex sign-in");
      if (surface === "web") {
        const disclosure = renderer!.root.findByType("details");
        expect(disclosure.props.open).not.toBe(true);
        expect(disclosure.findByType("summary").children.join("")).toBe("Previous error");
        expect(disclosure.findByType("p").children.join("")).toBe(earlierError);
      } else {
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(earlierError);
        expect(button("Previous error")!.props.accessibilityState.expanded).toBe(false);
        await click("Previous error");
        expect(button("Previous error")!.props.accessibilityState.expanded).toBe(true);
        expect(JSON.stringify(renderer!.toJSON())).toContain(earlierError);
        const operationId = CommandId.make("next-move");
        await render(
          { ...initialQueue, entries: [{ ...initialMove, operationId }] },
          environmentId,
          threadId,
          { ...movePlacement, operationId },
        );
        expect(button("Previous error")!.props.accessibilityState.expanded).toBe(false);
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(earlierError);
      }
      expect(fixture.signIn).not.toHaveBeenCalled();
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
