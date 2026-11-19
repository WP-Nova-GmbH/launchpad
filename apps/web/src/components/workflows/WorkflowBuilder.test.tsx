vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) =>
    createElement("button", {
      ...props,
      role: "checkbox",
      checked,
      onClick: () => onCheckedChange(!checked),
    }),
}));
vi.mock("../../cloud/workflowSources", () => ({
  useWorkflowSources: () => ({ snapshot: null, loading: false, refresh: vi.fn() }),
}));
vi.mock("./WorkflowSources", () => ({
  RepositorySourcesPanel: () => null,
  RepositorySourcesButton: () => null,
}));
vi.mock("./WorkflowEditorDepartureGuard", () => ({ WorkflowEditorDepartureGuard: () => null }));
import {
  act,
  cloneElement,
  createContext,
  createElement,
  useContext,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  RelayMachineId,
  RelayRepositoryId,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import { WorkflowConflictError, type RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { ManagedRelay, type ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  workflowSessionKey,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  startNewWorkflowDraft,
  workflowEditorDirty,
  workflowDraftAutomationResolved,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const { navigate, confirmation, modelIssues } = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirmation: vi.fn<() => Promise<boolean>>(),
  modelIssues: vi.fn<() => ReadonlyArray<{ stepId: string; title: string; detail: string }>>(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirmation }));
vi.mock("./WorkflowCanvas", async () => ({
  ...(await vi.importActual("./WorkflowCanvas")),
  WorkflowCanvas: (props: Record<string, unknown>) =>
    createElement(
      "div",
      { ...props, "data-testid": "canvas-fixture" },
      createElement("button", {
        "aria-label": "Configure workflow trigger",
        onClick: props.onTrigger,
      }),
    ),
}));
vi.mock("./WorkflowStepEditor", () => ({
  WorkflowStepEditor: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-testid": "step-fixture" }),
  useWorkflowEditorModels: () => ({ issues: modelIssues() }),
}));
vi.mock("../ui/alert-dialog", () => {
  const part = ({ children }: PropsWithChildren) => children;
  return {
    AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? createElement("section", { role: "alertdialog" }, children) : null,
    AlertDialogPopup: part,
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: part,
  };
});
vi.mock("../ui/sheet", () => ({
  Sheet: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? children : null),
  SheetPopup: ({ children }: PropsWithChildren) =>
    createElement("section", { role: "dialog" }, children),
  SheetTitle: ({ children }: PropsWithChildren) => children,
  SheetHeader: ({ children }: PropsWithChildren) => children,
  SheetDescription: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ children, render }: PropsWithChildren<{ render?: ReactElement }>) =>
    render ? cloneElement(render, undefined, children) : children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("../ui/combobox", () => {
  type CheckoutPicker = {
    items: ReadonlyArray<RelayOrganizationProject>;
    value: RelayOrganizationProject | null;
    inputValue: string;
    onInputValueChange: (value: string, details: { reason: "input-change" }) => void;
    onValueChange: (value: RelayOrganizationProject) => void;
  };
  const PickerContext = createContext<CheckoutPicker | null>(null);
  const component = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Combobox: ({ children, ...state }: PropsWithChildren<CheckoutPicker>) =>
      createElement(
        PickerContext.Provider,
        { value: state },
        createElement("div", { "data-checkout-picker": true }, children),
      ),
    ComboboxTrigger: ({
      children,
      render: _render,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) =>
      createElement("button", { role: "combobox", ...props }, children),
    ComboboxPopup: component,
    ComboboxList: ({
      children,
    }: {
      children: ReactNode | ((project: RelayOrganizationProject) => ReactNode);
    }) => {
      const picker = useContext(PickerContext)!;
      return typeof children === "function" ? picker.items.map(children) : children;
    },
    ComboboxItem: ({ children, value }: PropsWithChildren<{ value: RelayOrganizationProject }>) => {
      const picker = useContext(PickerContext)!;
      return createElement(
        "button",
        {
          role: "option",
          "aria-selected":
            picker.value?.environmentId === value.environmentId &&
            picker.value?.projectId === value.projectId,
          onClick: () => picker.onValueChange(value),
        },
        children,
      );
    },
    ComboboxSearchInput: (props: Record<string, unknown>) => {
      const picker = useContext(PickerContext)!;
      return createElement("input", {
        ...props,
        value: picker.inputValue,
        onChange: (event: { target: { value: string } }) =>
          picker.onInputValueChange(event.target.value, { reason: "input-change" }),
      });
    },
    ComboboxEmpty: ({ children }: PropsWithChildren) => {
      const picker = useContext(PickerContext)!;
      return picker.items.length === 0 ? createElement("div", { role: "status" }, children) : null;
    },
  };
});
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children, ...props }: PropsWithChildren) =>
    createElement("div", { ...props, "data-workflow-target": true }, children),
  RadioGroupItem: (props: Record<string, unknown>) =>
    createElement("span", { ...props, "data-workflow-target-option": true }),
}));

import { WorkflowBuilder } from "./WorkflowBuilder";
import {
  editWorkflowDraft,
  selectWorkflowStep,
  newWorkflowDraft,
  copiedWorkflowDraft,
  openNewWorkflowDraft,
} from "./workflowState";

type Props = Parameters<typeof WorkflowBuilder>[0];
const scope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const project: RelayOrganizationProject = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  machineId: RelayMachineId.make("machine"),
  machineLabel: "Machine",
  title: "Project",
  repositoryCanonicalKey: null,
  createdAt: "now",
  updatedAt: "now",
  catalogUpdatedAt: "now",
};
const read = vi.fn<() => Promise<unknown>>();
const call: Props["call"] = async <A,>() => (await read()) as A;
const refresh = vi.fn();
const base: Props = {
  scope,
  repositoryName: "Repository",
  isNew: true,
  workflow: undefined,
  projects: [project],
  canConfigure: true,
  call,
  refresh,
  refreshProjects: () => {},
};
const slot = workflowSessionKey(scope, "new");
let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const editor = (id: string) =>
  appAtomRegistry.get(workflowDraftAtom).editors[workflowSessionKey(scope, id)]!;
const newId = () => appAtomRegistry.get(workflowDraftAtom).newWorkflowIds[slot]!;
const saved = (
  id: string,
  revision = 1,
  definition = editor(id).definition,
): RepositoryWorkflow => ({
  workflowId: id,
  repositoryId: scope.repositoryId,
  organizationId: scope.organizationId,
  archived: false,
  revision,
  definition,
  createdAt: "now",
  updatedAt: "now",
});
async function mount(props: Props = base) {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowBuilder {...props} />
      </AppAtomRegistryProvider>,
      {
        createNodeMock: (element) =>
          element.type === "form" ? { querySelector: () => null } : null,
      },
    );
  });
}
async function unmount() {
  await act(() => renderer?.unmount());
  renderer = undefined;
}
async function submit() {
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
}
const editorDialog = () => renderer!.root.findByProps({ role: "alertdialog" });
const button = (label: string, root = renderer!.root) =>
  root.findAllByType("button").find((node) => {
    const text = node.children
      .filter((child) => typeof child === "string")
      .join("")
      .trim();
    return text === label;
  });
async function click(label: string, root = renderer!.root) {
  await act(async () => {
    button(label, root)!.props.onClick();
  });
}
async function rename(name: string) {
  await act(() =>
    renderer!.root.findByProps({ "aria-label": "Workflow name" }).props.onChange({
      target: { value: name },
    }),
  );
}
async function conflict(id: string) {
  await act(() =>
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: {
        ...state.editors,
        [workflowSessionKey(scope, id)]: { ...editor(id), error: "Conflict" },
      },
    })),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 400 } }]);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "HTMLElement",
    class {
      focus() {}
    },
  );
  navigate.mockReset();
  confirmation.mockReset().mockResolvedValue(true);
  read.mockReset();
  modelIssues.mockReset().mockReturnValue([]);
  refresh.mockReset();
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

describe("Create route identity", () => {
  it("returns to the same saved editor after remounting during Create", async () => {
    const reply = deferred<RepositoryWorkflow>();
    read.mockReturnValue(reply.promise);
    await mount();
    const id = newId();
    const result = saved(id);
    await submit();
    await unmount();
    await mount();
    expect(newId()).toBe(id);
    expect(editor(id).operation?.state).toBe("pending");
    await act(async () => {
      reply.resolve(result);
      await reply.promise;
    });
    expect(newId()).toBe(id);
    expect(Object.keys(appAtomRegistry.get(workflowDraftAtom).editors)).toHaveLength(1);
    expect(editor(id).baseline).toEqual(result);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: { repositoryId: scope.repositoryId, workflowId: id },
        replace: true,
      }),
    );
  });
  it("shares the pending editor when the server record appears before the Create reply", async () => {
    const reply = deferred<RepositoryWorkflow>();
    read.mockReturnValue(reply.promise);
    await mount();
    const id = newId();
    const result = saved(id);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflowId: id, workflow: result });
    await rename("Cannot edit a pending Create");
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(editor(id).definition).toEqual(result.definition);
    expect(Object.keys(appAtomRegistry.get(workflowDraftAtom).editors)).toHaveLength(1);
    await act(async () => {
      reply.resolve(result);
      await reply.promise;
    });
    expect(editor(id).baseline).toEqual(result);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps an acknowledged Create while elsewhere and resolves it on later return", async () => {
    const reply = deferred<RepositoryWorkflow>();
    read.mockReturnValue(reply.promise);
    await mount();
    const id = newId();
    const result = saved(id);
    await submit();
    await unmount();
    await act(async () => {
      reply.resolve(result);
      await reply.promise;
    });
    expect(navigate).not.toHaveBeenCalled();
    await mount();
    expect(newId()).toBe(id);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { repositoryId: scope.repositoryId, workflowId: id } }),
    );
  });
  it("reconciles an uncertain Create without losing edits shared by both routes", async () => {
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await mount();
    const id = newId();
    const result = saved(id);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflowId: id, workflow: result });
    await rename("Later edits");
    await unmount();
    await mount();
    expect(editor(id).definition.name).toBe("Later edits");
    read.mockResolvedValueOnce({ workflows: [result] });
    await click("Check saved version");
    expect(editor(id).definition.name).toBe("Later edits");
    expect(editor(id).baseline).toEqual(result);
    expect(editor(id).operation).toBeNull();
    expect(Object.keys(appAtomRegistry.get(workflowDraftAtom).editors)).toHaveLength(1);
  });
  it("reconciles the captured Save before submitting newer edits", async () => {
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await mount();
    const id = newId();
    const old = saved(id);
    await submit();
    await rename("Newer save");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Save not confirmed");
    expect(button("Retry save")).toBeUndefined();
    expect(button("Retry original save")).toBeUndefined();
    read.mockResolvedValueOnce({ workflows: [old] });
    await click("Check saved version");
    expect(editor(id).baseline).toEqual(old);
    expect(editor(id).definition.name).toBe("Newer save");
    expect(editor(id).operation).toBeNull();
    const next = saved(id, 2);
    read.mockResolvedValueOnce(next);
    await submit();
    expect(editor(id).baseline).toEqual(next);
  });
  it("preserves a saved editor when explicitly allocating the next new workflow", async () => {
    await mount();
    const id = newId();
    read.mockResolvedValueOnce(saved(id));
    await submit();
    await rename("Unsaved later edit");
    await act(() =>
      startNewWorkflowDraft(appAtomRegistry, scope, () => newWorkflowDraft([project]), true),
    );
    expect(newId()).not.toBe(id);
    expect(editor(id).definition.name).toBe("Unsaved later edit");
    expect(editor(newId()).baseline).toBeNull();
  });
});

