import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
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
          environmentId: EnvironmentId.make("environment"),
          projectId: ProjectId.make("project"),
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
  const root = createRootRoute({ component: Outlet });
  const editor = createRoute({
    getParentRoute: () => root,
    path: "workflows",
    component: () => <WorkflowEditorDepartureGuard scope={scope} id="flow" onDiscard={() => {}} />,
  });
  const destination = createRoute({
    getParentRoute: () => root,
    path: "settings",
    component: () => <p>Catalog</p>,
  });
  const createEditor = createRoute({
    getParentRoute: () => root,
    path: "workflows/$repositoryId/new",
    component: () => <WorkflowEditorDepartureGuard scope={scope} id="flow" onDiscard={() => {}} />,
  });
  const savedEditor = createRoute({
    getParentRoute: () => root,
    path: "workflows/$repositoryId/$workflowId/edit",
    component: () => <WorkflowEditorDepartureGuard scope={scope} id="flow" onDiscard={() => {}} />,
  });
  const history = createMemoryHistory({ initialEntries });
  const router = createRouter({
    routeTree: root.addChildren([editor, destination, createEditor, savedEditor]),
    history,
  });
  await router.load();
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
    );
  });
  vi.stubGlobal("document", {});
  return { router, history };
}
async function click(label: string) {
  await act(() =>
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick(),
  );
}
it("blocks router departures, keeps the draft on dismissal, and discards before continuing", async () => {
  const { history } = await mount();
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows");
  expect(renderer!.root.findAllByProps({ "data-dialog": true })).toHaveLength(1);
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

it("continues the original departure if the submitted Save completes while its dialog is open", async () => {
  const { history } = await mount();
  await act(async () => {
    history.push("/settings");
  });
  expect(history.location.pathname).toBe("/workflows");
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
              organizationId: scope.organizationId,
              repositoryId: scope.repositoryId,
              revision: 1,
              definition: draft.definition,
              archived: false,
              createdAt: "2026",
              updatedAt: "2026",
            },
          },
        },
      };
    }),
  );
  expect(history.location.pathname).toBe("/settings");
  expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline?.revision).toBe(1);
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
