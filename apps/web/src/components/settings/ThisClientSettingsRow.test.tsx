import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, type ComponentType, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const backend = vi.hoisted(() => ({
  label: "My browser",
  read: vi.fn(),
  rename: vi.fn(),
  refresh: vi.fn(),
  remember: vi.fn(),
  fetchSession: vi.fn(),
  live: undefined as unknown as Atom.Writable<
    AsyncResult.AsyncResult<Exclude<AuthSessionState["currentSession"], undefined> | null>
  >,
}));
const session = (): AuthSessionState => ({
  authenticated: true,
  scopes: [...AuthStandardClientScopes],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "session",
  },
  currentSession: {
    sessionId: AuthSessionId.make("self"),
    client: { label: backend.label, deviceType: "desktop" },
    needsClientLabel: false,
  },
});
vi.mock("../../environments/primary/auth", () => ({ fetchSessionState: backend.fetchSession }));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../state/auth", () => ({ authEnvironment: { currentSession: () => backend.live } }));
vi.mock("../../connection/onboarding", () => ({
  readConnectedClient: backend.read,
  renameConnectedClient: backend.rename,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));
vi.mock("../auth/ClientNameField", () => ({
  useClientName: () => ["Suggested name", () => {}],
  rememberClientLabel: backend.remember,
  ClientNameField: ({
    value,
    onChange,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <input
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      {title}
      <span>{description}</span>
      {control}
    </div>
  ),
}));
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <section role="dialog">{children}</section> : null,
    DialogPopup: Part,
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogPanel: Part,
    DialogFooter: Part,
  };
});

vi.mock("../../../../mobile/node_modules/react-native", () => {
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    View: Part,
    KeyboardAvoidingView: Part,
    Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
      visible ? <section role="dialog">{children}</section> : null,
  };
});
vi.mock("../../../../mobile/src/components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../../mobile/src/components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../../../mobile/src/features/connection/ConnectionFormField", () => ({
  ConnectionFormField: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => <input value={value} onChange={(event) => onChangeText(event.currentTarget.value)} />,
}));
vi.mock("../../../../mobile/src/features/connection/useClientName", () => ({
  useClientName: () => ["Suggested name", () => {}],
  rememberClientLabel: backend.remember,
}));
vi.mock("../../../../mobile/src/state/query", async () => vi.importActual("../../state/query"));
vi.mock("../../../../mobile/src/state/auth", () => ({
  authEnvironment: { currentSession: () => backend.live },
}));
vi.mock("../../../../mobile/src/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../../../mobile/src/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../../../mobile/src/connection/onboarding", () => ({
  readConnectedClient: backend.read,
  renameConnectedClient: backend.rename,
}));

import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ClientNameButton } from "../auth/ClientNameDialog";
import { ThisClientSettingsRow } from "./ThisClientSettingsRow";

let NativeClientNameButton: ComponentType<{
  environmentId: EnvironmentId;
  environmentLabel: string;
}>;
beforeAll(async () => {
  const native = await vi.importActual<{ ClientNameButton: typeof NativeClientNameButton }>(
    "../../../../mobile/src/features/connection/ClientNameDialog.tsx",
  );
  NativeClientNameButton = native.ClientNameButton;
});

