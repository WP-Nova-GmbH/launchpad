import type { RelayPortableThreadSummary } from "@t3tools/contracts/relay";
import {
  portableThreadOverviewPresentation,
  portableThreadOverviewAction,
} from "@t3tools/client-runtime/relay/portableThreadLibrary";
import { useNavigation } from "@react-navigation/native";
import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import type { ThreadQueueControlSubmission } from "@t3tools/client-runtime/relay/threadQueueControlSubmission";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import * as Crypto from "expo-crypto";
import { shareAttachmentBytes } from "../../lib/attachmentDownload";
import { useAtomValue } from "@effect/atom-react";
import { CommandId, EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { StatusPill } from "../../components/StatusPill";
import { relativeTime } from "../../lib/time";
import {
  portableThreadLibrary,
  openPortableThreadChat,
  threadQueueControlJournal,
  threadVmControls,
  threadVmActionJournal,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadVmControls } from "./ThreadVmControls";
function Action({
  children,
  onPress,
  disabled = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg bg-card px-3 py-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-sm text-foreground">{children}</Text>
    </Pressable>
  );
}
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
  return (
    <View className="gap-2">
      {lifecycle.error && <Text accessibilityLiveRegion="polite">{lifecycle.error}</Text>}
      {lifecycle.entries.map((entry) => (
        <View key={entry.threadId}>
          <Text>
            Saved {entry.action.type} request for {entry.threadId}
          </Text>
          <Action
            disabled={lifecycle.busy || !lifecycle.ready}
            onPress={() => void lifecycle.run(entry)}
          >
            Retry saved VM request
          </Action>
        </View>
      ))}
    </View>
  );
}
function LibraryBody() {
  const session = useAtomValue(managedRelaySessionAtom),
    index = useAtomValue(portableThreadLibrary.indexAtom);
  const loadIndex = useAtomCommand(portableThreadLibrary.loadIndex, { reportFailure: false });
  const navigation = useNavigation();
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
        navigation.navigate("Thread", result.value);
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
                    operationId: Crypto.randomUUID(),
                    allocationId: Crypto.randomUUID(),
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
  if (!session) return <Text>Sign in to Launchpad Connect to read your VM threads.</Text>;
  return (
    <View className="flex-1 gap-3">
      <View className="flex-row gap-2">
        <Action disabled={busy} onPress={() => void load()}>
          Refresh
        </Action>
        {selected && <Action onPress={() => setSelected(null)}>All threads</Action>}
      </View>
      {!selected && allowance && (
        <View className="gap-2 rounded-xl border border-border bg-card p-4">
          <View className="flex-row flex-wrap items-center justify-between gap-3">
            <Text className="text-sm font-medium">Your VMs</Text>
            <View className="flex-row items-center gap-2.5 rounded-lg bg-subtle-strong px-2.5 py-1.5">
              {allowance.limit > 0 && allowance.limit <= 8 && (
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  className="flex-row gap-1"
                >
                  {Array.from({ length: allowance.limit }, (_, slot) => (
                    <View
                      key={slot}
                      className={`h-1.5 w-3 rounded-full ${
                        slot < allowance.used ? "bg-primary" : "bg-foreground/15"
                      }`}
                    />
                  ))}
                </View>
              )}
              <Text className="text-xs tabular-nums text-foreground-muted">
                <Text className="font-medium text-foreground">{allowance.used}</Text>
                {" / "}
                {allowance.limit} used
              </Text>
            </View>
          </View>
          <Text className="text-xs text-foreground-muted">
            Paused VMs and pending replacements use a slot.
          </Text>
        </View>
      )}
      <SavedVmRequests />
      {!selected && (
        <Text className="text-sm text-foreground-muted">
          Open a local conversation, then choose Run on → Private VM.
        </Text>
      )}
      {(error || lifecycle.error) && (
        <Text className="text-danger-foreground" accessibilityLiveRegion="polite">
          {error ?? lifecycle.error}
        </Text>
      )}
      {summary ? (
        <SavedConversation
          key={`${session.accountId}:${threadMoveRelayUrl()}:${summary.placement.threadId}`}
          threadId={ThreadId.make(summary.placement.threadId)}
          environmentId={EnvironmentId.make(summary.placement.environmentId)}
          title={summary.title}
        />
      ) : (
        <ScrollView contentContainerClassName="gap-3">
          {index && index.entries.length > 0 && (
            <View className="overflow-hidden rounded-xl border border-border">
              {index.entries.map((entry, position) => {
                const threadId = ThreadId.make(entry.placement.threadId);
                const presentation = portableThreadOverviewPresentation(entry);
                const action = portableThreadOverviewAction(entry, capabilities);
                const expanded = expandedThreadId === threadId;
                return (
                  <View
                    key={threadId}
                    className={
                      position < index.entries.length - 1 ? "border-b border-border" : undefined
                    }
                  >
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      <View className="min-w-0 flex-1 gap-2">
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Details for ${entry.title}`}
                          accessibilityState={{ expanded }}
                          onPress={() => setExpandedThreadId(expanded ? null : threadId)}
                          className="min-h-11 flex-row items-center gap-2"
                        >
                          <SymbolView
                            name={expanded ? "chevron.down" : "chevron.right"}
                            size={14}
                            tintColorClassName="accent-icon-muted"
                          />
                          <View className="min-w-0 flex-1 gap-1">
                            <Text className="text-sm font-t3-medium text-foreground">
                              {entry.title}
                            </Text>
                            {entry.vm?.projectName && (
                              <Text className="text-xs text-foreground-muted">
                                {entry.vm.projectName}
                              </Text>
                            )}
                          </View>
                        </Pressable>
                        <View className="ml-5.5 flex-row flex-wrap items-center gap-2">
                          {presentation.location && (
                            <View className="flex-row items-center gap-1.5">
                              <SymbolView
                                name={
                                  presentation.location.kind === "vm"
                                    ? "server.rack"
                                    : "desktopcomputer"
                                }
                                size={14}
                                tintColorClassName="accent-icon-muted"
                              />
                              <Text className="text-xs text-foreground">
                                {presentation.location.label}
                              </Text>
                            </View>
                          )}
                          {presentation.status && (
                            <StatusPill
                              size="compact"
                              label={presentation.status}
                              pillClassName={
                                presentation.tone === "warning"
                                  ? "bg-warning"
                                  : presentation.tone === "success"
                                    ? "bg-update"
                                    : "bg-subtle-strong"
                              }
                              textClassName={
                                presentation.tone === "warning"
                                  ? "text-warning-foreground"
                                  : presentation.tone === "success"
                                    ? "text-update-foreground"
                                    : "text-foreground-muted"
                              }
                            />
                          )}
                        </View>
                        <Text
                          className="ml-5.5 text-xs text-foreground-muted"
                          accessibilityLabel={
                            entry.vm?.lastWorkAt ? undefined : "Last work time not recorded"
                          }
                        >
                          Last work{" "}
                          {entry.vm?.lastWorkAt ? `${relativeTime(entry.vm.lastWorkAt)} ago` : "—"}
                        </Text>
                      </View>
                      <Action
                        disabled={
                          busy ||
                          (["Resume VM", "Restore VM"].includes(action) &&
                            (lifecycle.busy || !lifecycle.ready))
                        }
                        onPress={() => void runPrimary(entry)}
                      >
                        {action}
                      </Action>
                    </View>
                    {expanded && (
                      <View className="gap-3 px-4 pb-4">
                        <View className="gap-3 rounded-lg bg-subtle-strong p-3">
                          <View className="gap-1">
                            <Text className="text-xs text-foreground-muted">Activity</Text>
                            <Text className="text-xs text-foreground">{presentation.activity}</Text>
                          </View>
                          {entry.vm &&
                            (entry.vm.state !== "on_machine" || entry.vm.lastVerifiedBackupAt) && (
                              <View className="gap-1">
                                <Text className="text-xs text-foreground-muted">
                                  Workspace backup
                                </Text>
                                <Text className="text-xs text-foreground">
                                  {entry.vm.lastVerifiedBackupAt
                                    ? `Verified ${relativeTime(entry.vm.lastVerifiedBackupAt)} ago`
                                    : "No verified backup"}
                                </Text>
                              </View>
                            )}
                          {entry.vm?.savedDiskExpiresAt && (
                            <View className="gap-1">
                              <Text className="text-xs text-foreground-muted">
                                Workspace expiry
                              </Text>
                              <Text className="text-xs text-foreground">
                                {new Date(entry.vm.savedDiskExpiresAt).toLocaleString()}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Action onPress={() => setSelected(threadId)}>Read conversation</Action>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
          {index?.entries.length === 0 && <Text>No VM threads yet.</Text>}
          {!index && !error && <Text>Reading saved threads…</Text>}
          {index?.next && (
            <Action disabled={busy} onPress={() => void load(index.next!)}>
              More threads
            </Action>
          )}
        </ScrollView>
      )}
    </View>
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
  const navigation = useNavigation();
  const queueControl = useAtomCommand(portableThreadLibrary.queueControl, { reportFailure: false });
  const queueReceipt = useAtomCommand(portableThreadLibrary.queueReceipt, { reportFailure: false });
  const [queueDraft, setQueueDraft] = useState<ThreadQueueControlSubmission | null>(null);
  const [queueReady, setQueueReady] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);

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
      navigation.navigate("Thread", result.value);
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
      await shareAttachmentBytes({ bytes: result.value, attachment: file, signal: abort.signal });
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
          commandId: CommandId.make(Crypto.randomUUID()),
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
  const thread = detail?.history.thread;
  return (
    <FlatList
      data={thread?.messages ?? []}
      keyExtractor={(message) => message.id}
      contentContainerClassName="gap-3"
      ListHeaderComponent={
        <View className="gap-3">
          <Text className="text-base font-medium text-foreground">{title}</Text>
          <Action
            disabled={busy || detail?.history.deleted === true}
            onPress={() => void continueChat()}
          >
            Open chat
          </Action>
          <Action disabled={busy} onPress={() => void more(true)}>
            Refresh conversation
          </Action>
          <ThreadVmControls environmentId={environmentId} threadId={threadId} />
          {queueDraft && (
            <View className="gap-2">
              <Text accessibilityLiveRegion="polite">
                {queueDraft.rejection ??
                  (queueDraft.accepted
                    ? "Updating queue… Refresh to check its current state."
                    : "This queue request is saved until the environment confirms it.")}
              </Text>
              <Action
                disabled={busy}
                onPress={() =>
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
              </Action>
            </View>
          )}
          {currentQueue && (
            <View className="gap-2">
              <Text className="font-medium">
                Queue {currentQueue.queue.enabled ? "enabled" : "paused"}
              </Text>
              <Action
                disabled={busy || !queueReady || queueDraft !== null}
                onPress={() => void changeQueue(!currentQueue.queue!.enabled)}
              >
                {currentQueue.queue.enabled ? "Pause queue" : "Resume queue"}
              </Action>

              {currentQueue.queue.entries.map((entry) => (
                <Text key={entry.messageId}>
                  {entry.kind === "move" ? "Move thread" : entry.text} · {entry.state}
                </Text>
              ))}
            </View>
          )}
          <Text className="text-xs text-foreground-muted">
            Reading this conversation does not start its VM. Resume or restore it, then open chat to
            continue working.
          </Text>
          {error && <Text className="text-danger-foreground">{error}</Text>}
          {!detail && !error && <Text>Reading conversation…</Text>}
          {detail?.history.deleted && <Text>This thread was deleted.</Text>}
          {detail && !thread && !detail.history.deleted && (
            <Text>The thread is being prepared. Refresh once setup finishes.</Text>
          )}
        </View>
      }
      renderItem={({ item: message }) => (
        <View className="gap-1 rounded-lg border border-border p-3">
          <Text className="text-xs text-foreground-muted">
            {message.author?.displayName ?? (message.role === "user" ? "User" : "Assistant")}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {message.text}
          </Text>
          {message.attachments?.map((file) => (
            <Action
              key={file.id}
              disabled={busy || (file.type !== "image" && file.type !== "file")}
              onPress={() => void downloadFile(file)}
            >
              {file.name}
            </Action>
          ))}
        </View>
      )}
      ListFooterComponent={
        <View className="gap-2">
          {detail?.hasMore && (
            <Action disabled={busy} onPress={() => void more()}>
              Read more history
            </Action>
          )}
        </View>
      }
    />
  );
}
export function PortableThreadLibrary() {
  const session = useAtomValue(managedRelaySessionAtom);
  return <LibraryBody key={`${session?.accountId}:${threadMoveRelayUrl()}`} />;
}
