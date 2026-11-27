import { useAtomValue } from "@effect/atom-react";
import {
  hasUnsavedWorkflowWork,
  summarizeWorkflowClose,
  workflowDraftAtom,
  workflowJobReadAtom,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ClipboardCheckIcon,
  Clock3Icon,
  FilePenLineIcon,
  MessageSquareIcon,
  PlayIcon,
  SaveIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

const requestPresentation = {
  save: {
    Icon: SaveIcon,
    label: "Save",
    fallback: "Workflow save",
    detail: "Check the saved version in Workflows.",
  },
  archive: {
    Icon: ArchiveIcon,
    label: "Archive",
    fallback: "Workflow archive",
    detail: "Check whether the workflow moved to Archived workflows.",
  },
  restore: {
    Icon: ArchiveRestoreIcon,
    label: "Restore",
    fallback: "Workflow restore",
    detail: "Check whether the workflow returned to the active list in Workflows.",
  },
  run: {
    Icon: PlayIcon,
    label: "Run",
    fallback: "Run submission",
    detail: "Look for the submission in Runs before starting another.",
  },
};

/** Guard the whole window, including workflow drafts held off the current route. */
export function WorkflowWindowCloseGuard() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"closing" | "failed" | null>(null);
  const closing = useRef(false);
  const keepOpen = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const desktop = window.desktopBridge;
    const supportsCloseDialog = !!desktop?.onWindowCloseBlocked && !!desktop.confirmWindowClose;
    const vetoUnload = (event: BeforeUnloadEvent) => {
      if (
        desktop &&
        !supportsCloseDialog &&
        window.confirm("Close this window and discard unsaved workflow drafts?")
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    const syncUnloadListener = () => {
      if (
        hasUnsavedWorkflowWork(
          appAtomRegistry.get(workflowDraftAtom),
          appAtomRegistry.get(workflowJobReadAtom),
        )
      )
        window.addEventListener("beforeunload", vetoUnload);
      else window.removeEventListener("beforeunload", vetoUnload);
    };
    const unsubscribeDrafts = appAtomRegistry.subscribe(workflowDraftAtom, syncUnloadListener);
    const unsubscribeReads = appAtomRegistry.subscribe(workflowJobReadAtom, syncUnloadListener);
    syncUnloadListener();
    const unsubscribeClose = supportsCloseDialog
      ? desktop.onWindowCloseBlocked?.(() => {
          setOpen(true);
        })
      : undefined;
    return () => {
      unsubscribeClose?.();
      unsubscribeDrafts();
      unsubscribeReads();
      window.removeEventListener("beforeunload", vetoUnload);
    };
  }, []);

  const stay = () => {
    if (closing.current) return;
    setOpen(false);
    setConfirmation(null);
  };
  const close = async () => {
    if (closing.current) return;
    const confirmWindowClose = window.desktopBridge?.confirmWindowClose;
    if (!confirmWindowClose) {
      setConfirmation("failed");
      return;
    }
    closing.current = true;
    setConfirmation("closing");
    try {
      await confirmWindowClose();
    } catch {
      closing.current = false;
      setConfirmation("failed");
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) stay();
      }}
    >
      <AlertDialogPopup
        bottomStickOnMobile={false}
        initialFocus={keepOpen}
        layer="window"
        variant="scrollable"
      >
        <WorkflowWindowCloseContent
          confirmation={confirmation}
          keepOpen={keepOpen}
          onStay={stay}
          onClose={() => void close()}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function WorkflowWindowCloseContent({
  confirmation,
  keepOpen,
  onStay,
  onClose,
}: {
  confirmation: "closing" | "failed" | null;
  keepOpen: React.RefObject<HTMLButtonElement | null>;
  onStay: () => void;
  onClose: () => void;
}) {
  const drafts = useAtomValue(workflowDraftAtom);
  const reads = useAtomValue(workflowJobReadAtom);
  const summary = summarizeWorkflowClose(drafts, reads);
  const unsent = summary.responses.filter((response) => !response.deliveryUnconfirmed);
  const hasEdits = !!(summary.edits.length || summary.runDrafts.length);
  const hasLocalWork = hasEdits || unsent.length > 0;
  const hasRequests = !!(
    summary.requests.length || summary.responses.some((response) => response.deliveryUnconfirmed)
  );
  const title = hasRequests
    ? "Close window before confirmation?"
    : hasEdits
      ? "Close window with unsaved edits?"
      : unsent.length === 1
        ? "Close window with an unsent response?"
        : unsent.length
          ? "Close window with unsent responses?"
          : "Close window?";
  const description = hasRequests
    ? "The relay may have received these requests. Closing discards the local drafts. Check their status after reopening."
    : hasEdits
      ? "Closing this window discards the edits and drafts listed below."
      : unsent.length
        ? "Closing this window discards the responses you drafted for these checkpoints."
        : "Your workflow work is up to date.";
  const StatusIcon = hasRequests ? Clock3Icon : unsent.length ? MessageSquareIcon : FilePenLineIcon;
  const items = [
    ...summary.edits.map(({ key, name }) => ({
      key: `edit:${key}`,
      Icon: WorkflowIcon,
      title: name ?? "Untitled workflow",
      detail: hasRequests || unsent.length ? "Unsaved workflow edits" : null,
    })),
    ...summary.runDrafts.map(({ key, workflowName }) => ({
      key: `instructions:${key}`,
      Icon: PlayIcon,
      title: "Unsent run instructions",
      detail: workflowName,
    })),
    ...summary.responses.map((response) => ({
      key: `response:${response.jobKey}:${response.checkpointId}`,
      Icon: response.kind === "review" ? ClipboardCheckIcon : MessageSquareIcon,
      title: response.deliveryUnconfirmed
        ? "Checkpoint response awaiting confirmation"
        : response.kind === "review"
          ? "Review feedback"
          : response.kind === "input"
            ? "Input answer"
            : "Unsent checkpoint response",
      detail: response.deliveryUnconfirmed
        ? `Check the checkpoint in Run details${response.workflowName ? ` for ${response.workflowName}` : ""}.`
        : [response.stepTitle, response.workflowName].filter(Boolean).join(" in "),
    })),
    ...summary.requests.map(({ key, requestId, kind, workflowName, runPosition }) => {
      const { Icon, label, fallback, detail } = requestPresentation[kind];
      const attempt = runPosition
        ? `Unconfirmed run ${runPosition.number} of ${runPosition.total}`
        : null;
      return {
        key: `request:${kind}:${key}:${requestId}`,
        Icon,
        title: workflowName ? `${attempt ?? label} for ${workflowName}` : (attempt ?? fallback),
        detail,
      };
    }),
  ];
  return (
    <>
      <AlertDialogHeader className="min-h-0 overflow-y-auto overscroll-contain">
        <div className="flex items-start gap-3 text-left">
          <div
            className={
              hasRequests
                ? "grid size-9 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning-foreground"
                : "grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
            }
          >
            <StatusIcon aria-hidden size={17} />
          </div>
          <div className="min-w-0 space-y-2">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </div>
        </div>
        {items.length ? (
          <ul
            aria-label="Workflow work in this window"
            className="divide-y rounded-lg border bg-muted/30 text-left"
          >
            {items.map(({ key, Icon, title, detail }) => (
              <li key={key} className="flex items-start gap-2.5 px-3 py-2.5 text-sm">
                <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 wrap-anywhere">
                  <p className="font-medium">{title}</p>
                  {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDialogHeader>
      <AlertDialogFooter className="shrink-0">
        <div className="grid w-full gap-2">
          {confirmation === "failed" ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not close the window. Try again or keep the window open.
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant={hasLocalWork ? "destructive-outline" : "outline"}
              onClick={onClose}
              disabled={confirmation === "closing"}
            >
              {confirmation === "closing"
                ? "Closing…"
                : hasRequests
                  ? "Close anyway"
                  : "Close window"}
            </Button>
            <Button
              ref={keepOpen}
              type="button"
              onClick={onStay}
              disabled={confirmation === "closing"}
            >
              Keep window open
            </Button>
          </div>
        </div>
      </AlertDialogFooter>
    </>
  );
}
