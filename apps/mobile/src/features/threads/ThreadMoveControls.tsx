import { workflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import { portableThreadPlacementsAtom } from "@t3tools/client-runtime/relay/portableThreadPresentation";
import { MovedThreadDraftRecovery } from "./MovedThreadDraftRecovery";
import { threadMoveProgressPresentation } from "@t3tools/client-runtime/relay/threadVmControls";
import {
  handoffMovedThreadDraft,
  type MovedThreadDraftConflict,
} from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { ThreadVmMenuActions, ThreadVmRefreshButton, useThreadVmUi } from "./ThreadVmControls";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  threadMoveProjectTargets,
  threadMoveProjectTargetAvailability,
  threadMoveOriginalLocationBlocker,
  threadMoveRepositoryCanonicalKey,
  threadMoveProviderSupported,
  threadWorkflowMoveBlocker,
  type ThreadMoveSubmission,
} from "@t3tools/client-runtime/relay/threadMoveSubmission";
import {
  recoverThreadMove,
  threadMoveObservation,
  threadMoveSnapshotReached,
} from "@t3tools/client-runtime/relay/threadMoveRecovery";
import { threadRunOnStatus } from "@t3tools/client-runtime/relay/threadRunOn";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadMoveDestination,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ContextSheetSize } from "../../components/ContextSheetSize";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { MaterialListRow } from "../../components/MaterialListRow";
import { threadMoveSubmissions, threadMoveRelayUrl } from "../../state/thread-move-submissions";
import {
  environmentThreadDetails,
  openPortableThreadChat,
  threadEnvironment,
  threadVmControls,
} from "../../state/threads";
import { environmentProjects } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import {
  useEnvironments,
  useEnvironmentConnectionState,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { environmentCatalog } from "../../connection/catalog";

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
  const navigation = useNavigation();
  const route = useRoute();
  const [attempt, setAttempt] = useState(0),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [draftConflict, setDraftConflict] = useState<MovedThreadDraftConflict | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const draftChoice = useRef<
    { use: "source" | "destination"; conflict: MovedThreadDraftConflict } | undefined
  >(undefined);
  const mounted = useRef(true);
  const destinationId = state?.destination?.environmentId,
    generation = state?.destination?.generation;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled && appAtomRegistry.get(managedRelaySessionAtom) === session) {
        setChecking(false);
        setError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session]);
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
            sourceKey: scopedThreadKey(environmentId, threadId),
            destinationKey: scopedThreadKey(result.value.environmentId, threadId),
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
          navigation.navigate("Thread", {
            ...result.value,
            workflowOrigin:
              workflowResultOrigin(route.params, session.accountId, threadId) ?? undefined,
          });
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
    route.params,
    destinationId,
    generation,
    session,
    relayUrl,
    environmentId,
    threadId,
    checking,
    attempt,
    open,
    navigation,
  ]);
  if (
    !state ||
    (!recoverUnavailable && !state.recoveryRequested && !state.destination && !state.error)
  )
    return null;
  const diagnostic = error ?? state.error;
  if (!recoverUnavailable && state.movePending && !diagnostic && !draftConflict && !busy)
    return null;
  const pending = checking || state.isPending;
  const unavailable = !busy && !pending && !state.movePending && !state.destination;
  const disabled = busy || pending || !!draftConflict || !session || !relayUrl;
  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-3 my-2 flex-row items-start gap-3 rounded-xl border border-border bg-muted/20 p-3"
    >
      <View className="h-5 justify-center">
        <SymbolView
          name={diagnostic || unavailable ? "exclamationmark.triangle" : "arrow.clockwise"}
          size={18}
          tintColorClassName={
            diagnostic || unavailable ? "accent-warning-foreground" : "accent-icon-muted"
          }
        />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-t3-medium">
          {busy
            ? "Opening thread…"
            : pending
              ? "Checking thread location…"
              : state.movePending
                ? "Thread is moving"
                : state.destination
                  ? diagnostic
                    ? "Can’t open thread"
                    : "Thread location found"
                  : "Can’t check thread location"}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {busy
            ? "Connecting to the thread’s current location."
            : pending
              ? "Waiting for the latest thread status."
              : state.movePending
                ? "Check again when the move finishes."
                : state.destination
                  ? "Open this thread’s current location to continue."
                  : "We couldn’t verify where this thread is running."}
        </Text>
        {diagnostic ? (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Thread location details"
              accessibilityState={{ expanded: detailsOpen }}
              className="min-h-11 flex-row items-center gap-1 self-start"
              onPress={() => setDetailsOpen((value) => !value)}
            >
              <Text className="text-xs text-muted-foreground">Details</Text>
              <SymbolView
                name={detailsOpen ? "chevron.down" : "chevron.right"}
                size={12}
                tintColorClassName="accent-icon-muted"
              />
            </Pressable>
            {detailsOpen ? (
              <View className="mb-2 border-l border-border pl-3">
                <Text selectable className="text-xs text-muted-foreground">
                  {diagnostic}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {draftConflict ? (
          <View className="gap-2 py-2">
            <Text className="text-sm font-semibold">Both locations have an unsent draft</Text>
            <Text className="text-xs">
              Choose which draft to open. The other stays saved at the previous location.
            </Text>
            {(["source", "destination"] as const).map((use) => (
              <Pressable
                key={use}
                accessibilityRole="button"
                className="gap-1 rounded-lg border border-border p-3"
                onPress={() => {
                  draftChoice.current = { use, conflict: draftConflict };
                  setDraftConflict(null);
                  setAttempt((value) => value + 1);
                }}
              >
                <Text numberOfLines={3} className="text-xs">
                  {draftConflict[use].text || "Attachments and context"}
                </Text>
                <Text className="text-sm text-primary">
                  {use === "source" ? "Use incoming draft" : "Keep destination draft"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled, busy: busy || pending }}
          className="mt-2 min-h-11 flex-row items-center gap-2 self-start rounded-lg border border-border bg-subtle px-3 py-2"
          style={{ opacity: disabled ? 0.5 : 1 }}
          onPress={async () => {
            if (busy || checking || !session || !relayUrl) return;
            setChecking(true);
            setError(null);
            setDetailsOpen(false);
            try {
              const result = await checkLocation({
                environmentId,
                threadId,
                accountId: session.accountId,
                relayUrl,
              });
              if (!mounted.current || appAtomRegistry.get(managedRelaySessionAtom) !== session)
                return;
              if (result._tag === "Failure") {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not confirm this thread’s current location.",
                );
              } else setAttempt((value) => value + 1);
            } catch (cause) {
              if (mounted.current && appAtomRegistry.get(managedRelaySessionAtom) === session)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not confirm this thread’s current location.",
                );
            } finally {
              if (mounted.current && appAtomRegistry.get(managedRelaySessionAtom) === session)
                setChecking(false);
            }
          }}
        >
          <SymbolView name="arrow.clockwise" size={14} tintColorClassName="accent-icon" />
          <Text className="text-sm font-t3-medium">
            {busy
              ? "Opening…"
              : pending
                ? "Checking…"
                : state.movePending
                  ? "Check status"
                  : state.destination && !diagnostic
                    ? "Open thread"
                    : "Retry"}
          </Text>
        </Pressable>
      </View>
    </View>
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
      <MovedThreadDraftRecovery environmentId={props.environmentId} threadId={props.threadId} />
      <FollowThreadLocation
        key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.threadId}:${props.recoverUnavailable === true}`}
        {...props}
      />
    </>
  );
}

function Action({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-xl bg-subtle px-3 py-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
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
  const connection = useEnvironmentConnectionState(target.destination.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(target.destination.environmentId));
  const availability = threadMoveProjectTargetAvailability(target, {
    phase: environment?.connection.phase,
    failureReason: connection.data?.lastFailure?.reason,
    registered: environment !== undefined,
    enabled: environment?.entry.enabled === true,
    projectsReady: shell.status === "live" && Option.isSome(shell.snapshot),
  });
  return (
    <MaterialListRow
      title={
        environment?.serverConfig?.environment.label ??
        environment?.label ??
        (target.original ? "Original machine" : "Machine")
      }
      subtitle={
        availability.detail ??
        (target.project
          ? `${target.project.title}\n${target.project.workspaceRoot}`
          : "Original project")
      }
      accessibilityRole="radio"
      accessibilityState={{ checked: false }}
      leading={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
          size={20}
          tintColorClassName="accent-icon-muted"
        />
      }
      trailing={null}
      disabled={disabled || availability.action === null}
      onPress={availability.action === "check" ? onCheck : onMove}
    />
  );
}

function ThreadMachinePicker({
  environmentId,
  thread,
  unavailable,
  onReconnect,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
  unavailable: boolean;
  onReconnect: () => void;
}) {
  const threadId = thread.id;
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const detailAtom = environmentThreadDetails.stateAtom({ environmentId, threadId });
  const queue = useAtomValue(detailAtom, (state) => Option.getOrNull(state.data)?.promptQueue);
  const detailReady = useAtomValue(
    detailAtom,
    (state) => state.status === "live" && Option.isSome(state.data),
  );
  const providerInstanceId = useAtomValue(
    detailAtom,
    (state) => Option.getOrNull(state.data)?.modelSelection.instanceId,
  );
  const vm = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  const host = useAtomValue(threadVmControls.hostConfigurationAtom);
  const location = useAtomValue(threadVmControls.locationViewAtom(environmentId, threadId));
  const confirmedPlacementAtom = threadVmControls.confirmedLocationAtom(environmentId, threadId);
  const placement = useAtomValue(confirmedPlacementAtom);
  const routeAtom = threadVmControls.routeAtom(environmentId, threadId);
  const route = useAtomValue(routeAtom);
  const currentEnvironmentId = location?.destination?.environmentId ?? environmentId;
  const currentConfig = useAtomValue(serverEnvironment.configValueAtom(currentEnvironmentId));
  const locationKey = location?.destination
    ? `${location.destination.environmentId}:${location.destination.generation}`
    : environmentId;
  const { environments } = useEnvironments();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const source = projects.find(
    (item) => item.environmentId === environmentId && item.id === thread.projectId,
  );
  const canonicalKey = source
    ? threadMoveRepositoryCanonicalKey(source, thread, config?.environment, vm?.data?.status)
    : undefined;
  const targets = source
    ? threadMoveProjectTargets(
        source,
        projects,
        environments,
        canonicalKey,
        placement?.originalLocation,
      )
    : [];
  const reconnect = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const enqueue = useAtomCommand(threadEnvironment.enqueueMove, { reportFailure: false });
  const receipt = useAtomCommand(threadEnvironment.getCommandReceipt, { reportFailure: false });
  const localReceipt = useAtomCommand(threadEnvironment.getLocalCommandReceipt, {
    reportFailure: false,
  });
  const checkLocation = useAtomCommand(threadVmControls.checkLocation, { reportFailure: false });
  const [openedLocation, setOpenedLocation] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<ThreadMoveSubmission | null>(null),
    [ready, setReady] = useState(!session || !relayUrl),
    [error, setError] = useState<string | null>(null),
    [sheetHeight, setSheetHeight] = useState(0);
  const submitting = useRef(false);
  const originalLocationAttempted = useRef(false);
  const signInAfterDismiss = useRef(false);
  const accountId = session?.accountId ?? null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      appAtomRegistry.get(managedRelaySessionAtom) === session &&
      threadMoveRelayUrl() === relayUrl,
    [session, relayUrl],
  );
  const readObservation = useCallback(
    () =>
      isCurrent()
        ? threadMoveObservation(
            environmentId,
            appAtomRegistry.get(detailAtom),
            appAtomRegistry.get(confirmedPlacementAtom),
            appAtomRegistry.get(routeAtom),
          )
        : { entries: [] },
    [isCurrent, detailAtom, confirmedPlacementAtom, routeAtom, environmentId],
  );
  const proofCaughtUp = useAtomValue(detailAtom, (state) =>
    threadMoveSnapshotReached(environmentId, state, saved, route),
  );
  const recoverSaved = useCallback(
    async (submission: ThreadMoveSubmission) => {
      if (!accountId || !relayUrl) return submission;
      const scope = { accountId, relayUrl, environmentId, threadId };
      return recoverThreadMove(threadMoveSubmissions, scope, submission, {
        checkLocation: async () => {
          const result = await checkLocation(scope);
          if (!isCurrent()) throw new Error("Your account or thread changed while checking it.");
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readReceipt: async () => {
          const result = await localReceipt({
            environmentId,
            input: { threadId, commandId: submission.command.commandId },
          });
          if (!isCurrent()) throw new Error("Your account or thread changed while checking it.");
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        readObservation,
        isCurrent,
      });
    },
    [
      accountId,
      relayUrl,
      environmentId,
      threadId,
      checkLocation,
      localReceipt,
      readObservation,
      isCurrent,
    ],
  );
  useEffect(() => {
    let cancelled = false;
    if (!accountId || !relayUrl) return;
    void threadMoveSubmissions.read({ accountId, relayUrl, environmentId, threadId }).then(
      (value) => {
        if (!cancelled && isCurrent()) {
          setSaved(value);
          setReady(true);
        }
      },
      () => {
        if (!cancelled && isCurrent())
          setError("Could not read the saved move. Resolve storage before sending another.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, relayUrl, environmentId, threadId, isCurrent]);
  useEffect(() => {
    if (!saved || !accountId || !relayUrl) return;
    let cancelled = false;
    const detail = appAtomRegistry.get(detailAtom);
    if (
      Option.getOrNull(detail.data)?.promptQueue !== queue ||
      (detail.status === "live" && Option.isSome(detail.data)) !== detailReady ||
      appAtomRegistry.get(confirmedPlacementAtom) !== placement ||
      appAtomRegistry.get(routeAtom) !== route ||
      threadMoveSnapshotReached(environmentId, detail, saved, route) !== proofCaughtUp
    )
      return;
    const observation = readObservation();
    void threadMoveSubmissions
      .observe({ accountId, relayUrl, environmentId, threadId }, saved, observation)
      .then(
        (value) => {
          if (!cancelled && isCurrent()) setSaved(value);
        },
        () => {
          if (!cancelled && isCurrent())
            setError("Could not update the saved move. Check its outcome before retrying.");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    saved,
    accountId,
    relayUrl,
    environmentId,
    threadId,
    queue,
    detailAtom,
    detailReady,
    placement,
    confirmedPlacementAtom,
    route,
    routeAtom,
    proofCaughtUp,
    readObservation,
    isCurrent,
  ]);
  const savedCommandId = saved?.command.commandId;
  const savedRejection = saved?.rejection;
  useEffect(() => {
    if (
      !savedCommandId ||
      savedRejection ||
      !detailReady ||
      route?.phase !== "active" ||
      route.generation === undefined ||
      submitting.current ||
      !accountId ||
      !relayUrl
    )
      return;
    let cancelled = false;
    const scope = { accountId, relayUrl, environmentId, threadId };
    void threadMoveSubmissions
      .read(scope)
      .then((submission) => {
        if (!submission || submission.command.commandId !== savedCommandId || !isCurrent())
          return null;
        return recoverSaved(submission);
      })
      .then(
        (value) => {
          if (!cancelled && isCurrent()) setSaved(value);
        },
        () => {
          if (!cancelled && isCurrent())
            setError("Could not confirm this move. Check its outcome to try again.");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    savedCommandId,
    savedRejection,
    detailReady,
    accountId,
    relayUrl,
    environmentId,
    threadId,
    route?.generation,
    route?.phase,
    recoverSaved,
    isCurrent,
  ]);

  const currentIsVm = currentConfig?.environment.threadVm?.threadId === threadId;
  const currentLabel = currentIsVm
    ? "Private VM"
    : (currentConfig?.environment.label ??
      environments.find((item) => item.environmentId === currentEnvironmentId)?.label ??
      "Environment");
  const selectedProvider = config?.providers.find(
    // Composer settings can name a draft provider that has not run on this thread.
    (provider) => provider.instanceId === providerInstanceId,
  );
  const codexSupported = threadMoveProviderSupported(selectedProvider, "environment");
  const vmSupported = threadMoveProviderSupported(selectedProvider, "vm");
  const originalLocationBlocker = threadMoveOriginalLocationBlocker(
    config?.environment.threadVm?.threadId === threadId,
    placement,
    error ?? location?.error,
  );
  const workflowBlocker = threadWorkflowMoveBlocker(thread);
  const setupBlocker = !relayUrl
    ? "Configure Launchpad Connect in the host app to move threads."
    : !session
      ? "Sign in to Launchpad Connect to move this thread."
      : workflowBlocker
        ? workflowBlocker
        : thread.archivedAt
          ? "Unarchive this thread before moving it."
          : unavailable || !config || !detailReady
            ? "Reconnect this environment to choose another machine."
            : !codexSupported
              ? "Thread moves currently require Codex."
              : config.environment.capabilities.threadMoves !== true
                ? config.environment.capabilities.threadMoves === false
                  ? "Open Launchpad on the host machine to connect this environment for thread moves."
                  : "Update this environment’s server to support queued moves."
                : (originalLocationBlocker ??
                  (!canonicalKey
                    ? "Register this project’s Git repository in the host app first."
                    : null));
  const pendingMove = queue?.entries.find((entry) => entry.kind === "move");
  const outstanding =
    saved !== null ||
    pendingMove !== undefined ||
    location?.movePending === true ||
    location?.destination != null;
  const disabled = busy || !ready || outstanding || setupBlocker !== null;
  const pickerVisible = openedLocation === locationKey;
  const originalLocationEligible =
    config?.environment.threadVm?.threadId === threadId &&
    placement?.originalLocation === undefined &&
    !!session &&
    !!relayUrl &&
    ready &&
    !location?.isPending &&
    !outstanding;
  useEffect(() => {
    if (!pickerVisible) {
      originalLocationAttempted.current = false;
      return;
    }
    if (!originalLocationEligible || originalLocationAttempted.current || !session || !relayUrl)
      return;
    originalLocationAttempted.current = true;
    void Promise.resolve()
      .then(async () => {
        if (!isCurrent()) return;
        setError(null);
        const result = await checkLocation({
          environmentId,
          threadId,
          accountId: session.accountId,
          relayUrl,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      })
      .catch((cause) => {
        if (isCurrent())
          setError(
            cause instanceof Error ? cause.message : "Could not check the original project.",
          );
      });
  }, [
    pickerVisible,
    originalLocationEligible,
    session,
    relayUrl,
    environmentId,
    threadId,
    checkLocation,
    isCurrent,
  ]);
  const vmBlocker = !vmSupported
    ? "Private VMs currently require the default Codex provider."
    : host.unavailableReason;
  const destinationLabel = (destination: ThreadMoveDestination) => {
    if (destination.kind === "vm") return "Private VM";
    const target = projects.find(
      (project) =>
        project.environmentId === destination.environmentId && project.id === destination.projectId,
    );
    const environment = environments.find(
      (item) => item.environmentId === destination.environmentId,
    );
    const label = environment?.serverConfig?.environment.label ?? environment?.label ?? "Machine";
    return target
      ? `${label} / ${target.title} (${target.workspaceRoot})`
      : `${label} / Unavailable project`;
  };
  const presentation = threadRunOnStatus({ queue, saved });
  const visibleError = error ?? location?.moveFailureDetail ?? null;
  const detailedProgress = threadMoveProgressPresentation(location?.placement);
  const progress = location?.moveFailureDetail
    ? "Move needs attention"
    : location?.destination
      ? `Thread moved → ${currentLabel}`
      : detailedProgress && !presentation?.warning
        ? `${detailedProgress.label}${detailedProgress.detail ? ` · ${detailedProgress.detail}` : ""}`
        : presentation
          ? `${presentation.title}${presentation.destination ? ` → ${destinationLabel(presentation.destination)}` : ""}`
          : location?.movePending
            ? "Moving thread…"
            : null;
  const ensureCurrent = () => {
    if (!isCurrent())
      throw new Error("Your account changed. Reopen this thread to check the move.");
  };
  const lookup = async (command: ThreadMoveSubmission["command"]) => {
    const result = await receipt({
      environmentId,
      input: { threadId, commandId: command.commandId },
    });
    ensureCurrent();
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const run = async (kind: "send" | "check" | "discard", destination?: ThreadMoveDestination) => {
    if (submitting.current || !session || !relayUrl || !ready) return;
    // A selected row creates a new move; recovery always uses the exact saved intent.
    if (destination && (disabled || (destination.kind === "vm" && vmBlocker))) return;
    if (kind === "send" && !destination && !saved) return;
    const scope = {
      accountId: session.accountId,
      relayUrl,
      environmentId,
      threadId,
      sourceGeneration: thread.relayRouting?.generation,
    };
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (kind === "discard") await threadMoveSubmissions.discardRejected(scope);
      else {
        const outcome =
          kind === "check" && saved
            ? await threadMoveSubmissions.reconcile(scope, saved, await lookup(saved.command))
            : await threadMoveSubmissions.submit(
                scope,
                () => {
                  if (!destination) throw new Error("Choose a destination for this repository.");
                  return {
                    type: "thread.move.enqueue",
                    commandId: CommandId.make(Crypto.randomUUID()),
                    messageId: MessageId.make(Crypto.randomUUID()),
                    threadId,
                    destination,
                    position: "next",
                    createdAt: new Date().toISOString(),
                  };
                },
                async (command) => {
                  const result = await enqueue({ environmentId, input: command });
                  ensureCurrent();
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  return result.value;
                },
                lookup,
                isCurrent,
                { allowExisting: destination === undefined },
              );
        ensureCurrent();
        if (outcome.status === "unknown")
          setError("Acceptance is unknown. This move remains saved; retry uses the same IDs.");
        else if (outcome.status === "rejected")
          setError(outcome.detail ?? "The move was rejected.");
        else setOpenedLocation(null);
        if (kind === "check" && saved && outcome.status !== "rejected") await recoverSaved(saved);
      }
      ensureCurrent();
      const value = await threadMoveSubmissions.read(scope);
      ensureCurrent();
      setSaved(value);
      if (kind === "check") {
        if (value?.rejection) setError(value.rejection);
        else if (!value || value.accepted || value.executionProof) setError(null);
      }
    } catch (cause) {
      if (!isCurrent()) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm this move. The saved request is retained.",
      );
      try {
        const value = await threadMoveSubmissions.read(scope);
        if (isCurrent()) setSaved(value);
      } catch {
        /* Keep the visible draft. */
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const vmUi = useThreadVmUi();
  const pendingVmAction = useRef<(() => void) | null>(null);
  const close = () => setOpenedLocation(null);
  const openSignIn = () =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsAuth",
    });
  const setup = () => {
    if (!session && hasCloudPublicConfig()) {
      signInAfterDismiss.current = Platform.OS === "ios";
      close();
      if (Platform.OS !== "ios") openSignIn();
    } else if (unavailable) {
      close();
      onReconnect();
    } else
      Alert.alert(
        "Set up thread moves",
        setupBlocker ??
          (vmBlocker
            ? `${vmBlocker}. Configure the VM host in the relay on your computer, then reopen Run on.`
            : "Manage this environment from Launchpad on its host machine."),
      );
  };
  const currentIcon = (
    <EnvironmentMachineSymbol
      kind={resolveEnvironmentMachineKind(currentConfig)}
      size={20}
      tintColorClassName="accent-icon-muted"
    />
  );
  return (
    <View className="gap-1 px-3 py-1">
      <ComposerInlineControl
        accessibilityLabel={`Run on: ${currentLabel}${currentIsVm && vmUi ? ` · ${vmUi.caption}` : ""}`}
        accessibilityHint="Choose where this thread runs"
        label={currentIsVm && vmUi ? `${currentLabel} · ${vmUi.caption}` : currentLabel}
        maxWidth="100%"
        iconNode={currentIcon}
        onPress={() => {
          Keyboard.dismiss();
          if (!host.isPending) appAtomRegistry.refresh(threadVmControls.hostConfigurationQueryAtom);
          setOpenedLocation(locationKey);
        }}
      />
      {progress ? (
        <Text accessibilityLiveRegion="polite" className="px-2 text-xs text-foreground-muted">
          {progress}
        </Text>
      ) : null}
      <Modal
        // A placement change dismisses this sheet before the route follower navigates.
        visible={pickerVisible}
        animationType="slide"
        presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
        transparent={Platform.OS === "android"}
        onRequestClose={close}
        onDismiss={() => {
          const action = pendingVmAction.current;
          pendingVmAction.current = null;
          action?.();
          if (!signInAfterDismiss.current) return;
          signInAfterDismiss.current = false;
          openSignIn();
        }}
      >
        <View className={Platform.OS === "android" ? "flex-1 justify-end bg-backdrop" : "flex-1"}>
          {Platform.OS === "android" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Run on"
              onPress={close}
              style={{ position: "absolute", inset: 0 }}
            />
          ) : null}
          <View
            className="overflow-hidden rounded-t-3xl bg-sheet-solid"
            style={Platform.OS === "android" ? { maxHeight: "90%" } : { flex: 1 }}
          >
            <ContextSheetSize height={sheetHeight} />
            <ScrollView
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={(_width, height) => setSheetHeight(height)}
              contentContainerStyle={{
                padding: 16,
                paddingBottom: Math.max(20, insets.bottom),
                gap: 16,
              }}
            >
              <View className="flex-row items-center justify-between">
                <Text
                  accessibilityRole="header"
                  className="text-lg font-t3-semibold text-foreground"
                >
                  Run on
                </Text>
                <View className="flex-row items-center">
                  <ThreadVmRefreshButton />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close Run on"
                    onPress={close}
                    className="min-h-11 min-w-11 items-center justify-center"
                  >
                    <SymbolView name="xmark" size={18} tintColorClassName="accent-icon-muted" />
                  </Pressable>
                </View>
              </View>
              <View className="overflow-hidden rounded-2xl">
                <MaterialListRow
                  title={currentLabel}
                  subtitle="Current location"
                  accessibilityRole="radio"
                  accessibilityState={{ checked: true }}
                  leading={currentIcon}
                  trailing={
                    <SymbolView name="checkmark" size={20} tintColorClassName="accent-focus" />
                  }
                  onPress={() => {}}
                />
                {!currentIsVm ? (
                  <MaterialListRow
                    title="Private VM"
                    subtitle={
                      setupBlocker
                        ? "Dedicated to this thread"
                        : (vmBlocker ?? "Dedicated to this thread")
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ checked: false }}
                    leading={
                      <SymbolView name="cube" size={20} tintColorClassName="accent-icon-muted" />
                    }
                    trailing={null}
                    disabled={disabled || vmBlocker !== null}
                    onPress={() => void run("send", { kind: "vm" })}
                  />
                ) : null}
                {targets
                  .filter((target) => target.destination.environmentId !== currentEnvironmentId)
                  .map((target) => {
                    const environment = environments.find(
                      (item) => item.environmentId === target.destination.environmentId,
                    );
                    return (
                      <MachineDestinationRow
                        key={target.key}
                        target={target}
                        environment={environment}
                        disabled={disabled}
                        onMove={() => void run("send", target.destination)}
                        onCheck={() => {
                          void reconnect(target.destination.environmentId).then((result) => {
                            if (result._tag === "Failure")
                              setError(
                                "Could not connect to this machine. Check its connection settings.",
                              );
                          });
                        }}
                      />
                    );
                  })}
              </View>
              <ThreadVmMenuActions
                onAction={(action) => {
                  close();
                  if (Platform.OS === "ios")
                    pendingVmAction.current = () => {
                      if (isCurrent()) action();
                    };
                  else action();
                }}
              />
              <Text className="text-sm text-foreground-muted">
                {outstanding
                  ? "Resolve the current move before choosing another machine."
                  : "Choose a machine to move this thread. It runs after the current turn, ahead of waiting prompts."}
              </Text>
              {presentation || location?.movePending || location?.destination ? (
                <View accessibilityLiveRegion="polite" className="gap-2 rounded-2xl bg-subtle p-3">
                  <Text className="text-sm font-t3-medium text-foreground">{progress}</Text>
                  {location?.destination ? (
                    <Text className="text-sm text-foreground-muted">
                      Open this thread’s current location to continue.
                    </Text>
                  ) : presentation?.detail ? (
                    <Text className="text-sm text-foreground-muted">{presentation.detail}</Text>
                  ) : null}
                  {location?.destination ? (
                    <Action label="Show location recovery" onPress={close} />
                  ) : pendingMove ? (
                    <Action label="Manage in shared queue" onPress={close} />
                  ) : saved ? (
                    <View className="gap-2">
                      {saved.rejection ? (
                        <Action
                          label="Discard rejected request"
                          disabled={busy}
                          onPress={() => void run("discard")}
                        />
                      ) : !saved.accepted ? (
                        <Action
                          label="Retry saved move"
                          disabled={busy || !ready}
                          onPress={() => void run("send")}
                        />
                      ) : null}
                      <Action
                        label="Check outcome"
                        disabled={busy || !ready}
                        onPress={() => void run("check")}
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
              {!outstanding && setupBlocker ? (
                <View className="gap-2 rounded-2xl bg-subtle p-3">
                  <Text className="text-sm text-foreground">{setupBlocker}</Text>
                  <Action
                    label={
                      !session && hasCloudPublicConfig()
                        ? "Sign in to Launchpad Connect"
                        : unavailable
                          ? "Reconnect environment"
                          : "View setup instructions"
                    }
                    onPress={setup}
                  />
                </View>
              ) : !outstanding && !currentIsVm && vmBlocker && !host.isPending ? (
                <Action label="View VM setup instructions" onPress={setup} />
              ) : null}
              {visibleError ? (
                <Text accessibilityRole="alert" className="text-sm text-destructive">
                  {visibleError}
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export const ThreadRunOnControl = memo(function ThreadRunOnControl(props: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
  unavailable: boolean;
  onReconnect: () => void;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  return (
    <ThreadMachinePicker
      key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.thread.id}`}
      {...props}
    />
  );
});
