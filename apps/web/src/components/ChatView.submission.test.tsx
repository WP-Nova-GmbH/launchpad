import { act, createElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  CheckpointRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { Project, Thread } from "../types";
import type { ChatComposerProps, ChatComposerHandle } from "./chat/ChatComposer";
import type { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";

const mocks = vi.hoisted(() => ({
  thread: null as Thread | null,
  project: null as Project | null,
  environment: null as import("../state/environments").EnvironmentPresentation | null,
  composer: null as { current: ChatComposerHandle } | null,
  navigate: vi.fn(),
  locationState: {} as {
    workflowOrigin?: import("@t3tools/client-runtime/relay/workflow-result").WorkflowResultOrigin;
  },
  checkpointDiff: null as import("@t3tools/contracts").OrchestrationGetTurnDiffResult | null,
  fileMenu: vi.fn(),
}));

// This harness exercises submission callbacks without mounting browser layout effects.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: (options?: {
    select?: (location: { href: string; state: typeof mocks.locationState }) => unknown;
  }) => {
    const location = { href: "http://localhost/", state: mocks.locationState };
    return options?.select ? options.select(location) : location;
  },
  useParams: (options: {
    select: (params: { environmentId?: string; threadId?: string }) => unknown;
  }) =>
    options.select(
      mocks.thread ? { environmentId: mocks.thread.environmentId, threadId: mocks.thread.id } : {},
    ),
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, planModeEnabled: true }),
  useClientSettings: (select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, planModeEnabled: true };
    return select ? select(settings) : settings;
  },
  useClientSettingsHydrated: () => true,
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../hooks/useNowMinute", () => ({ useNowMinute: () => 0 }));
vi.mock("./ui/dialog", () => ({
  Dialog: () => null,
  DialogPopup: () => null,
  DialogTitle: () => null,
  DialogDescription: () => null,
}));
vi.mock("./ui/tooltip", () => {
  const Tooltip = ({ children }: { children: ReactNode }) => <>{children}</>;
  const TooltipTrigger = ({ children, render }: { children: ReactNode; render?: ReactNode }) => (
    <>
      {isValidElement<{ "aria-label"?: string }>(render) &&
      render.props["aria-label"] === "Copy file path"
        ? render
        : children}
    </>
  );
  return { Tooltip, TooltipTrigger, TooltipPopup: () => null };
});
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: vi.fn(),
    pinThread: vi.fn(),
    confirmAndUnpinThread: vi.fn(),
  }),
}));
vi.mock("../hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useThread: () => mocks.thread,
  useThreadShell: () => mocks.thread,
  useProject: () => mocks.project,
  useProjects: () => [mocks.project],
  useThreadRefs: () => [],
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [mocks.environment] }),
  usePrimaryEnvironment: () => mocks.environment,
  usePrimaryEnvironmentId: () => mocks.environment?.environmentId,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../composerHandleContext", () => ({ useComposerHandleContext: () => mocks.composer }));
vi.mock("../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    failed: false,
    environmentId: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../assets/assetUrls", async (original) => ({
  ...(await original<typeof import("../assets/assetUrls")>()),
  useAssetUrls: () => new Map(),
}));
vi.mock("./chat/ChatComposer", () => ({
  ChatComposer: (props: ChatComposerProps) =>
    createElement("div", { ...props, "data-submission-composer": true }),
}));
vi.mock("./chat/MessagesTimeline", () => ({
  MessagesTimeline: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-submission-timeline": true }),
}));
vi.mock("./chat/ChatHeader", () => ({
  ChatHeader: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-submission-header": true }),
}));
vi.mock("../lib/checkpointDiffState", async (original) => ({
  ...(await original<typeof import("../lib/checkpointDiffState")>()),
  useCheckpointDiff: () => ({
    data: mocks.checkpointDiff,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../fileContextMenu", async (original) => ({
  ...(await original<typeof import("../fileContextMenu")>()),
  useFileContextMenuHandler: () => mocks.fileMenu,
}));
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: ComponentProps<typeof AnnotatableCodeView>) =>
    createElement(
      "div",
      { ...props, "data-submission-checkpoint-panel": true },
      props.files.map((file) => (
        <div key={file.filePath}>{props.renderHeaderFilenameSuffix(file.fileDiff)}</div>
      )),
    ),
}));
vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: ({ children, ...props }: Record<string, unknown> & { children: ReactNode }) =>
    createElement("div", { ...props, "data-submission-panel": true }, children),
}));
vi.mock("./chat/ComposerSurface", () => {
  const Surface = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    ComposerSurface: { Shell: Surface, Host: Surface, Main: Surface, ContextStrip: Surface },
  };
});
vi.mock("./ChatView.logic", async (original) => ({
  ...(await original<typeof import("./ChatView.logic")>()),
  waitForStartedServerThread: async () => mocks.thread,
}));

