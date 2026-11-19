import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { threadVmControls } from "../../state/threads";
import type { ThreadId, ChatAttachment } from "@t3tools/contracts";
import {
  RelayTenancyNotFoundError,
  type RelayThreadDeletionRequest,
} from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  WorkflowSavedResult,
  workflowApprovalCanRetry,
  workflowIsFinishing,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import {
  makeWorkflowSavedResultReader,
  currentWorkflowSavedResult,
  isCurrentWorkflowReviewResult,
  savedWorkflowThreadState,
  canDeleteSavedWorkflowThread,
  type SavedWorkflowResultRead,
} from "@t3tools/client-runtime/relay/workflow-saved-results";
import type { PortableThreadHistory } from "@t3tools/client-runtime/relay/portableThreadHistory";
import {
  beginWorkflowReview,
  recordSavedWorkflowReviewDiff,
  requireFreshWorkflowReviewRead,
  workflowJobAccessLost,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  sameWorkflowResultCheckpoint,
  workflowResultCheckpoint,
  type WorkflowResultCheckpoint,
} from "@t3tools/client-runtime/relay/workflow-result";
import {
  Columns2Icon,
  FileCheck2Icon,
  FileDiffIcon,
  LockIcon,
  RotateCwIcon,
  Rows3Icon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getRenderablePatch } from "../../lib/diffRendering";
import { cn, randomUUID } from "../../lib/utils";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { SavedConversationMessage } from "../chat/SavedConversationMessage";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SavedWorkflowResultPicker } from "./SavedWorkflowResultPicker";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { useWorkflowClient, workflowError } from "./workflowState";
import { WorkflowRequestNotSentError } from "./workflowOperations";

const sameSavedResult = Schema.toEquivalence(WorkflowSavedResult);
const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isNotFound = Schema.is(Schema.Struct({ cause: RelayTenancyNotFoundError }));

type DeletionTarget = { relayUrl: string; threadId: ThreadId; generation: number };
type HistoryRequest = { key: string; scope: string; epoch: number };
type HistoryRead = {
  request: HistoryRequest;
  state: "loading" | "retrying" | "failed";
};
type DeletionIntent = DeletionTarget & { payload: RelayThreadDeletionRequest };
type DeletionState =
  | { state: "confirming"; target: DeletionTarget }
  | { state: "unconfirmed" | "blocked"; intent: DeletionIntent; relayChanged?: boolean }
  | { state: "requesting" | "checking" | "requested" | "changed" | "unavailable" | "not-sent" };

function sameThreadPlacement(left: DeletionTarget, right: DeletionTarget | null) {
  return (
    right !== null &&
    left.relayUrl === right.relayUrl &&
    left.threadId === right.threadId &&
    left.generation === right.generation
  );
}

type CachedResultRange = {
  firstId: string;
  lastId: string;
  nextCursor: number | null;
};

/** A fetched page must reach the first row of a cached range before we can skip it. */
function continueSavedResults(
  page: { results: ReadonlyArray<WorkflowSavedResult>; nextCursor: number | null },
  cachedRanges: ReadonlyArray<CachedResultRange>,
) {
  const fetched = new Set(page.results.map(({ resultId }) => resultId));
  let nextCursor = page.nextCursor;
  let cursorTailId = page.results.at(-1)?.resultId ?? null;
  const remainingRanges: CachedResultRange[] = [];
  for (const range of cachedRanges) {
    if (!fetched.has(range.firstId)) {
      remainingRanges.push(range);
      continue;
    }
    if (nextCursor !== null && (range.nextCursor === null || range.nextCursor < nextCursor)) {
      nextCursor = range.nextCursor;
      cursorTailId = range.lastId;
    }
  }
  return { nextCursor, cursorTailId, cachedRanges: nextCursor === null ? [] : remainingRanges };
}