let renderer: ReactTestRenderer;
const environmentId = EnvironmentId.make("primary");
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  backend.label = "My browser";
  backend.refresh.mockClear();
  backend.remember.mockClear();
  backend.read.mockReset();
  backend.fetchSession.mockReset();
  backend.fetchSession.mockImplementation(async () => {
    backend.refresh();
    return session();
  });
  backend.live = Atom.make<
    AsyncResult.AsyncResult<Exclude<AuthSessionState["currentSession"], undefined> | null>
  >(AsyncResult.success(session().currentSession ?? null));
  backend.rename.mockReset();
  backend.read.mockImplementation(async () => ({ _tag: "Success", value: session() }));
  backend.rename.mockImplementation(async ({ label }: { label: string }) => {
    backend.label = label.trim();
    appAtomRegistry.set(backend.live, AsyncResult.success(session().currentSession ?? null));
    return { _tag: "Success", value: { current: true, client: { label: backend.label } } };
  });
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <ThisClientSettingsRow environmentId={environmentId} environmentLabel="Test host" />
      </AppAtomRegistryProvider>,
    );
  });
  backend.refresh.mockClear();
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
const click = async (label: string) => {
  const button = renderer.root.findAllByType("button").find((node) => textOf(node) === label)!;
  await act(() => button.props.onClick());
};
const rename = async (label: string) => {
  await click("Rename");
  expect(renderer.root.findByType("input").props.value).toBe("My browser");
  await act(() =>
    renderer.root.findByType("input").props.onChange({ currentTarget: { value: label } }),
  );
  await act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
};
const adminRename = async (label: string) => {
  backend.label = label;
  await act(() =>
    appAtomRegistry.set(backend.live, AsyncResult.success(session().currentSession ?? null)),
  );
};
describe.each(["web", "mobile"] as const)("%s live rename form", (surface) => {
  const openForm = async () => {
    if (surface === "mobile") {
      await act(() =>
        renderer.update(
          <AppAtomRegistryProvider>
            <NativeClientNameButton environmentId={environmentId} environmentLabel="Test host" />
          </AppAtomRegistryProvider>,
        ),
      );
    }
    await click(surface === "web" ? "Rename" : "Rename client");
  };
  it("accepts a fresh server read when a cached live snapshot has not changed", async () => {
    backend.label = "Fresh server name";
    await openForm();
    expect(renderer.root.findByType("input").props.value).toBe("Fresh server name");
  });
  it("updates an untouched form after an external rename", async () => {
    await openForm();
    await adminRename("Remote name");
    expect(renderer.root.findByType("input").props.value).toBe("Remote name");
  });
  it("preserves an edited form when its stored name changes", async () => {
    await openForm();
    await act(() =>
      renderer.root.findByType("input").props.onChange({ currentTarget: { value: "My draft" } }),
    );
    await adminRename("Remote name");
    expect(renderer.root.findByType("input").props.value).toBe("My draft");
    await click("Cancel");
    await click(surface === "web" ? "Rename" : "Rename client");
    expect(renderer.root.findByType("input").props.value).toBe("Remote name");
  });
  it("does not let a delayed initial read undo a newer live label", async () => {
    const oldSession = session();
    let completeRead!: () => void;
    backend.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRead = () => resolve({ _tag: "Success", value: oldSession });
        }),
    );
    await openForm();
    await adminRename("Remote name");
    await act(() => completeRead());
    expect(renderer.root.findByType("input").props.value).toBe("Remote name");
  });
});