import ChatView from "./ChatView";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { portableThreadCommands, threadEnvironment } from "../state/threads";
import { makeSubmissionRuntime, preparationBarrier } from "./chat/submissionTestUtils";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";
import { serverEnvironment } from "../state/server";
import { RelayRepositoryId } from "@t3tools/contracts/relay";

const environmentId = EnvironmentId.make("submission-environment");
const threadId = ThreadId.make("plan-thread");
const projectId = ProjectId.make("plan-project");
const createdAt = "2026-10-07T00:00:00.000Z";
const testServerConfig = Atom.make<ServerConfig | null>(null);
let renderer: ReactTestRenderer | undefined;
let transport: ReturnType<typeof makeSubmissionRuntime>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locationState = {};
  mocks.checkpointDiff = null;
  useRightPanelStore.setState({ byThreadKey: {} });
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      visibilityState: "visible",
      documentElement: { classList: { contains: () => false } },
    }),
  );
  mocks.project = {
    environmentId,
    id: projectId,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  };
  mocks.thread = {
    environmentId,
    id: threadId,
    projectId,
    title: "Plan",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    session: null,
    messages: [],
    activities: [],
    checkpoints: [],
    pullRequests: [],
    proposedPlans: [
      {
        id: "plan",
        turnId: TurnId.make("plan-turn"),
        planMarkdown: "# Plan\nRead WP-218 and implement it.",
        implementedAt: null,
        implementationThreadId: null,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    latestTurn: {
      turnId: TurnId.make("plan-turn"),
      state: "completed",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
      assistantMessageId: null,
    },
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
  };
  mocks.environment = {
    environmentId,
    label: "Local",
    displayUrl: null,
    relayManaged: false,
    organizationMachine: false,
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Local",
        httpBaseUrl: "http://localhost",
        wsBaseUrl: "ws://localhost",
      }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      providers: [
        {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          version: null,
          checkedAt: createdAt,
          models: [],
          slashCommands: [{ name: "compact", description: "Compact context" }],
          skills: [],
          showInteractionModeToggle: true,
        },
      ],
      environment: { capabilities: {}, platform: { machine: "desktop" } },
      version: "0.1.7",
    } as unknown as ServerConfig,
  };
  const context: ReturnType<ChatComposerHandle["getSendContext"]> = {
    prompt: "Implement the plan",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedModel: "gpt-5.4",
    selectedProviderModels: [],
    selectedModelSelection: mocks.thread.modelSelection,
    selectedPromptEffort: null,
    selectedModelOptionsForDispatch: undefined,
    multipleModelSelections: null,
    providerAvailable: true,
    interactionMode: "plan",
    interactionModeEnabled: true,
  };
  mocks.composer = {
    current: {
      getSendContext: () => context,
      validateProviderInput: () => true,
      resetCursorState: vi.fn(),
    } as unknown as ChatComposerHandle,
  };
  appAtomRegistry.set(managedRelaySessionAtom, {
    accountId: "alice",
    readClerkToken: () => Effect.succeed("alice-token"),
  });
  transport = makeSubmissionRuntime(appAtomRegistry, environmentId);
  vi.spyOn(threadEnvironment.startTurn, "run").mockImplementation((_registry, { input }) =>
    transport.start(input),
  );
});
afterAll(() => appAtomRegistry.dispose());

function chatView(id: ThreadId) {
  return (
    <AppAtomRegistryProvider>
      <ChatView routeKind="server" environmentId={environmentId} threadId={id} />
    </AppAtomRegistryProvider>
  );
}

async function render(id = threadId) {
  await act(async () => {
    renderer = create(chatView(id));
  });
}

