import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { RepositoryWorkflow, WorkflowJobListView } from "@t3tools/contracts/workflows";
import {
  workflowJobPageAccessLost,
  emptyWorkflowJobPageRead,
  beginWorkflowJobPage,
  settleWorkflowJobPage,
  workflowSessionKey,
  workflowStatusLabel,
  type WorkflowScope,
  type WorkflowJobPageRequest,
} from "@t3tools/client-runtime/relay/workflow-session";
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
  const key = workflowSessionKey(scope, `runs:${view}`);
  const load = useCallback(
    async (cursor: string | null = null, refreshMetadata = false) => {
      const request = { key, cursor };
      current.current = request;
      setRead((previous) => beginWorkflowJobPage(previous, request));
      try {
        const [page] = await Promise.all([
          call((client, clerkToken) =>
            client.pageWorkflowJobs({
              clerkToken,
              repositoryId: scope.repositoryId,
              query: { view, ...(cursor ? { cursor } : {}) },
            }),
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
              workflowJobPageAccessLost(cause),
            ),
          );
      }
    },
    [call, key, scope.repositoryId, view, refreshWorkflows],
  );
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect starts the external relay read for the selected repository and view.
    void load();
    return () => {
      current.current = null;
    };
  }, [load]);
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
        <Button variant="outline" disabled={busy} onClick={() => void load(null, true)}>
          Refresh runs
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {view === "history"
          ? "Completed runs, newest first."
          : "Active runs, oldest first. Load more to see further runs."}
      </p>
      {page.error ? (
        <p role="alert" className="text-sm text-destructive">
          {page.error}
          {page.jobs ? " Showing the last available runs. Refresh to retry." : ""}
        </p>
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
        <div key={job.jobId} className="flex items-center justify-between gap-4 border-b py-4">
          <div className="min-w-0">
            <p className="truncate font-medium">{job.instruction}</p>
            <p className="text-xs text-muted-foreground">
              {job.originSummary?.workflowName ??
                workflows.find((workflow) => workflow.workflowId === job.workflowId)?.definition
                  .name ??
                "Workflow run"}{" "}
              · {workflowStatusLabel(job.status)}
            </p>
            {job.originSummary?.kind === "automation" ? (
              <p className="text-xs text-muted-foreground">
                Started by workflow
                {job.originSummary.workflowName ? ` · ${job.originSummary.workflowName}` : ""}
              </p>
            ) : null}
            {job.detail ? <p className="text-xs text-muted-foreground">{job.detail}</p> : null}
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              navigate({
                to: "/workflows/$repositoryId/jobs/$jobId",
                params: { repositoryId: scope.repositoryId, jobId: job.jobId },
              })
            }
          >
            View
          </Button>
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
