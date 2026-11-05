import { act, createRef, useState, type ComponentType, type Ref } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  ThreadId,
  type ThreadPromptQueueEntry,
  type ThreadPromptQueue,
  type ThreadQueueEntry,
  type TurnId,
} from "@t3tools/contracts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { threadPromptQueuePresentation } from "@t3tools/client-runtime/state/threads";

const fixture = vi.hoisted(() => ({
  edit: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
  pause: vi.fn(),
  ok: vi.fn(async () => ({ _tag: "Success", value: {} })),
}));
vi.mock("../../../../mobile/node_modules/react-native", () => ({
  View: "div",
  ScrollView: "section",
  Pressable: "button",
  TextInput: "input",
  Alert: { alert: vi.fn() },
}));
vi.mock("../../../../mobile/node_modules/expo-crypto", () => ({ randomUUID: () => "command" }));
vi.mock("../../../../mobile/src/components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../../mobile/src/components/AppSymbol", () => ({ SymbolView: "symbol" }));
vi.mock("../../../../mobile/node_modules/@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "account" ? { accountId: "account" } : []),
}));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: "account" }));
vi.mock("@t3tools/client-runtime/relay/portableThreads", () => ({
  portableCommandStatesAtom: "commands",
}));
vi.mock("../../../../mobile/src/state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
}));
vi.mock("../../../../mobile/src/features/threads/ThreadMoveQueueItem", () => ({
  useThreadMovePlacement: () => null,
  ThreadMoveQueueItem: () => null,
}));
vi.mock("../../../../mobile/src/state/threads", () => ({
  threadEnvironment: { editPrompt: "edit", removePrompt: "remove", reorderQueue: "reorder" },
}));
vi.mock("../../../../mobile/src/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "edit"
      ? fixture.edit
      : command === "remove"
        ? fixture.remove
        : command === "reorder"
          ? fixture.reorder
          : fixture.ok,
}));

interface SharedPromptQueueHandle {
  edit: (messageId: string) => void;
  remove: (messageId: string) => void;
}
vi.mock("../../../../mobile/node_modules/react/index.js", async () => import("react"));
const nativeQueueModule = "../../../../mobile/src/features/threads/SharedPromptQueue";
const { SharedPromptQueue, InlinePromptActions } = await vi.importActual<{
  SharedPromptQueue: ComponentType<{
    ref?: Ref<SharedPromptQueueHandle>;
    environmentId: EnvironmentId;
    threadId: ThreadId;
    queue: ThreadPromptQueue;
    visibleEntries: ReadonlyArray<ThreadQueueEntry>;
    activeTurnId: TurnId | null;
    unavailable: boolean;
  }>;
  InlinePromptActions: ComponentType<{
    prompt: ThreadPromptQueueEntry;
    disabled?: boolean;
    onEdit?: (messageId: string) => void;
    onRemove?: (messageId: string) => void;
    onPause?: () => void;
  }>;
}>(nativeQueueModule);

const first: ThreadPromptQueueEntry = {
  messageId: MessageId.make("first"),
  text: "First",
  attachments: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  acceptedSequence: 1,
  createdAt: "2026-10-30T10:00:00Z",
  state: "pending",
};
const second = { ...first, messageId: MessageId.make("second"), text: "Second" };
const queue = { ...emptyThreadPromptQueue(), entries: [first, second] };
const environmentId = EnvironmentId.make("environment"),
  threadId = ThreadId.make("thread");
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.edit.mockResolvedValue({ _tag: "Success", value: {} });
  fixture.remove.mockResolvedValue({ _tag: "Success", value: {} });
  fixture.reorder.mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

function button(label: string) {
  const found = renderer!.root
    .findAllByType("button")
    .find((node) => node.props.accessibilityLabel === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

it("keeps the inline editor mounted across queue recovery and preserves conflicts", async () => {
  const ref = createRef<SharedPromptQueueHandle>();
  const render = (current = queue, visible = current.entries) => (
    <SharedPromptQueue
      ref={ref}
      environmentId={environmentId}
      threadId={threadId}
      queue={current}
      visibleEntries={visible}
      activeTurnId={null}
      unavailable={false}
    />
  );
  await act(async () => {
    renderer = create(render(queue, []));
  });
  expect(renderer!.toJSON()).toBeNull();
  await act(async () => ref.current!.edit(first.messageId));
  expect(renderer!.root.findByType("input").props.value).toBe("First");
  await act(async () => renderer!.root.findByType("input").props.onChangeText("My draft"));
  const changed = { ...queue, entries: [{ ...first, revision: 2, text: "Teammate edit" }, second] };
  await act(async () => renderer!.update(render(changed)));
  expect(renderer!.root.findByType("input").props.value).toBe("My draft");
  expect(JSON.stringify(renderer!.toJSON())).toContain("teammate changed");
  expect(button("Save edit").props.disabled).toBe(true);
  await act(async () => renderer!.update(render(changed, [])));
  expect(renderer!.root.findByType("input").props.value).toBe("My draft");
  await act(async () => button("Keep my draft against this version").props.onPress());
  await act(async () => button("Save edit").props.onPress());
  expect(fixture.edit).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId,
      messageId: first.messageId,
      expectedRevision: 2,
      expectedRuntimeMode: first.runtimeMode,
      message: { text: "My draft", attachments: [] },
    },
  });
  expect(renderer!.toJSON()).toBeNull();
});

