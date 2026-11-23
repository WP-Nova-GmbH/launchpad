vi.mock("./WorkflowSources", () => ({ RepositorySourcesButton: () => null }));
vi.mock("./WorkflowEditorDepartureGuard", () => ({ WorkflowEditorDepartureGuard: () => null }));
import {
  act,
  cloneElement,
  createElement,
  useLayoutEffect,
  useRef,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { Route as NewWorkflowRoute } from "../../routes/workflows.$repositoryId.new";
import { Route as EditWorkflowRoute } from "../../routes/workflows.$repositoryId.$workflowId.edit";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  WORKFLOW_MAX_STEPS,
  workflowPublishingPrerequisites,
  type RepositoryWorkflow,
  type WorkflowStep,
} from "@t3tools/contracts/workflows";
import {
  RelayMachineId,
  RelayRepositoryId,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import {
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowDraftIssue,
  workflowSessionKey,
  setWorkflowSessionAccount,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStepEditor } from "./WorkflowStepEditor";

type StepProps = Parameters<typeof WorkflowStepEditor>[0];
class FocusNode {
  isConnected = true;
  disabled = false;
  value = "";
  scrollTop = 0;
  focusOptions: FocusOptions | undefined;
  constructor(private readonly attributes: Record<string, unknown> = {}) {}
  getAttribute(name: string) {
    const value = this.attributes[name];
    return typeof value === "string" ? value : null;
  }
  get ownerDocument() {
    return focusDocument;
  }
  focus(options?: FocusOptions) {
    focusDocument.activeElement = this;
    this.focusOptions = options;
  }
  matches() {
    return this.disabled;
  }
}
class TextField extends FocusNode {
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  setSelectionRange(
    start: number,
    end: number,
    direction: typeof this.selectionDirection = "none",
  ) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}
const focusDocument = {
  activeElement: null as FocusNode | null,
  body: new FocusNode(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: () => null,
};
const nodes = new Map<string, FocusNode>();
const cache = new Map<string, FocusNode>();
let triggerButton: FocusNode;
let width = 1200;
let presentation = 0;
let resize: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined;
let completeOpening: ((open: boolean) => void) | undefined;
let dismissSheet: ((open: boolean) => void) | undefined;
let initialSheetFocus: (() => boolean | HTMLElement | null | void) | undefined;

function runInitialFocus(callback: NonNullable<typeof initialSheetFocus>) {
  const target = callback();
  if (target === true)
    nodes
      .get(draft().selectedStepId ? `${draft().selectedStepId}:title` : "close-settings")
      ?.focus();
  else if (target && typeof target !== "boolean") target.focus();
}

let renderWorkflowRoute: ((workflowId?: string) => ReactElement) | undefined;
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("./WorkflowsPage", () => {
  function EditorPage() {
    const params = useParams({ strict: false });
    return renderWorkflowRoute?.("workflowId" in params ? params.workflowId : undefined);
  }
  return { WorkflowEditorPage: EditorPage, WorkflowsPage: EditorPage };
});
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(false) }));
vi.mock("./WorkflowCanvas", async () => ({
  ...(await vi.importActual("./WorkflowCanvas")),
  WorkflowCanvas: (props: Parameters<typeof WorkflowCanvas>[0]) =>
    createElement(
      "div",
      { ...props, "data-testid": "canvas" },
      createElement("button", {
        "data-focus-key": "add-step",
        ref: props.addStepRef,
      }),
    ),
}));
vi.mock("./WorkflowTriggerInspector", async () => ({
  ...(await vi.importActual("./WorkflowTriggerInspector")),
  WorkflowTriggerInspector: ({ onClose, onSave }: { onClose: () => void; onSave: () => void }) =>
    createElement(
      "div",
      null,
      createElement("button", { "aria-label": "Close trigger settings", onClick: onClose }),
      createElement("button", { onClick: onSave }, "Save workflow"),
    ),
}));
const modelIssues = vi.hoisted(() =>
  vi.fn<() => { stepId: string; title: string; detail: string }[]>(),
);
vi.mock("./WorkflowStepEditor", () => ({
  useWorkflowEditorModels: () => ({ issues: modelIssues() }),
  WorkflowStepEditor: (props: StepProps) => {
    const step = props.definition.steps.find((entry) => entry.id === props.selectedId)!;
    const field = step.kind === "agent" ? "instruction" : "question";
    const { agent, push } = workflowPublishingPrerequisites(
      props.definition.steps,
      props.definition.steps.indexOf(step),
    );
    const needsMachine =
      props.definition.target.kind === "vm" ||
      !props.targetConfirmed ||
      !props.machineCheckoutAvailable;
    const needsPush =
      step.kind === "action" && step.action === "open_pull_request" && agent && !push;
    const blocked = step.kind === "action" && (needsMachine || !agent || needsPush);
    const repair =
      blocked && (needsMachine || needsPush)
        ? createElement(
            "button",
            {
              "data-focus-key": `${step.id}:repair`,
              disabled:
                props.disabled ||
                (!needsMachine && props.definition.steps.length >= WORKFLOW_MAX_STEPS),
              ref: (node: HTMLElement | null) => props.registerField("repair", node),
              onClick: needsMachine ? props.openWorkflowSettings : props.insertPushBranch,
            },
            needsMachine ? "Open workflow settings" : "Add Push branch",
          )
        : null;
    return createElement(
      "div",
      null,
      createElement("input", {
        "data-focus-key": `${step.id}:title`,
        ref: (node: HTMLElement | null) => props.registerField("title", node),
        value: step.title,
        disabled: props.disabled,
      }),
      step.kind === "review" || step.kind === "action"
        ? null
        : createElement("textarea", {
            "data-focus-key": `${step.id}:${field}`,
            ref: (node: HTMLElement | null) => props.registerField(field, node),
            value: step.kind === "agent" ? step.instruction : step.question,
            disabled: props.disabled,
            onChange: (event: { target: { value: string } }) =>
              props.change(
                props.definition.steps.map((entry) =>
                  entry.id === step.id ? { ...step, [field]: event.target.value } : entry,
                ),
              ),
          }),
      step.kind === "agent"
        ? createElement("button", {
            "data-focus-key": `${step.id}:model`,
            ref: (node: HTMLElement | null) => props.registerField("model", node),
          })
        : null,
      blocked
        ? createElement(
            "div",
            {
              tabIndex: -1,
              "data-focus-key": `${step.id}:repair-warning`,
              ref: (node: HTMLElement | null) => props.registerField("repair-warning", node),
            },
            repair,
          )
        : null,
      step.kind === "review"
        ? createElement("button", {
            "data-focus-key": `${step.id}:rework`,
            ref: (node: HTMLElement | null) => props.registerField("rework", node),
          })
        : null,
      createElement("button", {
        "aria-label": "Step actions",
        "data-focus-key": `${step.id}:actions`,
        ref: (node: HTMLElement | null) => props.registerField("actions", node),
      }),
      createElement("button", { "aria-label": "Close settings", onClick: props.close }),
      createElement("button", {
        "aria-label": "Move up from inspector",
        onClick: () => props.onRequestMove(step, -1),
      }),
      createElement("button", {
        "aria-label": "Move down from inspector",
        onClick: () => props.onRequestMove(step, 1),
      }),
      createElement("button", {
        "aria-label": "Remove step from inspector",
        onClick: () => props.onRequestRemove(step),
      }),
    );
  },
}));
vi.mock("../ui/alert-dialog", () => {
  type FocusTarget = { current: HTMLElement | null } | (() => HTMLElement | boolean | null);
  const readFocus = (target?: FocusTarget) =>
    typeof target === "function" ? target() : target?.current;
  const part = ({ children }: PropsWithChildren) => children;
  return {
    AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? createElement("section", { role: "alertdialog" }, children) : null,
    AlertDialogPopup: ({
      children,
      initialFocus,
      finalFocus,
    }: PropsWithChildren<{ initialFocus?: FocusTarget; finalFocus?: FocusTarget }>) => {
      const latestFinal = useRef(finalFocus);
      latestFinal.current = finalFocus;
      useLayoutEffect(() => {
        const opener = focusDocument.activeElement;
        queueMicrotask(() => {
          const target = readFocus(initialFocus);
          if (target && typeof target !== "boolean") target.focus();
        });
        return () => {
          queueMicrotask(() => {
            const target = readFocus(latestFinal.current);
            if (target === true) opener?.focus();
            else if (target) target.focus();
          });
        };
      }, []);
      return children;
    },
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: part,
  };
});
vi.mock("../ui/sheet", () => ({
  Sheet: ({
    open,
    children,
    onOpenChange,
    onOpenChangeComplete,
  }: PropsWithChildren<{
    open: boolean;
    onOpenChange: typeof dismissSheet;
    onOpenChangeComplete?: typeof completeOpening;
  }>) => {
    completeOpening = onOpenChangeComplete;
    dismissSheet = onOpenChange;
    return open ? children : null;
  },
  SheetPopup: ({
    children,
    initialFocus,
    finalFocus,
    inert,
  }: PropsWithChildren<{
    initialFocus: () => boolean | HTMLElement | null | void;
    finalFocus: () => boolean | HTMLElement | null | void;
    inert?: boolean;
  }>) => {
    initialSheetFocus = initialFocus;
    useLayoutEffect(() => {
      queueMicrotask(() => {
        runInitialFocus(initialFocus);
      });
      return () => {
        const target = finalFocus();
        queueMicrotask(() => {
          if (target && typeof target !== "boolean") target.focus();
        });
      };
    }, []);
    return createElement("div", { "data-testid": "inspector-sheet", inert }, children);
  },
  SheetTitle: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render?: ReactElement }>) =>
    render ? cloneElement(render, {}, children) : children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => {
  function ReviewQuestionButton(props: Record<string, unknown>) {
    useLayoutEffect(
      () => () => {
        const node = nodes.get("review-question");
        if (node) node.isConnected = false;
      },
      [],
    );
    return createElement("button", { ...props, "data-focus-key": "review-question" });
  }
  return {
    Button: (props: Record<string, unknown>) =>
      createElement(props.children === "Review question" ? ReviewQuestionButton : "button", props),
  };
});
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("../ui/combobox", () => {
  const component = ({ children }: PropsWithChildren) => children;
  return {
    Combobox: component,
    ComboboxTrigger: ({ render: _render, ...props }: Record<string, unknown>) =>
      createElement("button", { ...props, "data-focus-key": "checkout" }),
    ComboboxPopup: () => null,
    ComboboxSearchInput: () => null,
    ComboboxEmpty: () => null,
    ComboboxList: () => null,
    ComboboxItem: () => null,
  };
});
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children }: PropsWithChildren) => children,
  RadioGroupItem: ({ value, ...props }: Record<string, unknown>) =>
    createElement("span", { ...props, "data-focus-key": `target:${value}` }),
}));

