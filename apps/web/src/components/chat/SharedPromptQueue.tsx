import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadPromptQueue, TurnId } from "@t3tools/contracts";
import {
  promptAttributionLabel,
  queuedPromptEditConflict,
  type QueuedPromptEdit,
} from "@t3tools/client-runtime/state/threads";
import { useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

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
  const [edit, setEdit] = useState<QueuedPromptEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      aria-label="Shared prompt queue"
      className="mb-2 max-h-80 overflow-y-auto rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Shared queue · {queue.entries.length}</span>
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
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void run(() => pauseQueue(request(input)))}
          >
            Pause queue
          </Button>
        ) : queue.pauseReason?.code !== "delivery-unknown" && !preparing ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled || queue.handoff !== null}
            onClick={() =>
              void run(() => resumeQueue(request({ ...input, expectedRevision: queue.revision })))
            }
          >
            Resume queue
          </Button>
        ) : null}
      </div>
      {preparing ? (
        <div className="mt-2 space-y-2">
          <p role="status" className="text-xs text-muted-foreground">
            {setupRunning
              ? "Preparing workspace. Accepted prompts will wait for setup."
              : (preparation.failure?.detail ?? "Required preparation has not finished.")}
          </p>
          {!supportsPreparation ? (
            <p className="text-xs">Reconnect to a compatible server to recover setup.</p>
          ) : null}
          {preparation.state === "failed" ? (
            <div className="flex gap-2">
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
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Paused: {queue.pauseReason.detail}
        </p>
      ) : !preparing ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Waiting for the current turn to finish. Steer explicitly to change ongoing work.
        </p>
      ) : null}
      {queue.pauseReason?.code === "delivery-unknown" ? (
        <div className="mt-2 flex gap-2">
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
      <ol className="mt-2 space-y-2">
        {queue.entries.map((entry, index) => (
          <li key={entry.messageId} className="rounded-lg border border-border p-2">
            <p className="whitespace-pre-wrap break-words text-sm">
              {index + 1}. {entry.text || "Attachments"}
            </p>
            {entry.attachments.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Files: {entry.attachments.map((attachment) => attachment.name).join(", ")}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">{promptAttributionLabel(entry)}</p>
            {entry.state !== "pending" ? (
              <p role="status" className="mt-1 text-xs">
                {entry.state === "unknown" ? "Delivery outcome unknown" : "Sending to agent…"}
              </p>
            ) : (
              <div className="mt-1 flex gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setEdit({
                      messageId: entry.messageId,
                      revision: entry.revision,
                      text: entry.text,
                    });
                    setError(null);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || activeTurnId === null || preparing}
                  onClick={() => {
                    if (activeTurnId)
                      void run(() =>
                        steerPrompt(
                          request({
                            ...input,
                            messageId: entry.messageId,
                            expectedRevision: entry.revision,
                            expectedTurnId: activeTurnId,
                          }),
                        ),
                      );
                  }}
                >
                  Steer now
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void run(() =>
                      removePrompt(
                        request({
                          ...input,
                          messageId: entry.messageId,
                          expectedRevision: entry.revision,
                        }),
                      ),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {edit ? (
        <div className="mt-3 space-y-2">
          <Textarea
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
              <p className="whitespace-pre-wrap text-xs">Current prompt: {current.text}</p>
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
          <div className="flex gap-2">
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
                        message: {
                          text: edit.text,
                          attachments: current.attachments,
                          ...(current.context ? { context: current.context } : {}),
                        },
                      }),
                    ),
                  () => setEdit(null),
                );
              }}
            >
              Save edit
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEdit(null)}>
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
