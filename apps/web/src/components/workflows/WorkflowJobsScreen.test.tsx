import { act, createElement, type ComponentType, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import type * as Exit from "effect/Exit";
import { it as effectIt } from "@effect/vitest";
import * as Data from "effect/Data";
import { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  setWorkflowSessionAccount,
  workflowDraftAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflowJob,
  RespondToWorkflowJob,
  RepositoryWorkflowJobSummary,
  WorkflowJobPage,
  WorkflowJobPageQuery,
} from "@t3tools/contracts/workflows";

const fixture = vi.hoisted(() => ({
  accountId: "account",
  focused: true,
  getToken: vi.fn().mockResolvedValue("fixture-token"),
  list: vi.fn<(repositoryId: string) => Promise<ReadonlyArray<RepositoryWorkflowJobSummary>>>(),
  page: vi.fn<(repositoryId: string, query: WorkflowJobPageQuery) => Promise<WorkflowJobPage>>(),
  navigate: vi.fn(),
  job: vi.fn<() => RepositoryWorkflowJob>(),
  respond: vi.fn<(payload: typeof RespondToWorkflowJob.Type) => RepositoryWorkflowJob>(),
}));
const host = (name: string) => (props: PropsWithChildren<Record<string, unknown>>) =>
  createElement(
    name,
    props,
    props.children ?? (typeof props.label === "string" ? props.label : null),
  );
class FixtureReadError extends Data.TaggedError("FixtureReadError")<{ readonly message: string }> {}
type Request = {
  effect: Effect.Effect<unknown, FixtureReadError, ManagedRelayTenancy.ManagedRelayTenancyClient>;
  resolve: (result: Exit.Exit<unknown, FixtureReadError>) => void;
};
let requests: Queue.Queue<Request> | null = null;
let deliveries: Array<Promise<Exit.Exit<unknown, FixtureReadError>>> = [];

// The web test harness already owns the renderer. Mock only the native platform edges;
// execute the actual mobile screen so repository selection and its effects stay integrated.
vi.mock(
  "../../../../mobile/node_modules/react/index.js",
  async () => await vi.importActual("react"),
);
vi.mock(
  "../../../../mobile/node_modules/@effect/atom-react",
  async () => await vi.importActual("@effect/atom-react"),
);
vi.mock("../../../../mobile/node_modules/react-native/index.js", () => ({
  View: host("view"),
  Text: host("text"),
  TextInput: host("input"),
  Pressable: host("button"),
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("../../../../mobile/node_modules/@clerk/expo/dist/index.js", () => ({
  useAuth: () => ({ isSignedIn: true, userId: fixture.accountId, getToken: fixture.getToken }),
}));
vi.mock("../../../../mobile/node_modules/@react-navigation/native/lib/module/index.js", () => ({
  useNavigation: () => ({ navigate: fixture.navigate }),
  useIsFocused: () => fixture.focused,
}));
vi.mock("../../../../mobile/src/state/atom-registry", () => ({ appAtomRegistry }));
vi.mock("../../../../mobile/src/features/cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => true,
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("../../../../mobile/src/lib/uuid", () => ({ uuidv4: () => "fixture-control-id" }));
vi.mock("../../../../mobile/src/features/review/reviewState", () => ({
  setReviewSelectedSectionId: vi.fn(),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsScreen", () => ({
  SettingsScreen: host("screen"),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsSection", () => ({
  SettingsSection: host("section"),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsActionRow", () => ({
  SettingsActionRow: host("action"),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsRow", () => ({
  SettingsRow: host("row"),
}));
vi.mock("../../../../mobile/src/lib/runtime", () => ({
  runtime: {
    runPromiseExit: (effect: Request["effect"]) => {
      const delivery = new Promise<Exit.Exit<unknown, FixtureReadError>>((resolve) => {
        if (!requests)
          throw new FixtureReadError({ message: "Native test service is not running" });
        Queue.offerUnsafe(requests, { effect, resolve });
      });
      deliveries.push(delivery);
      return delivery;
    },
  },
}));

const repository = (id: string) => ({
  repository: {
    repositoryId: RelayRepositoryId.make(id),
    organizationId: "organization",
    name: id,
    canonicalKeys: [],
  },
  role: "maintainer",
});
const summary = (id: string): RepositoryWorkflowJobSummary => ({
  jobId: id,
  repositoryId: RelayRepositoryId.make("A"),
  workflowId: "workflow",
  environmentId: EnvironmentId.make("environment"),
  instruction: id,
  status: "done",
  detail: null,
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
});
const detail: RepositoryWorkflowJob = {
  ...summary("Older direct job"),
  workflow: null,
  progress: null,
};
const client = {
  listRepositories: () => Effect.succeed([repository("A"), repository("B")]),
  getOrganization: () => Effect.succeed({ role: "admin" }),
  listOrganizationProjects: () => Effect.succeed([]),
  pageWorkflowJobs: ({
    repositoryId,
    query,
  }: {
    repositoryId: string;
    query: WorkflowJobPageQuery;
  }) =>
    Effect.tryPromise({
      try: () => fixture.page(repositoryId, query),
      catch: (cause) =>
        new FixtureReadError({
          message: cause instanceof Error ? cause.message : "Recent list failed",
        }),
    }),
  getWorkflowJob: () => Effect.sync(() => fixture.job()),
  respondToWorkflowJob: ({ payload }: { payload: typeof RespondToWorkflowJob.Type }) =>
    Effect.sync(() => fixture.respond(payload)),
};
type Params = { repositoryId?: string; jobId?: string };
type Props = { route: { params: Params | undefined } };
const { WorkflowJobsScreen } = await vi.importActual<{ WorkflowJobsScreen: ComponentType<Props> }>(
  "../../../../mobile/src/features/settings/WorkflowJobsScreen",
);
let renderer: ReactTestRenderer | undefined;
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function text(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  return (node.children ?? []).map(text).join(" ");
}
const content = () => text(renderer!.toJSON());
async function mount(params: Params | undefined, waitForList = true) {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <WorkflowJobsScreen route={{ params }} />
      </AppAtomRegistryProvider>,
    );
  });
  // The catalog owns three receipts; selected-job reads stay independent of a delayed list.
  await act(async () => {
    await Promise.all(deliveries.slice(0, 3));
  });
  await act(async () => {
    if (waitForList) await deliveries[3];
    if (params?.jobId) await deliveries[4];
  });
}
async function press(label: string, waitForRead = true) {
  const before = deliveries.length;
  await act(async () => {
    renderer!.root
      .findAll((node) => ["action", "row"].includes(String(node.type)))
      .find((node) => node.props.label === label)!
      .props.onPress();
  });
  if (waitForRead)
    await act(async () => {
      await Promise.all(deliveries.slice(before));
    });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.accountId = "account";
  fixture.focused = true;
  fixture.job.mockReset().mockReturnValue(detail);
  fixture.respond.mockReset();
  fixture.list.mockReset().mockResolvedValue([]);
  fixture.page.mockReset().mockImplementation(async (repositoryId) => ({
    jobs: await fixture.list(repositoryId),
    nextCursor: null,
  }));
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, fixture.accountId);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

effectIt.layer(
  Layer.succeed(
    ManagedRelayTenancy.ManagedRelayTenancyClient,
    client as unknown as ManagedRelayTenancy.ManagedRelayTenancyClient["Service"],
  ),
)("native recent runs through repository and result-return routes", (it) => {
  const screenTest = (name: string, body: () => Promise<void>) =>
    it.effect(name, () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Request>();
        requests = queue;
        deliveries = [];
        yield* Effect.forever(
          Effect.gen(function* () {
            const request = yield* Queue.take(queue);
            yield* Effect.gen(function* () {
              request.resolve(yield* Effect.exit(request.effect));
            }).pipe(Effect.forkScoped);
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(body);
      }),
    );
  for (const operation of ["approve", "input", "request_changes"] as const) {
    screenTest(
      `keeps native controls blocked after a saved ${operation} until a refreshed acknowledgement`,
      async () => {
        const status = operation === "input" ? "awaiting_input" : "awaiting_review";
        const job: RepositoryWorkflowJob = {
          ...detail,
          status,
          responsePending: false,
          progress: {
            revision: 5,
            status,
            threadId: ThreadId.make("thread"),
            detail: null,
            manualPauseSupported: true,
            checkpoint:
              operation === "input"
                ? {
                    kind: "input",
                    checkpointId: "checkpoint",
                    stepId: "input",
                    generation: 0,
                    role: "member",
                    question: "What should the agent do?",
                  }
                : {
                    kind: "review",
                    checkpointId: "checkpoint",
                    turnId: "turn",
                    checkpointRef: "ref",
                    checkpointTurnCount: 1,
                    role: "member",
                  },
          },
        };
        fixture.job.mockReturnValue(job);
        fixture.respond.mockImplementation(() => {
          const pending = { ...job, responsePending: true };
          fixture.job.mockReturnValue(pending);
          return pending;
        });
        await mount({ repositoryId: "A", jobId: job.jobId });
        if (operation === "request_changes") await press("Request changes");
        if (operation !== "approve") {
          await act(() =>
            renderer!.root
              .findAllByType("input")
              .find(
                (node) =>
                  node.props.accessibilityLabel ===
                  (operation === "input" ? "Checkpoint answer" : "Rework feedback"),
              )!
              .props.onChangeText("Keep this response"),
          );
        }
        const before = deliveries.length;
        await act(async () => {
          renderer!.root
            .findAll((node) => String(node.type) === "action")
            .findLast(
              (node) =>
                node.props.label ===
                (operation === "approve"
                  ? "Approve result"
                  : operation === "input"
                    ? "Submit answer"
                    : "Request changes"),
            )!
            .props.onPress();
        });
        await act(async () => {
          await Promise.all(deliveries.slice(before));
        });
        expect(fixture.respond).toHaveBeenCalledTimes(1);
        expect(fixture.respond.mock.calls[0]![0].operation).toBe(operation);
        expect(content()).toContain("Response pending; waiting for the environment.");
        const pendingActions = renderer!.root.findAll(
          (node) => String(node.type) === "action" && node.props.label === "Response pending",
        );
        expect(pendingActions.length).toBeGreaterThan(0);
        expect(pendingActions.every((node) => node.props.disabled)).toBe(true);
        expect(
          renderer!.root.findAll(
            (node) => String(node.type) === "action" && node.props.label === "Pause workflow",
          ),
        ).toHaveLength(0);
        expect(
          renderer!.root
            .findAll((node) => String(node.type) === "action")
            .find((node) => node.props.label === "Cancel job")!.props.disabled,
        ).toBe(false);
        await act(async () => {
          pendingActions[0]!.props.onPress();
        });
        expect(fixture.respond).toHaveBeenCalledTimes(1);
        fixture.job.mockReturnValue({
          ...job,
          status: "running",
          responsePending: false,
          progress: { ...job.progress!, revision: 6, status: "running", checkpoint: null },
        });
        const readsBeforeFocus = deliveries.length;
        fixture.focused = false;
        await act(() =>
          renderer!.update(
            <AppAtomRegistryProvider>
              <WorkflowJobsScreen route={{ params: { repositoryId: "A", jobId: job.jobId } }} />
            </AppAtomRegistryProvider>,
          ),
        );
        fixture.focused = true;
        await act(() =>
          renderer!.update(
            <AppAtomRegistryProvider>
              <WorkflowJobsScreen route={{ params: { repositoryId: "A", jobId: job.jobId } }} />
            </AppAtomRegistryProvider>,
          ),
        );
        await act(async () => {
          await Promise.all(deliveries.slice(readsBeforeFocus));
        });
        expect(content()).not.toContain("Response pending; waiting for the environment.");
        expect(
          renderer!.root
            .findAll((node) => String(node.type) === "action")
            .find((node) => node.props.label === "Pause workflow")!.props.disabled,
        ).toBe(false);
      },
    );
  }
  screenTest(
    "keeps frozen issue details collapsed and expands them without another relay read",
    async () => {
      fixture.job.mockReturnValue({
        ...detail,
        origin: {
          kind: "automation",
          organizationId: "organization",
          repositoryId: "A",
          workflowId: "workflow",
          source: {
            provider: "linear",
            applicationId: "app",
            workspaceId: "workspace",
            connectionId: "source",
            grantId: "grant",
          },
          occurrenceId: "event",
        },
        issueSnapshot: {
          workspaceId: "workspace",
          issueId: "issue",
          identifier: "ENG-123",
          title: "Fix navigation",
          url: "https://linear.app/test/issue/ENG-123",
          description: "Frozen requirements with ![no downloads](https://images.test/private.png)",
          team: { id: "team", name: "Engineering" },
          status: { id: "ready", name: "Ready" },
          labels: [],
          issueUpdatedAt: "2026-10-19",
          retrievedAt: "2026-10-19",
          authorizationEpoch: 1,
          credentialVersion: 1,
        },
      });
      await mount({ repositoryId: "A", jobId: detail.jobId });
      expect(content()).toContain("ENG-123");
      expect(content()).not.toContain("Frozen requirements");
      const readsBefore = deliveries.length;
      const disclosure = () =>
        renderer!.root
          .findAll((node) => node.type === "button")
          .find((node) => node.props.accessibilityState !== undefined)!;
      await act(() => disclosure().props.onPress());
      expect(content()).toContain("Frozen requirements");
      expect(content()).toContain("Ready");
      expect(deliveries.length).toBe(readsBefore);
      await act(() => disclosure().props.onPress());
      expect(content()).not.toContain("Frozen requirements");
    },
  );
  for (const status of ["queued", "done"] as const) {
    screenTest(`shows truthful ${status} issue context when no snapshot exists`, async () => {
      fixture.job.mockReturnValue({
        ...detail,
        status,
        instruction: "Stored legacy instructions",
        origin: {
          kind: "automation",
          organizationId: "organization",
          repositoryId: "A",
          workflowId: "workflow",
          source: {
            provider: "linear",
            applicationId: "app",
            workspaceId: "workspace",
            connectionId: "source",
            grantId: "grant",
          },
          occurrenceId: "event",
        },
        event: {
          issueId: "issue",
          teamId: "team",
          stateId: "ready",
          labelIds: [],
          identifier: "ENG-123",
          title: "Fix navigation",
          url: "https://linear.app/test/issue/ENG-123",
          occurredAt: "2026-10-19",
          issueUpdatedAt: "2026-10-19",
        },
      });
      await mount({ repositoryId: "A", jobId: detail.jobId });
      expect(content()).toContain("ENG-123");
      if (status === "queued") {
        expect(content()).toContain("Issue details will be read before this job starts.");
      } else {
        expect(content()).not.toContain("will be read");
        expect(content()).not.toContain("Stored legacy instructions");
        const before = deliveries.length;
        await act(() =>
          renderer!.root
            .findAll((node) => node.type === "button")
            .find((node) => node.props.accessibilityState !== undefined)!
            .props.onPress(),
        );
        expect(content()).toContain("No issue snapshot was saved");
        expect(content()).toContain("Stored legacy instructions");
        expect(deliveries.length).toBe(before);
      }
    });
  }
  screenTest(
    "loads further active pages, refreshes from the start, and switches to history",
    async () => {
      fixture.page
        .mockResolvedValueOnce({ jobs: [summary("Old waiting run")], nextCursor: "next" })
        .mockResolvedValueOnce({ jobs: [summary("Further active run")], nextCursor: null })
        .mockResolvedValueOnce({ jobs: [summary("Current active run")], nextCursor: null })
        .mockResolvedValueOnce({ jobs: [summary("Completed run")], nextCursor: null });
      await mount({ repositoryId: "A" });
      await press("Load more runs");
      expect(fixture.page).toHaveBeenLastCalledWith("A", { view: "active", cursor: "next" });
      expect(content()).toContain("Old waiting run");
      expect(content()).toContain("Further active run");
      await press("Refresh jobs");
      expect(content()).toContain("Current active run");
      expect(content()).not.toContain("Old waiting run");
      expect(content()).not.toContain("Further active run");
      await press("History");
      expect(fixture.page).toHaveBeenLastCalledWith("A", { view: "history" });
      expect(content()).toContain("Completed run");
      expect(content()).not.toContain("Current active run");
    },
  );
  screenTest("loads recent runs after an incoming job route and Back to jobs", async () => {
    fixture.list.mockResolvedValue([summary("Recent A run")]);
    await mount({ repositoryId: "A", jobId: detail.jobId });
    expect(content()).toContain("Older direct job");
    await press("Back to jobs");
    expect(content()).toContain("Recent A run");
    expect(content()).not.toContain("No runs in this view");
    expect(fixture.list).toHaveBeenCalledWith("A");
  });
  screenTest(
    "shows loading rather than an empty list while a selected repository is unread",
    async () => {
      const reply = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
      fixture.list.mockReturnValue(reply.promise);
      await mount({ repositoryId: "A" }, false);
      expect(content()).toContain("Loading runs");
      expect(content()).not.toContain("No runs in this view");
      await act(async () => {
        reply.resolve([]);
        await reply.promise;
        await deliveries[3];
      });
      expect(content()).toContain("No runs in this view");
    },
  );
  screenTest(
    "retains the direct job and response buffer when the recent-list read fails",
    async () => {
      const scope = {
        accountId: "account",
        organizationId: "organization",
        repositoryId: RelayRepositoryId.make("A"),
      };
      const key = workflowSessionKey(scope, detail.jobId);
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        responses: { ...state.responses, [key]: { checkpoint: "Retained feedback" } },
      }));
      fixture.list.mockRejectedValue(new Error("Recent list offline"));
      await mount({ repositoryId: "A", jobId: detail.jobId });
      expect(content()).toContain("Older direct job");
      expect(content()).toContain("Retained feedback");
      await press("Back to jobs");
      expect(content()).toContain("Recent list offline");
      expect(content()).not.toContain("No runs in this view");
      fixture.list.mockResolvedValue([summary("Recovered recent run")]);
      await press("Refresh jobs");
      expect(content()).toContain("Recovered recent run");
      expect(appAtomRegistry.get(workflowDraftAtom).responses[key]?.checkpoint).toBe(
        "Retained feedback",
      );
    },
  );
  screenTest("ignores a previous repository's delayed list", async () => {
    const first = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
    const second = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
    fixture.list.mockImplementation((id) => (id === "A" ? first.promise : second.promise));
    await mount(undefined);
    await press("A", false);
    const oldRead = deliveries.at(-1);
    await press("Back to repositories");
    await press("B", false);
    const currentRead = deliveries.at(-1);
    await act(async () => {
      second.resolve([summary("Current B run")]);
      await second.promise;
      await currentRead;
    });
    await act(async () => {
      first.resolve([summary("Stale A run")]);
      await first.promise;
      await oldRead;
    });
    expect(content()).toContain("Current B run");
    expect(content()).not.toContain("Stale A run");
  });
  screenTest(
    "ignores a pre-focus refresh and applies only the returning screen's read",
    async () => {
      const first = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
      const second = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
      fixture.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const view = () => (
        <AppAtomRegistryProvider>
          <WorkflowJobsScreen route={{ params: { repositoryId: "A" } }} />
        </AppAtomRegistryProvider>
      );
      await mount({ repositoryId: "A" }, false);
      const oldRead = deliveries.at(-1);
      fixture.focused = false;
      await act(() => renderer!.update(view()));
      fixture.focused = true;
      await act(async () => renderer!.update(view()));
      const currentRead = deliveries.at(-1);
      await act(async () => {
        first.resolve([summary("Pre-focus run")]);
        await first.promise;
        await oldRead;
      });
      expect(content()).not.toContain("Pre-focus run");
      await act(async () => {
        second.resolve([summary("Current refreshed run")]);
        await second.promise;
        await currentRead;
      });
      expect(content()).toContain("Current refreshed run");
    },
  );
  screenTest("does not apply a previous account's list after account switch", async () => {
    const first = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
    fixture.list.mockReturnValueOnce(first.promise);
    await mount({ repositoryId: "A" }, false);
    const oldRead = deliveries.at(-1);
    const before = deliveries.length;
    fixture.accountId = "other-account";
    setWorkflowSessionAccount(appAtomRegistry, fixture.accountId);
    fixture.list.mockResolvedValueOnce([summary("Other account run")]);
    await act(async () =>
      renderer!.update(
        <AppAtomRegistryProvider>
          <WorkflowJobsScreen route={{ params: { repositoryId: "A" } }} />
        </AppAtomRegistryProvider>,
      ),
    );
    await act(async () => {
      await Promise.all(deliveries.slice(before, before + 3));
    });
    await act(async () => {
      await deliveries.at(-1);
    });
    await act(async () => {
      first.resolve([summary("Old account run")]);
      await first.promise;
      await oldRead;
    });
    expect(content()).toContain("Other account run");
    expect(content()).not.toContain("Old account run");
  });
});
