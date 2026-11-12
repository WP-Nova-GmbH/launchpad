import type {
  RelayCodexVmConnection,
  RelayThreadVmCodexAuthSelection,
  RelayThreadVmCodexPreference,
} from "@t3tools/contracts/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  save: vi.fn(),
  check: vi.fn(),
  retry: vi.fn(),
  close: vi.fn(),
  state: {
    data: null as RelayThreadVmCodexPreference | null,
    connection: null as RelayCodexVmConnection | null,
    phase: "idle" as "idle" | "saving" | "unknown" | "rejected",
    requested: null as RelayThreadVmCodexAuthSelection | null,
    hasRequested: false,
    isPending: false,
    error: null as string | null,
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixture.state }));
vi.mock("../../state/threads", () => ({
  threadVmControls: {
    codexPreferenceViewAtom: () => fixture.state,
    setCodexPreference: "save",
    refreshCodexPreference: "check",
    retryCodexPreference: "retry",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "save" ? fixture.save : command === "check" ? fixture.check : fixture.retry,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: PropsWithChildren) => <dialog open>{children}</dialog>,
  DialogPopup: "div",
  DialogHeader: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "div",
  DialogFooter: "div",
}));
vi.mock("../ui/radio-group", async () => {
  const { createContext, useContext, useMemo } = await import("react");
  const Context = createContext({
    value: null as string | null,
    disabled: false,
    onValueChange: (_value: string): void => undefined,
  });
  return {
    RadioGroup: ({
      children,
      value,
      disabled,
      onValueChange,
    }: PropsWithChildren<{
      value: string | null;
      disabled: boolean;
      onValueChange: (value: string) => void;
    }>) => {
      const context = useMemo(
        () => ({ value, disabled, onValueChange }),
        [value, disabled, onValueChange],
      );
      return (
        <Context.Provider value={context}>
          <div role="radiogroup">{children}</div>
        </Context.Provider>
      );
    },
    Radio: ({ value, disabled }: { value: string; disabled?: boolean }) => {
      const group = useContext(Context);
      return (
        <input
          type="radio"
          value={value}
          checked={group.value === value}
          disabled={group.disabled || disabled}
          onChange={() => group.onValueChange(value)}
        />
      );
    },
  };
});

import { ThreadVmAccountPreference } from "./ThreadVmAccountPreference";

const environmentId = EnvironmentId.make("local"),
  threadId = ThreadId.make("chat"),
  organization = { mode: "organization", connectionId: "organization-codex" } as const;
let renderer: ReactTestRenderer | undefined;
const view = (disabled = false) => (
  <ThreadVmAccountPreference
    environmentId={environmentId}
    threadId={threadId}
    accountId="owner"
    disabled={disabled}
    onClose={fixture.close}
    finalFocus={{ current: null }}
  />
);
const radio = (value: string) =>
  renderer!.root.findAllByType("input").find((node) => node.props.value === value)!;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const text = () => JSON.stringify(renderer!.toJSON());
const refresh = async (disabled = false) => {
  await act(async () => renderer!.update(view(disabled)));
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.state = {
    data: { generation: 3, revision: 4, selection: { mode: "personal" }, editable: true },
    connection: {
      connectionId: "organization-codex",
      label: "Company account",
      status: "connected",
      epoch: 1,
      tokenRevision: 1,
      errorCode: null,
      refreshing: false,
    },
    phase: "idle",
    requested: null,
    hasRequested: false,
    isPending: false,
    error: null,
  };
  fixture.save.mockResolvedValue(AsyncResult.success(null));
  fixture.check.mockResolvedValue(AsyncResult.success(null));
  fixture.retry.mockResolvedValue(AsyncResult.success(null));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(view());
  });
};

