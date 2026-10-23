import { portableThreadPlacementsAtom } from "@t3tools/client-runtime/relay/portableThreadPresentation";
import { MovedThreadDraftRecovery } from "./MovedThreadDraftRecovery";
import { threadMoveProgressPresentation } from "@t3tools/client-runtime/relay/threadVmControls";
import { handoffMovedThreadDraft, type MovedThreadDraftConflict } from "../../composerDraftStore";
import { recoverMovedDraftFile } from "../../lib/movedThreadDraft";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  threadMoveProjectTargets,
  threadMoveRepositoryCanonicalKey,
  threadMoveProviderSupported,
  type ThreadMoveSubmission,
  type ThreadMoveSubmissionScope,
} from "@t3tools/client-runtime/relay/threadMoveSubmission";
import {
  threadRunOnStatus,
  threadRunOnTargetAvailability,
} from "@t3tools/client-runtime/relay/threadRunOn";
import {
  recoverThreadMove,
  threadMoveObservation,
  threadMoveSnapshotReached,
} from "@t3tools/client-runtime/relay/threadMoveRecovery";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ThreadId,
  type ThreadMoveDestination,
} from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Option from "effect/Option";
import { threadMoveSubmissions, threadMoveRelayUrl } from "../../state/thread-move-submissions";
import {
  openPortableThreadChat,
  threadEnvironment,
  threadVmControls,
  environmentThreadDetails,
} from "../../state/threads";
import { environmentProjects } from "../../state/projects";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { environmentCatalog } from "../../connection/catalog";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ComposerControl } from "./ComposerControl";
import { ThreadVmMenuActions, useThreadVmUi } from "./ThreadVmControls";
import { useComposerMenuProps } from "./composerEventScope";