describe("Save recovery after a lost reply", () => {
  it.each(["unchanged", "changed"] as const)(
    "offers the recovery action appropriate to a %s saved revision",
    async (revision) => {
      const workflow = saved("flow", 4, newWorkflowDraft([project])!.definition);
      await mount({ ...base, isNew: false, workflow });
      await rename("Local edits");
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await submit();
      expect(button("Check saved version")).toBeDefined();
      expect(button("Retry original save")).toBeUndefined();

      const observed =
        revision === "unchanged"
          ? workflow
          : {
              ...workflow,
              revision: 5,
              definition: { ...workflow.definition, name: "Changes from another editor" },
            };
      const beforeCheck = read.mock.calls.length;
      read.mockResolvedValueOnce({ workflows: [observed] });
      await click("Check saved version");
      expect(read).toHaveBeenCalledTimes(beforeCheck + 1);
      expect(editor(workflow.workflowId).definition.name).toBe("Local edits");
      expect(editor(workflow.workflowId).baseline).toEqual(workflow);

      const content = JSON.stringify(renderer!.toJSON());
      if (revision === "unchanged") {
        expect(content).toContain("Save didn’t land");
        expect(button("Retry original save")).toBeDefined();
        return;
      }

      expect(content).toContain("Saved version changed");
      expect(button("Retry original save")).toBeUndefined();
      await submit();
      expect(read).toHaveBeenCalledTimes(beforeCheck + 1);

      await click("Keep editing");
      expect(editor(workflow.workflowId).definition.name).toBe("Local edits");
      expect(button("Retry original save")).toBeUndefined();

      confirmation.mockResolvedValueOnce(false);
      await click("Reload saved version");
      expect(confirmation).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(beforeCheck + 1);
      expect(editor(workflow.workflowId).definition.name).toBe("Local edits");

      read.mockResolvedValueOnce({ workflows: [observed] });
      await click("Reload saved version");
      expect(editor(workflow.workflowId).baseline).toEqual(observed);
      expect(editor(workflow.workflowId).definition).toEqual(observed.definition);
      expect(editor(workflow.workflowId).operation).toBeNull();
    },
  );
});

describe("Reload buffer and view ownership", () => {
  async function openSaved() {
    await mount();
    const id = newId();
    const baseline = saved(id);
    read.mockResolvedValueOnce(baseline);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflow: baseline, workflowId: id });
    await conflict(id);
    return { id, baseline, props: { ...base, isNew: false, workflow: baseline, workflowId: id } };
  }
  it("keeps text edited during Reload", async () => {
    const { id, baseline } = await openSaved();
    const reply = deferred<{ workflows: RepositoryWorkflow[] }>();
    read.mockReturnValueOnce(reply.promise);
    await click("Reload saved version");
    await rename("Typed after confirmation");
    await act(async () => {
      reply.resolve({ workflows: [baseline] });
      await reply.promise;
    });
    expect(editor(id).definition.name).toBe("Typed after confirmation");
    expect(
      renderer!.root
        .findAllByProps({ role: "status" })
        .some((node) => String(node.props.children).includes("edits were kept")),
    ).toBe(true);
  });
  it("adopts Reload for an unchanged current buffer", async () => {
    const { id, baseline } = await openSaved();
    const next = {
      ...baseline,
      revision: 2,
      definition: { ...baseline.definition, name: "Updated remotely" },
    };
    read.mockResolvedValueOnce({ workflows: [next] });
    await click("Reload saved version");
    expect(editor(id).baseline).toEqual(next);
    expect(editor(id).definition).toEqual(next.definition);
  });
  it.each(["old-first", "new-first"])("rejects a previous mount's Reload (%s)", async (order) => {
    const { id, baseline, props } = await openSaved();
    const first = deferred<{ workflows: RepositoryWorkflow[] }>();
    const second = deferred<{ workflows: RepositoryWorkflow[] }>();
    read.mockReturnValueOnce(first.promise);
    await click("Reload saved version");
    await unmount();
    await mount(props);
    read.mockReturnValueOnce(second.promise);
    await click("Reload saved version");
    const old = {
      ...baseline,
      revision: 2,
      definition: { ...baseline.definition, name: "Old snapshot" },
    };
    const latest = {
      ...baseline,
      revision: 3,
      definition: { ...baseline.definition, name: "Latest snapshot" },
    };
    const resolveFirst = () =>
      act(async () => {
        first.resolve({ workflows: [old] });
        await first.promise;
      });
    const resolveSecond = () =>
      act(async () => {
        second.resolve({ workflows: [latest] });
        await second.promise;
      });
    if (order === "old-first") {
      await resolveFirst();
      expect(editor(id).baseline).toEqual(baseline);
      await resolveSecond();
    } else {
      await resolveSecond();
      await resolveFirst();
    }
    expect(editor(id).baseline).toEqual(latest);
    expect(editor(id).definition.name).toBe("Latest snapshot");
  });
  it("does not adopt a Reload after leaving without requesting another", async () => {
    const { id, baseline } = await openSaved();
    const reply = deferred<{ workflows: RepositoryWorkflow[] }>();
    read.mockReturnValueOnce(reply.promise);
    await click("Reload saved version");
    await unmount();
    await act(async () => {
      reply.resolve({ workflows: [{ ...baseline, revision: 2 }] });
      await reply.promise;
    });
    expect(editor(id).baseline).toEqual(baseline);
  });
  it("rejects a confirmation after replacing its buffer", async () => {
    const { id } = await openSaved();
    const answer = deferred<boolean>();
    confirmation.mockReturnValueOnce(answer.promise);
    const count = read.mock.calls.length;
    await click("Reload saved version");
    await rename("Replacement text");
    await act(async () => {
      answer.resolve(true);
      await answer.promise;
    });
    expect(read).toHaveBeenCalledTimes(count);
    expect(editor(id).definition.name).toBe("Replacement text");
  });
  it("does not start a confirmed Reload after changing editor parameters", async () => {
    const { id, baseline } = await openSaved();
    const answer = deferred<boolean>();
    confirmation.mockReturnValueOnce(answer.promise);
    const count = read.mock.calls.length;
    await click("Reload saved version");
    const other = { ...baseline, workflowId: "other" };
    await act(() =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <WorkflowBuilder {...base} isNew={false} workflowId="other" workflow={other} />
        </AppAtomRegistryProvider>,
      ),
    );
    await act(async () => {
      answer.resolve(true);
      await answer.promise;
    });
    expect(read).toHaveBeenCalledTimes(count);
    expect(editor(id).error).toBe("Conflict");
    expect(editor("other").baseline).toEqual(other);
  });
  it("deduplicates Reload during confirmation and request delivery", async () => {
    await openSaved();
    const answer = deferred<boolean>();
    confirmation.mockReturnValueOnce(answer.promise);
    const reply = deferred<{ workflows: RepositoryWorkflow[] }>();
    read.mockReturnValueOnce(reply.promise);
    const count = read.mock.calls.length;
    await click("Reload saved version");
    await click("Reload saved version");
    expect(confirmation).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve(true);
      await answer.promise;
    });
    await click("Reload saved version");
    expect(read).toHaveBeenCalledTimes(count + 1);
    await act(async () => {
      reply.reject(new Error("Offline"));
      try {
        await reply.promise;
      } catch {}
    });
  });
});