function composerProps() {
  return renderer!.root.findByProps({ "data-submission-composer": true })
    .props as ChatComposerProps;
}

function switchAccount(accountId: string | null) {
  appAtomRegistry.set(
    managedRelaySessionAtom,
    accountId === null
      ? null
      : { accountId, readClerkToken: () => Effect.succeed(`${accountId}-token`) },
  );
}

function renderedText() {
  const text = (node: ReturnType<ReactTestRenderer["toJSON"]> | string): string => {
    if (node === null) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(text).join("");
    return node.children?.map(text).join("") ?? "";
  };
  return text(renderer!.toJSON());
}

function observeQueuedCommands(error: string | null = "This thread is unavailable.") {
  const state = Atom.make({
    relayCommands: [],
    environmentCommands: error === null ? [{ commandId: "queued-change" }] : [],
    waitingForRelay: 0,
    waitingForEnvironment: error === null ? 1 : 0,
    hasMore: false,
    rejections: [],
    error,
  });
  return vi.spyOn(portableThreadCommands, "viewAtom").mockReturnValue(state);
}

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  appAtomRegistry.set(managedRelaySessionAtom, null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["workflow-link", "direct"] as const)(
  "opens a finished read-only VM result via %s",
  async (entry) => {
    await import("./DiffPanel");
    const resultThreadId = ThreadId.make("workflow:finished");
    const ref = scopeThreadRef(environmentId, resultThreadId);
    const completedTurn = TurnId.make("completed-turn");
    mocks.thread = {
      ...mocks.thread!,
      id: resultThreadId,
      branch: "t3-job/finished",
      workflowJob: null,
      checkpoints: [
        {
          turnId: completedTurn,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/result/1"),
          status: "ready",
          files: [],
          completedAt: createdAt,
          assistantMessageId: MessageId.make("result-reply"),
        },
      ],
    };
    const config = mocks.environment!.serverConfig!;
    const queuedCommands = observeQueuedCommands();
    await render(resultThreadId);
    expect(queuedCommands).toHaveBeenCalledWith(environmentId, resultThreadId);
    expect(renderedText()).toContain("Queued changes could not be refreshed.");
    queuedCommands.mockClear();
    const previous = composerProps();
    vi.spyOn(serverEnvironment, "configValueAtom").mockReturnValue(testServerConfig);
    mocks.checkpointDiff = {
      threadId: resultThreadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff --git a/src/result.ts b/src/result.ts\n--- a/src/result.ts\n+++ b/src/result.ts\n@@ -1 +1 @@\n-before\n+after\n",
    };
    if (entry === "workflow-link") {
      mocks.locationState = {
        workflowOrigin: {
          accountId: "alice",
          organizationId: "org",
          repositoryId: RelayRepositoryId.make("repo"),
          jobId: "finished",
          threadId: resultThreadId,
          workflowVmResultReader: true,
        },
      };
      mocks.environment = { ...mocks.environment!, serverConfig: null };
    } else {
      mocks.environment = {
        ...mocks.environment!,
        serverConfig: {
          ...config,
          environment: {
            ...config.environment,
            capabilities: { ...config.environment.capabilities, workflowVmResultReader: true },
          },
        },
      };
    }

    await act(async () => {
      appAtomRegistry.set(testServerConfig, mocks.environment!.serverConfig);
      const panel = useRightPanelStore.getState();
      panel.open(ref, "diff");
      panel.openFile(ref, "src/result.ts");
      panel.openTerminal(ref, "stale-terminal");
      renderer!.update(chatView(resultThreadId));
    });
    await act(async () => vi.dynamicImportSettled());
    const root = renderer!.root;
    expect(queuedCommands).not.toHaveBeenCalled();
    expect(renderedText()).not.toContain("Queued changes could not be refreshed.");
    expect(root.findAllByProps({ "data-submission-composer": true })).toHaveLength(0);
    const checkpoint = root.findByProps({ "data-submission-checkpoint-panel": true });
    expect(checkpoint.props.readOnly).toBe(true);
    expect(checkpoint.props.files).toMatchObject([{ filePath: "src/result.ts" }]);
    class FileTitle {
      textContent = "src/result.ts";
      hasAttribute(name: string) {
        return name === "data-title";
      }
    }
    vi.stubGlobal("HTMLElement", FileTitle);
    vi.stubGlobal("HTMLButtonElement", class extends FileTitle {});
    vi.stubGlobal("HTMLAnchorElement", class extends FileTitle {});
    const diff = root.findAll(
      (node) =>
        typeof node.props.onContextMenuCapture === "function" &&
        typeof node.props.onClickCapture === "function",
    )[0]!;
    const event = {
      nativeEvent: { composedPath: () => [new FileTitle()] },
      preventDefault: vi.fn(),
    };
    expect(root.findByProps({ "data-submission-header": true }).props).toMatchObject({
      readOnly: true,
      openInCwd: null,
      gitCwd: null,
    });
    const controls = root.findByProps({ "data-submission-panel": true }).props;
    expect(controls).toMatchObject({
      activeSurfaceId: "diff",
      surfaces: [{ kind: "diff", id: "diff" }],
      diffAvailable: true,
      filesAvailable: false,
      terminalAvailable: false,
      browserAvailable: false,
    });
    const timeline = root.findByProps({ "data-submission-timeline": true }).props;
    expect(timeline.supportsConversationRollback).toBe(false);
    expect(timeline.onCiteAssistantText).toBeUndefined();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const copyPath = root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Copy file path");
    expect(copyPath).toBeDefined();
    await act(async () => {
      diff.props.onClickCapture(event);
      diff.props.onContextMenuCapture(event);
      copyPath!.props.onClick();
      controls.onAddTerminal();
      controls.onAddFiles();
      controls.onAddBrowser();
      await previous.onSend();
      await previous.onCompactContext();
      await previous.onImplementPlanInNewThread();
    });
    expect(root.findByProps({ "data-submission-panel": true }).props.activeSurfaceId).toBe("diff");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("src/result.ts");
    expect(mocks.fileMenu).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(0);
    expect(transport.dispatched).toHaveLength(0);

    mocks.thread = { ...mocks.thread!, id: threadId };
    mocks.environment = { ...mocks.environment!, serverConfig: config };
    mocks.locationState = {};
    await act(async () => {
      appAtomRegistry.set(testServerConfig, config);
      renderer!.update(chatView(threadId));
    });
    expect(queuedCommands).toHaveBeenCalledWith(environmentId, threadId);
    expect(renderedText()).toContain("Queued changes could not be refreshed.");
  },
);

