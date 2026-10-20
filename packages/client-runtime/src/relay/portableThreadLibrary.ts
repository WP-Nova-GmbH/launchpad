import {
  EnvironmentId,
  ThreadId,
  OrchestrationDispatchCommandError,
  type ThreadRelayRouting,
} from "@t3tools/contracts";
import type { RelayPortableThreadSummary } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { RelayConnectionRegistration } from "../connection/catalog.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createRuntimeCommand } from "../state/runtime.ts";
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
  const clerkToken = yield* session.readClerkToken();
  if (!clerkToken || registry.get(managedRelaySessionAtom) !== session)
    return yield* new OrchestrationDispatchCommandError({
      message: "Your account changed. Sign in again.",
    });
  return { relay, clerkToken, session };
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
  const { relay, clerkToken, session } = yield* authorize(registry);
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
}
export interface PortableThreadDetailState {
  readonly session: ManagedRelaySession;
  readonly history: PortableThreadHistory;
  readonly hasMore: boolean;
}

/** A private library independent of cached environment/project discovery and VM power state. */
export function createPortableThreadLibraryAtoms<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
) {
  const openAtom = Atom.make(false).pipe(Atom.keepAlive);
  const indexStateAtom = Atom.make<PortableThreadIndexState | null>(null);
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
  const loadIndex = createRuntimeCommand(runtime, {
    label: "read portable threads",
    concurrency: { mode: "serial", key: (_input: { after?: string }) => "index" },
    execute: Effect.fnUntraced(function* (input: { after?: string }, registry) {
      const { relay, clerkToken, session } = yield* authorize(registry);
      const previous = registry.get(indexAtom);
      if (input.after !== undefined && previous?.next !== input.after)
        return yield* new OrchestrationDispatchCommandError({
          message: "Refresh the saved thread list before loading more.",
        });
      const page = yield* relay
        .listPortableThreads({
          clerkToken,
          limit: 100,
          ...(input.after === undefined ? {} : { after: input.after }),
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (registry.get(managedRelaySessionAtom) === session)
                registry.set(indexStateAtom, null);
            }),
          ),
        );
      if (registry.get(managedRelaySessionAtom) !== session) return null;
      const entries =
        input.after === undefined ? page.entries : [...(previous?.entries ?? []), ...page.entries];
      const state = { session, relayUrl: relay.relayUrl, entries, next: page.next };
      registry.set(indexStateAtom, state);
      for (const { placement } of page.entries)
        rememberVerifiedRelay(registry, placement.environmentId, placement.threadId, {
          session,
          relayUrl: relay.relayUrl,
          generation: placement.generation,
        });
      return state;
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
  const queueControl = createRuntimeCommand(runtime, {
    label: "change saved thread queue",
    concurrency: {
      mode: "serial",
      key: (input: {
        accountId: string;
        command: import("./threadQueueControlSubmission.ts").ThreadQueueControlSubmission["command"];
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
    openAtom,
    queueControl,
    downloadAttachment,
    indexAtom,
    detailAtom,
    loadIndex,
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
  const { relay, clerkToken, session } = yield* authorize(registry);
  const currentAccount = () => registry.get(managedRelaySessionAtom) === session;
  const changed = () =>
    new OrchestrationDispatchCommandError({
      message: "Your account or this thread’s location changed. Refresh before opening chat.",
    });
  const auth = { clerkToken, threadId: input.threadId };
  const placement = yield* relay.getPortableThreadPlacement(auth);
  if (
    !currentAccount() ||
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
  const latest = yield* relay.getPortableThreadPlacement(auth);
  if (
    !currentAccount() ||
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
