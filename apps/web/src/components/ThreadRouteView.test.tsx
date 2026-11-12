import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import { managedRelaySessionAtom, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import { createThreadVmControlAtoms } from "@t3tools/client-runtime/relay/threadVmControls";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const fixture = vi.hoisted(() => ({
  controls: null as ReturnType<typeof createThreadVmControlAtoms> | null,
  hydrated: false,
  capabilities: undefined as { workflowVmResultReader?: boolean } | undefined,
  locationState: {} as { workflowOrigin?: WorkflowResultOrigin },
  navigate: vi.fn(),
  open: vi.fn(),
  requests: [] as string[],
}));
const environmentId = EnvironmentId.make("original-environment");

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useLocation: (options?: {
    select?: (location: { state: typeof fixture.locationState }) => unknown;
  }) => {
    const location = { state: fixture.locationState };
    return options?.select ? options.select(location) : location;
  },
}));
vi.mock("./ChatView", () => ({ default: () => <p>Saved workflow conversation</p> }));
vi.mock("./ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => fixture.hydrated,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./workflows/WorkflowNavigation", () => ({ WorkflowResultReturn: () => null }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { retryNow: "reconnect" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.open }));
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
  useThreadDetail: () => (fixture.hydrated ? {} : null),
  useThreadStatus: () => (fixture.hydrated ? "live" : "idle"),
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
                connection: { phase: "connected" },
                serverConfig: { environment: { capabilities: fixture.capabilities } },
              },
            ],
          ],
    ),
  }),
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
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: () => ({}) }));

import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { ThreadRouteView } from "./ThreadRouteView";

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
  fixture.capabilities = undefined;
  fixture.locationState = {};
  fixture.requests = [];
  fixture.navigate.mockReset();
  fixture.open.mockReset().mockResolvedValue(null);
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
  it("keeps a cold result on its route without querying private placement, then renders its transcript", async () => {
    await act(async () => {
      renderer = create(route("workflow:job"));
    });
    expect(fixture.requests).toEqual([]);
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.hydrated = true;
    fixture.capabilities = { workflowVmResultReader: true };
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