it.each(["direct", "workflow-link", "cold", "personal", "machine-workflow"] as const)(
  "shows current provider health only for writable conversations: %s",
  async (entry) => {
    const resultReader = entry !== "personal" && entry !== "machine-workflow";
    const id = ThreadId.make(entry === "personal" ? "personal" : `workflow:${entry}`);
    const message =
      "Could not verify this VM's Codex account with Launchpad Connect. Check the connection and retry.";
    const config = mocks.environment!.serverConfig!;
    mocks.thread = { ...mocks.thread!, id, workflowJob: null };
    mocks.environment = {
      ...mocks.environment!,
      serverConfig:
        entry === "cold"
          ? null
          : {
              ...config,
              providers: config.providers.map((provider) => ({
                ...provider,
                status: "warning",
                auth: { status: "unknown" },
                message,
              })),
              environment: {
                ...config.environment,
                capabilities:
                  entry === "workflow-link"
                    ? { ...config.environment.capabilities }
                    : { ...config.environment.capabilities, workflowVmResultReader: resultReader },
              },
            },
    };
    if (entry === "workflow-link" || entry === "machine-workflow") {
      mocks.locationState = {
        workflowOrigin: {
          accountId: "alice",
          organizationId: "org",
          repositoryId: RelayRepositoryId.make("repo"),
          jobId: entry,
          threadId: id,
          workflowVmResultReader: true,
        },
      };
    }

    await render(id);

    if (resultReader) {
      expect(renderedText()).toContain("This workflow result is read-only.");
      expect(renderedText()).not.toContain(message);
    } else expect(renderedText()).toContain(message);
  },
);

