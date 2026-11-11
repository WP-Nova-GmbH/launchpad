import {
  act,
  cloneElement,
  createElement,
  useCallback,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { it } from "@effect/vitest";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  RelayMachineId,
  RelayRepositoryId,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflow,
  SaveRepositoryWorkflow,
  WorkflowJobPage,
  WorkflowJobPageQuery,
  WorkflowCatalog,
} from "@t3tools/contracts/workflows";
import type { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  setWorkflowSessionAccount,
  workflowDraftAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { workflowVmCodexInstanceId } from "../settings/workflowModels";

const fixture = vi.hoisted(() => ({
  definitions: vi.fn<() => Promise<ReadonlyArray<RepositoryWorkflow>>>(),
  page: vi.fn<(query: WorkflowJobPageQuery) => Promise<WorkflowJobPage>>(),
  navigate: vi.fn(),
  refreshCatalog: vi.fn<() => void | Promise<void>>(),
  codexStatus: vi.fn<() => Promise<"connected" | "disconnected" | "reconnect_required">>(),
  tab: "runs",
  workflowId: undefined as string | undefined,
  supported: false,
  vmAuthoring: undefined as WorkflowCatalog["vmAuthoring"],
  vmExecutionAvailable: false,
  projectsUnavailable: false,
  projects: [] as ReadonlyArray<RelayOrganizationProject>,
  repositoryError: null as string | null,
  authStatus: "ready" as "loading" | "error" | "ready",
  signedIn: true,
  save: vi.fn<(payload: typeof SaveRepositoryWorkflow.Type) => Promise<RepositoryWorkflow>>(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({
    isLoaded: fixture.authStatus === "ready",
    isSignedIn: fixture.signedIn,
    userId: fixture.signedIn ? "account" : null,
  }),
  ClerkLoading: ({ children }: PropsWithChildren) =>
    fixture.authStatus === "loading" ? children : null,
  ClerkFailed: ({ children }: PropsWithChildren) =>
    fixture.authStatus === "error" ? children : null,
  ClerkLoaded: ({ children }: PropsWithChildren) =>
    fixture.authStatus === "ready" ? children : null,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useLocation: () => undefined,
  useParams: () => ({ repositoryId: "repository", workflowId: fixture.workflowId }),
  useSearch: () => ({ tab: fixture.tab }),
}));
vi.mock(import("../../cloud/publicConfig"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCloudPublicConfig: () => true,
}));
vi.mock("../../cloud/managedRelayState", () => ({
  useManagedRelayOrganizationCatalog: () => {
    const [, refreshSnapshot] = useState(0);
    const refresh = useCallback(() => {
      const result = fixture.refreshCatalog();
      if (result) void result.then(() => refreshSnapshot((version) => version + 1));
      else refreshSnapshot((version) => version + 1);
    }, []);
    return {
      data: fixture.repositoryError
        ? undefined
        : {
            ...catalog,
            projects: fixture.projects,
            ...(fixture.projectsUnavailable ? { projectsUnavailable: true } : {}),
          },
      accountId: "account",
      refresh,
      isPending: false,
      error: fixture.repositoryError,
    };
  },
}));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: fixture.navigate }),
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("./workflowState", async () => ({
  ...(await vi.importActual("./workflowState")),
  useWorkflowClient: () => call,
}));
vi.mock("./WorkflowEditorDepartureGuard", () => ({ WorkflowEditorDepartureGuard: () => null }));
vi.mock("./WorkflowRun", () => ({ WorkflowRun: () => null }));
vi.mock("./WorkflowJob", () => ({ WorkflowJob: () => null }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));
vi.mock("../ui/dialog", () => {
  const part = ({ children }: PropsWithChildren) => children;
  return {
    Dialog: part,
    DialogPopup: part,
    DialogTitle: part,
    DialogDescription: part,
    DialogHeader: part,
    DialogPanel: part,
    DialogFooter: part,
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/select", () => {
  const component = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Select: ({ children, ...props }: PropsWithChildren) =>
      createElement("div", { ...props, "data-workflow-select": true }, children),
    SelectTrigger: component,
    SelectValue: component,
    SelectPopup: component,
    SelectItem: ({ children, ...props }: PropsWithChildren) =>
      createElement("div", { ...props, "data-workflow-select-item": true }, children),
  };
});