import { WorkflowBuilder } from "./WorkflowBuilder";
import { editWorkflowDraft, newWorkflowDraft } from "./workflowState";
const scope = {
  accountId: "focus-account",
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
const openPrStep = {
  id: "open-pr",
  kind: "action",
  title: "Open PR",
  action: "open_pull_request",
} as const;
let renderer: ReactTestRenderer | undefined;
const id = () =>
  appAtomRegistry.get(workflowDraftAtom).newWorkflowIds[workflowSessionKey(scope, "new")]!;
const draft = () =>
  appAtomRegistry.get(workflowDraftAtom).editors[workflowSessionKey(scope, id())]!;
const canvas = () => renderer!.root.findByProps({ "data-testid": "canvas" });
const field = (key: string) => nodes.get(key)! as TextField;
const request = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("Unexpected request"));
const recoveryButton = (label: string) =>
  renderer!.root.findAllByType("button").find((button) => button.children.includes(label))!;
const reviewPublishingStep = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Review publishing step"))!;
async function mount(
  vm = false,
  {
    projects = vm ? [] : [project],
    automationSupported = false,
    useRoutes = false,
    workflow,
    openExecutionSettings = false,
  }: {
    projects?: ReadonlyArray<RelayOrganizationProject>;
    automationSupported?: boolean;
    useRoutes?: boolean;
    workflow?: RepositoryWorkflow;
    openExecutionSettings?: boolean;
  } = {},
) {
  const editor = (workflowId?: string) => (
    <AppAtomRegistryProvider>
      <WorkflowBuilder
        scope={scope}
        repositoryName="Repository"
        projects={projects}
        vmAuthoring={vm ? { models: null } : undefined}
        automationSupported={automationSupported}
        isNew={!workflow && !workflowId}
        workflowId={workflow?.workflowId ?? workflowId}
        workflow={workflow}
        openExecutionSettings={openExecutionSettings}
        canConfigure
        call={async <A,>() => (await request()) as A}
        refresh={() => {}}
        refreshProjects={() => {}}
      />
    </AppAtomRegistryProvider>
  );
  let tree = editor();
  let router;
  if (useRoutes) {
    const root = createRootRoute({ component: Outlet });
    const workflows = createRoute({
      getParentRoute: () => root,
      path: "workflows",
      component: Outlet,
    });
    const createEditor = createRoute({
      getParentRoute: () => workflows,
      path: "$repositoryId/new",
      component: NewWorkflowRoute.options.component!,
    });
    const savedEditor = createRoute({
      getParentRoute: () => workflows,
      path: "$repositoryId/$workflowId/edit",
      component: EditWorkflowRoute.options.component!,
    });
    vi.stubGlobal("self", {});
    vi.stubGlobal("window", {
      origin: "http://localhost",
      addEventListener() {},
      removeEventListener() {},
      scrollTo() {},
    });
    vi.stubGlobal("history", {});
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("scrollTo", () => {});
    router = createRouter({
      isServer: false,
      routeTree: root.addChildren([workflows.addChildren([createEditor, savedEditor])]),
      history: createMemoryHistory({ initialEntries: ["/workflows/repository/new"] }),
    });
    navigate.mockImplementation(router.navigate);
    await router.load();
    renderWorkflowRoute = editor;
    tree = <RouterProvider router={router} />;
  }
  await act(() => {
    renderer = create(tree, {
      createNodeMock: (element) => {
        if (element.type === "form") {
          return {
            querySelector: (selector: string) =>
              selector === '[aria-label="Configure workflow trigger"]' ? triggerButton : null,
          };
        }
        const props = element.props as Record<string, unknown>;
        const key =
          typeof props["data-focus-key"] === "string"
            ? props["data-focus-key"]
            : props["aria-label"] === "Workflow name"
              ? "name"
              : typeof props["aria-label"] === "string" &&
                  props["aria-label"].startsWith("Execution target: ")
                ? "header-target"
                : props["aria-label"] === "Close settings"
                  ? "close-settings"
                  : props.type === "submit"
                    ? "save"
                    : typeof props.id === "string" && props.id.endsWith("-branch-name")
                      ? "baseBranch"
                      : props.children === "Check saved version" ||
                          props.children === "Retry original save"
                        ? "recovery"
                        : props.children === "Keep step"
                          ? "keep-step"
                          : props.children === "Keep current order"
                            ? "keep-current-order"
                            : null;
        if (!key) return null;
        const cacheKey = `${presentation}:${key}`;
        let node = cache.get(cacheKey);
        if (!node?.isConnected) {
          node = element.type === "button" ? new FocusNode(props) : new TextField();
          cache.set(cacheKey, node);
        }
        node.value = typeof props.value === "string" ? props.value : "";
        node.disabled = !!props.disabled;
        nodes.set(key, node);
        return node;
      },
    });
  });
  return router;
}
async function changeWidth(next: number) {
  if (width >= 920 !== next >= 920) presentation++;
  width = next;
  await act(() => resize!([{ contentRect: { width } }]));
}
async function inspect() {
  const opener = new FocusNode();
  opener.focus();
  await act(() => canvas().props.onSelect("agent"));
  return opener;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", FocusNode);
  vi.stubGlobal("HTMLInputElement", TextField);
  vi.stubGlobal("HTMLTextAreaElement", TextField);
  vi.stubGlobal("document", focusDocument);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: NonNullable<typeof resize>) {
        resize = callback;
      }
      observe() {
        resize!([{ contentRect: { width } }]);
      }
      disconnect() {}
    },
  );
  width = 1200;
  presentation = 0;
  focusDocument.activeElement = null;
  triggerButton = new FocusNode();
  completeOpening = undefined;
  dismissSheet = undefined;
  initialSheetFocus = undefined;
  nodes.clear();
  cache.clear();
  request.mockReset().mockRejectedValue(new Error("Unexpected request"));
  navigate.mockReset();
  modelIssues.mockReset().mockReturnValue([]);
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  renderWorkflowRoute = undefined;
  vi.unstubAllGlobals();
});

