import { act, createElement, createRef, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadPromptQueueEntry,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { SharedPromptQueue, type SharedPromptQueueHandle } from "./SharedPromptQueue";
import { SharedPromptQueueRow } from "./SharedPromptQueueRow";

const commands = vi.hoisted(() => ({
  remove: vi.fn(),
  reorder: vi.fn(),
  ok: vi.fn(async () => ({ _tag: "Success", value: {} })),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "account" ? { accountId: "account" } : []),
}));
vi.mock("@t3tools/client-runtime/relay", () => ({ managedRelaySessionAtom: "account" }));
vi.mock("@t3tools/client-runtime/relay/portableThreads", () => ({
  portableCommandStatesAtom: "commands",
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { removePrompt: "remove", reorderQueue: "reorder" },
}));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "remove" ? commands.remove : command === "reorder" ? commands.reorder : commands.ok,
}));
vi.mock("./ThreadMoveQueueItem", () => ({
  useThreadMovePlacement: () => null,
  ThreadMoveQueueItem: () => null,
}));
vi.mock("./SharedPromptQueueRow", () => ({ SharedPromptQueueRow: () => null }));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => createElement("textarea", props),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));

const first: ThreadPromptQueueEntry = {
  messageId: MessageId.make("first"),
  text: "Draft",
  attachments: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  acceptedSequence: 1,
  state: "pending",
  createdAt: "2026-10-30T10:00:00Z",
};
const second = { ...first, messageId: MessageId.make("second") };
const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const queue = { ...emptyThreadPromptQueue(), entries: [first, second] };
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.remove.mockResolvedValue({ _tag: "Success", value: {} });
  commands.reorder.mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});

it("keeps an inline prompt editor and its conflict visible after remote removal", async () => {
  const controlsRef = createRef<SharedPromptQueueHandle>();
  const render = (entries = [first]) => (
    <SharedPromptQueue
      threadRef={threadRef}
      queue={{ ...queue, entries }}
      activeTurnId={null}
      visibleEntryIds={[]}
      controlsRef={controlsRef}
    />
  );
  await act(() => {
    renderer = create(render());
  });
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  await act(() => controlsRef.current!.edit(first.messageId));
  expect(renderer!.root.findByType("textarea").props.value).toBe("Draft");
  await act(() => renderer!.update(render([])));
  expect(renderer!.root.findByType("textarea").props.value).toBe("Draft");
  expect(
    renderer!.root
      .findAllByProps({ role: "alert" })
      .some((node) => node.children.join("").includes("no longer queued")),
  ).toBe(true);
});

it("keeps removal failures visible when the full queue is hidden", async () => {
  const controlsRef = createRef<SharedPromptQueueHandle>();
  commands.remove.mockRejectedValue(new Error("Connection failed"));
  await act(() => {
    renderer = create(
      <SharedPromptQueue
        threadRef={threadRef}
        queue={queue}
        activeTurnId={null}
        visibleEntryIds={[]}
        controlsRef={controlsRef}
      />,
    );
  });
  await act(() => controlsRef.current!.remove(first.messageId));
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "request failed",
  );
});

it("reorders with the complete canonical queue when its first visual row is hidden", async () => {
  await act(() => {
    renderer = create(
      <SharedPromptQueue
        threadRef={threadRef}
        queue={queue}
        activeTurnId={null}
        visibleEntryIds={[second.messageId]}
      />,
    );
  });
  const row = renderer!.root.findByType(SharedPromptQueueRow);
  expect(row.props.index).toBe(1);
  await act(() => row.props.onMoveNext());
  expect(commands.reorder.mock.calls[0]?.[0].input.order).toEqual([
    second.messageId,
    first.messageId,
  ]);
});