describe("Discard workflow changes", () => {
  it("keeps editing or resets a saved workflow in place", async () => {
    const workflow = saved("discard-saved", 1, newWorkflowDraft([project])!.definition);
    await mount({ ...base, workflow, isNew: false, openExecutionSettings: true });
    await rename("Unsaved edits");
    const draft = editor(workflow.workflowId);

    await click("Discard changes");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Discard unsaved edits?");
    expect(editor(workflow.workflowId)).toBe(draft);
    await click("Keep editing", editorDialog());
    expect(editor(workflow.workflowId)).toBe(draft);

    await click("Discard changes");
    await click("Discard edits", editorDialog());
    expect(editor(workflow.workflowId).definition).toEqual(workflow.definition);
    expect(workflowEditorDirty(editor(workflow.workflowId))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("removes a never-saved draft and returns to Workflows after confirmation", async () => {
    await mount({ ...base, openExecutionSettings: true });
    await rename("New release draft");
    const id = newId();

    await click("Discard changes");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Discard draft?");
    expect(newId()).toBe(id);
    expect(navigate).not.toHaveBeenCalled();
    await click("Discard draft", editorDialog());

    expect(editor(id)).toBeUndefined();
    expect(newId()).toBeUndefined();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: "workflows" },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "retained trigger",
    "retained step",
    "new edit",
    "failed read",
    "failed read in another inspector",
  ] as const)(
    "handles a confirmed reload after closing Workflow settings (%s)",
    async (scenario) => {
      const workflow = saved("discard-close-settings", 1, newWorkflowDraft([project])!.definition);
      const props = { ...base, workflow, isNew: false };
      await mount(props);
      await rename("Unsaved edits to discard");
      if (scenario === "retained trigger" || scenario === "retained step") {
        const canvas = renderer!.root.findByProps({ "data-testid": "canvas-fixture" });
        await act(() => {
          if (scenario === "retained trigger") canvas.props.onTrigger();
          else canvas.props.onSelect("review");
        });
      }
      await unmount();
      const newer = {
        ...workflow,
        revision: 2,
        definition: { ...workflow.definition, name: "New saved workflow" },
      };
      await mount({ ...props, workflow: newer, openExecutionSettings: true });
      if (scenario === "retained trigger")
        expect(editor(workflow.workflowId).triggerSetup).toBe(true);
      if (scenario === "retained step")
        expect(editor(workflow.workflowId).selectedStepId).toBe("review");
      const reply = deferred<{ workflows: RepositoryWorkflow[] }>();
      read.mockReturnValueOnce(reply.promise);
      await click("Discard changes");
      await click("Discard edits and reload", editorDialog());

      const settings = renderer!.root.findByProps({ role: "dialog" });
      const discardProps = button("Discard changes", settings)!.props;
      expect(discardProps["aria-disabled"]).toBe(true);
      expect(discardProps.disabled).toBeFalsy();
      expect(
        settings.findByProps({ id: discardProps["aria-describedby"], role: "status" }).children,
      ).toContain("Reloading saved version…");
      await act(() => settings.findByProps({ "aria-label": "Close settings" }).props.onClick());
      expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

      if (scenario === "new edit") await rename("Typed after confirmation");
      if (scenario === "failed read in another inspector") {
        const canvas = renderer!.root.findByProps({ "data-testid": "canvas-fixture" });
        await act(() => canvas.props.onSelect("review"));
      }
      const readFails =
        scenario === "failed read" || scenario === "failed read in another inspector";
      await act(async () => {
        if (readFails) reply.reject(new Error("Catalog unavailable"));
        else reply.resolve({ workflows: [newer] });
        await reply.promise.catch(() => {});
      });

      const draft = editor(workflow.workflowId);
      if (scenario === "new edit" || readFails) {
        expect(draft.baseline).toEqual(workflow);
        expect(draft.definition.name).toBe(
          scenario === "new edit" ? "Typed after confirmation" : "Unsaved edits to discard",
        );
        const feedback =
          scenario === "new edit"
            ? "Your draft changed during reload. Your current edits are kept."
            : "Could not reload the saved version. Your draft is kept.";
        const surface =
          scenario === "failed read in another inspector"
            ? renderer!.root.findByProps({ role: "dialog" })
            : renderer!.root;
        expect(
          surface
            .findAllByProps({ role: "alert" })
            .some((node) => node.children.includes(feedback)),
        ).toBe(true);
        await click("Open workflow settings", surface);
        expect(
          button("Retry reload", renderer!.root.findByProps({ role: "dialog" })),
        ).toBeDefined();
        expect(read).toHaveBeenCalledOnce();
        return;
      }

      expect(draft.baseline).toEqual(newer);
      expect(draft.definition).toEqual(newer.definition);
      expect(workflowEditorDirty(draft)).toBe(false);
    },
  );

  it.each(["failed", "older", "superseded"] as const)(
    "keeps the draft after a %s reload and adopts an up-to-date saved version on retry",
    async (outcome) => {
      const workflow = saved("discard-stale", 1, newWorkflowDraft([project])!.definition);
      const props = { ...base, workflow, isNew: false, openExecutionSettings: true };
      await mount(props);
      await rename("Unsaved edits to preserve");
      const newer = {
        ...workflow,
        revision: 2,
        definition: { ...workflow.definition, name: "New saved workflow" },
      };

      await click("Discard changes");
      expect(button("Discard edits", editorDialog())).toBeDefined();
      await act(() =>
        renderer!.update(
          <AppAtomRegistryProvider>
            <WorkflowBuilder {...props} workflow={newer} />
          </AppAtomRegistryProvider>,
        ),
      );
      expect(JSON.stringify(renderer!.toJSON())).toContain("Newer saved version available");
      expect(button("Discard edits", editorDialog())?.props.disabled ?? true).toBe(true);
      expect(read).not.toHaveBeenCalled();
      const latest = outcome === "superseded" ? { ...newer, revision: 3 } : newer;
      if (outcome === "superseded") {
        const reply = deferred<{ workflows: RepositoryWorkflow[] }>();
        read.mockReturnValueOnce(reply.promise);
        await click("Discard edits and reload", editorDialog());
        await act(() =>
          renderer!.update(
            <AppAtomRegistryProvider>
              <WorkflowBuilder {...props} workflow={latest} />
            </AppAtomRegistryProvider>,
          ),
        );
        await act(async () => {
          reply.resolve({ workflows: [newer] });
          await reply.promise;
        });
      } else {
        if (outcome === "failed") read.mockRejectedValueOnce(new Error("Catalog unavailable"));
        else read.mockResolvedValueOnce({ workflows: [workflow] });
        await click("Discard edits and reload", editorDialog());
      }

      expect(editor(workflow.workflowId).definition.name).toBe("Unsaved edits to preserve");
      expect(editor(workflow.workflowId).baseline).toEqual(workflow);
      expect(read).toHaveBeenCalledOnce();
      expect(confirmation).not.toHaveBeenCalled();

      if (outcome === "failed") {
        await act(() =>
          renderer!.update(
            <AppAtomRegistryProvider>
              <WorkflowBuilder {...props} workflow={undefined} workflowId={workflow.workflowId} />
            </AppAtomRegistryProvider>,
          ),
        );
      }
      const settings = renderer!.root.findByProps({ role: "dialog" });
      expect(
        settings.findAll((node) =>
          node.children.includes("Could not reload the saved version. Your draft is kept."),
        ),
      ).not.toHaveLength(0);
      await click("Retry reload", settings);
      expect(read).toHaveBeenCalledOnce();
      read.mockResolvedValueOnce({ workflows: [latest] });
      await click("Discard edits and reload", editorDialog());
      expect(editor(workflow.workflowId).baseline).toEqual(latest);
      expect(editor(workflow.workflowId).definition).toEqual(latest.definition);
      expect(read).toHaveBeenCalledTimes(2);
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});

describe("Canvas editor state", () => {
  const canvas = () => renderer!.root.findByProps({ "data-testid": "canvas-fixture" });
  it("starts in overview and retains explicit inspection across navigation", async () => {
    await mount();
    const id = newId();
    expect(editor(id).selectedStepId).toBe("");
    await act(() => canvas().props.onSelect("review"));
    await unmount();
    await mount();
    expect(editor(id).selectedStepId).toBe("review");
    await act(() => canvas().props.onOverview());
    expect(editor(id).selectedStepId).toBe("");
  });
  it("allows inspection during Save without unlocking definition edits or losing its receipt", async () => {
    const reply = deferred<RepositoryWorkflow>();
    read.mockReturnValue(reply.promise);
    await mount();
    const id = newId();
    const result = saved(id);
    await submit();
    const operation = editor(id).operation;
    await act(() => canvas().props.onSelect("review"));
    await rename("Blocked edit");
    await act(() => canvas().props.onInsert({ edge: "end" }, "input"));
    expect(editor(id).operation).toBe(operation);
    expect(editor(id).definition).toEqual(result.definition);
    expect(editor(id).selectedStepId).toBe("review");
    await act(() => canvas().props.onOverview());
    expect(editor(id).operation).toBe(operation);
    await act(async () => {
      reply.resolve(result);
      await reply.promise;
    });
    expect(editor(id).baseline).toEqual(result);
    expect(editor(id).selectedStepId).toBe("");
  });
  it("inserts using current anchors, selects the new ID, and refuses a removed anchor", async () => {
    await mount();
    const id = newId();
    const initial = editor(id).definition.steps;
    await act(() => canvas().props.onInsert({ after: initial[0] }, "input"));
    const inserted = editor(id).definition.steps[1]!;
    expect(inserted.kind).toBe("input");
    expect(editor(id).selectedStepId).toBe(inserted.id);
    expect(editor(id).definition.steps.map((step) => step.id)).toEqual([
      initial[0]!.id,
      inserted.id,
      initial[1]!.id,
    ]);
    await act(() =>
      editWorkflowDraft(scope, id, (draft) => ({
        ...draft,
        definition: { ...draft.definition, steps: draft.definition.steps.slice(1) },
      })),
    );
    const before = editor(id).definition;
    await act(() => canvas().props.onInsert({ after: initial[0] }, "agent"));
    expect(editor(id).definition).toBe(before);
  });
  it("enforces the step limit at mutation time", async () => {
    await mount();
    const id = newId();
    await act(() =>
      editWorkflowDraft(scope, id, (draft) => ({
        ...draft,
        definition: {
          ...draft.definition,
          steps: Array.from({ length: 32 }, (_, i) => ({
            ...draft.definition.steps[0]!,
            id: `step-${i}`,
          })),
        },
      })),
    );
    const before = editor(id).definition;
    await act(() => canvas().props.onInsert({ edge: "start" }, "input"));
    expect(editor(id).definition).toBe(before);
  });
  it("Save from overview reveals an invalid unmounted step without sending a write", async () => {
    await mount();
    const id = newId();
    await act(() =>
      editWorkflowDraft(scope, id, (draft) => ({
        ...draft,
        definition: {
          ...draft.definition,
          steps: [
            ...draft.definition.steps,
            { id: "empty-input", kind: "input", title: "Question", question: "", role: "member" },
          ],
        },
      })),
    );
    await submit();
    expect(read).not.toHaveBeenCalled();
    expect(editor(id).selectedStepId).toBe("empty-input");
    expect(editor(id).error).toBeNull();
    expect(renderer!.root.findAllByProps({ title: "Add a question" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "step-fixture" }).props.selectedId).toBe(
      "empty-input",
    );
  });
  it("ignores invalid and cross-account selections", async () => {
    await mount();
    const id = newId();
    const before = editor(id);
    await act(() => selectWorkflowStep(scope, id, "missing"));
    expect(editor(id)).toBe(before);
    await act(() => selectWorkflowStep({ ...scope, accountId: "other" }, id, "review"));
    expect(editor(id)).toBe(before);
  });
  it("dirty-editor Run uses the saved workflow ID and sends no Save", async () => {
    await mount();
    const id = newId();
    const baseline = saved(id);
    read.mockResolvedValueOnce(baseline);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflow: baseline, workflowId: id });
    await rename("Unsaved draft name");
    const count = read.mock.calls.length;
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((node) => node.props.children?.[1] === "Run")!
        .props.onClick(),
    );
    expect(read).toHaveBeenCalledTimes(count);
    expect(editor(id).definition.name).toBe("Unsaved draft name");
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "/workflows/$repositoryId/$workflowId/run",
        params: { repositoryId: scope.repositoryId, workflowId: id },
      }),
    );
  });
});

describe("Reloaded canvas selection", () => {
  it("returns to overview when the selected step is absent in the reloaded definition", async () => {
    await mount();
    const id = newId();
    const baseline = saved(id);
    read.mockResolvedValueOnce(baseline);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflow: baseline, workflowId: id });
    await act(() => selectWorkflowStep(scope, id, "review"));
    await conflict(id);
    const next = {
      ...baseline,
      revision: 2,
      definition: { ...baseline.definition, steps: [baseline.definition.steps[0]!] },
    };
    read.mockResolvedValueOnce({ workflows: [next] });
    await click("Reload saved version");
    expect(editor(id).definition).toEqual(next.definition);
    expect(editor(id).selectedStepId).toBe("");
  });
});

