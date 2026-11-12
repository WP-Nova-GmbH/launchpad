import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { threadVmControls } from "../../state/threads";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import type { RelayThreadDeletionRequest } from "@t3tools/contracts/relay";
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
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { workflowResultCheckpoint } from "@t3tools/client-runtime/relay/workflow-result";
import {
  Columns2Icon,
  FileDiffIcon,
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
import { randomUUID } from "../../lib/utils";
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
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { useWorkflowClient } from "./workflowState";
import { WorkflowRequestNotSentError } from "./workflowOperations";

const sameSavedResult = Schema.toEquivalence(WorkflowSavedResult);
const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

type DeletionTarget = { relayUrl: string; threadId: ThreadId; generation: number };
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

export function SavedWorkflowResults({
  scope,
  job,
  refresh,
  canConfigure,
  onReviewTargetChange,
}: {
  scope: WorkflowScope;
  job: RepositoryWorkflowJob;
  refresh: () => Promise<void>;
  canConfigure: boolean;
  onReviewTargetChange?: (current: boolean) => void;
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
    threadId: ThreadId;
    generation: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  // A run that ends while someone is reading keeps its result viewer open.
  const [partialResultOpen, setPartialResultOpen] = useState(job.status !== "cancelled");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const [view, setView] = useState<"changes" | "conversation">("changes");
  const [loaded, setLoaded] = useState<SavedWorkflowResultRead | null>(null);
  const [conversation, setConversation] = useState<{
    resultId: string;
    history: PortableThreadHistory;
    more: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [deletion, setDeletion] = useState<DeletionState | null>(null);
  const deletionInFlight = useRef(false);
  const deletionIndexCheck = useRef<DeletionIntent | null>(null);
  const savedResults = useRef<HTMLElement>(null);
  const deletionStatus = useRef<HTMLDivElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const keepThreadButton = useRef<HTMLButtonElement>(null);
  const cancelled = job.status === "cancelled";
  const cancellationDetail = cancelled && (job.detail ?? job.progress?.detail);
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
        ]),
      ),
    [scope.accountId, scope.organizationId, scope.repositoryId, job.jobId, index?.relayUrl],
  );
  useEffect(() => () => reader.clear(), [reader]);
  useEffect(() => {
    if (deleted || waitingForThread) return;
    let current = true;
    const epoch = indexEpoch.current;
    const checkedIntent = deletionIndexCheck.current;
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
        if (!current || epoch !== indexEpoch.current) return;
        setIndex((previous) => {
          if (
            !previous ||
            previous.relayUrl !== data.relayUrl ||
            previous.threadId !== data.threadId
          )
            return data;
          const previousResult = previous.results.find(
            (entry) => entry.resultId === selectedRef.current,
          );
          if (!previousResult) return data;
          const freshResult = data.results.find(
            (entry) => entry.resultId === previousResult.resultId,
          );
          if (!freshResult) return { ...data, results: [...data.results, previousResult] };
          // Re-reading the index should not reload the open diff or conversation.
          if (!sameSavedResult(previousResult, freshResult)) return data;
          return {
            ...data,
            results: data.results.map((entry) => (entry === freshResult ? previousResult : entry)),
          };
        });
        setError(null);
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
          setIndex(null);
          setLoaded(null);
          setConversation(null);
          setError(cause instanceof Error ? cause.message : "Could not read saved results.");
        }
      });
    return () => {
      current = false;
    };
  }, [
    call,
    scope.repositoryId,
    job.jobId,
    cancelled,
    job.progress?.resultSaving?.publicationId,
    job.progress?.resultSaving?.state,
    job.progress?.checkpoint?.checkpointId,
    retry,
    deleted,
    waitingForThread,
  ]);
  const result = index?.results.find((entry) => entry.resultId === selected) ?? null;
  const finishing = workflowIsFinishing(job);
  const retryableCompletion = finishing && workflowApprovalCanRetry(job.progress);
  const results = index?.results ?? [];
  const currentResult =
    job.status === "finishing" && retryableCompletion
      ? (results.find((entry) => isCurrentWorkflowReviewResult(job, entry)) ?? null)
      : currentWorkflowSavedResult(job, results);
  const partialResult = cancelled && currentResult?.outcome === "cancelled" ? currentResult : null;
  const hasPartialChanges = !!partialResult && partialResult.patch.sizeBytes > 0;
  const reviewingCurrent = !!result && result.resultId === currentResult?.resultId;
  useLayoutEffect(() => {
    onReviewTargetChange?.(reviewingCurrent);
  }, [onReviewTargetChange, reviewingCurrent]);
  const recorded = useRef<string | null>(null);
  const selectResult = (id: string | null) => {
    if (id !== selected) recorded.current = null;
    setBrowsingHistory(true);
    setSelected(id);
  };
  const returnToCurrent = () => {
    setView("changes");
    changesTab.current?.focus();
    setBrowsingHistory(false);
    if (currentResult) setSelected(currentResult.resultId);
    else setRetry((n) => n + 1);
  };
  const saving = job.progress?.resultSaving?.state;
  const resultSavePending = saving === "saving" || saving === "failed";
  const reviewAvailable = job.status === "awaiting_review" && !resultSavePending && !finishing;
  const canVerifyResult = !resultSavePending && (reviewAvailable || retryableCompletion);
  const showFinalResultLink = retryableCompletion && currentResult && !resultSavePending;
  const resultLabel = reviewingCurrent
    ? reviewAvailable
      ? "Current review result"
      : "Latest result"
    : "Earlier result";
  const stepTitle = (stepId: string) =>
    job.workflow?.definition.steps.find((step) => step.id === stepId)?.title ?? stepId;
  useEffect(() => {
    const request = ++generation.current;
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
      .then((value) => {
        if (active.current && request === generation.current) setLoaded(value);
      })
      .catch((cause) => {
        if (active.current && request === generation.current)
          setError(cause instanceof Error ? cause.message : "Could not read this saved result.");
      })
      .finally(() => {
        if (active.current && request === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [reader, result, call, scope.repositoryId, job.jobId, retry]);
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
  const [renderedId, setRenderedId] = useState<string | null>(null);
  const recordVisible = useCallback(() => {
    if (
      view !== "changes" ||
      !loaded ||
      loaded.result.resultId !== result?.resultId ||
      !checkpoint ||
      !canVerifyResult ||
      !reviewingCurrent ||
      patch?.kind === "raw" ||
      (loaded.patch !== "" && renderedId !== loaded.result.resultId) ||
      document.visibilityState === "hidden"
    )
      return;
    const key = `${checkpoint.checkpointId}:${loaded.result.resultId}:${loaded.result.patch.sha256}`;
    if (recorded.current === key) return;
    recorded.current = key;
    const visitId = randomUUID();
    beginWorkflowReview(appAtomRegistry, scope, job.jobId, visitId, checkpoint);
    if (recordSavedWorkflowReviewDiff(appAtomRegistry, scope, job.jobId, visitId, loaded.result)) {
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, job.jobId);
      void refresh();
    }
  }, [
    view,
    loaded,
    result?.resultId,
    checkpoint,
    canVerifyResult,
    reviewingCurrent,
    job.jobId,
    scope,
    patch,
    refresh,
    renderedId,
  ]);
  useLayoutEffect(() => {
    recordVisible();
    document.addEventListener("visibilitychange", recordVisible);
    return () => document.removeEventListener("visibilitychange", recordVisible);
  }, [recordVisible]);
  const diffOptions = useMemo(
    () => ({
      diffStyle: !narrow && diffLayout === "split" ? ("split" as const) : ("unified" as const),
      onPostRender: () => setRenderedId(loaded?.result.resultId ?? null),
    }),
    [loaded?.result, narrow, diffLayout],
  );
  const readConversation = useCallback(
    async (more = false) => {
      if (!result || !job.runtime || job.runtime.kind !== "vm") return;
      const request = generation.current;
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
        if (active.current && generation.current === request)
          setConversation({ resultId: result.resultId, ...next });
      } catch (cause) {
        if (active.current && generation.current === request)
          setError(
            cause instanceof Error ? cause.message : "Could not read the saved conversation.",
          );
      } finally {
        if (active.current && generation.current === request) setBusy(false);
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
      void readConversation();
  }, [view, result, conversation, busy, error, readConversation]);
  const download = async (file: ChatAttachment) => {
    if (!result) return;
    const request = generation.current;
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
      if (!active.current || request !== generation.current) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes).buffer], { type: file.mimeType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.split(/[\\/]/u).at(-1) ?? "attachment";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      if (active.current && request === generation.current)
        setError("Could not download this saved attachment.");
    }
  };
  const moreResults = async () => {
    if (!index?.nextCursor || busy) return;
    const request = generation.current;
    setBusy(true);
    try {
      const page = await call((client, token) =>
        client
          .listSavedWorkflowResults({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: job.jobId,
            before: index.nextCursor!,
          })
          .pipe(Effect.map((data) => ({ ...data, relayUrl: client.relayUrl }))),
      );
      if (active.current && request === generation.current)
        setIndex((previous) =>
          previous && sameThreadPlacement(index, previous) && sameThreadPlacement(index, page)
            ? {
                ...previous,
                nextCursor: page.nextCursor,
                results: [
                  ...new Map(
                    [...previous.results, ...page.results].map((item) => [item.resultId, item]),
                  ).values(),
                ],
              }
            : previous,
        );
    } catch {
      if (active.current && request === generation.current)
        setError("Could not load older Agent results.");
    } finally {
      if (active.current && request === generation.current) setBusy(false);
    }
  };
  const openDeletion = () => {
    if (!index || busy || !canDelete) return;
    const { threadId, generation, relayUrl } = index;
    setDeletion({ state: "confirming", target: { threadId, generation, relayUrl } });
  };
  const clearSavedResults = () => {
    indexEpoch.current++;
    reader.clear();
    generation.current++;
    setLoaded(null);
    setConversation(null);
    setIndex(null);
    setSelected(null);
    setBrowsingHistory(false);
    setBusy(false);
  };
  const refreshDeletionTarget = () => {
    indexEpoch.current++;
    setRetry((previous) => previous + 1);
    void refresh();
  };
  const refreshDeletionStatus = () => {
    deletionStatus.current?.focus();
    setError(null);
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
  const resultView = (
    <div
      id={`${tabId}-saved-results`}
      className="space-y-3"
      hidden={!!partialResult && !partialResultOpen}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {result ? (
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-medium">{stepTitle(result.stepId)}</h3>
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
        {index?.results.length ? (
          <div className="w-full min-w-0 sm:w-auto sm:max-w-96">
            <Select value={selected} onValueChange={selectResult}>
              <SelectTrigger aria-label="Saved result" size="sm">
                <SelectValue>
                  {result
                    ? `Saved ${new Date(result.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                    : "Choose a saved result"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {index.results.map((entry) => (
                  <SelectItem key={entry.resultId} value={entry.resultId}>
                    <div>
                      <p>{stepTitle(entry.stepId)}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}{" "}
                        / {entry.outcome}
                        {entry.resultId === currentResult?.resultId ? " / Current" : " / Earlier"}
                      </p>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </div>
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
            ? "This saved result is read-only. Decisions apply to the current review."
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
      {index?.nextCursor ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void moreResults()}>
          Load older results
        </Button>
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
        {error && deletion?.state !== "checking" ? (
          <WorkflowAlert
            title="Could not read saved results"
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setRetry((n) => n + 1);
                }}
              >
                Retry
              </Button>
            }
          >
            {error}
          </WorkflowAlert>
        ) : null}
        {!waitingForThread && !index && !error ? (
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
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading {view}…
          </p>
        ) : null}
        {view === "changes" && loaded && loaded.result.resultId === result?.resultId ? (
          <div className="min-w-0 overflow-hidden">
            {loaded.patch === "" ? (
              <p className="p-4 text-sm text-muted-foreground">No file changes.</p>
            ) : patch?.kind === "files" ? (
              <StyledDiffCodeView
                options={diffOptions}
                items={patch.files.map((fileDiff, n) => ({
                  id: `${result!.resultId}:${n}`,
                  type: "diff",
                  fileDiff,
                }))}
              />
            ) : (
              <pre className="overflow-auto p-4 text-xs">{loaded.patch}</pre>
            )}
          </div>
        ) : null}
        {view === "conversation" && conversation && conversation.resultId === result?.resultId ? (
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
                busy={busy}
                onDownload={download}
              />
            ))}
            {conversation.more ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void readConversation(true)}
              >
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
  return (
    <section
      ref={savedResults}
      tabIndex={-1}
      aria-label="Saved workflow results"
      className="space-y-3"
    >
      {!resultsUnavailable && partialResult ? (
        <WorkflowOutcome
          title={hasPartialChanges ? "Partial changes saved" : "Partial result saved"}
          actions={
            <Button
              aria-controls={`${tabId}-saved-results`}
              aria-expanded={partialResultOpen}
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
                error ? "Could not refresh the workflow thread" : "Checking the workflow thread"
              }
              variant={error ? "warning" : "info"}
              actions={
                error ? (
                  <Button size="sm" variant="outline" onClick={refreshDeletionStatus}>
                    Refresh saved results
                  </Button>
                ) : undefined
              }
            >
              {error
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
              disabled={busy || !index}
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
            <Button variant="destructive" disabled={busy} onClick={() => void deleteThread()}>
              Delete thread
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
