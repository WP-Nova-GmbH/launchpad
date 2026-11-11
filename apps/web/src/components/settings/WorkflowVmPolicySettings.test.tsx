import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkflowVmPolicy } from "@t3tools/client-runtime/relay";
import { WorkflowVmPolicyForm } from "./WorkflowVmPolicySettings";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user", getToken: async () => "token" }),
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
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
      {description}
      {control}
    </div>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));

const visibleText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : visibleText(child))).join(" ");

const record = { organizationId: "org", revision: 1, maxRunningVms: 10 };
const capabilities = { configuration: true, execution: false };
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const render = async (
  controller: ReturnType<typeof WorkflowVmPolicy.makeWorkflowVmPolicyController>,
) => {
  await act(async () => {
    renderer = create(<WorkflowVmPolicyForm controller={controller} />);
  });
  return renderer!;
};

describe("workflow VM settings block", () => {
  it("saves the admin's zero limit while execution remains unavailable", async () => {
    const save = vi.fn(async (value: typeof record) => ({ ...value, revision: 2 }));
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: async () => ({ record, capabilities, canEdit: true }),
        save,
      }),
    );
    const input = view.root.findByType("input");
    expect(input.props.value).toBe("10");
    const saveButton = () =>
      view.root.findAllByType("button").find((entry) => entry.props.children === "Save limit")!;
    expect(saveButton().props.disabled).toBe(true);
    await act(() => input.props.onChange({ target: { value: "010" } }));
    expect(saveButton().props.disabled).toBe(true);
    await act(() => input.props.onChange({ target: { value: "1.5" } }));
    expect(saveButton().props.disabled).toBe(true);
    expect(visibleText(view.root)).toContain("Enter a whole number");
    await act(() => input.props.onChange({ target: { value: "0" } }));
    expect(saveButton().props.disabled).toBe(false);
    await act(async () => {
      saveButton().props.onClick();
    });
    expect(save).toHaveBeenCalledWith({ ...record, maxRunningVms: 0 });
    expect(view.root.findByType("input").props.value).toBe("0");
    expect(
      view.root
        .findAllByProps({ role: "status" })
        .some((entry) => entry.props.children === "Limit saved."),
    ).toBe(true);
    expect(
      view.root
        .findAllByType("p")
        .some((entry) => entry.props.children === "VM workflow execution is not available yet."),
    ).toBe(true);
  });
  it.each([0, 10])("shows members a read-only limit of %i", async (maxRunningVms) => {
    const save = vi.fn();
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: async () => ({ record: { ...record, maxRunningVms }, capabilities, canEdit: false }),
        save,
      }),
    );
    expect(view.root.findAllByType("input")).toHaveLength(0);
    expect(view.root.findAllByType("button")).toHaveLength(0);
    const text = visibleText(view.root).replace(/\s+/gu, " ");
    expect(text).toContain(`${maxRunningVms} VMs`);
    expect(text).toContain("An organization admin can change this limit.");
    expect(text.includes("Workflow VMs can’t start or resume while the limit is 0.")).toBe(
      maxRunningVms === 0,
    );
    expect(save).not.toHaveBeenCalled();
  });
  it("shows loading until the relay reports unsupported configuration", async () => {
    type Unsupported = { record: null; capabilities: typeof capabilities; canEdit: boolean };
    let resolve!: (value: Unsupported) => void;
    const result = new Promise<Unsupported>((accept) => {
      resolve = accept;
    });
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: () => result,
        save: vi.fn(),
      }),
    );
    expect(visibleText(view.root)).toContain("Loading workflow VM limit…");
    expect(visibleText(view.root)).not.toContain("unavailable");
    await act(async () => {
      resolve({
        record: null,
        capabilities: { ...capabilities, configuration: false },
        canEdit: false,
      });
    });
    expect(visibleText(view.root)).toContain("Workflow VM settings unavailable");
    expect(view.root.findAllByType("button")).toHaveLength(0);
  });
  it("shows the unsaved limit when conflict recovery fails and loads the fresh limit on retry", async () => {
    const read = vi
      .fn(async () => ({ record, capabilities, canEdit: true }))
      .mockResolvedValueOnce({ record, capabilities, canEdit: true })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({
        record: { ...record, revision: 2, maxRunningVms: 12 },
        capabilities,
        canEdit: true,
      });
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read,
        save: async () => {
          throw new Error("Policy changed");
        },
      }),
    );
    await act(() => view.root.findByType("input").props.onChange({ target: { value: "0" } }));
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((entry) => entry.props.children === "Save limit")!
        .props.onClick();
    });
    expect(view.root.findByType("input").props.value).toBe("0");
    expect(visibleText(view.root.findByProps({ role: "alert" }))).toContain("Policy changed");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((entry) => entry.props.children === "Reload limit")!
        .props.onClick();
    });
    const failure = visibleText(view.root.findByProps({ role: "alert" }));
    expect(failure).toContain("Offline");
    expect(failure).toMatch(/Unsaved limit:\s+0/u);
    expect(view.root.findAllByType("input")).toHaveLength(0);
    const [retry] = view.root.findAllByType("button");
    expect(visibleText(retry!).trim()).toBe("Retry");
    expect(view.root.findAllByType("button")).toHaveLength(1);
    await act(async () => retry!.props.onClick());
    expect(view.root.findByType("input").props.value).toBe("12");
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it("ignores the old controller when the organization scope changes", async () => {
    type Loaded = {
      record: typeof record;
      capabilities: typeof capabilities;
      canEdit: boolean;
    };
    let resolve!: (value: Loaded) => void;
    const promise = new Promise<Loaded>((accept) => {
      resolve = accept;
    });
    const old = WorkflowVmPolicy.makeWorkflowVmPolicyController({
      read: () => promise,
      save: vi.fn(),
    });
    const view = await render(old);
    const current = WorkflowVmPolicy.makeWorkflowVmPolicyController({
      read: async () => ({
        record: { ...record, organizationId: "new-org", maxRunningVms: 3 },
        capabilities,
        canEdit: true,
      }),
      save: vi.fn(),
    });
    await act(async () => {
      view.update(<WorkflowVmPolicyForm controller={current} />);
    });
    await act(async () => {
      resolve({ record, capabilities, canEdit: true });
    });
    expect(view.root.findByType("input").props.value).toBe("3");
  });
});
