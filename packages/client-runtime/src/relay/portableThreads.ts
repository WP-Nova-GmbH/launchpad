import type {
  RelayThreadCommandReceipt,
  RelayThreadPendingCommandPage,
} from "@t3tools/contracts/relay";
import {
  OrchestrationDispatchCommandError,
  PortableThreadCommand,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type ThreadId,
  type EnvironmentId,
  type ThreadRelayRouting,
  type MessageId,
} from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { ThreadCommandRouting } from "../operations/commandRouting.ts";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import { readManagedRelaySnapshotState, managedRelaySessionAtom } from "./managedRelayState.ts";

import {
  portableThreadClientRouteAtom,
  resolvePortableThreadClientRoute,
  verifyPortableThreadClientRoute,
} from "./portableThreadLibrary.ts";

export interface PortableCommandState {
  readonly accountId: string;
  readonly relayUrl: string;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly commandId: string;
  readonly promptMessageId?: MessageId;
  readonly receipt: RelayThreadCommandReceipt | null;
}

export const portableCommandStatesAtom = Atom.make<ReadonlyArray<PortableCommandState>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("portable-thread:command-receipts"),
);

const trimRejectedNotices = (states: ReadonlyArray<PortableCommandState>) => {
  const retained = new Set(
    states.filter((state) => state.receipt?.receipt?.status === "rejected").slice(-20),
  );
  return states.filter(
    (state) => state.receipt?.receipt?.status !== "rejected" || retained.has(state),
  );
};

const completedCommandsAtom = Atom.family((scope: string) =>
  Atom.make(new Set<string>()).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`portable-thread:completed:${scope}`),
  ),
);

function completionScope(
  state: Pick<PortableCommandState, "accountId" | "relayUrl" | "environmentId" | "threadId">,
) {
  return JSON.stringify([
    state.environmentId,
    state.threadId,
    state.accountId,
    normalizeSecureRelayUrl(state.relayUrl),
  ]);
}

/** Positive receipts only live while a pending-status cache can still name them. */
function rememberCompletion(
  registry: AtomRegistry.AtomRegistry,
  state: PortableCommandState,
  receipt: RelayThreadCommandReceipt | null,
) {
  if (receipt?.receipt?.status !== "accepted") return;
  registry.update(
    completedCommandsAtom(completionScope(state)),
    (ids) => new Set([...ids, state.commandId]),
  );
}

type PortableCommandProgress = Pick<PortableCommandState, "commandId" | "promptMessageId">;

/** Hide only known prompt commands already represented elsewhere in this client. */
export function portableThreadCommandPresentation(
  state: {
    readonly relayCommands: ReadonlyArray<PortableCommandProgress>;
    readonly environmentCommands: ReadonlyArray<PortableCommandProgress>;
    readonly hasMore: boolean;
    readonly rejections: ReadonlyArray<{ readonly commandId: string; readonly detail: string }>;
    readonly error: string | null;
  } | null,
  representedMessageIds: ReadonlyArray<string> = [],
) {
  if (!state) return null;
  const represented =
    state.relayCommands.some((command) => command.promptMessageId) ||
    state.environmentCommands.some((command) => command.promptMessageId)
      ? new Set(representedMessageIds)
      : null;
  const visible = (command: PortableCommandProgress) =>
    !command.promptMessageId || !represented?.has(command.promptMessageId);
  return {
    waitingForRelay: state.relayCommands.filter(visible).length,
    waitingForEnvironment: state.environmentCommands.filter(visible).length,
    hasMore: state.hasMore,
    rejections: state.rejections,
    error: state.error,
  };
}

const decodeCommand = Schema.decodeUnknownEffect(PortableThreadCommand);

