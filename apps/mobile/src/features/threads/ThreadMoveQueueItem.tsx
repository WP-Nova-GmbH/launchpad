import * as Crypto from "expo-crypto";
import { createThreadMoveCancellation } from "@t3tools/client-runtime/relay/threadMoveSubmission";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  activeThreadMove,
  threadMoveQueuePresentation,
  threadMoveQueueRows,
} from "@t3tools/client-runtime/relay/threadMoveQueuePresentation";
import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ThreadMoveQueueEntry,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import type {
  RelayPortableThreadPlacement,
  ThreadMoveFailureDiagnostic,
} from "@t3tools/contracts/relay";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useEnvironments } from "../../state/environments";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { portableThreadLibrary, threadVmControls } from "../../state/threads";
import { useThreadVmUi, useThreadMovePlacement } from "./ThreadVmControls";
export { useThreadMovePlacement } from "./ThreadVmControls";

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean | undefined;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg px-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-xs text-foreground-muted">{label}</Text>
    </Pressable>
  );
}

function PreviousMoveErrors({ errors }: { errors: ReadonlyArray<ThreadMoveFailureDiagnostic> }) {
  const [expanded, setExpanded] = useState(false);
  const label = errors.length === 1 ? "Previous error" : "Previous errors";
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 justify-center"
      >
        <Text className="text-xs text-foreground-muted">{label}</Text>
      </Pressable>
      {expanded &&
        errors.map((failure) => (
          <Text
            key={`${failure.environmentId}:${failure.generation}:${failure.attempt}`}
            className="text-xs text-foreground-muted"
          >
            {failure.detail}
          </Text>
        ))}
    </View>
  );
}

type ActiveMove = NonNullable<RelayPortableThreadPlacement["activeMove"]>;

