import { act, createElement, type ReactNode } from "react";
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
  type ServerConfig,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Project, Thread } from "../types";
import type { ChatComposerProps, ChatComposerHandle } from "./chat/ChatComposer";

const mocks = vi.hoisted(() => ({
  thread: null as Thread | null,
  project: null as Project | null,
  environment: null as import("../state/environments").EnvironmentPresentation | null,
  composer: null as { current: ChatComposerHandle } | null,
  navigate: vi.fn(),
}));

// This harness exercises submission callbacks without mounting browser layout effects.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ href: "http://localhost/", state: {} }),
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
  return { Tooltip, TooltipTrigger: Tooltip, TooltipPopup: () => null };
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
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./chat/ChatHeader", () => ({ ChatHeader: () => null }));
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
import { threadEnvironment } from "../state/threads";
import { makeSubmissionRuntime, preparationBarrier } from "./chat/submissionTestUtils";
import { useComposerDraftStore } from "../composerDraftStore";

const environmentId = EnvironmentId.make("submission-environment");
const threadId = ThreadId.make("plan-thread");
const projectId = ProjectId.make("plan-project");
const createdAt = "2026-10-07T00:00:00.000Z";
let renderer: ReactTestRenderer | undefined;
let transport: ReturnType<typeof makeSubmissionRuntime>;

beforeEach(() => {
  vi.clearAllMocks();
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
      environment: { capabilities: {}, platform: { machine: "local" } },
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

async function render() {
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <ChatView routeKind="server" environmentId={environmentId} threadId={threadId} />
      </AppAtomRegistryProvider>,
    );
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

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  appAtomRegistry.set(managedRelaySessionAtom, null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
