import {
  act,
  cloneElement,
  createContext,
  createElement,
  useContext,
  useState,
  useInsertionEffect,
  type ReactElement,
  type PropsWithChildren,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { workflowModelState } from "../settings/workflowModels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkflowStep } from "@t3tools/contracts/workflows";
import { WorkflowCanvas, workflowInsertionIndex } from "./WorkflowCanvas";

const first: WorkflowStep = {
  id: "first",
  kind: "agent",
  title: "Plan",
  instruction: "Plan",
  modelSelection: null,
};
const second: WorkflowStep = {
  id: "second",
  kind: "input",
  title: "Question",
  question: "Confirm?",
  role: "member",
};
const last: WorkflowStep = {
  id: "last",
  kind: "review",
  title: "Review",
  role: "maintainer",
  reworkStepId: "first",
};

describe("Workflow canvas insertion anchors", () => {
  it("follows the same step when its order changes while the menu is open", () => {
    const anchor = { after: second };
    expect(workflowInsertionIndex([first, second, last], anchor)).toBe(2);
    expect(workflowInsertionIndex([second, first, last], anchor)).toBe(1);
  });
  it("rejects removed and replaced anchors, including a reloaded step with the same ID", () => {
    const anchor = { after: second };
    expect(workflowInsertionIndex([first, last], anchor)).toBeNull();
    expect(workflowInsertionIndex([first, { ...second }, last], anchor)).toBeNull();
  });
  it("resolves start/end against the current sequence, including an empty draft", () => {
    expect(workflowInsertionIndex([], { edge: "start" })).toBe(0);
    expect(workflowInsertionIndex([], { edge: "end" })).toBe(0);
    expect(workflowInsertionIndex([first, last], { edge: "start" })).toBe(0);
    expect(workflowInsertionIndex([first, second, last], { edge: "end" })).toBe(3);
  });
});

vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/menu", () => {
  type MenuProps = PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  return {
    Menu: ({ children, open, onOpenChange }: MenuProps) =>
      createElement(Context.Provider, { value: { open, onOpenChange } }, children),
    MenuTrigger: ({
      render,
      children,
      ...props
    }: PropsWithChildren<{
      render: ReactElement<Record<string, unknown>>;
      disabled?: boolean;
    }>) => {
      const { open, onOpenChange } = useContext(Context);
      return cloneElement(
        render,
        {
          ...props,
          onClick: () => {
            if (!props.disabled) onOpenChange(!open);
          },
        },
        children,
      );
    },
    MenuPopup: ({ children }: PropsWithChildren) =>
      useContext(Context).open ? createElement("div", { role: "menu" }, children) : null,
    MenuItem: (props: Record<string, unknown>) =>
      createElement("button", { ...props, role: "menuitem" }),
    MenuSeparator: () => createElement("hr"),
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
let renderer: ReactTestRenderer | undefined;
const overview = vi.fn();
const insert = vi.fn();
async function mountCanvas(
  steps: ReadonlyArray<WorkflowStep> = [first, second, last],
  selectedStepId = "",
) {
  const definition = {
    name: "Zoom example",
    target: {
      kind: "machine" as const,
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("project"),
    },
    steps,
  };
  await act(() => {
    renderer = create(
      <WorkflowCanvas
        definition={definition}
        selectedStepId={selectedStepId}
        invalidStepId={null}
        models={workflowModelState(definition, [], DEFAULT_UNIFIED_SETTINGS, null, false)}
        pending={false}
        onSelect={() => {}}
        onReorder={() => false}
        onInsert={insert}
        onOverview={overview}
        panelOpen={false}
      />,
    );
  });
}
async function zoom(label: string, times: number) {
  await act(() => {
    for (let i = 0; i < times; i++)
      renderer!.root.findByProps({ "aria-label": label }).props.onClick();
  });
}
const zoomLabel = () => renderer!.root.findByType("output").children.join("");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  overview.mockReset();
  insert.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("Workflow canvas zoom controls", () => {
  it("bounds repeated zoom gestures to a readable range", async () => {
    await mountCanvas();
    await zoom("Zoom out", 10);
    expect(zoomLabel()).toBe("85%");
    await zoom("Zoom in", 20);
    expect(zoomLabel()).toBe("125%");
  });
  it("overview restores the default diagram scale", async () => {
    await mountCanvas();
    await zoom("Zoom in", 3);
    expect(zoomLabel()).toBe("115%");
    await zoom("Show workflow overview", 1);
    expect(zoomLabel()).toBe("100%");
  });
});

describe("Add a step picker", () => {
  const push: WorkflowStep = { id: "push", kind: "action", title: "Push branch", action: "push" };
  const visibleText = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : visibleText(child))).join("");
  const menu = () => renderer!.root.findByProps({ role: "menu" });
  const menuTextElements = () =>
    menu()
      .findAll((node) => typeof node.type === "string")
      .map(visibleText);
  const option = (name: string) =>
    menu()
      .findAllByType("button")
      .find((item) => item.props["aria-label"] === name)!;
  const openPicker = (name: string) =>
    act(() =>
      renderer!.root
        .findAllByType("button")
        .find((item) => item.props["aria-label"] === name)!
        .props.onClick(),
    );

  it("shows unmet prerequisites after Trigger and still allows all five insertions", async () => {
    await mountCanvas();

    const choices = [
      ["Agent step", "agent"],
      ["Human input", "input"],
      ["Human review", "review"],
      ["Push branch", "action"],
      ["Open PR", "open_pull_request"],
    ] as const;
    for (const [label, kind] of choices) {
      await openPicker("Insert step at position 1");

      expect(visibleText(menu())).toContain("After Trigger");
      expect(visibleText(option("Human review"))).toContain("Needs an earlier Agent step.");
      expect(visibleText(option("Push branch"))).toContain("Needs an earlier Agent step.");
      expect(visibleText(option("Open PR"))).toContain("Needs an Agent followed by Push branch.");
      expect(option(label).props.disabled).toBeFalsy();

      await act(() => option(label).props.onClick());
      expect(insert).toHaveBeenLastCalledWith({ edge: "start" }, kind);
      expect(renderer!.root.findAllByProps({ role: "menu" })).toHaveLength(0);
    }
    expect(insert).toHaveBeenCalledTimes(choices.length);
  });

  it("distinguishes the trigger and numbered anchors even when step titles contain step numbers", async () => {
    const titleWithNumber = { ...first, title: "Trigger (step 2)" };
    const namedTrigger = { ...first, id: "named-trigger", title: "Trigger" };
    await mountCanvas([titleWithNumber, namedTrigger], namedTrigger.id);

    await openPicker("Insert step at position 1");
    expect(menuTextElements()).toContain("After Trigger");
    await act(() => option("Human input").props.onClick());
    expect(insert).toHaveBeenNthCalledWith(1, { edge: "start" }, "input");

    await openPicker("Insert step after Trigger (step 2) (position 2)");
    expect(menuTextElements()).toEqual(
      expect.arrayContaining(["After step 1", "Trigger (step 2)"]),
    );
    expect(visibleText(option("Open PR"))).toContain("Needs Push branch after step 1.");
    await act(() => option("Human input").props.onClick());
    expect(insert).toHaveBeenNthCalledWith(2, { after: titleWithNumber }, "input");

    await openPicker("Add a step after Trigger");
    expect(menuTextElements()).toEqual(expect.arrayContaining(["After step 2", "Trigger"]));
    expect(visibleText(option("Open PR"))).toContain("Needs Push branch after step 2.");
    await act(() => option("Human input").props.onClick());
    expect(insert).toHaveBeenNthCalledWith(3, { after: namedTrigger }, "input");
  });

  it("identifies the Agent that needs a Push branch when inserting after a later step", async () => {
    await mountCanvas([first, second], second.id);

    await openPicker("Add a step after Question");

    expect(menuTextElements()).toEqual(expect.arrayContaining(["After step 2", "Question"]));
    expect(visibleText(option("Open PR"))).toContain("Needs Push branch after step 1.");
    await act(() => option("Open PR").props.onClick());
    expect(insert).toHaveBeenCalledExactlyOnceWith({ after: second }, "open_pull_request");
  });

  it("offers to open a pull request from the branch pushed after the latest Agent", async () => {
    await mountCanvas([first, push], push.id);

    await openPicker("Add a step after Push branch");

    expect(menuTextElements()).toEqual(expect.arrayContaining(["After step 2", "Push branch"]));
    expect(visibleText(option("Open PR"))).toContain("Open a pull request from the pushed branch.");
    await act(() => option("Open PR").props.onClick());
    expect(insert).toHaveBeenCalledExactlyOnceWith({ after: push }, "open_pull_request");
  });

  it("checks Open PR against the latest Agent when an earlier same-named Agent has a Push branch", async () => {
    const latest = { ...first, id: "build" };
    await mountCanvas([first, push, latest], latest.id);

    await openPicker("Add a step after Plan");

    expect(menuTextElements()).toEqual(expect.arrayContaining(["After step 3", "Plan"]));
    expect(visibleText(option("Open PR"))).toContain("Needs Push branch after step 3.");
    expect(visibleText(option("Open PR"))).not.toContain("from the pushed branch");
  });
});