describe("Save recovery focus", () => {
  async function loseSaveReply() {
    request.mockRejectedValueOnce(new Error("Save reply lost"));
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    return {
      workflowId: id(),
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      revision: 1,
      definition: draft().definition,
      archived: false,
      createdAt: "now",
      updatedAt: "now",
    } satisfies RepositoryWorkflow;
  }

  it("moves focus to Save after confirming a Create and keeps it through the edit route", async () => {
    const router = (await mount(false, { useRoutes: true }))!;
    const saved = await loseSaveReply();
    const form = renderer!.root.findByType("form");
    field("recovery").focus();
    request.mockResolvedValueOnce({ workflows: [saved] });
    await act(() => recoveryButton("Check saved version").props.onClick());
    expect(router.state.location.pathname).toBe(`/workflows/repository/${saved.workflowId}/edit`);
    expect(renderer!.root.findByType(WorkflowBuilder).props.isNew).toBe(false);
    expect(renderer!.root.findByType("form")).toBe(form);
    expect(focusDocument.activeElement).toBe(field("save"));
  });

  it.each([false, true])(
    "keeps retry focus through the write and respects focus moved elsewhere (%s)",
    async (moveFocus) => {
      await mount();
      const saved = await loseSaveReply();
      const recovery = field("recovery");
      recovery.focus();
      request.mockResolvedValueOnce({ workflows: [] });
      await act(() => recoveryButton("Check saved version").props.onClick());

      let resolveWrite!: (workflow: RepositoryWorkflow) => void;
      request.mockResolvedValueOnce({ workflows: [] }).mockReturnValueOnce(
        new Promise<RepositoryWorkflow>((resolve) => {
          resolveWrite = resolve;
        }),
      );
      await act(() => recoveryButton("Retry original save").props.onClick());
      expect(recoveryButton("Retry original save").props["aria-disabled"]).toBe(true);
      expect(focusDocument.activeElement).toBe(recovery);
      const target = field("header-target");
      if (moveFocus) target.focus();
      await act(() => resolveWrite(saved));
      expect(focusDocument.activeElement).toBe(moveFocus ? target : field("save"));
    },
  );
});

const stepConfirmation = () =>
  renderer!.root.findAllByType("section").find((node) => node.props.role === "alertdialog");
const visibleText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : visibleText(child))).join("");
const setSteps = (steps: ReadonlyArray<WorkflowStep>) =>
  act(() =>
    editWorkflowDraft(scope, id(), (current) => ({
      ...current,
      definition: { ...current.definition, steps },
    })),
  );