describe("Editor Run archive eligibility", () => {
  const run = async () =>
    act(() =>
      renderer!.root
        .findAllByType("button")
        .find((node) => node.props.children?.[1] === "Run")!
        .props.onClick(),
    );
  it("blocks Run when Refresh reports a newer archived version while retaining edits", async () => {
    await mount();
    const id = newId();
    const baseline = saved(id);
    read.mockResolvedValueOnce(baseline);
    await submit();
    await unmount();
    await mount({ ...base, isNew: false, workflow: baseline, workflowId: id });
    await rename("Retained changes");
    await act(() =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <WorkflowBuilder
            {...base}
            isNew={false}
            workflowId={id}
            workflow={{ ...baseline, revision: 2, archived: true }}
          />
        </AppAtomRegistryProvider>,
      ),
    );
    navigate.mockClear();
    const count = read.mock.calls.length;
    await run();
    expect(navigate).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(count);
    expect(editor(id).definition.name).toBe("Retained changes");
  });
  it("allows Run after a newer Restore receipt despite an older archived list snapshot", async () => {
    await mount();
    const id = newId();
    const restored = saved(id);
    read.mockResolvedValueOnce(restored);
    await submit();
    await unmount();
    await mount({
      ...base,
      isNew: false,
      workflowId: id,
      workflow: { ...restored, revision: 0, archived: true },
    });
    navigate.mockClear();
    await run();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: "/workflows/$repositoryId/$workflowId/run",
        params: { repositoryId: scope.repositoryId, workflowId: id },
      }),
    );
  });
});

describe("workflow templates and copies", () => {
  it("requires a target for the review template when both kinds are available", () => {
    expect(newWorkflowDraft([project], "review", true)?.targetConfirmed).toBe(false);
    expect(newWorkflowDraft([], "review", true)).toMatchObject({
      definition: { target: { kind: "vm", baseBranch: null } },
      targetConfirmed: true,
    });
  });

  it("offers publishing templates on VM and asks when both targets are available", () => {
    expect(newWorkflowDraft([project], "publish", true)).toMatchObject({
      definition: { target: { kind: "vm", baseBranch: null } },
      targetConfirmed: false,
    });
    expect(newWorkflowDraft([], "publish", true)).toMatchObject({
      definition: { target: { kind: "vm", baseBranch: null } },
      targetConfirmed: true,
    });
  });

  it("submits publishing steps for saving after switching to VM", async () => {
    const draft = newWorkflowDraft([project], "publish")!;
    startNewWorkflowDraft(appAtomRegistry, scope, () => ({
      ...draft,
      definition: { ...draft.definition, target: { kind: "vm", baseBranch: null } },
    }));
    read.mockResolvedValue({ status: "connected" });
    await mount({ ...base, vmAuthoring: { models: null } });
    const reads = read.mock.calls.length;
    const submitted = {
      ...saved(draft.workflowId),
      definition: editor(draft.workflowId).definition,
    };
    read.mockResolvedValueOnce(submitted);
    await submit();
    expect(read).toHaveBeenCalledTimes(reads + 1);
    expect(editor(draft.workflowId).baseline?.definition.steps).toEqual(draft.definition.steps);
  });

  it("adds Push branch and Open PR to a VM draft", async () => {
    read.mockResolvedValue({ status: "connected" });
    await mount({ ...base, projects: [], vmAuthoring: { models: null } });
    const id = newId();
    const before = editor(id).definition.steps;
    await act(() => {
      const canvas = renderer!.root.findByProps({ "data-testid": "canvas-fixture" });
      canvas.props.onInsert({ edge: "end" }, "action");
      canvas.props.onInsert({ edge: "end" }, "open_pull_request");
    });
    expect(editor(id).definition.steps).toEqual([
      ...before,
      expect.objectContaining({ kind: "action", action: "push" }),
      expect.objectContaining({ kind: "action", action: "open_pull_request" }),
    ]);
  });

  it("copies a VM workflow without a machine and keeps the base branch only in the same repository", () => {
    const draft = newWorkflowDraft([], "review", true)!;
    const source: RepositoryWorkflow = {
      workflowId: "vm-source",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 3,
      createdAt: "now",
      updatedAt: "now",
      definition: { ...draft.definition, target: { kind: "vm", baseBranch: "release/1.x" } },
      automation: recoveryAuto,
      archived: false,
    };
    expect(copiedWorkflowDraft(source, [], true, true)).toMatchObject({
      targetConfirmed: true,
      automation: { enabled: false, trigger: null },
      definition: {
        target: { kind: "vm", baseBranch: "release/1.x" },
        steps: draft.definition.steps,
      },
    });
    expect(copiedWorkflowDraft(source, [project], false, true)?.definition.target).toEqual({
      kind: "vm",
      baseBranch: null,
    });
    expect(copiedWorkflowDraft(source, [project], false)).toBeNull();
  });

  it("starts the publish template as an independent unsaved definition", () => {
    const draft = newWorkflowDraft([project], "publish")!;
    expect(
      draft.definition.steps.map((step) => (step.kind === "action" ? step.action : step.kind)),
    ).toEqual(["agent", "review", "push", "open_pull_request"]);
    expect(draft.baseline).toBeNull();
    expect(draft.operation).toBeNull();
    expect(draft.targetConfirmed).toBe(true);
  });
  it("copies only saved definition data and binds the destination checkout", () => {
    const sourceDraft = newWorkflowDraft([project], "publish")!;
    const source: RepositoryWorkflow = {
      workflowId: "source",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 9,
      createdAt: "now",
      updatedAt: "now",
      definition: { ...sourceDraft.definition, name: "Saved source" },
      archived: true,
    };
    const destination = {
      ...project,
      projectId: ProjectId.make("destination"),
      environmentId: EnvironmentId.make("other-env"),
    };
    const copied = copiedWorkflowDraft(source, [destination], false)!;
    expect(copied.workflowId).not.toBe(source.workflowId);
    expect(copied.definition.name).toBe("Copy of Saved source");
    expect(copied.definition.target).toMatchObject({
      kind: "machine",
      projectId: destination.projectId,
    });
    expect(
      copiedWorkflowDraft(source, [destination], false, true)?.definition.target,
    ).toMatchObject({
      kind: "machine",
      projectId: destination.projectId,
    });
    expect(copiedWorkflowDraft(source, [], false, true)).toMatchObject({
      targetConfirmed: true,
      definition: {
        target: { kind: "vm", baseBranch: null },
        steps: source.definition.steps,
      },
    });
    expect(copied.baseline).toBeNull();
    expect(copied.operation).toBeNull();
    expect(copied.definition.steps).toEqual(source.definition.steps);
    expect(copied.definition.steps).not.toBe(source.definition.steps);
    expect(copied.definition.steps[0]).not.toBe(source.definition.steps[0]);
    expect(copiedWorkflowDraft(source, [project, destination], true)?.targetConfirmed).toBe(true);
    expect(copiedWorkflowDraft(source, [project, destination], false)?.targetConfirmed).toBe(false);
  });
  it("requires explicit discard and cannot overwrite a changed or uncertain retained draft", async () => {
    await mount();
    const id = newId();
    confirmation.mockResolvedValueOnce(false);
    expect(
      await openNewWorkflowDraft(scope, () => newWorkflowDraft([project], "publish")),
    ).toBeNull();
    expect(newId()).toBe(id);
    const confirm = deferred<boolean>();
    confirmation.mockReturnValueOnce(confirm.promise);
    const pending = openNewWorkflowDraft(scope, () => newWorkflowDraft([project], "publish"));
    await rename("Changed during confirmation");
    const rejected = expect(pending).rejects.toThrow("The retained draft changed");
    confirm.resolve(true);
    await rejected;
    expect(newId()).toBe(id);
    editWorkflowDraft(scope, id, (draft) => ({
      ...draft,
      operation: {
        requestId: "uncertain",
        state: "uncertain",
        definition: draft.definition,
        archived: false,
        expectedRevision: 0,
      },
    }));
    await expect(openNewWorkflowDraft(scope, () => newWorkflowDraft([project]))).rejects.toThrow(
      "reconcile",
    );
    expect(newId()).toBe(id);
  });
});

