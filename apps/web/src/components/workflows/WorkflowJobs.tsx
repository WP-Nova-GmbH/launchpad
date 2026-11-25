import {
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardCheckIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { WorkflowAlert } from "./WorkflowAlert";
import { workflowFinalCheckDetail, workflowSaveFailureDetail } from "./WorkflowCompletionRecovery";
import { workflowQueuedTask } from "./WorkflowQueuedTask";
import { workflowVmRecoveryTask } from "./WorkflowVmRecovery";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, type HistoryState } from "@tanstack/react-router";
import {
  WorkflowInvalidError,
  type RepositoryWorkflow,
  type RepositoryWorkflowJobSummary,
  type WorkflowJobListView,
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
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
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
type OlderRunsFailure = { cursor: string; recovery: "retry" | "refresh" };
const emptyRunsRead = {
  ...emptyWorkflowJobPageRead,
  olderRunsFailure: null as OlderRunsFailure | null,
};
const isRejectedCursor = Schema.is(Schema.Struct({ cause: WorkflowInvalidError }));

function findRunAction(list: HTMLElement, jobId: string) {
  return [...list.querySelectorAll<HTMLButtonElement>("[data-workflow-run-id]")].find(
    (button) => button.dataset.workflowRunId === jobId,
  );
}

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

const completionStatusLabels = {
  saving_result: "Saving run data",
  retrying_save: "Waiting for retry confirmation",
  save_failed: "Save failed",
  finishing: "Finishing run",
  completion_blocked: "Completion blocked",
} satisfies Record<NonNullable<RepositoryWorkflowJobSummary["completionState"]>, string>;

function runAttentionPresentation(
  job: RepositoryWorkflowJobSummary,
  recovery: ReturnType<typeof workflowVmRecoveryDisplay>,
) {
  const responsePending = job.checkpointResponsePending === true;
  const recoveryTask = job.vmRecovery
    ? workflowVmRecoveryTask(job.vmRecovery, responsePending)
    : undefined;
  if (recoveryTask?.warning) {
    return {
      status: "Blocked",
      action: "View blocker",
      icon: recoveryTask.icon,
      detail: recoveryTask.title,
      context: recoveryTask.message,
    };
  }
  if (job.completionState) {
    const blocked =
      job.completionState === "save_failed" || job.completionState === "completion_blocked";
    const rawDetail =
      job.completionDetail ??
      (job.detail === "Response saved; waiting for the environment." ? null : job.detail);
    const context =
      job.completionState === "save_failed"
        ? workflowSaveFailureDetail(rawDetail)
        : job.completionState === "completion_blocked"
          ? workflowFinalCheckDetail(rawDetail)
          : rawDetail;
    return {
      status: completionStatusLabels[job.completionState],
      action: blocked ? "View blocker" : "View run",
      icon: blocked ? TriangleAlertIcon : undefined,
      detail: null,
      context,
    };
  }
  if (recoveryTask && (recovery?.pending || responsePending)) {
    return { status: recoveryTask.title, action: "View run", detail: null };
  }
  if (job.status === "queued" && job.queueReason?.code === "vm_waiting_capacity") {
    const task = workflowQueuedTask(job, job.detail);
    return {
      status: task?.title ?? workflowStatusLabel(job.status),
      action: "View run",
      detail: task ? null : undefined,
    };
  }
  if (responsePending) return { status: "Waiting for confirmation", action: "View run" };
  if (job.needsAttention === false) return null;

  if (job.status === "awaiting_input") {
    return {
      status: workflowStatusLabel(job.status),
      action: "View input",
      icon: MessageSquareIcon,
    };
  }
  if (job.status === "awaiting_review") {
    return {
      status: workflowStatusLabel(job.status),
      action: "Open review",
      icon: ClipboardCheckIcon,
    };
  }
  if (job.needsAttention && (job.status === "queued" || job.status === "preparing")) {
    return {
      status: "Blocked",
      action: "View blocker",
      icon: TriangleAlertIcon,
      detail: workflowQueuedTask(job, job.detail)?.title,
    };
  }

  return null;
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
  const desktop = useMediaQuery("(min-width: 48rem)");
  const [view, setView] = useState<WorkflowJobListView>(() => returnContext?.view ?? "active");
  const [read, setRead] = useState(emptyRunsRead);
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
  const olderRunsButton = useRef<HTMLButtonElement>(null);
  const olderRunsFocus = useRef<{ key: string; jobId: string; button: HTMLButtonElement } | null>(
    null,
  );
  const restoreOlderRunsFocus = useCallback(() => {
    const button = olderRunsButton.current;
    if (button && button.ownerDocument.activeElement === button)
      section.current?.focus({ preventScroll: true });
  }, []);
  const current = useRef<WorkflowJobPageRequest | null>(null);
  const latestRead = useRef(read);
  useLayoutEffect(() => {
    latestRead.current = read;
  }, [read]);
  const key = workflowSessionKey(scope, `runs:${view}`);
  const load = useCallback(
    async (
      cursor: string | null = null,
      refreshMetadata = false,
      minimumCount = 0,
      refreshThrough?: RunPosition,
    ) => {
      if (current.current?.key === key) return;
      const request = { key, cursor };
      const restoreRow =
        cursor === null ? (pendingReturn.current?.row ?? refreshThrough) : undefined;
      current.current = request;
      const retry = retryButton.current;
      if (pendingReturn.current && retry && retry.ownerDocument.activeElement === retry) {
        // Beginning a read removes the error and its retry button.
        selectedFilter.current?.focus({ preventScroll: true });
        returnFocusCancelled.current = false;
      }
      setRead((previous) => ({
        ...beginWorkflowJobPage(previous, request),
        olderRunsFailure:
          previous.key === key &&
          cursor === null &&
          (!refreshMetadata || previous.olderRunsFailure?.recovery === "refresh")
            ? previous.olderRunsFailure
            : null,
      }));
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
        if (current.current === request) {
          if (!page.nextCursor) {
            const button = olderRunsButton.current;
            if (button && button.ownerDocument.activeElement === button) {
              const loadedIds = new Set(latestRead.current.jobs?.map(({ jobId }) => jobId));
              const firstAppended =
                cursor !== null ? page.jobs.find(({ jobId }) => !loadedIds.has(jobId)) : undefined;
              if (firstAppended)
                olderRunsFocus.current = { key, jobId: firstAppended.jobId, button };
              else restoreOlderRunsFocus();
            }
          }
          setRead((previous) => {
            if (previous.request !== request) return previous;
            const next = settleWorkflowJobPage(previous, request, page);
            return {
              ...next,
              olderRunsFailure:
                previous.olderRunsFailure?.cursor === next.nextCursor
                  ? previous.olderRunsFailure
                  : null,
            };
          });
        }
      } catch (cause) {
        if (current.current === request) {
          const accessLost = workflowJobAccessLost(cause);
          const olderRunsFailure: OlderRunsFailure | null =
            !accessLost && view === "history" && cursor !== null
              ? { cursor, recovery: isRejectedCursor(cause) ? "refresh" : "retry" }
              : null;
          if (accessLost) restoreOlderRunsFocus();
          setRead((previous) => {
            if (previous.request !== request) return previous;
            const next = settleWorkflowJobPage(previous, request, workflowError(cause), accessLost);
            return {
              ...next,
              error: olderRunsFailure ? null : next.error,
              olderRunsFailure: accessLost ? null : (olderRunsFailure ?? previous.olderRunsFailure),
            };
          });
        }
      } finally {
        if (current.current === request) current.current = null;
      }
    },
    [call, key, scope.repositoryId, view, refreshWorkflows, restoreOlderRunsFocus],
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
      const { jobs, nextCursor, olderRunsFailure } =
        previous.key === key ? previous : emptyRunsRead;
      const refreshThrough =
        olderRunsFailure?.recovery === "refresh" && olderRunsFailure.cursor === nextCursor
          ? jobs?.at(-1)
          : undefined;
      void load(
        null,
        false,
        pendingReturn.current?.loadedCount ?? jobs?.length ?? 0,
        refreshThrough,
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
  const page = read.key === key ? read : emptyRunsRead;
  const busy = !!page.request;
  useLayoutEffect(() => {
    const pending = olderRunsFocus.current;
    if (!pending || busy) return;
    olderRunsFocus.current = null;
    const list = section.current;
    if (!list || pending.key !== key || page.nextCursor) return;
    const { activeElement, body } = list.ownerDocument;
    if (activeElement && activeElement !== body && activeElement !== pending.button) return;
    const target = findRunAction(list, pending.jobId);
    (target ?? list).focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [busy, key, page.nextCursor]);
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
    const target = jobId ? findRunAction(list, jobId) : undefined;
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

  const olderRunsRecovery =
    page.olderRunsFailure?.cursor === page.nextCursor ? page.olderRunsFailure.recovery : undefined;
  const refreshOlderRuns = olderRunsRecovery === "refresh";
  const refreshLoadedHistory = (refreshMetadata: boolean) =>
    void load(null, refreshMetadata, page.jobs?.length ?? 0, page.jobs?.at(-1));
  const refreshRuns = () => {
    if (refreshOlderRuns) refreshLoadedHistory(true);
    else void load(null, true, pendingReturn.current?.loadedCount ?? 0);
  };
  const loadingOlderRuns = page.request?.cursor != null;
  const olderRunsPending = loadingOlderRuns || (busy && refreshOlderRuns);
  const olderRunsLabel = loadingOlderRuns
    ? "Loading older runs…"
    : busy && refreshOlderRuns
      ? "Refreshing runs…"
      : refreshOlderRuns
        ? "Refresh runs"
        : olderRunsRecovery
          ? "Retry"
          : "Load older runs";
  const olderRunsActionName = olderRunsPending
    ? olderRunsLabel
    : refreshOlderRuns
      ? "Refresh runs to load older runs"
      : olderRunsRecovery
        ? "Retry loading older runs"
        : olderRunsLabel;
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
      tabIndex={-1}
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
                size={desktop ? "icon-sm" : "icon"}
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
              const attentionRow =
                view === "attention" ? runAttentionPresentation(job, vmRecovery) : null;
              const AttentionIcon = attentionRow?.icon;
              const needsAttention =
                vmRecovery || view === "attention" ? job.needsAttention : undefined;
              const attentionStyle = attentionRow
                ? !!AttentionIcon
                : (needsAttention ??
                  (vmRecovery?.warning || (!vmRecovery?.pending && atCheckpoint)));
              const statusLabel = attentionRow?.status ?? workflowStatusLabel(job.status);
              const actionLabel =
                attentionRow?.action ??
                (view !== "attention" && job.status === "awaiting_review"
                  ? "Open review"
                  : "View run");
              const context =
                attentionRow?.context ??
                (attentionRow?.detail === undefined ? (vmRecovery?.title ?? job.detail) : null);

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
                    {context ? (
                      <p className="text-xs wrap-anywhere text-muted-foreground">{context}</p>
                    ) : null}
                  </div>
                  <div className="min-w-0 space-y-0.5 text-xs">
                    <span
                      className={
                        attentionStyle
                          ? "flex items-start gap-1.5 font-medium text-warning-foreground"
                          : "block"
                      }
                    >
                      {AttentionIcon ? (
                        <AttentionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      ) : null}
                      {statusLabel}
                    </span>
                    {attentionRow?.detail ? (
                      <p className="text-xs wrap-anywhere text-muted-foreground">
                        {attentionRow.detail}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    <span className="sr-only">Submitted </span>
                    <time dateTime={job.createdAt}>{formatRelativeTimeLabel(job.createdAt)}</time>
                  </span>
                  <div className="justify-self-end">
                    <Button
                      variant={attentionStyle ? "outline" : "ghost"}
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
        view === "history" ? (
          <div className="flex flex-wrap items-center gap-2 [overflow-anchor:none]">
            <p
              role="status"
              className={
                olderRunsRecovery && !olderRunsPending
                  ? "flex items-center gap-2 text-xs font-medium text-destructive-foreground"
                  : "sr-only"
              }
            >
              {olderRunsPending ? (
                olderRunsLabel
              ) : olderRunsRecovery ? (
                <>
                  <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                  Couldn’t load older runs
                </>
              ) : null}
            </p>
            <Button
              ref={olderRunsButton}
              variant="outline"
              size="compact"
              aria-disabled={busy || undefined}
              aria-label={olderRunsActionName}
              onClick={() => {
                if (busy) return;
                if (refreshOlderRuns) refreshLoadedHistory(false);
                else void load(page.nextCursor);
              }}
            >
              {olderRunsPending ? (
                <Spinner aria-hidden aria-label={undefined} role={undefined} />
              ) : olderRunsRecovery ? (
                <RefreshCwIcon aria-hidden />
              ) : (
                <ChevronDownIcon aria-hidden />
              )}
              {olderRunsLabel}
            </Button>
          </div>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void load(page.nextCursor)}>
            {busy ? "Loading…" : "Load more runs"}
          </Button>
        )
      ) : null}
    </section>
  );
}