describe("Step movement", () => {
  const question: WorkflowStep = {
    kind: "input",
    id: "question",
    title: "Deployment note",
    question: "What should the release notes include?",
    role: "member",
  };
  const push: WorkflowStep = { kind: "action", id: "push", title: "Push branch", action: "push" };
  const moveNotice = () =>
    renderer!.root
      .findAllByProps({ role: "status" })
      .map(visibleText)
      .find((text) => text.startsWith("Moved "));

  async function requestMove(stepId: string, direction: "up" | "down" = "up") {
    await act(() => canvas().props.onSelect(stepId));
    field(`${stepId}:actions`).focus();
    await act(() =>
      renderer!.root
        .findByProps({ "aria-label": `Move ${direction} from inspector` })
        .props.onClick(),
    );
  }

  it("moves an independent step immediately and keeps its inspector selected", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    await setSteps([question, agent!, review!]);

    await requestMove(question.id, "down");

    expect(stepConfirmation()).toBeUndefined();
    expect(draft().definition.steps).toEqual([agent, question, review]);
    expect(draft().selectedStepId).toBe(question.id);
    expect(focusDocument.activeElement).toBe(field(`${question.id}:actions`));
  });

  it("previews the new result and rework Agent before moving Review", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    if (review?.kind !== "review") throw new Error("Expected a Review step");
    const plan = { ...agent!, id: "plan", title: "Plan change" };
    const implement = { ...agent!, title: "Implement change" };
    const automaticReview = { ...review, reworkStepId: undefined };
    const steps = [plan, implement, automaticReview];
    await setSteps(steps);

    await requestMove(review.id);

    const confirmation = stepConfirmation()!;
    expect(visibleText(confirmation)).toContain(`Move ${review.title}?`);
    expect(visibleText(confirmation)).toContain("Above Implement change");
    expect(visibleText(confirmation)).toContain("Step 2");
    expect(confirmation.findAllByType("dt").map(visibleText)).toEqual([
      "Saved result to review",
      "Send requested changes back to",
    ]);
    expect(confirmation.findAllByType("dd").map(visibleText)).toEqual([
      expect.stringMatching(/Implement change.*Plan change/),
      expect.stringMatching(/Implement change.*Plan change/),
    ]);
    expect(draft().definition.steps).toEqual(steps);
    expect(focusDocument.activeElement).toBe(field("keep-current-order"));

    await act(() => recoveryButton("Keep current order").props.onClick());

    expect(stepConfirmation()).toBeUndefined();
    expect(draft().definition.steps).toEqual(steps);
    expect(focusDocument.activeElement).toBe(field(`${review.id}:actions`));

    await requestMove(review.id);
    await act(() => recoveryButton("Move step").props.onClick());

    expect(stepConfirmation()).toBeUndefined();
    expect(draft().definition.steps).toEqual([plan, automaticReview, implement]);
    expect(draft().selectedStepId).toBe(review.id);
    expect(focusDocument.activeElement).toBe(field(`${review.id}:actions`));
    expect(workflowDraftIssue(draft().definition)).toBeNull();
    expect(moveNotice()).toBe("Moved above Implement change");

    await setSteps([plan, automaticReview, implement, question]);
    expect(moveNotice()).toBeUndefined();

    await requestMove(review.id, "down");
    await act(() => recoveryButton("Move step").props.onClick());
    expect(moveNotice()).toBe("Moved below Implement change");

    await act(() => canvas().props.onSelect(plan.id));
    expect(moveNotice()).toBeUndefined();
    await act(() => canvas().props.onSelect(review.id));
    expect(moveNotice()).toBeUndefined();
  });

  it("keeps dependency titles separate from their actual step positions", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    if (review?.kind !== "review") throw new Error("Expected a Review step");
    const first = { ...agent!, id: "first", title: "Implement (currently step 2)" };
    const second = { ...agent!, title: "Implement" };
    const last = { ...agent!, id: "last", title: "Implement" };
    await setSteps([first, second, { ...review, reworkStepId: undefined }, last]);

    await requestMove(review.id);

    const changes = stepConfirmation()!.findAllByType("dd");
    expect(changes).toHaveLength(2);
    for (const change of changes) {
      const labels = change
        .findAll(
          (node) =>
            typeof node.type === "string" &&
            node.children.length > 0 &&
            node.children.every((child) => typeof child === "string"),
        )
        .map(visibleText)
        .filter((label) => label.startsWith("Implement") || /^Step \d+$/.test(label));
      expect(labels).toEqual([second.title, "Step 2", first.title, "Step 1"]);
    }
  });

  it("warns before moving Open PR ahead of its required Push branch", async () => {
    await mount();
    const [agent] = draft().definition.steps;
    const steps = [agent!, push, openPrStep];
    await setSteps(steps);

    await requestMove(openPrStep.id);

    const confirmation = stepConfirmation()!;
    expect(visibleText(confirmation)).toContain("Move Open PR?");
    expect(visibleText(confirmation)).toContain("Above Push branch");
    expect(visibleText(confirmation)).toContain("Open PR will be blocked");
    expect(draft().definition.steps).toEqual(steps);

    await act(() => recoveryButton("Move step").props.onClick());

    expect(stepConfirmation()).toBeUndefined();
    expect(draft().definition.steps).toEqual([agent, openPrStep, push]);
    expect(draft().selectedStepId).toBe(openPrStep.id);
    expect(focusDocument.activeElement).toBe(field(`${openPrStep.id}:actions`));
    expect(field(`${openPrStep.id}:repair`)).toBeDefined();
  });

  it("warns when an Open PR already missing Push would also lose its Agent", async () => {
    await mount();
    const [agent] = draft().definition.steps;
    const steps = [agent!, openPrStep, push];
    await setSteps(steps);

    await requestMove(openPrStep.id);

    const confirmation = stepConfirmation()!;
    expect(visibleText(confirmation)).toContain("Open PR will be blocked");
    expect(visibleText(confirmation)).toContain(
      "An Agent step must come before Push branch, and Push branch must come before Open PR.",
    );
    expect(draft().definition.steps).toEqual(steps);
  });

  it("blocks a pending move when the step order changes before confirmation", async () => {
    await mount();
    const [agent] = draft().definition.steps;
    await setSteps([agent!, push, openPrStep]);
    await requestMove(openPrStep.id);

    const steps = [agent!, push, question, openPrStep];
    await setSteps(steps);

    expect(visibleText(stepConfirmation()!)).toContain("Workflow steps changed.");
    expect(recoveryButton("Move step").props.disabled).toBe(true);
    await act(() => recoveryButton("Move step").props.onClick());
    expect(draft().definition.steps).toEqual(steps);

    await act(() => recoveryButton("Keep current order").props.onClick());

    expect(stepConfirmation()).toBeUndefined();
    expect(focusDocument.activeElement).toBe(field(`${openPrStep.id}:actions`));
  });
});

