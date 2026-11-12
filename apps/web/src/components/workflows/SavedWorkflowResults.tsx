import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { threadVmControls } from "../../state/threads";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
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
import { Columns2Icon, FileDiffIcon, Rows3Icon } from "lucide-react";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getRenderablePatch } from "../../lib/diffRendering";
import { randomUUID } from "../../lib/utils";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { SavedConversationMessage } from "../chat/SavedConversationMessage";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { useWorkflowClient, confirmWorkflow } from "./workflowState";

const sameSavedResult = Schema.toEquivalence(WorkflowSavedResult);

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
  const deleteIntent = useRef<string | null>(null);
  const [deletionRequested, setDeletionRequested] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const cancelled = job.status === "cancelled";
  const cancellationDetail = cancelled && (job.detail ?? job.progress?.detail);
  const threadState = savedWorkflowThreadState(job);
  const deleted = deletionRequested || threadState === "deleted";
  const waitingForThread = threadState === "not_started";
  const capabilities = useAtomValue(threadVmControls.capabilitiesAtom);
  const canDelete = canDeleteSavedWorkflowThread(job, canConfigure, capabilities);
  const latestDeletionAccess = useRef(canDelete);
  useLayoutEffect(() => {
    latestDeletionAccess.current = canDelete;
  }, [canDelete]);
  const active = useRef(true);
  const generation = useRef(0);
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
        if (!current) return;
        setIndex((previous) => {
          const previousResult = previous?.results.find(
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
      })
      .catch((cause) => {
        if (current) {
          reader.clear();
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
    reader,
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
        client.listSavedWorkflowResults({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId: job.jobId,
          before: index.nextCursor!,
        }),
      );
      if (active.current && request === generation.current)
        setIndex((previous) =>
          previous
            ? {
                ...previous,
                nextCursor: page.nextCursor,
                results: [
                  ...new Map(
                    [...previous.results, ...page.results].map((item) => [item.resultId, item]),
                  ).values(),
                ],
              }
            : null,
        );
    } catch {
      if (active.current && request === generation.current)
        setError("Could not load older Agent results.");
    } finally {
      if (active.current && request === generation.current) setBusy(false);
    }
  };
  const deleteThread = async () => {
    if (!index || busy || !canDelete) return;
    if (
      !deleteIntent.current &&
      !(await confirmWorkflow(
        "Permanently delete this workflow thread, its saved results and its VM workspace? This cannot be undone.",
      ))
    )
      return;
    if (
      !latestDeletionAccess.current ||
      !canDeleteSavedWorkflowThread(
        job,
        canConfigure,
        appAtomRegistry.get(threadVmControls.capabilitiesAtom),
      ) ||
      !active.current
    )
      return;
    deleteIntent.current ??= randomUUID();
    setDeletionError(null);
    const request = generation.current;
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
      if (active.current && request === generation.current) {
        reader.clear();
        generation.current++;
        setLoaded(null);
        setConversation(null);
        setIndex(null);
        setDeletionRequested(true);
        setBusy(false);
        void refresh();
      }
    } catch {
      if (active.current && request === generation.current) {
        setDeletionError("Retry deleting to reconcile the same request.");
        setBusy(false);
      }
    }
  };
  if (deleted)
    return (
      <div className="space-y-3 text-sm text-muted-foreground">
        {cancellationDetail ? <p>{cancellationDetail}</p> : null}
        <p>Thread deletion requested. Its saved results are no longer available.</p>
      </div>
    );
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
        {error ? (
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
    <section aria-label="Saved workflow results" className="space-y-3">
      {partialResult ? (
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
      {resultView}
      {canDelete ? (
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">More controls</summary>
          <div className="mt-2 space-y-2">
            {deletionError ? (
              <WorkflowAlert title="Could not confirm thread deletion">
                {deletionError}
              </WorkflowAlert>
            ) : null}
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || !index}
              onClick={() => void deleteThread()}
            >
              Delete thread permanently
            </Button>
          </div>
        </details>
      ) : null}
    </section>
  );
}
