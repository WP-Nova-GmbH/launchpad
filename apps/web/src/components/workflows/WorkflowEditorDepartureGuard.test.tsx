import { act, createContext, createElement, useContext, type PropsWithChildren } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import {
  workflowDraftAtom,
  workflowSessionKey,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/alert-dialog", () => {
  const part = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    AlertDialog: ({
      open,
      children,
      onOpenChange,
    }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) =>
      open
        ? createElement(
            "section",
            { "data-dialog": true, onDismiss: () => onOpenChange(false) },
            children,
          )
        : null,
    AlertDialogPopup: part,
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: part,
  };
});
import { WorkflowEditorDepartureGuard } from "./WorkflowEditorDepartureGuard";
const scope = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
};
const key = workflowSessionKey(scope, "flow");
const onDiscard = vi.fn();
const onCheckSavedVersion = vi.fn();
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  onDiscard.mockReset();
  onCheckSavedVersion.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    newWorkflowIds: { [workflowSessionKey(scope, "new")]: "flow" },
    editors: {
      [key]: {
        workflowId: "flow",
        definition: {
          name: "Unsaved",
          target: {
            kind: "machine" as const,
            environmentId: EnvironmentId.make("environment"),
            projectId: ProjectId.make("project"),
          },
          steps: [],
        },
        baseline: null,
        selectedStepId: "",
        targetConfirmed: true,
        operation: null,
        error: null,
      },
    },
  }));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount(initialEntries = ["/settings", "/workflows"]) {
  const Reading = createContext(false);
  const Editor = () => (
    <WorkflowEditorDepartureGuard
      scope={scope}
      id="flow"
      onDiscard={onDiscard}
      onCheckSavedVersion={onCheckSavedVersion}
      reading={useContext(Reading)}
    />
  );
  const root = createRootRoute({ component: Outlet });
  const editor = createRoute({
    getParentRoute: () => root,
    path: "workflows",
    component: Editor,
  });
  const destination = createRoute({
    getParentRoute: () => root,
    path: "settings",
    component: () => <p>Catalog</p>,
  });
  const createEditor = createRoute({
    getParentRoute: () => root,
    path: "workflows/$repositoryId/new",
    component: Editor,
  });
  const savedEditor = createRoute({
    getParentRoute: () => root,
    path: "workflows/$repositoryId/$workflowId/edit",
    component: Editor,
  });
  const history = createMemoryHistory({ initialEntries });
  const router = createRouter({
    routeTree: root.addChildren([editor, destination, createEditor, savedEditor]),
    history,
  });
  const app = (reading: boolean) => (
    <AppAtomRegistryProvider>
      <Reading.Provider value={reading}>
        <RouterProvider router={router} />
      </Reading.Provider>
    </AppAtomRegistryProvider>
  );
  await router.load();
  await act(() => {
    renderer = create(app(false));
  });
  vi.stubGlobal("document", {});
  return {
    router,
    history,
    setReading: (reading: boolean) => act(() => renderer!.update(app(reading))),
  };
}
async function click(label: string) {
  await act(() =>
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick(),
  );
}
function dialogText(
  node: ReactTestInstance = renderer!.root.findByProps({ "data-dialog": true }),
): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : dialogText(child)))
    .join("");
}

function setSaveState(saveState: "pending" | "uncertain") {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const draft = state.editors[key]!;
    return {
      ...state,
      editors: {
        [key]: {
          ...draft,
          operation: {
            requestId: "save",
            state: saveState,
            definition: draft.definition,
            archived: false,
            expectedRevision: 0,
          },
        },
      },
    };
  });
}

function completeSave() {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const draft = state.editors[key]!;
    return {
      ...state,
      editors: {
        [key]: {
          ...draft,
          operation: null,
          baseline: {
            workflowId: "flow",
            organizationId: scope.organizationId,
            repositoryId: scope.repositoryId,
            revision: 1,
            definition: draft.operation!.definition,
            archived: false,
            createdAt: "2026",
            updatedAt: "2026",
          },
        },
      },
    };
  });
}

it("blocks router departures, keeps the draft on dismissal, and discards before continuing", async () => {
  const { history } = await mount();
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows");
  expect(dialogText()).toContain("Discard unsaved changes?");
  expect(dialogText()).toContain("Unsaved");
  await click("Keep editing");
  expect(history.location.pathname).toBe("/workflows");
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.definition.name).toBe("Unsaved");
  await act(async () => {
    history.push("/settings");
  });
  await click("Discard and leave");
  expect(history.location.pathname).toBe("/settings");
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBeUndefined();
  expect(appAtomRegistry.get(workflowDraftAtom).newWorkflowIds).toEqual({});
  expect(onDiscard).toHaveBeenCalledOnce();
  expect(onCheckSavedVersion).not.toHaveBeenCalled();
});
it("keeps edits on dialog dismissal and lets a cleared account leave without a prompt", async () => {
  const { history } = await mount();
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows");
  await act(() => renderer!.root.findByProps({ "data-dialog": true }).props.onDismiss());
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBeDefined();
  setWorkflowSessionAccount(appAtomRegistry, null);
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/settings");
});