describe("admin renaming another client", () => {
  const updateTargetLabel = async (label: string) => {
    await act(() =>
      renderer.update(
        <AppAtomRegistryProvider>
          <ClientNameButton
            environmentId={environmentId}
            environmentLabel="Test host"
            sessionId={AuthSessionId.make("other")}
            initialLabel={label}
            buttonLabel="Rename other client"
          />
        </AppAtomRegistryProvider>,
      ),
    );
  };
  const openForm = async () => {
    backend.rename.mockImplementation(async ({ label }: { label: string }) => ({
      _tag: "Success",
      value: { current: false, client: { label: label.trim() } },
    }));
    await updateTargetLabel("Other browser");
    await click("Rename other client");
  };
  const editDraft = async () => {
    await act(() =>
      renderer.root.findByType("input").props.onChange({ currentTarget: { value: "My draft" } }),
    );
  };
  const save = async () => {
    await act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
  };

  it("follows the target's live label and saves its latest name when untouched", async () => {
    await openForm();
    await adminRename("My own renamed browser");
    expect(renderer.root.findByType("input").props.value).toBe("Other browser");
    await updateTargetLabel("New other-client name");
    expect(renderer.root.findByType("input").props.value).toBe("New other-client name");
    await save();
    expect(backend.rename).toHaveBeenCalledWith({
      environmentId,
      sessionId: "other",
      label: "New other-client name",
    });
    expect(backend.remember).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
  it("preserves an edited draft and shows the target's latest name after cancel", async () => {
    await openForm();
    await editDraft();
    await updateTargetLabel("New other-client name");
    expect(renderer.root.findByType("input").props.value).toBe("My draft");
    await click("Cancel");
    expect(backend.rename).not.toHaveBeenCalled();
    await click("Rename other client");
    expect(renderer.root.findByType("input").props.value).toBe("New other-client name");
  });
  it("saves an edited draft after the target's stored name changes", async () => {
    await openForm();
    await editDraft();
    await updateTargetLabel("New other-client name");
    await save();
    expect(backend.rename).toHaveBeenCalledWith({
      environmentId,
      sessionId: "other",
      label: "My draft",
    });
    expect(backend.remember).not.toHaveBeenCalled();
  });
});

describe("primary client self-renaming", () => {
  it("refreshes the row after renaming through the authorized-client list path", async () => {
    await act(() =>
      renderer.update(
        <AppAtomRegistryProvider>
          <ThisClientSettingsRow environmentId={environmentId} environmentLabel="Test host" />
          <ClientNameButton
            environmentId={environmentId}
            environmentLabel="Test host"
            sessionId={AuthSessionId.make("self")}
            initialLabel="My browser"
            buttonLabel="Access list rename"
          />
        </AppAtomRegistryProvider>,
      ),
    );
    await click("Access list rename");
    await act(() =>
      renderer.root
        .findByType("input")
        .props.onChange({ currentTarget: { value: "Renamed through access list" } }),
    );
    await act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
    expect(backend.rename).toHaveBeenCalledWith({
      environmentId,
      sessionId: "self",
      label: "Renamed through access list",
    });
    expect(backend.refresh).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("Renamed through access list");
    expect(textOf(renderer.root)).not.toContain("My browser");
  });
  it("updates the stored name while Settings stays open", async () => {
    await adminRename("Admin renamed");
    expect(textOf(renderer.root)).toContain("Admin renamed");
    expect(textOf(renderer.root)).not.toContain("My browser");
  });
  it("preserves an edited form across an admin rename and reveals the latest stored name on cancel", async () => {
    await click("Rename");
    await act(() =>
      renderer.root.findByType("input").props.onChange({ currentTarget: { value: "My draft" } }),
    );
    await adminRename("Admin renamed");
    expect(renderer.root.findByType("input").props.value).toBe("My draft");
    await click("Cancel");
    expect(textOf(renderer.root)).toContain("Admin renamed");
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
  it("saves the preserved local draft after an admin rename", async () => {
    await click("Rename");
    await act(() =>
      renderer.root.findByType("input").props.onChange({ currentTarget: { value: "My draft" } }),
    );
    await adminRename("Admin renamed");
    await act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
    expect(textOf(renderer.root)).toContain("My draft");
    expect(textOf(renderer.root)).not.toContain("Admin renamed");
  });
  it("renames a normal paired session and refreshes the displayed stored name", async () => {
    await rename(" My laptop ");
    expect(backend.rename).toHaveBeenCalledWith({ environmentId, label: " My laptop " });
    expect(backend.refresh).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(textOf(renderer.root)).toContain("My laptop");
    expect(textOf(renderer.root)).not.toContain("My browser");
  });
  it("keeps the original name and editable dialog when saving fails", async () => {
    backend.rename.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Connection lost")),
    });
    await rename("New name");
    expect(backend.refresh).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(renderer.root.findByType("input").props.value).toBe("New name");
    expect(textOf(renderer.root)).toContain("My browser");
    expect(textOf(renderer.root)).toContain("Connection lost");
  });
});
