import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadPromptQueue, TurnId } from "@t3tools/contracts";
import {
  queuedPromptEditConflict,
  type QueuedPromptEdit,
} from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { Clock3Icon, PauseIcon, PlayIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedPromptQueueRow } from "./SharedPromptQueueRow";

export function SharedPromptQueue({
  threadRef,
  queue,
  activeTurnId,
  unavailable = false,
  supportsPreparation = false,
  canWorkLocally = false,
}: {
  threadRef: ScopedThreadRef;
  queue: ThreadPromptQueue;
  activeTurnId: TurnId | null;
  unavailable?: boolean;
  supportsPreparation?: boolean;
  canWorkLocally?: boolean;
}) {
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
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [edit, setEdit] = useState<QueuedPromptEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingMessageId = edit?.messageId;
  useLayoutEffect(() => {
    if (editingMessageId) editorRef.current?.focus();
  }, [editingMessageId]);
  const current = queue.entries.find((entry) => entry.messageId === edit?.messageId);
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
  if (queue.entries.length === 0 && queue.pauseReason === null && edit === null && !preparing)
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
            {queue.entries.length}
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
        {queue.entries.map((entry, index) => (
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
            canSteer={activeTurnId !== null && !preparing}
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
        ))}
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
