import { act, createElement, useLayoutEffect, useState, type PropsWithChildren } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import { workflowDraftIssue } from "@t3tools/client-runtime/relay/workflow-session";
import { workflowVmCodexInstanceId } from "../settings/workflowModels";

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
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
vi.mock("../../state/environments", () => ({ useEnvironment: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
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
let renderer: ReactTestRenderer | undefined;
let definition: WorkflowDefinition = original;
let selectedId = "";
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
      select={select}
      change={change}
      move={change}
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
async function click(label: string) {
  await act(() =>
    renderer!.root
      .findAllByType("button")
      .find((node) => node.props.children === label)!
      .props.onClick(),
  );
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
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
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
    const error = renderer!.root.findByProps({ "aria-live": "polite" });
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

  it("keeps an unavailable VM model visible and allows returning to the managed default", async () => {
    const current = original.steps[1]!;
    if (current.kind !== "agent") throw new Error("Expected the Agent step fixture.");
    await mount({
      initial: {
        ...original,
        target: { kind: "vm", baseBranch: null },
        steps: [
          original.steps[0]!,
          {
            ...current,
            modelSelection: { instanceId: workflowVmCodexInstanceId, model: "saved-model" },
          },
          original.steps[2]!,
        ],
      },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("saved-model (Unverified)");
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Select the managed default before saving",
    );
    const picker = () => renderer!.root.findByProps({ "aria-label": "Managed Codex model" });
    const [issueId, approvalsId] = picker().props["aria-describedby"].split(" ");
    expect(picker().props["aria-invalid"]).toBe(true);
    expect(renderer!.root.findByProps({ id: issueId }).props.children).toContain(
      "Select the managed default before saving",
    );
    expect(definition.steps[1]).toMatchObject({
      modelSelection: { instanceId: workflowVmCodexInstanceId, model: "saved-model" },
    });
    await click("Use managed default");
    expect(definition.steps[1]).toMatchObject({ modelSelection: null });
    expect(picker().props["aria-invalid"]).toBeUndefined();
    expect(picker().props["aria-describedby"]).toBe(approvalsId);
  });

  it("selects explicit models using the managed Codex instance", async () => {
    await mount({
      initial: { ...original, target: { kind: "vm", baseBranch: null } },
      vmModels: {
        defaultModel: "verified-model",
        models: [
          { name: "Verified model", slug: "verified-model", isCustom: false, capabilities: null },
        ],
      },
    });
    await act(() =>
      renderer!.root
        .findByProps({ "data-workflow-model-select": true })
        .props.onValueChange("model:verified-model"),
    );
    expect(definition.steps[1]).toMatchObject({
      modelSelection: { instanceId: workflowVmCodexInstanceId, model: "verified-model" },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Verified model");
  });
  it("retains the selected identity and explicit rework target after moving an Agent", async () => {
    await mount();
    await click("Move up");
    expect(definition.steps.map((step) => step.id)).toEqual(["implement", "plan", "review"]);
    expect(selectedId).toBe("implement");
    expect(definition.steps[2]).toMatchObject({ reworkStepId: "implement" });
    await act(() =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "Build change" } }),
    );
    expect(definition.steps[0]?.title).toBe("Build change");
    expect(definition.steps[1]?.title).toBe("Plan");
  });
  it("keeps invalidated rework IDs visible rather than retargeting after removal", async () => {
    await mount();
    await click("Remove step");
    expect(selectedId).toBe("review");
    expect(definition.steps.map((step) => step.id)).toEqual(["plan", "review"]);
    expect(definition.steps[1]).toMatchObject({ reworkStepId: "implement" });
    expect(workflowDraftIssue(definition)).toMatchObject({ stepId: "review", field: "rework" });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Unavailable Agent step");
    expect(visibleText(renderer!.root)).toContain(
      "The saved Agent is no longer available. Choose an earlier Agent.",
    );
  });
  it("removing the last step leaves an explicit empty, invalid draft", async () => {
    await mount({ initial: { ...original, steps: [original.steps[0]!] }, selection: "plan" });
    await click("Remove step");
    expect(definition.steps).toEqual([]);
    expect(selectedId).toBe("");
    expect(workflowDraftIssue(definition)).not.toBeNull();
  });
  it("never falls back to editing the first step for an absent selection", async () => {
    await mount({ selection: "missing" });
    expect(renderer!.root.findAllByType("input")).toHaveLength(0);
    expect(definition).toEqual(original);
  });
});