it("does not read personal queued commands when opening a direct VM result before config arrives", async () => {
  const resultThreadId = ThreadId.make("workflow:cold-result");
  const config = mocks.environment!.serverConfig!;
  mocks.thread = { ...mocks.thread!, id: resultThreadId, workflowJob: null };
  mocks.environment = { ...mocks.environment!, serverConfig: null };
  const queuedCommands = observeQueuedCommands();

  await render(resultThreadId);
  expect(renderedText()).toContain("This workflow result is read-only.");
  expect(queuedCommands).not.toHaveBeenCalled();
  expect(renderedText()).not.toContain("Queued changes could not be refreshed.");

  mocks.environment = {
    ...mocks.environment!,
    serverConfig: {
      ...config,
      environment: {
        ...config.environment,
        capabilities: { ...config.environment.capabilities, workflowVmResultReader: true },
      },
    },
  };
  await act(async () => renderer!.update(chatView(resultThreadId)));
  expect(queuedCommands).not.toHaveBeenCalled();
  expect(renderedText()).not.toContain("Queued changes could not be refreshed.");
});

it.each(["personal", "machine-workflow"] as const)(
  "keeps queued changes visible in an offline writable %s thread",
  async (kind) => {
    const writableThreadId = ThreadId.make(kind === "personal" ? "personal" : "workflow:machine");
    const config = mocks.environment!.serverConfig!;
    mocks.thread = { ...mocks.thread!, id: writableThreadId };
    mocks.environment = {
      ...mocks.environment!,
      connection: { phase: "offline", error: null, traceId: null },
      serverConfig: {
        ...config,
        environment: {
          ...config.environment,
          capabilities: { ...config.environment.capabilities, workflowVmResultReader: false },
        },
      },
    };
    const queuedCommands = observeQueuedCommands(null);

    await render(writableThreadId);

    expect(queuedCommands).toHaveBeenCalledWith(environmentId, writableThreadId);
    expect(renderedText()).toContain("waiting for this");
    expect(renderedText()).not.toContain("This workflow result is read-only.");
  },
);

