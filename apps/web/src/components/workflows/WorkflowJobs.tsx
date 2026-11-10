import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
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
    <section className="space-y-4" aria-label="Workflow runs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter runs">
          {(["active", "attention", "history"] as const).map((choice) => (
            <Button
              key={choice}
              variant={choice === view ? "secondary" : "ghost"}
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
                variant="outline"
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
      <p className="text-xs text-muted-foreground">
        {view === "history"
          ? "Completed runs, newest first."
          : view === "attention"
            ? "Runs needing attention, oldest first."
            : "Active runs, oldest first. Load more to see further runs."}
      </p>
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
      {page.jobs?.map((job) => (
        <div key={job.jobId} className="flex flex-wrap items-center gap-4 border-b py-4">
          <div className="min-w-0 flex-1 basis-48">
            <p className="truncate font-medium">{job.instruction}</p>
            <p className="text-xs text-muted-foreground">
              {job.originSummary?.workflowName ??
                workflows.find((workflow) => workflow.workflowId === job.workflowId)?.definition
                  .name ??
                "Workflow run"}
            </p>
            {job.originSummary?.kind === "automation" ? (
              <p className="text-xs text-muted-foreground">Started by workflow</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <time dateTime={job.createdAt}>
                Submitted {formatRelativeTimeLabel(job.createdAt)}
              </time>
            </p>
            {job.detail ? <p className="text-xs text-muted-foreground">{job.detail}</p> : null}
          </div>
          <span className="text-xs font-medium">{workflowStatusLabel(job.status)}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Open run: ${job.instruction}`}
                  onClick={() =>
                    navigate({
                      to: "/workflows/$repositoryId/jobs/$jobId",
                      params: { repositoryId: scope.repositoryId, jobId: job.jobId },
                    })
                  }
                />
              }
            >
              <ChevronRightIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Open run</TooltipPopup>
          </Tooltip>
        </div>
      ))}
      {page.nextCursor ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(page.nextCursor)}>
          {busy ? "Loading…" : "Load more runs"}
        </Button>
      ) : null}
    </section>
  );
}