import { WorkflowsPage } from "./WorkflowsPage";
import type { useWorkflowClient } from "./workflowState";

const repositoryId = RelayRepositoryId.make("repository");
const canonicalKey = "github.com/launchpad/example";
const catalog = {
  membership: { role: "admin", organization: { organizationId: "organization" } },
  repositories: [
    {
      repository: {
        repositoryId,
        organizationId: "organization",
        name: "Repository",
        canonicalKeys: [canonicalKey],
      },
      role: "maintainer",
    },
  ],
};
const checkout: RelayOrganizationProject = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  machineId: RelayMachineId.make("machine"),
  machineLabel: "Build machine",
  title: "Workflow checkout",
  repositoryCanonicalKey: canonicalKey,
  createdAt: "now",
  updatedAt: "now",
  catalogUpdatedAt: "now",
};
type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
class FixtureReadError extends Data.TaggedError("FixtureReadError")<{ readonly message: string }> {}
const readError = (cause: unknown) =>
  new FixtureReadError({
    message: cause instanceof Error ? cause.message : "Fixture read failed.",
  });
const client = {
  readWorkflowCatalog: () =>
    Effect.tryPromise({
      try: async () => {
        const workflows = await fixture.definitions();
        return {
          workflows,
          vmAuthoring: fixture.vmAuthoring,
          vmExecutionAvailable: fixture.vmExecutionAvailable,
          ...(fixture.supported
            ? {
                automationSupported: true,
                automationSummaries: workflows.map((entry) => ({
                  workflowId: entry.workflowId,
                  revision: entry.revision,
                  state: entry.automation?.enabled ? ("on" as const) : ("off" as const),
                  reason: null,
                })),
              }
            : {}),
        };
      },
      catch: readError,
    }),
  listWorkflows: () => Effect.tryPromise({ try: () => fixture.definitions(), catch: readError }),
  getCodexVmConnection: () =>
    Effect.tryPromise({
      try: async () => ({ status: await fixture.codexStatus() }),
      catch: readError,
    }),
  saveWorkflow: ({ payload }: Parameters<Client["saveWorkflow"]>[0]) =>
    Effect.tryPromise({ try: () => fixture.save(payload), catch: readError }),
  pageWorkflowJobs: ({ query }: Parameters<Client["pageWorkflowJobs"]>[0]) =>
    Effect.tryPromise({ try: () => fixture.page(query), catch: readError }),
} as unknown as Client;
let reads: Queue.Queue<Effect.Effect<void>>;
let deliveries: Array<Promise<void>> = [];
const call: ReturnType<typeof useWorkflowClient> = (operation) => {
  const receipt = deferred<void>();
  deliveries.push(receipt.promise);
  return new Promise((resolve, reject) => {
    Queue.offerUnsafe(
      reads,
      operation(client, "fixture-token").pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            reject(Cause.squash(cause));
            receipt.resolve();
          },
          onSuccess: (value) => {
            resolve(value);
            receipt.resolve();
          },
        }),
      ),
    );
  });
};
const workflow: RepositoryWorkflow = {
  workflowId: "workflow",
  repositoryId,
  organizationId: "organization",
  archived: false,
  revision: 1,
  definition: {
    name: "Recovered workflow",
    target: {
      kind: "machine" as const,
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("project"),
    },
    steps: [
      {
        id: "agent",
        kind: "agent",
        title: "Implement",
        instruction: "Implement",
        modelSelection: null,
      },
    ],
  },
  createdAt: "2026-10-15",
  updatedAt: "2026-10-15",
};
const row = (jobId: string) => ({
  jobId,
  repositoryId,
  workflowId: workflow.workflowId,
  runtime: workflow.definition.target.kind === "machine" ? workflow.definition.target : null,
  instruction: jobId,
  status: "done" as const,
  detail: null,
  createdAt: "2026-10-15",
  updatedAt: "2026-10-15",
});
let renderer: ReactTestRenderer | undefined;
function text(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  return (node.children ?? []).map(text).join(" ");
}
const content = () => text(renderer!.toJSON());
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find(
      (node) =>
        node.props["aria-label"] === label ||
        node.children.filter((child) => typeof child === "string").join("") === label,
    )!;
