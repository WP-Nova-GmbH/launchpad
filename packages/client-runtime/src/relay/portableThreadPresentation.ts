import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayPortableThreadPlacement,
  RelayPortableThreadVmSummary,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { Connectivity } from "../connection/connectivity.ts";
import { ConnectionWakeups, isApplicationActiveWakeup } from "../connection/wakeups.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import type { createPortableThreadLibraryAtoms } from "./portableThreadLibrary.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import { managedRelaySessionAtom, type ManagedRelaySession } from "./managedRelayState.ts";

interface PlacementProofs {
  readonly session: ManagedRelaySession;
  readonly relayUrl: string;
  readonly placements: ReadonlyMap<string, RelayPortableThreadPlacement>;
  readonly summaries: ReadonlyMap<string, RelayPortableThreadVmSummary>;
  readonly reads: ReadonlyMap<string, number>;
}

const placementReadSequenceAtom = Atom.make(0).pipe(Atom.keepAlive);
const placementReadScopeAtom = Atom.make<{
  session: ManagedRelaySession;
  relayUrl: string | null;
} | null>(null).pipe(Atom.keepAlive);

/** Allocate before the request, so every authenticated placement writer shares response ordering. */
export function beginPortableThreadPlacementRead(
  registry: AtomRegistry.AtomRegistry,
  session: ManagedRelaySession,
  relayUrl: string,
): number {
  registry.set(placementReadScopeAtom, { session, relayUrl: normalizeSecureRelayUrl(relayUrl) });
  registry.update(placementReadSequenceAtom, (value) => value + 1);
  return registry.get(placementReadSequenceAtom);
}

export function isPortableThreadPlacementReadScopeCurrent(
  registry: AtomRegistry.AtomRegistry,
  session: ManagedRelaySession,
  relayUrl: string,
): boolean {
  const scope = registry.get(placementReadScopeAtom);
  return (
    registry.get(managedRelaySessionAtom) === session &&
    scope?.session === session &&
    scope.relayUrl === normalizeSecureRelayUrl(relayUrl)
  );
}

export function isPortableThreadPlacementReadCurrent(
  registry: AtomRegistry.AtomRegistry,
  session: ManagedRelaySession,
  relayUrl: string,
  threadId: string,
  request: number,
): boolean {
  const proofs = registry.get(portableThreadPlacementsAtom);
  return (
    isPortableThreadPlacementReadScopeCurrent(registry, session, relayUrl) &&
    (proofs?.session !== session ||
      proofs.relayUrl !== normalizeSecureRelayUrl(relayUrl) ||
      (proofs.reads.get(threadId) ?? 0) <= request)
  );
}

/** Placement reads are authenticated; cached UUIDs alone never identify a portable conversation. */
export const portableThreadPlacementsAtom = Atom.make<PlacementProofs | null>(null).pipe(
  Atom.keepAlive,
);

export function rememberPortableThreadPlacement(
  registry: AtomRegistry.AtomRegistry,
  session: ManagedRelaySession,
  relayUrl: string,
  placement: RelayPortableThreadPlacement,
  summary?: RelayPortableThreadVmSummary,
  request = beginPortableThreadPlacementRead(registry, session, relayUrl),
): boolean {
  const normalizedRelay = normalizeSecureRelayUrl(relayUrl);
  if (
    !normalizedRelay ||
    !isPortableThreadPlacementReadCurrent(registry, session, relayUrl, placement.threadId, request)
  )
    return false;
  let accepted = false;
  registry.update(portableThreadPlacementsAtom, (previous) => {
    const sameScope = previous?.session === session && previous.relayUrl === normalizedRelay;
    const placements = new Map(sameScope ? previous.placements : []);
    const known = placements.get(placement.threadId);
    if (known && known.generation > placement.generation) return previous;
    accepted = true;
    placements.set(placement.threadId, placement);
    const reads = new Map(sameScope ? previous.reads : []);
    reads.set(placement.threadId, request);
    const summaries = new Map(sameScope ? previous.summaries : []);
    if (summary) summaries.set(placement.threadId, summary);
    else if (
      known?.generation !== placement.generation ||
      known.operationId !== placement.operationId
    )
      summaries.delete(placement.threadId);
    return { session, relayUrl: normalizedRelay, placements, summaries, reads };
  });
  return accepted;
}