const resizeCallbacks = new Set<() => void>();
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, ...props }: PropsWithChildren) =>
    createElement("div", { ...props, "data-testid": "drag-context" }, children),
  KeyboardSensor: () => {},
  PointerSensor: () => {},
  useSensor: () => null,
  useSensors: () => [],
}));
vi.mock("@dnd-kit/sortable", async () => ({
  ...(await vi.importActual("@dnd-kit/sortable")),
  SortableContext: ({ children }: PropsWithChildren) => children,
  useSortable: ({ id }: { id: string }) => ({
    setNodeRef: (node: { stepId: string } | null) => {
      if (node) node.stepId = id;
    },
    setActivatorNodeRef: () => {},
    transform: null,
    attributes: {},
    listeners: undefined,
    isDragging: false,
  }),
}));
let currentSteps: ReadonlyArray<WorkflowStep> = [];
let currentSelection = "first";
let changeSteps: (steps: ReadonlyArray<WorkflowStep>) => void;
let changeSelection: (id: string) => void;
let moveSelected: (steps: ReadonlyArray<WorkflowStep>) => void;
let scrollTop = 0;
const scrollViewport = {
  get scrollTop() {
    return scrollTop;
  },
  set scrollTop(value: number) {
    scrollTop = Math.max(0, value);
  },
  height: 300,
  getBoundingClientRect: () => ({ top: 0, bottom: scrollViewport.height }),
  scrollTo: ({ top }: { top: number }) => {
    scrollViewport.scrollTop = top;
  },
};
const longSteps: ReadonlyArray<WorkflowStep> = Array.from({ length: 32 }, (_, index) => {
  const id = index === 0 ? "first" : `step-${index}`;
  return index % 5 === 1
    ? { id, kind: "input", title: `Question ${index}`, question: "Confirm?", role: "member" }
    : index % 5 === 4
      ? { id, kind: "review", title: `Review ${index}`, role: "maintainer" }
      : { id, kind: "agent", title: `Agent ${index}`, instruction: "Work", modelSelection: null };
});
function ScrollHarness({
  accept = true,
  pending = false,
  replaced = false,
}: {
  accept?: boolean;
  pending?: boolean;
  replaced?: boolean;
}) {
  const [steps, setSteps] = useState(longSteps);
  const [selection, setSelection] = useState("first");
  const [movementVersion, setMovementVersion] = useState(0);
  useInsertionEffect(() => {
    currentSteps = steps;
    currentSelection = selection;
    changeSteps = setSteps;
    changeSelection = setSelection;
    moveSelected = (next) => {
      setSteps(next);
      setMovementVersion((version) => version + 1);
    };
  }, [steps, selection]);
  const definition = {
    name: "Long workflow",
    target: {
      kind: "machine" as const,
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("project"),
    },
    steps,
  };
  return (
    <WorkflowCanvas
      definition={definition}
      selectedStepId={selection}
      invalidStepId={null}
      models={workflowModelState(definition, [], DEFAULT_UNIFIED_SETTINGS, null, false)}
      pending={pending}
      onSelect={setSelection}
      onReorder={(next) => {
        if (!accept) return false;
        setSteps(replaced ? longSteps.map((step) => ({ ...step })) : next);
        return true;
      }}
      onInsert={() => {}}
      onOverview={() => setSelection("")}
      panelOpen
      movementVersion={movementVersion}
    />
  );
}
async function mountScrolling(props: Parameters<typeof ScrollHarness>[0] = {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  scrollViewport.scrollTop = 0;
  scrollViewport.height = 300;
  await act(() => {
    renderer = create(<ScrollHarness {...props} />, {
      createNodeMock: (element) => {
        const props = element.props as Record<string, unknown>;
        if (props["aria-label"] === "Scrollable workflow canvas") return scrollViewport;
        if (String(props.className).includes("workflow-node-wrap")) {
          const node = {
            stepId: "",
            getBoundingClientRect: () => {
              const index = currentSteps.findIndex((step) => step.id === node.stepId);
              return {
                top: index * 140 - scrollViewport.scrollTop,
                bottom: index * 140 + 70 - scrollViewport.scrollTop,
              };
            },
          };
          return node;
        }
        return null;
      },
    });
  });
}
async function drop(active = "step-27", over: string | null = "step-28") {
  await act(() =>
    renderer!.root
      .findByProps({ "data-testid": "drag-context" })
      .props.onDragEnd({ active: { id: active }, over: over ? { id: over } : null }),
  );
}
const movedBounds = () => {
  const top =
    currentSteps.findIndex((step) => step.id === "step-27") * 140 - scrollViewport.scrollTop;
  return { top, bottom: top + 70 };
};
describe("Workflow canvas reveal ownership", () => {
  it("keeps a distant moved node visible after the commit and a deferred viewport resize", async () => {
    await mountScrolling();
    scrollViewport.scrollTop = 3700;
    await drop();
    expect(currentSteps[28]?.id).toBe("step-27");
    expect(currentSelection).toBe("first");
    expect(movedBounds().top).toBeGreaterThanOrEqual(16);
    expect(movedBounds().bottom).toBeLessThanOrEqual(scrollViewport.height - 16);
    // A cleared error banner increases the canvas height after the reorder commit.
    scrollViewport.height = 450;
    await act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(scrollViewport.scrollTop).toBeGreaterThan(3500);
    expect(movedBounds().bottom).toBeLessThanOrEqual(scrollViewport.height - 16);
  });
  it("adjusts an offscreen destination without changing inspector selection", async () => {
    await mountScrolling();
    scrollViewport.scrollTop = 3500;
    await drop();
    expect(movedBounds().bottom).toBe(scrollViewport.height - 16);
    expect(currentSelection).toBe("first");
  });
  it("does not reveal the unrelated selection on ordinary instruction edits", async () => {
    await mountScrolling();
    scrollViewport.scrollTop = 3700;
    await act(() =>
      changeSteps(
        currentSteps.map((step) =>
          step.id === "first" && step.kind === "agent"
            ? { ...step, instruction: "Edited instructions" }
            : step,
        ),
      ),
    );
    expect(scrollViewport.scrollTop).toBe(3700);
  });
  it.each([{ accept: false }, { pending: true }])(
    "does not claim a rejected or pending drop (%j)",
    async (props) => {
      await mountScrolling(props);
      scrollViewport.scrollTop = 3700;
      await drop();
      expect(currentSteps[27]?.id).toBe("step-27");
      expect(scrollViewport.scrollTop).toBe(3700);
      await act(() => changeSteps([...currentSteps]));
      expect(scrollViewport.scrollTop).toBe(3700);
    },
  );
  it("leaves no reveal request after same-position, absent-target and cancelled gestures", async () => {
    await mountScrolling();
    scrollViewport.scrollTop = 3700;
    await drop("step-27", "step-27");
    await drop("step-27", null);
    await act(() =>
      renderer!.root.findByProps({ "data-testid": "drag-context" }).props.onDragCancel?.(),
    );
    await act(() => changeSteps([...currentSteps]));
    expect(scrollViewport.scrollTop).toBe(3700);
  });
  it("discards a reveal when the accepted sequence was replaced before rendering", async () => {
    await mountScrolling({ replaced: true });
    scrollViewport.scrollTop = 3700;
    await drop();
    expect(currentSteps[27]?.id).toBe("step-27");
    expect(scrollViewport.scrollTop).toBe(3700);
    await act(() => changeSteps([...currentSteps]));
    expect(scrollViewport.scrollTop).toBe(3700);
  });
  it("returns reveal ownership to a deliberate selection, movement or overview", async () => {
    await mountScrolling();
    scrollViewport.scrollTop = 3700;
    await drop();
    await act(() => changeSelection("step-1"));
    expect(scrollViewport.scrollTop).toBeLessThan(200);
    scrollViewport.scrollTop = 3700;
    await act(() => moveSelected([currentSteps[1]!, currentSteps[0]!, ...currentSteps.slice(2)]));
    expect(scrollViewport.scrollTop).toBe(0);
    await zoom("Show workflow overview", 1);
    await act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(scrollViewport.scrollTop).toBe(0);
    expect(currentSelection).toBe("");
  });
});