function useActiveMoveActions(threadId: ThreadId, move: ActiveMove) {
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const scope = useMemo(
    () => ({
      session,
      relayUrl,
      threadId,
      operationId: move.operationId,
      generation: move.sourceGeneration,
    }),
    [session, relayUrl, threadId, move.operationId, move.sourceGeneration],
  );
  const current = useRef<typeof scope | null>(null);
  useLayoutEffect(() => {
    current.current = scope;
    return () => {
      current.current = null;
    };
  }, [scope]);
  const sending = useRef<typeof scope | null>(null);
  const [feedback, setFeedback] = useState<{
    scope: typeof scope;
    phase: "sending" | "requested" | "confirmed" | "unknown";
    checking?: boolean;
    error?: string;
  } | null>(null);
  const cancelMove = useAtomCommand(portableThreadLibrary.cancelActiveMove, {
    reportFailure: false,
  });
  const checkMove = useAtomCommand(portableThreadLibrary.checkMoveCancellation, {
    reportFailure: false,
  });
  const retryMove = useAtomCommand(portableThreadLibrary.retryActiveMove, {
    reportFailure: false,
  });
  const retrySending = useRef<{ scope: typeof scope; attempt: number } | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<{
    scope: typeof scope;
    attempt: number;
    phase: "sending" | "accepted" | "failed";
    error?: string;
  } | null>(null);
  const failedAttempt = move.retryRequiredAttempt;
  const displayedRetry =
    retryFeedback?.scope === scope && retryFeedback.attempt === failedAttempt
      ? retryFeedback
      : null;
  const displayed = feedback?.scope === scope ? feedback : null;
  const displayedPhase = displayed?.phase;
  const confirmedCancelled = displayedPhase === "confirmed";
  const retryLegacy = !confirmedCancelled && move.cancellationBlocker === "legacy_cancel_rejected";
  const cancelling = move.phase === "aborting" || move.phase === "reopening";
  const canCancel =
    move.phase === "preparing" || move.phase === "frozen" || move.phase === "ready" || retryLegacy;
  const acknowledgedPhase = confirmedCancelled ? "confirmed" : "requested";
  const shouldCheck =
    !retryLegacy && (cancelling || confirmedCancelled || displayed?.phase === "requested");
  const submit = async () => {
    if (!session || !relayUrl || current.current !== scope || sending.current === scope) return;
    const input = {
      accountId: session.accountId,
      relayUrl,
      threadId,
      operationId: move.operationId,
      sourceGeneration: move.sourceGeneration,
    };
    sending.current = scope;
    setFeedback(
      shouldCheck
        ? { scope, phase: acknowledgedPhase, checking: true }
        : { scope, phase: "sending" },
    );
    const reportFailure = (error: unknown) => {
      setFeedback({
        scope,
        phase: shouldCheck ? acknowledgedPhase : "unknown",
        error: error instanceof Error ? error.message : "Could not confirm cancellation.",
      });
    };
    const acknowledge = (reply: ActiveMove) =>
      setFeedback({ scope, phase: reply.phase === "aborted" ? "confirmed" : acknowledgedPhase });
    try {
      const result = await (shouldCheck ? checkMove : cancelMove)(input);
      if (current.current !== scope) return;
      if (result._tag === "Success") {
        acknowledge(result.value);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (shouldCheck) {
        reportFailure(failure);
        return;
      }
      const checked = await checkMove(input);
      if (current.current !== scope) return;
      if (
        checked._tag === "Success" &&
        ["aborting", "reopening", "aborted"].includes(checked.value.phase)
      )
        acknowledge(checked.value);
      else reportFailure(failure);
    } catch (error) {
      if (current.current === scope) reportFailure(error);
    } finally {
      if (sending.current === scope) sending.current = null;
    }
  };
  const retryAvailable =
    session &&
    relayUrl &&
    failedAttempt !== undefined &&
    canCancel &&
    !retryLegacy &&
    !displayedPhase;
  const retry = async () => {
    if (
      !retryAvailable ||
      current.current !== scope ||
      displayedRetry?.phase === "accepted" ||
      (retrySending.current?.scope === scope && retrySending.current.attempt === failedAttempt)
    )
      return;
    const ticket = { scope, attempt: failedAttempt };
    retrySending.current = ticket;
    setRetryFeedback({ ...ticket, phase: "sending" });
    const isCurrent = () => current.current === scope && retrySending.current === ticket;
    try {
      const result = await retryMove({
        accountId: session.accountId,
        relayUrl,
        threadId,
        operationId: move.operationId,
        sourceGeneration: move.sourceGeneration,
        failedAttempt,
      });
      if (!isCurrent()) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setRetryFeedback({ ...ticket, phase: "accepted" });
    } catch (error) {
      if (isCurrent())
        setRetryFeedback({
          ...ticket,
          phase: "failed",
          error: error instanceof Error ? error.message : "Could not confirm the retry.",
        });
    } finally {
      if (retrySending.current === ticket) retrySending.current = null;
    }
  };
  const pending = displayed?.checking || displayed?.phase === "sending";
  return {
    retryAction: retryAvailable
      ? {
          label:
            displayedRetry?.phase === "accepted"
              ? "Retry requested"
              : displayedRetry?.phase === "sending"
                ? "Requesting retry…"
                : "Retry move",
          pending: displayedRetry?.phase === "sending" || displayedRetry?.phase === "accepted",
          onPress: () => void retry(),
        }
      : undefined,
    retryError: retryAvailable ? displayedRetry?.error : undefined,
    action:
      session && relayUrl && (canCancel || cancelling)
        ? {
            label: shouldCheck
              ? pending
                ? "Checking…"
                : "Check status"
              : pending
                ? "Cancelling…"
                : retryLegacy || displayed?.phase === "unknown"
                  ? "Retry cancellation"
                  : "Cancel move",
            pending,
            onPress: () => void submit(),
          }
        : undefined,
    confirmedCancelled,
    phase: (canCancel || cancelling) && !confirmedCancelled ? displayedPhase : undefined,
    error: canCancel || cancelling ? displayed?.error : undefined,
  };
}

type ThreadMoveQueueItemProps = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry?: ThreadMoveQueueEntry | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  cancellation?: "sending" | "requested" | "unknown" | undefined;
  queuePaused?: boolean | undefined;
  disabled?: boolean | undefined;
  activeCancellationDisabled?: boolean | undefined;
  onCancel?: (() => void) | undefined;
  children?: ReactNode;
};

