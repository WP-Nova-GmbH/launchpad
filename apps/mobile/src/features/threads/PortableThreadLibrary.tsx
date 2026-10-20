import { useNavigation } from "@react-navigation/native";
import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import type { ThreadQueueControlSubmission } from "@t3tools/client-runtime/relay/threadQueueControlSubmission";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import * as Crypto from "expo-crypto";
import { shareAttachmentBytes } from "../../lib/attachmentDownload";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CommandId, EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
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
      className="rounded-lg bg-card px-3 py-2"
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
            Saved {entry.action.type} request · {entry.threadId}
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
  if (!session) return <Text>Sign in to Launchpad Connect to read your VM threads.</Text>;
  return (
    <View className="flex-1 gap-3">
      <View className="flex-row gap-2">
        <Action disabled={busy} onPress={() => void load()}>
          Refresh
        </Action>
        {selected && <Action onPress={() => setSelected(null)}>All threads</Action>}
      </View>
      <SavedVmRequests />
      {!selected && (
        <Text className="text-sm text-muted-foreground">
          Open a local conversation, then choose Move thread → Private VM.
        </Text>
      )}
      {error && (
        <Text className="text-destructive" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {summary ? (
        <SavedConversation
          key={`${session.accountId}:${summary.placement.threadId}`}
          threadId={ThreadId.make(summary.placement.threadId)}
          environmentId={EnvironmentId.make(summary.placement.environmentId)}
          title={summary.title}
        />
      ) : (
        <ScrollView contentContainerClassName="gap-2">
          {index?.entries.map((entry) => (
            <Action
              key={entry.placement.threadId}
              onPress={() => setSelected(ThreadId.make(entry.placement.threadId))}
            >
              {entry.title}
            </Action>
          ))}
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
  const openChat = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const closeLibrary = useAtomSet(portableThreadLibrary.openAtom);
  const navigation = useNavigation();
  const queueControl = useAtomCommand(portableThreadLibrary.queueControl, { reportFailure: false });
  const [queueDraft, setQueueDraft] = useState<ThreadQueueControlSubmission | null>(null);
  const [queueReady, setQueueReady] = useState(false);
  const [requestedQueue, setRequestedQueue] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);

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
      navigation.navigate("Thread", result.value);
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
    setRequestedQueue(null);
    try {
      const draft = await threadQueueControlJournal.prepare(scope, () => {
        const queue = detail?.history.thread?.promptQueue;
        if (!queue || detail?.hasMore)
          throw new Error("Read the current queue before changing it.");
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
                {queueDraft.rejection ?? "This queue request is saved until the relay confirms it."}
              </Text>
              <Action
                disabled={busy}
                onPress={() =>
                  queueDraft.rejection
                    ? void discardQueue()
                    : void changeQueue(queueDraft.command.type === "thread.queue.resume")
                }
              >
                {queueDraft.rejection ? "Dismiss rejected request" : "Retry saved queue request"}
              </Action>
            </View>
          )}
          <Text className="text-xs text-muted-foreground">
            Reading this conversation does not start its VM. Resume or restore it, then open chat to
            continue working.
          </Text>
          {error && <Text className="text-destructive">{error}</Text>}
          {!detail && !error && <Text>Reading conversation…</Text>}
          {detail?.history.deleted && <Text>This thread was deleted.</Text>}
          {detail && !thread && !detail.history.deleted && (
            <Text>The thread is being prepared. Refresh once setup finishes.</Text>
          )}
        </View>
      }
      renderItem={({ item: message }) => (
        <View className="gap-1 rounded-lg border border-border p-3">
          <Text className="text-xs text-muted-foreground">
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
          {detail?.hasMore ? (
            <Text className="text-xs text-muted-foreground">
              Read the remaining history to see the current queue.
            </Text>
          ) : (
            thread?.promptQueue && (
              <View className="gap-2">
                <Text className="font-medium">
                  Queue {thread.promptQueue.enabled ? "enabled" : "paused"}
                </Text>
                <Action
                  disabled={busy || !queueReady || waitingForQueue || queueDraft !== null}
                  onPress={() => void changeQueue(!thread.promptQueue!.enabled)}
                >
                  {thread.promptQueue.enabled ? "Pause queue" : "Resume queue"}
                </Action>
                {waitingForQueue && (
                  <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
                    Queue request accepted. Refresh to see it applied.
                  </Text>
                )}
                {thread.promptQueue.entries.map((entry) => (
                  <Text key={entry.messageId}>
                    {entry.kind === "move" ? "Move thread" : entry.text} · {entry.state}
                  </Text>
                ))}
              </View>
            )
          )}
        </View>
      }
    />
  );
}
function EnabledPortableThreadLibrary() {
  const session = useAtomValue(managedRelaySessionAtom),
    open = useAtomValue(portableThreadLibrary.openAtom);
  const setOpen = useAtomSet(portableThreadLibrary.openAtom);
  if (!session) return null;
  return (
    <>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 gap-3 bg-screen p-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-medium">VM threads</Text>
            <Action onPress={() => setOpen(false)}>Close</Action>
          </View>
          {open && <LibraryBody key={session.accountId} />}
        </SafeAreaView>
      </Modal>
    </>
  );
}
export function PortableThreadLibraryOverlay() {
  return process.env.EXPO_PUBLIC_THREAD_VM_CONTROLS_ENABLED === "1" ? (
    <EnabledPortableThreadLibrary />
  ) : null;
}

export function PortableThreadLibrary() {
  const session = useAtomValue(managedRelaySessionAtom);
  const setOpen = useAtomSet(portableThreadLibrary.openAtom);
  return session && process.env.EXPO_PUBLIC_THREAD_VM_CONTROLS_ENABLED === "1" ? (
    <Action onPress={() => setOpen(true)}>VM threads</Action>
  ) : null;
}
