import {
  beginPortableThreadPlacementRead,
  isPortableThreadPlacementReadCurrent,
  isPortableThreadPlacementReadScopeCurrent,
  portableThreadPlacementsAtom,
  rememberPortableThreadPlacement,
} from "./portableThreadPresentation.ts";
import {
  EnvironmentId,
  ThreadId,
  type CommandId,
  OrchestrationDispatchCommandError,
  type ThreadRelayRouting,
} from "@t3tools/contracts";
import type {
  RelayPortableThreadPlacement,
  RelayPortableThreadSummary,
  RelayThreadCurrentQueue,
  RelayThreadVmAllowance,
  ThreadVmCapabilities,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { RelayConnectionRegistration } from "../connection/catalog.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createAtomCommandScheduler, createRuntimeCommand } from "../state/runtime.ts";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import { managedRelaySessionAtom, type ManagedRelaySession } from "./managedRelayState.ts";
import {
  applyPortableThreadHistoryPage,
  emptyPortableThreadHistory,
  type PortableThreadHistory,
} from "./portableThreadHistory.ts";

const encodeRouteKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

type VerifiedThreadRelay = {
  readonly session: ManagedRelaySession;
  readonly relayUrl: string;
  readonly generation: number;
};
const verifiedRelayAtom = Atom.family((_key: string) =>
  Atom.make<VerifiedThreadRelay | null>(null).pipe(Atom.keepAlive),
);
const rememberVerifiedRelay = (
  registry: AtomRegistry.AtomRegistry,
  environmentId: string,
  threadId: string,
  proof: VerifiedThreadRelay,
) =>
  registry.update(verifiedRelayAtom(encodeRouteKey([environmentId, threadId])), (previous) =>
    previous?.session === proof.session && previous.generation > proof.generation
      ? previous
      : proof,
  );
const clientRouteAtom = Atom.family((key: string) =>
  Atom.make((get): ThreadRelayRouting | null => {
    const proof = get(verifiedRelayAtom(key));
    return proof && proof.session === get(managedRelaySessionAtom)
      ? { relayUrl: proof.relayUrl, generation: proof.generation, phase: "retired" }
      : null;
  }),
);

/** Only authenticated placement reads can select a client-facing relay transport. */
export const portableThreadClientRouteAtom = (environmentId: EnvironmentId, threadId: ThreadId) =>
  clientRouteAtom(encodeRouteKey([environmentId, threadId]));

/** Guest and client transports can differ; a matching placement never changes its phase. */
export function resolvePortableThreadClientRoute(
  route: ThreadRelayRouting | null,
  verified: ThreadRelayRouting | null,
): ThreadRelayRouting | null {
  return route
    ? verified?.generation === route.generation
      ? { ...route, relayUrl: verified.relayUrl }
      : route
    : verified;
}

const authorize = Effect.fnUntraced(function* (registry: AtomRegistry.AtomRegistry) {
  const session = registry.get(managedRelaySessionAtom),
    relay = yield* ManagedRelayTenancyClient;
  if (!session || !normalizeSecureRelayUrl(relay.relayUrl))
    return yield* new OrchestrationDispatchCommandError({
      message: "Sign in to Launchpad Connect to read saved threads.",
    });
  const request = beginPortableThreadPlacementRead(registry, session, relay.relayUrl);
  const clerkToken = yield* session.readClerkToken();
  if (!clerkToken || registry.get(managedRelaySessionAtom) !== session)
    return yield* new OrchestrationDispatchCommandError({
      message: "Your account changed. Sign in again.",
    });
  return { relay, clerkToken, session, request };
});

/** A cold deep link verifies only its exact placement; it never connects or wakes the VM. */
export const verifyPortableThreadClientRoute = Effect.fnUntraced(function* (
  registry: AtomRegistry.AtomRegistry,
  input: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    generation: number;
    session: ManagedRelaySession;
  },
) {
  const changed = () =>
    new OrchestrationDispatchCommandError({
      message: "Your account or this thread’s location changed. Refresh before opening chat.",
    });
  if (registry.get(managedRelaySessionAtom) !== input.session) return yield* changed();
  const { relay, clerkToken, session, request } = yield* authorize(registry);
  const placement = yield* relay.getPortableThreadPlacement({
    clerkToken,
    threadId: input.threadId,
  });
  if (
    registry.get(managedRelaySessionAtom) !== session ||
    placement.threadId !== input.threadId ||
    placement.environmentId !== input.environmentId ||
    placement.generation !== input.generation
  )
    return yield* changed();
  if (
    !rememberPortableThreadPlacement(
      registry,
      session,
      relay.relayUrl,
      placement,
      undefined,
      request,
    )
  )
    return;
  rememberVerifiedRelay(registry, input.environmentId, input.threadId, {
    session,
    relayUrl: relay.relayUrl,
    generation: placement.generation,
  });
});