describe("plan submission ownership", () => {
  it.each([
    { from: "alice", to: "bob" },
    { from: "alice", to: null },
    { from: null, to: "bob" },
  ])(
    "rejects a new-thread implementation after an account transition during creation: %j",
    async ({ from, to }) => {
      switchAccount(from);
      const creating = preparationBarrier();
      const createThread = vi
        .spyOn(threadEnvironment.create, "run")
        .mockImplementation(async () => {
          await creating.wait();
          return AsyncResult.success({ sequence: 1 });
        });
      const deleteThread = vi
        .spyOn(threadEnvironment.delete, "run")
        .mockResolvedValue(AsyncResult.success({ sequence: 2 }));
      await render();
      let submitting!: Promise<void>;
      await act(() => {
        submitting = Promise.resolve(composerProps().onImplementPlanInNewThread());
      });
      await creating.entered;
      expect(createThread).toHaveBeenCalledOnce();
      switchAccount(to);
      await act(async () => {
        creating.release();
        await submitting;
      });
      expect(transport.requests).toHaveLength(0);
      expect(transport.dispatched).toHaveLength(0);
      expect(deleteThread).toHaveBeenCalledOnce();
      expect(deleteThread.mock.calls[0]?.[1].input.threadId).toBe(
        createThread.mock.calls[0]?.[1].input.threadId,
      );
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(composerProps().isSendBusy).toBe(false);
    },
  );

  it("starts implementation with the captured account when it remains signed in", async () => {
    const creating = preparationBarrier();
    vi.spyOn(threadEnvironment.create, "run").mockImplementation(async () => {
      await creating.wait();
      return AsyncResult.success({ sequence: 1 });
    });
    const deleteThread = vi
      .spyOn(threadEnvironment.delete, "run")
      .mockResolvedValue(AsyncResult.success({ sequence: 2 }));
    await render();
    let submitting!: Promise<void>;
    await act(() => {
      submitting = Promise.resolve(composerProps().onImplementPlanInNewThread());
    });
    await creating.entered;
    await act(async () => {
      creating.release();
      await submitting;
    });
    expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer alice-token");
    expect(transport.dispatched).toMatchObject([
      {
        type: "thread.turn.start",
        issueTrackerAuthorization: "personal-grant",
        sourceProposedPlan: { threadId, planId: "plan" },
      },
    ]);
    expect(transport.dispatched[0]).not.toHaveProperty("expectedAccountId");
    expect(deleteThread).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(composerProps().isSendBusy).toBe(false);
  });

  it("restores a plan follow-up and its review context after an account change during settings persistence", async () => {
    const persisting = preparationBarrier();
    const updateMetadata = vi
      .spyOn(threadEnvironment.updateMetadata, "run")
      .mockImplementation(async () => {
        await persisting.wait();
        return AsyncResult.success({ sequence: 1 });
      });
    const context = mocks.composer!.current.getSendContext();
    context.selectedModelSelection = { ...context.selectedModelSelection, model: "gpt-5.4-mini" };
    context.selectedModel = "gpt-5.4-mini";
    context.reviewComments = [
      {
        id: "review-1",
        sectionId: "file:a.ts",
        sectionTitle: "File comment",
        filePath: "a.ts",
        startIndex: 0,
        endIndex: 0,
        rangeLabel: "L1",
        text: "Keep this check",
        diff: "",
      },
    ];
    const threadRef = scopeThreadRef(environmentId, threadId);
    useComposerDraftStore.getState().setPrompt(threadRef, "Follow up on the plan");
    useComposerDraftStore.getState().setReviewComments(threadRef, context.reviewComments);
    await render();
    expect(composerProps().showPlanFollowUpPrompt).toBe(true);
    const original = useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    composerProps().promptRef.current = original.prompt;
    let submitting!: Promise<void>;
    await act(() => {
      submitting = Promise.resolve(composerProps().onSend());
    });
    expect(updateMetadata).toHaveBeenCalledOnce();
    await persisting.entered;
    expect(composerProps().promptRef.current).toBe("");
    switchAccount("bob");
    await act(async () => {
      persisting.release();
      await submitting;
    });
    expect(transport.requests).toHaveLength(0);
    expect(transport.dispatched).toHaveLength(0);
    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)!;
    expect(restored.prompt).toBe(original.prompt);
    expect(restored.reviewComments).toEqual(original.reviewComments);
    expect(composerProps().promptRef.current).toBe(original.prompt);
    expect(composerProps().isSendBusy).toBe(false);
  });

  it("sends a plan follow-up with the captured account when it stays the same", async () => {
    vi.spyOn(threadEnvironment.updateMetadata, "run").mockResolvedValue(
      AsyncResult.success({ sequence: 1 }),
    );
    await render();
    expect(composerProps().showPlanFollowUpPrompt).toBe(true);
    composerProps().promptRef.current = "Clarify how to implement WP-218";
    await act(async () => {
      await composerProps().onSend();
    });
    expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer alice-token");
    expect(transport.dispatched).toMatchObject([
      {
        type: "thread.turn.start",
        threadId,
        interactionMode: "plan",
        issueTrackerAuthorization: "personal-grant",
      },
    ]);
    expect(transport.dispatched[0]).not.toHaveProperty("expectedAccountId");
  });

  it("keeps the draft and rejects compaction after an account change during settings persistence", async () => {
    mocks.thread = {
      ...mocks.thread!,
      interactionMode: "default",
      messages: [
        {
          id: MessageId.make("earlier-message"),
          role: "user",
          text: "Explain WP-218",
          turnId: null,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      ],
    };
    const context = mocks.composer!.current.getSendContext();
    context.interactionMode = "default";
    context.selectedModelSelection = { ...context.selectedModelSelection, model: "gpt-5.4-mini" };
    const persisting = preparationBarrier();
    const updateMetadata = vi
      .spyOn(threadEnvironment.updateMetadata, "run")
      .mockImplementation(async () => {
        await persisting.wait();
        return AsyncResult.success({ sequence: 1 });
      });
    const threadRef = scopeThreadRef(environmentId, threadId);
    useComposerDraftStore.getState().setPrompt(threadRef, "Keep this unsent draft");
    await render();
    expect(composerProps().compactDisabled).toBe(false);
    const original = useComposerDraftStore.getState().getComposerDraft(threadRef);
    let submitting!: Promise<void>;
    await act(() => {
      submitting = Promise.resolve(composerProps().onCompactContext());
    });
    expect(updateMetadata).toHaveBeenCalledOnce();
    await persisting.entered;
    switchAccount("bob");
    await act(async () => {
      persisting.release();
      await submitting;
    });
    expect(transport.requests).toHaveLength(0);
    expect(transport.dispatched).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toEqual(original);
    expect(composerProps().isSendBusy).toBe(false);
  });
});