async function press(label: string, waitForReads = true) {
  const before = deliveries.length;
  await act(async () => {
    button(label).props.onClick();
  });
  if (waitForReads)
    await act(async () => {
      await Promise.all(deliveries.slice(before));
    });
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  deliveries = [];
  fixture.definitions.mockReset();
  fixture.page.mockReset();
  fixture.navigate.mockReset();
  fixture.refreshCatalog.mockReset();
  fixture.codexStatus.mockReset().mockResolvedValue("connected");
  fixture.save.mockReset();
  fixture.tab = "runs";
  fixture.workflowId = undefined;
  fixture.supported = false;
  fixture.vmAuthoring = undefined;
  fixture.vmExecutionAvailable = false;
  fixture.projectsUnavailable = false;
  fixture.projects = [];
  fixture.repositoryError = null;
  fixture.authStatus = "ready";
  fixture.signedIn = true;
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, "account");
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("replaces failed sign-in loading with an error and lets the user retry", async () => {
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  fixture.authStatus = "loading";
  fixture.signedIn = false;
  const page = () => (
    <AppAtomRegistryProvider>
      <WorkflowsPage />
    </AppAtomRegistryProvider>
  );
  await act(async () => {
    renderer = create(page());
  });
  expect(
    renderer!.root.findAllByType("svg").filter((node) => node.props.role === "status"),
  ).toHaveLength(1);

  fixture.authStatus = "error";
  await act(async () => renderer!.update(page()));
  expect(content()).toContain("Could not load Launchpad Connect sign-in");
  expect(
    renderer!.root.findAllByType("div").filter((node) => node.props.role === "alert"),
  ).toHaveLength(1);
  expect(
    renderer!.root.findAllByType("svg").filter((node) => node.props.role === "status"),
  ).toHaveLength(0);
  expect(fixture.definitions).not.toHaveBeenCalled();
  await press("Retry", false);
  expect(reload).toHaveBeenCalledOnce();

  fixture.authStatus = "ready";
  await act(async () => renderer!.update(page()));
  expect(content()).toContain("Sign in to Launchpad Connect to manage repository workflows.");
  expect(
    renderer!.root.findAllByType("div").filter((node) => node.props.role === "alert"),
  ).toHaveLength(0);
});

it.effect(
  "waits for VM authoring capability and creates a VM draft when checkouts are unavailable",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Effect.Effect<void>>();
      reads = queue;
      yield* Effect.forever(
        Queue.take(queue).pipe(Effect.flatMap((read) => read.pipe(Effect.forkScoped))),
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(async () => {
        const metadata = deferred<ReadonlyArray<RepositoryWorkflow>>();
        fixture.tab = "workflows";
        fixture.projectsUnavailable = true;
        fixture.definitions.mockReturnValueOnce(metadata.promise);
        await act(() => {
          renderer = create(
            <AppAtomRegistryProvider>
              <WorkflowsPage />
            </AppAtomRegistryProvider>,
          );
        });
        const scope = { accountId: "account", organizationId: "organization", repositoryId };
        const slot = workflowSessionKey(scope, "new");
        expect(button("Create workflow")).toBeUndefined();
        expect(appAtomRegistry.get(workflowDraftAtom).newWorkflowIds[slot]).toBeUndefined();
        fixture.vmAuthoring = { models: null };
        await act(async () => {
          metadata.resolve([
            {
              ...workflow,
              definition: {
                ...workflow.definition,
                target: { kind: "vm", baseBranch: "release/1.x" },
              },
            },
          ]);
          await Promise.all(deliveries);
        });
        expect(content()).toContain("release/1.x");
        expect(content()).toContain("VM execution unavailable");
        expect(button("Run")).toBeUndefined();
        await press("Create workflow");
        const state = appAtomRegistry.get(workflowDraftAtom);
        const id = state.newWorkflowIds[slot]!;
        expect(state.editors[workflowSessionKey(scope, id)]).toMatchObject({
          definition: { target: { kind: "vm", baseBranch: null } },
          targetConfirmed: true,
        });
        expect(fixture.navigate).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "/workflows/$repositoryId/new",
          }),
        );
      });
    }),
);