/** Pins relay ownership even when the old environment disconnects or retires. */
export const portableThreadCommandLayer = (registry: AtomRegistry.AtomRegistry) =>
  Layer.effect(
    ThreadCommandRouting,
    Effect.gen(function* () {
      const relay = yield* ManagedRelayTenancyClient;
      const routes = new Map<string, ThreadRelayRouting>();
      const routeKey = (threadId: ThreadId, environmentId: EnvironmentId) =>
        JSON.stringify([environmentId, threadId]);
      const remember = (
        snapshot: Pick<OrchestrationShellSnapshot, "threads">,
        environmentId: EnvironmentId,
      ) => {
        for (const thread of snapshot.threads) {
          const route = thread.relayRouting;
          const key = routeKey(thread.id, environmentId);
          if (route && route.generation >= (routes.get(key)?.generation ?? -1))
            routes.set(key, route);
        }
      };
      const clientRoute = Effect.fnUntraced(function* (
        threadId: ThreadId,
        environmentId: EnvironmentId,
      ) {
        const current = () =>
          resolvePortableThreadClientRoute(
            routes.get(routeKey(threadId, environmentId)) ?? null,
            registry.get(portableThreadClientRouteAtom(environmentId, threadId)),
          );
        const route = current();
        const session = registry.get(managedRelaySessionAtom);
        if (
          route &&
          session &&
          normalizeSecureRelayUrl(relay.relayUrl) &&
          normalizeSecureRelayUrl(route.relayUrl) !== normalizeSecureRelayUrl(relay.relayUrl)
        ) {
          // An environment can reach the same relay through a different transport.
          // Verify this location belongs to the thread through the configured client relay first.
          yield* verifyPortableThreadClientRoute(registry, {
            environmentId,
            threadId,
            generation: route.generation,
            session,
          }).pipe(
            Effect.provideService(ManagedRelayTenancyClient, relay),
            Effect.mapError((cause) =>
              cause._tag === "OrchestrationDispatchCommandError"
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Could not verify this thread's relay connection.",
                    cause,
                  }),
            ),
          );
        }
        return current();
      });
      const dispatch = Effect.fn("PortableThreadCommands.dispatch")(function* (
        command: ClientOrchestrationCommand,
        environmentId: EnvironmentId,
      ) {
        if (!("threadId" in command))
          return yield* new OrchestrationDispatchCommandError({
            message: "This is not a thread command.",
          });
        const route = yield* clientRoute(command.threadId, environmentId);
        if (
          !route ||
          !normalizeSecureRelayUrl(relay.relayUrl) ||
          normalizeSecureRelayUrl(route.relayUrl) !== normalizeSecureRelayUrl(relay.relayUrl)
        )
          return yield* new OrchestrationDispatchCommandError({
            message: "Connect to this thread's relay before changing it.",
          });
        // Do not send a token to a relay selected by an environment snapshot.
        const session = registry.get(managedRelaySessionAtom);
        if (!session)
          return yield* new OrchestrationDispatchCommandError({
            message: "Sign in to Launchpad Connect before changing this thread.",
          });
        const portable = yield* decodeCommand(command).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "This command is not supported for a portable thread.",
                cause,
              }),
          ),
        );
        const clerkToken = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Could not read your Launchpad Connect session.",
                cause,
              }),
          ),
        );
        if (!clerkToken || registry.get(managedRelaySessionAtom) !== session)
          return yield* new OrchestrationDispatchCommandError({
            message: "Sign in again before changing this thread.",
          });
        const state: PortableCommandState = {
          accountId: session.accountId,
          relayUrl: relay.relayUrl,
          threadId: command.threadId,
          environmentId,
          commandId: command.commandId,
          ...(portable.type === "thread.prompt.enqueue"
            ? { promptMessageId: portable.message.messageId }
            : {}),
          receipt: null,
        };
        const update = (receipt: RelayThreadCommandReceipt | null) =>
          Atom.batch(() => {
            rememberCompletion(registry, state, receipt);
            registry.update(portableCommandStatesAtom, (states) => {
              const rest = states.filter(
                (item) =>
                  !(
                    item.accountId === state.accountId &&
                    item.relayUrl === state.relayUrl &&
                    item.environmentId === state.environmentId &&
                    item.threadId === state.threadId &&
                    item.commandId === state.commandId
                  ),
              );
              return receipt?.receipt?.status === "accepted"
                ? rest
                : trimRejectedNotices([...rest, { ...state, receipt }]);
            });
          });
        update(null);
        const receipt = yield* relay
          .stagePortableThreadCommand({
            clerkToken,
            threadId: command.threadId,
            command: portable,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message:
                    "Could not confirm relay acceptance. Retry this command with the same ID.",
                  cause,
                }),
            ),
          );
        update(receipt);
        if (receipt.receipt?.status === "rejected")
          return yield* new OrchestrationDispatchCommandError({
            message: receipt.receipt.detail ?? "The environment rejected this command.",
          });
        return { relay: receipt };
      });
      return {
        remember,
        isPortable: (threadId: ThreadId, environmentId: EnvironmentId) =>
          routes.has(routeKey(threadId, environmentId)),
        dispatch,
        receipt: Effect.fn("PortableThreadCommands.receipt")(
          function* (threadId, commandId, environmentId) {
            const route = yield* clientRoute(threadId, environmentId);
            if (
              !route ||
              !normalizeSecureRelayUrl(relay.relayUrl) ||
              normalizeSecureRelayUrl(route.relayUrl) !== normalizeSecureRelayUrl(relay.relayUrl)
            )
              return yield* new OrchestrationDispatchCommandError({
                message: "Connect to this thread's relay before reading its command result.",
              });
            const session = registry.get(managedRelaySessionAtom);
            if (!session)
              return yield* new OrchestrationDispatchCommandError({
                message: "Sign in to read this command result.",
              });
            return yield* refreshPortableCommandReceipt(registry, {
              accountId: session.accountId,
              relayUrl: relay.relayUrl,
              threadId,
              environmentId,
              commandId,
              receipt: null,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: "Could not read the relay command result.",
                    cause,
                  }),
              ),
              Effect.provideService(ManagedRelayTenancyClient, relay),
            );
          },
        ),
      };
    }),
  );