export function SavedWorkflowResults({
  scope,
  job,
  refresh,
  canConfigure,
  onReviewTargetChange,
  onReviewRenderChange,
  onResultsAvailableChange,
  showCancellationDetail = true,
  resultsRef,
}: {
  scope: WorkflowScope;
  job: RepositoryWorkflowJob;
  refresh: () => Promise<void>;
  canConfigure: boolean;
  onReviewTargetChange?: (current: boolean) => void;
  onReviewRenderChange?: (checkpoint: WorkflowResultCheckpoint | null) => void;
  onResultsAvailableChange?: ((available: boolean) => void) | undefined;
  showCancellationDetail?: boolean;
  resultsRef?: RefObject<HTMLElement | null>;
}) {
  const call = useWorkflowClient(scope);
  const narrow = useIsMobile();
  const { diffLayout } = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const tabId = useId();
  const changesTab = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState<{
    relayUrl: string;
    results: ReadonlyArray<WorkflowSavedResult>;
    nextCursor: number | null;
    // Cached older results can appear after the last row reached by the cursor.
    cursorTailId?: string | null;
    cachedRanges?: ReadonlyArray<CachedResultRange>;
    threadId: ThreadId;
    generation: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  // A run that ends while someone is reading keeps its result viewer open.
  const [partialResultOpen, setPartialResultOpen] = useState(job.status !== "cancelled");
  const selectedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const [view, setView] = useState<"changes" | "conversation">("changes");
  const [loaded, setLoaded] = useState<
    | (SavedWorkflowResultRead & {
        readId: number;
        scope: string;
        retry: number;
        changesRetry: number;
      })
    | null
  >(null);
  const [renderedReview, setRenderedReview] = useState<{
    readId: number;
    checkpoint: WorkflowResultCheckpoint;
  } | null>(null);
  const [conversation, setConversation] = useState<{
    resultId: string;
    history: PortableThreadHistory;
    more: boolean;
  } | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<{
    more: boolean;
    detail: string;
  } | null>(null);
  const [attachmentError, setAttachmentError] = useState<ChatAttachment | null>(null);
  const [historyRead, setHistoryRead] = useState<HistoryRead | null>(null);
  const [readingIndex, setReadingIndex] = useState(false);
  const [readingChanges, setReadingChanges] = useState(false);
  const [readingConversation, setReadingConversation] = useState<"first" | "more" | null>(null);
  const busy = readingChanges || readingConversation !== null;
  const [retry, setRetry] = useState(0);
  const [indexRetry, setIndexRetry] = useState(0);
  const [changesRetry, setChangesRetry] = useState(0);
  const [deletion, setDeletion] = useState<DeletionState | null>(null);
  const deletionInFlight = useRef(false);
  const deletionIndexCheck = useRef<DeletionIntent | null>(null);
  const localResultsRef = useRef<HTMLElement>(null);
  const savedResults = resultsRef ?? localResultsRef;
  const indexRetryButton = useRef<HTMLButtonElement>(null);
  const changesRetryButton = useRef<HTMLButtonElement>(null);
  const conversationPageButton = useRef<HTMLButtonElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const attachmentRetryButton = useRef<HTMLButtonElement>(null);
  const restorePageRetryFocus = useRef(false);
  const restoreReadFocus = useCallback(
    (button: HTMLButtonElement | null) => {
      if (button && button.ownerDocument?.activeElement === button)
        savedResults.current?.focus({ preventScroll: true });
    },
    [savedResults],
  );
  useLayoutEffect(() => {
    if (!restorePageRetryFocus.current) return;
    restorePageRetryFocus.current = false;
    const target = conversationPageButton.current ?? conversationEnd.current;
    if (target && target.ownerDocument?.activeElement === target.ownerDocument?.body)
      target.focus();
  }, [conversation, conversationError]);
  const deletionStatus = useRef<HTMLDivElement>(null);
  const partialResultToggle = useRef<HTMLButtonElement>(null);
  const restorePickerFocus = useRef(false);
  const capturePickerFocus = useCallback(() => {
    restorePickerFocus.current = true;
  }, []);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const keepThreadButton = useRef<HTMLButtonElement>(null);
  const completed = job.status === "done";
  const cancelled = job.status === "cancelled";
  const cancellationDetail =
    cancelled && showCancellationDetail && (job.detail ?? job.progress?.detail);
  const threadState = savedWorkflowThreadState(job);
  const deleted = deletion?.state === "requested" || threadState === "deleted";
  const deletionUnavailable = deletion?.state === "unavailable";
  const resultsUnavailable = deleted || (deletionUnavailable && !index);
  const confirmingDeletion = deletion?.state === "confirming";
  const retryIntent =
    deletion?.state === "unconfirmed" || deletion?.state === "blocked" ? deletion : null;
  const retryRelayChanged =
    retryIntent &&
    (index ? index.relayUrl !== retryIntent.intent.relayUrl : retryIntent.relayChanged);
  const waitingForThread = threadState === "not_started";
  const resultsScope =
    index && !resultsUnavailable && !waitingForThread
      ? JSON.stringify([
          scope.accountId,
          scope.organizationId,
          scope.repositoryId,
          job.jobId,
          index.relayUrl,
          index.threadId,
        ])
      : null;
  const historyKey =
    resultsScope && index && index.nextCursor !== null
      ? JSON.stringify([resultsScope, index.generation, index.nextCursor])
      : null;
  const paging = historyRead?.request.key === historyKey ? historyRead.state : null;
  const pagingPending = paging === "loading" || paging === "retrying";
  const latestHistoryKey = useRef(historyKey);
  const latestResultsScope = useRef(resultsScope);
  const inFlightHistory = useRef<HistoryRequest | null>(null);
  useLayoutEffect(() => {
    latestHistoryKey.current = historyKey;
    latestResultsScope.current = resultsScope;
  }, [historyKey, resultsScope]);
  const capabilities = useAtomValue(threadVmControls.capabilitiesAtom);
  const canDelete = canDeleteSavedWorkflowThread(job, canConfigure, capabilities);
  const latestDeletionAccess = useRef(canDelete);
  useLayoutEffect(() => {
    latestDeletionAccess.current = canDelete && !deleted && !deletionUnavailable;
    return () => {
      latestDeletionAccess.current = false;
    };
  }, [canDelete, deleted, deletionUnavailable]);
  if (
    confirmingDeletion &&
    (!canDelete || deleted || !sameThreadPlacement(deletion.target, index))
  ) {
    setDeletion(null);
  }
  const active = useRef(true);
  const generation = useRef(0);
  const indexEpoch = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
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
          index?.threadId,
        ]),
      ),
    [
      scope.accountId,
      scope.organizationId,
      scope.repositoryId,
      job.jobId,
      index?.relayUrl,
      index?.threadId,
    ],
  );
  useEffect(() => () => reader.clear(), [reader]);
  const result = index?.results.find((entry) => entry.resultId === selected) ?? null;
  const relayUrl = index?.relayUrl;
  const threadId = index?.threadId;
  const contentRead = useMemo(
    () =>
      result && resultsScope && relayUrl && threadId
        ? { result, scope: resultsScope, relayUrl, threadId, call, retry }
        : null,
    [result, resultsScope, relayUrl, threadId, call, retry],
  );
  const latestContentRead = useRef<typeof contentRead>(null);
  const conversationRequest = useRef<symbol | null>(null);
  const attachmentRequests = useRef(new Map<string, NonNullable<typeof contentRead>>());
  useLayoutEffect(() => {
    latestContentRead.current = contentRead;
    setConversation(null);
    setConversationError(null);
    setAttachmentError(null);
    setReadingConversation(null);
    setChangesError(null);
    return () => {
      latestContentRead.current = null;
      conversationRequest.current = null;
    };
  }, [contentRead]);
  const clearSavedResults = useCallback(() => {
    indexEpoch.current++;
    inFlightHistory.current = null;
    setHistoryRead(null);
    reader.clear();
    generation.current++;
    latestContentRead.current = null;
    conversationRequest.current = null;
    setLoaded(null);
    setRenderedReview(null);
    setConversation(null);
    setChangesError(null);
    setConversationError(null);
    setAttachmentError(null);
    setIndexError(null);
    setIndex(null);
    setSelected(null);
    setBrowsingHistory(false);
    setReadingIndex(false);
    setReadingChanges(false);
    setReadingConversation(null);
  }, [reader]);
  const recoverContentRead = useCallback(
    async (
      read: NonNullable<typeof contentRead>,
      epoch: number,
      cause: unknown,
      relayChanged: boolean,
    ) => {
      const accessLost = workflowJobAccessLost(cause);
      if (!relayChanged && !accessLost) return false;
      const sameAuthority = () =>
        active.current && latestResultsScope.current === read.scope && indexEpoch.current === epoch;
      if (!sameAuthority()) return true;
      if (relayChanged) {
        clearSavedResults();
        setIndexRetry((n) => n + 1);
        return true;
      }
      if (!isNotFound(cause) || cause.cause.reason !== "thread_not_found") {
        clearSavedResults();
        setIndexError(workflowError(cause));
        return true;
      }

      // The relay uses the same 404 for a missing artifact and a hidden thread.
      let movedRelay = false;
      try {
        const list = await read.call((client, token) => {
          movedRelay = client.relayUrl !== read.relayUrl;
          if (movedRelay || !sameAuthority())
            throw new WorkflowRequestNotSentError("The saved results changed.");
          return client.listSavedWorkflowResults({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: job.jobId,
          });
        });
        if (!sameAuthority()) return true;
        if (list.threadId === read.threadId) return false;
        clearSavedResults();
        setIndexRetry((n) => n + 1);
      } catch (checkError) {
        if (!sameAuthority()) return true;
        clearSavedResults();
        if (movedRelay) setIndexRetry((n) => n + 1);
        else setIndexError(workflowError(checkError));
      }
      return true;
    },
    [clearSavedResults, scope.repositoryId, job.jobId],
  );
  const clearInaccessibleResults = useEffectEvent(clearSavedResults);
  useEffect(() => {
    if (deleted || waitingForThread) {
      setReadingIndex(false);
      return;
    }
    setReadingIndex(true);
    let current = true;
    let requestedRelayUrl: string | undefined;
    const epoch = indexEpoch.current;
    const checkedIntent = deletionIndexCheck.current;
    void call((client, token) => {
      requestedRelayUrl = client.relayUrl;
      return client
        .listSavedWorkflowResults({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
        })
        .pipe(Effect.map((data) => ({ ...data, relayUrl: client.relayUrl })));
    })
      .then((data) => {
        if (!current || epoch !== indexEpoch.current) return;
        restoreReadFocus(indexRetryButton.current);
        setIndex((previous) => {
          if (
            !previous ||
            previous.relayUrl !== data.relayUrl ||
            previous.threadId !== data.threadId
          )
            return data;
          if (completed && !checkedIntent) {
            const cached = new Map(previous.results.map((entry) => [entry.resultId, entry]));
            const fresh = data.results.map((entry) => {
              const existing = cached.get(entry.resultId);
              cached.delete(entry.resultId);
              return existing && sameSavedResult(existing, entry) ? existing : entry;
            });
            const firstId = previous.results[0]?.resultId;
            const lastId =
              previous.cursorTailId === undefined
                ? previous.results.at(-1)?.resultId
                : previous.cursorTailId;
            const cachedRanges = previous.cachedRanges ?? [];
            const previousRange =
              firstId && lastId ? [{ firstId, lastId, nextCursor: previous.nextCursor }] : [];
            return {
              ...data,
              results: [...fresh, ...cached.values()],
              ...continueSavedResults(data, [...previousRange, ...cachedRanges]),
            };
          }
          const previousResult = previous.results.find(
            (entry) => entry.resultId === selectedRef.current,
          );
          if (!previousResult) return data;
          const freshResult = data.results.find(
            (entry) => entry.resultId === previousResult.resultId,
          );
          if (!freshResult)
            return {
              ...data,
              results: [...data.results, previousResult],
              cursorTailId: data.results.at(-1)?.resultId ?? null,
            };
          // Re-reading the index should not reload the open diff or conversation.
          if (!sameSavedResult(previousResult, freshResult)) return data;
          return {
            ...data,
            results: data.results.map((entry) => (entry === freshResult ? previousResult : entry)),
          };
        });
        setIndexError(null);
        setSelected((id) => id ?? data.results[0]?.resultId ?? null);
        if (checkedIntent && deletionIndexCheck.current === checkedIntent) {
          deletionIndexCheck.current = null;
          const sameTarget = sameThreadPlacement(checkedIntent, data);
          if (data.relayUrl !== checkedIntent.relayUrl || data.threadId !== checkedIntent.threadId)
            setSelected(data.results[0]?.resultId ?? null);
          setDeletion(
            sameTarget ? { state: "blocked", intent: checkedIntent } : { state: "changed" },
          );
        }
      })
      .catch((cause) => {
        if (current && epoch === indexEpoch.current) {
          if (workflowJobAccessLost(cause)) {
            clearInaccessibleResults();
          } else if (completed && !checkedIntent && requestedRelayUrl) {
            setIndex((previous) => (previous?.relayUrl === requestedRelayUrl ? previous : null));
          } else {
            setIndex(null);
            setLoaded(null);
            setConversation(null);
          }
          setIndexError(cause instanceof Error ? cause.message : "Could not read saved results.");
        }
      })
      .finally(() => {
        if (current && epoch === indexEpoch.current) setReadingIndex(false);
      });
    return () => {
      current = false;
    };
  }, [
    call,
    scope.repositoryId,
    job.jobId,
    // Completion can publish a result after the last index read.
    completed,
    cancelled,
    job.progress?.resultSaving?.publicationId,
    job.progress?.resultSaving?.state,
    job.progress?.checkpoint?.checkpointId,
    retry,
    indexRetry,
    deleted,
    waitingForThread,
    restoreReadFocus,
  ]);
  const finishing = workflowIsFinishing(job);
  const retryableCompletion = finishing && workflowApprovalCanRetry(job.progress);
  const results = index?.results ?? [];
  const currentResult =
    job.status === "finishing" && retryableCompletion
      ? (results.find((entry) => isCurrentWorkflowReviewResult(job, entry)) ?? null)
      : currentWorkflowSavedResult(job, results);
  const partialResult = cancelled && currentResult?.outcome === "cancelled" ? currentResult : null;
  const partialResultHidden = !!partialResult && !partialResultOpen;
  const pickerKey = index?.results.length && !partialResultHidden ? resultsScope : null;
  useLayoutEffect(() => {
    if (restorePickerFocus.current) {
      restorePickerFocus.current = false;
      (partialResultHidden ? partialResultToggle.current : savedResults.current)?.focus({
        preventScroll: true,
      });
    }
  }, [pickerKey, partialResultHidden, savedResults]);
  const hasPartialChanges = !!partialResult && partialResult.patch.sizeBytes > 0;
  const resultsAvailable =
    !resultsUnavailable &&
    !waitingForThread &&
    results.length > 0 &&
    (!partialResult || partialResultOpen);
  const completedSavedResultsPane = completed && (resultsAvailable || !!indexError);
  useLayoutEffect(() => {
    onResultsAvailableChange?.(resultsAvailable);
  }, [onResultsAvailableChange, resultsAvailable]);
  const reviewingCurrent = !!result && result.resultId === currentResult?.resultId;
  useLayoutEffect(() => {
    onReviewTargetChange?.(reviewingCurrent);
  }, [onReviewTargetChange, reviewingCurrent]);
  const recorded = useRef<string | null>(null);
  const selectResult = (id: string) => {
    if (id !== selected) setRenderedReview(null);
    setBrowsingHistory(id !== currentResult?.resultId);
    setSelected(id);
  };
  const returnToCurrent = () => {
    setView("changes");
    changesTab.current?.focus();
    if (currentResult) {
      selectResult(currentResult.resultId);
    } else {
      setBrowsingHistory(false);
      setRetry((n) => n + 1);
    }
  };
  const saving = job.progress?.resultSaving?.state;
  const resultSavePending = saving === "saving" || saving === "failed";
  const reviewAvailable = job.status === "awaiting_review" && !resultSavePending && !finishing;
  const canVerifyResult = !resultSavePending && (reviewAvailable || retryableCompletion);
  const showFinalResultLink = retryableCompletion && currentResult && !resultSavePending;
  const isCurrentReview = reviewingCurrent && reviewAvailable;
  const resultLabel = isCurrentReview
    ? "Current review result"
    : reviewingCurrent
      ? "Latest result"
      : "Earlier result";
  const stepTitle = (stepId: string) =>
    job.workflow?.definition.steps.find((step) => step.id === stepId)?.title ?? stepId;
  useEffect(() => {
    const request = ++generation.current;
    setLoaded(null);
    if (!contentRead) {
      setReadingChanges(false);
      return;
    }
    const owns = () =>
      active.current && request === generation.current && contentRead === latestContentRead.current;
    const epoch = indexEpoch.current;
    setReadingChanges(true);
    let relayChanged = false;
    void reader
      .read(contentRead.result, () =>
        contentRead.call((client, token) => {
          relayChanged = client.relayUrl !== contentRead.relayUrl;
          if (relayChanged || !owns())
            throw new WorkflowRequestNotSentError("The saved result changed.");
          return client.readSavedWorkflowResult({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: job.jobId,
            resultId: contentRead.result.resultId,
          });
        }),
      )
      .then((value) => {
        if (!owns()) return;
        restoreReadFocus(changesRetryButton.current);
        setChangesError(null);
        setLoaded({
          ...value,
          readId: request,
          scope: contentRead.scope,
          retry: contentRead.retry,
          changesRetry,
        });
      })
      .catch(async (cause) => {
        if (!(await recoverContentRead(contentRead, epoch, cause, relayChanged)) && owns())
          setChangesError(workflowError(cause));
      })
      .finally(() => {
        if (owns()) setReadingChanges(false);
      });
    return () => {
      generation.current++;
    };
  }, [
    reader,
    contentRead,
    changesRetry,
    scope.repositoryId,
    job.jobId,
    recoverContentRead,
    restoreReadFocus,
  ]);
  const patch = useMemo(
    () =>
      loaded
        ? getRenderablePatch(
            loaded.patch,
            `workflow-result:${loaded.result.resultId}:${loaded.result.patch.sha256}`,
            { preservePatchWhitespace: true },
          )
        : null,
    [loaded],
  );
  const checkpoint = workflowResultCheckpoint(job.progress?.checkpoint);
  const [renderedRead, setRenderedRead] = useState<number | null>(null);
  const activeRead =
    loaded &&
    loaded.scope === resultsScope &&
    loaded.retry === retry &&
    loaded.changesRetry === changesRetry &&
    result &&
    sameSavedResult(loaded.result, result)
      ? loaded
      : null;
  const verifiedCheckpoint =
    canVerifyResult &&
    reviewingCurrent &&
    checkpoint &&
    renderedReview &&
    activeRead?.readId === renderedReview.readId &&
    sameWorkflowResultCheckpoint(checkpoint, renderedReview.checkpoint)
      ? renderedReview.checkpoint
      : null;
  useLayoutEffect(() => {
    onReviewRenderChange?.(verifiedCheckpoint);
    return () => onReviewRenderChange?.(null);
  }, [onReviewRenderChange, verifiedCheckpoint]);
  const recordVisible = useCallback(() => {
    if (
      view !== "changes" ||
      readingChanges ||
      changesError ||
      !activeRead ||
      !checkpoint ||
      !canVerifyResult ||
      !reviewingCurrent ||
      patch?.kind === "raw" ||
      activeRead.readId !== generation.current ||
      (activeRead.patch !== "" && renderedRead !== activeRead.readId) ||
      document.visibilityState === "hidden"
    )
      return;
    const key = `${checkpoint.checkpointId}:${activeRead.readId}`;
    if (recorded.current === key) return;
    recorded.current = key;
    const visitId = randomUUID();
    beginWorkflowReview(appAtomRegistry, scope, job.jobId, visitId, checkpoint);
    if (
      recordSavedWorkflowReviewDiff(appAtomRegistry, scope, job.jobId, visitId, activeRead.result)
    ) {
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, job.jobId);
      if (onReviewRenderChange) setRenderedReview({ checkpoint, readId: activeRead.readId });
      void refresh();
    }
  }, [
    view,
    readingChanges,
    changesError,
    activeRead,
    checkpoint,
    canVerifyResult,
    reviewingCurrent,
    job.jobId,
    scope,
    patch,
    refresh,
    renderedRead,
    onReviewRenderChange,
  ]);
  useLayoutEffect(() => {
    recordVisible();
    document.addEventListener("visibilitychange", recordVisible);
    return () => document.removeEventListener("visibilitychange", recordVisible);
  }, [recordVisible]);
  const diffOptions = useMemo(
    () => ({
      diffStyle: !narrow && diffLayout === "split" ? ("split" as const) : ("unified" as const),
      onPostRender: () => {
        if (active.current && loaded?.readId === generation.current) {
          setRenderedRead(loaded.readId);
        }
      },
    }),
    [loaded, narrow, diffLayout],
  );
  const readConversation = useCallback(
    async (more = false) => {
      if (!contentRead || contentRead !== latestContentRead.current || conversationRequest.current)
        return;
      const previous =
        conversation?.resultId === contentRead.result.resultId ? conversation.history : null;
      if (more && !previous) return;
      const request = Symbol();
      const owns = () =>
        active.current &&
        request === conversationRequest.current &&
        contentRead === latestContentRead.current;
      const epoch = indexEpoch.current;
      conversationRequest.current = request;
      setReadingConversation(more ? "more" : "first");
      let relayChanged = false;
      try {
        const next = await reader.history(contentRead.threadId, more ? previous : null, (after) =>
          contentRead.call((client, token) => {
            relayChanged = client.relayUrl !== contentRead.relayUrl;
            if (relayChanged || !owns())
              throw new WorkflowRequestNotSentError("The saved conversation changed.");
            return client.getSavedWorkflowHistory({
              clerkToken: token,
              repositoryId: scope.repositoryId,
              jobId: job.jobId,
              resultId: contentRead.result.resultId,
              after,
              limit: 200,
            });
          }),
        );
        if (owns()) {
          const button = conversationPageButton.current;
          if (!more) restoreReadFocus(button);
          else if (!next.more || conversationError)
            restorePageRetryFocus.current =
              !!button && button.ownerDocument?.activeElement === button;
          setConversationError(null);
          setConversation({ resultId: contentRead.result.resultId, ...next });
        }
      } catch (cause) {
        if (!(await recoverContentRead(contentRead, epoch, cause, relayChanged)) && owns()) {
          const button = conversationPageButton.current;
          restorePageRetryFocus.current =
            more &&
            !conversationError &&
            !!button &&
            button.ownerDocument?.activeElement === button;
          setConversationError({ more, detail: workflowError(cause) });
        }
      } finally {
        if (owns()) {
          conversationRequest.current = null;
          setReadingConversation(null);
        }
      }
    },
    [
      reader,
      contentRead,
      job.jobId,
      scope.repositoryId,
      conversation,
      conversationError,
      recoverContentRead,
      restoreReadFocus,
    ],
  );
  useEffect(() => {
    if (
      view === "conversation" &&
      result &&
      conversation?.resultId !== result.resultId &&
      !readingConversation &&
      !conversationError
    )
      void readConversation();
  }, [view, result, conversation, readingConversation, conversationError, readConversation]);
  const download = async (file: ChatAttachment) => {
    if (!contentRead || contentRead !== latestContentRead.current) return;
    const requests = attachmentRequests.current;
    if (requests.get(file.id) === contentRead) return;
    requests.set(file.id, contentRead);
    const owns = () => active.current && contentRead === latestContentRead.current;
    const epoch = indexEpoch.current;
    let relayChanged = false;
    if (attachmentError?.id === file.id) restoreReadFocus(attachmentRetryButton.current);
    setAttachmentError((previous) => (previous?.id === file.id ? null : previous));
    try {
      const bytes = await contentRead.call((client, token) => {
        relayChanged = client.relayUrl !== contentRead.relayUrl;
        if (relayChanged || !owns())
          throw new WorkflowRequestNotSentError("The saved conversation changed.");
        return client.downloadSavedWorkflowAttachment({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
          resultId: contentRead.result.resultId,
          attachmentId: file.id,
        });
      });
      if (!owns()) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes).buffer], { type: file.mimeType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.split(/[\\/]/u).at(-1) ?? "attachment";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (!(await recoverContentRead(contentRead, epoch, cause, relayChanged)) && owns())
        setAttachmentError(file);
    } finally {
      if (requests.get(file.id) === contentRead) requests.delete(file.id);
    }
  };
  const moreResults = async () => {
    if (
      !historyKey ||
      !resultsScope ||
      !index ||
      index.nextCursor === null ||
      inFlightHistory.current?.key === historyKey
    )
      return;
    const cursor = index.nextCursor;
    const request: HistoryRequest = {
      key: historyKey,
      scope: resultsScope,
      epoch: indexEpoch.current,
    };
    const sameAuthority = () =>
      active.current &&
      request.epoch === indexEpoch.current &&
      request.scope === latestResultsScope.current;
    const isCurrent = () =>
      sameAuthority() &&
      request === inFlightHistory.current &&
      request.key === latestHistoryKey.current;
    inFlightHistory.current = request;
    setHistoryRead({ request, state: paging === "failed" ? "retrying" : "loading" });
    let relayChanged = false;
    try {
      const page = await call((client, token) => {
        relayChanged = client.relayUrl !== index.relayUrl;
        if (relayChanged || !isCurrent())
          throw new WorkflowRequestNotSentError("The workflow result index changed.");
        return client
          .listSavedWorkflowResults({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: job.jobId,
            before: cursor,
          })
          .pipe(Effect.map((data) => ({ ...data, relayUrl: client.relayUrl })));
      });
      if (!isCurrent()) return;
      if (!sameThreadPlacement(index, page)) {
        if (page.relayUrl !== index.relayUrl || page.threadId !== index.threadId) {
          clearSavedResults();
        }
        setIndexRetry((previous) => previous + 1);
        return;
      }
      setIndex((previous) => {
        if (!previous || previous.nextCursor !== cursor || !sameThreadPlacement(index, previous))
          return previous;
        // A refresh can retain older cached results beyond the fetched page range.
        const cursorIndex = previous.results.findIndex(
          (entry) => entry.resultId === previous.cursorTailId,
        );
        const split = cursorIndex === -1 ? previous.results.length : cursorIndex + 1;
        const cached = new Map(previous.results.map((entry) => [entry.resultId, entry]));
        const fresh = new Map(
          page.results.map((entry) => {
            const existing = cached.get(entry.resultId);
            return [
              entry.resultId,
              existing && sameSavedResult(existing, entry) ? existing : entry,
            ];
          }),
        );
        const results = [
          ...previous.results.slice(0, split),
          ...fresh.values(),
          ...previous.results.slice(split),
        ];
        const byId = new Map(
          results.map((entry) => [entry.resultId, fresh.get(entry.resultId) ?? entry]),
        );
        return {
          ...previous,
          results: [...byId.values()],
          ...continueSavedResults(page, previous.cachedRanges ?? []),
        };
      });
    } catch (cause) {
      if (workflowJobAccessLost(cause)) {
        if (sameAuthority()) {
          clearSavedResults();
          setIndexError(cause instanceof Error ? cause.message : "Could not read saved results.");
        }
      } else if (!isCurrent()) {
        return;
      } else if (relayChanged) {
        clearSavedResults();
        setIndexRetry((previous) => previous + 1);
      } else {
        setHistoryRead({ request, state: "failed" });
      }
    } finally {
      if (request === inFlightHistory.current) {
        inFlightHistory.current = null;
        if (active.current) {
          setHistoryRead((previous) =>
            previous?.request === request && previous.state !== "failed" ? null : previous,
          );
        }
      }
    }
  };
  const openDeletion = () => {
    if (!index || busy || pagingPending || !canDelete) return;
    const { threadId, generation, relayUrl } = index;
    setDeletion({ state: "confirming", target: { threadId, generation, relayUrl } });
  };
  const refreshDeletionTarget = () => {
    indexEpoch.current++;
    inFlightHistory.current = null;
    setHistoryRead(null);
    setRetry((previous) => previous + 1);
    void refresh();
  };
  const refreshDeletionStatus = () => {
    deletionStatus.current?.focus();
    setChangesError(null);
    setConversationError(null);
    setAttachmentError(null);
    setIndexError(null);
    refreshDeletionTarget();
  };
  const deleteThread = async () => {
    if (deletionInFlight.current || !latestDeletionAccess.current || retryRelayChanged) return;
    const canSubmit = () =>
      active.current &&
      latestDeletionAccess.current &&
      canDeleteSavedWorkflowThread(
        job,
        canConfigure,
        appAtomRegistry.get(threadVmControls.capabilitiesAtom),
      );
    if (!canSubmit()) return;

    let intent: DeletionIntent;
    if (retryIntent) {
      intent = retryIntent.intent;
      deletionStatus.current?.focus();
    } else if (deletion?.state === "confirming" && sameThreadPlacement(deletion.target, index)) {
      intent = {
        ...deletion.target,
        payload: {
          operationId: randomUUID(),
          expectedGeneration: deletion.target.generation,
          confirmWorkspaceLoss: true,
        },
      };
    } else return;

    deletionInFlight.current = true;
    setDeletion({ state: "requesting" });
    let relayChanged = false;
    try {
      await call((client, token) => {
        relayChanged = client.relayUrl !== intent.relayUrl;
        if (!canSubmit() || relayChanged)
          throw new WorkflowRequestNotSentError("The workflow connection changed.");
        return client.permanentlyDeleteThread({
          clerkToken: token,
          threadId: intent.threadId,
          payload: intent.payload,
        });
      });
      if (!active.current) return;
      clearSavedResults();
      setDeletion({ state: "requested" });
      void refresh();
    } catch (cause) {
      if (!active.current) return;
      const relayError = isRequestFailed(cause) ? cause.relayError : undefined;
      if (
        relayError?._tag === "RelayTenancyNotFoundError" &&
        relayError.reason === "thread_not_found"
      ) {
        clearSavedResults();
        setDeletion({ state: "unavailable" });
        refreshDeletionTarget();
      } else if (
        relayError?._tag === "RelayTenancyConflictError" &&
        relayError.reason === "thread_deletion_conflict"
      ) {
        deletionIndexCheck.current = intent;
        setDeletion({ state: "checking" });
        refreshDeletionTarget();
      } else if (
        relayError?._tag === "RelayTenancyConflictError" &&
        relayError.reason === "thread_placement_changed"
      ) {
        clearSavedResults();
        setDeletion({ state: "changed" });
        refreshDeletionTarget();
      } else if (cause instanceof WorkflowRequestNotSentError) {
        if (relayChanged || !retryIntent) {
          clearSavedResults();
          refreshDeletionTarget();
        }
        setDeletion(
          retryIntent
            ? { ...retryIntent, ...(relayChanged ? { relayChanged: true } : {}) }
            : { state: "not-sent" },
        );
      } else {
        setDeletion({ state: "unconfirmed", intent });
      }
    } finally {
      deletionInFlight.current = false;
    }
  };
  const conversationRetry = (more: boolean) => (
    <Button
      ref={conversationPageButton}
      size="sm"
      variant="outline"
      aria-disabled={readingConversation !== null || undefined}
      onClick={() => void readConversation(more)}
    >
      <RotateCwIcon aria-hidden />
      {more
        ? readingConversation
          ? "Loading more messages…"
          : "Retry loading more messages"
        : readingConversation
          ? "Loading conversation…"
          : "Retry conversation"}
    </Button>
  );
  const resultView = (
    <div id={`${tabId}-saved-results`} className="space-y-3" hidden={partialResultHidden}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        {result ? (
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-medium wrap-anywhere">{stepTitle(result.stepId)}</h3>
              <Badge variant="secondary">
                <LockIcon aria-hidden />
                {isCurrentReview ? "Read-only" : "Read-only result"}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{resultLabel}</span>
              <time dateTime={result.createdAt}>
                Saved{" "}
                {new Date(result.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
              {result.outcome !== "completed" ? <span>{result.outcome}</span> : null}
            </div>
          </div>
        ) : null}
        {pickerKey && index ? (
          <SavedWorkflowResultPicker
            key={pickerKey}
            results={index.results}
            selected={result}
            currentReview={reviewAvailable ? currentResult : null}
            stepTitle={stepTitle}
            onSelect={selectResult}
            canLoadOlder={historyKey !== null}
            paging={paging}
            onLoadOlder={() => void moreResults()}
            onFocusBeforeRemoval={capturePickerFocus}
          />
        ) : null}
      </header>
      {indexError && deletion?.state !== "checking" ? (
        <WorkflowAlert
          title={result ? "Couldn’t refresh the results list" : "Couldn’t load the results list"}
          actions={
            <Button
              ref={indexRetryButton}
              size="sm"
              variant="outline"
              aria-disabled={readingIndex || undefined}
              onClick={() => {
                if (!readingIndex) setIndexRetry((n) => n + 1);
              }}
            >
              <RotateCwIcon aria-hidden />
              {readingIndex ? "Loading results…" : "Retry loading results"}
            </Button>
          }
        >
          {indexError}
        </WorkflowAlert>
      ) : null}
      {reviewAvailable && result && !reviewingCurrent ? (
        <WorkflowAlert
          title={browsingHistory ? "Earlier result" : "A newer result needs review"}
          variant="info"
          actions={
            <Button size="sm" variant="outline" onClick={returnToCurrent}>
              {currentResult
                ? browsingHistory
                  ? "Return to current review"
                  : "Review latest"
                : "Refresh results"}
            </Button>
          }
        >
          {browsingHistory
            ? "Decisions apply to the current review."
            : "Your opened result has been kept in place. Open the current result before deciding."}
        </WorkflowAlert>
      ) : null}
      {showFinalResultLink && result && !reviewingCurrent ? (
        <WorkflowAlert
          title="Earlier result"
          variant="info"
          actions={
            <Button size="sm" variant="outline" onClick={returnToCurrent}>
              Open result for final checks
            </Button>
          }
        >
          Open the saved result for this run before retrying completion.
        </WorkflowAlert>
      ) : null}
      {result ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div
            role="tablist"
            aria-label="Saved result content"
            className="flex gap-1"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "changes"
                  : event.key === "End"
                    ? "conversation"
                    : view === "changes"
                      ? "conversation"
                      : "changes";
              setView(next);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`[id="${tabId}-${next}"]`)
                ?.focus();
            }}
          >
            {(["changes", "conversation"] as const).map((tab) => (
              <Button
                key={tab}
                ref={tab === "changes" ? changesTab : undefined}
                id={`${tabId}-${tab}`}
                role="tab"
                size="sm"
                variant={view === tab ? "secondary" : "ghost"}
                aria-selected={view === tab}
                aria-controls={`${tabId}-panel`}
                tabIndex={view === tab ? 0 : -1}
                onClick={() => setView(tab)}
              >
                {tab === "changes" ? "Changes" : "Conversation"}
              </Button>
            ))}
          </div>
          {view === "changes" && !narrow && patch?.kind === "files" ? (
            <ToggleGroup
              aria-label="Diff layout"
              variant="segmented"
              value={[diffLayout]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "stacked" || next === "split")
                  void updateClientSettings({ diffLayout: next });
              }}
            >
              <Toggle aria-label="Stacked diff view" value="stacked">
                <Rows3Icon className="size-3.5" />
              </Toggle>
              <Toggle aria-label="Split diff view" value="split">
                <Columns2Icon className="size-3.5" />
              </Toggle>
            </ToggleGroup>
          ) : null}
        </div>
      ) : null}
      <div
        id={`${tabId}-panel`}
        role={result ? "tabpanel" : undefined}
        aria-labelledby={result ? `${tabId}-${view}` : undefined}
        tabIndex={result ? 0 : undefined}
        className="space-y-3"
      >
        {!waitingForThread && !index && !indexError ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading saved results…
          </p>
        ) : null}
        {(waitingForThread || index) &&
        !result &&
        (!resultSavePending || job.status === "cancelling") ? (
          <p className="text-sm text-muted-foreground">
            {job.status === "failed" || job.status === "cancelled"
              ? "No safely captured Agent result is available."
              : "No Agent result has been saved yet."}
          </p>
        ) : null}
        {result && view === "changes" ? (
          changesError ? (
            <WorkflowAlert
              title="Couldn’t load changes"
              actions={
                <Button
                  ref={changesRetryButton}
                  size="sm"
                  variant="outline"
                  aria-disabled={readingChanges || undefined}
                  onClick={() => {
                    if (!readingChanges) setChangesRetry((n) => n + 1);
                  }}
                >
                  <RotateCwIcon aria-hidden />
                  {readingChanges ? "Loading changes…" : "Retry changes"}
                </Button>
              }
            >
              {changesError}
            </WorkflowAlert>
          ) : readingChanges ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading changes…
            </p>
          ) : activeRead ? (
            <div className="min-w-0 overflow-hidden">
              {activeRead.patch === "" ? (
                <div className="flex items-start gap-3 rounded-lg border p-4">
                  <FileCheck2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 space-y-1">
                    <h4 className="text-sm font-medium">No file changes</h4>
                    <p className="text-sm text-muted-foreground">
                      This step saved a result without changing files.
                    </p>
                  </div>
                </div>
              ) : patch?.kind === "files" ? (
                <StyledDiffCodeView
                  options={diffOptions}
                  items={patch.files.map((fileDiff, n) => ({
                    id: `${result.resultId}:${n}`,
                    type: "diff",
                    fileDiff,
                  }))}
                />
              ) : (
                <pre className="overflow-auto p-4 text-xs">{activeRead.patch}</pre>
              )}
            </div>
          ) : null
        ) : null}
        {result && view === "conversation" ? (
          <>
            {attachmentError ? (
              <WorkflowAlert
                title="Couldn’t download the attachment"
                actions={
                  <Button
                    size="sm"
                    variant="outline"
                    ref={attachmentRetryButton}
                    onClick={() => void download(attachmentError)}
                  >
                    Retry download
                  </Button>
                }
              >
                {attachmentError.name}
              </WorkflowAlert>
            ) : null}
            {conversationError && !conversationError.more ? (
              <WorkflowAlert
                title="Couldn’t load the conversation"
                actions={conversationRetry(false)}
              >
                {conversationError.detail}
              </WorkflowAlert>
            ) : readingConversation === "first" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading conversation…
              </p>
            ) : null}
            {conversation?.resultId === result.resultId ? (
              <div className="space-y-4 py-2">
                {!conversation.history.thread?.messages.length ? (
                  <p className="text-sm text-muted-foreground">
                    No saved messages for this Agent result.
                  </p>
                ) : null}
                {conversation.history.thread?.messages.map((message) => (
                  <SavedConversationMessage
                    key={message.id}
                    message={message}
                    busy={readingConversation !== null}
                    onDownload={download}
                  />
                ))}
                {conversationError?.more ? (
                  <WorkflowAlert
                    title="Couldn’t load more messages"
                    actions={conversationRetry(true)}
                  >
                    {conversationError.detail}
                  </WorkflowAlert>
                ) : conversation.more ? (
                  <Button
                    ref={conversationPageButton}
                    size="sm"
                    variant="outline"
                    aria-disabled={readingConversation !== null || undefined}
                    onClick={() => void readConversation(true)}
                  >
                    {readingConversation === "more"
                      ? "Loading more messages…"
                      : "Load more messages"}
                  </Button>
                ) : (
                  <div
                    ref={conversationEnd}
                    tabIndex={-1}
                    className="sr-only text-sm text-muted-foreground focus:not-sr-only"
                  >
                    End of saved conversation.
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
  return (
    <section
      ref={savedResults}
      tabIndex={-1}
      aria-label="Saved workflow results"
      className={cn(
        "space-y-3",
        completedSavedResultsPane && "rounded-lg border bg-card p-4 text-card-foreground",
      )}
    >
      {completedSavedResultsPane ? <h2 className="text-sm font-semibold">Saved results</h2> : null}
      {!resultsUnavailable && partialResult ? (
        <WorkflowOutcome
          title={hasPartialChanges ? "Partial changes saved" : "Partial result saved"}
          actions={
            <Button
              aria-controls={`${tabId}-saved-results`}
              aria-expanded={partialResultOpen}
              ref={partialResultToggle}
              onClick={() => {
                if (!partialResultOpen) {
                  setSelected(partialResult.resultId);
                  setView("changes");
                  setBrowsingHistory(false);
                }
                setPartialResultOpen(!partialResultOpen);
              }}
            >
              <FileDiffIcon aria-hidden />
              {partialResultOpen
                ? "Hide saved result"
                : hasPartialChanges
                  ? "View saved changes"
                  : "View saved result"}
            </Button>
          }
        >
          <p>{cancellationDetail || "The run ended before the workflow completed."}</p>
        </WorkflowOutcome>
      ) : cancellationDetail ? (
        <p className="text-sm text-muted-foreground">{cancellationDetail}</p>
      ) : null}
      {deleted || (deletion && !confirmingDeletion) ? (
        <div ref={deletionStatus} tabIndex={-1}>
          {deleted ? (
            <WorkflowAlert title="Deletion requested" variant="info">
              The conversation and saved results are no longer available. The run stays in history.
            </WorkflowAlert>
          ) : deletion?.state === "requesting" ? (
            <WorkflowAlert title="Requesting deletion…" variant="info">
              Waiting for the relay to confirm the request.
            </WorkflowAlert>
          ) : deletionUnavailable ? (
            <WorkflowAlert
              title={index ? "Deletion unavailable" : "Saved results unavailable"}
              variant="warning"
              actions={
                !index ? (
                  <Button size="sm" variant="outline" onClick={refreshDeletionStatus}>
                    Refresh saved results
                  </Button>
                ) : undefined
              }
            >
              {index
                ? "You can still view this run’s saved results."
                : "Refresh to check the run and saved results."}
            </WorkflowAlert>
          ) : deletion?.state === "not-sent" ? (
            <WorkflowAlert title="Deletion request not sent" variant="warning">
              Refresh the saved results or sign in, then confirm deletion again.
            </WorkflowAlert>
          ) : deletion?.state === "changed" ? (
            <WorkflowAlert title="The workflow thread changed" variant="warning">
              Check the refreshed saved results before requesting deletion again.
            </WorkflowAlert>
          ) : deletion?.state === "checking" ? (
            <WorkflowAlert
              title={
                indexError
                  ? "Could not refresh the workflow thread"
                  : "Checking the workflow thread"
              }
              variant={indexError ? "warning" : "info"}
              actions={
                indexError ? (
                  <Button size="sm" variant="outline" onClick={refreshDeletionStatus}>
                    Refresh saved results
                  </Button>
                ) : undefined
              }
            >
              {indexError
                ? "Refresh saved results to check whether the deletion target has changed."
                : "Checking whether the deletion target has changed."}
            </WorkflowAlert>
          ) : (
            <Alert variant="warning" role="status">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle role="heading" aria-level={2}>
                {deletion?.state === "blocked" ? "Deletion blocked" : "Deletion not confirmed"}
              </AlertTitle>
              <AlertDescription>
                {retryRelayChanged
                  ? "Reconnect to the original relay to retry this deletion."
                  : deletion?.state === "blocked"
                    ? "The relay could not start deletion. Wait for any VM operations to finish, then retry."
                    : canDelete
                      ? "The request may already have been accepted. Retry to confirm the same deletion."
                      : "The request may already have been accepted. Refresh the run to check its status."}
              </AlertDescription>
              {retryRelayChanged ? (
                <AlertAction>
                  <Button size="sm" variant="outline" onClick={refreshDeletionStatus}>
                    Refresh saved results
                  </Button>
                </AlertAction>
              ) : canDelete ? (
                <AlertAction>
                  <Button size="sm" variant="outline" onClick={() => void deleteThread()}>
                    <RotateCwIcon aria-hidden />
                    Retry deletion
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          )}
        </div>
      ) : null}
      {!resultsUnavailable ? resultView : null}
      {canDelete &&
      !resultsUnavailable &&
      (!deletion ||
        confirmingDeletion ||
        deletion.state === "changed" ||
        deletion.state === "not-sent") ? (
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">More controls</summary>
          <div className="mt-2">
            <Button
              ref={deleteButton}
              size="sm"
              variant="destructive-outline"
              disabled={busy || pagingPending || !index}
              onClick={openDeletion}
            >
              Delete thread permanently
            </Button>
          </div>
        </details>
      ) : null}
      <AlertDialog
        open={confirmingDeletion && canDelete && !deleted}
        onOpenChange={(open) => {
          if (!open && confirmingDeletion) setDeletion(null);
        }}
      >
        <AlertDialogPopup
          initialFocus={keepThreadButton}
          finalFocus={() =>
            deletionStatus.current ??
            (deleteButton.current && !deleteButton.current.disabled
              ? deleteButton.current
              : savedResults.current)
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              <span className="flex items-start gap-2">
                <Trash2Icon aria-hidden className="size-4 shrink-0 text-error" />
                Delete workflow thread permanently?
              </span>
            </AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              <span className="mb-2 block font-medium text-popover-foreground">
                {job.workflow?.definition.name ?? "Workflow run"}
              </span>
              The conversation, saved results, and VM workspace will be permanently deleted. The run
              stays in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button ref={keepThreadButton} variant="outline" onClick={() => setDeletion(null)}>
              Keep thread
            </Button>
            <Button
              variant="destructive"
              disabled={busy || pagingPending}
              onClick={() => void deleteThread()}
            >
              Delete thread
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