function FollowThreadLocation({
  environmentId,
  threadId,
  recoverUnavailable = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  recoverUnavailable?: boolean;
}) {
  const state = useAtomValue(
    threadVmControls.locationViewAtom(environmentId, threadId, recoverUnavailable),
  );
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const checkLocation = useAtomCommand(threadVmControls.checkLocation, { reportFailure: false });
  const open = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [draftConflict, setDraftConflict] = useState<MovedThreadDraftConflict | null>(null);
  const draftChoice = useRef<
    { use: "source" | "destination"; conflict: MovedThreadDraftConflict } | undefined
  >(undefined);
  const destinationId = state?.destination?.environmentId,
    generation = state?.destination?.generation;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!destinationId || generation === undefined || !session || checking) {
      void Promise.resolve().then(() => {
        if (!cancelled) setBusy(false);
      });
      return () => {
        cancelled = true;
      };
    }
    void Promise.resolve()
      .then(() => {
        if (cancelled || appAtomRegistry.get(managedRelaySessionAtom) !== session) return null;
        setBusy(true);
        setError(null);
        return open({
          threadId,
          title: "Moved thread",
          expectedPlacement: { environmentId: destinationId, generation },
        });
      })
      .then(async (result) => {
        if (!result || cancelled || appAtomRegistry.get(managedRelaySessionAtom) !== session)
          return;
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not connect to the current location.",
          );
        } else {
          const stillCurrent = () => {
            const proofs = appAtomRegistry.get(portableThreadPlacementsAtom);
            const placement = proofs?.placements.get(threadId);
            return (
              !cancelled &&
              appAtomRegistry.get(managedRelaySessionAtom) === session &&
              proofs?.session === session &&
              threadMoveRelayUrl() === relayUrl &&
              proofs.relayUrl === relayUrl &&
              placement?.operationId === null &&
              placement.environmentId === destinationId &&
              placement.generation === generation
            );
          };
          const handoff = await handoffMovedThreadDraft({
            source: { environmentId, threadId },
            destination: result.value,
            recoverFile: recoverMovedDraftFile,
            stillCurrent,
            ...(draftChoice.current ? { choice: draftChoice.current } : {}),
          });
          if (!stillCurrent()) return;
          if (handoff.conflict) {
            setDraftConflict(handoff.conflict);
            return;
          }
          setDraftConflict(null);
          draftChoice.current = undefined;
          await navigate({ to: "/$environmentId/$threadId", params: result.value, replace: true });
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          draftChoice.current = undefined;
          setDraftConflict(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not open the current location. Try again.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    destinationId,
    generation,
    session,
    relayUrl,
    environmentId,
    threadId,
    attempt,
    checking,
    open,
    navigate,
  ]);
  if (
    !state ||
    (!recoverUnavailable && !state.recoveryRequested && !state.destination && !state.error)
  )
    return null;
  return (
    <section role="status" className="border-b border-border px-3 py-2 text-xs">
      <p>
        {busy || checking
          ? "Opening the thread’s current location…"
          : state.isPending
            ? "Checking this thread’s current location…"
            : state.movePending
              ? "This thread is still moving. Check again when the move finishes."
              : state.destination
                ? "Open this thread’s current location to continue."
                : "Could not confirm this thread’s current location."}
      </p>
      {error || state.error ? (
        <p role="alert" className="text-destructive">
          {error ?? state.error}
        </p>
      ) : null}
      {draftConflict ? (
        <div className="space-y-2 py-2">
          <p className="font-medium">Both locations have an unsent draft</p>
          <p>Choose which draft to open. The other stays saved at the previous location.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["source", "destination"] as const).map((use) => (
              <div key={use} className="rounded-md border border-border p-2">
                <p className="line-clamp-3 whitespace-pre-wrap">
                  {draftConflict[use].prompt || "Attachments and context"}
                </p>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    draftChoice.current = { use, conflict: draftConflict };
                    setDraftConflict(null);
                    setAttempt((value) => value + 1);
                  }}
                >
                  {use === "source" ? "Use incoming draft" : "Keep destination draft"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <Button
        size="xs"
        variant="secondary"
        disabled={busy || checking || state.isPending || !!draftConflict || !session || !relayUrl}
        onClick={async () => {
          if (!session || !relayUrl) return;
          setChecking(true);
          setError(null);
          try {
            const result = await checkLocation({
              environmentId,
              threadId,
              accountId: session.accountId,
              relayUrl,
            });
            if (
              !mounted.current ||
              appAtomRegistry.get(managedRelaySessionAtom) !== session ||
              threadMoveRelayUrl() !== relayUrl
            )
              return;
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            setAttempt((value) => value + 1);
          } catch (cause) {
            if (
              mounted.current &&
              appAtomRegistry.get(managedRelaySessionAtom) === session &&
              threadMoveRelayUrl() === relayUrl
            )
              setError(
                cause instanceof Error ? cause.message : "Could not check the current location.",
              );
          } finally {
            if (mounted.current) setChecking(false);
          }
        }}
      >
        Open current location
      </Button>
    </section>
  );
}

function ThreadMoveProgressCard({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const location = useAtomValue(threadVmControls.locationViewAtom(environmentId, threadId));
  const queue = useAtomValue(
    environmentThreadDetails.stateAtom({ environmentId, threadId }),
    (state) => Option.getOrNull(state.data)?.promptQueue,
  );
  const progress = threadMoveProgressPresentation(location?.placement);
  const moving = queue?.entries.find((entry) => entry.kind === "move" && entry.state !== "pending");
  if (!location?.movePending || location.moveFailureDetail || !progress) return null;
  const cancelling = moving?.state === "cancelling";
  return (
    <div
      className="mx-3 my-2 grid gap-1 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs"
      role="status"
    >
      <p className="font-medium">{cancelling ? "Cancelling move…" : progress.label}</p>
      {!cancelling && progress.detail ? (
        <p className="text-muted-foreground">{progress.detail}</p>
      ) : null}
      <p className="text-muted-foreground">
        {cancelling
          ? "Waiting for both locations to confirm cancellation."
          : "Your conversation and files move together. Manage or cancel the move in the queue."}
      </p>
    </div>
  );
}

export function CurrentThreadLocation(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  recoverUnavailable?: boolean;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  return (
    <>
      <ThreadMoveProgressCard environmentId={props.environmentId} threadId={props.threadId} />
      <MovedThreadDraftRecovery environmentId={props.environmentId} threadId={props.threadId} />
      <FollowThreadLocation
        key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.threadId}:${props.recoverUnavailable === true}`}
        {...props}
      />
    </>
  );
}

function SignInForMoves() {
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  return (
    <Button size="xs" variant="secondary" onClick={openAuthPrompt}>
      Sign in
    </Button>
  );
}

function ConnectForMoves({ environmentId }: { environmentId: EnvironmentId }) {
  const controller = useCloudLinkController();
  const reconnect = useAtomCommand(environmentCatalog.retryNow);
  const [busy, setBusy] = useState(false);
  if (controller.linkState.target?.environmentId !== environmentId)
    return <p>Open Launchpad Connect on this thread’s host to connect it.</p>;
  const update = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (
        await controller.reconcileCloudState({
          managedTunnel: false,
          publish: false,
          keepLinked: true,
        })
      )
        await reconnect(environmentId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <p>Agent activity publishing stays off.</p>
      <Button
        size="xs"
        variant="secondary"
        disabled={busy || controller.linkState.isPending}
        onClick={() => void update()}
      >
        {busy ? "Connecting…" : "Connect for thread moves"}
      </Button>
      {controller.operationError ? (
        <p role="alert" className="text-destructive">
          {controller.operationError}
        </p>
      ) : null}
    </div>
  );
}

/** A destination is an action; checked state always describes the current host. */
function DestinationRow({
  label,
  detail,
  machine,
  current = false,
  disabled = false,
  onClick,
}: {
  label: string;
  detail: string;
  machine: Parameters<typeof EnvironmentMachineIcon>[0]["kind"];
  current?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={current ? "location" : undefined}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <EnvironmentMachineIcon
        kind={machine}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        <span className="mt-0.5 flex text-xs text-muted-foreground">
          <MiddleTruncate value={detail} showTitle={false} />
        </span>
      </span>
      {current ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
}

function MachineDestinationRow({
  target,
  environment,
  disabled,
  onMove,
  onCheck,
}: {
  target: ReturnType<typeof threadMoveProjectTargets>[number];
  environment: EnvironmentPresentation | undefined;
  disabled: boolean;
  onMove: () => void;
  onCheck: () => void;
}) {
  const connection = useEnvironmentQuery(
    environmentCatalog.stateAtom(target.project.environmentId),
  );
  const availability = threadRunOnTargetAvailability({
    phase: environment?.connection.phase,
    failureReason: connection.data?.lastFailure?.reason,
  });
  return (
    <DestinationRow
      label={
        environment?.serverConfig?.environment.label ?? environment?.label ?? "Selected machine"
      }
      detail={availability.detail ?? `${target.project.title} · ${target.project.workspaceRoot}`}
      machine={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
      disabled={disabled || availability.action === null}
      onClick={availability.action === "check" ? onCheck : onMove}
    />
  );
}

function RunOnPicker({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const thread = useThreadShell({ environmentId, threadId });
  const detailAtom = environmentThreadDetails.stateAtom({ environmentId, threadId });
  const queue = useAtomValue(detailAtom, (state) => Option.getOrNull(state.data)?.promptQueue);
  const detailReady = useAtomValue(
    detailAtom,
    (state) => state.status === "live" && Option.isSome(state.data),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const vm = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  const location = useAtomValue(threadVmControls.locationViewAtom(environmentId, threadId));
  const routeAtom = threadVmControls.routeAtom(environmentId, threadId);
  const route = useAtomValue(routeAtom);
  const confirmedLocationAtom = threadVmControls.confirmedLocationAtom(environmentId, threadId);
  const placement = useAtomValue(confirmedLocationAtom);
  const host = useAtomValue(threadVmControls.hostConfigurationAtom);
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const composerFloatingLayerProps = useComposerMenuProps();
  const enqueue = useAtomCommand(threadEnvironment.enqueueMove, { reportFailure: false });
  const receipt = useAtomCommand(threadEnvironment.getCommandReceipt, { reportFailure: false });
  const localReceipt = useAtomCommand(threadEnvironment.getLocalCommandReceipt, {
    reportFailure: false,
  });
  const reconnect = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const checkLocation = useAtomCommand(threadVmControls.checkLocation, { reportFailure: false });
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<ThreadMoveSubmission | null>(null),
    [ready, setReady] = useState(!session || !relayUrl),
    [error, setError] = useState<string | null>(null);
  const runOnTrigger = useRef<HTMLButtonElement | null>(null);
  const vmUi = useThreadVmUi();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const snapshotReached = useAtomValue(detailAtom, (state) =>
    threadMoveSnapshotReached(environmentId, state, saved, route),
  );
  const savedCommandId = saved?.command.commandId;
  const savedRejection = saved?.rejection;
  const accountId = session?.accountId ?? null;
  const recoverSaved = useCallback(
    (scope: ThreadMoveSubmissionScope, pending: ThreadMoveSubmission, isCurrent: () => boolean) =>
      recoverThreadMove(threadMoveSubmissions, scope, pending, {
        isCurrent,
        checkLocation: async () => {
          const result = await checkLocation(scope);
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readReceipt: async () => {
          const result = await localReceipt({
            environmentId,
            input: { threadId, commandId: pending.command.commandId },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readObservation: () =>
          threadMoveObservation(
            environmentId,
            appAtomRegistry.get(detailAtom),
            appAtomRegistry.get(confirmedLocationAtom),
            appAtomRegistry.get(routeAtom),
          ),
      }),
    [
      environmentId,
      threadId,
      checkLocation,
      localReceipt,
      detailAtom,
      routeAtom,
      confirmedLocationAtom,
    ],
  );
  useEffect(() => {
    let cancelled = false;
    if (!accountId || !relayUrl) return;
    void threadMoveSubmissions.read({ accountId, relayUrl, environmentId, threadId }).then(
      (value) => {
        if (!cancelled) {
          setSaved(value);
          setReady(true);
        }
      },
      () => {
        if (!cancelled)
          setError("Could not read the saved move. Resolve storage before sending another.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, relayUrl, environmentId, threadId]);
  useEffect(() => {
    if (!saved || !session || !relayUrl) return;
    let cancelled = false;
    const detailState = appAtomRegistry.get(detailAtom);
    const observedQueue = Option.getOrNull(detailState.data)?.promptQueue;
    if (
      observedQueue !== queue ||
      (detailState.status === "live" && Option.isSome(detailState.data)) !== detailReady ||
      appAtomRegistry.get(confirmedLocationAtom) !== placement ||
      appAtomRegistry.get(routeAtom) !== route ||
      threadMoveSnapshotReached(environmentId, detailState, saved, route) !== snapshotReached
    )
      return;
    void threadMoveSubmissions
      .observe(
        { accountId: session.accountId, relayUrl, environmentId, threadId },
        saved,
        threadMoveObservation(environmentId, detailState, placement, route),
      )
      .then(
        (value) => {
          if (
            !cancelled &&
            appAtomRegistry.get(managedRelaySessionAtom) === session &&
            threadMoveRelayUrl() === relayUrl
          )
            setSaved(value);
        },
        (cause) => {
          if (
            !cancelled &&
            appAtomRegistry.get(managedRelaySessionAtom) === session &&
            threadMoveRelayUrl() === relayUrl
          )
            setError(
              cause instanceof Error ? cause.message : "Could not reconcile the saved move.",
            );
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    saved,
    session,
    relayUrl,
    environmentId,
    threadId,
    queue,
    detailAtom,
    detailReady,
    placement,
    confirmedLocationAtom,
    route,
    routeAtom,
    snapshotReached,
  ]);
  useEffect(() => {
    if (
      !savedCommandId ||
      savedRejection ||
      !session ||
      !relayUrl ||
      !detailReady ||
      route?.phase !== "active"
    )
      return;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      appAtomRegistry.get(managedRelaySessionAtom) === session &&
      threadMoveRelayUrl() === relayUrl &&
      appAtomRegistry.get(routeAtom)?.generation === route.generation &&
      appAtomRegistry.get(routeAtom)?.phase === "active";
    const scope = { accountId: session.accountId, relayUrl, environmentId, threadId };
    void threadMoveSubmissions
      .read(scope)
      .then((pending) => {
        if (!isCurrent() || !pending || pending.command.commandId !== savedCommandId)
          return pending;
        return recoverSaved(scope, pending, isCurrent);
      })
      .then(
        (value) => {
          if (isCurrent()) setSaved(value);
        },
        (cause) => {
          if (isCurrent())
            setError(cause instanceof Error ? cause.message : "Could not check the saved move.");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    session,
    relayUrl,
    environmentId,
    threadId,
    savedCommandId,
    savedRejection,
    detailReady,
    route?.generation,
    route?.phase,
    routeAtom,
    recoverSaved,
  ]);
  const environment = environments.find((item) => item.environmentId === environmentId);
  const currentEnvironmentId = location?.destination?.environmentId ?? environmentId;
  const currentEnvironment = environments.find(
    (item) => item.environmentId === currentEnvironmentId,
  );
  const currentConfig =
    currentEnvironmentId === environmentId ? config : currentEnvironment?.serverConfig;
  const movedAway = currentEnvironmentId !== environmentId;
  const source = projects.find(
    (item) => item.environmentId === environmentId && item.id === thread?.projectId,
  );
  const isVm = config?.environment.threadVm?.threadId === threadId;
  const label =
    currentConfig?.environment.threadVm?.threadId === threadId
      ? "Private VM"
      : (currentConfig?.environment.label ?? currentEnvironment?.label ?? "Current machine");
  const machine = resolveEnvironmentMachineKind(currentConfig ?? null);
  const canonicalKey =
    source && thread
      ? threadMoveRepositoryCanonicalKey(source, thread, config?.environment, vm?.data?.status)
      : undefined;
  const targets = source
    ? threadMoveProjectTargets(source, projects, environments, canonicalKey)
    : [];
  const provider = config?.providers.find(
    (item) => item.instanceId === thread?.modelSelection.instanceId,
  );
  const codexSupported = threadMoveProviderSupported(provider, "environment");
  const vmSupported = threadMoveProviderSupported(provider, "vm");
  const status = threadRunOnStatus({ queue, saved });
  const detailedProgress = threadMoveProgressPresentation(location?.placement);
  const movePending = location?.movePending === true;
  const visibleError = error ?? location?.moveFailureDetail ?? null;
  const destinationLabel = (destination: ThreadMoveDestination) => {
    if (destination.kind === "vm") return "Private VM";
    const destinationEnvironment = environments.find(
      (item) => item.environmentId === destination.environmentId,
    );
    const targetLabel =
      destinationEnvironment?.serverConfig?.environment.label ??
      destinationEnvironment?.label ??
      "Selected machine";
    const project = projects.find(
      (item) =>
        item.environmentId === destination.environmentId && item.id === destination.projectId,
    );
    return project &&
      targets.filter((item) => item.project.environmentId === destination.environmentId).length > 1
      ? `${targetLabel} · ${project.title} (${project.workspaceRoot})`
      : targetLabel;
  };
  const unavailable = environment?.connection.phase !== "connected";
  const blocker =
    !relayUrl || !hasCloudPublicConfig()
      ? "Launchpad Connect is not configured on this host."
      : !session
        ? "Sign in to Launchpad Connect to move this thread."
        : !thread || !config
          ? "Checking this thread’s host…"
          : thread.archivedAt
            ? "Restore this archived thread before moving it."
            : unavailable
              ? "Reconnect to this thread’s host before moving it."
              : !codexSupported
                ? "Thread moves currently require Codex."
                : config.environment.capabilities.threadMoves === false
                  ? "Connect this host to move its threads."
                  : config.environment.capabilities.threadMoves !== true
                    ? "Update this host’s server to support queued moves."
                    : !detailReady
                      ? "Syncing this thread’s queue…"
                      : !canonicalKey
                        ? isVm
                          ? "The VM’s repository is not available yet. Reconnect to its host and try again."
                          : "Register this Git repository in Organization settings first."
                        : null;
  const disabled =
    busy || !ready || blocker !== null || status !== null || movePending || movedAway;
  const lookup = async (command: ThreadMoveSubmission["command"]) => {
    const result = await receipt({
      environmentId,
      input: { threadId, commandId: command.commandId },
    });
    if (appAtomRegistry.get(managedRelaySessionAtom) !== session)
      throw new Error("Your account changed. The saved move is preserved.");
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const run = async (kind: "send" | "check" | "discard", destination?: ThreadMoveDestination) => {
    if (submitting.current || !session || !relayUrl || !ready) return;
    if (kind === "send" && destination && disabled) return;
    const scope = {
      accountId: session.accountId,
      relayUrl,
      environmentId,
      threadId,
      ...(thread?.relayRouting?.generation === undefined
        ? {}
        : { sourceGeneration: thread.relayRouting.generation }),
    };
    const isCurrent = () =>
      mounted.current &&
      appAtomRegistry.get(managedRelaySessionAtom) === session &&
      threadMoveRelayUrl() === relayUrl;
    if (!isCurrent()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (kind === "discard") await threadMoveSubmissions.discardRejected(scope);
      else if (kind === "check" && saved) {
        await threadMoveSubmissions.reconcile(scope, saved, await lookup(saved.command));
        const pending = await threadMoveSubmissions.read(scope);
        if (pending && !pending.rejection && isCurrent())
          await recoverSaved(scope, pending, isCurrent);
        const current = await threadMoveSubmissions.read(scope);
        if (!isCurrent()) return;
        if (current?.rejection) setError(current.rejection);
        else if (!current || current.accepted) setOpen(false);
      } else {
        const outcome = await threadMoveSubmissions.submit(
          scope,
          () => {
            if (!destination || status)
              throw new Error("Resolve the saved move before choosing another machine.");
            return {
              type: "thread.move.enqueue",
              commandId: CommandId.make(randomUUID()),
              messageId: MessageId.make(randomUUID()),
              threadId,
              destination,
              position: "next",
              createdAt: new Date().toISOString(),
            };
          },
          async (command) => {
            const result = await enqueue({ environmentId, input: command });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          lookup,
          isCurrent,
          { allowExisting: destination === undefined },
        );
        if (!isCurrent()) return;
        if (outcome.status === "accepted") {
          setOpen(false);
        } else if (outcome.status === "rejected")
          setError(outcome.detail ?? "The move was rejected.");
      }
      if (isCurrent()) setSaved(await threadMoveSubmissions.read(scope));
    } catch (cause) {
      if (!isCurrent()) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm this move. The saved request is retained.",
      );
      try {
        setSaved(await threadMoveSubmissions.read(scope));
      } catch {
        /* Keep the existing saved request. */
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-initial items-center gap-1" data-composer-context-control>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next && !host.isPending)
            appAtomRegistry.refresh(threadVmControls.hostConfigurationQueryAtom);
        }}
      >
        <PopoverTrigger
          ref={vmUi?.trigger ?? runOnTrigger}
          render={<ComposerControl size="xs" />}
          className="min-w-0"
          aria-label={`Run on: ${label}${currentConfig?.environment.threadVm?.threadId === threadId && vmUi ? ` · ${vmUi.caption}` : ""}`}
          data-composer-shortcut="composer.host"
        >
          <EnvironmentMachineIcon kind={machine} className="size-3 shrink-0" aria-hidden="true" />
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate group-data-[compact]/composer-context:opacity-0"
            >
              {label}
              {currentConfig?.environment.threadVm?.threadId === threadId && vmUi ? (
                <>
                  <span
                    aria-hidden="true"
                    className={`mx-1.5 inline-block size-1.5 rounded-full ${vmUi.tone === "success" ? "bg-success" : vmUi.tone === "danger" ? "bg-destructive" : "bg-muted-foreground"}`}
                  />
                  {vmUi.caption}
                </>
              ) : null}
            </span>
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          width="md"
          padding="compact"
          {...composerFloatingLayerProps}
        >
          <div className="px-1 pb-2 pt-1">
            <PopoverTitle>Run on</PopoverTitle>
          </div>
          <DestinationRow
            label={label}
            detail={
              currentConfig?.environment.threadVm?.threadId === threadId
                ? "Private VM · Current location"
                : "Current location"
            }
            machine={machine}
            current
          />
          {!isVm && currentConfig?.environment.threadVm?.threadId !== threadId ? (
            <DestinationRow
              label="Private VM"
              detail={
                (!blocker && !status && !movePending && !movedAway
                  ? host.unavailableReason
                  : null) ??
                (!blocker && !status && !movePending && !movedAway && !vmSupported && codexSupported
                  ? "Requires the default Codex provider"
                  : "Dedicated to this thread")
              }
              machine="cloud"
              disabled={disabled || !vmSupported || host.unavailableReason !== null}
              onClick={() => void run("send", { kind: "vm" })}
            />
          ) : null}
          {targets
            .filter((target) => target.project.environmentId !== currentEnvironmentId)
            .map((target) => {
              const targetEnvironment = environments.find(
                (item) => item.environmentId === target.project.environmentId,
              );
              return (
                <MachineDestinationRow
                  key={target.key}
                  target={target}
                  environment={targetEnvironment}
                  disabled={disabled}
                  onMove={() => void run("send", target.destination)}
                  onCheck={() => {
                    void reconnect(target.project.environmentId).then((result) => {
                      if (result._tag === "Failure")
                        setError(
                          "Could not connect to this machine. Check its connection settings.",
                        );
                    });
                  }}
                />
              );
            })}
          <ThreadVmMenuActions onAction={() => setOpen(false)} />
          <div className="mt-2 space-y-2 border-t border-border px-1 pb-1 pt-3 text-xs text-muted-foreground">
            {movedAway ? (
              <p role="status">
                This thread moved to {label}. Use Open current location above if it does not open
                automatically.
              </p>
            ) : status ? (
              <>
                <p className={status.warning ? "text-warning-foreground" : undefined} role="status">
                  {detailedProgress && !status.warning ? detailedProgress.label : status.title} →{" "}
                  {destinationLabel(status.destination)}
                </p>
                <p>
                  {detailedProgress && !status.warning ? detailedProgress.label : status.detail}
                </p>
                {detailedProgress?.detail && !status.warning ? (
                  <p>{detailedProgress.detail}</p>
                ) : null}
                {saved ? (
                  <div className="flex flex-wrap gap-2">
                    {saved.rejection ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run("discard")}
                      >
                        Discard rejected move
                      </Button>
                    ) : !saved.accepted ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run("send")}
                      >
                        Retry saved move
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={busy}
                      onClick={() => void run("check")}
                    >
                      Check outcome
                    </Button>
                  </div>
                ) : (
                  <p>Use the queue to cancel, reorder or resume this move.</p>
                )}
              </>
            ) : movePending ? (
              <p role="status">
                {detailedProgress
                  ? `${detailedProgress.label}${detailedProgress.detail ? ` · ${detailedProgress.detail}` : ""}`
                  : "This thread is moving. Wait for the move to finish before choosing another machine."}
              </p>
            ) : blocker ? (
              <>
                <p>{blocker}</p>
                {!session && hasCloudPublicConfig() && relayUrl ? (
                  <SignInForMoves />
                ) : session && thread && config && !thread.archivedAt && unavailable ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => void reconnect(environmentId)}
                  >
                    Reconnect
                  </Button>
                ) : session &&
                  thread &&
                  config &&
                  !thread.archivedAt &&
                  !unavailable &&
                  config?.environment.capabilities.threadMoves === false &&
                  codexSupported ? (
                  <ConnectForMoves environmentId={environmentId} />
                ) : session &&
                  thread &&
                  config &&
                  !thread.archivedAt &&
                  !unavailable &&
                  detailReady &&
                  !canonicalKey &&
                  codexSupported &&
                  !isVm &&
                  config?.environment.capabilities.threadMoves === true ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => void navigate({ to: "/settings/organization" })}
                  >
                    Organization settings
                  </Button>
                ) : null}
              </>
            ) : (
              <p>
                {busy
                  ? "Saving move…"
                  : "Choose a machine to move this thread. Moves next when the queue can run; reorder it in the queue to move later."}
              </p>
            )}
            {visibleError ? (
              <p role="alert" className="text-destructive">
                {visibleError}
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      {movedAway ? (
        <span role="status" className="text-xs text-muted-foreground">
          Moved
        </span>
      ) : visibleError ? (
        <Tooltip>
          <TooltipTrigger
            render={<span role="status" />}
            className="max-w-48 truncate text-xs text-destructive"
          >
            Move needs attention
          </TooltipTrigger>
          <TooltipPopup>{visibleError}</TooltipPopup>
        </Tooltip>
      ) : status ? (
        <Tooltip>
          <TooltipTrigger
            render={<span role="status" />}
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          >
            <ArrowRightIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="max-w-48 truncate">
              {status.title} → {destinationLabel(status.destination)}
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {status.title} → {destinationLabel(status.destination)}. {status.detail}
          </TooltipPopup>
        </Tooltip>
      ) : movePending ? (
        <span role="status" className="truncate text-xs text-muted-foreground">
          {detailedProgress?.label ?? "Moving thread…"}
        </span>
      ) : null}
    </div>
  );
}

export function ThreadRunOnPicker(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const session = useAtomValue(managedRelaySessionAtom);
  return (
    <RunOnPicker
      key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.threadId}`}
      {...props}
    />
  );
}