describe("account for the next VM", () => {
  it("shows the requested account immediately while its save is pending", async () => {
    await mount();
    expect(radio("personal").props.checked).toBe(true);
    fixture.save.mockImplementationOnce(() => {
      fixture.state.phase = "saving";
      fixture.state.hasRequested = true;
      fixture.state.requested = organization;
      return new Promise(() => {});
    });
    await act(async () => radio("organization:organization-codex").props.onChange());
    await refresh();
    expect(radio("organization:organization-codex").props.checked).toBe(true);
    expect(radio("personal").props.disabled).toBe(true);
    expect(text()).toContain("Saving choice…");
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      threadId,
      accountId: "owner",
      selection: organization,
      expectedGeneration: 3,
      expectedRevision: 4,
    });
    expect(text()).not.toContain("Sign in to Codex");
  });

  it("keeps an unconfirmed clear visible across reopening until its saved state is checked", async () => {
    await mount();
    await act(async () => button("Clear saved choice").props.onClick());
    fixture.state.phase = "unknown";
    fixture.state.hasRequested = true;
    fixture.state.requested = null;
    fixture.state.error = "The save could not be confirmed.";
    await refresh();
    expect(renderer!.root.findAllByType("input").every((node) => !node.props.checked)).toBe(true);
    expect(radio("personal").props.disabled).not.toBe(true);
    await act(async () => renderer!.unmount());
    await mount();
    expect(radio("personal").props.disabled).not.toBe(true);
    expect(button("Retry same choice")).toBeDefined();
    fixture.check.mockImplementationOnce(async () => {
      fixture.state.phase = "idle";
      fixture.state.hasRequested = false;
      fixture.state.data = { ...fixture.state.data!, revision: 5, selection: null };
      fixture.state.error = null;
      return AsyncResult.success(null);
    });
    await act(async () => button("Check saved choice").props.onClick());
    await refresh();
    expect(text()).toContain("No account choice saved.");
    expect(button("Clear saved choice").props.disabled).toBe(true);
    expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it("requires an explicit choice before adopting a replacement organization connection", async () => {
    fixture.state.data = { ...fixture.state.data!, selection: organization };
    fixture.state.connection = { ...fixture.state.connection!, connectionId: "replacement" };
    await mount();
    expect(radio("organization:replacement").props.checked).toBe(false);
    expect(text()).toContain("The saved organization account is unavailable.");
    expect(fixture.save).not.toHaveBeenCalled();
    await act(async () => radio("organization:replacement").props.onChange());
    expect(fixture.save).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { mode: "organization", connectionId: "replacement" } }),
    );
  });

  it("allows clearing an unconfirmed organization save even when no previous choice was saved", async () => {
    fixture.state.data = { ...fixture.state.data!, selection: null };
    fixture.state.phase = "unknown";
    fixture.state.hasRequested = true;
    fixture.state.requested = organization;
    fixture.state.connection = null;
    fixture.state.error = "The save could not be confirmed.";
    await mount();
    expect(button("Retry same choice").props.disabled).toBe(true);
    expect(button("Clear saved choice").props.disabled).toBe(false);
    expect(radio("personal").props.disabled).not.toBe(true);
    await act(async () => button("Clear saved choice").props.onClick());
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      threadId,
      accountId: "owner",
      selection: null,
      expectedGeneration: 3,
      expectedRevision: 4,
    });
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it("does not claim there is no saved choice when the first read fails", async () => {
    fixture.state.data = null;
    fixture.state.error = "Could not reach Launchpad Connect.";
    await mount();
    expect(text()).toContain("Could not check the saved choice.");
    expect(text()).not.toContain("No account choice saved.");
    expect(radio("personal").props.disabled).toBe(true);
    expect(button("Check saved choice")).toBeDefined();
  });

  it("retains a saved organization choice without claiming the missing connection is usable", async () => {
    fixture.state.data = { ...fixture.state.data!, selection: organization };
    fixture.state.connection = null;
    fixture.state.error = "Could not read the organization account.";
    await mount();
    expect(radio("organization:organization-codex").props.checked).toBe(true);
    expect(radio("organization:organization-codex").props.disabled).toBe(true);
    expect(text()).toContain("The saved organization account is unavailable.");
    expect(text()).not.toContain("Using organization ChatGPT plan");
    expect(button("Check saved choice")).toBeDefined();
  });

  it("blocks edits when a move starts while the editor is open", async () => {
    await mount();
    await refresh(true);
    expect(radio("personal").props.disabled).toBe(true);
    expect(button("Clear saved choice").props.disabled).toBe(true);
    await act(async () => radio("organization:organization-codex").props.onChange());
    expect(fixture.save).not.toHaveBeenCalled();
    expect(text()).toContain("Resolve the current move");
    expect(button("Close").props.disabled).not.toBe(true);
  });

  it("keeps the previous selection and rejection visible when a save is refused", async () => {
    fixture.state.phase = "rejected";
    fixture.state.error = "This chat moved. Check its current location.";
    fixture.state.data = { ...fixture.state.data!, editable: false };
    await mount();
    expect(radio("personal").props.checked).toBe(true);
    expect(radio("personal").props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
      "This chat moved. Check its current location.",
    ]);
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
