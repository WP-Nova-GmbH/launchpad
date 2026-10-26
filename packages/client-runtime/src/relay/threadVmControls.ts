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
  RelayPortableThreadPlacement,
  ThreadVmCapabilities,
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
import {
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  type ManagedRelaySession,
} from "./managedRelayState.ts";

import {
  portableThreadClientRouteAtom,
  resolvePortableThreadClientRoute,
  verifyPortableThreadClientRoute,
} from "./portableThreadLibrary.ts";

import {
  beginPortableThreadPlacementRead,
  isPortableThreadPlacementReadCurrent,
  rememberPortableThreadPlacement,
  portableThreadPlacementsAtom,
} from "./portableThreadPresentation.ts";

const controlKey = Schema.fromJsonString(Schema.Tuple([EnvironmentId, ThreadId]));
const encodeKey = Schema.encodeSync(controlKey);
const decodeKey = Schema.decodeSync(controlKey);
const decodePreviewPort = Schema.decodeUnknownEffect(RelayThreadVmPreviewPort);
const inFlightMove = (queue: ThreadPromptQueue | undefined) =>
  queue?.entries.some(
    (entry) =>
      entry.kind === "move" && entry.state !== "pending" && entry.operationId !== undefined,
  ) === true;
const moveFailureDetail = (
  placement: RelayPortableThreadPlacement | null,
  queue?: ThreadPromptQueue,
) =>
  placement?.operationId != null &&
  !queue?.entries.some(
    (entry) =>
      entry.kind === "move" &&
      entry.operationId !== undefined &&
      entry.operationId !== placement.operationId,
  )
    ? (placement.moveFailureDetail ?? null)
    : null;

export const THREAD_DELETE_WARNING =
  "This permanently deletes conversation history and attachments. Any dedicated VM and saved workspaces are also deleted. Work stored only in the VM is lost. Archive the thread to keep it.";

function threadVmHostUnavailableReason(state: {
  readonly data: boolean | null;
  readonly isPending: boolean;
  readonly error: string | null;
}) {
  if (state.isPending) return "Checking VM host…";
  if (state.error) return "Could not check VM host. Reopen Run on to retry.";
  return state.data === true ? null : "VM host not configured";
}

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
export function threadVmProviderAuthPresentation(
  value: {
    readonly requirement: "sign_in_required" | "authenticated" | "provider_unavailable";
    readonly auth: ProviderAuthState;
  },
  now?: number,
) {
  const { auth, requirement } = value;
  const expiresAt = auth.expiresAt === null ? null : Date.parse(auth.expiresAt);
  const expired =
    expiresAt !== null && (now === undefined || !Number.isFinite(expiresAt) || expiresAt <= now);
  const active = !expired && ["starting", "waiting", "verifying"].includes(auth.phase);
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
        "This VM needs an installed and configured Codex provider before preparation can continue.")
      : finished
        ? "Signed in to Codex. The VM is finishing preparation."
        : expired
          ? "This Codex sign-in code expired. Start sign-in again to get a new code."
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
          : expired
            ? "Codex sign-in expired"
            : auth.phase === "cancelled"
              ? "Codex sign-in cancelled"
              : "Codex sign-in needed",
    message,
    expired,
    url,
    userCode:
      url && active && !finished && interaction?.type === "deviceCode"
        ? interaction.userCode
        : null,
    canStart: requirement === "sign_in_required" && !active && !finished,
    canCancel: active && !finished && auth.flowId !== null,
    startLabel:
      expired || auth.phase === "failed" || auth.phase === "cancelled"
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
  if (status.restore?.errorCode) return "VM restore needs attention";
  if (status.reset?.errorCode) return "VM reset needs attention";
  if (status.finalSave?.errorCode) return "Saving VM needs attention";
  if (status.setupPhase === "failed" && !status.pendingProviderAuth)
    return "VM setup needs attention";
  if (status.pendingProviderAuth) return "Sign in to Codex";
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
  if (status.resumePhase && status.resumePhase !== "completed") return "Resume requested";
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
  if (status.allocation?.state === "running" && status.setupPhase === "ready")
    return status.activity === "busy" ? "VM working" : "VM ready";
  return "VM status unavailable";
}

