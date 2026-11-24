import { RefreshCwIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { WorkflowAlert } from "./WorkflowAlert";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, type HistoryState } from "@tanstack/react-router";
import type {
  RepositoryWorkflow,
  RepositoryWorkflowJobSummary,
  WorkflowJobListView,
} from "@t3tools/contracts/workflows";
import { workflowVmRecoveryDisplay } from "@t3tools/client-runtime/relay/workflow-responses";
import {
  workflowJobAccessLost,
  emptyWorkflowJobPageRead,
  beginWorkflowJobPage,
  settleWorkflowJobPage,
  readWorkflowJobPages,
  workflowSessionKey,
  workflowStatusLabel,
  type WorkflowScope,
  type WorkflowJobPageRequest,
} from "@t3tools/client-runtime/relay/workflow-session";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { useWorkflowClient, workflowError } from "./workflowState";
import type { WorkflowRunsReturn } from "./workflowRunsNavigation";

interface WorkflowJobsProps {
  scope: WorkflowScope;
  workflows: ReadonlyArray<RepositoryWorkflow>;
  refreshWorkflows: () => Promise<void>;
}

type RunsHistoryEntry = HistoryState & { __TSR_key?: string; key?: string };
type RunPosition = Pick<RepositoryWorkflowJobSummary, "createdAt" | "jobId">;
const runsScrollContainer = "[data-workflow-runs-scroll-container]";

function compareRunPosition(left: RunPosition, right: RunPosition) {
  // The relay orders runs by ISO creation time and uses job ID to break ties.
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.jobId === right.jobId ? 0 : left.jobId < right.jobId ? -1 : 1;
}

function returnedRunId(
  restored: WorkflowRunsReturn,
  jobs: ReadonlyArray<RepositoryWorkflowJobSummary>,
) {
  const { row } = restored;
  if (!row) return undefined;
  if (jobs.some(({ jobId }) => jobId === row.jobId)) return row.jobId;
  if (restored.view === "attention" && row.createdAt) {
    const anchor = { jobId: row.jobId, createdAt: row.createdAt };
    return (jobs.find((job) => compareRunPosition(job, anchor) > 0) ?? jobs.at(-1))?.jobId;
  }
  return (
    [row.nextJobId, row.previousJobId].find((id) => jobs.some(({ jobId }) => jobId === id)) ??
    jobs[Math.min(row.index, jobs.length - 1)]?.jobId
  );
}

function currentRunsHistoryEntry(entryKey: string | undefined) {
  const state = globalThis.window?.history?.state as RunsHistoryEntry | null | undefined;
  return entryKey && (state?.__TSR_key ?? state?.key) === entryKey ? state : undefined;
}

export function WorkflowJobs(props: WorkflowJobsProps) {
  const state = useLocation({ select: (location) => location.state });
  // A pending destination changes the router location before the Runs list leaves.
  const [{ entryKey, returnContext }] = useState(() => {
    const entryKey = state?.__TSR_key ?? state?.key;
    const returnContext =
      state?.workflowRunsReturn ?? currentRunsHistoryEntry(entryKey)?.workflowRunsReturn;
    return { entryKey, returnContext };
  });
  const scopeKey = workflowSessionKey(props.scope, "runs");
  return (
    <WorkflowJobsList
      key={scopeKey}
      {...props}
      entryKey={entryKey}
      scopeKey={scopeKey}
      returnContext={returnContext?.scopeKey === scopeKey ? returnContext : undefined}
    />
  );
}