/** The same queue item is used in live chat and retained conversation history. */
export function ThreadMoveQueueItem(props: ThreadMoveQueueItemProps) {
  const { environmentId, threadId, entry, placement: knownPlacement } = props;
  const currentPlacement = useThreadMovePlacement(environmentId, threadId);
  const placement = currentPlacement ?? knownPlacement;
  const move = activeThreadMove(placement);
  const activeMove = move && (!entry || entry.operationId === move.operationId) ? move : null;
  return activeMove ? (
    <ActiveThreadMoveQueueItem {...props} placement={placement} move={activeMove} />
  ) : (
    <ThreadMoveQueueItemContent {...props} placement={placement} />
  );
}

function ActiveThreadMoveQueueItem({
  move,
  ...props
}: ThreadMoveQueueItemProps & { move: ActiveMove }) {
  const actions = useActiveMoveActions(props.threadId, move);
  return (
    <ThreadMoveQueueItemContent
      {...props}
      disabled={props.activeCancellationDisabled}
      onCancel={undefined}
      activeCancellationAction={actions.action}
      retryAction={actions.retryAction}
      retryError={actions.retryError}
      cancellation={actions.phase}
      cancellationError={actions.error}
      confirmedCancelled={actions.confirmedCancelled}
    />
  );
}