it("keeps repository authorization failures separate from unavailable Machine checkouts", async () => {
  fixture.repositoryError = "Repository access denied.";
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowsPage />
      </AppAtomRegistryProvider>,
    );
  });
  expect(content()).toContain("Repository access denied.");
  expect(button("Create workflow")).toBeUndefined();
  expect(fixture.definitions).not.toHaveBeenCalled();
});

it.effect(
  "recovers workflow names and metadata errors from Runs refresh while retaining the selected list view",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Effect.Effect<void>>();
      reads = queue;
      yield* Effect.forever(
        Queue.take(queue).pipe(Effect.flatMap((read) => read.pipe(Effect.forkScoped))),
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(async () => {
        const metadata = deferred<ReadonlyArray<RepositoryWorkflow>>();
        fixture.definitions
          .mockRejectedValueOnce(new Error("Metadata offline"))
          .mockReturnValueOnce(metadata.promise);
        fixture.page
          .mockResolvedValueOnce({ jobs: [row("Initial active run")], nextCursor: null })
          .mockResolvedValueOnce({ jobs: [row("First history run")], nextCursor: "next" })
          .mockResolvedValueOnce({ jobs: [row("Older history run")], nextCursor: null })
          .mockResolvedValueOnce({ jobs: [row("Refreshed history run")], nextCursor: null });
        await act(async () => {
          renderer = create(
            <AppAtomRegistryProvider>
              <WorkflowsPage />
            </AppAtomRegistryProvider>,
          );
        });
        // Definitions settle first; their loaded state then mounts the independent runs read.
        await act(async () => {
          await deliveries[0];
        });
        await act(async () => {
          await deliveries[1];
        });
        expect(content()).toContain("Metadata offline");
        expect(content()).toContain("Workflow run");
        await press("History");
        await press("Load more runs");
        expect(content()).toContain("Older history run");
        await press("Refresh runs", false);
        expect(button("Refresh runs").props.disabled).toBe(true);
        await act(async () => {
          metadata.resolve([workflow]);
          await metadata.promise;
          await Promise.all(deliveries.slice(-2));
        });
        expect(content()).toContain("Recovered workflow");
        expect(content()).toContain("Refreshed history run");
        expect(button("History").props["aria-pressed"]).toBe(true);
        expect(content()).not.toContain("Metadata offline");
        expect(content()).not.toContain("Older history run");
        expect(button("Refresh runs").props.disabled).toBe(false);
        expect(fixture.navigate).not.toHaveBeenCalled();
      });
    }),
);

