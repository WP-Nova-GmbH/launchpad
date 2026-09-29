import type { ScopedThreadRef, CommandId, ProjectId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  forgetSharedPromptSubmission,
  rejectSharedPromptSubmission,
  reviseRejectedSharedPrompt,
  useSharedPromptSubmissions,
  type SharedPromptSubmission,
} from "../../sharedPromptSubmissionStore";
import { verifyStashedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function receiptInput(entry: SharedPromptSubmission, projectId: ProjectId | undefined) {
  if (entry.command.type !== "thread.turn.start") return null;
  const scope = entry.command.bootstrap?.createThread?.projectId ?? projectId;
  return {
    threadId: entry.command.threadId,
    commandId: entry.command.commandId,
    ...(scope ? { projectId: scope } : {}),
  };
}

/** Preacceptance transport state stays separate from the team's accepted queue. */
export function SharedPromptSubmissions({
  threadRef,
  projectId,
  unavailable,
}: {
  threadRef: ScopedThreadRef;
  projectId?: ProjectId;
  unavailable: boolean;
}) {
  const entries = useSharedPromptSubmissions((state) => state.entries);
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const receipt = useAtomCommand(threadEnvironment.getCommandReceipt, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [busy, setBusy] = useState<CommandId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ commandId: CommandId; text: string } | null>(null);
  const [dismissing, setDismissing] = useState<CommandId | null>(null);
  const pending = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.environmentId === threadRef.environmentId &&
          entry.command.type === "thread.turn.start" &&
          ((entry.displayThreadId ?? entry.command.threadId) === threadRef.threadId ||
            // A creation may never produce a navigable server thread. Its saved recovery remains reachable.
            entry.command.bootstrap?.createThread !== undefined),
      ),
    [entries, threadRef.environmentId, threadRef.threadId],
  );
  const available = !unavailable && config?.environment.capabilities.sharedPromptQueue === true;
  const preparationSupported = config?.environment.capabilities.sharedPreparation === true;
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    for (const entry of pending) {
      const input = receiptInput(entry, projectId);
      if (!input) continue;
      void receipt({ environmentId: entry.environmentId, input }).then((result) => {
        if (cancelled || result._tag !== "Success") return;
        try {
          if (result.value.status === "accepted")
            forgetSharedPromptSubmission(entry.command.commandId);
          else if (result.value.status === "rejected")
            rejectSharedPromptSubmission(
              entry.command.commandId,
              result.value.detail ?? "The server rejected this prompt.",
            );
        } catch {
          /* Keep the durable journal if local cleanup cannot finish. */
        }
      });
    }
    return () => {
      cancelled = true;
    };
    // Only receipts remove ownership; an absent thread/queue entry proves nothing.
  }, [available, pending, receipt, projectId]);

  const discard = (commandId: CommandId) => {
    try {
      forgetSharedPromptSubmission(commandId);
      setDismissing(null);
    } catch {
      setError("Could not remove the saved copy. It remains on this device.");
    }
  };

  const reconcile = async (entry: SharedPromptSubmission, retry: boolean) => {
    const input = receiptInput(entry, projectId);
    if (!input || entry.command.type !== "thread.turn.start") return;
    setBusy(entry.command.commandId);
    setError(null);
    try {
      const outcome = await receipt({ environmentId: entry.environmentId, input });
      if (outcome._tag !== "Success") {
        setError("The outcome could not be checked. This submission remains saved.");
        return;
      }
      if (outcome.value.status === "accepted") {
        forgetSharedPromptSubmission(entry.command.commandId);
        return;
      }
      if (outcome.value.status === "rejected") {
        rejectSharedPromptSubmission(
          entry.command.commandId,
          outcome.value.detail ?? "The server rejected this prompt.",
        );
        return;
      }
      if (
        !retry ||
        (!entry.awaitingSend && (!preparationSupported || entry.sharedPreparation !== true))
      ) {
        setError(
          "Acceptance is unknown. Review the task before sending a copy; the original may already have started.",
        );
        return;
      }
      for (const attachment of entry.command.message.attachments) {
        if ("dataUrl" in attachment || !attachment.id) continue;
        const verification = await verifyStashedAttachmentUpload({
          environmentId: entry.environmentId,
          attachmentId: attachment.id,
        });
        if (verification.status !== "verified") {
          setError(
            verification.status === "missing"
              ? `Reattach '${attachment.name}' in the composer before sending a new draft. Copy the saved text below; this submission is retained for review.`
              : "Could not verify the saved attachments. Reconnect and check the outcome again.",
          );
          return;
        }
      }
      const result = await start({ environmentId: entry.environmentId, input: entry.command });
      if (result._tag === "Failure")
        setError(
          "This submission remains saved. Check its outcome or your access before retrying.",
        );
    } catch {
      setError("Recovery could not finish. The saved submission is retained.");
    } finally {
      setBusy(null);
    }
  };
  if (pending.length === 0) return null;
  return (
    <section
      aria-label="Prompts waiting for acceptance"
      className="mb-2 space-y-2 rounded-lg border border-border p-3"
    >
      <p className="text-sm font-medium">Saved submissions</p>
      <p className="text-xs text-muted-foreground">
        These prompts stay on this device until the server confirms acceptance. Setup failures after
        acceptance appear in the shared queue.
      </p>
      {pending.map((entry) => (
        <div key={entry.command.commandId} className="space-y-1">
          <p className="whitespace-pre-wrap text-sm">
            {"message" in entry.command ? entry.command.message.text : "Saved prompt"}
          </p>
          {"message" in entry.command && entry.command.message.attachments.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Files:{" "}
              {entry.command.message.attachments.map((attachment) => attachment.name).join(", ")}.
              Saved uploads are checked before retry; expired files need reattaching.
            </p>
          ) : null}
          {entry.rejection ? (
            <div className="space-y-1">
              <p role="alert" className="text-xs">
                {entry.rejection}
              </p>
              {editing?.commandId === entry.command.commandId ? (
                <>
                  <Textarea
                    aria-label="Revise rejected prompt"
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  />
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      try {
                        reviseRejectedSharedPrompt(editing.commandId, editing.text, {
                          sharedPreparation: preparationSupported,
                        });
                        setEditing(null);
                      } catch {
                        setError("Could not save the revised draft. The original is retained.");
                      }
                    }}
                  >
                    Save revised draft
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (entry.command.type === "thread.turn.start")
                      setEditing({
                        commandId: entry.command.commandId,
                        text: entry.command.message.text,
                      });
                  }}
                >
                  Edit rejected prompt
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => discard(entry.command.commandId)}>
                Discard rejected prompt
              </Button>
            </div>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              {entry.awaitingSend
                ? "Revised draft ready to send."
                : entry.sharedPreparation
                  ? "Waiting for acceptance."
                  : "Acceptance unknown. Review before sending again."}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="secondary"
              disabled={!available || busy !== null}
              onClick={() => void reconcile(entry, false)}
            >
              Check outcome
            </Button>
            {entry.rejection === undefined &&
            (entry.awaitingSend || (entry.sharedPreparation && preparationSupported)) ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={!available || busy !== null}
                onClick={() => void reconcile(entry, true)}
              >
                {entry.awaitingSend ? "Send revised draft" : "Retry submission"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (!("message" in entry.command)) return;
                if (!navigator.clipboard) {
                  setError("Select and copy the saved text above.");
                  return;
                }
                void navigator.clipboard
                  .writeText(entry.command.message.text)
                  .catch(() => setError("Select and copy the saved text above."));
              }}
            >
              Copy text
            </Button>
            {!entry.rejection ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setDismissing(entry.command.commandId)}
              >
                Dismiss saved copy
              </Button>
            ) : null}
          </div>
          {dismissing === entry.command.commandId ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Review the task first. Dismissing removes this device's saved copy and does not
                cancel work the server may have accepted.
              </p>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => discard(entry.command.commandId)}
              >
                I reviewed the task; dismiss
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDismissing(null)}>
                Keep saved copy
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
