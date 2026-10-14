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
import { editWorkflowDraft, selectWorkflowStep, newWorkflowDraft } from "./workflowState";

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
    read.mockResolvedValueOnce([result]);
    await click("Check saved version");
    expect(editor(id).definition.name).toBe("Later edits");
    expect(editor(id).baseline).toEqual(result);
    expect(editor(id).operation).toBeNull();
    expect(Object.keys(appAtomRegistry.get(workflowDraftAtom).editors)).toHaveLength(1);
  });
  it("ignores old reconciliation after a newer Save acknowledges", async () => {
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await mount();
    const id = newId();
    const old = saved(id);
    await submit();
    const reconciliation = deferred<RepositoryWorkflow[]>();
    read.mockReturnValueOnce(reconciliation.promise);
    await click("Check saved version");
    await rename("Newer save");
    const next = saved(id);
    read.mockResolvedValueOnce(next);
    await submit();
    await act(async () => {
      reconciliation.resolve([old]);
      await reconciliation.promise;
    });
    expect(editor(id).baseline).toEqual(next);
    expect(editor(id).definition.name).toBe("Newer save");
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
    const reply = deferred<RepositoryWorkflow[]>();
    read.mockReturnValueOnce(reply.promise);
    await click("Reload saved version");
    await rename("Typed after confirmation");
    await act(async () => {
      reply.resolve([baseline]);
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
    read.mockResolvedValueOnce([next]);
    await click("Reload saved version");
    expect(editor(id).baseline).toEqual(next);
    expect(editor(id).definition).toEqual(next.definition);
  });
  it.each(["old-first", "new-first"])("rejects a previous mount's Reload (%s)", async (order) => {
    const { id, baseline, props } = await openSaved();
    const first = deferred<RepositoryWorkflow[]>();
    const second = deferred<RepositoryWorkflow[]>();
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
        first.resolve([old]);
        await first.promise;
      });
    const resolveSecond = () =>
      act(async () => {
        second.resolve([latest]);
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
    const reply = deferred<RepositoryWorkflow[]>();
    read.mockReturnValueOnce(reply.promise);
    await click("Reload saved version");
    await unmount();
    await act(async () => {
      reply.resolve([{ ...baseline, revision: 2 }]);
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
    const reply = deferred<RepositoryWorkflow[]>();
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
    read.mockResolvedValueOnce([next]);
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
    const restored = saved(id, 3);
    read.mockResolvedValueOnce(restored);
    await submit();
    await unmount();
    await mount({
      ...base,
      isNew: false,
      workflowId: id,
      workflow: { ...restored, revision: 2, archived: true },
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