const serve = Effect.gen(function* () {
  reads = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forever(
    Queue.take(reads).pipe(Effect.flatMap((read) => read.pipe(Effect.forkScoped))),
  ).pipe(Effect.forkScoped);
});
async function mountCatalog(view: "catalog" | "builder" = "catalog") {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowsPage view={view} />
      </AppAtomRegistryProvider>,
      { createNodeMock: (element) => (element.type === "form" ? {} : null) },
    );
  });
  await act(async () => {
    await Promise.all(deliveries);
  });
}
const vmWorkflow: RepositoryWorkflow = {
  ...workflow,
  definition: { ...workflow.definition, target: { kind: "vm", baseBranch: null } },
};
async function mountVmEditor(saved = vmWorkflow) {
  fixture.workflowId = saved.workflowId;
  fixture.vmAuthoring = { models: null };
  fixture.definitions.mockResolvedValue([saved]);
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal(
    "HTMLElement",
    class {
      focus() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private readonly resize: (entries: Array<{ contentRect: { width: number } }>) => void,
      ) {}
      observe() {
        this.resize([{ contentRect: { width: 1200 } }]);
      }
      disconnect() {}
    },
  );
  await mountCatalog("builder");
  await act(async () => {
    await Promise.all(deliveries);
  });
}

it.effect("keeps the Run draft reachable after VM receipt recovery while gated and archived", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.tab = "workflows";
      fixture.definitions.mockResolvedValue([vmWorkflow]);
      await mountCatalog();
      expect(content()).toContain("VM execution unavailable");
      expect(button("Run")).toBeUndefined();

      fixture.vmExecutionAvailable = true;
      await press("Refresh workflows");
      await press("Run");
      const route = {
        to: "/workflows/$repositoryId/$workflowId/run",
        params: { repositoryId, workflowId: vmWorkflow.workflowId },
      };
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);

      const scope = { accountId: "account", organizationId: "organization", repositoryId };
      await act(() =>
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          runs: {
            ...state.runs,
            [workflowSessionKey(scope, vmWorkflow.workflowId)]: {
              instruction: "Task",
              operation: {
                requestId: "submitted",
                instruction: "Task",
                targetKind: "vm",
                state: "uncertain",
              },
              startedJobId: null,
              error: null,
            },
          },
        })),
      );
      fixture.vmExecutionAvailable = false;
      await press("Refresh workflows");
      expect(button("Run")).toBeUndefined();
      await press("View run submission");
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);

      await act(() =>
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          runs: {
            ...state.runs,
            [workflowSessionKey(scope, vmWorkflow.workflowId)]: {
              instruction: "New instructions",
              operation: null,
              startedJobId: "existing-run",
              error: null,
            },
          },
        })),
      );
      expect(button("View run submission")).toBeUndefined();
      await press("View retained instructions");
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);

      fixture.definitions.mockResolvedValue([{ ...vmWorkflow, revision: 2, archived: true }]);
      fixture.vmExecutionAvailable = true;
      await press("Refresh workflows");
      expect(button("Run")).toBeUndefined();
      await press("View retained instructions");
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);
    });
  }),
);

it.effect("reopens an uncertain Machine submission with no text after a VM switch or archive", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.tab = "workflows";
      fixture.definitions.mockResolvedValue([workflow]);
      await mountCatalog();
      const scope = { accountId: "account", organizationId: "organization", repositoryId };
      await act(() =>
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          runs: {
            ...state.runs,
            [workflowSessionKey(scope, workflow.workflowId)]: {
              instruction: "",
              operation: { requestId: "submitted", instruction: "Task", state: "uncertain" },
              startedJobId: null,
              error: null,
            },
          },
        })),
      );
      const route = {
        to: "/workflows/$repositoryId/$workflowId/run",
        params: { repositoryId, workflowId: workflow.workflowId },
      };
      fixture.definitions.mockResolvedValue([
        { ...workflow, definition: vmWorkflow.definition, revision: 2 },
      ]);
      await press("Refresh workflows");
      expect(button("Run")).toBeUndefined();
      await press("View run submission");
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);

      fixture.definitions.mockResolvedValue([{ ...workflow, revision: 3, archived: true }]);
      await press("Refresh workflows");
      expect(button("Run")).toBeUndefined();
      await press("View run submission");
      expect(fixture.navigate).toHaveBeenCalledTimes(2);
      expect(fixture.navigate).toHaveBeenLastCalledWith(route);
    });
  }),
);