describe("Step removal", () => {
  const releaseNotes: WorkflowStep = {
    kind: "input",
    id: "release-notes",
    title: "Release notes",
    question: "What should the release notes include?",
    role: "member",
  };
  const push: WorkflowStep = { kind: "action", id: "push", title: "Push branch", action: "push" };
  const removalDialog = stepConfirmation;
  const inspectorSheet = () => renderer!.root.findByProps({ "data-testid": "inspector-sheet" });
  async function requestRemoval(stepId: string) {
    await act(() => canvas().props.onSelect(stepId));
    field(`${stepId}:actions`).focus();
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Remove step from inspector" }).props.onClick(),
    );
  }

  it("removes an independent step immediately and focuses its neighbor", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    await setSteps([agent!, releaseNotes, review!]);

    await requestRemoval(releaseNotes.id);

    expect(removalDialog()).toBeUndefined();
    expect(draft().definition.steps).toEqual([agent, review]);
    expect(draft().selectedStepId).toBe("review");
    expect(focusDocument.activeElement).toBe(field("review:title"));
  });

  it("keeps the resized inspector inert until the removal confirmation restores focus", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    if (review?.kind !== "review") throw new Error("Expected a Review step");
    const steps = [agent!, releaseNotes, { ...review, reworkStepId: "agent" }];
    await setSteps(steps);
    await requestRemoval("agent");

    const confirmation = removalDialog()!;
    const keep = field("keep-step");
    expect(visibleText(confirmation)).toContain("Review changes loses its rework Agent");
    expect(focusDocument.activeElement).toBe(keep);

    await changeWidth(800);
    expect(removalDialog()).toBe(confirmation);
    expect(focusDocument.activeElement).toBe(keep);
    expect(inspectorSheet().props.inert).toBe(true);

    const actions = field("agent:actions");
    const restore = actions.focus.bind(actions);
    const restoreFocus = vi.spyOn(actions, "focus").mockImplementation((options) => {
      expect(inspectorSheet().props.inert).toBeFalsy();
      restore(options);
    });
    try {
      await act(() => recoveryButton("Keep step").props.onClick());

      expect(restoreFocus).toHaveBeenCalledOnce();
    } finally {
      restoreFocus.mockRestore();
    }

    expect(removalDialog()).toBeUndefined();
    expect(inspectorSheet().props.inert).toBeFalsy();
    expect(draft().definition.steps).toEqual(steps);
    expect(draft().selectedStepId).toBe("agent");
    expect(focusDocument.activeElement).toBe(actions);
  });

  it("keeps the Review's explicit rework reference and focuses its repair after confirmation", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    if (review?.kind !== "review") throw new Error("Expected a Review step");
    const earlier = { ...agent!, id: "plan", title: "Plan change" };
    await setSteps([earlier, agent!, releaseNotes, { ...review, reworkStepId: "agent" }]);
    await requestRemoval("agent");

    const confirmation = removalDialog()!;
    expect(visibleText(confirmation)).toContain("Choose another earlier Agent");
    expect(draft().definition.steps).toHaveLength(4);
    await act(() => recoveryButton("Remove step").props.onClick());

    expect(draft().selectedStepId).toBe("review");
    expect(draft().definition.steps.at(-1)).toMatchObject({ reworkStepId: "agent" });
    expect(workflowDraftIssue(draft().definition)).toMatchObject({
      stepId: "review",
      field: "rework",
    });
    expect(focusDocument.activeElement).toBe(field("review:rework"));
  });

  it("keeps an Open PR confirmation after a sheet resize and an equivalent steps replacement", async () => {
    width = 800;
    await mount();
    const [agent] = draft().definition.steps;
    await setSteps([agent!, push, releaseNotes, openPrStep]);
    await requestRemoval(push.id);
    const confirmation = removalDialog()!;
    expect(visibleText(confirmation)).toContain("Open PR will be blocked");
    expect(focusDocument.activeElement).toBe(field("keep-step"));

    await changeWidth(1200);
    await setSteps(draft().definition.steps.map((step) => ({ ...step })));
    expect(removalDialog()).toBe(confirmation);
    expect(focusDocument.activeElement).toBe(field("keep-step"));
    expect(recoveryButton("Remove step").props.disabled).toBe(false);

    await act(() => recoveryButton("Remove step").props.onClick());

    expect(draft().definition.steps).toEqual([agent, releaseNotes, openPrStep]);
    expect(draft().selectedStepId).toBe(openPrStep.id);
    expect(focusDocument.activeElement).toBe(field("open-pr:repair"));
  });

  it("removes a Push branch immediately when Open PR can use an earlier Push branch", async () => {
    await mount();
    const [agent] = draft().definition.steps;
    const earlierPush = { ...push, id: "earlier-push" };
    await setSteps([agent!, earlierPush, push, openPrStep]);

    await requestRemoval(push.id);

    expect(removalDialog()).toBeUndefined();
    expect(draft().definition.steps).toEqual([agent, earlierPush, openPrStep]);
    expect(workflowDraftIssue(draft().definition)).toBeNull();
  });

  it("names the earlier Agent before changing an implicit Review rework target", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    const earlierAgent = { ...agent!, id: "plan", title: "Plan change" };
    await setSteps([earlierAgent, agent!, review!]);

    await requestRemoval("agent");

    expect(visibleText(removalDialog()!)).toContain(
      "Review changes will send rework to Plan change",
    );
    await act(() => recoveryButton("Remove step").props.onClick());

    expect(draft().definition.steps).toEqual([earlierAgent, review]);
    expect(workflowDraftIssue(draft().definition)).toBeNull();
    expect(focusDocument.activeElement).toBe(field("review:rework"));
  });

  it("reports when Review will inspect a different Agent result without changing its explicit rework target", async () => {
    await mount();
    const [agent, review] = draft().definition.steps;
    if (review?.kind !== "review") throw new Error("Expected a Review step");
    const plan = { ...agent!, id: "plan", title: "Plan change" };
    const implement = { ...agent!, title: "Implement change" };
    const explicitReview = { ...review, reworkStepId: plan.id };
    const steps = [plan, implement, explicitReview];
    await setSteps(steps);

    await requestRemoval(implement.id);

    const confirmation = removalDialog()!;
    expect(visibleText(confirmation)).toContain(
      "Review changes will inspect a different saved result",
    );
    expect(visibleText(confirmation)).toContain("saved result from Plan change");
    expect(draft().definition.steps).toEqual(steps);

    await act(() => recoveryButton("Remove step").props.onClick());

    expect(draft().definition.steps).toEqual([plan, explicitReview]);
    expect(draft().selectedStepId).toBe(review.id);
    expect(focusDocument.activeElement).toBe(field("review:title"));
    expect(workflowDraftIssue(draft().definition)).toBeNull();
  });

  it("names same-titled publishing steps and the Agent now providing their saved result", async () => {
    await mount();
    const [agent] = draft().definition.steps;
    const originalAgent = { ...agent!, id: "plan" };
    await setSteps([
      originalAgent,
      agent!,
      { ...push, title: "Publish" },
      { ...openPrStep, title: "Publish" },
    ]);

    await requestRemoval("agent");

    const confirmation = removalDialog()!;
    expect(visibleText(confirmation)).toContain("Remove Agent (step 2)?");
    const warnings = confirmation.findAllByType("li").map(visibleText);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Publish (step 3) will publish a different saved result");
    expect(warnings[1]).toContain("Publish (step 4) will publish a different saved result");
    for (const warning of warnings) expect(warning).toContain("saved result from Agent (step 1)");

    await act(() => recoveryButton("Remove step").props.onClick());

    expect(draft().definition.steps.map((step) => step.id)).toEqual(["plan", "push", "open-pr"]);
    expect(workflowDraftIssue(draft().definition)).toBeNull();
  });
});

