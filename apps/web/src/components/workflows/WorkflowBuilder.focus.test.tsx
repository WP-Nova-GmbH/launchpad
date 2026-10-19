vi.mock("./WorkflowSources", () => ({ RepositorySourcesButton: () => null }));
vi.mock("./WorkflowEditorDepartureGuard", () => ({ WorkflowEditorDepartureGuard: () => null }));
import { act, createElement, useLayoutEffect, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  RelayMachineId,
  RelayRepositoryId,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import {
  workflowDraftAtom,
  workflowSessionKey,
  setWorkflowSessionAccount,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { WorkflowStepEditor } from "./WorkflowStepEditor";

type StepProps = Parameters<typeof WorkflowStepEditor>[0];
class FocusNode {
  isConnected = true;
  disabled = false;
  value = "";
  scrollTop = 0;
  focus() {
    focusDocument.activeElement = this;
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
const focusDocument: { activeElement: FocusNode | null } = { activeElement: null };
const nodes = new Map<string, FocusNode>();
const cache = new Map<string, FocusNode>();
let width = 1200;
let presentation = 0;
let resize: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined;
let completeOpening: ((open: boolean) => void) | undefined;
let dismissSheet: ((open: boolean) => void) | undefined;
let initialSheetFocus: (() => boolean | HTMLElement | null | void) | undefined;

function runInitialFocus(callback: NonNullable<typeof initialSheetFocus>) {
  const target = callback();
  if (target === true)
    nodes.get(draft().selectedStepId ? `${draft().selectedStepId}:title` : "target")?.focus();
  else if (target && typeof target !== "boolean") target.focus();
}

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(false) }));
vi.mock("./WorkflowCanvas", async () => ({
  ...(await vi.importActual("./WorkflowCanvas")),
  WorkflowCanvas: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-testid": "canvas" }),
}));
vi.mock("./WorkflowStepEditor", () => ({
  useWorkflowEditorModels: () => ({ issues: [] }),
  WorkflowStepEditor: (props: StepProps) => {
    const step = props.definition.steps.find((entry) => entry.id === props.selectedId)!;
    const field = step.kind === "agent" ? "instruction" : "question";
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
      createElement("button", { "aria-label": "Close settings", onClick: props.close }),
    );
  },
}));
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
  }: PropsWithChildren<{
    initialFocus: () => boolean | HTMLElement | null | void;
    finalFocus: () => boolean | HTMLElement | null | void;
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
    return children;
  },
  SheetTitle: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ children }: PropsWithChildren) => children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/select", () => {
  const component = ({ children }: PropsWithChildren) => children;
  return {
    Select: component,
    SelectValue: component,
    SelectPopup: component,
    SelectItem: component,
    SelectTrigger: (props: Record<string, unknown>) =>
      createElement("button", { ...props, "data-focus-key": "target" }),
  };
});

import { WorkflowBuilder } from "./WorkflowBuilder";
import { editWorkflowDraft } from "./workflowState";
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
let renderer: ReactTestRenderer | undefined;
const id = () =>
  appAtomRegistry.get(workflowDraftAtom).newWorkflowIds[workflowSessionKey(scope, "new")]!;
const draft = () =>
  appAtomRegistry.get(workflowDraftAtom).editors[workflowSessionKey(scope, id())]!;
const canvas = () => renderer!.root.findByProps({ "data-testid": "canvas" });
const field = (key: string) => nodes.get(key)! as TextField;
async function mount() {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowBuilder
          scope={scope}
          projects={[project]}
          isNew
          workflow={undefined}
          canConfigure
          call={async () => {
            throw new Error("Unexpected write");
          }}
          refresh={() => {}}
        />
      </AppAtomRegistryProvider>,
      {
        createNodeMock: (element) => {
          if (element.type === "form") return { querySelector: () => null };
          const props = element.props as Record<string, unknown>;
          const key =
            typeof props["data-focus-key"] === "string"
              ? props["data-focus-key"]
              : props["aria-label"] === "Workflow name"
                ? "name"
                : null;
          if (!key) return null;
          const cacheKey = `${presentation}:${key}`;
          let node = cache.get(cacheKey);
          if (!node) {
            node = element.type === "button" ? new FocusNode() : new TextField();
            cache.set(cacheKey, node);
          }
          node.value = typeof props.value === "string" ? props.value : "";
          node.disabled = !!props.disabled;
          nodes.set(key, node);
          return node;
        },
      },
    );
  });
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
  completeOpening = undefined;
  dismissSheet = undefined;
  initialSheetFocus = undefined;
  nodes.clear();
  cache.clear();
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Inspector presentation focus", () => {
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
  it("consumes validation focus before restoring a subsequently edited title", async () => {
    await mount();
    await inspect();
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
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(focusDocument.activeElement === field("agent:instruction")).toBe(true);
    const title = field("agent:title");
    title.focus();
    title.setSelectionRange(1, 4);
    await changeWidth(800);
    expect(focusDocument.activeElement === field("agent:title")).toBe(true);
    expect([field("agent:title").selectionStart, field("agent:title").selectionEnd]).toEqual([
      1, 4,
    ]);
  });
  it("preserves ordinary workflow-target control focus and explicit dismissal", async () => {
    await mount();
    const opener = new FocusNode();
    opener.focus();
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
    );
    field("target").focus();
    await changeWidth(800);
    expect(focusDocument.activeElement === field("target")).toBe(true);
    await act(() => dismissSheet!(false));
    expect(draft().selectedStepId).toBe("");
    expect(focusDocument.activeElement === opener).toBe(true);
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