export interface PortableThreadIndexState {
  readonly session: ManagedRelaySession;
  readonly relayUrl: string;
  readonly entries: ReadonlyArray<RelayPortableThreadSummary>;
  readonly next: string | null;
  readonly allowance?: RelayThreadVmAllowance;
}
export interface PortableThreadDetailState {
  readonly session: ManagedRelaySession;
  readonly history: PortableThreadHistory;
  readonly hasMore: boolean;
}

/** Refresh retained data independently; none of these reads may resume the VM. */
export async function refreshSavedConversation(input: {
  signal: AbortSignal;
  placement: () => Promise<RelayPortableThreadPlacement | null>;
  status: (placement: RelayPortableThreadPlacement) => Promise<unknown>;
  queue: () => Promise<unknown>;
  history: () => Promise<unknown>;
}) {
  const errors: Array<{ section: string; detail: string }> = [];
  const read = async (section: string, action: () => Promise<unknown>) => {
    if (input.signal.aborted) return;
    try {
      await action();
    } catch (cause) {
      if (!input.signal.aborted)
        errors.push({
          section,
          detail: cause instanceof Error ? cause.message : "Could not refresh. Try again.",
        });
    }
  };
  let placement: RelayPortableThreadPlacement | null = null;
  await read("Location", async () => {
    placement = await input.placement();
    if (!placement) throw new Error("Could not confirm this thread’s location.");
  });
  if (input.signal.aborted) return [];
  const current = placement;
  await Promise.all([
    read("Queue", input.queue),
    read("Conversation", input.history),
    ...(current ? [read("VM status", () => input.status(current))] : []),
  ]);
  return errors;
}