it.effect("uses catalog Refresh to recover Machine choices and reload workflow definitions", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.tab = "workflows";
      fixture.projectsUnavailable = true;
      fixture.vmAuthoring = { models: null };
      fixture.definitions.mockResolvedValueOnce([]).mockResolvedValueOnce([workflow]);
      await mountCatalog();
      expect(content()).toContain("No workflows yet.");
      fixture.refreshCatalog.mockImplementationOnce(() => {
        fixture.projectsUnavailable = false;
        fixture.projects = [checkout];
      });
      await press("Refresh workflows");
      expect(content()).toContain(workflow.definition.name);
      await press("Create workflow");
      const scope = { accountId: "account", organizationId: "organization", repositoryId };
      const state = appAtomRegistry.get(workflowDraftAtom);
      const id = state.newWorkflowIds[workflowSessionKey(scope, "new")]!;
      expect(state.editors[workflowSessionKey(scope, id)]?.targetConfirmed).toBe(false);
    });
  }),
);

it.effect("copies using the checkout catalog refreshed while the source read is pending", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.tab = "workflows";
      fixture.projects = [checkout];
      fixture.vmAuthoring = { models: null };
      fixture.definitions.mockResolvedValue([workflow]);
      await mountCatalog();

      const refreshed = deferred<void>();
      fixture.refreshCatalog.mockReturnValueOnce(refreshed.promise);
      await press("Refresh workflows");
      const copy = renderer!.root
        .findAllByType("button")
        .find(
          (node) =>
            Array.isArray(node.props.children) &&
            node.props.children.some(
              (child: unknown) => typeof child === "string" && child.trim() === "Copy",
            ),
        )!;
      await act(() => copy.props.onClick());

      const source = deferred<ReadonlyArray<RepositoryWorkflow>>();
      fixture.definitions.mockReturnValueOnce(source.promise);
      const beforeCopy = deliveries.length;
      await press("Copy saved workflow", false);
      const copyReads = deliveries.slice(beforeCopy);
      await act(() => {
        fixture.projects = [];
        refreshed.resolve();
      });
      await act(async () => {
        source.resolve([workflow]);
        await Promise.all(copyReads);
      });

      const scope = { accountId: "account", organizationId: "organization", repositoryId };
      const state = appAtomRegistry.get(workflowDraftAtom);
      const id = state.newWorkflowIds[workflowSessionKey(scope, "new")]!;
      expect(state.editors[workflowSessionKey(scope, id)]).toMatchObject({
        targetConfirmed: true,
        definition: {
          name: `Copy of ${workflow.definition.name}`,
          target: { kind: "vm", baseBranch: null },
        },
      });
      expect(fixture.navigate).toHaveBeenLastCalledWith({
        to: "/workflows/$repositoryId/new",
        params: { repositoryId },
      });
    });
  }),
);

it.effect("refreshes open editor dependencies and ignores a late Codex status failure", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.projectsUnavailable = true;
      fixture.codexStatus.mockRejectedValueOnce(new Error("Initial status error"));
      await mountVmEditor();
      expect(content()).toContain("Could not check the organization's Codex connection.");
      await act(() =>
        renderer!.root.findByProps({ "aria-label": "Workflow settings" }).props.onClick(),
      );
      await act(() =>
        renderer!.root.findByProps({ placeholder: "Repository default" }).props.onChange({
          target: { value: "release/1.x" },
        }),
      );
      const findMachine = () =>
        renderer!.root.findByProps({ "data-workflow-select-item": true, value: "machine" });
      expect(findMachine().props.disabled).toBe(true);
      expect(content()).toContain("Machine checkouts could not be loaded.");

      const earlierStatus = deferred<"connected">();
      fixture.codexStatus.mockReturnValueOnce(earlierStatus.promise);
      fixture.refreshCatalog.mockImplementationOnce(() => {
        fixture.projectsUnavailable = false;
        fixture.projects = [checkout];
      });
      const firstRetry = deliveries.length;
      await press("Refresh workflows", false);
      const firstRetryReceipts = deliveries.slice(firstRetry);
      await press("Refresh workflows");
      expect(fixture.codexStatus).toHaveBeenCalledTimes(3);
      expect(content()).not.toContain("Could not check the organization's Codex connection.");
      await act(async () => {
        earlierStatus.reject(new Error("Stale retry failed"));
        await Promise.all(firstRetryReceipts);
      });
      expect(content()).not.toContain("Could not check the organization's Codex connection.");
      expect(findMachine().props.disabled).toBe(false);
      expect(renderer!.root.findByProps({ placeholder: "Repository default" }).props.value).toBe(
        "release/1.x",
      );
      await act(() =>
        renderer!.root
          .findByProps({ "data-workflow-select": true, value: "vm" })
          .props.onValueChange("machine"),
      );
      expect(content()).toContain("Build machine · Workflow checkout");
    });
  }),
);