it("uses canonical indices when only the second entry remains in the visible backlog", async () => {
  await act(async () => {
    renderer = create(
      <SharedPromptQueue
        environmentId={environmentId}
        threadId={threadId}
        queue={queue}
        visibleEntries={[second]}
        activeTurnId={null}
        unavailable={false}
      />,
    );
  });
  const text = JSON.stringify(renderer!.toJSON());
  expect(text).toContain("Second");
  expect(text).not.toContain('"First"');
  expect(
    renderer!.root.findAllByType("span").some((node) => node.children.join("") === "Queued 1"),
  ).toBe(true);
  expect(button("Move next").props.disabled).toBe(false);
  expect(button("Move down").props.disabled).toBe(true);
  await act(async () => button("Move next").props.onPress());
  expect(fixture.reorder).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, expectedRevision: 0, order: [second.messageId, first.messageId] },
  });
});

it("retains a failed inline removal and blocks actions after delivery claims the entry", async () => {
  const ref = createRef<SharedPromptQueueHandle>();
  fixture.remove.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    renderer = create(
      <SharedPromptQueue
        ref={ref}
        environmentId={environmentId}
        threadId={threadId}
        queue={queue}
        visibleEntries={[]}
        activeTurnId={null}
        unavailable={false}
      />,
    );
  });
  await act(async () => ref.current!.remove(first.messageId));
  expect(JSON.stringify(renderer!.toJSON())).toContain("Your draft is preserved");
  const delivering = { ...queue, entries: [{ ...first, state: "delivering" as const }, second] };
  await act(async () =>
    renderer!.update(
      <SharedPromptQueue
        ref={ref}
        environmentId={environmentId}
        threadId={threadId}
        queue={delivering}
        visibleEntries={[]}
        activeTurnId={null}
        unavailable={false}
      />,
    ),
  );
  await act(async () => {
    ref.current!.edit(first.messageId);
    ref.current!.remove(first.messageId);
  });
  expect(fixture.remove).toHaveBeenCalledOnce();
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});

function InlineDraftHarness({
  state = "delivering",
  archived = false,
  unavailable = false,
  workflowControlled = false,
}: {
  state?: ThreadPromptQueueEntry["state"];
  archived?: boolean;
  unavailable?: boolean;
  workflowControlled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [paused, setPaused] = useState(false);
  const prompt = { ...first, state };
  const current = {
    ...emptyThreadPromptQueue(),
    enabled: !paused,
    pauseReason: paused ? { code: "stopped" as const, detail: "Paused by you" } : null,
    entries: [prompt],
    handoff:
      state === "delivering"
        ? {
            attemptId: CommandId.make("attempt"),
            messageId: first.messageId,
            revision: 1,
            controlRevision: 0,
            mode: "next-turn" as const,
          }
        : null,
  };
  const presentation = threadPromptQueuePresentation({
    queue: current,
    messages: [],
    sessionStatus: state === "delivering" ? "starting" : "ready",
    archived,
    unavailable,
    workflowControlled,
  });
  return (
    <>
      <input
        value={draft}
        onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
      />
      {presentation.inline ? (
        <InlinePromptActions
          prompt={presentation.inline.prompt}
          disabled={unavailable || workflowControlled}
          onPause={() => {
            fixture.pause({ environmentId, input: { threadId } });
            setPaused(true);
          }}
        />
      ) : null}
      <SharedPromptQueue
        environmentId={environmentId}
        threadId={threadId}
        queue={current}
        visibleEntries={presentation.queuedEntries}
        activeTurnId={null}
        unavailable={unavailable}
      />
    </>
  );
}

it.each(["pending", "delivering"] as const)(
  "keeps inline Pause available while typing a follow-up during %s",
  async (state) => {
    await act(async () => {
      renderer = create(<InlineDraftHarness state={state} />);
    });
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "My next draft" } }),
    );
    expect(button("Pause queue").props.disabled).not.toBe(true);
    expect(
      renderer!.root.findAllByType("span").some((node) => node.children.join("") === "Queued 1"),
    ).toBe(false);
    await act(async () => button("Pause queue").props.onPress());
    expect(fixture.pause).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    expect(renderer!.root.findByType("input").props.value).toBe("My next draft");
    expect(button("Resume queue").props.disabled).toBe(state === "delivering");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Paused by you");
  },
);

it("keeps an archived pending head in the full queue instead of the immediate-message actions", async () => {
  await act(async () => {
    renderer = create(<InlineDraftHarness state="pending" archived />);
  });
  expect(
    renderer!.root.findAllByType("span").some((node) => node.children.join("") === "Queued 1"),
  ).toBe(true);
  expect(button("Edit").props.disabled).not.toBe(true);
  expect(
    renderer!.root
      .findAllByType("button")
      .some((node) => node.props.accessibilityLabel === "Edit queued prompt"),
  ).toBe(false);
});