/** Reading a command result never connects to or wakes its environment. */
export const refreshPortableCommandReceipt = Effect.fn("PortableThreadCommands.refreshReceipt")(
  function* (registry: AtomRegistry.AtomRegistry, state: PortableCommandState) {
    const relay = yield* ManagedRelayTenancyClient;
    const session = registry.get(managedRelaySessionAtom);
    if (!session || session.accountId !== state.accountId || relay.relayUrl !== state.relayUrl)
      return yield* new OrchestrationDispatchCommandError({
        message: "Sign in to the account that sent this command.",
      });
    const clerkToken = yield* session.readClerkToken();
    if (!clerkToken || registry.get(managedRelaySessionAtom)?.accountId !== state.accountId)
      return yield* new OrchestrationDispatchCommandError({
        message: "Sign in again before reading this command.",
      });
    const receipt = yield* relay.getPortableThreadCommandReceipt({
      clerkToken,
      threadId: state.threadId,
      commandId: state.commandId,
    });
    if (registry.get(managedRelaySessionAtom)?.accountId !== state.accountId) return receipt;
    Atom.batch(() => {
      rememberCompletion(registry, state, receipt);
      registry.update(portableCommandStatesAtom, (states) =>
        trimRejectedNotices(
          states.flatMap((item) =>
            item.accountId === state.accountId &&
            item.relayUrl === state.relayUrl &&
            item.environmentId === state.environmentId &&
            item.threadId === state.threadId &&
            item.commandId === state.commandId
              ? receipt?.receipt?.status === "accepted"
                ? []
                : [{ ...item, receipt }]
              : [item],
          ),
        ),
      );
    });
    return receipt;
  },
);

