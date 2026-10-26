import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadPresencePerson } from "@t3tools/client-runtime/state/threadPresence";
import { act, type ComponentType, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const presence = vi.hoisted(() => ({ others: [] as ReadonlyArray<ThreadPresencePerson> }));
const viewer: ThreadPresencePerson = {
  key: "session:self",
  displayName: "My phone",
  imageUrl: null,
  email: null,
  userId: null,
  clientDetails: "iOS · Safari",
  isSelf: true,
  typing: false,
};
const other: ThreadPresencePerson = {
  ...viewer,
  key: "session:other",
  displayName: "Bob's laptop",
  isSelf: false,
};
vi.mock("../../state/threadPresence", () => ({
  useThreadPresencePeople: () => presence.others,
  useThreadPresenceParticipants: () => [viewer, ...presence.others],
}));
vi.mock("../../../../mobile/src/state/thread-presence", () => ({
  useThreadPresencePeople: () => presence.others,
  useThreadPresenceParticipants: () => [viewer, ...presence.others],
}));
vi.mock("../ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipPopup: () => null,
    TooltipTrigger: ({
      render,
      children,
    }: {
      render: import("react").ReactElement;
      children: ReactNode;
    }) => cloneElement(render, {}, children),
  };
});
vi.mock("../ui/dialog", async () => {
  const { createContext, useContext, cloneElement } = await import("react");
  const DialogState = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <DialogState value={props}>{props.children}</DialogState>,
    DialogTrigger: ({
      render,
      children,
      ...props
    }: {
      render: import("react").ReactElement<{ onClick?: () => void }>;
      children: ReactNode;
    }) => {
      const state = useContext(DialogState);
      return cloneElement(render, { ...props, onClick: () => state.onOpenChange(true) }, children);
    },
    DialogPopup: ({ children }: { children: ReactNode }) => {
      const state = useContext(DialogState);
      return state.open ? (
        <section role="dialog">
          <button onClick={() => state.onOpenChange(false)}>Close</button>
          {children}
        </section>
      ) : null;
    },
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogPanel: Part,
  };
});
// Exercise the native component in the existing web renderer, with native primitives replaced.
vi.mock("../../../../mobile/node_modules/react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Image: () => null,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  Modal: ({
    visible,
    children,
    onRequestClose,
  }: {
    visible: boolean;
    children: ReactNode;
    onRequestClose: () => void;
  }) =>
    visible ? (
      <section role="dialog">
        <button onClick={onRequestClose}>Native dismiss</button>
        {children}
      </section>
    ) : null,
}));
vi.mock("../../../../mobile/src/components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../../mobile/src/components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));

import { ThreadPresencePill } from "./ThreadPresencePill";

let NativePresence: ComponentType<{
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}>;
beforeAll(async () => {
  const native = await vi.importActual<{ ThreadPresence: typeof NativePresence }>(
    "../../../../mobile/src/features/threads/ThreadPresence.tsx",
  );
  NativePresence = native.ThreadPresence;
});
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  presence.others = [other];
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
const originalRef = {
  environmentId: EnvironmentId.make("host-a"),
  threadId: ThreadId.make("chat-a"),
};
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

for (const surface of ["web", "mobile"] as const) {
  describe(`${surface} participant dialog lifecycle`, () => {
    const render = (ref: ScopedThreadRef | null = originalRef) =>
      surface === "web" ? (
        <ThreadPresencePill threadRef={ref} />
      ) : (
        <NativePresence
          environmentId={ref?.environmentId ?? null}
          threadId={ref?.threadId ?? null}
        />
      );
    const update = async (ref: ScopedThreadRef | null = originalRef) => {
      await act(() => renderer.update(render(ref)));
    };
    const dialogs = () => renderer.root.findAllByProps({ role: "dialog" });
    const open = async () => {
      const trigger = renderer.root
        .findAllByType("button")
        .find((button) =>
          String(button.props["aria-label"]).startsWith("View thread participants"),
        )!;
      await act(() => trigger.props.onClick());
    };
    const start = async () => {
      await act(() => {
        renderer = create(render());
      });
      await open();
      expect(dialogs()).toHaveLength(1);
    };
    it("keeps an opened list and You visible when the last other viewer leaves and rejoins", async () => {
      await start();
      presence.others = [];
      await update({ ...originalRef });
      expect(dialogs()).toHaveLength(1);
      expect(textOf(dialogs()[0]!)).toContain("You");
      expect(textOf(dialogs()[0]!)).not.toContain(other.displayName);
      presence.others = [other];
      await update();
      expect(dialogs()).toHaveLength(1);
      expect(textOf(dialogs()[0]!)).toContain(other.displayName);
    });
    it("does not reopen a dismissed list after viewers leave and return", async () => {
      await start();
      const close = dialogs()[0]!
        .findAllByType("button")
        .find((node) => textOf(node) === "Close")!;
      await act(() => close.props.onClick());
      expect(dialogs()).toHaveLength(0);
      presence.others = [];
      await update();
      presence.others = [other];
      await update();
      expect(dialogs()).toHaveLength(0);
    });
    it.each([
      { ...originalRef, threadId: ThreadId.make("chat-b") },
      { ...originalRef, environmentId: EnvironmentId.make("host-b") },
      null,
    ])("closes on navigation to %j and stays closed on returning", async (nextRef) => {
      await start();
      await update(nextRef);
      expect(dialogs()).toHaveLength(0);
      await update(originalRef);
      expect(dialogs()).toHaveLength(0);
      await open();
      expect(dialogs()).toHaveLength(1);
    });
  });
}