it.effect("keeps an explicit VM model through a missing proof and saves it once verified", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      const modelSelection = { instanceId: workflowVmCodexInstanceId, model: "saved-model" };
      const saved: RepositoryWorkflow = {
        ...vmWorkflow,
        definition: {
          ...vmWorkflow.definition,
          steps: vmWorkflow.definition.steps.map((step) =>
            step.kind === "agent" ? { ...step, modelSelection } : step,
          ),
        },
      };
      await mountVmEditor(saved);
      const name = () => renderer!.root.findByProps({ "aria-label": "Workflow name" });
      await act(() => name().props.onChange({ target: { value: "Edited VM workflow" } }));
      const submit = () =>
        act(async () => {
          renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
        });
      await submit();
      expect(content()).toContain("saved-model (Unverified)");
      expect(content()).toContain("Select the managed default before saving");
      expect(fixture.save).not.toHaveBeenCalled();
      fixture.vmAuthoring = {
        models: {
          defaultModel: "saved-model",
          models: [
            { slug: "saved-model", name: "Verified model", isCustom: false, capabilities: null },
          ],
        },
      };
      await press("Refresh workflows");
      expect(content()).toContain("Verified model");
      expect(content()).not.toContain("Select the managed default before saving");
      fixture.save.mockImplementation(async ({ definition }) => ({
        ...saved,
        revision: 2,
        definition,
      }));
      await submit();
      await act(async () => {
        await Promise.all(deliveries);
      });
      expect(fixture.save).toHaveBeenCalledWith(
        expect.objectContaining({
          definition: expect.objectContaining({
            name: "Edited VM workflow",
            steps: [expect.objectContaining({ modelSelection })],
          }),
        }),
      );
    });
  }),
);

for (const savedVm of [false, true])
  it.effect(
    `opens trigger settings for a ${savedVm ? "saved" : "draft"} VM workflow without enabling automation`,
    () =>
      Effect.gen(function* () {
        yield* serve;
        yield* Effect.promise(async () => {
          fixture.tab = "workflows";
          fixture.supported = true;
          fixture.vmAuthoring = { models: null };
          const scope = { accountId: "account", organizationId: "organization", repositoryId };
          const key = workflowSessionKey(scope, workflow.workflowId);
          const definition = {
            ...workflow.definition,
            target: { kind: "vm" as const, baseBranch: null },
          };
          const automation = { enabled: false, trigger: null };
          const baseline = {
            ...workflow,
            definition: savedVm ? definition : workflow.definition,
            automation,
          };
          fixture.definitions.mockResolvedValue([baseline]);
          updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
            ...state,
            editors: {
              ...state.editors,
              [key]: {
                workflowId: workflow.workflowId,
                definition,
                baseline,
                automation,
                selectedStepId: "",
                targetConfirmed: true,
                operation: null,
                error: "Save could not be completed.",
              },
            },
          }));
          await mountCatalog();
          expect(button("Turn On")).toBeUndefined();
          await press("Trigger settings");
          expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toMatchObject({
            triggerSetup: true,
            definition,
            automation,
          });
          expect(fixture.save).not.toHaveBeenCalled();
        });
      }),
  );

