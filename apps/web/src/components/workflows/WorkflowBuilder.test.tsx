vi.mock("./WorkflowTriggerInspector", async () => ({
  ...(await vi.importActual("./WorkflowTriggerInspector")),
  WorkflowTriggerInspector: () => null,
}));
vi.mock("./WorkflowEditorDepartureGuard", () => ({ WorkflowEditorDepartureGuard: () => null }));
import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  RelayMachineId,
  RelayRepositoryId,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
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

const { navigate, confirmation } = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirmation: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirmation }));
vi.mock("./WorkflowCanvas", async () => ({
  ...(await vi.importActual("./WorkflowCanvas")),
  WorkflowCanvas: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-testid": "canvas-fixture" }),
}));
vi.mock("./WorkflowStepEditor", () => ({
  WorkflowStepEditor: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-testid": "step-fixture" }),
  useWorkflowEditorModels: () => ({ issues: [] }),
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? children : null),
  SheetPopup: ({ children }: PropsWithChildren) => children,
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
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("../ui/select", () => {
  const component = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Select: component,
    SelectTrigger: component,
    SelectValue: component,
    SelectPopup: component,
    SelectItem: component,
  };
});

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
  isNew: true,
  workflow: undefined,
  projects: [project],
  canConfigure: true,
  call,
  refresh,
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
const saved = (id: string, revision = 1): RepositoryWorkflow => ({
  workflowId: id,
  repositoryId: scope.repositoryId,
  organizationId: scope.organizationId,
  archived: false,
  revision,
  definition: editor(id).definition,
  createdAt: "now",
  updatedAt: "now",
});
async function mount(props: Props = base) {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowBuilder {...props} />
      </AppAtomRegistryProvider>,
      { createNodeMock: (element) => (element.type === "form" ? {} : null) },
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
async function click(label: string) {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick();
  });
}
async function rename(name: string) {
  await act(() => renderer!.root.findByType("input").props.onChange({ target: { value: name } }));
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
    read.mockResolvedValueOnce({ workflows: [old] });
    await submit();
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
    expect(editor(id).error).toContain("Question");
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
    const sourceDraft = newWorkflowDraft([project])!;
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
    expect(copied.definition.projectId).toBe(destination.projectId);
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
    confirm.resolve(true);
    expect(await pending).toBeNull();
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
            projectId: ProjectId.make("later-project"),
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
      if (!committed) read.mockResolvedValueOnce(receipt);
      const before = read.mock.calls.length;
      await submit();
      expect(read.mock.calls.length - before).toBe(committed ? 1 : 2);
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