/** A private library independent of cached environment/project discovery and VM power state. */
export function createPortableThreadLibraryAtoms<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
) {
  const indexStateAtom = Atom.make<PortableThreadIndexState | null>(null);
  const queueStateAtom = Atom.family((_threadId: ThreadId) =>
    Atom.make<{ session: ManagedRelaySession; current: RelayThreadCurrentQueue } | null>(null),
  );
  const queueAtom = Atom.family((threadId: ThreadId) =>
    Atom.make((get) => {
      const state = get(queueStateAtom(threadId));
      return state?.session === get(managedRelaySessionAtom) ? (state?.current ?? null) : null;
    }),
  );
  const detailStateAtom = Atom.family((_threadId: ThreadId) =>
    Atom.make<PortableThreadDetailState | null>(null),
  );
  const indexAtom = Atom.make((get) => {
    const session = get(managedRelaySessionAtom),
      state = get(indexStateAtom);
    return session && state?.session === session ? state : null;
  });
  const detailAtom = Atom.family((threadId: ThreadId) =>
    Atom.make((get) => {
      const session = get(managedRelaySessionAtom),
        state = get(detailStateAtom(threadId));
      return session && state?.session === session ? state : null;
    }),
  );
  const indexScheduler = createAtomCommandScheduler();
  const readIndex = Effect.fnUntraced(function* (
    input: { after?: string },
    registry: AtomRegistry.AtomRegistry,
    complete = false,
  ) {
    const { relay, clerkToken, session, request: firstRead } = yield* authorize(registry);
    const previous = registry.get(indexAtom);
    if (input.after !== undefined && previous?.next !== input.after)
      return yield* new OrchestrationDispatchCommandError({
        message: "Refresh the saved thread list before loading more.",
      });
    let after = input.after;
    let entries = input.after === undefined ? [] : [...(previous?.entries ?? [])];
    let state: PortableThreadIndexState;
    let request = firstRead;
    do {
      // A failed read retains the last authenticated view until lifecycle/manual retry.
      const page = yield* relay.listPortableThreads({
        clerkToken,
        limit: 100,
        ...(after === undefined ? {} : { after }),
      });
      if (!isPortableThreadPlacementReadScopeCurrent(registry, session, relay.relayUrl))
        return null;
      for (const { placement, vm } of page.entries) {
        if (
          rememberPortableThreadPlacement(registry, session, relay.relayUrl, placement, vm, request)
        )
          rememberVerifiedRelay(registry, placement.environmentId, placement.threadId, {
            session,
            relayUrl: relay.relayUrl,
            generation: placement.generation,
          });
      }
      entries.push(...page.entries);
      state = {
        session,
        relayUrl: relay.relayUrl,
        entries,
        next: page.next,
        ...(page.allowance ? { allowance: page.allowance } : {}),
      };
      after = complete ? (page.next ?? undefined) : undefined;
      if (after !== undefined)
        request = beginPortableThreadPlacementRead(registry, session, relay.relayUrl);
    } while (after !== undefined);
    // A direct location check may have completed after an earlier index page.
    const proofs = registry.get(portableThreadPlacementsAtom);
    if (proofs?.session === session && proofs.relayUrl === normalizeSecureRelayUrl(relay.relayUrl))
      state = {
        ...state,
        entries: entries.map(({ vm: _vm, ...entry }) => {
          const vm = proofs.summaries.get(entry.placement.threadId);
          return {
            ...entry,
            placement: proofs.placements.get(entry.placement.threadId) ?? entry.placement,
            ...(vm ? { vm } : {}),
          };
        }),
      };
    state = {
      ...state,
      entries: [
        ...new Map(state.entries.map((entry) => [entry.placement.threadId, entry])).values(),
      ],
    };
    registry.set(indexStateAtom, state);
    return state;
  });
  const loadIndex = createRuntimeCommand(runtime, {
    label: "read portable threads",
    scheduler: indexScheduler,
    concurrency: { mode: "serial", key: (_input: { after?: string }) => "index" },
    execute: Effect.fnUntraced(function* (input: { after?: string }, registry) {
      return yield* readIndex(input, registry);
    }),
  });
  const refreshIndexCommand = createRuntimeCommand(runtime, {
    label: "refresh portable thread locations",
    scheduler: indexScheduler,
    concurrency: { mode: "serial", key: (_input: void) => "index" },
    execute: Effect.fnUntraced(function* (_input: void, registry) {
      return yield* readIndex({}, registry, true);
    }),
  });
  const refreshing = new WeakMap<
    AtomRegistry.AtomRegistry,
    {
      dirty: boolean;
      promise: ReturnType<typeof refreshIndexCommand.run>;
    }
  >();
  const refreshIndex: typeof refreshIndexCommand = {
    label: refreshIndexCommand.label,
    run(registry, input) {
      const pending = refreshing.get(registry);
      if (pending) {
        pending.dirty = true;
        return pending.promise;
      }
      const pendingRefresh = {
        dirty: false,
        promise: refreshIndexCommand.run(registry, input),
      };
      const initial = pendingRefresh.promise;
      pendingRefresh.promise = (async () => {
        try {
          let result = await initial;
          while (pendingRefresh.dirty) {
            pendingRefresh.dirty = false;
            result = await refreshIndexCommand.run(registry, input);
          }
          return result;
        } finally {
          refreshing.delete(registry);
        }
      })();
      refreshing.set(registry, pendingRefresh);
      return pendingRefresh.promise;
    },
  };
  const refreshPlacement = createRuntimeCommand(runtime, {
    label: "refresh moving thread location",
    concurrency: { mode: "singleFlight", key: (input: { threadId: ThreadId }) => input.threadId },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session, request } = yield* authorize(registry);
      const placement = yield* relay.getPortableThreadPlacement({
        clerkToken,
        threadId: input.threadId,
      });
      if (
        placement.threadId !== input.threadId ||
        !rememberPortableThreadPlacement(
          registry,
          session,
          relay.relayUrl,
          placement,
          undefined,
          request,
        )
      )
        return null;
      rememberVerifiedRelay(registry, placement.environmentId, placement.threadId, {
        session,
        relayUrl: relay.relayUrl,
        generation: placement.generation,
      });
      return placement;
    }),
  });
  const loadHistory = createRuntimeCommand(runtime, {
    label: "read retained conversation",
    concurrency: {
      mode: "serial",
      key: (input: { threadId: ThreadId; more?: boolean; refresh?: boolean }) => input.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      if (
        !registry
          .get(indexAtom)
          ?.entries.some((entry) => entry.placement.threadId === input.threadId)
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "Refresh the saved thread list before opening this conversation.",
        });
      const previous =
        input.more || input.refresh ? registry.get(detailAtom(input.threadId)) : null;
      if (input.more && (!previous || !previous.hasMore)) return previous;
      const history = previous?.history ?? emptyPortableThreadHistory();
      const page = yield* relay
        .getPortableThreadHistory({
          clerkToken,
          threadId: input.threadId,
          after: history.cursor,
          limit: 200,
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (registry.get(managedRelaySessionAtom) === session)
                registry.set(detailStateAtom(input.threadId), null);
            }),
          ),
        );
      if (registry.get(managedRelaySessionAtom) !== session) return null;
      const next = yield* Effect.try({
        try: () => applyPortableThreadHistoryPage(history, input.threadId, page),
        catch: (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Retained conversation could not be verified.",
            cause,
          }),
      });
      const state = { session, history: next, hasMore: page.entries.length === 200 };
      registry.set(detailStateAtom(input.threadId), state);
      return state;
    }),
  });
  const loadQueue = createRuntimeCommand(runtime, {
    label: "read current thread queue",
    concurrency: {
      mode: "serial",
      key: (input: { threadId: ThreadId; commandId?: CommandId }) => input.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      const current = yield* relay.getPortableThreadCurrentQueue({
        clerkToken,
        threadId: input.threadId,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      });
      if (registry.get(managedRelaySessionAtom) !== session) return null;
      registry.set(queueStateAtom(input.threadId), { session, current });
      return current;
    }),
  });
  const queueReceipt = createRuntimeCommand(runtime, {
    label: "read saved queue receipt",
    concurrency: {
      mode: "serial",
      key: (input: { threadId: ThreadId; commandId: string }) => input.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      const receipt = yield* relay.getPortableThreadCommandReceipt({ clerkToken, ...input });
      if (registry.get(managedRelaySessionAtom) !== session) return null;
      return receipt;
    }),
  });
  const queueControl = createRuntimeCommand(runtime, {
    label: "change saved thread queue",
    concurrency: {
      mode: "serial",
      key: (input: {
        accountId: string;
        command:
          | import("./threadQueueControlSubmission.ts").ThreadQueueControlSubmission["command"]
          | (import("../operations/commands.ts").CancelThreadMoveInput & {
              type: "thread.move.cancel";
              commandId: CommandId;
              createdAt: string;
            });
      }) => input.command.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      if (session.accountId !== input.accountId)
        return yield* new OrchestrationDispatchCommandError({
          message: "This saved queue request belongs to another account.",
        });
      const command = input.command;
      const receipt = yield* relay.stagePortableThreadCommand({
        clerkToken,
        threadId: command.threadId,
        command,
      });
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. Check this command’s receipt before retrying.",
        });
      if (receipt.commandId !== command.commandId)
        return yield* new OrchestrationDispatchCommandError({
          message: "The relay acknowledged a different queue request.",
        });
      return receipt;
    }),
  });
  const downloadAttachment = createRuntimeCommand(runtime, {
    label: "download saved attachment",
    concurrency: {
      mode: "serial",
      key: (input: { threadId: ThreadId; attachmentId: string }) => input.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      const bytes = yield* relay.downloadPortableThreadAttachment({ clerkToken, ...input });
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. The download was discarded.",
        });
      return bytes;
    }),
  });
  return {
    queueControl,
    queueReceipt,
    queueAtom,
    loadQueue,
    downloadAttachment,
    indexAtom,
    detailAtom,
    loadIndex,
    refreshIndex,
    refreshPlacement,
    loadHistory,
    routeAtom: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ): Atom.Atom<ThreadRelayRouting | null> =>
      portableThreadClientRouteAtom(environmentId, threadId),
  };
}

