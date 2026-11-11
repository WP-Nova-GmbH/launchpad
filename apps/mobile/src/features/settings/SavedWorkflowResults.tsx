import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import * as Effect from "effect/Effect";
import { useAtomValue } from "@effect/atom-react";
import { threadVmControls } from "../../state/threads";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import type { RepositoryWorkflowJob, WorkflowSavedResult } from "@t3tools/contracts/workflows";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  makeWorkflowSavedResultReader,
  currentWorkflowSavedResult,
  savedWorkflowThreadState,
  canDeleteSavedWorkflowThread,
  type SavedWorkflowResultRead,
} from "@t3tools/client-runtime/relay/workflow-saved-results";
import type { PortableThreadHistory } from "@t3tools/client-runtime/relay/portableThreadHistory";
import {
  beginWorkflowReview,
  recordSavedWorkflowReviewDiff,
  requireFreshWorkflowReviewRead,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { workflowResultCheckpoint } from "@t3tools/client-runtime/relay/workflow-result";
import { appAtomRegistry } from "../../state/atom-registry";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SavedConversationMessage } from "../threads/SavedConversationMessage";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { shareAttachmentBytes } from "../../lib/attachmentDownload";
import { uuidv4 } from "../../lib/uuid";
import { buildReviewParsedDiff } from "../review/reviewModel";
import {
  buildNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import {
  resolveNativeReviewDiffView,
  isNativeReviewDiffDrawEvent,
} from "../diffs/nativeReviewDiffSurface";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "./appearance/useAppearanceCodeSurface";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
type Call = <A>(
  operation: (
    client: Client,
    token: string,
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
) => Promise<A>;
const EMPTY: ReadonlyArray<string> = [];
function SavedChanges({
  read,
  onVisible,
}: {
  read: SavedWorkflowResultRead;
  onVisible: () => void;
}) {
  const parsed = useMemo(
    () =>
      buildReviewParsedDiff(
        read.patch,
        `saved:${read.result.resultId}:${read.result.patch.sha256}`,
        true,
      ),
    [read],
  );
  const data = useMemo(() => buildNativeReviewDiffData(parsed), [parsed]);
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>([]);
  const NativeView = resolveNativeReviewDiffView();
  const { themeAppearance } = useAppearancePreferences();
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const bridge = useNativeReviewDiffBridge({
    threadKey: read.result.resultId,
    sectionId: read.result.resultId,
    diff: read.patch,
    data,
    collapsedFileIds: collapsed,
    viewedFileIds: EMPTY,
    selectedRowIds: EMPTY,
    canHighlight: true,
  });
  useLayoutEffect(() => {
    if (parsed.kind === "empty") onVisible();
  }, [parsed.kind, onVisible]);
  if (parsed.kind === "empty")
    return <Text className="p-4 text-sm text-foreground-muted">No file changes.</Text>;
  if (!NativeView)
    return (
      <ErrorBanner
        title="Diff view unavailable"
        message="Rebuild the development app to inspect this saved diff."
      />
    );
  return (
    <View style={{ height: 420 }}>
      <NativeView
        style={{ flex: 1 }}
        appearanceScheme={themeAppearance}
        rowHeight={nativeReviewDiffStyle.rowHeight}
        contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
        rowsJson={bridge.rowsJson}
        themeJson={bridge.themeJson}
        styleJson={bridge.styleJson}
        tokensPatchJson={bridge.tokensPatchJson}
        tokensResetKey={bridge.tokensResetKey}
        contentResetKey={read.result.resultId}
        collapsedFileIdsJson={bridge.collapsedFileIdsJson}
        onDebug={(event) => {
          bridge.onDebug(event);
          if (parsed.kind === "files" && isNativeReviewDiffDrawEvent(event.nativeEvent))
            onVisible();
        }}
        onToggleFile={(event) => {
          const id = event.nativeEvent.fileId;
          if (id)
            setCollapsed((ids) =>
              ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
            );
        }}
      />
    </View>
  );
}

export function SavedWorkflowResults({
  scope,
  job,
  call,
  refresh,
  canConfigure,
  onReviewTargetChange,
}: {
  scope: WorkflowScope;
  job: RepositoryWorkflowJob;
  call: Call;
  refresh: () => Promise<void>;
  canConfigure: boolean;
  onReviewTargetChange?: (current: boolean) => void;
}) {
  const [index, setIndex] = useState<{
    relayUrl: string;
    results: ReadonlyArray<WorkflowSavedResult>;
    nextCursor: number | null;
    threadId: ThreadId;
    generation: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const [view, setView] = useState<"changes" | "conversation">("changes");
  const [loaded, setLoaded] = useState<SavedWorkflowResultRead | null>(null);
  const [conversation, setConversation] = useState<{
    resultId: string;
    history: PortableThreadHistory;
    more: boolean;
  } | null>(null);
  const [moreControlsOpen, setMoreControlsOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const deleteIntent = useRef<string | null>(null);
  const [deletionRequested, setDeletionRequested] = useState(false);
  const threadState = savedWorkflowThreadState(job);
  const deleted = deletionRequested || threadState === "deleted";
  const waitingForThread = threadState === "not_started";
  const capabilities = useAtomValue(threadVmControls.capabilitiesAtom);
  const canDelete = canDeleteSavedWorkflowThread(job, canConfigure, capabilities);
  const latestDeletionAccess = useRef(canDelete);
  useLayoutEffect(() => {
    latestDeletionAccess.current = canDelete;
  }, [canDelete]);
  const abort = useRef<AbortController>(new AbortController());
  useEffect(() => {
    abort.current = new AbortController();
    return () => {
      abort.current.abort();
      request.current++;
    };
  }, []);
  const reader = useMemo(
    () =>
      makeWorkflowSavedResultReader(
        JSON.stringify([
          scope.accountId,
          index?.relayUrl,
          scope.organizationId,
          scope.repositoryId,
          job.jobId,
        ]),
      ),
    [scope.accountId, scope.organizationId, scope.repositoryId, job.jobId, index?.relayUrl],
  );
  useEffect(() => () => reader.clear(), [reader]);
  useEffect(() => {
    if (deleted || waitingForThread) return;
    let current = true;
    void call((client, token) =>
      client
        .listSavedWorkflowResults({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
        })
        .pipe(Effect.map((data) => ({ ...data, relayUrl: client.relayUrl }))),
    )
      .then((data) => {
        if (current) {
          setIndex((previous) => ({
            ...data,
            results:
              previous &&
              selectedRef.current &&
              !data.results.some((entry) => entry.resultId === selectedRef.current)
                ? [
                    ...data.results,
                    ...previous.results.filter((entry) => entry.resultId === selectedRef.current),
                  ]
                : data.results,
          }));
          setError(null);
          setSelected((id) => id ?? data.results[0]?.resultId ?? null);
        }
      })
      .catch(() => {
        if (current) {
          reader.clear();
          setIndex(null);
          setLoaded(null);
          setConversation(null);
          setError("Could not read saved results. Refresh to retry.");
        }
      });
    return () => {
      current = false;
    };
  }, [
    call,
    scope.repositoryId,
    job.jobId,
    job.progress?.resultSaving?.publicationId,
    job.progress?.resultSaving?.state,
    job.progress?.checkpoint?.checkpointId,
    reader,
    retry,
    deleted,
    waitingForThread,
  ]);
  const result = index?.results.find((entry) => entry.resultId === selected) ?? null;
  const currentResult = currentWorkflowSavedResult(job, index?.results ?? []);
  const reviewingCurrent = !!result && result.resultId === currentResult?.resultId;
  useLayoutEffect(() => {
    onReviewTargetChange?.(reviewingCurrent);
  }, [onReviewTargetChange, reviewingCurrent]);
  const selectResult = (id: string | null) => {
    setBrowsingHistory(true);
    setSelected(id);
  };
  const returnToCurrent = () => {
    setView("changes");
    setBrowsingHistory(false);
    if (currentResult) setSelected(currentResult.resultId);
    else setRetry((n) => n + 1);
  };
  const resultLabel = reviewingCurrent
    ? job.status === "awaiting_review"
      ? "Current review result"
      : "Latest result"
    : "Earlier result";
  const stepTitle = (stepId: string) =>
    job.workflow?.definition.steps.find((step) => step.id === stepId)?.title ?? stepId;
  useEffect(() => {
    const id = ++request.current;
    setLoaded(null);
    setConversation(null);
    if (!result) return;
    setBusy(true);
    setError(null);
    void reader
      .read(result, () =>
        call((client, token) =>
          client.readSavedWorkflowResult({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: job.jobId,
            resultId: result.resultId,
          }),
        ),
      )
      .then((data) => {
        if (request.current === id) setLoaded(data);
      })
      .catch(() => {
        if (request.current === id) setError("Could not read this saved result. Refresh to retry.");
      })
      .finally(() => {
        if (request.current === id) setBusy(false);
      });
    return () => {
      request.current++;
    };
  }, [reader, result, call, scope.repositoryId, job.jobId, retry]);
  const recorded = useRef<string | null>(null);
  const visible = useCallback(() => {
    const checkpoint = workflowResultCheckpoint(job.progress?.checkpoint);
    if (!loaded || !checkpoint || job.status !== "awaiting_review") return;
    const key = `${checkpoint.checkpointId}:${loaded.result.resultId}`;
    if (recorded.current === key) return;
    recorded.current = key;
    const visit = uuidv4();
    beginWorkflowReview(appAtomRegistry, scope, job.jobId, visit, checkpoint);
    if (recordSavedWorkflowReviewDiff(appAtomRegistry, scope, job.jobId, visit, loaded.result)) {
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, job.jobId);
      void refresh();
    }
  }, [loaded, job.progress?.checkpoint, job.status, job.jobId, scope, refresh]);
  const history = useCallback(
    async (more = false) => {
      if (!result || job.runtime?.kind !== "vm") return;
      const id = request.current;
      setBusy(true);
      setError(null);
      try {
        const next = await reader.history(
          ThreadId.make(job.runtime.threadId),
          more && conversation?.resultId === result.resultId ? conversation.history : null,
          (after) =>
            call((client, token) =>
              client.getSavedWorkflowHistory({
                clerkToken: token,
                repositoryId: scope.repositoryId,
                jobId: job.jobId,
                resultId: result.resultId,
                after,
                limit: 200,
              }),
            ),
        );
        if (request.current === id) setConversation({ resultId: result.resultId, ...next });
      } catch {
        if (request.current === id) setError("Could not read the saved conversation.");
      } finally {
        if (request.current === id) setBusy(false);
      }
    },
    [reader, result, job.runtime, job.jobId, scope.repositoryId, conversation, call],
  );
  useEffect(() => {
    if (
      view === "conversation" &&
      result &&
      conversation?.resultId !== result.resultId &&
      !busy &&
      !error
    )
      void history();
  }, [view, result, conversation, busy, error, history]);
  const download = async (file: ChatAttachment) => {
    if (!result || (file.type !== "file" && file.type !== "image")) return;
    const id = request.current;
    try {
      const bytes = await call((client, token) =>
        client.downloadSavedWorkflowAttachment({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
          resultId: result.resultId,
          attachmentId: file.id,
        }),
      );
      if (request.current === id)
        await shareAttachmentBytes({ bytes, attachment: file, signal: abort.current.signal });
    } catch {
      if (request.current === id) setError("Could not download the saved attachment.");
    }
  };
  const moreResults = async () => {
    if (!index?.nextCursor || busy) return;
    const id = request.current;
    setBusy(true);
    try {
      const page = await call((client, token) =>
        client.listSavedWorkflowResults({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
          before: index.nextCursor!,
        }),
      );
      if (request.current === id)
        setIndex((previous) =>
          previous
            ? {
                ...previous,
                nextCursor: page.nextCursor,
                results: [
                  ...new Map(
                    [...previous.results, ...page.results].map((entry) => [entry.resultId, entry]),
                  ).values(),
                ],
              }
            : null,
        );
    } catch {
      if (request.current === id) setError("Could not load older Agent results.");
    } finally {
      if (request.current === id) setBusy(false);
    }
  };
  const deleteThread = async () => {
    if (!index || busy || !canDelete) return;
    if (!deleteIntent.current) {
      const confirmed = await new Promise<boolean>((resolve) =>
        Alert.alert(
          "Delete workflow thread?",
          "Permanently remove its saved results and VM workspace? This cannot be undone.",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Delete thread", style: "destructive", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      );
      if (!confirmed) return;
      deleteIntent.current = uuidv4();
    }
    if (
      !latestDeletionAccess.current ||
      !canDeleteSavedWorkflowThread(
        job,
        canConfigure,
        appAtomRegistry.get(threadVmControls.capabilitiesAtom),
      ) ||
      abort.current.signal.aborted
    )
      return;
    const id = request.current;
    setBusy(true);
    try {
      await call((client, token) =>
        client.permanentlyDeleteThread({
          clerkToken: token,
          threadId: index.threadId,
          payload: {
            operationId: deleteIntent.current!,
            expectedGeneration: index.generation,
            confirmWorkspaceLoss: true,
          },
        }),
      );
      if (request.current === id) {
        reader.clear();
        abort.current.abort();
        request.current++;
        setIndex(null);
        setLoaded(null);
        setConversation(null);
        setDeletionRequested(true);
        setBusy(false);
        void refresh();
      }
    } catch {
      if (request.current === id) {
        setError(
          "Could not confirm thread deletion. Retry deleting to reconcile the same request.",
        );
        setBusy(false);
      }
    }
  };
  if (deleted)
    return (
      <Text className="p-4 text-sm text-foreground-muted">
        Thread deletion requested. Its saved results are no longer available.
      </Text>
    );
  return (
    <View className="gap-3 p-4">
      {result ? (
        <View className="gap-1">
          <Text accessibilityRole="header" className="font-t3-medium text-sm text-foreground">
            {stepTitle(result.stepId)}
          </Text>
          <Text className="text-xs text-foreground-muted">{resultLabel}</Text>
          <Text className="text-xs text-foreground-muted">
            Saved{" "}
            {new Date(result.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </Text>
        </View>
      ) : null}
      {job.status === "awaiting_review" && result && !reviewingCurrent ? (
        <View className="gap-1">
          <Text className="font-t3-medium text-sm text-foreground">
            {browsingHistory ? "Earlier result" : "A newer result needs review"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {browsingHistory
              ? "This saved result is read-only. Decisions apply to the current review."
              : "Your opened result has been kept in place. Open the current result before deciding."}
          </Text>
          <SettingsActionRow
            icon="arrow.uturn.backward"
            label={
              currentResult
                ? browsingHistory
                  ? "Return to current review"
                  : "Review latest"
                : "Refresh results"
            }
            onPress={returnToCurrent}
          />
        </View>
      ) : null}
      {error ? (
        <ErrorBanner message={error}>
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Retry"
            onPress={() => {
              setError(null);
              setRetry((n) => n + 1);
            }}
          />
        </ErrorBanner>
      ) : null}
      <ScrollView horizontal>
        {index?.results.map((entry) => (
          <Pressable
            key={entry.resultId}
            accessibilityRole="button"
            accessibilityState={{ selected: entry.resultId === selected }}
            className="mr-2 min-h-11 justify-center rounded-lg bg-card px-3"
            onPress={() => selectResult(entry.resultId)}
          >
            <Text className="text-sm text-foreground">{stepTitle(entry.stepId)}</Text>
            <Text className="text-xs text-foreground-muted">
              {new Date(entry.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}{" "}
              / {entry.outcome}
              {entry.resultId === currentResult?.resultId ? " / Current" : " / Earlier"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {index?.nextCursor ? (
        <SettingsActionRow
          icon="arrow.down"
          label="Load older results"
          disabled={busy}
          onPress={() => void moreResults()}
        />
      ) : null}
      <SegmentedControl
        size="compact"
        role="tab"
        options={[
          { value: "changes", label: "Changes" },
          { value: "conversation", label: "Conversation" },
        ]}
        selected={view}
        onSelect={setView}
      />
      {!waitingForThread && (!index || busy) && !error ? (
        <Text accessibilityRole="text" className="text-sm text-foreground-muted">
          Loading saved {view}…
        </Text>
      ) : null}
      {(waitingForThread || index) && !result ? (
        <Text className="text-sm text-foreground-muted">
          {job.status === "failed" || job.status === "cancelled"
            ? "No safely captured Agent result is available."
            : "No Agent result has been saved yet."}
        </Text>
      ) : null}
      {view === "changes" && loaded && loaded.result.resultId === result?.resultId ? (
        <SavedChanges read={loaded} onVisible={visible} />
      ) : null}
      {view === "conversation" && conversation && conversation.resultId === result?.resultId ? (
        <View>
          {!conversation.history.thread?.messages.length ? (
            <Text className="text-sm text-foreground-muted">
              No saved messages for this Agent result.
            </Text>
          ) : null}
          {conversation.history.thread?.messages.map((message) => (
            <SavedConversationMessage
              key={message.id}
              message={message}
              expanded={expanded.has(message.id)}
              onToggle={(id) =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              busy={busy}
              onDownload={download}
            />
          ))}
          {conversation.more ? (
            <SettingsActionRow
              icon="arrow.down"
              label="Load more"
              disabled={busy}
              onPress={() => void history(true)}
            />
          ) : null}
        </View>
      ) : null}
      {canDelete ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: moreControlsOpen }}
            className="min-h-11 justify-center"
            onPress={() => setMoreControlsOpen((open) => !open)}
          >
            <Text className="text-sm text-foreground-muted">More controls</Text>
          </Pressable>
          {moreControlsOpen ? (
            <SettingsActionRow
              icon="trash"
              label="Delete thread permanently"
              tone="danger"
              disabled={busy}
              onPress={() => void deleteThread()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