function ThreadMoveQueueItemContent({
  environmentId,
  threadId,
  entry,
  placement,
  cancellation,
  cancellationError,
  activeCancellationAction,
  retryAction,
  retryError,
  confirmedCancelled,
  queuePaused,
  disabled,
  onCancel,
  children,
}: ThreadMoveQueueItemProps & {
  cancellationError?: string | undefined;
  activeCancellationAction?: ReturnType<typeof useActiveMoveActions>["action"];
  retryAction?: ReturnType<typeof useActiveMoveActions>["retryAction"];
  retryError?: string | undefined;
  confirmedCancelled?: boolean;
}) {
  const view = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  const { environments } = useEnvironments();
  const ui = useThreadVmUi();
  const presentation = threadMoveQueuePresentation({
    entry,
    placement,
    cancellation,
    queuePaused,
    status: view?.data?.status,
    providerAuth: view?.providerAuth,
    providerAuthError: view?.providerAuthError,
    workerAuth: view?.workerAuth,
    error: view?.error,
  });
  if (!presentation) return null;
  const { tone, steps, step, completedSteps, waiting, outbound, cancelling, activeMove } =
    presentation;
  const label = confirmedCancelled ? "Move cancelled" : presentation.label;
  const detail = confirmedCancelled ? "The source has reopened." : presentation.detail;
  const machineLabel = (id: string | undefined) =>
    environments.find((item) => item.environmentId === id)?.label ?? "Your machine";
  const sourceEnvironment = environments.find(
    (item) => item.environmentId === (presentation.sourceEnvironmentId ?? environmentId),
  );
  const sourceIsVm =
    presentation.sourceIsVm ??
    sourceEnvironment?.serverConfig?.environment.threadVm?.threadId === threadId;
  const source =
    entry || activeMove
      ? sourceIsVm
        ? "Private VM"
        : (sourceEnvironment?.label ?? "Current location")
      : "Current location";
  const destinationId =
    activeMove?.destinationEnvironmentId ??
    (entry?.destination.kind === "environment" ? entry.destination.environmentId : undefined);
  const destination =
    entry || activeMove ? (outbound ? "Private VM" : machineLabel(destinationId)) : "New location";
  const cancelAction =
    activeCancellationAction ??
    (onCancel
      ? {
          label: cancelling
            ? "Cancelling…"
            : cancellation === "unknown"
              ? "Retry cancellation"
              : "Cancel move",
          pending: cancelling,
          onPress: onCancel,
        }
      : undefined);
  return (
    <View
      className="my-1 gap-3 rounded-xl border border-border bg-card p-3"
      accessibilityLabel="Thread move"
    >
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
          <SymbolView name={sourceIsVm ? "server.rack" : "laptopcomputer"} size={14} />
          <Text className="text-xs font-medium text-foreground">{source}</Text>
          <Text accessibilityLabel="to" className="text-foreground-muted">
            →
          </Text>
          <SymbolView name={outbound ? "server.rack" : "laptopcomputer"} size={14} />
          <Text className="text-xs font-medium text-foreground">{destination}</Text>
        </View>
        {cancelAction && (
          <Action
            label={cancelAction.label}
            disabled={disabled || cancelAction.pending}
            onPress={cancelAction.onPress}
          />
        )}
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="min-w-0 flex-1 gap-1" accessibilityLiveRegion="polite">
          <Text
            className={
              !confirmedCancelled && tone === "danger"
                ? "text-xs font-medium text-destructive"
                : "text-xs font-medium text-foreground"
            }
          >
            {label}
          </Text>
          {detail && <Text className="text-xs text-foreground-muted">{detail}</Text>}
          {(cancellationError ?? retryError) && (
            <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">
              {cancellationError ?? retryError}
            </Text>
          )}
        </View>
        {retryAction && (
          <Action
            label={retryAction.label}
            disabled={disabled || retryAction.pending}
            onPress={retryAction.onPress}
          />
        )}
        {presentation.ownsNotice &&
          !waiting &&
          !cancelling &&
          !confirmedCancelled &&
          activeMove?.retryRequiredAttempt === undefined &&
          activeMove?.retryRequestedAttempt === undefined &&
          ui?.moveAction && (
            <Action
              label={ui.moveAction.label}
              disabled={ui.moveAction.disabled}
              onPress={ui.moveAction.onPress}
            />
          )}
      </View>
      {!waiting && !confirmedCancelled && (
        <View className="flex-row gap-2" accessibilityLabel="Move stages">
          {steps.map((name, index) => (
            <View key={name} className="flex-1 gap-1.5">
              <View
                className={`h-0.5 rounded-full ${index === step || completedSteps.includes(index) ? "bg-primary" : "bg-foreground/10"}`}
              />
              <Text
                className={
                  index === step ? "text-xs text-foreground" : "text-xs text-foreground-muted"
                }
              >
                {completedSteps.includes(index) ? "✓ " : ""}
                {name}
              </Text>
            </View>
          ))}
        </View>
      )}
      {presentation.previousErrors.length > 0 && (
        <PreviousMoveErrors
          key={`${threadId}:${entry?.operationId ?? placement?.operationId}`}
          errors={presentation.previousErrors}
        />
      )}
      {!waiting && !confirmedCancelled && ui?.moveFeedback}
      {waiting && !cancelling && children && (
        <View className="flex-row flex-wrap gap-2">{children}</View>
      )}
    </View>
  );
}