type PortableThreadChatInput = {
  threadId: ThreadId;
  title: string;
  expectedPlacement?: { environmentId: EnvironmentId; generation: number };
};
/** Explicit connection only: saved reads never call this or resume compute. */
export const openPortableThreadChat = Effect.fnUntraced(function* (
  input: PortableThreadChatInput,
  registry: AtomRegistry.AtomRegistry,
  connections: Pick<EnvironmentRegistry["Service"], "entries" | "register" | "setEnabled">,
) {
  const { relay, clerkToken, session, request: firstRead } = yield* authorize(registry);
  const currentAccount = () => registry.get(managedRelaySessionAtom) === session;
  const changed = () =>
    new OrchestrationDispatchCommandError({
      message: "Your account or this thread’s location changed. Refresh before opening chat.",
    });
  const auth = { clerkToken, threadId: input.threadId };
  const placement = yield* relay.getPortableThreadPlacement(auth);
  if (
    !currentAccount() ||
    !isPortableThreadPlacementReadCurrent(
      registry,
      session,
      relay.relayUrl,
      input.threadId,
      firstRead,
    ) ||
    placement.threadId !== input.threadId ||
    placement.operationId !== null ||
    (input.expectedPlacement &&
      (placement.environmentId !== input.expectedPlacement.environmentId ||
        placement.generation !== input.expectedPlacement.generation))
  )
    return yield* changed();
  const status = yield* relay.getThreadVmStatus(auth);
  if (
    !currentAccount() ||
    status.threadId !== input.threadId ||
    status.generation !== placement.generation
  )
    return yield* changed();
  if (
    status.allocation &&
    (status.allocation.state !== "running" ||
      status.setupPhase !== "ready" ||
      status.finalSave ||
      status.restore ||
      status.reset ||
      status.pausePhase === "pending" ||
      status.pausePhase === "sealed")
  )
    return yield* new OrchestrationDispatchCommandError({
      message: "Resume or restore this VM and let setup finish before opening chat.",
    });
  if (!status.allocation && status.savedDisk)
    return yield* new OrchestrationDispatchCommandError({
      message: "Restore or reset the saved workspace before opening chat.",
    });
  // Reads can overlap a move. Never register the stale source from the library row.
  if (!isPortableThreadPlacementReadScopeCurrent(registry, session, relay.relayUrl))
    return yield* changed();
  const request = beginPortableThreadPlacementRead(registry, session, relay.relayUrl);
  const latest = yield* relay.getPortableThreadPlacement(auth);
  if (
    !currentAccount() ||
    !isPortableThreadPlacementReadCurrent(
      registry,
      session,
      relay.relayUrl,
      input.threadId,
      request,
    ) ||
    latest.threadId !== input.threadId ||
    latest.environmentId !== placement.environmentId ||
    latest.generation !== placement.generation ||
    latest.operationId !== null
  )
    return yield* changed();
  const environmentId = EnvironmentId.make(latest.environmentId);
  const existing = (yield* SubscriptionRef.get(connections.entries)).get(environmentId);
  if (!currentAccount()) return yield* changed();
  if (!existing) {
    yield* connections.register(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({ environmentId, label: input.title }),
      }),
    );
  } else if (!existing.enabled) {
    // Preserve a known local, bearer or SSH transport rather than replacing it.
    yield* connections.setEnabled(environmentId, true);
  }
  if (!currentAccount()) return yield* changed();
  if (
    !rememberPortableThreadPlacement(registry, session, relay.relayUrl, latest, undefined, request)
  )
    return yield* changed();
  rememberVerifiedRelay(registry, environmentId, input.threadId, {
    session,
    relayUrl: relay.relayUrl,
    generation: latest.generation,
  });
  return { environmentId, threadId: input.threadId };
});

