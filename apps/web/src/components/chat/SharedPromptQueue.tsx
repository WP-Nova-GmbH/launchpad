import { threadMoveQueueOwnership } from "@t3tools/client-runtime/relay/threadMoveQueuePresentation";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type ScopedThreadRef,
  type ThreadMoveQueueEntry,
  type ThreadPromptQueue,
  type TurnId,
} from "@t3tools/contracts";
import { ThreadMoveQueueItem, useThreadMovePlacement } from "./ThreadMoveQueueItem";
import { createThreadMoveCancellation } from "@t3tools/client-runtime/relay/threadMoveSubmission";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { portableCommandStatesAtom } from "@t3tools/client-runtime/relay/portableThreads";
import {
  queuedPromptEditConflict,
  moveQueueEntryNext,
  moveQueueEntryLater,
  type QueuedPromptEdit,
} from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { Clock3Icon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedPromptQueueRow } from "./SharedPromptQueueRow";

type SharedPromptQueueProps = {
  threadRef: ScopedThreadRef;
  queue: ThreadPromptQueue;
  activeTurnId: TurnId | null;
  unavailable?: boolean;
  supportsPreparation?: boolean;
  canWorkLocally?: boolean;
};

export function SharedPromptQueue(props: SharedPromptQueueProps) {
  const account = useAtomValue(managedRelaySessionAtom);
  const scope = JSON.stringify([
    account?.accountId ?? null,
    threadMoveRelayUrl(),
    props.threadRef.environmentId,
    props.threadRef.threadId,
  ]);
  return <SharedPromptQueueContent key={scope} {...props} />;
}

