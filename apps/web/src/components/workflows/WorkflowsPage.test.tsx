import { act, createElement, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { it } from "@effect/vitest";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflow,
  SaveRepositoryWorkflow,
  WorkflowJobPage,
  WorkflowJobPageQuery,
} from "@t3tools/contracts/workflows";
import type { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  setWorkflowSessionAccount,
  workflowDraftAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const fixture = vi.hoisted(() => ({
  definitions: vi.fn<() => Promise<ReadonlyArray<RepositoryWorkflow>>>(),
  page: vi.fn<(query: WorkflowJobPageQuery) => Promise<WorkflowJobPage>>(),
  navigate: vi.fn(),
  tab: "runs",
  supported: false,
  save: vi.fn<(payload: typeof SaveRepositoryWorkflow.Type) => Promise<RepositoryWorkflow>>(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "account" }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useParams: () => ({ repositoryId: "repository" }),
  useSearch: () => ({ tab: fixture.tab }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../../cloud/managedRelayState", () => ({
  useManagedRelayOrganizationCatalog: () => ({
    data: catalog,
    accountId: "account",
    isPending: false,
    error: null,
  }),
}));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: fixture.navigate }),
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("./workflowState", async () => ({
  ...(await vi.importActual("./workflowState")),
  useWorkflowClient: () => call,
}));
vi.mock("./WorkflowBuilder", () => ({ WorkflowBuilder: () => null }));
vi.mock("./WorkflowRun", () => ({ WorkflowRun: () => null }));
vi.mock("./WorkflowJob", () => ({ WorkflowJob: () => null }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
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

import { WorkflowsPage } from "./WorkflowsPage";
import type { useWorkflowClient } from "./workflowState";

const repositoryId = RelayRepositoryId.make("repository");
const catalog = {
  membership: { role: "admin", organization: { organizationId: "organization" } },
  repositories: [
    {
      repository: {
        repositoryId,
        organizationId: "organization",
        name: "Repository",
        canonicalKeys: [],
      },
      role: "maintainer",
    },
  ],
  projects: [],
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
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
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
  environmentId: workflow.definition.environmentId,
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
  renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
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
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  deliveries = [];
  fixture.definitions.mockReset();
  fixture.page.mockReset();
  fixture.navigate.mockReset();
  fixture.save.mockReset();
  fixture.tab = "runs";
  fixture.supported = false;
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, "account");
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
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
        expect(content()).toContain("Completed runs, newest first.");
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
async function mountCatalog() {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowsPage />
      </AppAtomRegistryProvider>,
    );
  });
  await act(async () => {
    await Promise.all(deliveries);
  });
}
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
          expect(draft?.automation?.enabled).toBe(true);
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
it.effect(
  "turns Off the saved complete rule and reconciles a lost reply without a second write",
  () =>
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
        let current: RepositoryWorkflow = { ...workflow, automation: { enabled: true, trigger } };
        fixture.definitions.mockImplementation(async () => [current]);
        fixture.save.mockImplementation(async (payload) => {
          current = {
            ...current,
            ...payload,
            automation: payload.automation ?? current.automation,
            revision: current.revision + 1,
          };
          throw new Error("Reply lost after commit");
        });
        await mountCatalog();
        await press("Turn Off");
        // Follow-up refresh is queued by the action after its receipt.
        await act(async () => {
          await Promise.all(deliveries);
        });
        expect(fixture.save).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedRevision: 1,
            definition: workflow.definition,
            automation: { enabled: false, trigger },
          }),
        );
        expect(content()).toContain("Automatic triggering Off");
        await press("Retry");
        await act(async () => {
          await Promise.all(deliveries);
        });
        expect(fixture.save).toHaveBeenCalledTimes(1);
        expect(button("Turn On")).toBeDefined();
      });
    }),
);