export type ThreadVmPrimaryAction =
  | "resume"
  | "restore"
  | "reset"
  | "sign_in"
  | "replace"
  | "cancel_setup"
  | "cancel_restore"
  | "cancel_reset"
  | "check";

/** Numeric policy values do not enable relay workers. */
export function threadVmCapabilityLabel(
  capabilities: ThreadVmCapabilities | null,
  capability: keyof ThreadVmCapabilities,
) {
  return capabilities === null
    ? "Status unknown"
    : capabilities[capability]
      ? "Enabled"
      : "Inactive";
}

/** A single presentation model is shared by the chat, VM overview and mobile client. */
export function threadVmPresentation(input: {
  readonly status: RelayThreadVmStatus | null;
  readonly error?: string | null;
  readonly pendingRequest?: boolean;
  readonly queuePaused?: boolean;
  readonly capabilities?: ThreadVmCapabilities | null;
  readonly providerAuth?: RelayThreadVmProviderAuth | null;
}) {
  const { status } = input;
  const held = !!(
    input.pendingRequest ||
    status?.pendingProviderAuth ||
    status?.pausePhase === "pending" ||
    status?.pausePhase === "sealed" ||
    status?.finalSave ||
    status?.restore ||
    status?.reset ||
    status?.replacement ||
    (status?.resumePhase && status.resumePhase !== "completed")
  );
  const activePause = status?.pausePhase === "pending" || status?.pausePhase === "sealed";
  const ready =
    !input.error &&
    status?.allocation?.state === "running" &&
    status.setupPhase === "ready" &&
    !held &&
    !activePause;
  const failed = !!(
    input.error ||
    (status?.pendingProviderAuth && input.providerAuth?.requirement === "provider_unavailable") ||
    status?.restore?.errorCode ||
    status?.reset?.errorCode ||
    status?.finalSave?.errorCode ||
    (status?.setupPhase === "failed" && !status.pendingProviderAuth)
  );
  const label = input.error
    ? "VM status unavailable"
    : status?.pendingProviderAuth && input.providerAuth?.requirement === "provider_unavailable"
      ? "Codex needs attention"
      : status?.pendingProviderAuth && input.providerAuth?.requirement === "authenticated"
        ? "Preparing VM"
        : status
          ? threadVmStatusLabel(status)
          : "VM status unavailable";
  let primary: { type: ThreadVmPrimaryAction; label: string } | null = null;
  if (input.error || !status) primary = { type: "check", label: "Check status" };
  else if (status.pendingProviderAuth)
    primary =
      input.providerAuth?.requirement === "authenticated"
        ? null
        : input.providerAuth?.requirement === "provider_unavailable"
          ? { type: "check", label: "Check status" }
          : {
              type: "sign_in",
              label: ["waiting", "verifying"].includes(input.providerAuth?.auth.phase ?? "")
                ? "Finish Codex sign-in"
                : "Sign in to Codex",
            };
  else if (status.replacement?.phase === "awaiting_choice")
    primary = { type: "replace", label: "Choose a VM to replace" };
  else if (
    status.restore &&
    status.restore.canCancel !== false &&
    ["pending", "preparing", "prepared", "boot_preparing", "boot_prepared"].includes(
      status.restore.phase,
    )
  )
    primary = { type: "cancel_restore", label: "Cancel restore" };
  else if (status.reset && ["pending", "creating"].includes(status.reset.phase))
    primary = { type: "cancel_reset", label: "Cancel reset" };
  else if (!held && status.setupPhase === "failed")
    primary = { type: "cancel_setup", label: "Cancel VM setup" };
  else if (!held && !activePause && status.allocation?.state === "paused")
    primary = { type: "resume", label: "Resume VM" };
  else if (!held && status.savedDisk?.phase === "available" && status.savedDisk.operationId)
    primary = { type: "restore", label: "Restore VM" };
  else if (!held && status.savedDisk?.phase === "expired" && status.repository)
    primary = { type: "reset", label: "Reset VM…" };
  else if (label === "VM status unavailable") primary = { type: "check", label: "Check status" };
  const detail =
    input.error ??
    (status?.pendingProviderAuth
      ? input.providerAuth?.requirement === "provider_unavailable"
        ? (input.providerAuth.auth.message ??
          "Codex is unavailable in this VM. Its runner needs attention before preparation can continue.")
        : input.providerAuth?.requirement === "authenticated"
          ? "Codex is signed in. VM preparation continues automatically."
          : "Sign in to Codex inside this VM. Your Launchpad Connect account is already connected."
      : status?.setupPhase === "failed" && !status.pendingProviderAuth
        ? "Preparation stopped. Cancel this setup before trying another move. Your conversation is kept."
        : status?.restore?.errorCode || status?.reset?.errorCode || status?.finalSave?.errorCode
          ? "The last step could not be confirmed. Your saved data is kept; check status or use the available cancellation."
          : status?.allocation?.state === "paused"
            ? "The conversation is available. Resume the VM when you need to continue working."
            : status?.savedDisk?.phase === "available"
              ? "The VM is stopped. Restore its saved workspace to continue."
              : status?.savedDisk?.phase === "expired"
                ? "The saved workspace expired. Reset from the original uploaded commit; the conversation is kept."
                : ready && input.queuePaused
                  ? "The VM is ready. Queued messages stay paused until you resume the queue."
                  : status?.resumePhase && status.resumePhase !== "completed"
                    ? "The relay accepted your request. Waiting for the VM to confirm it is ready."
                    : null);
  const capability =
    primary?.type === "restore"
      ? "restore"
      : primary?.type === "reset"
        ? "reset"
        : primary?.type === "replace"
          ? "replacement"
          : primary?.type === "resume"
            ? "configured"
            : null;
  const disabledReason =
    capability && input.capabilities !== undefined
      ? input.capabilities === null
        ? "Relay capability status is unknown. Check status before continuing."
        : !input.capabilities[capability]
          ? "This VM action is inactive on the relay."
          : null
      : null;
  return {
    disabledReason,
    label: ready && input.queuePaused ? "VM ready · queue paused" : label,
    tone: failed
      ? ("danger" as const)
      : ready
        ? ("success" as const)
        : primary
          ? ("attention" as const)
          : ("neutral" as const),
    detail,
    primary,
    held,
    ready,
    canPreview:
      ready &&
      !failed &&
      (input.capabilities === undefined || input.capabilities?.privatePreview === true),
    canRecoverBackup:
      !input.error &&
      (input.capabilities === undefined || input.capabilities?.restore === true) &&
      !held &&
      !!status?.lastVerifiedBackupAt &&
      (status.allocation?.state === "running" || status.allocation?.state === "paused"),
    canDelete:
      !!status &&
      !input.error &&
      !held &&
      (input.capabilities === undefined || input.capabilities?.permanentDelete === true),
    canCancelSetup: !held && ["pending", "running", "failed"].includes(status?.setupPhase ?? ""),
    canCancelRestore:
      !!status?.restore &&
      status.restore.canCancel !== false &&
      ["pending", "preparing", "prepared", "boot_preparing", "boot_prepared"].includes(
        status.restore.phase,
      ),
    canCancelReset: !!status?.reset && ["pending", "creating"].includes(status.reset.phase),
  };
}

