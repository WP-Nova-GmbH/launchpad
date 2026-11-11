import { RefreshCwIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { WorkflowAlert } from "./WorkflowAlert";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { RepositoryWorkflow, WorkflowJobListView } from "@t3tools/contracts/workflows";
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

export function WorkflowJobs({
  scope,
  workflows,
  refreshWorkflows,
}: {
  scope: WorkflowScope;
  workflows: ReadonlyArray<RepositoryWorkflow>;
  refreshWorkflows: () => Promise<void>;
}) {
  const call = useWorkflowClient(scope);
  const navigate = useNavigate();
  const [view, setView] = useState<WorkflowJobListView>("active");
  const [read, setRead] = useState(emptyWorkflowJobPageRead);
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
      current.current = request;
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
            { cursor, minimumCount, isCurrent: () => current.current === request },
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
    void load();
    return () => {
      current.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden" || current.current) return;
      const previous = latestRead.current;
      void load(null, false, previous.key === key ? (previous.jobs?.length ?? 0) : 0);
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
  return (
    <section className="@container/workflow-runs space-y-4" aria-label="Workflow runs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter runs">
          {(["active", "attention", "history"] as const).map((choice) => (
            <Button
              key={choice}
              variant={choice === view ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={view === choice}
              onClick={() => setView(choice)}
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
                onClick={() => void load(null, true)}
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
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void load(null, true)}
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
            {page.jobs.map((job) => {
              const workflowName =
                job.originSummary?.workflowName ??
                workflows.find((workflow) => workflow.workflowId === job.workflowId)?.definition
                  .name ??
                "Workflow run";
              const needsAttention =
                job.status === "awaiting_review" || job.status === "awaiting_input";
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
                    </div>
                    <p className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
                      {job.instruction}
                    </p>
                    {job.detail ? (
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
                      onClick={() =>
                        navigate({
                          to: "/workflows/$repositoryId/jobs/$jobId",
                          params: { repositoryId: scope.repositoryId, jobId: job.jobId },
                        })
                      }
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