describe("VM authoring", () => {
  const openExecutionSettings = () =>
    act(() => renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick());
  const chooseExecutionTarget = (kind: "machine" | "vm") =>
    act(() =>
      renderer!.root.findByProps({ "data-workflow-target": true }).props.onValueChange(kind),
    );
  const baseBranchMode = (value: "default" | "specific") =>
    renderer!.root.findByProps({ type: "radio", value });
  const chooseBaseBranchMode = (value: "default" | "specific") =>
    act(() => baseBranchMode(value).props.onChange({ target: { checked: true } }));
  const baseBranchInput = () =>
    renderer!.root
      .findAllByType("input")
      .find((node) => typeof node.props.id === "string" && node.props.id.endsWith("-branch-name"));
  const changeBaseBranch = (value: string) =>
    act(() => baseBranchInput()!.props.onChange({ target: { value } }));
  const recordUnavailableSavedBranch = (workflow: RepositoryWorkflow, branch: string) =>
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      runs: {
        ...state.runs,
        [workflowSessionKey(scope, workflow.workflowId)]: {
          instruction: "Keep the run instructions.",
          operation: null,
          startedJobId: null,
          error: "Choose an existing GitHub base branch with at least one commit.",
          vmStartFailure: { kind: "base-branch-unavailable", branch },
          vmStartFailureRevision: workflow.revision,
        },
      },
    }));
  const checkoutPicker = () => renderer!.root.findByProps({ "data-checkout-picker": true });
  const checkoutOptions = () => checkoutPicker().findAllByProps({ role: "option" });
  const searchCheckouts = (value: string) =>
    act(() => checkoutPicker().findByType("input").props.onChange({ target: { value } }));
  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
  const update = (props: Props) =>
    act(() =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <WorkflowBuilder {...props} />
        </AppAtomRegistryProvider>,
      ),
    );

  it("searches by checkout and machine and selects the intended same-named checkout", async () => {
    const buildMac = { ...project, title: "launchpad", machineLabel: "Build Mac" };
    const workstation = {
      ...buildMac,
      environmentId: EnvironmentId.make("workstation-environment"),
      machineId: RelayMachineId.make("workstation"),
      machineLabel: "Dev Workstation",
    };
    const releaseRunner = {
      ...buildMac,
      projectId: ProjectId.make("release-checkout"),
      machineLabel: "Release Runner",
      title: "launchpad-release",
    };
    const workflow = saved("same-checkout-name", 1, newWorkflowDraft([buildMac])!.definition);
    await mount({
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      projects: [buildMac, workstation, releaseRunner],
    });

    expect(checkoutOptions().map((option) => option.props["aria-selected"])).toEqual([
      true,
      false,
      false,
    ]);
    await searchCheckouts("RELEASE");
    expect(checkoutOptions()).toHaveLength(1);
    expect(
      checkoutOptions()[0]!.findAll((node) => node.children.includes("launchpad-release")).length,
    ).toBeGreaterThan(0);

    await searchCheckouts("unknown");
    expect(checkoutOptions()).toHaveLength(0);
    expect(checkoutPicker().findByProps({ role: "status" })).toBeDefined();

    await searchCheckouts(" dev workstation ");
    expect(checkoutOptions()).toHaveLength(1);
    expect(
      checkoutOptions()[0]!.findAll((node) => node.children.includes("Dev Workstation")).length,
    ).toBeGreaterThan(0);
    await act(() => checkoutOptions()[0]!.props.onClick());
    expect(editor(workflow.workflowId).definition.target).toEqual({
      kind: "machine",
      environmentId: workstation.environmentId,
      projectId: workstation.projectId,
    });
    expect(editor(workflow.workflowId).baseline).toEqual(workflow);
    expect(read).not.toHaveBeenCalled();
  });

  it("distinguishes identical checkout and machine names in the list and selected value", async () => {
    const first = { ...project, title: "launchpad", machineLabel: "Build Mac" };
    const second = {
      ...first,
      environmentId: EnvironmentId.make("second-environment"),
      machineId: RelayMachineId.make("second-machine"),
    };
    const sameMachine = { ...first, projectId: ProjectId.make("another-project") };
    const unique = { ...first, title: "launchpad-dev", projectId: ProjectId.make("dev") };
    const workflow = saved("identical-checkout-names", 1, newWorkflowDraft([first])!.definition);
    await mount({
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      projects: [first, second, sameMachine, unique],
    });

    const identifiers = (node: ReactTestInstance) =>
      node
        .findAllByType("span")
        .map(textOf)
        .filter((text) => text.startsWith("Environment "));
    const options = checkoutOptions();
    expect(options.map(identifiers)).toEqual([
      ["Environment environment / Checkout project"],
      ["Environment second-environment / Checkout project"],
      ["Environment environment / Checkout another-project"],
      [],
    ]);
    const trigger = () => checkoutPicker().findByProps({ role: "combobox" });
    expect(identifiers(trigger())).toEqual(["Environment environment / Checkout project"]);
    await act(() => options[1]!.props.onClick());
    expect(identifiers(trigger())).toEqual(["Environment second-environment / Checkout project"]);
    expect(editor(workflow.workflowId).definition.target).toEqual({
      kind: "machine",
      environmentId: second.environmentId,
      projectId: second.projectId,
    });
  });

  it("keeps other edits when replacing an unavailable checkout and saving", async () => {
    const workflow = saved("unavailable-checkout", 1, newWorkflowDraft([project])!.definition);
    const replacement = {
      ...project,
      projectId: ProjectId.make("replacement"),
      machineLabel: "Release Runner",
    };
    await mount({ ...base, workflow, isNew: false, projects: [replacement] });
    await rename("Draft name");
    await openExecutionSettings();

    expect(JSON.stringify(renderer!.toJSON())).toContain("Saved checkout unavailable");
    expect(editor(workflow.workflowId).definition.target).toEqual(workflow.definition.target);
    await act(() => checkoutOptions()[0]!.props.onClick());

    const draft = editor(workflow.workflowId);
    expect(draft.definition).toMatchObject({
      name: "Draft name",
      target: {
        kind: "machine",
        environmentId: replacement.environmentId,
        projectId: replacement.projectId,
      },
    });
    expect(draft.baseline).toEqual(workflow);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Saved checkout unavailable");

    const repair = { ...workflow, revision: 2, definition: draft.definition };
    read.mockResolvedValueOnce(repair);
    await submit();
    expect(editor(workflow.workflowId).baseline).toEqual(repair);
  });

  it("describes a disappearing draft checkout as selected in the header and inspector", async () => {
    const workflow = saved(
      "unavailable-draft-checkout",
      1,
      newWorkflowDraft([project])!.definition,
    );
    const other = { ...project, projectId: ProjectId.make("other") };
    const props = {
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      projects: [project, other],
    };
    await mount(props);
    await act(() => checkoutOptions()[1]!.props.onClick());
    const draft = editor(workflow.workflowId);
    await update({ ...props, projects: [project] });

    const root = renderer!.root;
    expect(
      root.findByProps({ "aria-label": "Execution target: Selected checkout unavailable" }),
    ).toBeDefined();
    expect(root.findAllByProps({ role: "alert" }).map(textOf)).toContainEqual(
      expect.stringContaining("Selected checkout unavailable"),
    );
    expect(editor(workflow.workflowId)).toEqual(draft);
  });

  it("compares a missing checkout with the latest saved target while retaining the draft", async () => {
    const workflow = saved("newer-saved-checkout", 1, newWorkflowDraft([project])!.definition);
    const props = { ...base, workflow, isNew: false, openExecutionSettings: true };
    await mount(props);
    await rename("Draft name");
    const other = { ...project, projectId: ProjectId.make("other") };
    const newer = saved(workflow.workflowId, 2, newWorkflowDraft([other])!.definition);
    const draft = editor(workflow.workflowId);
    await update({ ...props, workflow: newer, projects: [other] });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Selected checkout unavailable");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Saved checkout unavailable");
    expect(editor(workflow.workflowId)).toEqual(draft);
  });

  it("keeps the checkout repair as a draft until saved and restores with the saved replacement", async () => {
    const workflow = {
      ...saved("archived-machine", 1, newWorkflowDraft([project])!.definition),
      archived: true,
    };
    const replacement = { ...project, projectId: ProjectId.make("replacement") };
    await mount({
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      projects: [replacement],
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Saved checkout unavailable");
    const restore = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.children === "Restore workflow")!;
    expect(restore().props.disabled).toBe(true);
    expect(editor(workflow.workflowId).definition.target).toEqual(workflow.definition.target);
    await act(() => checkoutOptions()[0]!.props.onClick());
    const repaired = editor(workflow.workflowId).definition;
    expect(repaired.target).toEqual({
      kind: "machine",
      environmentId: replacement.environmentId,
      projectId: replacement.projectId,
    });
    expect(restore().props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Save the execution target before restoring this workflow.",
    );
    await click("Restore workflow");
    expect(confirmation).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(editor(workflow.workflowId).definition).toEqual(repaired);

    const savedRepair = { ...workflow, revision: 2, definition: repaired };
    read.mockResolvedValueOnce(savedRepair);
    await submit();
    expect(restore().props.disabled).toBe(false);

    const restored = { ...savedRepair, revision: 3, archived: false };
    read.mockResolvedValueOnce(restored);
    await click("Restore workflow");
    expect(editor(workflow.workflowId).baseline).toEqual(restored);
  });

  it("archives a saved manual workflow with a missing checkout only after confirmation", async () => {
    const workflow = saved("active-machine", 1, newWorkflowDraft([project])!.definition);
    await mount({ ...base, workflow, isNew: false, openExecutionSettings: true, projects: [] });

    await click("Archive workflow");
    expect(read).not.toHaveBeenCalled();
    expect(editor(workflow.workflowId).baseline).toEqual(workflow);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Archive workflow?");
    expect(button("Cancel", editorDialog())).toBeDefined();

    const archived = { ...workflow, revision: 2, archived: true };
    read.mockResolvedValueOnce(archived);
    await click("Archive workflow", editorDialog());
    expect(read).toHaveBeenCalledTimes(1);
    expect(editor(workflow.workflowId).baseline).toEqual(archived);
  });

  it("explains and turns off saved automatic triggering when archiving", async () => {
    const workflow = {
      ...saved("automatic-machine", 1, newWorkflowDraft([project])!.definition),
      automation: recoveryAuto,
    };
    await mount({
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      automationSupported: true,
    });

    await click("Archive workflow");
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Automatic triggering turns off");

    const archived = {
      ...workflow,
      revision: 2,
      archived: true,
      automation: { ...recoveryAuto, enabled: false },
    };
    read.mockResolvedValueOnce(archived);
    await click("Archive workflow", editorDialog());
    expect(read).toHaveBeenCalledTimes(1);
    expect(editor(workflow.workflowId).baseline).toEqual(archived);
  });

  it("keeps unsaved edits on dismissal and archives the saved version after explicit discard", async () => {
    const workflow = saved("edited-machine", 1, newWorkflowDraft([project])!.definition);
    await mount({ ...base, workflow, isNew: false, openExecutionSettings: true });
    await rename("Unsaved workflow name");

    await click("Archive workflow");
    await click("Keep editing", editorDialog());
    expect(read).not.toHaveBeenCalled();
    expect(editor(workflow.workflowId).definition.name).toBe("Unsaved workflow name");

    await click("Archive workflow");
    expect(read).not.toHaveBeenCalled();
    const archived = { ...workflow, revision: 2, archived: true };
    read.mockResolvedValueOnce(archived);
    await click("Discard edits and archive", editorDialog());
    expect(read).toHaveBeenCalledTimes(1);
    expect(editor(workflow.workflowId).baseline).toEqual(archived);
    expect(editor(workflow.workflowId).definition).toEqual(workflow.definition);
  });

  it.each(["rejected", "unconfirmed"] as const)(
    "retains edits through a %s archive request",
    async (outcome) => {
      type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
      const saveWorkflow = vi.fn<Client["saveWorkflow"]>();
      const client = { saveWorkflow, readWorkflowCatalog: vi.fn() } as unknown as Client;
      const call: Props["call"] = async <A,>(operation: Parameters<Props["call"]>[0]) => {
        void operation(client, "fixture-token");
        return (await read()) as A;
      };
      const workflow = saved("archive-attempt", 1, newWorkflowDraft([project])!.definition);
      const id = workflow.workflowId;
      await mount({ ...base, workflow, call, isNew: false, openExecutionSettings: true });
      await rename("Unsaved archive edits");
      const reply = deferred<RepositoryWorkflow>();
      read.mockReturnValueOnce(reply.promise);

      await click("Archive workflow");
      await click("Discard edits and archive", editorDialog());
      expect(saveWorkflow).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "fixture-token",
        repositoryId: scope.repositoryId,
        payload: {
          workflowId: id,
          expectedRevision: workflow.revision,
          definition: workflow.definition,
          archived: true,
        },
      });
      expect(editor(id).operation?.state).toBe("pending");
      expect(editor(id).definition.name).toBe("Unsaved archive edits");

      await act(async () => {
        reply.reject(
          outcome === "rejected"
            ? new ManagedRelay.ManagedRelayRequestFailedError({
                action: "saveWorkflow",
                cause: new WorkflowConflictError({ message: "This workflow changed." }),
              })
            : new Error("Reply lost"),
        );
      });
      expect(editor(id).baseline).toEqual(workflow);
      expect(editor(id).definition.name).toBe("Unsaved archive edits");
      if (outcome === "rejected") {
        expect(editor(id).operation).toBeNull();
        return;
      }

      expect(editor(id).operation?.state).toBe("uncertain");
      const archived = { ...workflow, revision: 2, archived: true };
      read.mockResolvedValueOnce({ workflows: [archived] });
      await click("Check saved version");
      expect(saveWorkflow).toHaveBeenCalledOnce();
      expect(editor(id).operation).toBeNull();
      expect(editor(id).baseline).toEqual(archived);
      expect(editor(id).definition).toEqual(archived.definition);
    },
  );

  it("keeps unsaved edits when a newer saved version invalidates the archive confirmation", async () => {
    const workflow = saved("archive-conflict", 1, newWorkflowDraft([project])!.definition);
    const props = { ...base, workflow, isNew: false, openExecutionSettings: true };
    await mount(props);
    await rename("Unsaved archive edits");
    await click("Archive workflow");
    expect(button("Discard edits and archive", editorDialog())?.props.disabled).toBeFalsy();
    const capturedDraft = editor(workflow.workflowId);

    const newer = {
      ...workflow,
      revision: 2,
      definition: { ...workflow.definition, name: "Changed in another editor" },
    };
    await act(() =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <WorkflowBuilder {...props} workflow={newer} />
        </AppAtomRegistryProvider>,
      ),
    );

    expect(editor(workflow.workflowId)).toBe(capturedDraft);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saved version changed");
    const dialog = editorDialog();
    const discardAndArchive = button("Discard edits and archive", dialog);
    expect(!discardAndArchive || discardAndArchive.props.disabled === true).toBe(true);
    expect(button("Keep editing", dialog)).toBeDefined();
    expect(button("Discard edits and reload", dialog)).toBeDefined();
    expect(read).not.toHaveBeenCalled();

    await click("Keep editing", dialog);
    expect(confirmation).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ role: "alertdialog" })).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(editor(workflow.workflowId).definition.name).toBe("Unsaved archive edits");
    expect(editor(workflow.workflowId).baseline).toEqual(workflow);

    await click("Archive workflow");
    read.mockResolvedValueOnce({ workflows: [newer] });
    await click("Discard edits and reload", editorDialog());
    expect(confirmation).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(editor(workflow.workflowId).baseline).toEqual(newer);
    expect(editor(workflow.workflowId).definition).toEqual(newer.definition);
  });

  it.each([true, false])(
    "keeps the saved Machine target and accounts for VM execution availability (%s)",
    async (vmExecutionAvailable) => {
      const workflow = saved("saved-machine", 1, newWorkflowDraft([project])!.definition);
      read.mockResolvedValue({ status: "connected" });
      const props: Props = {
        ...base,
        workflow,
        isNew: false,
        projects: [],
        vmAuthoring: { models: null },
        vmExecutionAvailable,
      };
      await mount({ ...props, projectsUnavailable: true });
      await openExecutionSettings();

      const root = renderer!.root;
      expect(button("Retry loading checkouts")).toBeDefined();
      expect(
        root.findByProps({
          "aria-label": "Execution target: Machine checkouts could not be loaded",
        }),
      ).toBeDefined();
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Saved checkout unavailable");
      await update(props);
      expect(root.findByProps({ "data-workflow-target": true }).props.value).toBe("machine");
      expect(
        root.findByProps({ "data-workflow-target-option": true, value: "machine" }).props.disabled,
      ).toBe(true);
      expect(root.findAllByProps({ "data-checkout-picker": true })).toHaveLength(0);
      expect(editor(workflow.workflowId).definition.target).toEqual(workflow.definition.target);

      const content = JSON.stringify(renderer!.toJSON());
      expect(content).toContain("Your workflow edits are kept.");
      expect(content).toContain("Saved checkout unavailable");
      expect(content).not.toContain("Choose another checkout.");
      expect(button("Retry loading checkouts")).toBeUndefined();
      if (vmExecutionAvailable) {
        expect(content).toContain("Choose VM or enroll a checkout to run this workflow.");
      } else {
        expect(content).toContain("VM runs are unavailable.");
        expect(content).not.toContain("Choose VM or enroll a checkout to run this workflow.");
      }

      await chooseExecutionTarget("vm");
      expect(editor(workflow.workflowId).definition.target).toEqual({
        kind: "vm",
        baseBranch: null,
      });
    },
  );

  it.each([
    { name: "the saved override", edit: undefined, expected: "release/1.x" },
    { name: "an unsaved override", edit: "release/2.x", expected: "release/2.x" },
    { name: "an unsaved reset to the default", edit: null, expected: null },
  ])("restores $name after returning to VM in the retained draft", async ({ edit, expected }) => {
    const workflow: RepositoryWorkflow = {
      workflowId: "saved-vm",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
      definition: {
        ...newWorkflowDraft([], "review", true)!.definition,
        target: { kind: "vm", baseBranch: "release/1.x" },
      },
      archived: false,
    };
    const props = { ...base, workflow, isNew: false, vmAuthoring: { models: null } };
    read.mockResolvedValue({ status: "connected" });
    await mount(props);
    await openExecutionSettings();
    if (edit === null) await chooseBaseBranchMode("default");
    else if (edit !== undefined) await changeBaseBranch(edit);
    await chooseExecutionTarget("machine");
    expect(editor(workflow.workflowId).definition.target.kind).toBe("machine");
    await unmount();
    await mount(props);
    await openExecutionSettings();
    await chooseExecutionTarget("vm");
    expect(editor(workflow.workflowId).definition.target).toEqual({
      kind: "vm",
      baseBranch: expected,
    });
    expect(baseBranchMode(expected === null ? "default" : "specific").props.checked).toBe(true);
    expect(baseBranchInput()?.props.value).toBe(expected ?? undefined);
  });

  it.each(["Discard changes", "Reload saved version"] as const)(
    "forgets the alternate VM branch when using %s",
    async (action) => {
      const workflow: RepositoryWorkflow = {
        workflowId: "saved-machine",
        repositoryId: scope.repositoryId,
        organizationId: scope.organizationId,
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
        definition: newWorkflowDraft([project])!.definition,
        archived: false,
      };
      read.mockResolvedValue({ status: "connected" });
      await mount({ ...base, workflow, isNew: false, vmAuthoring: { models: null } });
      await openExecutionSettings();
      await chooseExecutionTarget("vm");
      await chooseBaseBranchMode("specific");
      await changeBaseBranch("unsaved-branch");
      await chooseExecutionTarget("machine");
      if (action === "Reload saved version") {
        await conflict(workflow.workflowId);
        read.mockResolvedValueOnce({ workflows: [{ ...workflow, revision: 2 }] });
      }
      await click(action);
      await openExecutionSettings();
      await chooseExecutionTarget("vm");
      expect(editor(workflow.workflowId).definition.target).toEqual({
        kind: "vm",
        baseBranch: null,
      });
    },
  );

  it("saves a base branch override with no checkout or Codex connection", async () => {
    read.mockResolvedValueOnce({ status: "disconnected" });
    await mount({ ...base, projects: [], vmAuthoring: { models: null } });
    const id = newId();
    expect(editor(id).definition.target).toEqual({ kind: "vm", baseBranch: null });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Connect Codex before running.");
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
    );
    await chooseBaseBranchMode("specific");
    await changeBaseBranch("release/1.x ");
    const receipt: RepositoryWorkflow = {
      ...saved(id),
      definition: { ...editor(id).definition, target: { kind: "vm", baseBranch: "release/1.x" } },
    };
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await submit();
    expect(editor(id).operation).toMatchObject({
      state: "uncertain",
      definition: receipt.definition,
    });
    read.mockResolvedValueOnce({ workflows: [receipt], vmAuthoring: { models: null } });
    await click("Check saved version");
    expect(editor(id).baseline?.definition.target).toEqual({
      kind: "vm",
      baseBranch: "release/1.x",
    });
    expect(editor(id).operation).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/workflows/$repositoryId/$workflowId/edit",
      }),
    );
  });

  it("blocks saving a blank specific branch until the default is explicitly selected", async () => {
    const workflow = saved("branch-mode", 1, {
      ...newWorkflowDraft([], "review", true)!.definition,
      target: { kind: "vm", baseBranch: "release/1.x" },
    });
    read.mockResolvedValueOnce({ status: "connected" });
    await mount({
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      vmAuthoring: { models: null },
    });
    expect(baseBranchMode("specific").props.checked).toBe(true);
    await chooseBaseBranchMode("default");
    await chooseBaseBranchMode("specific");
    expect(baseBranchInput()?.props.value).toBe("release/1.x");

    await changeBaseBranch("   ");
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(baseBranchInput()?.props["aria-invalid"]).toBe(true);
    expect(editor(workflow.workflowId).operation).toBeNull();

    await chooseBaseBranchMode("default");
    expect(baseBranchMode("default").props.checked).toBe(true);
    expect(baseBranchInput()).toBeUndefined();
    const updated = saved(workflow.workflowId, 2, {
      ...workflow.definition,
      target: { kind: "vm", baseBranch: null },
    });
    read.mockResolvedValueOnce(updated);
    await submit();
    expect(read).toHaveBeenCalledTimes(2);
    expect(editor(workflow.workflowId).baseline?.definition.target).toEqual(
      updated.definition.target,
    );
    await chooseBaseBranchMode("specific");
    expect(baseBranchInput()?.props.value).toBe("");
  });

  it("keeps the rejected branch warning through a rename until a replacement branch is saved", async () => {
    const branch = "release/missing";
    const workflow = saved("unavailable-branch", 1, {
      ...newWorkflowDraft([], "review", true)!.definition,
      target: { kind: "vm", baseBranch: branch },
    });
    recordUnavailableSavedBranch(workflow, branch);
    const props: Props = {
      ...base,
      workflow,
      isNew: false,
      openExecutionSettings: true,
      vmAuthoring: { models: null },
    };
    read.mockResolvedValue({ status: "connected" });
    await mount(props);

    expect(textOf(renderer!.root)).toContain("Saved branch unavailable");
    expect(baseBranchInput()?.props).toMatchObject({ value: branch, "aria-invalid": true });
    await chooseExecutionTarget("machine");
    expect(textOf(renderer!.root)).not.toContain("Saved branch unavailable");
    await chooseExecutionTarget("vm");
    expect(textOf(renderer!.root)).toContain("Saved branch unavailable");

    await rename("Renamed workflow");
    const renamed = saved(workflow.workflowId, 2);
    read.mockResolvedValueOnce(renamed);
    await submit();
    expect(editor(workflow.workflowId).baseline).toEqual(renamed);
    expect(textOf(renderer!.root)).toContain("Saved branch unavailable");
    expect(baseBranchInput()?.props).toMatchObject({ value: branch, "aria-invalid": true });

    await changeBaseBranch("release/replacement");
    const repaired = saved(workflow.workflowId, 3);
    read.mockResolvedValueOnce(repaired);
    await submit();
    expect(editor(workflow.workflowId).baseline).toEqual(repaired);
    expect(textOf(renderer!.root)).not.toContain("Saved branch unavailable");
    expect(baseBranchInput()?.props.value).toBe("release/replacement");
  });

  it.each(["clean", "dirty"] as const)(
    "opens branch recovery with a %s retained editor on an older revision",
    async (draftState) => {
      const branch = "release/missing";
      const older = saved("branch-recovery", 1, newWorkflowDraft([project])!.definition);
      const newer = saved(older.workflowId, 2, {
        ...older.definition,
        target: { kind: "vm", baseBranch: branch },
      });
      const props = { ...base, isNew: false, vmAuthoring: { models: null } };
      read.mockResolvedValue({ status: "connected" });
      await mount({ ...props, workflow: older });
      if (draftState === "dirty") await rename("Unsaved name");
      await unmount();

      recordUnavailableSavedBranch(newer, branch);
      await mount({ ...props, workflow: newer, openExecutionSettings: true });

      if (draftState === "dirty") {
        expect(editor(older.workflowId).baseline).toEqual(older);
        expect(editor(older.workflowId).definition).toEqual({
          ...older.definition,
          name: "Unsaved name",
        });
        return;
      }

      expect(editor(older.workflowId).baseline).toEqual(newer);
      expect(baseBranchInput()?.props).toMatchObject({ value: branch, "aria-invalid": true });
      expect(textOf(renderer!.root)).toContain("Saved branch unavailable");
      await changeBaseBranch("release/replacement");
      const repair = deferred<RepositoryWorkflow>();
      const repaired = saved(older.workflowId, 3);
      read.mockReturnValueOnce(repair.promise);
      await submit();
      expect(editor(older.workflowId).operation?.expectedRevision).toBe(newer.revision);
      await act(async () => {
        repair.resolve(repaired);
        await repair.promise;
      });
      expect(editor(older.workflowId).baseline).toEqual(repaired);
    },
  );

  it.each([false, true])(
    "uses saved VM Run availability %s when the draft switches to a machine",
    async (vmExecutionAvailable) => {
      const definition = newWorkflowDraft([], "review", true)!.definition;
      const workflow: RepositoryWorkflow = {
        workflowId: "saved-vm",
        repositoryId: scope.repositoryId,
        organizationId: scope.organizationId,
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
        definition,
        archived: false,
      };
      read.mockRejectedValueOnce(new Error("status unavailable"));
      await mount({
        ...base,
        workflow,
        isNew: false,
        vmAuthoring: { models: null },
        vmExecutionAvailable,
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        "Could not check the organization's Codex connection.",
      );
      await act(() =>
        renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
      );
      await act(() =>
        renderer!.root.findByProps({ "data-workflow-target": true }).props.onValueChange("machine"),
      );
      expect(editor(workflow.workflowId).definition.target.kind).toBe("machine");
      const run = renderer!.root
        .findAllByType("button")
        .find((node) => node.props.children?.[1] === "Run")!;
      expect(run.props.disabled).toBe(!vmExecutionAvailable);
      await act(() => run.props.onClick());
      if (vmExecutionAvailable)
        expect(navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/workflows/$repositoryId/$workflowId/run",
          params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
        });
      else expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["gated", "View retained instructions"],
    ["archived", "View retained instructions"],
    ["gated", "View run submission"],
    ["archived", "View run submission"],
  ] as const)("opens %s editor Run details via %s", async (condition, label) => {
    const uncertainMachine = label === "View run submission";
    const workflow: RepositoryWorkflow = {
      workflowId: "saved-vm",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
      definition:
        uncertainMachine && condition === "archived"
          ? newWorkflowDraft([project])!.definition
          : newWorkflowDraft([], "review", true)!.definition,
      archived: condition === "archived",
    };
    read.mockResolvedValueOnce({ status: "connected" });
    await mount({
      ...base,
      workflow,
      isNew: false,
      vmAuthoring: { models: null },
      vmExecutionAvailable: condition !== "gated",
    });
    await act(() =>
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        runs: {
          ...state.runs,
          [workflowSessionKey(scope, workflow.workflowId)]: {
            instruction: uncertainMachine ? "" : "New instructions",
            operation: uncertainMachine
              ? { requestId: "submitted", instruction: "Task", state: "uncertain" }
              : null,
            startedJobId: uncertainMachine ? null : "existing-run",
            error: null,
          },
        },
      })),
    );
    const run = renderer!.root
      .findAllByType("button")
      .find((node) => node.props.children?.[1] === label)!;
    expect(run.props.disabled).toBe(false);
    await act(() => run.props.onClick());
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workflows/$repositoryId/$workflowId/run",
      params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
    });
  });

  it("saves Off and VM together after an explicit Off action, keeping the trigger", async () => {
    const workflow: RepositoryWorkflow = {
      workflowId: "saved-machine",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
      definition: newWorkflowDraft([project])!.definition,
      automation: recoveryAuto,
      archived: false,
    };
    await mount({
      ...base,
      workflow,
      isNew: false,
      vmAuthoring: { models: null },
      automationSupported: true,
    });
    const root = renderer!.root;
    const openSettings = () =>
      root.findByProps({ "aria-label": "Workflow settings" }).props.onClick();
    const openTrigger = () =>
      root.findByProps({ "aria-label": "Configure workflow trigger" }).props.onClick();
    const toggle = () =>
      root.findAllByType("button").find((node) => node.props.role === "checkbox")!;
    const selectVm = () =>
      root.findByProps({ "data-workflow-target": true }).props.onValueChange("vm");
    await act(openSettings);
    const vmChoice = root.findByProps({ "data-workflow-target-option": true, value: "vm" });
    expect(vmChoice.props.disabled).toBe(true);
    await act(selectVm);
    expect(editor(workflow.workflowId).definition.target.kind).toBe("machine");
    expect(editor(workflow.workflowId).automation).toEqual(recoveryAuto);

    await act(openTrigger);
    await act(() => toggle().props.onClick());
    await act(openSettings);
    read.mockResolvedValueOnce({ status: "connected" });
    await act(selectVm);
    await act(openTrigger);
    expect(toggle()).toBeUndefined();
    expect(editor(workflow.workflowId).automation).toEqual({
      enabled: false,
      trigger: recoveryTrigger,
    });

    const definition = editor(workflow.workflowId).definition;
    read.mockImplementationOnce(async () => {
      expect(editor(workflow.workflowId).operation).toMatchObject({
        includesAutomation: true,
        automation: { enabled: false, trigger: recoveryTrigger },
        definition: { target: { kind: "vm", baseBranch: null } },
      });
      return {
        ...workflow,
        revision: 2,
        definition,
        automation: { enabled: false, trigger: recoveryTrigger },
      };
    });
    await submit();
    expect(editor(workflow.workflowId).baseline).toMatchObject({
      revision: 2,
      automation: { enabled: false, trigger: recoveryTrigger },
      definition: { target: { kind: "vm", baseBranch: null } },
    });
  });

  it("allows choosing VM without turning off a Linear rule when VM automation is available", async () => {
    const workflow = {
      ...saved("saved-machine", 1, newWorkflowDraft([project])!.definition),
      automation: recoveryAuto,
    };
    await mount({
      ...base,
      workflow,
      isNew: false,
      vmAuthoring: { models: null },
      automationSupported: true,
      vmAutomationAvailable: true,
    });
    const root = renderer!.root;
    await act(() => root.findByProps({ "aria-label": "Workflow settings" }).props.onClick());
    expect(
      root.findByProps({ "data-workflow-target-option": true, value: "vm" }).props.disabled,
    ).toBe(false);
    read.mockResolvedValueOnce({ status: "connected" });
    await act(() => root.findByProps({ "data-workflow-target": true }).props.onValueChange("vm"));
    expect(editor(workflow.workflowId)).toMatchObject({
      definition: { target: { kind: "vm" } },
      automation: recoveryAuto,
    });
  });

  it("saves Off against the saved revision during a VM outage and retains unrelated draft edits", async () => {
    const original = saved("saved-vm", 4, newWorkflowDraft([], "review", true)!.definition);
    const workflow: RepositoryWorkflow = {
      ...original,
      definition: { ...original.definition, target: { kind: "vm", baseBranch: "main" } },
      automation: recoveryAuto,
    };
    modelIssues.mockReturnValue([
      { stepId: "agent", title: "Agent", detail: "Choose a model supported by this VM build." },
    ]);
    read.mockResolvedValueOnce({ status: "connected" });
    await mount({
      ...base,
      workflow,
      isNew: false,
      vmAuthoring: { models: null },
      automationSupported: true,
      vmAutomationAvailable: false,
    });
    await rename("");
    const editedTrigger = { ...recoveryTrigger, labelIds: ["draft-label"] };
    await act(() =>
      editWorkflowDraft(scope, workflow.workflowId, (current) => ({
        ...current,
        automation: { enabled: true, trigger: editedTrigger },
      })),
    );
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Configure workflow trigger" }).props.onClick(),
    );
    const off = { enabled: false, trigger: recoveryTrigger };
    const receipt = { ...workflow, revision: workflow.revision + 1, automation: off };
    const write = deferred<RepositoryWorkflow>();
    read.mockImplementationOnce(async () => {
      expect(editor(workflow.workflowId).operation).toMatchObject({
        expectedRevision: workflow.revision,
        definition: workflow.definition,
        automation: off,
      });
      return write.promise;
    });
    expect(button("Review model")?.props.disabled).toBeFalsy();
    await click("Save Off only");
    expect(button("Review model")?.props.disabled).toBe(true);
    await act(() => write.resolve(receipt));
    expect(button("Review model")?.props.disabled).toBeFalsy();
    expect(editor(workflow.workflowId)).toMatchObject({
      baseline: receipt,
      definition: { name: "" },
      automation: { enabled: false, trigger: editedTrigger },
      operation: null,
    });
  });

  it("saves the clean trigger switch Off when the saved model is unavailable", async () => {
    const workflow = {
      ...saved("saved-vm", 5, newWorkflowDraft([], "review", true)!.definition),
      automation: recoveryAuto,
    };
    modelIssues.mockReturnValue([
      { stepId: "agent", title: "Agent", detail: "Choose a model supported by this VM build." },
    ]);
    read.mockResolvedValueOnce({ status: "connected" });
    await mount({
      ...base,
      workflow,
      isNew: false,
      vmAuthoring: { models: null },
      automationSupported: true,
      vmAutomationAvailable: true,
    });
    const root = renderer!.root;
    await act(() =>
      root.findByProps({ "aria-label": "Configure workflow trigger" }).props.onClick(),
    );
    await act(() => root.findByProps({ role: "checkbox" }).props.onClick());
    const receipt = {
      ...workflow,
      revision: 6,
      automation: { enabled: false, trigger: recoveryTrigger },
    };
    read.mockResolvedValueOnce(receipt);
    await click("Save workflow");
    expect(editor(workflow.workflowId).baseline).toEqual(receipt);
    expect(workflowEditorDirty(editor(workflow.workflowId))).toBe(false);
  });
});