/** Byte counts come from verified transfer receipts, with no guessed overall percentage. */
export function threadMoveProgressPresentation(
  placement: RelayPortableThreadPlacement | null | undefined,
) {
  if (!placement?.operationId || placement.moveFailureDetail) return null;
  const snapshots =
    placement.moveProgress?.filter(
      (progress) =>
        progress.operationId === placement.operationId && progress.threadId === placement.threadId,
    ) ?? [];
  const destination = snapshots.filter((progress) => progress.participant === "destination");
  const progress = [...(destination.length ? destination : snapshots)].sort(
    (a, b) =>
      b.attempt - a.attempt || b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  if (!progress) return null;
  const labels = {
    capturing: "Saving conversation",
    packing: "Preparing files",
    uploading: "Uploading files",
    downloading: "Downloading files",
    installing: "Restoring files and conversation",
    setup: "Preparing project",
    activating: "Opening the new location",
  };
  const bytes = (value: number) =>
    value >= 1_048_576
      ? `${(value / 1_048_576).toFixed(1)} MB`
      : value >= 1024
        ? `${Math.round(value / 1024)} KB`
        : `${value} B`;
  return {
    label: labels[progress.stage],
    detail:
      progress.totalBytes === null
        ? null
        : `${bytes(progress.completedBytes)} of ${bytes(progress.totalBytes)} verified`,
    stage: progress.stage,
  };
}

/** A refreshed status must still permit the command selected by the user. */
export function threadVmActionUnavailableReason(
  action: ThreadVmControlAction,
  status: RelayThreadVmStatus,
) {
  if (
    "payload" in action &&
    "expectedGeneration" in action.payload &&
    action.payload.expectedGeneration !== status.generation &&
    !(action.type === "restore" && status.restore?.operationId === action.payload.operationId) &&
    !(action.type === "reset" && status.reset?.operationId === action.payload.operationId)
  )
    return "This thread’s VM changed. Check its current status before trying again.";
  const presentation = threadVmPresentation({ status });
  if (action.type === "resume" && status.allocation?.state !== "paused" && !status.resumePhase)
    return "This VM is no longer paused. Check its current status.";
  if (
    action.type === "reset" &&
    status.reset?.operationId !== action.payload.operationId &&
    presentation.primary?.type !== "reset"
  )
    return "Reset is available only after the saved workspace expires.";
  if (
    action.type === "restore" &&
    status.restore?.operationId !== action.payload.operationId &&
    status.replacement?.requestId !== action.payload.operationId &&
    presentation.primary?.type !== "restore"
  )
    return "This saved workspace is no longer available to restore.";
  if (action.type === "cancel_restore" && status.restore?.operationId !== action.operationId)
    return "This restore request changed. Check its current status.";
  if (action.type === "cancel_reset" && status.reset?.operationId !== action.operationId)
    return "This reset request changed. Check its current status.";
  return null;
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
  const capabilitiesQueryAtom = runtime
    .atom(
      Effect.gen(function* () {
        const relay = yield* ManagedRelayTenancyClient;
        if (!normalizeSecureRelayUrl(relay.relayUrl)) return null;
        return (yield* relay.getHealth()).threadVmCapabilities ?? null;
      }),
    )
    .pipe(Atom.setIdleTTL(0));
  const capabilitiesAtom = Atom.make((get) =>
    readManagedRelaySnapshotState(get(capabilitiesQueryAtom)),
  ).pipe(Atom.setIdleTTL(0));
  const hostConfigurationQueryAtom = runtime
    .atom(
      Effect.gen(function* () {
        const relay = yield* ManagedRelayTenancyClient;
        if (!normalizeSecureRelayUrl(relay.relayUrl)) return false;
        return (yield* relay.getHealth()).threadVmConfigured === true;
      }),
    )
    .pipe(Atom.setIdleTTL(0));
  const hostConfigurationAtom = Atom.make((get) => {
    const state = readManagedRelaySnapshotState(get(hostConfigurationQueryAtom));
    return { ...state, unavailableReason: threadVmHostUnavailableReason(state) };
  }).pipe(Atom.setIdleTTL(0));
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
  const configuredRelayAtom = runtime.atom(
    Effect.map(ManagedRelayTenancyClient, (relay) => normalizeSecureRelayUrl(relay.relayUrl)),
  );
  type LocationState = {
    session: ManagedRelaySession;
    relayUrl: string;
    request: number;
    generation: number;
    recoveryRequested: boolean;
    /** Confirm the final placement even after a claimed move leaves the queue. */
    trackingMove: boolean;
    placement: RelayPortableThreadPlacement | null;
    error: string | null;
    isPending: boolean;
  };
  const locationStateAtom = Atom.family((_threadId: ThreadId) =>
    Atom.make<LocationState | null>(null).pipe(Atom.keepAlive),
  );
  const scopedLocationAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const [, threadId] = decodeKey(key),
        state = get(locationStateAtom(threadId)),
        configured = readManagedRelaySnapshotState(get(configuredRelayAtom));
      if (
        state?.session !== get(managedRelaySessionAtom) ||
        configured.isPending ||
        configured.error ||
        state?.relayUrl !== configured.data
      )
        return null;
      const proofs = get(portableThreadPlacementsAtom);
      const placement =
        proofs?.session === state.session &&
        proofs.relayUrl === state.relayUrl &&
        (proofs.reads.get(threadId) ?? 0) >= state.request
          ? proofs.placements.get(threadId)
          : null;
      return placement
        ? {
            ...state,
            placement,
            generation: placement.generation,
            trackingMove: placement.operationId !== null,
            error: null,
            isPending: false,
          }
        : state;
    }),
  );
  const confirmedLocationAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const state = get(scopedLocationAtom(key)),
        route = get(routeAtom(key));
      return state &&
        !state.error &&
        !state.isPending &&
        (state.placement?.generation ?? 0) >= (route?.generation ?? 0)
        ? state.placement
        : null;
    }),
  );
  const readLocation = Effect.fnUntraced(function* (
    registry: AtomRegistry.AtomRegistry,
    key: string,
    expectedAccount?: string,
    recoveryRelay?: string,
    explicit = false,
  ) {
    const session = registry.get(managedRelaySessionAtom),
      relay = yield* ManagedRelayTenancyClient;
    if (!session || (expectedAccount !== undefined && session.accountId !== expectedAccount))
      return yield* new OrchestrationDispatchCommandError({
        message: "Connect to this thread’s Launchpad Connect account first.",
      });
    const relayUrl = normalizeSecureRelayUrl(relay.relayUrl),
      configuredRelay = yield* AtomRegistry.getResult(registry, configuredRelayAtom, {
        suspendOnWaiting: true,
      });
    if (
      !relayUrl ||
      configuredRelay !== relayUrl ||
      registry.get(managedRelaySessionAtom) !== session ||
      (recoveryRelay && normalizeSecureRelayUrl(recoveryRelay) !== relayUrl)
    )
      return yield* new OrchestrationDispatchCommandError({
        message: "The Launchpad Connect relay changed. Reopen this thread before checking it.",
      });
    const [environmentId, threadId] = decodeKey(key),
      route = registry.get(routeAtom(key)),
      atom = locationStateAtom(threadId),
      previous = registry.get(atom),
      sameScope = previous?.session === session && previous.relayUrl === relayUrl,
      request = beginPortableThreadPlacementRead(registry, session, relay.relayUrl);
    const queuedMove = () =>
      threadDetailAtom
        ? inFlightMove(registry.get(threadDetailAtom(environmentId, threadId))?.promptQueue)
        : false;
    const started = {
      session,
      relayUrl,
      request,
      generation: Math.max(sameScope ? previous.generation : 0, route?.generation ?? 0),
      recoveryRequested: explicit || (sameScope && previous.recoveryRequested),
      trackingMove: queuedMove() || (sameScope && previous.trackingMove),
      placement: sameScope ? previous.placement : null,
      error: null,
      isPending: true,
    };
    if (explicit) registry.set(atom, started);
    const isCurrent = () => {
      const currentRoute = registry.get(routeAtom(key));
      const configured = readManagedRelaySnapshotState(registry.get(configuredRelayAtom));
      return (
        registry.get(managedRelaySessionAtom) === session &&
        !configured.isPending &&
        configured.data === relayUrl &&
        currentRoute?.generation === route?.generation &&
        normalizeSecureRelayUrl(currentRoute?.relayUrl ?? relayUrl) ===
          normalizeSecureRelayUrl(route?.relayUrl ?? relayUrl) &&
        (registry.get(atom)?.request ?? 0) <= request &&
        isPortableThreadPlacementReadCurrent(registry, session, relayUrl, threadId, request)
      );
    };
    const placement = yield* Effect.gen(function* () {
      const { clerkToken } = yield* authorize(registry, key, expectedAccount, recoveryRelay);
      return yield* relay.getPortableThreadPlacement({ clerkToken, threadId });
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isCurrent()) return;
          registry.update(atom, (current) => ({
            ...started,
            generation: sameScope
              ? (current?.generation ?? started.generation)
              : started.generation,
            placement: null,
            trackingMove: false,
            error: readManagedRelaySnapshotState(AsyncResult.fail(error)).error,
            isPending: false,
          }));
        }),
      ),
    );
    if (!isCurrent()) {
      if (
        registry.get(atom)?.request === request &&
        registry.get(managedRelaySessionAtom) === session
      )
        registry.update(
          atom,
          (current) =>
            current && {
              ...current,
              placement: null,
              error: "This thread’s location changed while checking it. Check again.",
              isPending: false,
            },
        );
      return yield* new OrchestrationDispatchCommandError({
        message: "Your account or this thread’s location changed while checking it. Check again.",
      });
    }
    const latest = registry.get(atom);
    if (
      placement.threadId !== threadId ||
      placement.generation < Math.max(started.generation, sameScope ? (latest?.generation ?? 0) : 0)
    ) {
      if (explicit) registry.set(atom, { ...started, isPending: false });
      return yield* new OrchestrationDispatchCommandError({
        message: "This thread’s location changed while checking it. Check again.",
      });
    }
    if (
      !rememberPortableThreadPlacement(registry, session, relayUrl, placement, undefined, request)
    )
      return yield* new OrchestrationDispatchCommandError({
        message: "This thread’s location changed while checking it. Check again.",
      });
    registry.set(atom, {
      ...started,
      placement,
      generation: placement.generation,
      trackingMove: started.trackingMove && (queuedMove() || placement.operationId !== null),
      isPending: false,
    });
    return placement;
  });
  const checkLocation = createRuntimeCommand(runtime, {
    label: "check thread location",
    execute: Effect.fnUntraced(function* (
      input: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        accountId: string;
        relayUrl: string;
      },
      registry,
    ) {
      return yield* readLocation(
        registry,
        keyFor(input.environmentId, input.threadId),
        input.accountId,
        input.relayUrl,
        true,
      );
    }),
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
  const providerAuthBindingAtom = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        readManagedRelaySnapshotState(get(queryAtom(key))).data?.status?.pendingProviderAuth ??
        null,
    ).pipe(
      Atom.withEquality<RelayThreadVmProviderAuthBinding | null>(
        (a, b) => a === b || (a !== null && b !== null && sameAuthBinding(a, b)),
      ),
      Atom.setIdleTTL(0),
    ),
  );
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
            route = get(routeAtom(key)),
            binding = get(providerAuthBindingAtom(key));
          if (!session || !route || !binding) return null;
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
          return reply ? { ...reply, accountId: session.accountId, route } : null;
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
        !result.waiting &&
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
          const registry = yield* AtomRegistry.AtomRegistry;
          // Read without subscribing: this query publishes the same recovery state.
          const trackingMove = registry.get(scopedLocationAtom(key))?.trackingMove;
          if (route.phase === "active" && !inFlightMove(queue) && !trackingMove) return null;
          const placement = yield* readLocation(registry, key);
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
          const placement = yield* readLocation(
            registry,
            key,
            session.accountId,
            configuredRelay.relayUrl,
          );
          return { session, placement };
        }),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const unavailableLocationViewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const session = get(managedRelaySessionAtom);
      if (!session) return null;
      const [environmentId, threadId] = decodeKey(key);
      const queue = threadDetailAtom
        ? get(threadDetailAtom(environmentId, threadId))?.promptQueue
        : undefined;
      const query = readManagedRelaySnapshotState(get(unavailableLocationQueryAtom(key))),
        recovery = get(scopedLocationAtom(key)),
        state = recovery ?? query,
        value = recovery
          ? recovery.placement
          : query.data?.session === session
            ? query.data.placement
            : null;
      return {
        accountId: session.accountId,
        placement: !state.error && !state.isPending ? value : null,
        recoveryRequested: recovery?.recoveryRequested ?? false,
        error: state.error,
        moveFailureDetail:
          !state.error && !state.isPending ? moveFailureDetail(value, queue) : null,
        isPending: state.isPending,
        movePending: value?.operationId != null,
        destination:
          !state.error &&
          !state.isPending &&
          value?.threadId === threadId &&
          value.operationId === null
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
      if (!session) return null;
      const [environmentId, threadId] = decodeKey(key);
      const queue = threadDetailAtom
        ? get(threadDetailAtom(environmentId, threadId))?.promptQueue
        : undefined;
      const recovery = get(scopedLocationAtom(key));
      const autoLookup =
        !!route &&
        (route.phase !== "active" || inFlightMove(queue) || recovery?.trackingMove === true);
      // Keep the base query mounted even when a newer check supplies the placement;
      // publishing completion must not dispose its in-progress read.
      const initial = route ? readManagedRelaySnapshotState(get(locationQueryAtom(key))) : null;
      // A superseded query may fail while a newer check still confirms a live move.
      const current = recovery
        ? recovery.placement
        : initial?.data?.session === session
          ? initial.data.placement
          : null;
      const query =
        autoLookup &&
        current &&
        !(recovery ? recovery.error : initial?.error) &&
        (current.operationId !== null ||
          (inFlightMove(queue) &&
            current.environmentId === environmentId &&
            current.generation === route?.generation))
          ? readManagedRelaySnapshotState(get(movingLocationQueryAtom(key)))
          : initial;
      if (!autoLookup && !recovery?.recoveryRequested && !recovery?.error) return null;
      const state = recovery ?? query,
        value = recovery
          ? recovery.placement
          : query?.data?.session === session
            ? query.data.placement
            : null,
        error = state?.error ?? null,
        isPending = state?.isPending ?? false;
      if (
        !isPending &&
        !error &&
        value?.environmentId === environmentId &&
        value.generation === route?.generation &&
        value.operationId === null &&
        route.phase === "active" &&
        !inFlightMove(queue)
      )
        return null;
      return {
        accountId: session.accountId,
        placement: !error && !isPending ? value : null,
        recoveryRequested: recovery?.recoveryRequested ?? false,
        error,
        moveFailureDetail: !error && !isPending ? moveFailureDetail(value, queue) : null,
        isPending,
        movePending: value?.operationId != null,
        destination:
          !error &&
          !isPending &&
          value?.threadId === threadId &&
          value.operationId === null &&
          value.generation > (route?.generation ?? 0) &&
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
      const [environmentId, threadId] = decodeKey(key);
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
          authValue.route === route &&
          sameAuthBinding(binding, authValue)
            ? authValue
            : null,
        providerAuthError: providerAuth?.error ?? null,
        providerAuthPending: providerAuth?.isPending ?? false,
        accountId: session.accountId,
        queuePaused: threadDetailAtom
          ? get(threadDetailAtom(environmentId, threadId))?.promptQueue?.enabled === false
          : false,
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
      const previouslyRead =
        value.type === "delete"
          ? null
          : readManagedRelaySnapshotState(registry.get(queryAtom(key))).data?.status;
      const fresh = value.type === "delete" ? null : yield* relay.getThreadVmStatus(auth);
      if (
        fresh &&
        previouslyRead &&
        fresh.generation !== previouslyRead.generation &&
        (value.type === "resume" || value.type === "cancel_setup")
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "This thread’s VM changed. Check its current status before trying again.",
        });
      const unavailable = fresh ? threadVmActionUnavailableReason(value, fresh) : null;
      if (unavailable || registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: unavailable ?? "Your account changed. Check this thread again.",
        });
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
    capabilitiesQueryAtom,
    capabilitiesAtom,
    hostConfigurationQueryAtom,
    hostConfigurationAtom,
    refresh(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId, threadId: ThreadId) {
      const key = keyFor(environmentId, threadId),
        route = registry.get(routeAtom(key));
      if (route)
        registry.refresh(
          bootstrapAtom(encodeBootstrapKey([environmentId, threadId, route.generation])),
        );
      registry.refresh(queryAtom(key));
      registry.refresh(capabilitiesQueryAtom);
      registry.refresh(providerAuthQueryAtom(key));
      registry.refresh(locationQueryAtom(key));
      registry.refresh(unavailableLocationQueryAtom(key));
    },
    action,
    checkLocation,
    confirmedLocationAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      confirmedLocationAtom(keyFor(environmentId, threadId)),
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
