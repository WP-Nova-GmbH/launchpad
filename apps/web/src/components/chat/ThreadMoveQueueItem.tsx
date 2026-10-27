import { randomUUID } from "../../lib/utils";
import { createThreadMoveCancellation } from "@t3tools/client-runtime/relay/threadMoveSubmission";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  threadMoveQueuePresentation,
  threadMoveQueueOwnership,
} from "@t3tools/client-runtime/relay/threadMoveQueuePresentation";
import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ThreadMoveQueueEntry,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import { ArrowRightIcon, CheckIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useEnvironments } from "../../state/environments";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { portableThreadLibrary, threadVmControls } from "../../state/threads";
import { Button } from "../ui/button";
import { useThreadVmUi, useThreadMovePlacement } from "./ThreadVmControls";
export { useThreadMovePlacement } from "./ThreadVmControls";

/** The same queue item is used in live chat and retained conversation history. */
export function ThreadMoveQueueItem({
  environmentId,
  threadId,
  entry,
  placement: knownPlacement,
  cancellation,
  queuePaused,
  disabled,
  onCancel,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry?: ThreadMoveQueueEntry | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  cancellation?: "sending" | "requested" | "unknown" | undefined;
  queuePaused?: boolean | undefined;
  disabled?: boolean | undefined;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const currentPlacement = useThreadMovePlacement(environmentId, threadId);
  const placement = currentPlacement ?? knownPlacement;
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
    error: view?.error,
  });
  if (!presentation) return null;
  const { label, detail, tone, steps, step, completedSteps, waiting, outbound, cancelling } =
    presentation;
  const machineLabel = (id: string | undefined) =>
    environments.find((item) => item.environmentId === id)?.label ?? "Your machine";
  const sourceEnvironment = environments.find(
    (item) => item.environmentId === (presentation.sourceEnvironmentId ?? environmentId),
  );
  const sourceIsVm = sourceEnvironment?.serverConfig?.environment.threadVm?.threadId === threadId;
  const source = entry
    ? sourceIsVm
      ? "Private VM"
      : (sourceEnvironment?.label ?? "Current location")
    : "Current location";
  const destination = entry
    ? outbound
      ? "Private VM"
      : machineLabel(
          entry.destination.kind === "environment" ? entry.destination.environmentId : undefined,
        )
    : "New location";
  const SourceIcon = sourceIsVm ? ServerIcon : LaptopIcon;
  const DestinationIcon = outbound ? ServerIcon : LaptopIcon;
  return (
    <div
      className="my-1 rounded-xl border border-border/70 bg-card/40 px-3 py-3 text-xs"
      aria-label="Thread move"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          <SourceIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-words">{source}</span>
          <ArrowRightIcon aria-label="to" className="size-3.5 shrink-0 text-muted-foreground" />
          <DestinationIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-words">{destination}</span>
        </div>
        {entry && onCancel && (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled || cancelling}
            onClick={onCancel}
          >
            {cancelling
              ? "Cancelling…"
              : cancellation === "unknown"
                ? "Retry cancellation"
                : "Cancel move"}
          </Button>
        )}
      </div>
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-2"
        role="status"
        aria-live="polite"
      >
        <div className="min-w-0 flex-1">
          <p className={tone === "danger" ? "font-medium text-destructive" : "font-medium"}>
            {label}
          </p>
          {detail && <p className="mt-1 break-words text-muted-foreground">{detail}</p>}
        </div>
        {presentation.ownsNotice &&
          !waiting &&
          !cancelling &&
          ui?.moveAction &&
          tone !== "neutral" && (
            <Button
              size="xs"
              variant="secondary"
              disabled={ui.moveAction.disabled}
              onClick={ui.moveAction.onPress}
            >
              {ui.moveAction.label}
            </Button>
          )}
      </div>
      {!waiting && (
        <ol className="mt-3 grid grid-cols-3 gap-2" aria-label="Move stages">
          {steps.map((name, index) => (
            <li key={name} aria-current={index === step ? "step" : undefined}>
              <div
                aria-hidden
                className={`mb-1.5 h-0.5 rounded-full ${index === step || completedSteps.includes(index) ? "bg-primary" : "bg-foreground/10"}`}
              />
              <span
                className={`flex items-center gap-1 ${index === step ? "text-foreground" : "text-muted-foreground"}`}
              >
                {completedSteps.includes(index) && <CheckIcon aria-hidden className="size-3" />}
                {name}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!waiting && ui?.moveFeedback}
      {waiting && !cancelling && children && (
        <div className="mt-2 flex flex-wrap gap-2">{children}</div>
      )}
    </div>
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
      commandId: CommandId.make(randomUUID()),
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
  placement,
  onChange,
  cancellation,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  queue: ThreadPromptQueue | undefined;
  placement?: RelayPortableThreadPlacement | null | undefined;
  onChange: () => Promise<void>;
  cancellation: ReturnType<typeof useSavedThreadMoveCancellation>;
}) {
  const fallback = threadMoveQueueOwnership({ entries: queue?.entries, placement }).fallback;
  return (
    <>
      {fallback && (
        <ThreadMoveQueueItem
          environmentId={environmentId}
          threadId={threadId}
          placement={placement}
        />
      )}
      {queue?.entries.map((entry) =>
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
          <div
            key={entry.messageId}
            className="flex items-start justify-between gap-3 py-2 text-sm"
          >
            <p className="whitespace-pre-wrap break-words">{entry.text || "Attachments"}</p>
            <span className="text-xs text-muted-foreground">{entry.state}</span>
          </div>
        ),
      )}
      {cancellation.error && (
        <p role="alert" className="text-xs text-destructive">
          {cancellation.error}
        </p>
      )}
    </>
  );
}