const recoveryTrigger = {
  provider: "linear",
  connectionId: "connection",
  grantId: "grant",
  teamId: "team",
  event: "entered_status",
  stateId: "ready",
  labelIds: [],
} as const;
const recoveryAuto = { enabled: true, trigger: recoveryTrigger };
describe("captured automation recovery in the editor", () => {
  for (const committed of [true, false])
    it(`recovers an earlier ${committed ? "committed" : "uncommitted"} Save before validating incomplete edits`, async () => {
      await mount({ ...base, automationSupported: true });
      const id = newId();
      const receipt = { ...saved(id), automation: recoveryAuto };
      await act(() =>
        editWorkflowDraft(scope, id, (current) => ({ ...current, automation: recoveryAuto })),
      );
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await submit();
      const operation = editor(id).operation!;
      await act(() =>
        editWorkflowDraft(scope, id, (current) => ({
          ...current,
          targetConfirmed: false,
          definition: {
            ...current.definition,
            name: "",
            target: {
              kind: "machine",
              environmentId: project.environmentId,
              projectId: ProjectId.make("later-project"),
            },
          },
          automation: {
            ...recoveryAuto,
            trigger: { ...recoveryTrigger, teamId: "later-team", stateId: "" },
          },
        })),
      );
      read.mockResolvedValueOnce({
        workflows: committed ? [receipt] : [],
        automationSupported: true,
      });
      const before = read.mock.calls.length;
      await click("Check saved version");
      expect(read).toHaveBeenCalledTimes(before + 1);
      if (!committed) {
        expect(JSON.stringify(renderer!.toJSON())).toContain("Save didn’t land");
        expect(editor(id).operation?.state).toBe("uncertain");
        read
          .mockResolvedValueOnce({ workflows: [], automationSupported: true })
          .mockResolvedValueOnce(receipt);
        await click("Retry original save");
        expect(read).toHaveBeenCalledTimes(before + 3);
      }
      expect(editor(id).baseline).toEqual(receipt);
      expect(editor(id).operation).toBeNull();
      expect(editor(id).definition.name).toBe("");
      expect(editor(id).targetConfirmed).toBe(false);
      expect(editor(id).automation?.trigger).toMatchObject({ teamId: "later-team", stateId: "" });
      expect(operation.definition).toEqual(receipt.definition);
      const after = read.mock.calls.length;
      await submit();
      expect(read).toHaveBeenCalledTimes(after);
    });
  it("does not confirm an automation Save through Check saved version after a downgrade", async () => {
    await mount({ ...base, automationSupported: true });
    const id = newId();
    const receipt = { ...saved(id), automation: recoveryAuto };
    await act(() =>
      editWorkflowDraft(scope, id, (current) => ({ ...current, automation: recoveryAuto })),
    );
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await submit();
    await unmount();
    await mount({ ...base, automationSupported: false });
    read.mockResolvedValueOnce({ workflows: [saved(id)] });
    await click("Check saved version");
    expect(editor(id).operation?.state).toBe("uncertain");
    read.mockResolvedValueOnce({ workflows: [receipt], automationSupported: true });
    await click("Check saved version");
    expect(editor(id).operation).toBeNull();
    expect(editor(id).baseline).toEqual(receipt);
  });
  for (const laterEdit of ["none", "definition", "automation"] as const)
    it(`applies upgraded canonical automation on read-only recovery while ${laterEdit !== "none" ? `preserving newer ${laterEdit} edits` : "keeping the draft clean"}`, async () => {
      await mount(base);
      const id = newId();
      const receipt = { ...saved(id), automation: recoveryAuto };
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await submit();
      if (laterEdit !== "none")
        await act(() =>
          editWorkflowDraft(scope, id, (current) => ({
            ...current,
            definition:
              laterEdit === "definition"
                ? { ...current.definition, name: "Later name" }
                : current.definition,
            ...(laterEdit === "automation"
              ? {
                  automation: {
                    ...recoveryAuto,
                    trigger: { ...recoveryTrigger, teamId: "later-team", stateId: "" },
                  },
                }
              : {}),
          })),
        );
      await unmount();
      await mount({ ...base, automationSupported: true });
      read.mockResolvedValueOnce({ workflows: [receipt], automationSupported: true });
      await click("Check saved version");
      expect(editor(id).operation).toBeNull();
      expect(editor(id).baseline).toEqual(receipt);
      if (laterEdit === "definition") expect(editor(id).definition.name).toBe("Later name");
      if (laterEdit === "automation")
        expect(editor(id).automation?.trigger?.teamId).toBe("later-team");
      else expect(editor(id).automation).toEqual(recoveryAuto);
      expect(workflowEditorDirty(editor(id))).toBe(laterEdit !== "none");
    });
});