/** Pending cancellation identity follows the logical thread across environment changes. */
export function useSavedThreadMoveCancellation(threadId: ThreadId) {
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const scope = JSON.stringify([session?.accountId, relayUrl, threadId]);
  const [cancellation] = useState(createThreadMoveCancellation);
  const [, rerender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const currentScope = useRef(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const mounted = useRef(true);
  const dispatch = useAtomCommand(portableThreadLibrary.queueControl, { reportFailure: false });
  const receipt = useAtomCommand(portableThreadLibrary.queueReceipt, { reportFailure: false });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const observe = useCallback(
    (queue: ThreadPromptQueue) => {
      if (!mounted.current || currentScope.current !== scope) return;
      const outcome = cancellation.observe(scope, queue.entries, []);
      if (outcome.changed) rerender((value) => value + 1);
      if (outcome.rejection) setError(outcome.rejection);
    },
    [cancellation, scope],
  );
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const isCurrent = () => !signal.aborted && mounted.current && currentScope.current === scope;
      const pending = cancellation.pending(scope);
      if (pending.length > 0 && isCurrent()) setError(null);
      await Promise.all(
        pending.map(async (command) => {
          try {
            const result = await receipt({ threadId, commandId: command.commandId });
            if (!isCurrent()) return;
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            if (!result.value) return;
            if (result.value.commandId !== command.commandId)
              throw new Error("The relay acknowledged another cancellation request.");
            // Admission without a receipt says nothing about acceptance, including during an active send.
            if (!result.value.receipt) return;
            const outcome = cancellation.acknowledge(scope, command, result.value.receipt);
            if (outcome?.status === "rejected")
              setError(outcome.detail ?? "Cancellation was rejected.");
          } catch (cause) {
            if (isCurrent())
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not check cancellation. The original request is retained.",
              );
          }
        }),
      );
      if (pending.length > 0 && isCurrent()) rerender((value) => value + 1);
    },
    [cancellation, scope, receipt, threadId],
  );
  const cancel = async (entry: ThreadMoveQueueEntry, onChange: () => Promise<void>) => {
    if (!session || !relayUrl || !mounted.current || currentScope.current !== scope) return;
    const command = cancellation.prepare(scope, entry, () => ({
      threadId,
      messageId: entry.messageId,
      expectedRevision: entry.revision,
      commandId: CommandId.make(Crypto.randomUUID()),
      createdAt: new Date().toISOString(),
    }));
    if (!command) return;
    const isCurrent = () => mounted.current && currentScope.current === scope;
    rerender((value) => value + 1);
    setError(null);
    try {
      const result = await dispatch({
        accountId: session.accountId,
        command: { ...command, type: "thread.move.cancel" },
      });
      if (!isCurrent()) return;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const outcome = cancellation.acknowledge(
        scope,
        command,
        result.value.receipt ?? { status: "unknown" },
      );
      if (outcome?.status === "rejected") setError(outcome.detail ?? "Cancellation was rejected.");
      try {
        await onChange();
      } catch {
        if (isCurrent()) setError("The cancellation request is saved. Refresh to check the queue.");
      }
    } catch {
      if (!isCurrent()) return;
      cancellation.failed(scope, command);
      try {
        await onChange();
      } catch {
        if (isCurrent())
          setError("Could not confirm cancellation. Refresh or retry sends the same request.");
      }
    } finally {
      if (isCurrent()) rerender((value) => value + 1);
    }
  };
  return {
    cancel,
    observe,
    refresh,
    error,
    phase: (messageId: string) => cancellation.phase(scope, messageId),
  };
}

export function SavedThreadQueue({
  environmentId,
  threadId,
  queue,
  queueGeneration,
  placement,
  onChange,
  cancellation,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  queue: ThreadPromptQueue | undefined;
  queueGeneration?: number | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  onChange: () => Promise<void>;
  cancellation: ReturnType<typeof useSavedThreadMoveCancellation>;
}) {
  const { entries, fallback } = threadMoveQueueRows({
    entries: queue?.entries,
    placement,
    queueEnvironmentId: environmentId,
    queueGeneration,
  });
  return (
    <View>
      {fallback && (
        <ThreadMoveQueueItem
          environmentId={environmentId}
          threadId={threadId}
          placement={placement}
        />
      )}
      {entries.map((entry) =>
        entry.kind === "move" ? (
          <ThreadMoveQueueItem
            key={entry.messageId}
            environmentId={environmentId}
            threadId={threadId}
            entry={entry}
            placement={placement}
            queuePaused={queue?.enabled === false || queue?.pauseReason != null}
            cancellation={cancellation.phase(entry.messageId)}
            onCancel={() => void cancellation.cancel(entry, onChange)}
          />
        ) : (
          <View key={entry.messageId} className="gap-1 py-2">
            <Text className="text-sm text-foreground">{entry.text || "Attachments"}</Text>
            <Text className="text-xs text-foreground-muted">{entry.state}</Text>
          </View>
        ),
      )}
      {cancellation.error && (
        <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">
          {cancellation.error}
        </Text>
      )}
    </View>
  );
}
