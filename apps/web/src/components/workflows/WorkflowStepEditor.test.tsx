import {
  act,
  createElement,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type PropsWithChildren,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  WORKFLOW_VM_DEFAULT_CODEX_MODEL,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import type { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { workflowVmCodexInstanceId } from "../settings/workflowModels";

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => createElement("textarea", props),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: PropsWithChildren) => children,
  MenuTrigger: ({ render }: { render: React.ReactElement }) => render,
  MenuPopup: ({ children }: PropsWithChildren) => children,
  MenuItem: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/select", async () => {
  const { createContext, useContext, useState } = await import("react");
  type SelectProps = {
    disabled?: boolean;
    readOnly?: boolean;
    value?: string | null;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onValueChange?: (value: string) => void;
  };
  const SelectState = createContext<
    | (SelectProps & {
        open: boolean;
        toggle: () => void;
        choose: (value: string) => void;
      })
    | null
  >(null);
  const OptionValue = createContext<string | null>(null);
  const component = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Select: ({ children, ...props }: PropsWithChildren<SelectProps>) => {
      const [internalOpen, setInternalOpen] = useState(false);
      const open = props.open ?? internalOpen;
      const setOpen = props.onOpenChange ?? setInternalOpen;
      return createElement(
        SelectState.Provider,
        {
          value: {
            ...props,
            open,
            toggle: () => {
              if (!props.disabled && !props.readOnly) setOpen(!open);
            },
            choose: (value) => {
              props.onValueChange?.(value);
              setOpen(false);
            },
          },
        },
        createElement("div", { ...props, "data-workflow-model-select": true }, children),
      );
    },
    SelectTrigger: ({ children, ...props }: PropsWithChildren) => {
      const select = useContext(SelectState)!;
      return createElement(
        "button",
        {
          ...props,
          disabled: select.disabled,
          "aria-readonly": select.readOnly || undefined,
          "aria-expanded": select.open,
          onClick: select.toggle,
        },
        children,
      );
    },
    SelectValue: component,
    SelectPopup: ({ children }: PropsWithChildren) =>
      useContext(SelectState)?.open ? createElement("div", { role: "listbox" }, children) : null,
    SelectGroup: component,
    SelectGroupLabel: component,
    SelectItem: ({
      children,
      disabled,
      value,
    }: PropsWithChildren<{ disabled?: boolean; value: string }>) => {
      const select = useContext(SelectState)!;
      return createElement(
        "button",
        {
          disabled,
          "data-option-value": value,
          onClick: disabled ? undefined : () => select.choose(value),
        },
        createElement(OptionValue.Provider, { value }, children),
      );
    },
    SelectItemIndicator: ({ children }: PropsWithChildren) =>
      useContext(SelectState)?.value === useContext(OptionValue)
        ? createElement("span", { "data-slot": "select-item-indicator" }, children)
        : null,
  };
});
const machine = vi.hoisted(() => ({ environment: vi.fn(), project: vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironment: machine.environment }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../state/entities", () => ({ useProject: machine.project }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: ComponentProps<typeof ProviderModelPicker>) => {
    const [internalOpen, setInternalOpen] = useState(false);
    const open = props.open ?? internalOpen;
    const setOpen = props.onOpenChange ?? setInternalOpen;
    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          ...props.triggerProps,
          "aria-label": props.triggerAriaLabel,
          disabled: props.disabled,
          onClick: () => setOpen(!open),
        },
        props.triggerLabel ?? props.model,
      ),
      open
        ? createElement(
            "div",
            { role: "listbox" },
            props.pickerHeader,
            props.instanceEntries.flatMap(({ instanceId }) =>
              (props.modelOptionsByInstance.get(instanceId) ?? []).map((model) => {
                const reason = props.getModelDisabledReason?.(instanceId, model.slug);
                return createElement(
                  "button",
                  {
                    key: `${instanceId}:${model.slug}`,
                    "aria-label": model.name,
                    disabled: !!reason,
                    onClick: reason
                      ? undefined
                      : () => {
                          props.onInstanceModelChange(instanceId, model.slug);
                          setOpen(false);
                        },
                  },
                  model.name,
                  reason,
                );
              }),
            ),
          )
        : null,
    );
  },
}));
import { useWorkflowEditorModels, WorkflowStepEditor } from "./WorkflowStepEditor";
const original: WorkflowDefinition = {
  name: "Example",
  target: {
    kind: "machine" as const,
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
  },
  steps: [
    {
      id: "plan",
      kind: "agent",
      title: "Plan",
      instruction: "Plan the change.",
      modelSelection: null,
    },
    {
      id: "implement",
      kind: "agent",
      title: "Implement",
      instruction: "Implement the change.",
      modelSelection: null,
    },
    {
      id: "review",
      kind: "review",
      title: "Review",
      role: "maintainer",
      reworkStepId: "implement",
    },
  ],
};
const vmPublishing: WorkflowDefinition = {
  ...original,
  target: { kind: "vm", baseBranch: "release/2.x" },
  steps: [
    ...original.steps,
    { id: "push", kind: "action", title: "Push the release", action: "push" },
    { id: "pr", kind: "action", title: "Open PR", action: "open_pull_request" },
  ],
};
const machineProvider = {
  instanceId: workflowVmCodexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  continuation: { groupKey: "checkout-codex" },
  requiresNewThreadForModelChange: true,
  models: [
    { slug: "project-model", name: "Project model", isCustom: false, capabilities: {} },
    { slug: "alternate-model", name: "Alternate model", isCustom: false, capabilities: {} },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;
function connectMachine() {
  machine.environment.mockReturnValue({
    connection: { phase: "connected" },
    serverConfig: { providers: [machineProvider] },
  });
  machine.project.mockReturnValue({
    defaultModelSelection: { instanceId: machineProvider.instanceId, model: "project-model" },
  });
}
let renderer: ReactTestRenderer | undefined;
let definition: WorkflowDefinition = original;
let selectedId = "";
const requestRemoval = vi.fn<(step: WorkflowStep) => boolean>();
function Harness({
  initial = original,
  selection = "implement",
  vmModels = null,
  machineCheckoutAvailable = true,
}: {
  initial?: WorkflowDefinition;
  selection?: string;
  vmModels?: WorkflowVmModelCatalog | null;
  machineCheckoutAvailable?: boolean;
}) {
  const [steps, change] = useState<ReadonlyArray<WorkflowStep>>(initial.steps);
  const [selected, select] = useState(selection);
  const current = { ...initial, steps };
  const models = useWorkflowEditorModels(current, vmModels);
  useLayoutEffect(() => {
    definition = current;
    selectedId = selected;
  }, [current, selected]);
  return (
    <WorkflowStepEditor
      definition={current}
      selectedId={selected}
      onRequestRemove={requestRemoval}
      change={change}
      onRequestMove={(step, offset) => {
        const index = steps.indexOf(step);
        const destination = index + offset;
        const neighbor = steps[destination];
        if (index === -1 || !neighbor) return false;
        const next = steps.slice();
        next[index] = neighbor;
        next[destination] = step;
        change(next);
        return false;
      }}
      models={models}
      vmModels={vmModels}
      targetConfirmed
      machineCheckoutAvailable={machineCheckoutAvailable}
      disabled={false}
      close={() => select("")}
      openWorkflowSettings={() => {}}
      insertPushBranch={() => {}}
      registerField={() => {}}
    />
  );
}
async function mount(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => {
    renderer = create(<Harness {...props} />);
  });
}
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.props.children === label)!;
async function click(label: string) {
  await act(() => button(label).props.onClick());
}
const textParts = (node: ReactTestInstance): ReadonlyArray<string> =>
  node.children.flatMap((child) => (typeof child === "string" ? child : textParts(child)));