describe("Editor validation focus", () => {
  it("returns focus to the settings opener after submitting a blank branch from its input", async () => {
    request.mockResolvedValue({ status: "connected" });
    await mount(true);
    const opener = new FocusNode();
    opener.focus();
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
    );
    await act(() =>
      renderer!.root.findByProps({ type: "radio", value: "specific" }).props.onChange(),
    );
    field("baseBranch").focus();

    await act(() =>
      renderer!.root.findByType("form").props.onSubmit({
        preventDefault() {},
        nativeEvent: { submitter: field("save") },
      }),
    );
    expect(focusDocument.activeElement).toBe(field("baseBranch"));

    await act(() => renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick());
    expect(focusDocument.activeElement).toBe(opener);
  });

  it("describes a missing name, focuses it on Save, and clears the error after editing", async () => {
    await mount();
    const nameInput = () =>
      renderer!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "Workflow name")!;
    await act(() => nameInput().props.onChange({ target: { value: "" } }));

    field("save").focus();
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));

    expect(focusDocument.activeElement).toBe(field("name"));
    expect(nameInput().props["aria-invalid"]).toBe(true);
    const descriptionId = nameInput().props["aria-describedby"];
    expect(descriptionId).toEqual(expect.any(String));
    expect(renderer!.root.findByProps({ id: descriptionId }).children).toContain(
      "Enter a workflow name.",
    );
    expect(draft().error).toBeNull();
    expect(recoveryButton("Reload saved version")).toBeUndefined();
    expect(request).not.toHaveBeenCalled();

    await act(() => nameInput().props.onChange({ target: { value: "Reviewed implementation" } }));

    expect(nameInput().props["aria-invalid"]).toBeFalsy();
    expect(renderer!.root.findAllByProps({ id: descriptionId })).toHaveLength(0);
  });

  it("keeps focus on the missing workflow name after closing the Trigger sheet from Save", async () => {
    width = 600;
    await mount(false, { automationSupported: true });
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => ({
        ...current,
        definition: { ...current.definition, name: "" },
      })),
    );
    await act(() => canvas().props.onTrigger());
    expect(draft().triggerSetup).toBe(true);

    await act(() => recoveryButton("Save workflow").props.onClick());

    expect(draft().triggerSetup).toBe(false);
    expect(focusDocument.activeElement).toBe(field("name"));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([1200, 600])(
    "opens and returns focus from a missing Input question at width %i",
    async (editorWidth) => {
      width = editorWidth;
      await mount();
      await act(() =>
        editWorkflowDraft(scope, id(), (current) => ({
          ...current,
          definition: {
            ...current.definition,
            steps: [
              ...current.definition.steps,
              {
                id: "input",
                kind: "input",
                title: "Choose release target",
                question: "   ",
                role: "maintainer",
              },
            ],
          },
        })),
      );

      expect(renderer!.root.findAllByProps({ title: "Add a question" })).toHaveLength(1);
      const openQuestion = async () => {
        const button = recoveryButton("Review question");
        const opener = button.instance as FocusNode;
        opener.focus();
        await act(() => button.props.onClick({ currentTarget: opener }));
        expect(opener.isConnected).toBe(false);
        return opener;
      };
      const closeQuestion = async () => {
        await act(() =>
          renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick(),
        );
        if (editorWidth < 920) {
          const remounted = recoveryButton("Review question");
          if (remounted) expect(focusDocument.activeElement).not.toBe(remounted.instance);
          await act(() => completeOpening!(false));
        }
      };
      const firstOpener = await openQuestion();
      expect(focusDocument.activeElement).toBe(field("input:question"));
      expect(field("input:question").focusOptions?.preventScroll).toBe(false);
      expect(renderer!.root.findAllByProps({ title: "Add a question" })).toHaveLength(0);

      await closeQuestion();
      expect(renderer!.root.findAllByProps({ title: "Add a question" })).toHaveLength(1);
      const remountedOpener = recoveryButton("Review question").instance;
      expect(remountedOpener).not.toBe(firstOpener);
      expect(focusDocument.activeElement).toBe(remountedOpener);

      field("save").focus();
      await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
      expect(draft().selectedStepId).toBe("input");
      expect(focusDocument.activeElement).toBe(field("input:question"));
      expect(field("input:question").focusOptions?.preventScroll).toBe(false);
      expect(draft().error).toBeNull();
      expect(request).not.toHaveBeenCalled();

      await closeQuestion();
      await openQuestion();
      await act(() =>
        renderer!.root.findByProps({ "data-focus-key": "input:question" }).props.onChange({
          target: { value: "Which release should this change target?" },
        }),
      );
      await closeQuestion();
      expect(renderer!.root.findAllByProps({ title: "Add a question" })).toHaveLength(0);
      expect(focusDocument.activeElement).toBe(field("save"));
    },
  );

  it("focuses the chosen VM model warning and still sends Save to the first unresolved model", async () => {
    request.mockResolvedValue({ status: "connected" });
    await mount(true);
    modelIssues.mockReturnValue([
      { stepId: "agent", title: "Implement change", detail: "The selected model is unavailable." },
      { stepId: "verify", title: "Verify implementation", detail: "Choose an available model." },
    ]);
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => {
        const agent = current.definition.steps[0]!;
        return {
          ...current,
          targetConfirmed: true,
          definition: {
            ...current.definition,
            steps: [
              { ...agent, title: "Implement change" },
              { ...agent, id: "verify", title: "Verify implementation" },
            ],
          },
        };
      }),
    );
    request.mockClear();

    const verifyModel = renderer!.root
      .findAllByType("button")
      .find(
        (button) =>
          button.props["aria-label"] === "Review model for Agent step 2: Verify implementation",
      )!;
    expect(verifyModel.children).toContain("Review model");
    await act(() => verifyModel.props.onClick({ currentTarget: new FocusNode() }));
    expect(draft().selectedStepId).toBe("verify");
    expect(focusDocument.activeElement).toBe(field("verify:model"));
    expect(field("verify:model").focusOptions?.preventScroll).toBe(false);

    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(draft().selectedStepId).toBe("agent");
    expect(focusDocument.activeElement).toBe(field("agent:model"));
    expect(field("agent:model").focusOptions?.preventScroll).toBe(false);
    expect(request).not.toHaveBeenCalled();

    modelIssues.mockReturnValue([
      { stepId: "agent", title: "", detail: "The selected model is unavailable." },
      { stepId: "verify", title: "Agent step 1", detail: "Choose an available model." },
    ]);
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => ({
        ...current,
        definition: {
          ...current.definition,
          steps: current.definition.steps.map((step) => ({
            ...step,
            title: step.id === "agent" ? "" : "Agent step 1",
          })),
        },
      })),
    );
    const reviewLabels = renderer!.root
      .findAllByType("button")
      .filter((button) => button.children.includes("Review model"))
      .map((button) => button.props["aria-label"]);
    expect(reviewLabels).toEqual([
      "Review model for Agent step 1",
      "Review model for Agent step 2: Agent step 1",
    ]);
  });
});