for (const retained of [false, true])
  it.effect(
    `opens trigger setup for On without a trigger while preserving saved Off (retained unknown draft: ${retained})`,
    () =>
      Effect.gen(function* () {
        yield* serve;
        yield* Effect.promise(async () => {
          fixture.tab = "workflows";
          fixture.supported = true;
          fixture.definitions.mockResolvedValue([
            { ...workflow, automation: { enabled: false, trigger: null } },
          ]);
          if (retained) {
            const scope = { accountId: "account", organizationId: "organization", repositoryId };
            updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
              ...state,
              editors: {
                ...state.editors,
                [workflowSessionKey(scope, workflow.workflowId)]: {
                  workflowId: workflow.workflowId,
                  definition: { ...workflow.definition, name: "Retained name" },
                  baseline: workflow,
                  automation: { enabled: false, trigger: null },
                  selectedStepId: "",
                  targetConfirmed: true,
                  operation: null,
                  error: null,
                },
              },
            }));
          }
          await mountCatalog();
          await press("Turn On");
          expect(fixture.navigate).toHaveBeenCalledWith(
            expect.objectContaining({ to: "/workflows/$repositoryId/$workflowId/edit" }),
          );
          const draft =
            appAtomRegistry.get(workflowDraftAtom).editors[
              workflowSessionKey(
                { accountId: "account", organizationId: "organization", repositoryId },
                workflow.workflowId,
              )
            ];
          expect(draft?.triggerSetup).toBe(true);
          expect(draft?.automation?.enabled).toBe(false);
          expect(draft?.automationResolved).toBe(true);
          if (retained) expect(draft?.definition.name).toBe("Retained name");
          expect(draft?.baseline?.automation?.enabled).toBe(false);
          expect(fixture.save).not.toHaveBeenCalled();
        });
      }),
  );
it.effect(
  "keeps automation unknown against a legacy relay that omits capability even with an On record",
  () =>
    Effect.gen(function* () {
      yield* serve;
      yield* Effect.promise(async () => {
        fixture.tab = "workflows";
        fixture.definitions.mockResolvedValue([
          { ...workflow, automation: { enabled: true, trigger: null } },
        ]);
        await mountCatalog();
        expect(content()).toContain("Automation state unavailable on this relay");
        expect(content()).not.toContain("Automatic triggering Off");
        expect(button("Turn Off")).toBeUndefined();
        expect(button("Run")).toBeDefined();
      });
    }),
);
it.effect("opens an Off draft without saving or discarding other workflow edits", () =>
  Effect.gen(function* () {
    yield* serve;
    yield* Effect.promise(async () => {
      fixture.tab = "workflows";
      fixture.supported = true;
      const trigger = {
        provider: "linear",
        connectionId: "connection",
        grantId: "grant",
        teamId: "team",
        event: "issue_created",
        labelIds: ["label"],
      } as const;
      const current: RepositoryWorkflow = { ...workflow, automation: { enabled: true, trigger } };
      const scope = { accountId: "account", organizationId: "organization", repositoryId };
      const key = workflowSessionKey(scope, workflow.workflowId);
      fixture.definitions.mockResolvedValue([current]);
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        editors: {
          ...state.editors,
          [key]: {
            workflowId: workflow.workflowId,
            baseline: current,
            definition: { ...workflow.definition, name: "Unsaved name" },
            automation: { enabled: true, trigger },
            automationResolved: true,
            selectedStepId: "",
            targetConfirmed: true,
            operation: null,
            error: null,
          },
        },
      }));
      await mountCatalog();
      await press("Turn Off");
      expect(fixture.save).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(workflowDraftAtom).editors[key]).toMatchObject({
        definition: { name: "Unsaved name" },
        triggerSetup: true,
        automation: { enabled: false, trigger },
        baseline: { automation: { enabled: true, trigger } },
      });
      expect(fixture.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/workflows/$repositoryId/$workflowId/edit" }),
      );
    });
  }),
);