describe("automation state after a relay upgrade", () => {
  for (const retained of [false, true])
    it(`preserves saved On and unrelated edits for a ${retained ? "pre-fix retained" : "new"} unsupported editor`, async () => {
      const legacy: RepositoryWorkflow = {
        workflowId: "legacy-flow",
        repositoryId: scope.repositoryId,
        organizationId: scope.organizationId,
        revision: 1,
        archived: false,
        definition: newWorkflowDraft([project])!.definition,
        createdAt: "now",
        updatedAt: "now",
      };
      await mount({
        ...base,
        isNew: false,
        workflowId: legacy.workflowId,
        workflow: legacy,
        automationSupported: false,
      });
      await rename("Only rename the workflow");
      if (retained)
        await act(() =>
          updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
            const current = editor(legacy.workflowId);
            const { automationResolved: _resolved, ...old } = current;
            return {
              ...state,
              editors: {
                ...state.editors,
                [workflowSessionKey(scope, legacy.workflowId)]: {
                  ...old,
                  automation: { enabled: false, trigger: null },
                },
              },
            };
          }),
        );
      await unmount();
      const canonical = { ...legacy, automation: recoveryAuto };
      await mount({
        ...base,
        isNew: false,
        workflowId: canonical.workflowId,
        workflow: canonical,
        automationSupported: true,
      });
      expect(editor(legacy.workflowId).definition.name).toBe("Only rename the workflow");
      expect(editor(legacy.workflowId).automation).toEqual(recoveryAuto);
      expect(workflowDraftAutomationResolved(editor(legacy.workflowId))).toBe(true);
      const { saveWorkflowDraft } = await import("./workflowOperations");
      const write = vi.fn(
        async (payload: Parameters<Parameters<typeof saveWorkflowDraft>[2]>[0]) => ({
          ...canonical,
          definition: payload.definition,
          automation: payload.automation ?? canonical.automation,
          revision: 2,
        }),
      );
      await act(async () => {
        await saveWorkflowDraft(scope, legacy.workflowId, write, undefined, {
          automationSupported: true,
          read: async () => ({ workflows: [canonical], automationSupported: true }),
        });
      });
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ automation: recoveryAuto }));
      expect(editor(legacy.workflowId).operation).toBeNull();
      expect(workflowEditorDirty(editor(legacy.workflowId))).toBe(false);
      // An explicit later Off remains a real edit rather than being replaced on refresh.
      await act(() =>
        editWorkflowDraft(scope, legacy.workflowId, (current) => ({
          ...current,
          automation: { ...recoveryAuto, enabled: false },
        })),
      );
      expect(editor(legacy.workflowId).automation?.enabled).toBe(false);
    });
  it("resolves a supported legacy manual workflow as Off without changing its definition", async () => {
    const legacy: RepositoryWorkflow = {
      workflowId: "legacy-off",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 1,
      archived: false,
      definition: newWorkflowDraft([project])!.definition,
      createdAt: "now",
      updatedAt: "now",
    };
    await mount({
      ...base,
      isNew: false,
      workflowId: legacy.workflowId,
      workflow: legacy,
      automationSupported: true,
    });
    expect(workflowDraftAutomationResolved(editor(legacy.workflowId))).toBe(true);
    expect(editor(legacy.workflowId).automation).toEqual({ enabled: false, trigger: null });
    expect(workflowEditorDirty(editor(legacy.workflowId))).toBe(false);
  });
  it("keeps unknown drafts and edits when a newer saved revision needs an explicit reload", async () => {
    const legacy: RepositoryWorkflow = {
      workflowId: "legacy-stale",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      revision: 1,
      archived: false,
      definition: newWorkflowDraft([project])!.definition,
      createdAt: "now",
      updatedAt: "now",
    };
    await mount({
      ...base,
      isNew: false,
      workflowId: legacy.workflowId,
      workflow: legacy,
      automationSupported: false,
    });
    await rename("Retain my edit");
    await unmount();
    await mount({
      ...base,
      isNew: false,
      workflowId: legacy.workflowId,
      workflow: { ...legacy, revision: 2, automation: recoveryAuto },
      automationSupported: true,
    });
    expect(workflowDraftAutomationResolved(editor(legacy.workflowId))).toBe(false);
    await submit();
    expect(read).not.toHaveBeenCalled();
    expect(editor(legacy.workflowId).definition.name).toBe("Retain my edit");
    expect(editor(legacy.workflowId).baseline?.revision).toBe(1);
    expect(editor(legacy.workflowId).error).toContain("Refresh or reload");
  });
});

it("cancels only trigger changes while keeping other unsaved workflow edits", async () => {
  const workflow: RepositoryWorkflow = {
    workflowId: "workflow",
    repositoryId: scope.repositoryId,
    organizationId: scope.organizationId,
    archived: false,
    revision: 1,
    definition: newWorkflowDraft([project])!.definition,
    createdAt: "now",
    updatedAt: "now",
    automation: recoveryAuto,
  };
  await mount({ ...base, workflow, isNew: false, automationSupported: true });
  await rename("Retained workflow name");
  await act(() =>
    renderer!.root.findByProps({ "aria-label": "Configure workflow trigger" }).props.onClick(),
  );
  await act(() =>
    renderer!.root
      .findAllByType("button")
      .find((node) => node.props.role === "checkbox")!
      .props.onClick(),
  );
  expect(editor(workflow.workflowId).automation?.enabled).toBe(false);
  await click("Cancel trigger edits");
  expect(editor(workflow.workflowId).automation).toEqual(recoveryAuto);
  expect(editor(workflow.workflowId).definition.name).toBe("Retained workflow name");
  expect(workflowEditorDirty(editor(workflow.workflowId))).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
