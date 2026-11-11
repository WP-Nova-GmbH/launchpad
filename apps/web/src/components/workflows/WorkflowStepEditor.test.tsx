import { act, createElement, useLayoutEffect, useState, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
vi.mock("../ui/select", () => {
  const component = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Select: ({ children, ...props }: PropsWithChildren) =>
      createElement("div", { ...props, "data-workflow-model-select": true }, children),
    SelectTrigger: component,
    SelectValue: component,
    SelectPopup: component,
    SelectItem: component,
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
let renderer: ReactTestRenderer | undefined;
let definition: WorkflowDefinition = original;
let selectedId = "";
function Harness({
  initial = original,
  selection = "implement",
  vmModels = null,
}: {
  initial?: WorkflowDefinition;
  selection?: string;
  vmModels?: WorkflowVmModelCatalog | null;
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
      disabled={false}
      close={() => select("")}
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
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("Workflow step editing", () => {
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
    expect(definition.steps[1]).toMatchObject({
      modelSelection: { instanceId: workflowVmCodexInstanceId, model: "saved-model" },
    });
    await click("Use managed default");
    expect(definition.steps[1]).toMatchObject({ modelSelection: null });
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
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose an earlier Agent step.");
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