/** Completed relay moves prove source aliases without trusting equal thread UUIDs. */
export function isPortableThreadSourceLocation(
  shell: Pick<EnvironmentThreadShell, "id" | "environmentId" | "relayRouting">,
  placement: RelayPortableThreadPlacement,
  relayUrl: string,
): boolean {
  const route = shell.relayRouting;
  return (
    shell.id === placement.threadId &&
    !!route &&
    (placement.previousLocations?.some(
      (source) =>
        source.environmentId === shell.environmentId && source.generation === route.generation,
    ) === true ||
      (normalizeSecureRelayUrl(route.relayUrl) === normalizeSecureRelayUrl(relayUrl) &&
        route.generation <= placement.generation + (placement.operationId === null ? 0 : 1)))
  );
}

/** Raw shell lists remain available to outboxes and commands; only navigation uses this projection. */
export function selectPortableThreadPresentation<T extends EnvironmentThreadShell>(
  shells: ReadonlyArray<T>,
  placements: ReadonlyMap<string, RelayPortableThreadPlacement>,
  relayUrl: string,
  summaries: ReadonlyMap<string, RelayPortableThreadVmSummary> = new Map(),
): ReadonlyArray<T> {
  const relay = normalizeSecureRelayUrl(relayUrl);
  if (!relay) return shells;
  const hidden = new Set<T>();
  const fallback = new Map<T, NonNullable<EnvironmentThreadShell["portableLocation"]>>();
  const byId = new Map<string, T[]>();
  for (const shell of shells) {
    const existing = byId.get(shell.id);
    if (existing) existing.push(shell);
    else byId.set(shell.id, [shell]);
  }
  for (const placement of placements.values()) {
    const matching = (byId.get(placement.threadId) ?? []).filter(
      (shell) =>
        shell.environmentId === placement.environmentId ||
        isPortableThreadSourceLocation(shell, placement, relayUrl),
    );
    if (matching.length === 0) continue;
    // An unavailable current environment retains a single source/history row so the
    // conversation and its recovery controls never disappear from navigation.
    const current =
      matching.find((shell) => shell.environmentId === placement.environmentId) ?? matching[0];
    if (current && current.environmentId !== placement.environmentId) {
      const summary = summaries.get(placement.threadId);
      const vm = summary && summary.state !== "on_machine";
      const state =
        summary?.state === "paused"
          ? "paused"
          : summary?.state === "saved"
            ? "saved workspace"
            : summary?.state === "expired"
              ? "saved workspace expired"
              : summary?.state === "preparing"
                ? "preparing"
                : "unavailable";
      fallback.set(current, {
        environmentId: EnvironmentId.make(placement.environmentId),
        generation: placement.generation,
        label: `${vm ? "Private VM" : "Current machine"} · ${state}`,
        machine: vm ? "cloud" : "server",
      });
    }
    for (const shell of matching) if (shell !== current) hidden.add(shell);
  }
  return hidden.size === 0 && fallback.size === 0
    ? shells
    : shells.flatMap((shell) => {
        if (hidden.has(shell)) return [];
        const portableLocation = fallback.get(shell);
        return [portableLocation ? { ...shell, portableLocation } : shell];
      });
}

export function createPortableThreadPresentationAtom(input: {
  readonly shellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly relayUrl: () => string | null;
  readonly indexLoadedAtom?: Atom.Atom<unknown>;
}) {
  return Atom.make((get) => {
    if (input.indexLoadedAtom) get(input.indexLoadedAtom);
    const shells = get(input.shellsAtom);
    const proofs = get(portableThreadPlacementsAtom);
    const relayUrl = input.relayUrl();
    return proofs?.session === get(managedRelaySessionAtom) &&
      relayUrl &&
      normalizeSecureRelayUrl(proofs.relayUrl) === normalizeSecureRelayUrl(relayUrl)
      ? selectPortableThreadPresentation(shells, proofs.placements, relayUrl, proofs.summaries)
      : shells;
  }).pipe(Atom.withLabel("portable-thread-navigation"));
}

/** Shared guard for every client path that creates a new thread. */
export function canCreateThreadInEnvironment(
  config:
    | { readonly environment: { readonly threadVm?: { readonly threadId: ThreadId } } }
    | null
    | undefined,
): boolean {
  return config?.environment.threadVm === undefined;
}

/** Only routing and queue changes invalidate placement; streamed text and titles do not. */
export function portableThreadRoutingFingerprint(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): string {
  return JSON.stringify(
    shells
      .map((shell) => [
        shell.environmentId,
        shell.id,
        shell.relayRouting?.relayUrl,
        shell.relayRouting?.generation,
        shell.relayRouting?.phase,
        shell.promptQueueSummary,
      ])
      .sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])),
      ),
  );
}

