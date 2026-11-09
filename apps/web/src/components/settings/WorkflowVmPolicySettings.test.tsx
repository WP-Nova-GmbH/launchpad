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
    await act(() => input.props.onChange({ target: { value: "0" } }));
    const button = view.root
      .findAllByType("button")
      .find((entry) => entry.props.children === "Save limit")!;
    await act(async () => {
      button.props.onClick();
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
  it("shows members a static value without editable or save controls", async () => {
    const save = vi.fn();
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: async () => ({ record, capabilities, canEdit: false }),
        save,
      }),
    );
    expect(view.root.findAllByType("input")).toHaveLength(0);
    expect(view.root.findAllByType("button")).toHaveLength(0);
    expect(view.root.findAllByType("span").some((entry) => entry.props.children === 10)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps failed save edits and reloads only after explicit action", async () => {
    const read = vi.fn(async () => ({ record, capabilities, canEdit: true }));
    const view = await render(
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read,
        save: async () => {
          throw new Error("Policy changed");
        },
      }),
    );
    await act(() => view.root.findByType("input").props.onChange({ target: { value: "4" } }));
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((entry) => entry.props.children === "Save limit")!
        .props.onClick();
    });
    expect(view.root.findByType("input").props.value).toBe("4");
    expect(visibleText(view.root.findByProps({ role: "alert" }))).toContain("Policy changed");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((entry) => entry.props.children === "Reload limit")!
        .props.onClick();
    });
    expect(view.root.findByType("input").props.value).toBe("10");
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