describe("Inspector presentation focus", () => {
  it.each([1200, 600])(
    "focuses Add a step after removing the only step at width %i",
    async (editorWidth) => {
      width = editorWidth;
      await mount();
      await act(() =>
        editWorkflowDraft(scope, id(), (current) => ({
          ...current,
          definition: {
            ...current.definition,
            steps: current.definition.steps.filter((step) => step.id === "agent"),
          },
        })),
      );
      await inspect();
      field("agent:title").focus();
      await act(() =>
        renderer!.root.findByProps({ "aria-label": "Remove step from inspector" }).props.onClick(),
      );
      expect(draft().definition.steps).toEqual([]);
      expect(focusDocument.activeElement).toBe(field("add-step"));
    },
  );

  it("keeps instructions, selection and textarea scroll through both presentation changes", async () => {
    await mount();
    await inspect();
    const before = field("agent:instruction");
    before.focus();
    before.setSelectionRange(3, 14, "backward");
    before.scrollTop = 90;
    await changeWidth(800);
    const narrow = field("agent:instruction");
    expect(focusDocument.activeElement === narrow).toBe(true);
    expect(narrow.focusOptions?.preventScroll).toBe(true);
    expect([
      narrow.selectionStart,
      narrow.selectionEnd,
      narrow.selectionDirection,
      narrow.scrollTop,
    ]).toEqual([3, 14, "backward", 90]);
    narrow.setSelectionRange(20, 20);
    narrow.scrollTop = 130;
    await act(() => completeOpening?.(true));
    expect([narrow.selectionStart, narrow.selectionEnd, narrow.scrollTop]).toEqual([20, 20, 130]);
    await changeWidth(1200);
    const docked = field("agent:instruction");
    expect(focusDocument.activeElement === docked).toBe(true);
    expect([docked.selectionStart, docked.selectionEnd, docked.scrollTop]).toEqual([20, 20, 130]);
    expect(draft().selectedStepId).toBe("agent");
    expect(draft().definition.steps[0]).toMatchObject({ instruction: before.value });
  });
  it("opens missing Agent instructions from the warning and consumes Save focus", async () => {
    await mount();
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => ({
        ...current,
        definition: {
          ...current.definition,
          steps: current.definition.steps.map((step) =>
            step.kind === "agent" ? { ...step, instruction: "" } : step,
          ),
        },
      })),
    );
    expect(renderer!.root.findAllByProps({ title: "Add Agent instructions" })).toHaveLength(1);
    await act(() =>
      recoveryButton("Review Agent instructions").props.onClick({ currentTarget: new FocusNode() }),
    );
    expect(draft().selectedStepId).toBe("agent");
    expect(focusDocument.activeElement).toBe(field("agent:instruction"));
    expect(field("agent:instruction").focusOptions?.preventScroll).toBe(false);

    field("save").focus();
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(focusDocument.activeElement).toBe(field("agent:instruction"));
    expect(field("agent:instruction").focusOptions?.preventScroll).toBe(false);
    expect(draft().error).toBeNull();
    expect(recoveryButton("Reload saved version")).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    const title = field("agent:title");
    title.focus();
    title.setSelectionRange(1, 4);
    await changeWidth(800);
    expect(focusDocument.activeElement === field("agent:title")).toBe(true);
    expect([field("agent:title").selectionStart, field("agent:title").selectionEnd]).toEqual([
      1, 4,
    ]);

    await act(() =>
      renderer!.root.findByProps({ "data-focus-key": "agent:instruction" }).props.onChange({
        target: { value: "Implement the change." },
      }),
    );
    await act(() => renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick());
    expect(renderer!.root.findAllByProps({ title: "Add Agent instructions" })).toHaveLength(0);
  });
  it.each([1200, 600])(
    "returns focus to the canvas trigger after dismissing trigger settings at width %i",
    async (editorWidth) => {
      width = editorWidth;
      await mount();
      await act(() =>
        editWorkflowDraft(scope, id(), (current) => ({ ...current, triggerSetup: true })),
      );

      if (editorWidth < 920) {
        await act(() => dismissSheet!(false));
      } else {
        await act(() =>
          renderer!.root.findByProps({ "aria-label": "Close trigger settings" }).props.onClick(),
        );
      }

      expect(draft().triggerSetup).toBe(false);
      expect(focusDocument.activeElement).toBe(triggerButton);
    },
  );

  it("repairs a stale Push branch immediately before Open PR and keeps its inspector focused", async () => {
    await mount();
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => {
        const agent = current.definition.steps[0]!;
        return {
          ...current,
          definition: {
            ...current.definition,
            steps: [
              agent,
              { id: "early-push", kind: "action", title: "Push branch", action: "push" },
              { ...agent, id: "later-agent", title: "Finish change" },
              openPrStep,
            ],
          },
        };
      }),
    );

    expect(renderer!.root.findAllByProps({ title: "Check workflow settings" })).toHaveLength(1);
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(draft().error).toContain("Push branch");
    expect(draft().selectedStepId).toBe(openPrStep.id);
    expect(renderer!.root.findAllByProps({ title: "Check workflow settings" })).toHaveLength(0);
    expect(focusDocument.activeElement).toBe(field("open-pr:repair"));

    await act(() => renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick());
    expect(draft().selectedStepId).toBe("");
    expect(focusDocument.activeElement).toBe(field("save"));
    await act(() => reviewPublishingStep().props.onClick());
    expect(draft().selectedStepId).toBe(openPrStep.id);
    expect(focusDocument.activeElement).toBe(field("open-pr:repair"));

    await act(() => renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick());
    expect(focusDocument.activeElement).toBe(field("save"));
    await act(() => reviewPublishingStep().props.onClick());

    const repair = renderer!.root.findByProps({ "data-focus-key": "open-pr:repair" });
    await act(() => repair.props.onClick());

    const steps = draft().definition.steps;
    expect(steps.slice(0, 3).map((step) => step.id)).toEqual([
      "agent",
      "early-push",
      "later-agent",
    ]);
    expect(steps.slice(3)).toEqual([
      expect.objectContaining({ kind: "action", action: "push", title: "Push branch" }),
      openPrStep,
    ]);
    expect(draft().error).toBeNull();
    expect(draft().selectedStepId).toBe(openPrStep.id);
    expect(focusDocument.activeElement).toBe(field("open-pr:title"));
  });

  it.each(["step limit", "no earlier Agent"] as const)(
    "focuses the publishing warning when recovery is unavailable at %s",
    async (blocker) => {
      await mount();
      await act(() =>
        editWorkflowDraft(scope, id(), (current) => {
          const agent = current.definition.steps[0]!;
          const steps =
            blocker === "step limit"
              ? [
                  ...Array.from({ length: WORKFLOW_MAX_STEPS - 1 }, (_, index) => ({
                    ...agent,
                    id: `agent-${index}`,
                  })),
                  openPrStep,
                ]
              : [openPrStep, agent];
          return { ...current, definition: { ...current.definition, steps } };
        }),
      );

      await act(() => reviewPublishingStep().props.onClick());
      expect(focusDocument.activeElement).toBe(field("open-pr:repair-warning"));
      if (blocker === "step limit") expect(field("open-pr:repair").disabled).toBe(true);
      else expect(nodes.has("open-pr:repair")).toBe(false);

      await act(() =>
        renderer!.root.findByProps({ "aria-label": "Close settings" }).props.onClick(),
      );
      await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
      expect(draft().selectedStepId).toBe(openPrStep.id);
      expect(focusDocument.activeElement).toBe(field("open-pr:repair-warning"));
    },
  );

  it.each([
    ["VM", { kind: "vm", baseBranch: null }, "target:machine"],
    [
      "unavailable Machine",
      {
        kind: "machine",
        environmentId: EnvironmentId.make("missing-environment"),
        projectId: ProjectId.make("missing-project"),
      },
      "checkout",
    ],
  ] as const)(
    "focuses the target recovery control in Workflow settings for %s",
    async (_label, target, recoveryField) => {
      await mount(true, { projects: [project] });
      await act(() =>
        editWorkflowDraft(scope, id(), (current) => ({
          ...current,
          targetConfirmed: true,
          definition: {
            ...current.definition,
            target,
            steps: [
              ...current.definition.steps,
              { id: "push", kind: "action", title: "Push branch", action: "push" },
              openPrStep,
            ],
          },
        })),
      );
      await act(() => canvas().props.onSelect(openPrStep.id));

      await act(() =>
        renderer!.root.findByProps({ "data-focus-key": "open-pr:repair" }).props.onClick(),
      );

      expect(draft().selectedStepId).toBe("");
      expect(draft().definition.target).toEqual(target);
      expect(draft().definition.steps.at(-1)).toEqual(openPrStep);
      expect(focusDocument.activeElement).toBe(field(recoveryField));
    },
  );

  it("returns focus to Save after dismissing trigger validation", async () => {
    width = 600;
    await mount(false, { automationSupported: true });
    await act(() =>
      editWorkflowDraft(scope, id(), (current) => ({
        ...current,
        automation: { enabled: true, trigger: null },
      })),
    );
    const submitter = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.type === "submit")!.instance;
    await act(() =>
      renderer!.root.findByType("form").props.onSubmit({
        preventDefault() {},
        nativeEvent: { submitter },
      }),
    );
    expect(draft().triggerSetup).toBe(true);

    await act(() => dismissSheet!(false));
    expect(focusDocument.activeElement).toBe(submitter);
  });

  it("returns focus to the execution target after dismissing automatically opened settings", async () => {
    width = 600;
    await mount(true, { projects: [project] });
    expect(draft().targetConfirmed).toBe(false);

    await act(() => dismissSheet!(false));
    expect(focusDocument.activeElement).toBe(field("header-target"));
  });

  it("scrolls to the unavailable saved branch when entering from Run", async () => {
    const branch = "release/missing";
    const workflow: RepositoryWorkflow = {
      workflowId: "missing-branch",
      repositoryId: scope.repositoryId,
      organizationId: scope.organizationId,
      definition: {
        ...newWorkflowDraft([], "review", true)!.definition,
        target: { kind: "vm", baseBranch: branch },
      },
      revision: 1,
      archived: false,
      createdAt: "now",
      updatedAt: "now",
    };
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      runs: {
        ...state.runs,
        [workflowSessionKey(scope, workflow.workflowId)]: {
          instruction: "Run instructions",
          operation: null,
          startedJobId: null,
          error: "Choose an existing GitHub base branch with at least one commit.",
          vmStartFailure: { kind: "base-branch-unavailable", branch },
          vmStartFailureRevision: workflow.revision,
        },
      },
    }));
    request.mockResolvedValue({ status: "connected" });
    await mount(true, { workflow, openExecutionSettings: true });

    expect(focusDocument.activeElement).toBe(field("baseBranch"));
    expect(field("baseBranch").value).toBe(branch);
    expect(field("baseBranch").focusOptions?.preventScroll).toBe(false);
  });

  it.each([
    { vm: false, key: "checkout" },
    { vm: true, key: "target:machine" },
  ])("preserves $key focus and explicit dismissal", async ({ vm, key }) => {
    await mount(vm, { projects: [project] });
    const opener = new FocusNode();
    opener.focus();
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props["aria-label"] === "Workflow settings")!
        .props.onClick(),
    );
    field(key).focus();
    await changeWidth(800);
    expect(focusDocument.activeElement === field(key)).toBe(true);
    await act(() => dismissSheet!(false));
    expect(draft().selectedStepId).toBe("");
    expect(focusDocument.activeElement === opener).toBe(true);
  });
  it("keeps the Base branch value, focus, and selection through both presentation changes", async () => {
    await mount(true);
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
    );
    await act(() =>
      renderer!.root.findByProps({ type: "radio", value: "specific" }).props.onChange({
        target: { checked: true },
      }),
    );
    await act(() => {
      const input = renderer!.root
        .findAllByType("input")
        .find(
          (node) => typeof node.props.id === "string" && node.props.id.endsWith("-branch-name"),
        )!;
      input.props.onChange({ target: { value: "release/1.x" } });
    });
    const wide = field("baseBranch");
    wide.focus();
    wide.setSelectionRange(2, 7, "backward");
    await changeWidth(800);
    const narrow = field("baseBranch");
    expect(narrow).not.toBe(wide);
    expect(focusDocument.activeElement).toBe(narrow);
    expect([
      narrow.value,
      narrow.selectionStart,
      narrow.selectionEnd,
      narrow.selectionDirection,
    ]).toEqual(["release/1.x", 2, 7, "backward"]);
    narrow.setSelectionRange(9, 9);
    await changeWidth(1200);
    const docked = field("baseBranch");
    expect(docked).not.toBe(narrow);
    expect(focusDocument.activeElement).toBe(docked);
    expect([docked.value, docked.selectionStart, docked.selectionEnd]).toEqual([
      "release/1.x",
      9,
      9,
    ]);
    expect(draft().definition.target).toEqual({ kind: "vm", baseBranch: "release/1.x" });
  });
  it("ignores an old Sheet callback after dismissal and reopening", async () => {
    width = 800;
    await mount();
    await inspect();
    const oldInitialFocus = initialSheetFocus!;
    await act(() => dismissSheet!(false));
    await inspect();
    const input = field("agent:instruction");
    input.focus();
    input.setSelectionRange(8, 8);
    await act(() => runInitialFocus(oldInitialFocus));
    expect(focusDocument.activeElement === input).toBe(true);
    expect(input.selectionStart).toBe(8);
  });
  it("ignores same-mode notifications and preserves the newest caret on rapid resizing", async () => {
    await mount();
    await inspect();
    const input = field("agent:instruction");
    input.focus();
    input.setSelectionRange(7, 10);
    await changeWidth(1100);
    expect(focusDocument.activeElement === input).toBe(true);
    input.setSelectionRange(15, 15);
    await changeWidth(800);
    const narrow = field("agent:instruction");
    narrow.setSelectionRange(21, 23, "forward");
    await changeWidth(1200);
    await changeWidth(800);
    const latest = field("agent:instruction");
    expect(focusDocument.activeElement === latest).toBe(true);
    expect([latest.selectionStart, latest.selectionEnd, latest.selectionDirection]).toEqual([
      21,
      23,
      "forward",
    ]);
  });
  it("does not replay initial focus after its editor unmounts", async () => {
    width = 800;
    await mount();
    await inspect();
    const oldInitialFocus = initialSheetFocus!;
    await act(() => renderer!.unmount());
    renderer = undefined;
    const other = new FocusNode();
    other.focus();
    await act(() => runInitialFocus(oldInitialFocus));
    expect(focusDocument.activeElement === other).toBe(true);
  });
});