const visibleText = (node: ReactTestInstance) =>
  textParts(node).join(" ").replace(/\s+/g, " ").trim();
const inspectorDetails = () =>
  Object.fromEntries(
    renderer!.root
      .findByType("dl")
      .findAllByType("dt")
      .map((term) => [visibleText(term), visibleText(term.parent!.findByType("dd"))]),
  );
const reworkPicker = () =>
  renderer!.root.findByProps({ "data-workflow-field": "rework" }).findByType("button");
const openReworkPicker = async () => act(() => reworkPicker().props.onClick());
const selectOption = (value: string) => renderer!.root.findByProps({ "data-option-value": value });
const indicatedOptions = () =>
  renderer!.root
    .findByProps({ role: "listbox" })
    .findAllByType("button")
    .flatMap((option) =>
      option
        .findAllByProps({ "data-slot": "select-item-indicator" })
        .map(() => option.props["data-option-value"]),
    );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  machine.environment.mockReset().mockReturnValue(null);
  machine.project.mockReset().mockReturnValue(null);
  requestRemoval.mockReset().mockReturnValue(true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("Workflow step editing", () => {
  it("clears a missing Input question error while keeping the selected responder", async () => {
    await mount({
      initial: {
        ...original,
        steps: [
          {
            id: "input",
            kind: "input",
            title: "Choose release target",
            question: "Which release should this change target?",
            role: "member",
          },
          ...original.steps,
        ],
      },
      selection: "input",
    });
    const question = () => renderer!.root.findByType("textarea");
    const error = renderer!.root
      .findAllByType("p")
      .find((node) => node.props["aria-live"] === "polite")!;
    expect(error.children).toHaveLength(0);
    await act(() =>
      renderer!.root
        .findByProps({ "data-workflow-model-select": true })
        .props.onValueChange("maintainer"),
    );
    await act(() => question().props.onChange({ target: { value: "   " } }));

    expect(question().props["aria-invalid"]).toBe(true);
    const descriptionId = question().props["aria-describedby"];
    expect(descriptionId).toEqual(expect.any(String));
    expect(renderer!.root.findByProps({ id: descriptionId })).toBe(error);
    expect(error.children).toContain("Enter a question for this Input step.");

    const replacement = "Which version should we publish?";
    await act(() => question().props.onChange({ target: { value: replacement } }));
    expect(question().props["aria-invalid"]).toBeFalsy();
    expect(question().props["aria-describedby"]).toBeUndefined();
    expect(renderer!.root.findByProps({ id: descriptionId })).toBe(error);
    expect(error.children).toHaveLength(0);
    expect(definition.steps[0]).toMatchObject({
      question: replacement,
      role: "maintainer",
    });
  });

  it("keeps the reviewed result on the latest Agent when selecting another rework target", async () => {
    const [plan, implement, review] = original.steps;
    if (!plan || !implement || review?.kind !== "review")
      throw new Error("Expected Review fixture.");
    await mount({
      initial: {
        ...original,
        steps: [
          { ...plan, title: implement.title },
          implement,
          { ...review, reworkStepId: undefined },
        ],
      },
      selection: "review",
    });

    const reviewedResult = () => inspectorDetails()["Saved result to review"];
    expect(reviewedResult()).toBe("Implement Step 2");
    expect(visibleText(reworkPicker())).toBe("Previous Agent step Currently Implement Step 2");
    await openReworkPicker();

    expect(visibleText(selectOption("agent:plan"))).toBe("Implement Step 1");
    expect(visibleText(selectOption("agent:implement"))).toBe("Implement Step 2");
    expect(indicatedOptions()).toEqual(["nearest"]);

    await act(() => selectOption("agent:plan").props.onClick());

    expect(definition.steps[2]).toMatchObject({ reworkStepId: "plan" });
    expect(visibleText(reworkPicker())).toBe("Implement Step 1");
    expect(reviewedResult()).toBe("Implement Step 2");

    await openReworkPicker();
    expect(indicatedOptions()).toEqual(["agent:plan"]);
    await act(() => selectOption("nearest").props.onClick());

    expect(definition.steps[2]).toMatchObject({ reworkStepId: undefined });
    expect(visibleText(reworkPicker())).toBe("Previous Agent step Currently Implement Step 2");
    await openReworkPicker();
    expect(indicatedOptions()).toEqual(["nearest"]);
  });

  it.each([
    {
      removed: false,
      current: "Implement Unavailable Step 3",
      reason: "The saved Agent runs after Review.",
    },
    {
      removed: true,
      current: "Unavailable Agent step",
      reason: "The saved Agent is no longer available.",
    },
  ])(
    "keeps an unavailable rework Agent visible before letting the user replace it (removed=$removed)",
    async ({ removed, current, reason }) => {
      const [plan, implement, review] = original.steps;
      await mount({
        initial: { ...original, steps: removed ? [plan!, review!] : [plan!, review!, implement!] },
        selection: "review",
      });

      expect(definition.steps[1]).toMatchObject({ reworkStepId: "implement" });
      expect(inspectorDetails()["Saved result to review"]).toBe("Plan Step 1");
      expect(visibleText(reworkPicker())).toBe(current);
      expect(reworkPicker().props["aria-invalid"]).toBe(true);
      const issueId = reworkPicker().props["aria-describedby"];
      expect(visibleText(renderer!.root.findByProps({ id: issueId }))).toBe(
        `${reason} Choose an earlier Agent.`,
      );
      await openReworkPicker();

      expect(
        renderer!.root.findAllByProps({ "data-option-value": "agent:implement" }),
      ).toHaveLength(0);
      expect(indicatedOptions()).toEqual([]);

      await act(() => selectOption("agent:plan").props.onClick());

      expect(definition.steps[1]).toMatchObject({ reworkStepId: "plan" });
      expect(visibleText(reworkPicker())).toBe("Plan Step 1");
      expect(reworkPicker().props["aria-invalid"]).toBeUndefined();
      expect(renderer!.root.findAllByProps({ id: issueId })).toHaveLength(0);
    },
  );

  it("shows how to unblock a Review with no earlier Agent", async () => {
    const [plan, , review] = original.steps;
    if (review?.kind !== "review") throw new Error("Expected Review fixture.");
    await mount({
      initial: { ...original, steps: [{ ...review, reworkStepId: undefined }, plan!] },
      selection: "review",
    });

    expect(inspectorDetails()["Saved result to review"]).toBe("No earlier Agent");
    expect(visibleText(renderer!.root)).toContain("Add an Agent step before Review.");
    expect(reworkPicker().props.disabled).toBe(false);
    expect(reworkPicker().props["aria-readonly"]).toBe(true);

    await openReworkPicker();

    expect(reworkPicker().props["aria-expanded"]).toBe(false);
    expect(renderer!.root.findAllByProps({ role: "listbox" })).toHaveLength(0);

    await click("Move down");

    expect(inspectorDetails()["Saved result to review"]).toBe("Plan Step 1");
    expect(visibleText(reworkPicker())).toBe("Previous Agent step Currently Plan Step 1");
    expect(reworkPicker().props["aria-invalid"]).toBeUndefined();
    expect(reworkPicker().props["aria-readonly"]).toBeUndefined();

    await openReworkPicker();

    expect(reworkPicker().props["aria-expanded"]).toBe(true);
    await act(() => selectOption("agent:plan").props.onClick());
    expect(definition.steps[1]).toMatchObject({ reworkStepId: "plan" });
  });

  it("updates Open PR readiness when a Push branch follows its latest Agent", async () => {
    await mount({
      initial: {
        ...original,
        steps: [
          original.steps[0]!,
          { id: "push", kind: "action", title: "Push the release", action: "push" },
          original.steps[1]!,
          {
            id: "open-pr",
            kind: "action",
            title: "Publish the changes",
            action: "open_pull_request",
          },
        ],
      },
      selection: "open-pr",
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Push branch step required");
    expect(
      renderer!.root.findAllByType("p").some((node) => node.props.children === "Open PR"),
    ).toBe(true);

    await click("Move up");

    expect(selectedId).toBe("open-pr");
    expect(definition.steps.map((step) => step.id)).toEqual([
      "plan",
      "push",
      "open-pr",
      "implement",
    ]);
    const updated = JSON.stringify(renderer!.toJSON());
    expect(updated).toContain("Ready");
    expect(updated).toContain("Push the release");
    expect(updated).not.toContain("Push branch step required");
  });

  it("provides a checkout recovery before showing a renamed Push branch as ready", async () => {
    const fixture = {
      initial: {
        ...original,
        steps: [
          original.steps[0]!,
          { id: "push", kind: "action", title: "Publish the release", action: "push" },
        ],
      },
      selection: "push",
    } satisfies Parameters<typeof Harness>[0];
    await mount({ ...fixture, machineCheckoutAvailable: false });
    expect(
      renderer!.root.findAllByType("p").some((node) => node.props.children === "Push branch"),
    ).toBe(true);
    const warning = renderer!.root.findByProps({
      role: "group",
      "aria-label": "Machine checkout unavailable",
    });
    expect(warning.props.tabIndex).toBe(-1);
    const descriptionId = warning.props["aria-describedby"];
    expect(warning.findByProps({ id: descriptionId }).props.children).toBe(
      "Choose an available Machine checkout to publish.",
    );
    expect(
      warning
        .findAllByType("button")
        .some(
          (button) =>
            !button.props.disabled &&
            button.props["aria-describedby"] === descriptionId &&
            button.children.includes("Open workflow settings"),
        ),
    ).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Ready");

    await act(() => renderer!.update(<Harness {...fixture} machineCheckoutAvailable />));

    expect(selectedId).toBe("push");
    const readyInspector = visibleText(renderer!.root);
    expect(readyInspector).toContain("Ready");
    expect(inspectorDetails()["Execution target"]).toBe("Machine");
    expect(readyInspector).not.toContain("Machine checkout unavailable");
    expect(readyInspector).not.toContain("GitHub access pending verification");
  });

  it.each([
    {
      workflow: "only pushes a branch",
      steps: vmPublishing.steps.slice(0, -1),
      access: "Contents write",
    },
    {
      workflow: "also opens a pull request",
      steps: vmPublishing.steps,
      access: "Contents write Pull requests write",
    },
  ])(
    "shows the VM Push branch prerequisite and run access when the workflow $workflow",
    async ({ steps, access }) => {
      await mount({
        initial: { ...vmPublishing, steps },
        selection: "push",
        machineCheckoutAvailable: false,
      });

      expect(inspectorDetails()).toEqual({
        "Execution target": "VM",
        "Saved result": "Implement",
        "GitHub App access for the run": access,
      });
      const inspector = visibleText(renderer!.root);
      expect(inspector).toContain("Step configured");
      expect(inspector).toContain("GitHub access pending verification");
      expect(inspector).toContain("GitHub access is checked when the run starts.");
      expect(inspector).not.toContain("Ready");
    },
  );

  it.each([
    ["release/2.x", "release/2.x"],
    [null, "Repository default"],
    ["   ", "Repository default"],
  ])(
    "shows the VM Open PR destination when the base branch is %s",
    async (baseBranch, expected) => {
      await mount({
        initial: { ...vmPublishing, target: { kind: "vm", baseBranch } },
        selection: "pr",
        machineCheckoutAvailable: false,
      });

      expect(inspectorDetails()).toEqual({
        "Execution target": "VM",
        "Publishes after": "Push the release",
        "Base branch": expected,
        "GitHub App access for the run": "Contents write Pull requests write",
      });
      const inspector = visibleText(renderer!.root);
      expect(inspector).toContain("Step configured");
      expect(inspector).toContain("GitHub access pending verification");
      expect(inspector).toContain("GitHub access is checked when the run starts.");
    },
  );

  it("edits the VM Push commit subject and clears it back to the default", async () => {
    await mount({ initial: vmPublishing, selection: "push" });
    const field = () =>
      renderer!.root
        .findAllByType("input")
        .find((node) => node.props["data-workflow-field"] === "commitSubject")!;
    const template = "fix({{issueKey}}): update {{workflowName}}";
    await act(() => field().props.onChange({ target: { value: template } }));
    expect(definition.steps.find((step) => step.id === "push")).toMatchObject({
      commitSubject: template,
    });
    await act(() => field().props.onChange({ target: { value: "" } }));
    expect(field().props.value).toBe("");
    expect(definition.steps.find((step) => step.id === "push")).toMatchObject({
      commitSubject: undefined,
    });
  });

  it("offers to repair an Open PR step on a VM without a Machine checkout", async () => {
    await mount({
      initial: {
        ...original,
        target: { kind: "vm", baseBranch: null },
        steps: [
          original.steps[0]!,
          { id: "pr", kind: "action", title: "Open PR", action: "open_pull_request" },
        ],
      },
      selection: "pr",
      machineCheckoutAvailable: false,
    });
    const blockedInspector = visibleText(renderer!.root);
    expect(blockedInspector).toContain("Push branch step required");
    expect(blockedInspector).not.toContain("Step configured");
    expect(blockedInspector).not.toContain("GitHub access pending verification");
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Add Push branch")),
    ).toBe(true);
  });

  it("keeps an unverified saved VM model visible and allows returning to the managed default", async () => {
    const [plan, implement, review] = original.steps;
    if (implement?.kind !== "agent" || !plan || !review)
      throw new Error("Expected Agent fixtures.");
    const saved = { instanceId: workflowVmCodexInstanceId, model: "saved-model" };
    await mount({
      initial: {
        ...original,
        target: { kind: "vm", baseBranch: null },
        steps: [plan, { ...implement, modelSelection: saved }, review],
      },
    });

    const warning = renderer!.root.findByProps({
      role: "group",
      "aria-label": "Saved model unverified",
    });
    expect(warning.props.tabIndex).toBe(-1);
    expect(visibleText(warning)).toContain("saved-model");
    const [issueId, approvalsId] = warning.props["aria-describedby"].split(" ");
    expect(visibleText(renderer!.root.findByProps({ id: issueId }))).toContain(
      "A verified VM model catalog is required to keep this model.",
    );
    expect(visibleText(renderer!.root.findByProps({ id: approvalsId }))).toBe("Approvals required");
    expect(button("Choose another model")).toBeUndefined();
    expect(definition.steps[1]).toMatchObject({ modelSelection: saved });

    await click("Use managed default");

    expect(definition.steps[1]).toMatchObject({ modelSelection: null });
    expect(visibleText(renderer!.root)).toContain("Managed default unverified");
    expect(visibleText(renderer!.root)).not.toContain("saved-model");
  });

  it("shows the current VM default and keeps it distinct from an explicit model choice", async () => {
    await mount({
      initial: { ...original, target: { kind: "vm", baseBranch: null } },
      vmModels: {
        defaultModel: WORKFLOW_VM_DEFAULT_CODEX_MODEL,
        models: [
          {
            name: "Managed Codex Stable",
            slug: WORKFLOW_VM_DEFAULT_CODEX_MODEL,
            isCustom: false,
            capabilities: null,
          },
          { name: "Verified model", slug: "verified-model", isCustom: false, capabilities: null },
        ],
      },
    });

    expect(visibleText(button("Managed Codex model, Managed default"))).toContain(
      "Managed default",
    );
    expect(visibleText(renderer!.root)).toContain("Currently Managed Codex Stable");
    expect(definition.steps[1]).toMatchObject({ modelSelection: null });

    await click("Managed Codex model, Managed default");
    await act(() => selectOption("model:verified-model").props.onClick());

    expect(definition.steps[1]).toMatchObject({
      modelSelection: { instanceId: workflowVmCodexInstanceId, model: "verified-model" },
    });
    expect(visibleText(button("Managed Codex model, Verified model"))).toBe("Verified model");
  });

  it("shows the checkout default and explains a model blocked by conversation continuation", async () => {
    connectMachine();
    await mount();

    expect(visibleText(button("Machine model, Project default"))).toContain("Project default");
    expect(visibleText(renderer!.root)).toMatch(/Currently.*Project model/);

    await click("Machine model, Project default");

    const alternate = button("Alternate model");
    expect(alternate.props.disabled).toBe(true);
    expect(visibleText(alternate)).toContain(
      "This provider cannot change models or instances within the shared conversation.",
    );
    expect(definition.steps[1]).toMatchObject({ modelSelection: null });
  });

  it("keeps a saved Machine model visible and requires a compatible replacement when the default conflicts", async () => {
    connectMachine();
    const [plan, implement, review] = original.steps;
    if (plan?.kind !== "agent" || implement?.kind !== "agent" || !review)
      throw new Error("Expected Agent fixtures.");
    const replacement = { instanceId: machineProvider.instanceId, model: "alternate-model" };
    const saved = { instanceId: machineProvider.instanceId, model: "retired-model" };
    await mount({
      initial: {
        ...original,
        steps: [
          { ...plan, modelSelection: replacement },
          { ...implement, modelSelection: saved },
          review,
        ],
      },
    });

    expect(visibleText(renderer!.root)).toContain("Saved model unavailable");
    expect(visibleText(renderer!.root)).toContain("retired-model");
    expect(visibleText(button("Choose another model"))).toBe("Choose another model");
    expect(button("Use project default")).toBeUndefined();
    expect(definition.steps[1]).toMatchObject({ modelSelection: saved });

    await click("Choose another model");
    expect(button("Project model").props.disabled).toBe(true);
    expect(button("Project default").props.disabled).toBe(true);
    await click("Alternate model");

    expect(definition.steps[1]).toMatchObject({ modelSelection: replacement });
    expect(visibleText(renderer!.root)).not.toContain("retired-model");
  });
  it("retains the selected identity and explicit rework target after moving an Agent", async () => {
    await mount();
    expect(visibleText(button("Move up"))).toBe("Move up Above Plan Step 1");
    expect(visibleText(button("Move down"))).toBe("Move down Below Review Step 3");

    await click("Move up");

    expect(button("Move up").props.disabled).toBe(true);
    expect(visibleText(button("Move up"))).toBe("Move up Already the first step");
    expect(visibleText(button("Move down"))).toBe("Move down Below Plan Step 2");
    expect(
      renderer!.root
        .findAllByType("span")
        .some((node) => node.props["aria-live"] === "polite" && visibleText(node) === "Step 1"),
    ).toBe(true);
    expect(definition.steps.map((step) => step.id)).toEqual(["implement", "plan", "review"]);
    expect(selectedId).toBe("implement");
    expect(definition.steps[2]).toMatchObject({ reworkStepId: "implement" });
    await act(() =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "Build change" } }),
    );
    expect(definition.steps[0]?.title).toBe("Build change");
    expect(definition.steps[1]?.title).toBe("Plan");
  });
  it("leaves the selected step intact when requesting removal from Step actions", async () => {
    await mount({ selection: "implement" });

    await click("Remove step");

    expect(requestRemoval).toHaveBeenCalledExactlyOnceWith(original.steps[1]);
    expect(selectedId).toBe("implement");
    expect(definition.steps).toEqual(original.steps);
  });
  it("never falls back to editing the first step for an absent selection", async () => {
    await mount({ selection: "missing" });
    expect(renderer!.root.findAllByType("input")).toHaveLength(0);
    expect(definition).toEqual(original);
  });
});
