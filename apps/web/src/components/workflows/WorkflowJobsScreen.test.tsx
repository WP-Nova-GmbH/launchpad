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
import { EnvironmentId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflowJob,
  RepositoryWorkflowJobSummary,
} from "@t3tools/contracts/workflows";

const fixture = vi.hoisted(() => ({
  accountId: "account",
  focused: true,
  getToken: vi.fn().mockResolvedValue("fixture-token"),
  list: vi.fn<(repositoryId: string) => Promise<ReadonlyArray<RepositoryWorkflowJobSummary>>>(),
  navigate: vi.fn(),
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
  listWorkflowJobs: ({ repositoryId }: { repositoryId: string }) =>
    Effect.tryPromise({
      try: () => fixture.list(repositoryId),
      catch: (cause) =>
        new FixtureReadError({
          message: cause instanceof Error ? cause.message : "Recent list failed",
        }),
    }),
  getWorkflowJob: () => Effect.succeed(detail),
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
  fixture.list.mockReset().mockResolvedValue([]);
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
  screenTest("loads recent runs after an incoming job route and Back to jobs", async () => {
    fixture.list.mockResolvedValue([summary("Recent A run")]);
    await mount({ repositoryId: "A", jobId: detail.jobId });
    expect(content()).toContain("Older direct job");
    await press("Back to jobs");
    expect(content()).toContain("Recent A run");
    expect(content()).not.toContain("No recent runs");
    expect(fixture.list).toHaveBeenCalledWith("A");
  });
  screenTest(
    "shows loading rather than an empty list while a selected repository is unread",
    async () => {
      const reply = deferred<ReadonlyArray<RepositoryWorkflowJobSummary>>();
      fixture.list.mockReturnValue(reply.promise);
      await mount({ repositoryId: "A" }, false);
      expect(content()).toContain("Loading recent runs");
      expect(content()).not.toContain("No recent runs");
      await act(async () => {
        reply.resolve([]);
        await reply.promise;
        await deliveries[3];
      });
      expect(content()).toContain("No recent runs");
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
      expect(content()).not.toContain("No recent runs");
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
