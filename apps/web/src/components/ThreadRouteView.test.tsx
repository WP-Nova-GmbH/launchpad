import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  RelayRepositoryId,
  type RelayWorkflowVmFollowUpConnection,
} from "@t3tools/contracts/relay";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import { managedRelaySessionAtom, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import { createThreadVmControlAtoms } from "@t3tools/client-runtime/relay/threadVmControls";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const fixture = vi.hoisted(() => ({
  controls: null as ReturnType<typeof createThreadVmControlAtoms> | null,
  hydrated: false,
  threadDetailDeleted: false,
  capabilities: undefined as ExecutionEnvironmentDescriptor["capabilities"] | undefined,
  phase: "connected" as "connected" | "reconnecting" | "error",
  scopedTarget: undefined as RelayWorkflowVmFollowUpConnection | undefined,
  locationState: {} as { workflowOrigin?: WorkflowResultOrigin },
  navigate: vi.fn(),
  open: vi.fn(),
  continueInVm: vi.fn(),
  connectFollowUp: vi.fn(),
  requests: [] as string[],
}));
const environmentId = EnvironmentId.make("original-environment");
const initialSessionConfig = Atom.make<ServerConfig | null>(null);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useLocation: (options?: {
    select?: (location: { state: typeof fixture.locationState }) => unknown;
  }) => {
    const location = { state: fixture.locationState };
    return options?.select ? options.select(location) : location;
  },
}));
vi.mock("./ChatView", () => ({
  default: ({ workflowFollowUp }: { workflowFollowUp?: boolean }) => (
    <p>{workflowFollowUp ? "Live workflow follow-up" : "Saved workflow conversation"}</p>
  ),
}));
vi.mock("./ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => fixture.hydrated,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./workflows/WorkflowNavigation", () => ({
  useWorkflowConversation: () => null,
  WorkflowConversationHeader: () => null,
}));
vi.mock("./workflows/workflowState", () => ({
  useWorkflowClient:
    () =>
    (
      operation: (
        client: { continueWorkflowVm: typeof fixture.continueInVm },
        token: string,
      ) => unknown,
    ) =>
      operation({ continueWorkflowVm: fixture.continueInVm }, "test-token"),
  workflowError: (error: Error) => error.message,
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { retryNow: "reconnect" } }));
vi.mock("../state/workflowVmFollowUp", async (load) => ({
  ...(await load<typeof import("../state/workflowVmFollowUp")>()),
  connectWorkflowVmFollowUp: "follow-up",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "follow-up" ? fixture.connectFollowUp : fixture.open,
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  useBackgroundDraftSubmissionPending: () => false,
  markPromotedDraftThreadByRef: () => {},
  finalizePromotedDraftThreadByRef: () => {},
  handoffMovedThreadDraft: () => Promise.resolve({}),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: {
    getState: () => ({ clearPendingFileDropsForThread: () => {} }),
  },
}));
vi.mock("../state/entities", () => ({
  useThreadRefs: () => [],
  useEnvironmentThreadRefs: () => [{ environmentId, threadId: "another-thread" }],
  useThread: () => (fixture.hydrated ? {} : null),
  useThreadShell: () => (fixture.hydrated ? {} : null),
  useThreadDetail: () => (fixture.hydrated && !fixture.threadDetailDeleted ? {} : null),
  useThreadStatus: () =>
    fixture.threadDetailDeleted ? "deleted" : fixture.hydrated ? "live" : "idle",
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { snapshot: Option.some({}), status: "live", error: Option.none() },
    error: null,
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    presentationById: new Map(
      fixture.capabilities === undefined
        ? []
        : [
            [
              environmentId,
              {
                entry: {
                  target: { _tag: "RelayConnectionTarget", workflowFollowUp: fixture.scopedTarget },
                },
                connection: { phase: fixture.phase },
                serverConfig: { environment: { capabilities: fixture.capabilities } },
              },
            ],
          ],
    ),
  }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { initialConfigValueAtom: () => initialSessionConfig },
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateAtom: () => "shell" } }));
vi.mock("../state/thread-move-submissions", () => ({
  threadMoveRelayUrl: () => "https://relay.example.test",
}));
vi.mock("../state/threads", () => ({
  get threadVmControls() {
    return fixture.controls;
  },
  useEnvironmentThread: () => ({ error: Option.none(), status: "idle", data: Option.none() }),
  openPortableThreadChat: "open",
}));
vi.mock("./chat/MovedThreadDraftRecovery", () => ({ MovedThreadDraftRecovery: () => null }));
vi.mock("./chat/ThreadMoveQueueItem", () => ({
  useThreadMovePlacement: () => null,
  ThreadMoveQueueItem: () => null,
}));
vi.mock("./chat/ThreadVmControls", () => ({
  ThreadVmMenuActions: () => null,
  ThreadVmRefreshButton: () => null,
  useThreadVmUi: () => ({}),
}));
vi.mock("../state/projects", () => ({ environmentProjects: {} }));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../lib/movedThreadDraft", () => ({ recoverMovedDraftFile: () => {} }));
vi.mock("../cloud/useCloudLinkController", () => ({ useCloudLinkController: () => ({}) }));
vi.mock("../cloud/publicConfig", async (load) => ({
  ...(await load<typeof import("../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("./clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: () => ({}) }));

import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { ThreadRouteView } from "./ThreadRouteView";
import {
  rememberedWorkflowVmFollowUpOriginAtom,
  workflowVmFollowUpHistoryState,
} from "../state/workflowVmFollowUp";

let renderer: ReactTestRenderer | null = null;
const route = (threadId: string) => (
  <AppAtomRegistryProvider>
    <ThreadRouteView
      target={{ kind: "server", threadRef: { environmentId, threadId: ThreadId.make(threadId) } }}
    />
  </AppAtomRegistryProvider>
);

beforeEach(() => {
  fixture.hydrated = false;
  fixture.threadDetailDeleted = false;
  fixture.capabilities = undefined;
  fixture.phase = "connected";
  fixture.scopedTarget = undefined;
  fixture.locationState = {};
  fixture.requests = [];
  fixture.navigate.mockReset();
  fixture.open.mockReset().mockResolvedValue(null);
  fixture.continueInVm.mockReset();
  fixture.connectFollowUp.mockReset().mockResolvedValue({ _tag: "Success" });
  appAtomRegistry.set(initialSessionConfig, null);
  appAtomRegistry.set(managedRelaySessionAtom, {
    accountId: "owner",
    readClerkToken: () => Effect.succeed("test-token"),
  });
  fixture.controls = createThreadVmControlAtoms(
    Atom.runtime(
      ManagedRelayTenancy.layer({ relayUrl: "https://relay.example.test" }).pipe(
        Layer.provide(
          remoteHttpClientLayer(async (url, init) => {
            const request = new Request(url, init);
            fixture.requests.push(new URL(request.url).pathname);
            const threadId = decodeURIComponent(new URL(request.url).pathname.split("/")[3]!);
            return Response.json({
              threadId,
              environmentId: "destination",
              projectId: "project",
              ownerUserId: "owner",
              organizationId: "org",
              repositoryId: "repo",
              generation: 2,
              operationId: null,
            });
          }),
        ),
      ),
    ),
    () => Atom.make(null),
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  appAtomRegistry.set(managedRelaySessionAtom, null);
});

describe("workflow result location recovery", () => {
  it.each([
    "viewer reconnect with cached follow-up capabilities",
    "scoped connection before session confirmation",
    "failed follow-up connection",
  ])("re-enters the current follow-up generation from a %s", async (connection) => {
    const threadId = ThreadId.make("workflow:job");
    fixture.hydrated = true;
    const access = { threadId, generation: 1 };
    fixture.capabilities = {
      repositoryIdentity: true,
      workflowVmResultReader: true,
      workflowVmFollowUp: access,
    };
    if (connection === "viewer reconnect with cached follow-up capabilities") {
      fixture.phase = "reconnecting";
    } else fixture.scopedTarget = access;
    if (connection === "failed follow-up connection") {
      fixture.phase = "error";
      fixture.threadDetailDeleted = true;
    }
    fixture.locationState = {
      workflowOrigin: {
        accountId: "owner",
        organizationId: "org",
        repositoryId: RelayRepositoryId.make("repo"),
        jobId: "job",
        threadId,
        workflowVmFollowUpGeneration: 1,
      },
    };
    const current = {
      state: "running",
      environmentId: EnvironmentId.make("new-workflow-environment"),
      threadId,
      generation: 2,
    };
    fixture.continueInVm.mockResolvedValue(current);

    await act(async () => {
      renderer = create(route(threadId));
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    const continueButton = renderer!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Continue in VM"));
    expect(continueButton).toBeDefined();
    await act(async () => {
      continueButton!.props.onClick();
    });

    expect(fixture.continueInVm).toHaveBeenCalledWith({
      clerkToken: "test-token",
      repositoryId: "repo",
      jobId: "job",
    });
    expect(fixture.connectFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ...current,
        origin: expect.objectContaining({ accountId: "owner", workflowVmFollowUpGeneration: 2 }),
      }),
    );
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: current.environmentId, threadId },
      state: { workflowOrigin: expect.objectContaining({ workflowVmFollowUpGeneration: 2 }) },
    });
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
  });

  it("opens chat when a connected relay target and current session both confirm follow-up access", async () => {
    const threadId = ThreadId.make("workflow:job");
    fixture.hydrated = true;
    fixture.scopedTarget = { threadId, generation: 1 };
    fixture.capabilities = { repositoryIdentity: true, workflowVmResultReader: true };
    fixture.locationState = {
      workflowOrigin: {
        accountId: "owner",
        organizationId: "org",
        repositoryId: RelayRepositoryId.make("repo"),
        jobId: "job",
        threadId,
        workflowVmFollowUpGeneration: 1,
      },
    };
    appAtomRegistry.set(initialSessionConfig, {
      environment: {
        capabilities: { ...fixture.capabilities, workflowVmFollowUp: fixture.scopedTarget },
      },
    } as ServerConfig);

    await act(async () => {
      renderer = create(route(threadId));
    });

    expect(renderer!.root.findByType("p").children).toContain("Live workflow follow-up");
    expect(fixture.continueInVm).not.toHaveBeenCalled();
  });

  it("reopens a previously continued thread from a bare URL without waking a VM or replacing an explicit result", async () => {
    const threadId = ThreadId.make("workflow:direct-job");
    const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
    fixture.hydrated = true;
    const access = { threadId, generation: 2 };
    const origin = {
      accountId: "owner",
      organizationId: "org",
      repositoryId: RelayRepositoryId.make("repo"),
      jobId: "job",
      threadId,
    };
    fixture.scopedTarget = access;
    fixture.capabilities = { repositoryIdentity: true, workflowVmResultReader: true };
    appAtomRegistry.set(initialSessionConfig, {
      environment: { capabilities: { ...fixture.capabilities, workflowVmFollowUp: access } },
    } as ServerConfig);
    appAtomRegistry.set(rememberedWorkflowVmFollowUpOriginAtom(key), {
      session: appAtomRegistry.get(managedRelaySessionAtom)!,
      origin: { ...origin, workflowVmFollowUpGeneration: access.generation },
    });

    await act(async () => {
      renderer = create(route(threadId));
    });
    expect(renderer!.root.findByType("p").children).toContain("Live workflow follow-up");

    fixture.locationState = { workflowOrigin: { ...origin, workflowVmResultReader: true } };
    await act(async () => renderer!.update(route(threadId)));
    expect(renderer!.root.findByType("p").children).toContain("Saved workflow conversation");

    fixture.locationState = {};
    await act(async () => {
      appAtomRegistry.set(managedRelaySessionAtom, {
        accountId: "other",
        readClerkToken: () => Effect.succeed("other-token"),
      });
      renderer!.update(route(threadId));
    });
    expect(renderer!.root.findByType("p").children).not.toContain("Live workflow follow-up");
    expect(fixture.connectFollowUp).not.toHaveBeenCalled();
    expect(fixture.continueInVm).not.toHaveBeenCalled();
  });

  it("offers explicit Continue after reloading a sidebar history entry", async () => {
    const threadId = ThreadId.make("workflow:sidebar-job");
    const threadRef = scopeThreadRef(environmentId, threadId);
    const key = scopedThreadKey(threadRef);
    const origin = {
      accountId: "owner",
      organizationId: "org",
      repositoryId: RelayRepositoryId.make("repo"),
      jobId: "sidebar-job",
      threadId,
      workflowVmFollowUpGeneration: 2,
    };
    appAtomRegistry.set(rememberedWorkflowVmFollowUpOriginAtom(key), {
      session: appAtomRegistry.get(managedRelaySessionAtom)!,
      origin,
    });
    const historyState = workflowVmFollowUpHistoryState(threadRef);
    expect(historyState).toEqual({ workflowOrigin: origin });

    fixture.hydrated = true;
    fixture.capabilities = { repositoryIdentity: true, workflowVmResultReader: true };
    fixture.locationState = structuredClone(historyState);
    appAtomRegistry.set(rememberedWorkflowVmFollowUpOriginAtom(key), null);
    appAtomRegistry.set(managedRelaySessionAtom, {
      accountId: "owner",
      readClerkToken: () => Effect.succeed("new-test-token"),
    });
    await act(async () => {
      renderer = create(route(threadId));
    });
    const anyContinueButton = () =>
      renderer!.root
        .findAllByType("button")
        .some((node) => node.children.includes("Continue in VM"));
    expect(anyContinueButton()).toBe(true);

    await act(async () => {
      appAtomRegistry.set(managedRelaySessionAtom, {
        accountId: "other",
        readClerkToken: () => Effect.succeed("other-token"),
      });
    });
    expect(anyContinueButton()).toBe(false);
    expect(workflowVmFollowUpHistoryState(threadRef)).toEqual({});
    expect(fixture.continueInVm).not.toHaveBeenCalled();
    expect(fixture.connectFollowUp).not.toHaveBeenCalled();
  });

  it("keeps a cold result on its route without querying private placement, then renders its transcript", async () => {
    await act(async () => {
      renderer = create(route("workflow:job"));
    });
    expect(fixture.requests).toEqual([]);
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.hydrated = true;
    fixture.capabilities = { repositoryIdentity: true, workflowVmResultReader: true };
    await act(async () => renderer!.update(route("workflow:job")));
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => node.children.includes("Saved workflow conversation")),
    ).toBe(true);
    expect(fixture.requests).toEqual([]);
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("recovers a moved machine workflow even if its source descriptor never arrives", async () => {
    await act(async () => {
      renderer = create(route("workflow:job:agent"));
    });
    expect(fixture.requests).toEqual(["/v1/threads/workflow%3Ajob%3Aagent/placement"]);
    expect(fixture.open).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "workflow:job:agent",
        expectedPlacement: { environmentId: "destination", generation: 2 },
      }),
    );
    expect(fixture.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: "/" }));
  });

  it("stops result-location observation across route changes and ignores another account's hint", async () => {
    fixture.locationState = {
      workflowOrigin: {
        accountId: "owner",
        organizationId: "org",
        repositoryId: RelayRepositoryId.make("repo"),
        jobId: "job",
        threadId: "thread",
        workflowVmResultReader: true,
      },
    };
    await act(async () => {
      renderer = create(route("thread"));
    });
    expect(fixture.requests).toEqual([]);
    await act(async () => {
      appAtomRegistry.set(managedRelaySessionAtom, {
        accountId: "other",
        readClerkToken: () => Effect.succeed("other-token"),
      });
    });
    expect(fixture.requests).toEqual(["/v1/threads/thread/placement"]);
    expect(fixture.open).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }));

    fixture.locationState = {};
    await act(async () => renderer!.update(route("workflow:job")));
    expect(fixture.requests).toEqual(["/v1/threads/thread/placement"]);
    expect(fixture.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: "/" }));
  });
});
