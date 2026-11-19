import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  session: { accountId: "account" },
  sessionAtom: Symbol("session"),
  proofsAtom: Symbol("proofs"),
  draftsAtom: Symbol("drafts"),
  handoff: vi.fn(),
}));
const placement = { operationId: null, environmentId: "vm", generation: 2 };
const proofs = {
  session: mocks.session,
  relayUrl: "https://relay.example.com",
  placements: new Map([["thread", placement]]),
};
const source = { prompt: "Incoming", images: [], files: [], persistedAttachments: [] };
const destination = { ...source, prompt: "Existing" };
const drafts = { "mac:thread": source };
const state = { draftsByThreadKey: drafts };
const mobileDrafts = { "mac:thread": { text: "Incoming", attachments: [] } };

function readAtom(atom: unknown) {
  return atom === mocks.sessionAtom
    ? mocks.session
    : atom === mocks.draftsAtom
      ? mobileDrafts
      : proofs;
}
function readRegistry(atom: unknown) {
  return atom === mocks.sessionAtom
    ? mocks.session
    : atom === mocks.proofsAtom
      ? proofs
      : { relayRouting: { generation: 1 } };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: readAtom,
}));
vi.mock("@t3tools/client-runtime/relay", () => ({
  managedRelaySessionAtom: mocks.sessionAtom,
}));
vi.mock("@t3tools/client-runtime/relay/portableThreadPresentation", () => ({
  portableThreadPlacementsAtom: mocks.proofsAtom,
  isPortableThreadSourceLocation: () => true,
}));
vi.mock("../../composerDraftStore", () => ({
  handoffMovedThreadDraft: mocks.handoff,
  composerDraftHasUserContent: (draft: typeof source) => !!draft.prompt,
  useComposerDraftStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("../../lib/movedThreadDraft", () => ({ recoverMovedDraftFile: vi.fn() }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: readRegistry },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => Symbol("shell") },
}));
vi.mock("../../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.com",
}));
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & {
    size?: string;
    variant?: string;
  }) => <button {...props} />,
}));

// Mount the mobile component with the same React instance as the renderer.
vi.mock("../../../../mobile/node_modules/react/index.js", async () => import("react"));
vi.mock("../../../../mobile/node_modules/@effect/atom-react", () => ({ useAtomValue: readAtom }));
vi.mock("../../../../mobile/node_modules/react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../../../../mobile/src/components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../../mobile/src/state/atom-registry", () => ({
  appAtomRegistry: { get: readRegistry },
}));
vi.mock("../../../../mobile/src/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => Symbol("shell") },
}));
vi.mock("../../../../mobile/src/state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.com",
}));
vi.mock("../../../../mobile/src/state/use-composer-drafts", () => ({
  composerDraftsAtom: mocks.draftsAtom,
  handoffMovedThreadDraft: mocks.handoff,
  isComposerDraftEmpty: () => false,
}));

import { MovedThreadDraftRecovery } from "./MovedThreadDraftRecovery";
const mobileComponentPath = "../../../../mobile/src/features/threads/MovedThreadDraftRecovery";
const { MovedThreadDraftRecovery: MobileMovedThreadDraftRecovery } = await vi.importActual<{
  MovedThreadDraftRecovery: typeof MovedThreadDraftRecovery;
}>(mobileComponentPath);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer;
const renderedText = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(renderedText).join("");
const button = (label: string) =>
  renderer.root.findAllByType("button").find((entry) => renderedText(entry).endsWith(label))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.handoff.mockReset();
  proofs.placements.set("thread", placement);
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe.each([
  { surface: "web", Component: MovedThreadDraftRecovery },
  { surface: "mobile", Component: MobileMovedThreadDraftRecovery },
])("$surface moved draft recovery", ({ surface, Component }) => {
  it.each(["unchanged", "generation"])(
    "checks route fields after a %s placement refresh during recovery",
    async (change) => {
      const started = gate();
      const pending = gate();
      const confirmed: boolean[] = [];
      mocks.handoff.mockImplementation(async (input: { stillCurrent: () => boolean }) => {
        started.resolve();
        await pending.promise;
        const current = input.stillCurrent();
        confirmed.push(current);
        if (!current) throw new Error("The thread’s location changed.");
        return {};
      });
      await act(async () => {
        renderer = create(
          <Component environmentId={EnvironmentId.make("vm")} threadId={ThreadId.make("thread")} />,
        );
      });
      await act(async () => {
        button("Review saved draft").props.onClick();
        await started.promise;
      });
      proofs.placements.set("thread", {
        ...placement,
        generation: change === "generation" ? 3 : 2,
      });
      await act(async () => {
        pending.resolve();
      });
      expect(confirmed).toEqual([change === "unchanged"]);
      if (change === "generation")
        expect(JSON.stringify(renderer.toJSON())).toContain("The thread’s location changed.");
      else
        expect(JSON.stringify(renderer.toJSON())).not.toContain("The thread’s location changed.");
    },
  );
  it.each(["Use saved draft", "Keep current draft"])(
    "allows a fresh review when %s rejects an outdated choice",
    async (choice) => {
      const incoming = surface === "web" ? source : { text: "Incoming", attachments: [] };
      const existing = surface === "web" ? destination : { text: "Existing", attachments: [] };
      const updated =
        surface === "web"
          ? { ...destination, prompt: "Updated" }
          : { text: "Updated", attachments: [] };
      mocks.handoff
        .mockResolvedValueOnce({ conflict: { source: incoming, destination: existing } })
        .mockRejectedValueOnce(
          new Error("A draft changed while you were choosing. Check both drafts again."),
        )
        .mockResolvedValueOnce({ conflict: { source: incoming, destination: updated } });
      await act(async () => {
        renderer = create(
          <Component environmentId={EnvironmentId.make("vm")} threadId={ThreadId.make("thread")} />,
        );
      });
      await act(async () => {
        button("Review saved draft").props.onClick();
      });
      await act(async () => {
        button(choice).props.onClick();
      });

      expect(JSON.stringify(renderer.toJSON())).toContain(
        "A draft changed while you were choosing. Check both drafts again.",
      );
      expect(button("Review saved draft")).toBeDefined();
      await act(async () => {
        button("Review saved draft").props.onClick();
      });
      expect(mocks.handoff.mock.lastCall![0].choice).toBeUndefined();
      expect(JSON.stringify(renderer.toJSON())).toContain("Updated");
    },
  );
});