export function createPortableThreadChatCommand<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | EnvironmentRegistry | R, E>,
) {
  return createRuntimeCommand(runtime, {
    label: "open portable thread chat",
    concurrency: {
      mode: "serial",
      key: (input: PortableThreadChatInput) => input.threadId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      return yield* openPortableThreadChat(input, registry, yield* EnvironmentRegistry);
    }),
  });
}

const vmLocation = { kind: "vm", label: "Private VM" } as const;
const overviewStates = {
  on_machine: {
    location: { kind: "machine", label: "On machine" },
    status: null,
    tone: "neutral",
  },
  preparing: { location: vmLocation, status: "Preparing", tone: "neutral" },
  running: { location: vmLocation, status: "Running", tone: "neutral" },
  paused: { location: vmLocation, status: "Paused", tone: "neutral" },
  saving: { location: vmLocation, status: "Saving workspace", tone: "neutral" },
  saved: { location: null, status: "Saved workspace", tone: "neutral" },
  expired: { location: null, status: "Workspace expired", tone: "warning" },
  moving: { location: null, status: "Moving thread", tone: "neutral" },
  unavailable: { location: null, status: "Unavailable", tone: "warning" },
  unknown: { location: null, status: "Unknown", tone: "neutral" },
} as const;

/** Uses the overview summary only; reading or expanding a row never wakes compute. */
export function portableThreadOverviewPresentation(summary: RelayPortableThreadSummary) {
  const vm = summary.vm;
  const display = overviewStates[vm?.state ?? "unknown"];
  const activity =
    vm?.activity === "busy" ? "Working" : vm?.activity === "idle" ? "Idle" : "Unknown";
  if (
    summary.placement.operationId !== null &&
    (vm?.state === "running" || vm?.state === "on_machine")
  ) {
    return { ...display, status: "Updating", tone: "neutral", activity } as const;
  }
  if (vm?.state === "running" && vm.activity !== "unknown") {
    return {
      ...display,
      status: vm.activity === "busy" ? "Working" : "Ready",
      tone: vm.activity === "idle" ? "success" : "neutral",
      activity,
    } as const;
  }
  return { ...display, activity };
}

export function portableThreadOverviewAction(
  summary: RelayPortableThreadSummary,
  capabilities: ThreadVmCapabilities | null,
) {
  if (summary.placement.operationId !== null) return "Manage VM";
  switch (summary.vm?.state) {
    case "running":
    case "on_machine":
      return "Open chat";
    case "paused":
      return capabilities?.configured ? "Resume VM" : "Manage VM";
    case "saved":
      return summary.vm.savedDiskOperationId && capabilities?.restore ? "Restore VM" : "Manage VM";
    default:
      return "Manage VM";
  }
}