export function createPortableThreadCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
) {
  const routingAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      return resolvePortableThreadClientRoute(
        get(snapshotAtom(environmentId))?.threads.find((thread) => thread.id === threadId)
          ?.relayRouting ?? null,
        get(portableThreadClientRouteAtom(environmentId, threadId)),
      );
    }).pipe(
      Atom.withEquality<ThreadRelayRouting | null>(
        (a, b) =>
          a?.relayUrl === b?.relayUrl && a?.generation === b?.generation && a?.phase === b?.phase,
      ),
    ),
  );
  const pendingAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return runtime
      .atom((get) => {
        const previousPage = Option.getOrNull(
          Option.flatMap(
            get.self<AsyncResult.AsyncResult<RelayThreadPendingCommandPage | null, unknown>>(),
            AsyncResult.value,
          ),
        );
        return Effect.gen(function* () {
          const route = get(routingAtom(key));
          const session = get(managedRelaySessionAtom);
          if (!route || !session) return null;
          const completions = completedCommandsAtom(
            completionScope({
              accountId: session.accountId,
              relayUrl: route.relayUrl,
              environmentId,
              threadId,
            }),
          );
          get.mount(completions);
          const relay = yield* ManagedRelayTenancyClient;
          if (
            !normalizeSecureRelayUrl(relay.relayUrl) ||
            normalizeSecureRelayUrl(relay.relayUrl) !== normalizeSecureRelayUrl(route.relayUrl)
          )
            return yield* new OrchestrationDispatchCommandError({
              message: "Connect to this thread's relay to read queued changes.",
            });
          const clerkToken = yield* session.readClerkToken();
          if (!clerkToken)
            return yield* new OrchestrationDispatchCommandError({
              message: "Sign in again to read queued changes.",
            });
          const registry = yield* AtomRegistry.AtomRegistry;
          if (registry.get(managedRelaySessionAtom)?.accountId !== session.accountId) return null;
          const page = yield* relay.getPendingPortableThreadCommands({
            clerkToken,
            threadId,
            after: 0,
            limit: 200,
          });
          if (registry.get(managedRelaySessionAtom)?.accountId !== session.accountId) return null;
          const local = registry
            .get(portableCommandStatesAtom)
            .filter(
              (state) =>
                state.accountId === session.accountId &&
                state.relayUrl === relay.relayUrl &&
                state.threadId === threadId &&
                state.environmentId === environmentId &&
                (state.receipt === null || state.receipt.receipt === null),
            )
            .slice(0, 16);
          const completed = yield* Effect.forEach(
            local,
            (state) =>
              refreshPortableCommandReceipt(registry, state).pipe(
                Effect.map((receipt) => (receipt?.receipt ? state.commandId : null)),
                Effect.orElseSucceed(() => null),
              ),
            { concurrency: 4 },
          );
          // Keep positive receipts while an older rendered page can still name
          // them. Once both cached and fresh pages omit them, no old banner can return.
          if (previousPage && !previousPage.hasMore && !page.hasMore) {
            const pendingIds = new Set([
              ...previousPage.entries.map((entry) => entry.commandId),
              ...page.entries.map((entry) => entry.commandId),
            ]);
            registry.update(
              completions,
              (ids) => new Set([...ids].filter((id) => pendingIds.has(id))),
            );
          }
          return {
            ...page,
            entries: page.entries.filter((entry) => !completed.includes(entry.commandId)),
          };
        });
      })
      .pipe(
        Atom.withRefresh(15_000),
        Atom.setIdleTTL(0),
        Atom.withLabel(`portable-thread:pending:${key}`),
      );
  });
  const viewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
      const session = get(managedRelaySessionAtom);
      const route = get(routingAtom(key));
      if (!route || !session) return null;
      const completed = get(
        completedCommandsAtom(
          completionScope({
            accountId: session.accountId,
            relayUrl: route.relayUrl,
            environmentId,
            threadId,
          }),
        ),
      );
      const result = readManagedRelaySnapshotState(get(pendingAtom(key)));
      const local = get(portableCommandStatesAtom).filter(
        (state) =>
          state.accountId === session.accountId &&
          state.threadId === threadId &&
          state.environmentId === environmentId &&
          normalizeSecureRelayUrl(state.relayUrl) === normalizeSecureRelayUrl(route.relayUrl),
      );
      const completedCommands = new Set([
        ...completed,
        ...local.filter((state) => state.receipt?.receipt).map((state) => state.commandId),
      ]);
      const waitingForRelay = new Set(
        local.filter((state) => state.receipt === null).map((state) => state.commandId),
      );
      const waitingForEnvironment = new Set([
        ...(result.data?.entries.map((entry) => entry.commandId) ?? []),
        ...local
          .filter((state) => state.receipt !== null && state.receipt.receipt === null)
          .map((state) => state.commandId),
      ]);
      for (const id of completedCommands) waitingForEnvironment.delete(id);
      for (const id of waitingForEnvironment) waitingForRelay.delete(id);
      const known = new Map(local.map((state) => [state.commandId, state.promptMessageId]));
      const progress = (ids: ReadonlySet<string>) =>
        result.error
          ? []
          : [...ids].map((commandId) => {
              const promptMessageId = known.get(commandId);
              return { commandId, ...(promptMessageId ? { promptMessageId } : {}) };
            });
      const state = {
        relayCommands: progress(waitingForRelay),
        environmentCommands: progress(waitingForEnvironment),
        hasMore: !result.error && (result.data?.hasMore ?? false),
        rejections: (result.error ? [] : local).flatMap((state) =>
          state.receipt?.receipt?.status === "rejected"
            ? [
                {
                  commandId: state.commandId,
                  detail: state.receipt.receipt.detail ?? "The environment rejected a change.",
                },
              ]
            : [],
        ),
        error: result.error,
      };
      return { ...state, ...portableThreadCommandPresentation(state)! };
    }).pipe(Atom.setIdleTTL(0)),
  );
  return {
    pendingAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      pendingAtom(JSON.stringify([environmentId, threadId])),
    viewAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      viewAtom(JSON.stringify([environmentId, threadId])),
  };
}