function SharedPromptQueueContent({
  threadRef,
  queue,
  activeTurnId,
  unavailable = false,
  supportsPreparation = false,
  canWorkLocally = false,
}: SharedPromptQueueProps) {
  const placement = useThreadMovePlacement(threadRef.environmentId, threadRef.threadId);
  const fallbackMove = threadMoveQueueOwnership({ entries: queue.entries, placement }).fallback;
  const cancelMove = useAtomCommand(threadEnvironment.cancelMove, { reportFailure: false });
  const getCommandReceipt = useAtomCommand(threadEnvironment.getCommandReceipt, {
    reportFailure: false,
  });
  const reorderQueue = useAtomCommand(threadEnvironment.reorderQueue, { reportFailure: false });
  const editPrompt = useAtomCommand(threadEnvironment.editPrompt, { reportFailure: false });
  const removePrompt = useAtomCommand(threadEnvironment.removePrompt, { reportFailure: false });
  const steerPrompt = useAtomCommand(threadEnvironment.steerPrompt, { reportFailure: false });
  const pauseQueue = useAtomCommand(threadEnvironment.pauseQueue, { reportFailure: false });
  const resumeQueue = useAtomCommand(threadEnvironment.resumeQueue, { reportFailure: false });
  const resolveQueue = useAtomCommand(threadEnvironment.resolveQueue, { reportFailure: false });
  const retryPreparation = useAtomCommand(threadEnvironment.retryPreparation, {
    reportFailure: false,
  });
  const account = useAtomValue(managedRelaySessionAtom);
  const portableCommands = useAtomValue(portableCommandStatesAtom);
  const [cancellation] = useState(createThreadMoveCancellation);
  const [, setCancellationRevision] = useState(0);
  const cancellationRelayUrl = threadMoveRelayUrl();
  const cancellationScope = JSON.stringify([
    account?.accountId ?? null,
    cancellationRelayUrl,
    threadRef.environmentId,
    threadRef.threadId,
  ]);
  const mounted = useRef(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [edit, setEdit] = useState<QueuedPromptEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const { changed, rejection } = cancellation.observe(
      cancellationScope,
      queue.entries,
      portableCommands.filter(
        (command) =>
          command.accountId === account?.accountId &&
          normalizeSecureRelayUrl(command.relayUrl) === cancellationRelayUrl &&
          command.environmentId === threadRef.environmentId &&
          command.threadId === threadRef.threadId,
      ),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- Queue projections and command receipts reconcile the external cancellation tracker.
    if (changed) setCancellationRevision((value) => value + 1);
    if (rejection) setError(rejection);
  }, [
    cancellation,
    cancellationScope,
    cancellationRelayUrl,
    queue.entries,
    portableCommands,
    account?.accountId,
    threadRef.environmentId,
    threadRef.threadId,
  ]);
  const editingMessageId = edit?.messageId;
  useLayoutEffect(() => {
    if (editingMessageId) editorRef.current?.focus();
  }, [editingMessageId]);
  const candidate = queue.entries.find((entry) => entry.messageId === edit?.messageId);
  const current = candidate?.kind === "move" ? undefined : candidate;
  const firstMoveIndex = queue.entries.findIndex((entry) => entry.kind === "move");
  const canReorder =
    queue.handoff === null && queue.entries.every((entry) => entry.state === "pending");
  const conflict = edit ? queuedPromptEditConflict(edit, current) : null;
  const disabled = busy || unavailable;
  const preparation = queue.preparation;
  const preparing = preparation !== undefined && preparation.state !== "ready";
  const setupRunning = preparation?.state === "pending" || preparation?.state === "running";
  const run = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    onSuccess?: () => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Success") onSuccess?.();
      else {
        const failure = squashAtomCommandFailure(result);
        setError(
          `${failure instanceof Error ? failure.message : "The request failed."} Your draft is preserved.`,
        );
      }
    } catch {
      setError("The request failed. Your draft is preserved.");
    } finally {
      setBusy(false);
    }
  };
  const input = { threadId: threadRef.threadId };
  const request = <T,>(value: T) => ({ environmentId: threadRef.environmentId, input: value });
  const requestCancellation = async (entry: ThreadMoveQueueEntry) => {
    const isCurrent = () => mounted.current;
    const command = cancellation.prepare(cancellationScope, entry, () => ({
      ...input,
      messageId: entry.messageId,
      expectedRevision: entry.revision,
      commandId: CommandId.make(randomUUID()),
      createdAt: new Date().toISOString(),
    }));
    if (!command) return;
    setCancellationRevision((value) => value + 1);
    setBusy(true);
    setError(null);
    try {
      const result = await cancelMove(request(command));
      if (!isCurrent()) return;
      if (result._tag === "Success") {
        const outcome = cancellation.acknowledge(cancellationScope, command, result.value);
        if (outcome?.status === "rejected")
          setError(outcome.detail ?? "The cancellation request was rejected.");
      } else {
        cancellation.failed(cancellationScope, command);
        const failure = squashAtomCommandFailure(result);
        const receipt = await getCommandReceipt(
          request({ threadId: command.threadId, commandId: command.commandId }),
        );
        if (!isCurrent()) return;
        const outcome =
          receipt._tag === "Success"
            ? cancellation.acknowledge(cancellationScope, command, receipt.value)
            : null;
        if (receipt._tag === "Success" && outcome === null) return;
        if (outcome?.status !== "accepted")
          setError(
            outcome?.status === "rejected"
              ? (outcome.detail ?? "The cancellation request was rejected.")
              : failure instanceof Error
                ? failure.message
                : "Could not confirm cancellation.",
          );
      }
    } catch {
      if (!isCurrent()) return;
      cancellation.failed(cancellationScope, command);
      setError("Could not confirm cancellation. Retry to send the same request.");
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setCancellationRevision((value) => value + 1);
      }
    }
  };
  if (
    queue.entries.length === 0 &&
    queue.pauseReason === null &&
    edit === null &&
    !preparing &&
    !fallbackMove
  )
    return null;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label="Shared prompt queue"
      data-shared-prompt-queue="true"
      className="@container/shared-queue mb-2 max-h-[min(20rem,40dvh,var(--shared-queue-available-height,20rem))] scroll-pt-10 overflow-y-auto overscroll-contain bg-background px-3 pb-1 outline-none"
    >
      <div className="sticky top-0 z-10 flex min-h-9 items-center justify-between gap-2 bg-background">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3Icon aria-hidden="true" className="size-3.5" />
          {queue.pauseReason ? "Queue paused" : "Queued"}
          <span className="rounded bg-muted px-1 text-3xs tabular-nums">
            {queue.entries.length + (fallbackMove ? 1 : 0)}
          </span>
        </span>
        {setupRunning || (preparing && preparation.settled === false) ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled || !supportsPreparation}
            onClick={() => void run(() => pauseQueue(request(input)))}
          >
            Stop setup
          </Button>
        ) : queue.pauseReason === null && !preparing ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Pause queue"
                  disabled={disabled}
                  onClick={() => void run(() => pauseQueue(request(input)))}
                />
              }
            >
              <PauseIcon />
            </TooltipTrigger>
            <TooltipPopup>Pause queue</TooltipPopup>
          </Tooltip>
        ) : queue.pauseReason?.code !== "delivery-unknown" && !preparing ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Resume queue"
                  disabled={disabled || queue.handoff !== null}
                  onClick={() =>
                    void run(() =>
                      resumeQueue(request({ ...input, expectedRevision: queue.revision })),
                    )
                  }
                />
              }
            >
              <PlayIcon />
            </TooltipTrigger>
            <TooltipPopup>Resume queue</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {preparing ? (
        <div className="mt-2 space-y-2 wrap-anywhere">
          <p role="status" className="text-xs text-muted-foreground">
            {setupRunning
              ? "Preparing workspace. Accepted prompts will wait for setup."
              : (preparation.failure?.detail ?? "Required preparation has not finished.")}
          </p>
          {!supportsPreparation ? (
            <p className="text-xs">Reconnect to a compatible server to recover setup.</p>
          ) : null}
          {preparation.state === "failed" ? (
            <div className="flex flex-wrap gap-2">
              {preparation.recipe !== null ? (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={
                    disabled ||
                    !supportsPreparation ||
                    !preparation.settled ||
                    queue.handoff !== null
                  }
                  onClick={() =>
                    void run(() =>
                      retryPreparation(
                        request({
                          ...input,
                          expectedRevision: preparation.revision,
                          expectedControlRevision: queue.revision,
                        }),
                      ),
                    )
                  }
                >
                  Retry setup and resume
                </Button>
              ) : (
                <p className="text-xs">Review the interrupted setup before choosing a workspace.</p>
              )}
              {canWorkLocally ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={
                    disabled ||
                    !supportsPreparation ||
                    !preparation.settled ||
                    queue.handoff !== null
                  }
                  onClick={() =>
                    void run(() =>
                      retryPreparation(
                        request({
                          ...input,
                          expectedRevision: preparation.revision,
                          expectedControlRevision: queue.revision,
                          target: "project",
                        }),
                      ),
                    )
                  }
                >
                  Work locally
                </Button>
              ) : null}
              {!preparation.settled ? <p className="text-xs">Waiting for setup to stop…</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {queue.pauseReason ? (
        <p role="status" className="mt-1 wrap-anywhere text-xs text-muted-foreground">
          Paused: {queue.pauseReason.detail}
        </p>
      ) : null}
      {queue.pauseReason?.code === "delivery-unknown" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  "The provider may already have received this prompt. Retry can duplicate work. Retry it?",
                )
              )
                void run(() =>
                  resolveQueue(
                    request({ ...input, expectedRevision: queue.revision, resolution: "retry" }),
                  ),
                );
            }}
          >
            Retry delivery
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  "Remove the uncertain delivery from the queue? Work already started by the provider is not undone.",
                )
              )
                void run(() =>
                  resolveQueue(
                    request({ ...input, expectedRevision: queue.revision, resolution: "dismiss" }),
                  ),
                );
            }}
          >
            Dismiss delivery
          </Button>
        </div>
      ) : null}
      <ol>
        {fallbackMove && (
          <li>
            <ThreadMoveQueueItem
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              placement={placement}
            />
          </li>
        )}
        {queue.entries.map((entry, index) =>
          entry.kind === "move" ? (
            <li key={entry.messageId}>
              <ThreadMoveQueueItem
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                entry={entry}
                placement={placement}
                queuePaused={!queue.enabled || queue.pauseReason !== null}
                cancellation={cancellation.phase(cancellationScope, entry.messageId)}
                disabled={disabled}
                onCancel={() => void requestCancellation(entry)}
              >
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled || !canReorder || index === 0}
                  onClick={() =>
                    void run(() =>
                      reorderQueue(
                        request({
                          ...input,
                          expectedRevision: queue.revision,
                          order: moveQueueEntryNext(queue.entries, entry.messageId),
                        }),
                      ),
                    )
                  }
                >
                  Move next
                </Button>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled || !canReorder || index === queue.entries.length - 1}
                  onClick={() =>
                    void run(() =>
                      reorderQueue(
                        request({
                          ...input,
                          expectedRevision: queue.revision,
                          order: moveQueueEntryLater(queue.entries, entry.messageId),
                        }),
                      ),
                    )
                  }
                >
                  Move down
                </Button>
              </ThreadMoveQueueItem>
            </li>
          ) : (
            <SharedPromptQueueRow
              key={entry.messageId}
              entry={entry}
              index={index}
              isNext={
                index === 0 &&
                entry.state === "pending" &&
                queue.enabled &&
                queue.pauseReason === null &&
                !preparing &&
                queue.handoff === null
              }
              disabled={disabled}
              canSteer={
                activeTurnId !== null &&
                !preparing &&
                (firstMoveIndex < 0 || index < firstMoveIndex)
              }
              onMoveNext={
                canReorder && index > 0
                  ? () =>
                      void run(() =>
                        reorderQueue(
                          request({
                            ...input,
                            expectedRevision: queue.revision,
                            order: moveQueueEntryNext(queue.entries, entry.messageId),
                          }),
                        ),
                      )
                  : undefined
              }
              onMoveDown={
                canReorder && index + 1 < queue.entries.length
                  ? () =>
                      void run(() =>
                        reorderQueue(
                          request({
                            ...input,
                            expectedRevision: queue.revision,
                            order: moveQueueEntryLater(queue.entries, entry.messageId),
                          }),
                        ),
                      )
                  : undefined
              }
              viewerId={account?.accountId}
              editorRef={editorRef}
              onEdit={() => {
                if (edit?.messageId === entry.messageId) {
                  return;
                }
                setEdit({ messageId: entry.messageId, revision: entry.revision, text: entry.text });
                setError(null);
              }}
              onSteer={() => {
                if (activeTurnId)
                  void run(
                    () =>
                      steerPrompt(
                        request({
                          ...input,
                          messageId: entry.messageId,
                          expectedRevision: entry.revision,
                          expectedTurnId: activeTurnId,
                        }),
                      ),
                    () => sectionRef.current?.focus({ preventScroll: true }),
                  );
              }}
              onRemove={() =>
                void run(
                  () =>
                    removePrompt(
                      request({
                        ...input,
                        messageId: entry.messageId,
                        expectedRevision: entry.revision,
                      }),
                    ),
                  () => sectionRef.current?.focus({ preventScroll: true }),
                )
              }
            />
          ),
        )}
      </ol>
      {edit ? (
        <div className="mt-3 space-y-2">
          <Textarea
            ref={editorRef}
            aria-label="Edit queued prompt"
            value={edit.text}
            onChange={(event) => setEdit({ ...edit, text: event.target.value })}
          />
          {conflict ? (
            <p role="alert" className="text-xs">
              {conflict}
            </p>
          ) : null}
          {current && current.revision !== edit.revision ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap wrap-anywhere text-xs">
                Current prompt: {current.text}
              </p>
              <Button
                size="xs"
                variant="secondary"
                disabled={disabled || current.state !== "pending"}
                onClick={() => setEdit({ ...edit, revision: current.revision })}
              >
                Keep my draft against this version
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              disabled={disabled || conflict !== null}
              onClick={() => {
                if (!current) return;
                void run(
                  () =>
                    editPrompt(
                      request({
                        ...input,
                        messageId: edit.messageId,
                        expectedRevision: edit.revision,
                        expectedRuntimeMode: current.runtimeMode,
                        message: {
                          text: edit.text,
                          attachments: current.attachments,
                          ...(current.context ? { context: current.context } : {}),
                        },
                      }),
                    ),
                  () => {
                    setEdit(null);
                    sectionRef.current?.focus({ preventScroll: true });
                  },
                );
              }}
            >
              Save edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEdit(null);
                sectionRef.current?.focus({ preventScroll: true });
              }}
            >
              Cancel edit
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
