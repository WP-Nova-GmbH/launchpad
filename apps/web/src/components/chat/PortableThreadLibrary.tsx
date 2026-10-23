import type { RelayPortableThreadSummary } from "@t3tools/contracts/relay";
import {
  portableThreadOverviewPresentation,
  portableThreadOverviewAction,
} from "@t3tools/client-runtime/relay/portableThreadLibrary";
import { useNavigate } from "@tanstack/react-router";
import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import type { ThreadQueueControlSubmission } from "@t3tools/client-runtime/relay/threadQueueControlSubmission";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { CommandId, EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  MonitorIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
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
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
            Saved {entry.action.type} request for {entry.threadId}
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
  const navigate = useNavigate();
  const openChat = useAtomCommand(openPortableThreadChat, { reportFailure: false });
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

  const overviewAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    overviewAbort.current = controller;
    return () => controller.abort();
  }, [session]);
  const [expandedThreadId, setExpandedThreadId] = useState<ThreadId | null>(null);
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
  const capabilityState = useAtomValue(threadVmControls.capabilitiesAtom);
  const capabilities =
    capabilityState.error || capabilityState.isPending ? null : capabilityState.data;
  const runPrimary = async (entry: RelayPortableThreadSummary) => {
    const abort = overviewAbort.current;
    if (!abort || abort.signal.aborted) return;
    const label = portableThreadOverviewAction(entry, capabilities);
    if (label === "Manage VM") {
      setSelected(ThreadId.make(entry.placement.threadId));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    const threadId = ThreadId.make(entry.placement.threadId),
      environmentId = EnvironmentId.make(entry.placement.environmentId);
    try {
      if (label === "Open chat") {
        const result = await openChat({
          threadId,
          title: entry.title,
          expectedPlacement: { environmentId, generation: entry.placement.generation },
        });
        if (abort.signal.aborted) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        await navigate({ to: "/$environmentId/$threadId", params: result.value });
      } else {
        const success = await lifecycle.run({
          environmentId,
          threadId,
          action:
            label === "Resume VM"
              ? { type: "resume" }
              : {
                  type: "restore",
                  payload: {
                    operationId: randomUUID(),
                    allocationId: randomUUID(),
                    savedDiskOperationId: entry.vm!.savedDiskOperationId!,
                    expectedGeneration: entry.placement.generation,
                  },
                },
        });
        if (success && !abort.signal.aborted) {
          await loadIndex({});
          setSelected(threadId);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the VM action.");
    } finally {
      setBusy(false);
    }
  };
  const summary = index?.entries.find((entry) => entry.placement.threadId === selected);
  const allowance = index?.allowance;
  if (
    expandedThreadId &&
    index &&
    !index.entries.some((entry) => entry.placement.threadId === expandedThreadId)
  ) {
    setExpandedThreadId(null);
  }
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
      {!selected && allowance && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">Your VMs</p>
            <div className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-2.5 py-1.5">
              {allowance.limit > 0 && allowance.limit <= 8 && (
                <span aria-hidden className="flex gap-1">
                  {Array.from({ length: allowance.limit }, (_, slot) => (
                    <span
                      key={slot}
                      className={`h-1.5 w-3 rounded-full ${
                        slot < allowance.used ? "bg-primary" : "bg-foreground/15"
                      }`}
                    />
                  ))}
                </span>
              )}
              <span className="text-xs tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{allowance.used}</span>
                {" / "}
                {allowance.limit} used
              </span>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Paused VMs and pending replacements use a slot.
          </p>
        </div>
      )}
      <SavedVmRequests />
      {(error || lifecycle.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error ?? lifecycle.error}
        </p>
      )}
      {summary ? (
        <SavedConversation
          key={`${session.accountId}:${threadMoveRelayUrl()}:${summary.placement.threadId}`}
          threadId={ThreadId.make(summary.placement.threadId)}
          environmentId={EnvironmentId.make(summary.placement.environmentId)}
          title={summary.title}
        />
      ) : (
        <>
          {index && index.entries.length > 0 && (
            <div className="@container/vm-conversations overflow-hidden rounded-xl border border-border/70">
              <div
                aria-hidden
                className="hidden grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.75fr)_8rem] gap-4 border-b border-border/60 px-4 py-3 text-xs text-muted-foreground @min-[40rem]/vm-conversations:grid"
              >
                <span>Conversation</span>
                <span>Location</span>
                <span>Last work</span>
                <span />
              </div>
              <ul aria-label="VM conversations" className="divide-y divide-border/60">
                {index.entries.map((entry) => {
                  const threadId = ThreadId.make(entry.placement.threadId);
                  const presentation = portableThreadOverviewPresentation(entry);
                  const action = portableThreadOverviewAction(entry, capabilities);
                  return (
                    <li key={threadId}>
                      <Collapsible
                        open={expandedThreadId === threadId}
                        onOpenChange={(open) => setExpandedThreadId(open ? threadId : null)}
                      >
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 @min-[40rem]/vm-conversations:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.75fr)_8rem]">
                          <CollapsibleTrigger
                            aria-label={`Details for ${entry.title}`}
                            className="group col-start-1 row-start-1 flex min-h-11 min-w-0 items-center gap-2 text-left"
                          >
                            <ChevronRightIcon
                              aria-hidden
                              className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                            />
                            <span className="grid min-w-0 gap-1">
                              <span className="wrap-anywhere text-sm font-medium leading-snug">
                                {entry.title}
                              </span>
                              {entry.vm?.projectName && (
                                <span className="wrap-anywhere text-xs text-muted-foreground">
                                  {entry.vm.projectName}
                                </span>
                              )}
                            </span>
                          </CollapsibleTrigger>
                          <div className="col-start-1 row-start-2 ml-5.5 flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]/vm-conversations:col-start-2 @min-[40rem]/vm-conversations:row-start-1 @min-[40rem]/vm-conversations:ml-0 @min-[40rem]/vm-conversations:flex-col @min-[40rem]/vm-conversations:items-start">
                            {presentation.location && (
                              <span className="flex items-center gap-1.5 text-xs">
                                {presentation.location.kind === "vm" ? (
                                  <ServerIcon
                                    aria-hidden
                                    className="size-3.5 text-muted-foreground"
                                  />
                                ) : (
                                  <MonitorIcon
                                    aria-hidden
                                    className="size-3.5 text-muted-foreground"
                                  />
                                )}
                                {presentation.location.label}
                              </span>
                            )}
                            {presentation.status && (
                              <Badge
                                variant={
                                  presentation.tone === "neutral" ? "secondary" : presentation.tone
                                }
                              >
                                {presentation.status === "Ready" && <CheckIcon aria-hidden />}
                                {presentation.status}
                              </Badge>
                            )}
                          </div>
                          <span className="col-start-1 row-start-3 ml-5.5 text-xs text-muted-foreground @min-[40rem]/vm-conversations:col-start-3 @min-[40rem]/vm-conversations:row-start-1 @min-[40rem]/vm-conversations:ml-0">
                            <span className="sr-only">Last work: </span>
                            {entry.vm?.lastWorkAt ? (
                              <time dateTime={entry.vm.lastWorkAt}>
                                {formatRelativeTimeLabel(entry.vm.lastWorkAt)}
                              </time>
                            ) : (
                              <span aria-label="Last work time not recorded">—</span>
                            )}
                          </span>
                          <div className="col-start-2 row-span-3 row-start-1 justify-self-end @min-[40rem]/vm-conversations:col-start-4 @min-[40rem]/vm-conversations:row-span-1">
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={
                                busy ||
                                (["Resume VM", "Restore VM"].includes(action) &&
                                  (lifecycle.busy || !lifecycle.ready))
                              }
                              onClick={() => void runPrimary(entry)}
                            >
                              {action}
                            </Button>
                          </div>
                        </div>
                        <CollapsiblePanel>
                          <div className="grid gap-3 px-4 pb-4">
                            <dl className="grid gap-3 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-2">
                              <div className="grid gap-1">
                                <dt className="text-muted-foreground">Activity</dt>
                                <dd>{presentation.activity}</dd>
                              </div>
                              {entry.vm &&
                                (entry.vm.state !== "on_machine" ||
                                  entry.vm.lastVerifiedBackupAt) && (
                                  <div className="grid gap-1">
                                    <dt className="text-muted-foreground">Workspace backup</dt>
                                    <dd>
                                      {entry.vm.lastVerifiedBackupAt ? (
                                        <time dateTime={entry.vm.lastVerifiedBackupAt}>
                                          Verified{" "}
                                          {formatRelativeTimeLabel(entry.vm.lastVerifiedBackupAt)}
                                        </time>
                                      ) : (
                                        "No verified backup"
                                      )}
                                    </dd>
                                  </div>
                                )}
                              {entry.vm?.savedDiskExpiresAt && (
                                <div className="grid gap-1">
                                  <dt className="text-muted-foreground">Workspace expiry</dt>
                                  <dd>
                                    <time dateTime={entry.vm.savedDiskExpiresAt}>
                                      {new Date(entry.vm.savedDiskExpiresAt).toLocaleString()}
                                    </time>
                                  </dd>
                                </div>
                              )}
                            </dl>
                            <div>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setSelected(threadId)}
                              >
                                Read conversation
                                <ChevronRightIcon aria-hidden />
                              </Button>
                            </div>
                          </div>
                        </CollapsiblePanel>
                      </Collapsible>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {index?.entries.length === 0 && (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <MessageSquareIcon aria-hidden className="mb-1 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">No VM threads yet</p>
              <p className="text-sm text-muted-foreground">
                Open a local conversation, then choose Run on → Private VM.
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
              Move a local conversation here with Run on → Private VM. Opening a saved conversation
              does not start its VM.
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
  const currentQueue = useAtomValue(portableThreadLibrary.queueAtom(threadId));
  const loadQueue = useAtomCommand(portableThreadLibrary.loadQueue, { reportFailure: false });
  const openChat = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const navigate = useNavigate();
  const queueControl = useAtomCommand(portableThreadLibrary.queueControl, { reportFailure: false });
  const queueReceipt = useAtomCommand(portableThreadLibrary.queueReceipt, { reportFailure: false });
  const [queueDraft, setQueueDraft] = useState<ThreadQueueControlSubmission | null>(null);
  const [queueReady, setQueueReady] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [earlier, setEarlier] = useState(0);

  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const accountAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!session || !relayUrl) return;
    const controller = new AbortController();
    accountAbort.current = controller;
    return () => controller.abort();
  }, [session, relayUrl]);
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
    } catch {
      if (!abort.signal.aborted) setError("Could not open this chat. Try again.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const refreshQueue = useCallback(
    async (signal: AbortSignal) => {
      if (!session || !relayUrl || signal.aborted) return;
      const check = () => {
        if (signal.aborted) throw new Error("The queue check was cancelled.");
      };
      const scope = { accountId: session.accountId, relayUrl, threadId };
      const next = await threadQueueControlJournal
        .refresh(
          scope,
          async (commandId) => {
            check();
            const result = await loadQueue({ threadId, ...(commandId ? { commandId } : {}) });
            check();
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            if (!result.value) throw new Error("Could not read the current queue.");
            return result.value;
          },
          async (commandId) => {
            check();
            const result = await queueReceipt({ threadId, commandId });
            check();
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return result.value;
          },
        )
        .catch(async (cause) => {
          // A receipt may be durable even when the subsequent queue read fails.
          const saved = await threadQueueControlJournal.read(scope);
          if (!signal.aborted) setQueueDraft(saved);
          throw cause;
        });
      if (!signal.aborted) {
        setQueueDraft(next);
        setQueueReady(true);
        if (next?.rejection) setError(next.rejection);
      }
    },
    [session, relayUrl, threadId, loadQueue, queueReceipt],
  );
  useEffect(() => {
    const abort = accountAbort.current;
    if (!session || !relayUrl || !abort || abort.signal.aborted) return;
    void threadQueueControlJournal
      .read({ accountId: session.accountId, relayUrl, threadId })
      .then(async (draft) => {
        if (abort.signal.aborted) return;
        setQueueDraft(draft);
        setQueueReady(true);
        setBusy(false);
        setError(draft?.rejection ?? null);
        await refreshQueue(abort.signal);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setBusy(false);
          setError(
            cause instanceof Error ? cause.message : "Could not verify the saved queue request.",
          );
        }
      });
  }, [session, relayUrl, threadId, refreshQueue]);

  const download = useAtomCommand(portableThreadLibrary.downloadAttachment, {
    reportFailure: false,
  });

  const loadHistory = useAtomCommand(portableThreadLibrary.loadHistory, { reportFailure: false });
  useEffect(() => {
    if (!session) return;
    let active = true;
    void loadHistory({ threadId }).then((result) => {
      if (active && result._tag !== "Success")
        setError(failureMessage(result, "Could not read this conversation."));
    });
    return () => {
      active = false;
    };
  }, [session, threadId, loadHistory]);
  const more = async (refresh = false) => {
    const abort = accountAbort.current;
    if (!abort || abort.signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (refresh) await refreshQueue(abort.signal);
      if (abort.signal.aborted) return;
      const result = await loadHistory({
        threadId,
        ...(refresh ? { refresh: true } : { more: true }),
      });
      if (!abort.signal.aborted && result._tag !== "Success")
        setError(failureMessage(result, "Could not read more history."));
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not refresh this conversation.");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
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
    try {
      const draft = await threadQueueControlJournal.prepare(scope, currentQueue, () => {
        const queue = currentQueue?.queue;
        if (!queue) throw new Error("Read the current queue before changing it.");
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
      if (draft.accepted) {
        await refreshQueue(abort.signal);
        return;
      }
      const result = await queueControl({ accountId: session.accountId, command: draft.command });
      if (abort.signal.aborted) return;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const next = await threadQueueControlJournal.acknowledge(scope, draft.command, result.value);
      if (abort.signal.aborted) return;
      setQueueDraft(next);
      if (next?.rejection) setError(next.rejection);
      else await refreshQueue(abort.signal);
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
  const thread = detail?.history.thread,
    messages = thread?.messages ?? [],
    end = Math.max(0, messages.length - earlier),
    start = Math.max(0, end - 200);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 text-base font-medium">{title}</h3>
        <div className="flex items-center gap-2">
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
        </div>
      </div>
      <ThreadVmControls environmentId={environmentId} threadId={threadId} />
      {queueDraft && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status">
            {queueDraft.rejection ??
              (queueDraft.accepted
                ? "Updating queue… Refresh to check its current state."
                : "This queue request is saved until the environment confirms it.")}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              queueDraft.rejection
                ? void discardQueue()
                : queueDraft.accepted
                  ? void more(true)
                  : void changeQueue(queueDraft.command.type === "thread.queue.resume")
            }
          >
            {queueDraft.rejection
              ? "Dismiss rejected request"
              : queueDraft.accepted
                ? "Check current queue"
                : "Retry saved queue request"}
          </Button>
        </div>
      )}
      {currentQueue && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">
            Queue {currentQueue.queue.enabled ? "enabled" : "paused"}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !queueReady || queueDraft !== null}
            onClick={() => void changeQueue(!currentQueue.queue!.enabled)}
          >
            {currentQueue.queue.enabled ? "Pause queue" : "Resume queue"}
          </Button>

          {currentQueue.queue.entries.map((entry) => (
            <p key={entry.messageId} className="w-full text-sm">
              {entry.kind === "move" ? "Move thread" : entry.text} · {entry.state}
            </p>
          ))}
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
    </div>
  );
}
export function PortableThreadLibrary() {
  const session = useAtomValue(managedRelaySessionAtom);
  return <LibraryBody key={`${session?.accountId}:${threadMoveRelayUrl()}`} />;
}
