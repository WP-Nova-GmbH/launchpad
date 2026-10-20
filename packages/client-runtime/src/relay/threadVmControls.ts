import {
  EnvironmentId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type ThreadRelayRouting,
  type ProviderAuthState,
  type OrchestrationThread,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { RelayThreadVmPreviewPort } from "@t3tools/contracts/relay";
import type {
  RelayThreadVmStatus,
  RelayThreadVmResetRequest,
  RelayThreadVmRestoreRequest,
  RelayThreadVmBackupRecoveryRequest,
  RelayThreadDeletionRequest,
  RelayThreadVmProviderAuthBinding,
  RelayThreadVmProviderAuth,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  createRuntimeCommand,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommand,
} from "../state/runtime.ts";
import type { createThreadVmActionJournal } from "./threadVmActionSubmission.ts";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import { managedRelaySessionAtom, readManagedRelaySnapshotState } from "./managedRelayState.ts";

import {
  portableThreadClientRouteAtom,
  resolvePortableThreadClientRoute,
  verifyPortableThreadClientRoute,
} from "./portableThreadLibrary.ts";

const controlKey = Schema.fromJsonString(Schema.Tuple([EnvironmentId, ThreadId]));
const encodeKey = Schema.encodeSync(controlKey);
const decodeKey = Schema.decodeSync(controlKey);
const decodePreviewPort = Schema.decodeUnknownEffect(RelayThreadVmPreviewPort);
const inFlightMove = (queue: ThreadPromptQueue | undefined) =>
  queue?.entries.some(
    (entry) =>
      entry.kind === "move" && entry.state !== "pending" && entry.operationId !== undefined,
  ) === true;

export const THREAD_DELETE_WARNING =
  "This permanently deletes conversation history and attachments. Any dedicated VM and saved workspaces are also deleted. Work stored only in the VM is lost. Archive the thread to keep it.";

export function threadVmBackupRecoveryUnavailable(reason: string | null | undefined) {
  switch (reason) {
    case "operation_in_progress":
      return "Another VM operation is still in progress. Wait for it to finish before checking again.";
    case "capture_time_unknown":
      return "This older backup has no confirmed capture time, so it cannot be selected for recovery.";
    case "conversation_unavailable":
      return "The conversation or its attachments are not completely saved. Recovery is unavailable; the existing data is kept.";
    default:
      return "No complete recovery backup is available. The existing VM data is kept.";
  }
}

/** Fresh VMs use Codex's own device sign-in while their workspace remains fenced. */
export function threadVmProviderAuthPresentation(value: {
  readonly requirement: "sign_in_required" | "authenticated" | "provider_unavailable";
  readonly auth: ProviderAuthState;
}) {
  const { auth, requirement } = value;
  const active = ["starting", "waiting", "verifying"].includes(auth.phase);
  const finished = requirement === "authenticated" || auth.phase === "succeeded";
  const interaction = auth.interaction;
  const candidate =
    interaction?.type === "deviceCode" || interaction?.type === "browser"
      ? interaction.url
      : auth.authorizationUrl;
  let url: string | null = null;
  if (candidate && active && !finished && requirement === "sign_in_required") {
    try {
      const parsed = new URL(candidate);
      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        ["chatgpt.com", "openai.com"].some(
          (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
        )
      )
        url = parsed.toString();
    } catch {
      /* A malformed provider link cannot be opened. */
    }
  }
  const message =
    requirement === "provider_unavailable"
      ? (auth.message ??
        "This VM needs the supported Codex version before preparation can continue.")
      : finished
        ? "Signed in to Codex. The VM is finishing preparation."
        : auth.phase === "failed"
          ? (auth.message ?? "Codex sign-in failed. Try again to continue preparing this VM.")
          : auth.phase === "cancelled"
            ? "Sign-in was cancelled. The VM is still waiting; sign in again to continue."
            : auth.phase === "starting"
              ? "Starting Codex sign-in…"
              : auth.phase === "verifying"
                ? "Checking your Codex sign-in…"
                : auth.phase === "waiting"
                  ? "Finish signing in on Codex’s sign-in page. The VM will continue automatically."
                  : "Sign in to Codex for this VM. Preparation continues when sign-in finishes.";
  return {
    title:
      requirement === "provider_unavailable"
        ? "Codex needs attention"
        : finished
          ? "Codex signed in"
          : auth.phase === "cancelled"
            ? "Codex sign-in cancelled"
            : "Codex sign-in needed",
    message,
    url,
    userCode:
      url && active && !finished && interaction?.type === "deviceCode"
        ? interaction.userCode
        : null,
    canStart: requirement === "sign_in_required" && !active && !finished,
    canCancel: active && !finished && auth.flowId !== null,
    startLabel:
      auth.phase === "failed" || auth.phase === "cancelled"
        ? "Retry Codex sign-in"
        : "Sign in to Codex",
  };
}

/** Sidebar and keybinding deletion use the same durable lifecycle request as the VM controls. */
export function withPortableThreadDeletion<
  W extends {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  },
  A,
  E,
  D,
  DE,
>(
  local: AtomCommand<W, A, E>,
  action: AtomCommand<
    {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      action: ThreadVmControlAction;
      accountId?: string;
      relayUrl?: string;
    },
    D,
    DE
  >,
  journal: ReturnType<typeof createThreadVmActionJournal>,
  routeAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<ThreadRelayRouting | null>,
  operationId: () => string,
): AtomCommand<W, A | D, E> {
  return {
    label: local.label,
    run: async (registry: AtomRegistry.AtomRegistry, input: W) => {
      const threadId = input.input.threadId,
        route = registry.get(routeAtom(input.environmentId, threadId));
      if (!route) return local.run(registry, input);
      return settlePromise(async () => {
        const session = registry.get(managedRelaySessionAtom);
        if (!session) throw new Error("Sign in to Launchpad Connect before deleting this thread.");
        const scope = { accountId: session.accountId, relayUrl: route.relayUrl },
          saved = await journal.prepare(scope, {
            environmentId: input.environmentId,
            threadId,
            action: {
              type: "delete",
              payload: {
                operationId: operationId(),
                expectedGeneration: route.generation,
                confirmWorkspaceLoss: true,
              },
            },
          });
        if (registry.get(managedRelaySessionAtom) !== session)
          throw new Error("Your account changed. The deletion remains saved.");
        const result = await action.run(registry, { ...saved, ...scope });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (registry.get(managedRelaySessionAtom) !== session)
          throw new Error("Your account changed. Check the saved deletion before retrying.");
        await journal.acknowledge(scope, saved, result.value);
        return result.value;
      });
    },
  };
}

export type ThreadVmControlAction =
  | { readonly type: "resume" | "cancel_setup" }
  | { readonly type: "restore"; readonly payload: RelayThreadVmRestoreRequest }
  | { readonly type: "restore_backup"; readonly payload: RelayThreadVmBackupRecoveryRequest }
  | {
      readonly type: "cancel_backup_recovery";
      readonly payload: RelayThreadVmBackupRecoveryRequest;
    }
  | { readonly type: "reset"; readonly payload: RelayThreadVmResetRequest }
  | { readonly type: "cancel_restore" | "cancel_reset"; readonly operationId: string }
  | {
      readonly type: "select_replacement";
      readonly requestId: string;
      readonly victimAllocationId: string;
    }
  | { readonly type: "cancel_replacement"; readonly requestId: string }
  | { readonly type: "delete"; readonly payload: RelayThreadDeletionRequest };

/** Presentation depends on confirmed relay state, never a speculative local power state. */
export function threadVmStatusLabel(status: RelayThreadVmStatus) {
  if (status.pendingProviderAuth) return "Preparing VM — checking Codex sign-in";
  if (status.replacement?.phase === "awaiting_choice") return "VM limit reached";
  if (status.replacement?.phase === "waiting") return "Saving the selected VM before replacement";
  if (status.finalSave)
    return status.finalSave.phase === "deleting"
      ? "Stopping VM after saving"
      : "Saving VM workspace";
  if (status.reset) return "Resetting VM — queue will remain paused";
  if (status.restore) {
    switch (status.restore.recoveryStage) {
      case "saving_history":
        return "Saving conversation for recovery";
      case "retaining_source":
        return "Preserving the previous VM";
      case "stopping_source":
        return "Stopping the previous VM";
    }
    switch (status.restore.phase) {
      case "pending":
        return "Waiting to restore VM";
      case "preparing":
      case "prepared":
        return "Checking saved workspace";
      case "boot_preparing":
      case "boot_prepared":
        return "Preparing replacement VM";
      case "committed":
      case "booted":
        return "Starting replacement VM";
      case "importing":
        return "Restoring conversation — queue stays paused";
      case "aborting":
        return "Cancelling VM restore";
      default:
        return "Restoring saved VM";
    }
  }
  if (status.resumePhase && status.resumePhase !== "completed") return "Waiting to resume VM";
  if (status.pausePhase === "pending" || status.pausePhase === "sealed") return "Pausing VM";
  if (status.savedDisk?.phase === "expired") return "Saved workspace expired";
  if (status.savedDisk?.phase === "expiring") return "Saved workspace is expiring";
  if (status.savedDisk) return "VM stopped — workspace saved";
  if (status.setupPhase === "failed") return "VM setup needs attention";
  if (status.capacityState === "waiting") return "Waiting for VM capacity";
  if (
    status.allocation?.state === "creating" ||
    status.setupPhase === "pending" ||
    status.setupPhase === "running"
  )
    return "Preparing VM";
  if (status.allocation?.state === "paused") return "VM paused";
  if (status.allocation?.state === "deleting") return "Stopping VM";
  return status.activity === "busy" ? "VM working" : "VM running";
}

/** Only mounted thread views refresh. All reads are relay-only and never wake compute. */
export function createThreadVmControlAtoms<R, E, AE = never>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
  savedRouteAtom?: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<ThreadRelayRouting | null>,
  cachedArchivedSnapshotAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, AE>>,
  threadDetailAtom?: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<Pick<OrchestrationThread, "promptQueue"> | null>,
) {
  const keyFor = (environmentId: EnvironmentId, threadId: ThreadId) =>
    encodeKey([environmentId, threadId]);
  const deletionAtom = Atom.family((_key: string) =>
    Atom.make<{ accountId: string; operationId: string } | null>(null).pipe(Atom.keepAlive),
  );
  const routeAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, threadId] = decodeKey(key);
      return resolvePortableThreadClientRoute(
        get(snapshotAtom(environmentId))?.threads.find((thread) => thread.id === threadId)
          ?.relayRouting ??
          (savedRouteAtom ? get(savedRouteAtom(environmentId, threadId)) : null) ??
          (cachedArchivedSnapshotAtom
            ? Option.getOrNull(
                AsyncResult.value(get(cachedArchivedSnapshotAtom(environmentId))),
              )?.threads.find((thread) => thread.id === threadId)?.relayRouting
            : null) ??
          null,
        get(portableThreadClientRouteAtom(environmentId, threadId)),
      );
    }).pipe(
      Atom.withEquality<ThreadRelayRouting | null>(
        (a, b) =>
          a?.relayUrl === b?.relayUrl && a?.generation === b?.generation && a?.phase === b?.phase,
      ),
    ),
  );
  const authorize = Effect.fnUntraced(function* (
    registry: AtomRegistry.AtomRegistry,
    key: string,
    expectedAccount?: string,
    recoveryRelay?: string,
  ) {
    const session = registry.get(managedRelaySessionAtom),
      route = registry.get(routeAtom(key)) ?? (recoveryRelay ? { relayUrl: recoveryRelay } : null),
      relay = yield* ManagedRelayTenancyClient;
    if (
      !session ||
      (expectedAccount !== undefined && session.accountId !== expectedAccount) ||
      !route ||
      !normalizeSecureRelayUrl(relay.relayUrl) ||
      normalizeSecureRelayUrl(route.relayUrl) !== normalizeSecureRelayUrl(relay.relayUrl)
    )
      return yield* new OrchestrationDispatchCommandError({
        message: "Connect to this thread’s Launchpad Connect account first.",
      });
    const clerkToken = yield* session.readClerkToken();
    if (!clerkToken || registry.get(managedRelaySessionAtom) !== session)
      return yield* new OrchestrationDispatchCommandError({
        message: "Sign in again before changing this VM.",
      });
    return { relay, clerkToken, session };
  });
  const bootstrapKey = Schema.fromJsonString(
    Schema.Tuple([EnvironmentId, ThreadId, Schema.Number]),
  );
  const encodeBootstrapKey = Schema.encodeSync(bootstrapKey),
    decodeBootstrapKey = Schema.decodeSync(bootstrapKey);
  // Keep failures for this identity too: normal status polling must not retry account discovery.
  const bootstrapAtom = Atom.family((key: string) => {
    const [environmentId, threadId, generation] = decodeBootstrapKey(key);
    return runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom);
          if (!session) return;
          const registry = yield* AtomRegistry.AtomRegistry;
          yield* verifyPortableThreadClientRoute(registry, {
            environmentId,
            threadId,
            generation,
            session,
          });
        }),
      )
      .pipe(Atom.keepAlive);
  });
  const queryAtom = Atom.family((key: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom),
            route = get(routeAtom(key)),
            deletion = get(deletionAtom(key));
          if (!session || !route) return null;
          const registry = yield* AtomRegistry.AtomRegistry;
          const [environmentId, threadId] = decodeKey(key);
          const configuredRelay = yield* ManagedRelayTenancyClient;
          const verified = get(portableThreadClientRouteAtom(environmentId, threadId));
          if (
            (verified?.generation !== route.generation ||
              normalizeSecureRelayUrl(verified.relayUrl) !==
                normalizeSecureRelayUrl(configuredRelay.relayUrl)) &&
            normalizeSecureRelayUrl(route.relayUrl) !==
              normalizeSecureRelayUrl(configuredRelay.relayUrl)
          )
            yield* get.result(
              bootstrapAtom(encodeBootstrapKey([environmentId, threadId, route.generation])),
              { suspendOnWaiting: true },
            );
          const { relay, clerkToken } = yield* authorize(registry, key);
          if (deletion?.accountId === session.accountId) {
            const receipt = yield* relay.getThreadDeletion({ clerkToken, threadId });
            if (registry.get(managedRelaySessionAtom) !== session) return null;
            return { status: null, candidates: [], deletion: receipt };
          }
          const status = yield* relay.getThreadVmStatus({ clerkToken, threadId });
          const candidates =
            status.replacement?.phase === "awaiting_choice"
              ? yield* relay.getThreadVmReplacementCandidates({
                  clerkToken,
                  requestId: status.replacement.requestId,
                })
              : [];
          if (registry.get(managedRelaySessionAtom) !== session) return null;
          return { status, candidates, deletion: null };
        }),
      )
      .pipe(Atom.withRefresh(15_000), Atom.setIdleTTL(0)),
  );
  const pendingAuthBinding = (registry: AtomRegistry.AtomRegistry, key: string) =>
    readManagedRelaySnapshotState(registry.get(queryAtom(key))).data?.status?.pendingProviderAuth ??
    null;
  const sameAuthBinding = (
    a: RelayThreadVmProviderAuthBinding,
    b: RelayThreadVmProviderAuthBinding,
  ) =>
    a.operationId === b.operationId &&
    a.allocationId === b.allocationId &&
    a.environmentId === b.environmentId &&
    a.generation === b.generation &&
    a.instanceId === b.instanceId;
  const validateAuthBinding = (
    binding: RelayThreadVmProviderAuthBinding,
    reply: RelayThreadVmProviderAuth | null,
  ) => {
    if (reply && (!sameAuthBinding(binding, reply) || reply.auth.instanceId !== binding.instanceId))
      return Effect.fail(
        new OrchestrationDispatchCommandError({
          message: "The VM sign-in belongs to a different preparation. Refresh this thread.",
        }),
      );
    return Effect.succeed(reply);
  };
  const providerAuthQueryAtom = Atom.family((key: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom),
            binding = readManagedRelaySnapshotState(get(queryAtom(key))).data?.status
              ?.pendingProviderAuth;
          if (!session || !binding) return null;
          const registry = yield* AtomRegistry.AtomRegistry;
          const { relay, clerkToken } = yield* authorize(registry, key);
          const [, threadId] = decodeKey(key);
          const reply = yield* relay.getThreadVmProviderAuth({ clerkToken, threadId });
          const current = pendingAuthBinding(registry, key);
          if (
            registry.get(managedRelaySessionAtom) !== session ||
            !current ||
            !sameAuthBinding(binding, current)
          )
            return null;
          yield* validateAuthBinding(binding, reply);
          // AsyncResult retains the previous value during refresh; never show its code to a new account.
          return reply ? { ...reply, accountId: session.accountId } : null;
        }),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const providerAuthRefreshingAtom = Atom.family((key: string) =>
    providerAuthQueryAtom(key).pipe(Atom.withRefresh(2_000), Atom.setIdleTTL(0)),
  );
  const providerAuthPollAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const query = providerAuthQueryAtom(key),
        result = get(query);
      const value = readManagedRelaySnapshotState(result).data;
      if (
        value &&
        value.requirement === "sign_in_required" &&
        ["starting", "waiting", "verifying"].includes(value.auth.phase)
      ) {
        return get(providerAuthRefreshingAtom(key));
      }
      return result;
    }).pipe(Atom.setIdleTTL(0)),
  );
  const locationQueryAtom = Atom.family((key: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom),
            route = get(routeAtom(key));
          if (!session || !route) return null;
          const [environmentId, threadId] = decodeKey(key);
          const queue = threadDetailAtom
            ? get(threadDetailAtom(environmentId, threadId))?.promptQueue
            : undefined;
          if (route.phase === "active" && !inFlightMove(queue)) return null;
          const registry = yield* AtomRegistry.AtomRegistry;
          const { relay, clerkToken } = yield* authorize(registry, key);
          const placement = yield* relay.getPortableThreadPlacement({ clerkToken, threadId });
          if (
            registry.get(managedRelaySessionAtom) !== session ||
            registry.get(routeAtom(key))?.generation !== route.generation
          )
            return null;
          return { session, placement };
        }),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const movingLocationQueryAtom = Atom.family((key: string) =>
    locationQueryAtom(key).pipe(Atom.withRefresh(2_000), Atom.setIdleTTL(0)),
  );
  // A fresh pairing may have no snapshot of the retired source. Only unavailable
  // routes opt into this single read; the configured relay authorizes the thread.
  const unavailableLocationQueryAtom = Atom.family((key: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const session = get(managedRelaySessionAtom);
          if (!session) return null;
          const registry = yield* AtomRegistry.AtomRegistry;
          const configuredRelay = yield* ManagedRelayTenancyClient;
          const { relay, clerkToken } = yield* authorize(
            registry,
            key,
            session.accountId,
            configuredRelay.relayUrl,
          );
          const [, threadId] = decodeKey(key);
          const placement = yield* relay.getPortableThreadPlacement({ clerkToken, threadId });
          if (registry.get(managedRelaySessionAtom) !== session) return null;
          return { session, placement };
        }),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const unavailableLocationViewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const session = get(managedRelaySessionAtom);
      if (!session) return null;
      const [, threadId] = decodeKey(key);
      const state = readManagedRelaySnapshotState(get(unavailableLocationQueryAtom(key)));
      const value = state.data?.session === session ? state.data.placement : null;
      return {
        accountId: session.accountId,
        error: state.error,
        isPending: state.isPending,
        movePending: value?.operationId != null,
        destination:
          !state.error && value?.threadId === threadId && value.operationId === null
            ? {
                environmentId: EnvironmentId.make(value.environmentId),
                threadId,
                generation: value.generation,
              }
            : null,
      };
    }).pipe(Atom.setIdleTTL(0)),
  );
  // The retired source can disconnect before publishing its final snapshot.
  // Follow relay ownership instead of waiting for another source socket event.
  const locationViewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const session = get(managedRelaySessionAtom),
        route = get(routeAtom(key));
      if (!session || !route) return null;
      const [environmentId, threadId] = decodeKey(key);
      const queue = threadDetailAtom
        ? get(threadDetailAtom(environmentId, threadId))?.promptQueue
        : undefined;
      if (route.phase === "active" && !inFlightMove(queue)) return null;
      const initial = readManagedRelaySnapshotState(get(locationQueryAtom(key)));
      const current = initial.data?.session === session ? initial.data.placement : null;
      // A claimed queue move can precede relay admission. Keep following its
      // source until cutover; stop on confirmation, cancellation or access failure.
      const state =
        current &&
        !initial.error &&
        (current.operationId !== null ||
          (inFlightMove(queue) &&
            current.environmentId === environmentId &&
            current.generation === route.generation))
          ? readManagedRelaySnapshotState(get(movingLocationQueryAtom(key)))
          : initial;
      const value = state.data?.session === session ? state.data.placement : null;
      return {
        accountId: session.accountId,
        error: state.error,
        isPending: state.isPending,
        movePending: value?.operationId != null,
        destination:
          !state.error &&
          value?.threadId === threadId &&
          value.operationId === null &&
          value.generation > route.generation &&
          value.environmentId !== environmentId
            ? {
                environmentId: EnvironmentId.make(value.environmentId),
                threadId,
                generation: value.generation,
              }
            : null,
      };
    }).pipe(Atom.setIdleTTL(0)),
  );
  const viewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const session = get(managedRelaySessionAtom),
        route = get(routeAtom(key));
      if (!session || !route) return null;
      const state = readManagedRelaySnapshotState(get(queryAtom(key)));
      const providerAuth = state.data?.status?.pendingProviderAuth
        ? readManagedRelaySnapshotState(get(providerAuthPollAtom(key)))
        : null;
      const authValue = providerAuth?.data;
      const binding = state.data?.status?.pendingProviderAuth;
      return {
        ...state,
        providerAuth:
          authValue &&
          binding &&
          authValue.accountId === session.accountId &&
          sameAuthBinding(binding, authValue)
            ? authValue
            : null,
        providerAuthError: providerAuth?.error ?? null,
        providerAuthPending: providerAuth?.isPending ?? false,
        accountId: session.accountId,
      };
    }).pipe(Atom.setIdleTTL(0)),
  );
  const action = createRuntimeCommand(runtime, {
    label: "thread VM action",
    concurrency: {
      mode: "serial",
      key: (input: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        action: ThreadVmControlAction;
        accountId?: string;
        relayUrl?: string;
      }) => keyFor(input.environmentId, input.threadId),
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const key = keyFor(input.environmentId, input.threadId),
        { relay, clerkToken, session } = yield* authorize(
          registry,
          key,
          input.accountId,
          input.accountId ? input.relayUrl : undefined,
        );
      const auth = { clerkToken, threadId: input.threadId };
      const value = input.action;
      const result = yield* Effect.gen(function* () {
        switch (value.type) {
          case "resume":
            return yield* relay.resumeThreadVm(auth);
          case "cancel_setup":
            return yield* relay.cancelThreadVmSetup(auth);
          case "restore":
            return yield* relay.restoreThreadVm({ ...auth, payload: value.payload });
          case "restore_backup":
            return yield* relay.restoreThreadVmBackup({ ...auth, payload: value.payload });
          case "cancel_backup_recovery":
            return yield* relay.cancelThreadVmBackupRecovery({ ...auth, payload: value.payload });
          case "reset":
            return yield* relay.resetThreadVm({ ...auth, payload: value.payload });
          case "cancel_restore":
            return yield* relay.cancelThreadVmRestore({ ...auth, operationId: value.operationId });
          case "cancel_reset":
            return yield* relay.cancelThreadVmReset({ ...auth, operationId: value.operationId });
          case "select_replacement":
            return yield* relay.selectThreadVmReplacement({
              clerkToken,
              requestId: value.requestId,
              victimAllocationId: value.victimAllocationId,
            });
          case "cancel_replacement":
            return yield* relay.cancelThreadVmReplacement({
              clerkToken,
              requestId: value.requestId,
            });
          case "delete":
            return yield* relay.permanentlyDeleteThread({ ...auth, payload: value.payload });
        }
      });
      if (registry.get(managedRelaySessionAtom) === session) {
        if (value.type === "delete")
          registry.set(deletionAtom(key), {
            accountId: session.accountId,
            operationId: value.payload.operationId,
          });
        registry.refresh(queryAtom(key));
      }
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. Check the saved request before retrying.",
        });
      return result;
    }),
  });
  const checkBackupRecovery = createRuntimeCommand(runtime, {
    label: "check VM backup recovery",
    execute: Effect.fnUntraced(function* (
      input: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        accountId: string;
        expectedGeneration: number;
        sourceAllocationId: string;
      },
      registry,
    ) {
      const key = keyFor(input.environmentId, input.threadId),
        { relay, clerkToken, session } = yield* authorize(registry, key, input.accountId);
      const candidate = yield* relay.getThreadVmBackupRecovery({
        clerkToken,
        threadId: input.threadId,
      });
      if (
        registry.get(managedRelaySessionAtom) !== session ||
        registry.get(routeAtom(key))?.generation !== input.expectedGeneration ||
        (candidate &&
          (candidate.threadId !== input.threadId ||
            candidate.generation !== input.expectedGeneration ||
            candidate.sourceAllocationId !== input.sourceAllocationId))
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account or VM changed. Check the backup again.",
        });
      return candidate;
    }),
  });
  const openPreview = createRuntimeCommand(runtime, {
    label: "open private VM preview",
    execute: Effect.fnUntraced(function* (
      input: { environmentId: EnvironmentId; threadId: ThreadId; port: number },
      registry,
    ) {
      const port = yield* decodePreviewPort(input.port),
        { relay, clerkToken, session } = yield* authorize(
          registry,
          keyFor(input.environmentId, input.threadId),
        );
      const link = yield* relay.openThreadVmPreview({ clerkToken, threadId: input.threadId, port });
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "The signed-in account changed before the preview opened.",
        });
      return link;
    }),
  });
  const providerAuthAction = createRuntimeCommand(runtime, {
    label: "VM Codex sign-in",
    concurrency: {
      mode: "serial",
      key: (input: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        accountId: string;
        binding: RelayThreadVmProviderAuthBinding;
        action: { type: "start" | "refresh" } | { type: "cancel"; flowId: string };
      }) => keyFor(input.environmentId, input.threadId),
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const key = keyFor(input.environmentId, input.threadId),
        current = pendingAuthBinding(registry, key);
      if (!current || !sameAuthBinding(current, input.binding))
        return yield* new OrchestrationDispatchCommandError({
          message: "VM preparation changed. Refresh before signing in.",
        });
      const { relay, clerkToken, session } = yield* authorize(registry, key, input.accountId);
      const auth = { clerkToken, threadId: input.threadId },
        payload = {
          operationId: current.operationId,
          allocationId: current.allocationId,
          generation: current.generation,
        };
      const request =
        input.action.type === "start"
          ? relay.startThreadVmProviderAuth({ ...auth, payload })
          : input.action.type === "cancel"
            ? relay.cancelThreadVmProviderAuth({
                ...auth,
                payload: { ...payload, flowId: input.action.flowId },
              })
            : relay.getThreadVmProviderAuth(auth);
      const reply = yield* request.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            registry.refresh(providerAuthQueryAtom(key));
            registry.refresh(queryAtom(key));
          }),
        ),
      );
      const latest = pendingAuthBinding(registry, key);
      if (
        registry.get(managedRelaySessionAtom) !== session ||
        !latest ||
        !sameAuthBinding(latest, current)
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account or VM preparation changed. Refresh the thread.",
        });
      yield* validateAuthBinding(current, reply);
      return reply;
    }),
  });
  return {
    refresh(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId, threadId: ThreadId) {
      const key = keyFor(environmentId, threadId),
        route = registry.get(routeAtom(key));
      if (route)
        registry.refresh(
          bootstrapAtom(encodeBootstrapKey([environmentId, threadId, route.generation])),
        );
      registry.refresh(queryAtom(key));
      registry.refresh(providerAuthQueryAtom(key));
      registry.refresh(locationQueryAtom(key));
      registry.refresh(unavailableLocationQueryAtom(key));
    },
    action,
    checkBackupRecovery,
    openPreview,
    providerAuthAction,
    providerAuthQueryAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      providerAuthQueryAtom(keyFor(environmentId, threadId)),
    locationQueryAtom: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      recoverUnavailable = false,
    ) =>
      (recoverUnavailable ? unavailableLocationQueryAtom : locationQueryAtom)(
        keyFor(environmentId, threadId),
      ),
    locationViewAtom: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      recoverUnavailable = false,
    ) =>
      (recoverUnavailable ? unavailableLocationViewAtom : locationViewAtom)(
        keyFor(environmentId, threadId),
      ),
    routeAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      routeAtom(keyFor(environmentId, threadId)),
    queryAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      queryAtom(keyFor(environmentId, threadId)),
    viewAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      viewAtom(keyFor(environmentId, threadId)),
  };
}
