import { useNavigate } from "@tanstack/react-router";
import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import type { ThreadQueueControlSubmission } from "@t3tools/client-runtime/relay/threadQueueControlSubmission";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { randomUUID } from "../../lib/utils";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CommandId, EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowLeftIcon, ChevronRightIcon, MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  portableThreadLibrary,
  openPortableThreadChat,
  threadQueueControlJournal,
  threadVmControls,
  threadVmActionJournal,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ThreadVmControls } from "./ThreadVmControls";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : fallback;
}
function SavedVmRequests() {
  const session = useAtomValue(managedRelaySessionAtom);
  const dispatch = useAtomCommand(threadVmControls.action, { reportFailure: false });
  const submit = useCallback(
    async (input: Parameters<typeof dispatch>[0]) => {
      const result = await dispatch(input);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [dispatch],
  );
  const lifecycle = useThreadVmActionJournal(
    threadVmActionJournal,
    session,
    threadMoveRelayUrl(),
    submit,
  );
  if (!lifecycle.error && lifecycle.entries.length === 0) return null;
  return (
    <div className="grid gap-2">
      {lifecycle.error && <p role="alert">{lifecycle.error}</p>}
      {lifecycle.entries.map((entry) => (
        <div key={entry.threadId}>
          <p className="text-sm">
            Saved {entry.action.type} request · {entry.threadId}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={lifecycle.busy || !lifecycle.ready}
            onClick={() => void lifecycle.run(entry)}
          >
            Retry saved VM request
          </Button>
        </div>
      ))}
    </div>
  );
}
function LibraryBody() {
  const session = useAtomValue(managedRelaySessionAtom),
    index = useAtomValue(portableThreadLibrary.indexAtom);
  const loadIndex = useAtomCommand(portableThreadLibrary.loadIndex, { reportFailure: false });
  const [selected, setSelected] = useState<ThreadId | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!session) return;
    let active = true;
    void loadIndex({}).then((result) => {
      if (active && result._tag !== "Success")
        setError(failureMessage(result, "Could not read saved threads."));
    });
    return () => {
      active = false;
    };
  }, [session, loadIndex]);
  const load = async (after?: string) => {
    setBusy(true);
    setError(null);
    const result = await loadIndex(after === undefined ? {} : { after });
    if (result._tag !== "Success")
      setError(failureMessage(result, "Could not read saved threads."));
    setBusy(false);
  };
  const summary = index?.entries.find((entry) => entry.placement.threadId === selected);
  if (!session) return <p>Sign in to Launchpad Connect to read your VM threads.</p>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {selected ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
            <ArrowLeftIcon aria-hidden />
            All threads
          </Button>
        ) : (
          <h2 className="text-sm font-medium">Conversations</h2>
        )}
        <div className="flex items-center gap-2">
          {busy && (
            <span role="status" className="text-xs text-muted-foreground">
              Refreshing…
            </span>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label="Refresh VM threads"
                  onClick={() => void load()}
                />
              }
            >
              <RefreshCwIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Refresh threads</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <SavedVmRequests />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {summary ? (
        <SavedConversation
          key={`${session.accountId}:${summary.placement.threadId}`}
          threadId={ThreadId.make(summary.placement.threadId)}
          environmentId={EnvironmentId.make(summary.placement.environmentId)}
          title={summary.title}
        />
      ) : (
        <>
          {index && index.entries.length > 0 && (
            <ul
              aria-label="VM conversations"
              className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70"
            >
              {index.entries.map((entry) => (
                <li key={entry.placement.threadId}>
                  <button
                    type="button"
                    className="group flex w-full cursor-pointer items-center gap-3 p-4 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    onClick={() => setSelected(ThreadId.make(entry.placement.threadId))}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <MessageSquareIcon aria-hidden className="size-4" />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="wrap-anywhere text-sm font-medium leading-snug">
                        {entry.title}
                      </span>
                      {entry.updatedAt && (
                        <span className="text-xs text-muted-foreground">
                          Updated{" "}
                          <time dateTime={entry.updatedAt}>
                            {formatRelativeTimeLabel(entry.updatedAt)}
                          </time>
                        </span>
                      )}
                    </span>
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-foreground"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {index?.entries.length === 0 && (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <MessageSquareIcon aria-hidden className="mb-1 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">No VM threads yet</p>
              <p className="text-sm text-muted-foreground">
                Open a local conversation, then choose Move thread → Private VM.
              </p>
            </div>
          )}
          {!index && !error && (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">
              Loading conversations…
            </p>
          )}
          {index?.next && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void load(index.next!)}
            >
              More threads
            </Button>
          )}
          {index && index.entries.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Move a local conversation here with Move thread → Private VM. Opening a saved
              conversation does not start its VM.
            </p>
          )}
        </>
      )}
    </div>
  );
}
function SavedConversation({
  threadId,
  environmentId,
  title,
}: {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  title: string;
}) {
  const detail = useAtomValue(portableThreadLibrary.detailAtom(threadId));
  const openChat = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const closeLibrary = useAtomSet(portableThreadLibrary.openAtom);
  const navigate = useNavigate();
  const queueControl = useAtomCommand(portableThreadLibrary.queueControl, { reportFailure: false });
  const [queueDraft, setQueueDraft] = useState<ThreadQueueControlSubmission | null>(null);
  const [queueReady, setQueueReady] = useState(false);
  const [requestedQueue, setRequestedQueue] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [earlier, setEarlier] = useState(0);

  const session = useAtomValue(managedRelaySessionAtom);
  const accountAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    accountAbort.current = controller;
    return () => controller.abort();
  }, [session]);
  const continueChat = async () => {
    const abort = accountAbort.current;
    if (!abort || abort.signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await openChat({ threadId, title });
      if (abort.signal.aborted) return;
      if (result._tag === "Failure") {
        setError(failureMessage(result, "Could not open this chat."));
        return;
      }
      await navigate({ to: "/$environmentId/$threadId", params: result.value });
      if (!abort.signal.aborted) closeLibrary(false);
    } catch {
      if (!abort.signal.aborted) setError("Could not open this chat. Try again.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const relayUrl = threadMoveRelayUrl();
  useEffect(() => {
    let active = true;
    if (!session || !relayUrl) return;
    void threadQueueControlJournal.read({ accountId: session.accountId, relayUrl, threadId }).then(
      (draft) => {
        if (active) {
          setQueueDraft(draft);
          setQueueReady(true);
        }
      },
      () => {
        if (active)
          setError(
            "Could not read the saved queue request. Resolve storage before changing the queue.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [session, relayUrl, threadId]);

  const download = useAtomCommand(portableThreadLibrary.downloadAttachment, {
    reportFailure: false,
  });

  const loadHistory = useAtomCommand(portableThreadLibrary.loadHistory, { reportFailure: false });
  useEffect(() => {
    let active = true;
    void loadHistory({ threadId }).then((result) => {
      if (active && result._tag !== "Success")
        setError(failureMessage(result, "Could not read this conversation."));
    });
    return () => {
      active = false;
    };
  }, [threadId, loadHistory]);
  const more = async (refresh = false) => {
    setBusy(true);
    setError(null);
    const result = await loadHistory({
      threadId,
      ...(refresh ? { refresh: true } : { more: true }),
    });
    if (result._tag !== "Success") setError(failureMessage(result, "Could not read more history."));
    setBusy(false);
  };
  const downloadFile = async (file: ChatAttachment) => {
    const abort = accountAbort.current;
    if (!abort || abort.signal.aborted) return;
    setBusy(true);
    setError(null);
    try {
      const result = await download({ threadId, attachmentId: file.id });
      if (result._tag !== "Success") {
        setError(failureMessage(result, "Could not download the attachment."));
        return;
      }
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(result.value).buffer], { type: "application/octet-stream" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.split(/[\\/]/u).at(-1) ?? "attachment";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not download the attachment.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const changeQueue = async (enabled: boolean) => {
    const abort = accountAbort.current;
    if (!abort || abort.signal.aborted) return;
    if (!session || !relayUrl || !queueReady || busy) return;
    const scope = { accountId: session.accountId, relayUrl, threadId };
    setBusy(true);
    setError(null);
    setRequestedQueue(null);
    try {
      const draft = await threadQueueControlJournal.prepare(scope, () => {
        const queue = detail?.history.thread?.promptQueue;
        if (!queue || detail?.hasMore)
          throw new Error("Read the current queue before changing it.");
        const metadata = {
          commandId: CommandId.make(randomUUID()),
          threadId,
          createdAt: new Date().toISOString(),
        };
        return enabled
          ? { ...metadata, type: "thread.queue.resume", expectedRevision: queue.revision }
          : { ...metadata, type: "thread.queue.pause" };
      });
      if (abort.signal.aborted) return;
      setQueueDraft(draft);
      if (draft.rejection) {
        setError(draft.rejection);
        return;
      }
      const result = await queueControl({ accountId: session.accountId, command: draft.command });
      if (abort.signal.aborted) return;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const next = await threadQueueControlJournal.acknowledge(scope, draft.command, result.value);
      if (abort.signal.aborted) return;
      setQueueDraft(next);
      if (next?.rejection) setError(next.rejection);
      else setRequestedQueue(draft.command.type === "thread.queue.resume");
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not confirm the queue request. Retry uses the same request.",
        );
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const discardQueue = async () => {
    const abort = accountAbort.current;
    if (!abort || abort.signal.aborted) return;
    if (!session || !relayUrl || busy) return;
    setBusy(true);
    try {
      await threadQueueControlJournal.discardRejected({
        accountId: session.accountId,
        relayUrl,
        threadId,
      });
      if (!abort.signal.aborted) {
        setQueueDraft(null);
        setError(null);
      }
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not clear the rejected request.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const waitingForQueue =
    requestedQueue !== null && detail?.history.thread?.promptQueue?.enabled !== requestedQueue;
  const thread = detail?.history.thread,
    messages = thread?.messages ?? [],
    end = Math.max(0, messages.length - earlier),
    start = Math.max(0, end - 200);
  return (
    <div className="grid gap-3">
      <h3 className="text-base font-medium">{title}</h3>
      <Button
        size="sm"
        disabled={busy || detail?.history.deleted === true}
        onClick={() => void continueChat()}
      >
        Open chat
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void more(true)}>
        Refresh conversation
      </Button>
      <ThreadVmControls environmentId={environmentId} threadId={threadId} />
      {queueDraft && (
        <div className="grid gap-2">
          <p role="status">
            {queueDraft.rejection ?? "This queue request is saved until the relay confirms it."}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              queueDraft.rejection
                ? void discardQueue()
                : void changeQueue(queueDraft.command.type === "thread.queue.resume")
            }
          >
            {queueDraft.rejection ? "Dismiss rejected request" : "Retry saved queue request"}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Reading this conversation does not start its VM. Resume or restore it, then open chat to
        continue working.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!detail && !error && <p role="status">Reading conversation…</p>}
      {detail?.history.deleted && <p>This thread was deleted.</p>}
      {detail && !thread && !detail.history.deleted && (
        <p role="status">The thread is being prepared. Refresh once setup finishes.</p>
      )}
      {start > 0 && (
        <Button size="sm" variant="secondary" onClick={() => setEarlier(earlier + 200)}>
          Earlier messages
        </Button>
      )}
      <div className="grid gap-3">
        {messages.slice(start, end).map((message) => (
          <article key={message.id} className="rounded-lg border border-border p-3">
            <p className="mb-1 text-xs text-muted-foreground">
              {message.author?.displayName ?? (message.role === "user" ? "User" : "Assistant")}
            </p>
            <div className="whitespace-pre-wrap break-words text-sm">{message.text}</div>
            {message.attachments?.map((file) => (
              <Button
                key={file.id}
                size="xs"
                variant="secondary"
                disabled={busy || (file.type !== "image" && file.type !== "file")}
                onClick={() => void downloadFile(file)}
              >
                {file.name}
              </Button>
            ))}
          </article>
        ))}
      </div>
      {earlier > 0 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEarlier(Math.max(0, earlier - 200))}
        >
          Later messages
        </Button>
      )}
      {detail?.hasMore && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void more()}>
          Read more history
        </Button>
      )}
      {detail?.hasMore ? (
        <p className="text-xs text-muted-foreground">
          Read the remaining history to see the current queue.
        </p>
      ) : (
        thread?.promptQueue && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">
              Queue {thread.promptQueue.enabled ? "enabled" : "paused"}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !queueReady || waitingForQueue || queueDraft !== null}
              onClick={() => void changeQueue(!thread.promptQueue!.enabled)}
            >
              {thread.promptQueue.enabled ? "Pause queue" : "Resume queue"}
            </Button>
            {waitingForQueue && (
              <p role="status" className="text-xs text-muted-foreground">
                Queue request accepted. Refresh to see it applied.
              </p>
            )}
            {thread.promptQueue.entries.map((entry) => (
              <p key={entry.messageId} className="text-sm">
                {entry.kind === "move" ? "Move thread" : entry.text} · {entry.state}
              </p>
            ))}
          </div>
        )
      )}
    </div>
  );
}
export function PortableThreadLibraryOverlay() {
  const session = useAtomValue(managedRelaySessionAtom),
    open = useAtomValue(portableThreadLibrary.openAtom);
  const setOpen = useAtomSet(portableThreadLibrary.openAtom);
  if (!session) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-xl" data-portable-thread-library>
        <DialogHeader>
          <DialogTitle>VM threads</DialogTitle>
          <DialogDescription>Open a conversation or manage its VM.</DialogDescription>
        </DialogHeader>
        <DialogPanel>{open && <LibraryBody key={session.accountId} />}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
export function PortableThreadLibrary() {
  const session = useAtomValue(managedRelaySessionAtom);
  const setOpen = useAtomSet(portableThreadLibrary.openAtom);
  return session ? (
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
      VM threads
    </Button>
  ) : null;
}