/** One client-owned index refresh, shared by web and mobile, without polling the full library. */
export function createPortableThreadNavigationRefreshAtom<R, E>(
  runtime: Atom.AtomRuntime<R, E>,
  library: Pick<
    ReturnType<typeof createPortableThreadLibraryAtoms<R, E>>,
    "refreshIndex" | "refreshPlacement"
  >,
  input: {
    readonly shellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
    readonly catalogAtom: Atom.Atom<EnvironmentCatalogState>;
    readonly connectionStateAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<
      import("effect/unstable/reactivity/AsyncResult").AsyncResult<
        SupervisorConnectionState,
        unknown
      >
    >;
    readonly relayUrl: () => string | null;
  },
) {
  const routingAtom = Atom.make((get) => portableThreadRoutingFingerprint(get(input.shellsAtom)));
  const connectionsAtom = Atom.make((get) =>
    JSON.stringify(
      [...get(input.catalogAtom).entries]
        .map(([id, entry]) => {
          const state = get(input.connectionStateAtom(id));
          return [
            id,
            entry.enabled,
            state._tag === "Success" ? state.value.generation : null,
            state._tag === "Success" ? state.value.phase : null,
          ];
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
  const wakeupAtom = runtime.atom(
    Stream.unwrap(
      Effect.gen(function* () {
        const wakeups = yield* Effect.serviceOption(ConnectionWakeups);
        const connectivity = yield* Effect.serviceOption(Connectivity);
        return Stream.merge(
          Option.isSome(wakeups)
            ? wakeups.value.changes.pipe(
                Stream.filter(isApplicationActiveWakeup),
                Stream.map(() => ({})),
              )
            : Stream.empty,
          Option.isSome(connectivity)
            ? connectivity.value.changes.pipe(
                Stream.changes,
                Stream.filter((value) => value !== "offline"),
                Stream.map(() => ({})),
              )
            : Stream.empty,
        );
      }),
    ),
  );
  const movingQueryAtom = Atom.family((threadId: ThreadId) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom);
          if (!session || !input.relayUrl()) return;
          const registry = yield* AtomRegistry.AtomRegistry;
          yield* Effect.promise(() => library.refreshPlacement.run(registry, { threadId }));
        }),
      )
      .pipe(Atom.withRefresh(1500), Atom.setIdleTTL(0)),
  );
  const trackingAtom = Atom.make((get) => {
    const scope = get(portableThreadPlacementsAtom);
    if (
      scope?.session !== get(managedRelaySessionAtom) ||
      scope?.relayUrl !== normalizeSecureRelayUrl(input.relayUrl() ?? "")
    )
      return;
    for (const placement of scope.placements.values())
      if (placement.operationId !== null) get(movingQueryAtom(ThreadId.make(placement.threadId)));
  });
  return Atom.make((get) => {
    const registry = get.registry;
    let active = true;
    const refresh = () => {
      if (active && registry.get(managedRelaySessionAtom) && input.relayUrl())
        void library.refreshIndex.run(registry, undefined);
    };
    let previous = registry.get(portableThreadPlacementsAtom);
    get.subscribe(portableThreadPlacementsAtom, (proofs) => {
      const sameScope =
        previous?.session === proofs?.session && previous?.relayUrl === proofs?.relayUrl;
      const needsSummary =
        proofs?.session === registry.get(managedRelaySessionAtom) &&
        proofs.relayUrl === normalizeSecureRelayUrl(input.relayUrl() ?? "") &&
        [...proofs.placements.values()].some((placement) => {
          const prior = sameScope ? previous?.placements.get(placement.threadId) : undefined;
          return (
            placement.operationId === null &&
            !proofs.summaries.has(placement.threadId) &&
            (!prior ||
              prior.operationId !== null ||
              prior.generation !== placement.generation ||
              prior.environmentId !== placement.environmentId)
          );
        });
      previous = proofs;
      // Any authenticated writer can confirm cutover. Fetch its VM summary once,
      // even if that confirmation stops the targeted tracker before its next read.
      if (needsSummary) refresh();
    });
    get.subscribe(managedRelaySessionAtom, refresh);
    get.subscribe(runtime, refresh);
    get.subscribe(routingAtom, refresh);
    get.subscribe(connectionsAtom, refresh);
    get.subscribe(wakeupAtom, (result) => {
      if (result._tag === "Success") refresh();
    });
    get.mount(trackingAtom);
    get.mount(routingAtom);
    get.mount(connectionsAtom);
    get.mount(wakeupAtom);
    get.addFinalizer(() => {
      active = false;
    });
    refresh();
  }).pipe(Atom.keepAlive);
}
