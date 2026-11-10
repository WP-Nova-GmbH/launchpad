import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import { useAtomValue } from "@effect/atom-react";
import { threadVmControls } from "../../state/threads";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import type { RepositoryWorkflowJob, WorkflowSavedResult } from "@t3tools/contracts/workflows";
import {
  makeWorkflowSavedResultReader,
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
import { useIsMobile } from "../../hooks/useMediaQuery";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { getRenderablePatch } from "../../lib/diffRendering";
import { randomUUID } from "../../lib/utils";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { SavedConversationMessage } from "../chat/SavedConversationMessage";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkflowAlert } from "./WorkflowAlert";
import { useWorkflowClient, confirmWorkflow } from "./workflowState";

export function SavedWorkflowResults({
  scope,
  job,
  refresh,
  canConfigure,
}: {
  scope: WorkflowScope;
  job: RepositoryWorkflowJob;
  refresh: () => Promise<void>;
  canConfigure: boolean;
}) {
  const call = useWorkflowClient(scope);
  const narrow = useIsMobile();
  const [index, setIndex] = useState<{
    relayUrl: string;
    results: ReadonlyArray<WorkflowSavedResult>;
    nextCursor: number | null;
    threadId: ThreadId;
    generation: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
    job.progress?.resultSaving?.publicationId,
    job.progress?.resultSaving?.state,
    retry,
    reader,
    deleted,
    waitingForThread,
  ]);
  const result = index?.results.find((entry) => entry.resultId === selected) ?? null;
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
  const recorded = useRef<string | null>(null);
  const [renderedId, setRenderedId] = useState<string | null>(null);
  const recordVisible = useCallback(() => {
    if (
      view !== "changes" ||
      !loaded ||
      loaded.result.resultId !== result?.resultId ||
      !checkpoint ||
      job.status !== "awaiting_review" ||
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
    job.status,
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
      diffStyle: narrow ? ("unified" as const) : ("split" as const),
      onPostRender: () => setRenderedId(loaded?.result.resultId ?? null),
    }),
    [loaded?.result, narrow],
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
        setError(
          "Could not confirm thread deletion. Retry deleting to reconcile the same request.",
        );
        setBusy(false);
      }
    }
  };
  if (deleted)
    return (
      <p className="text-sm text-muted-foreground">
        Thread deletion requested. Its saved results are no longer available.
      </p>
    );
  return (
    <section aria-label="Saved workflow results" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Saved results</h3>
        {index?.results.length ? (
          <div className="min-w-48">
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger aria-label="Agent result" size="sm">
                <SelectValue>
                  {result
                    ? `${stepTitle(result.stepId)} · ${result.outcome}`
                    : "Choose an Agent result"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {index.results.map((entry) => (
                  <SelectItem key={entry.resultId} value={entry.resultId}>
                    {entry.turnCount}. {stepTitle(entry.stepId)} · {entry.outcome}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <Button
          size="sm"
          variant={view === "changes" ? "secondary" : "ghost"}
          onClick={() => setView("changes")}
        >
          Changes
        </Button>
        <Button
          size="sm"
          variant={view === "conversation" ? "secondary" : "ghost"}
          onClick={() => setView("conversation")}
        >
          Conversation
        </Button>
      </div>
      {index?.nextCursor ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void moreResults()}>
          Load older Agent results
        </Button>
      ) : null}
      {canDelete ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteThread()}>
          Delete thread permanently
        </Button>
      ) : null}
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
      {(waitingForThread || index) && !result ? (
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
        <div className="max-h-[36rem] overflow-auto rounded-lg border">
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
        <div className="max-h-[36rem] space-y-3 overflow-auto rounded-lg border p-3">
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
    </section>
  );
}