function WorkflowJobsList({
  scope,
  workflows,
  refreshWorkflows,
  entryKey,
  scopeKey,
  returnContext,
}: WorkflowJobsProps & {
  entryKey: string | undefined;
  scopeKey: string;
  returnContext: WorkflowRunsReturn | undefined;
}) {
  const call = useWorkflowClient(scope);
  const navigate = useNavigate();
  const [view, setView] = useState<WorkflowJobListView>(() => returnContext?.view ?? "active");
  const [read, setRead] = useState(emptyWorkflowJobPageRead);
  const pendingReturn = useRef(returnContext);
  const returnFocusCancelled = useRef(false);
  const attentionReturn = useRef<{
    context: WorkflowRunsReturn;
    action: HTMLButtonElement;
    detachedWhileFocused: boolean;
  } | null>(null);
  const trackAttentionAction = useCallback((action: HTMLButtonElement | null) => {
    if (!action) return;
    const current = attentionReturn.current;
    if (current?.action === action) current.detachedWhileFocused = false;
    return () => {
      const tracked = attentionReturn.current;
      // Ref cleanup runs before the focused row leaves the DOM.
      if (tracked?.action === action)
        tracked.detachedWhileFocused = action.ownerDocument.activeElement === action;
    };
  }, []);
  const section = useRef<HTMLElement>(null);
  const selectedFilter = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const current = useRef<WorkflowJobPageRequest | null>(null);
  const latestRead = useRef(read);
  useLayoutEffect(() => {
    latestRead.current = read;
  }, [read]);
  const key = workflowSessionKey(scope, `runs:${view}`);
  const load = useCallback(
    async (cursor: string | null = null, refreshMetadata = false, minimumCount = 0) => {
      if (current.current?.key === key) return;
      const request = { key, cursor };
      const restoreRow = cursor === null ? pendingReturn.current?.row : undefined;
      current.current = request;
      const retry = retryButton.current;
      if (pendingReturn.current && retry && retry.ownerDocument.activeElement === retry) {
        // Beginning a read removes the error and its retry button.
        selectedFilter.current?.focus({ preventScroll: true });
        returnFocusCancelled.current = false;
      }
      setRead((previous) => beginWorkflowJobPage(previous, request));
      try {
        const [page] = await Promise.all([
          readWorkflowJobPages(
            (pageCursor) =>
              call((client, clerkToken) =>
                client.pageWorkflowJobs({
                  clerkToken,
                  repositoryId: scope.repositoryId,
                  query: { view, ...(pageCursor ? { cursor: pageCursor } : {}) },
                }),
              ),
            {
              cursor,
              minimumCount,
              isCurrent: () => current.current === request,
              continueWhile: (last) => {
                if (cursor !== null || view === "active") return false;
                const tracked = attentionReturn.current;
                const row =
                  restoreRow ??
                  (view === "attention" &&
                  tracked &&
                  tracked.action.ownerDocument.activeElement === tracked.action
                    ? tracked.context.row
                    : undefined);
                if (!row?.createdAt) return false;
                const anchor = { jobId: row.jobId, createdAt: row.createdAt };
                const position = compareRunPosition(last, anchor);
                // Sorted pages can stop as soon as they reach or pass the original run.
                return view === "history" ? position > 0 : position < 0;
              },
            },
          ),
          refreshMetadata ? refreshWorkflows() : undefined,
        ]);
        if (current.current === request)
          setRead((previous) => settleWorkflowJobPage(previous, request, page));
      } catch (cause) {
        if (current.current === request)
          setRead((previous) =>
            settleWorkflowJobPage(
              previous,
              request,
              workflowError(cause),
              workflowJobAccessLost(cause),
            ),
          );
      } finally {
        if (current.current === request) current.current = null;
      }
    },
    [call, key, scope.repositoryId, view, refreshWorkflows],
  );
  useEffect(() => {
    void load(null, false, pendingReturn.current?.loadedCount ?? 0);
    return () => {
      current.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden" || current.current) return;
      const previous = latestRead.current;
      void load(
        null,
        false,
        pendingReturn.current?.loadedCount ??
          (previous.key === key ? (previous.jobs?.length ?? 0) : 0),
      );
    };
    const timer = window.setInterval(refreshVisible, 5000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load, key]);
  const page = read.key === key ? read : emptyWorkflowJobPageRead;
  const busy = !!page.request;
  useLayoutEffect(() => {
    const document = section.current?.ownerDocument;
    if (!document || !pendingReturn.current) return;
    // Focus may have moved while the repository catalog was still loading.
    if (document.activeElement && document.activeElement !== document.body)
      returnFocusCancelled.current = true;
    const cancelFocus = (event: FocusEvent) => {
      if (pendingReturn.current && event.target !== document.body)
        returnFocusCancelled.current = true;
    };
    document.addEventListener("focusin", cancelFocus);
    return () => document.removeEventListener("focusin", cancelFocus);
  }, []);
  useLayoutEffect(() => {
    const restored = pendingReturn.current;
    const list = section.current;
    if (!list || busy) return;
    const tracked = attentionReturn.current;
    let handoff: WorkflowRunsReturn | undefined;
    if (tracked && !tracked.action.isConnected) {
      attentionReturn.current = null;
      if (tracked.detachedWhileFocused) handoff = tracked.context;
    }
    const context = restored ?? handoff;
    if (!context || page.jobs === null || page.error) return;
    pendingReturn.current = undefined;
    if (entryKey && globalThis.window?.history && !currentRunsHistoryEntry(entryKey)) return;
    if (restored) {
      if (returnFocusCancelled.current) return;
      const scroll = list.closest<HTMLElement>(runsScrollContainer);
      if (scroll) scroll.scrollTop = restored.scrollTop;
    } else if (
      view !== "attention" ||
      list.ownerDocument.activeElement !== list.ownerDocument.body
    ) {
      return;
    }

    const jobId = returnedRunId(context, page.jobs);
    const target = jobId
      ? [...list.querySelectorAll<HTMLButtonElement>("[data-workflow-run-id]")].find(
          (action) => action.dataset.workflowRunId === jobId,
        )
      : undefined;
    (target ?? selectedFilter.current)?.focus({ preventScroll: true });
    if (
      restored?.view === "attention" &&
      restored.row?.jobId === jobId &&
      target &&
      target.ownerDocument.activeElement === target
    ) {
      attentionReturn.current = { context: restored, action: target, detachedWhileFocused: false };
    }
    target?.scrollIntoView?.({ block: "nearest" });
  }, [busy, entryKey, page.error, page.jobs, view]);

  const refreshRuns = () => void load(null, true, pendingReturn.current?.loadedCount ?? 0);
  const openRun = (index: number) => {
    const { jobs } = page;
    const job = jobs?.[index];
    if (!job || !jobs) return;
    const { jobId, createdAt } = job;
    const nextJobId = jobs[index + 1]?.jobId;
    const previousJobId = jobs[index - 1]?.jobId;
    const workflowRunsReturn: WorkflowRunsReturn = {
      scopeKey,
      view,
      row: {
        jobId,
        createdAt,
        index,
        ...(nextJobId ? { nextJobId } : {}),
        ...(previousJobId ? { previousJobId } : {}),
      },
      loadedCount: jobs.length,
      scrollTop: section.current?.closest<HTMLElement>(runsScrollContainer)?.scrollTop ?? 0,
    };
    const source = currentRunsHistoryEntry(entryKey);
    // Preserve the entry key and index so Browser Back can restore this exact list.
    if (source) window.history.replaceState({ ...source, workflowRunsReturn }, "");
    void navigate({
      to: "/workflows/$repositoryId/jobs/$jobId",
      params: { repositoryId: scope.repositoryId, jobId },
      state: { workflowRunsReturn },
    });
  };

  return (
    <section
      ref={section}
      className="@container/workflow-runs space-y-4"
      aria-label="Workflow runs"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter runs">
          {(["active", "attention", "history"] as const).map((choice) => (
            <Button
              key={choice}
              ref={choice === view ? selectedFilter : undefined}
              variant={choice === view ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={view === choice}
              onClick={() => {
                if (choice !== view) pendingReturn.current = undefined;
                setView(choice);
              }}
            >
              {choice === "active"
                ? "Active"
                : choice === "attention"
                  ? "Needs attention"
                  : "History"}
            </Button>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh runs"
                disabled={busy}
                onClick={refreshRuns}
              />
            }
          >
            <RefreshCwIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>Refresh runs</TooltipPopup>
        </Tooltip>
      </div>
      {page.error ? (
        <WorkflowAlert
          title={page.jobs ? "Could not refresh runs" : "Could not load runs"}
          actions={
            <Button
              ref={retryButton}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={refreshRuns}
            >
              Retry loading runs
            </Button>
          }
        >
          {page.error}
          {page.jobs ? " Showing the last available runs. Refresh to retry." : ""}
        </WorkflowAlert>
      ) : null}
      {page.jobs === null && !page.error ? (
        <p>Loading runs…</p>
      ) : page.jobs?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {view === "history"
            ? "No completed runs."
            : view === "attention"
              ? "No runs need attention."
              : "No active runs."}
        </p>
      ) : null}
      {page.jobs?.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_6.75rem] gap-x-2 @min-[34rem]/workflow-runs:grid-cols-[minmax(0,1fr)_8.5rem_4.5rem_7rem] @min-[34rem]/workflow-runs:gap-x-3">
          <div
            aria-hidden
            className="col-span-full hidden grid-cols-subgrid border-b pb-2 text-xs text-muted-foreground @min-[34rem]/workflow-runs:grid"
          >
            <span>Workflow</span>
            <span>Status</span>
            <span>Submitted</span>
          </div>
          <ul
            role="list"
            aria-label={view === "history" ? "Runs, newest first" : "Runs, oldest first"}
            className="col-span-full grid grid-cols-subgrid"
          >
            {page.jobs.map((job, index) => {
              const workflowName =
                job.originSummary?.workflowName ??
                workflows.find((workflow) => workflow.workflowId === job.workflowId)?.definition
                  .name ??
                "Workflow run";
              const vmRecovery = workflowVmRecoveryDisplay(job.vmRecovery);
              const atCheckpoint =
                job.status === "awaiting_review" || job.status === "awaiting_input";
              const needsAttention = vmRecovery
                ? (job.needsAttention ??
                  (vmRecovery.warning || (!vmRecovery.pending && atCheckpoint)))
                : atCheckpoint;
              const actionLabel = job.status === "awaiting_review" ? "Open review" : "View run";

              return (
                <li
                  key={job.jobId}
                  className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5 border-b py-3"
                >
                  <div className="col-span-full min-w-0 @min-[34rem]/workflow-runs:col-span-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className="text-sm font-medium wrap-anywhere">{workflowName}</p>
                      {job.originSummary?.kind === "automation" ? (
                        <span className="text-xs text-muted-foreground">Started by workflow</span>
                      ) : null}
                      {(job.targetKind ?? job.runtime?.kind) === "vm" ? (
                        <span className="text-xs text-muted-foreground">Workflow VM</span>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
                      {job.instruction}
                    </p>
                    {vmRecovery ? (
                      <p className="text-xs wrap-anywhere text-muted-foreground">
                        {vmRecovery.title}
                      </p>
                    ) : job.detail ? (
                      <p className="text-xs wrap-anywhere text-muted-foreground">{job.detail}</p>
                    ) : null}
                  </div>
                  <span
                    className={
                      needsAttention ? "text-xs font-medium text-warning-foreground" : "text-xs"
                    }
                  >
                    {workflowStatusLabel(job.status)}
                  </span>
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    <span className="sr-only">Submitted </span>
                    <time dateTime={job.createdAt}>{formatRelativeTimeLabel(job.createdAt)}</time>
                  </span>
                  <div className="justify-self-end">
                    <Button
                      variant={needsAttention ? "outline" : "ghost"}
                      size="compact"
                      aria-label={`${actionLabel} for ${workflowName}: ${job.instruction}`}
                      data-workflow-run-id={job.jobId}
                      ref={
                        view === "attention" && returnContext?.row?.jobId === job.jobId
                          ? trackAttentionAction
                          : undefined
                      }
                      onClick={() => openRun(index)}
                    >
                      {actionLabel}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {page.nextCursor ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(page.nextCursor)}>
          {busy ? "Loading…" : "Load more runs"}
        </Button>
      ) : null}
    </section>
  );
}