it.each([
  ["pending", "Save in progress", "Stay"],
  ["uncertain", "Save not confirmed", "Check saved version"],
] as const)("keeps or leaves a workflow with a %s save", async (saveState, title, stayAction) => {
  setSaveState(saveState);
  const initialDraft = appAtomRegistry.get(workflowDraftAtom).editors[key];
  const { history } = await mount();

  await act(async () => {
    history.push("/settings");
  });
  expect(dialogText()).toContain(title);
  expect(dialogText()).toContain(initialDraft?.definition.name);
  expect(dialogText()).toContain(
    "If you leave and the save doesn’t complete, your edits will be lost.",
  );
  await click(stayAction);
  expect(history.location.pathname).toBe("/workflows");
  expect(renderer!.root.findAllByProps({ "data-dialog": true })).toHaveLength(0);
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBe(initialDraft);
  expect(onDiscard).not.toHaveBeenCalled();
  expect(onCheckSavedVersion).toHaveBeenCalledTimes(saveState === "uncertain" ? 1 : 0);

  await act(async () => {
    history.push("/settings");
  });
  await click("Leave anyway");
  expect(history.location.pathname).toBe("/settings");
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toBeUndefined();
  expect(onDiscard).toHaveBeenCalledOnce();
});

it("offers Stay while another read is active and restores Check when it finishes", async () => {
  setSaveState("uncertain");
  const { history, setReading } = await mount();
  await setReading(true);

  await act(async () => {
    history.push("/settings");
  });
  expect(dialogText()).toContain("Save not confirmed");
  expect(dialogText()).not.toContain("Check saved version");
  await click("Stay");
  expect(history.location.pathname).toBe("/workflows");
  expect(onCheckSavedVersion).not.toHaveBeenCalled();

  await act(async () => {
    history.push("/settings");
  });
  await setReading(false);
  expect(history.location.pathname).toBe("/workflows");
  expect(dialogText()).toContain("Check saved version");
  await click("Check saved version");
  expect(history.location.pathname).toBe("/workflows");
  expect(onCheckSavedVersion).toHaveBeenCalledOnce();
  expect(onDiscard).not.toHaveBeenCalled();
});

it.each([false, true])(
  "counts automation as submitted only when the save included it (%s)",
  async (includesAutomation) => {
    const automation = {
      enabled: true,
      trigger: {
        provider: "linear",
        connectionId: "connection",
        grantId: "grant",
        teamId: "team",
        event: "issue_created",
        labelIds: [],
      },
    } as const;
    setSaveState("pending");
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const draft = state.editors[key]!;
      return {
        ...state,
        editors: {
          [key]: {
            ...draft,
            automation,
            baseline: {
              workflowId: "flow",
              organizationId: scope.organizationId,
              repositoryId: scope.repositoryId,
              revision: 1,
              definition: draft.definition,
              automation: { enabled: false, trigger: null },
              archived: false,
              createdAt: "2026",
              updatedAt: "2026",
            },
            operation: { ...draft.operation!, automation, includesAutomation, expectedRevision: 1 },
          },
        },
      };
    });
    const { history } = await mount();

    await act(async () => {
      history.push("/settings");
    });
    expect(dialogText()).toContain("Save in progress");
    expect(dialogText().includes("Edits outside that save will be lost if you leave.")).toBe(
      !includesAutomation,
    );
  },
);

it("stays in the editor when checking the saved version confirms the save", async () => {
  setSaveState("uncertain");
  onCheckSavedVersion.mockImplementationOnce(completeSave);
  const { history } = await mount();

  await act(async () => {
    history.push("/settings");
  });
  await click("Check saved version");

  expect(history.location.pathname).toBe("/workflows");
  expect(renderer!.root.findAllByProps({ "data-dialog": true })).toHaveLength(0);
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline?.revision).toBe(1);
  expect(onDiscard).not.toHaveBeenCalled();
});

it("continues the original departure if the submitted Save completes while its dialog is open", async () => {
  setSaveState("pending");
  const { history } = await mount();
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows");
  expect(dialogText()).toContain("Save in progress");

  await act(completeSave);

  expect(history.location.pathname).toBe("/settings");
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline?.revision).toBe(1);
  expect(onDiscard).not.toHaveBeenCalled();
});

it("promotes the same recovered Create without discarding later edits and still blocks real departures", async () => {
  const { history } = await mount(["/workflows/repo/new"]);
  await act(() =>
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const draft = state.editors[key]!;
      return {
        ...state,
        editors: {
          [key]: {
            ...draft,
            baseline: {
              workflowId: "flow",
              repositoryId: scope.repositoryId,
              organizationId: scope.organizationId,
              definition: { ...draft.definition, name: "Original saved name" },
              revision: 1,
              archived: false,
              createdAt: "2026",
              updatedAt: "2026",
            },
          },
        },
      };
    }),
  );
  await act(async () => {
    history.replace("/workflows/repo/flow/edit");
  });
  expect(history.location.pathname).toBe("/workflows/repo/flow/edit");
  expect(renderer!.root.findAllByProps({ "data-dialog": true })).toHaveLength(0);
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.definition.name).toBe("Unsaved");
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows/repo/flow/edit");
  await click("Keep editing");
});
for (const destination of ["/workflows/repo/other/edit", "/workflows/other/flow/edit"])
  it(`does not exempt another workflow or repository from departure protection: ${destination}`, async () => {
    const { history } = await mount(["/workflows/repo/new"]);
    await act(() =>
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
        const draft = state.editors[key]!;
        return {
          ...state,
          editors: {
            [key]: {
              ...draft,
              baseline: {
                workflowId: "flow",
                repositoryId: scope.repositoryId,
                organizationId: scope.organizationId,
                definition: { ...draft.definition, name: "Saved name" },
                revision: 1,
                archived: false,
                createdAt: "2026",
                updatedAt: "2026",
              },
            },
          },
        };
      }),
    );
    await act(async () => {
      history.push(destination);
    });
    expect(history.location.pathname).toBe("/workflows/repo/new");
    expect(renderer!.root.findAllByProps({ "data-dialog": true })).toHaveLength(1);
    await click("Keep editing");
  });
