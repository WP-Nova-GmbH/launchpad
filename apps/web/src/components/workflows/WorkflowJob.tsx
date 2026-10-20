import { WorkflowIssueDetails } from "./WorkflowIssueDetails";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  workflowManualControlState,
  workflowActionState,
  workflowManualSubmission,
} from "@t3tools/client-runtime/relay/workflow-responses";
import {
  workflowDraftAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  recordWorkflowResponse,
  settleWorkflowJobRequest,
  invalidateWorkflowJobRead,
  emptyWorkflowJobRead,
  workflowStatusLabel,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { isTerminalWorkflowJob, type WorkflowControl } from "@t3tools/contracts/workflows";
import { TurnId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { WorkflowFlow } from "./WorkflowFlow";
import {
  useWorkflowClient,
  useWorkflowDrafts,
  useWorkflowJobReads,
  workflowError,
  confirmWorkflow,
} from "./workflowState";

type Operation = Exclude<WorkflowControl["operation"], "start" | "status">;

export function WorkflowJob({
  scope,
  jobId,
  projects,
  canConfigure,
}: {
  scope: WorkflowScope;
  jobId: string;
  projects: ReadonlyArray<RelayOrganizationProject>;
  canConfigure: boolean;
}) {
  const navigate = useNavigate();
  const call = useWorkflowClient(scope);
  const reads = useWorkflowJobReads();
  const drafts = useWorkflowDrafts();
  const key = workflowSessionKey(scope, jobId);
  const read = reads.jobs[key] ?? emptyWorkflowJobRead;
  const selectedJob = read.job;
  const manualState = workflowManualControlState(selectedJob);
  const actionState = workflowActionState(selectedJob);
  const detail = selectedJob?.detail ?? selectedJob?.progress?.detail ?? actionState.action?.detail;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const checkpoint = selectedJob?.progress?.checkpoint;
  const responseDrafts = drafts.responses[key] ?? {};
  const response = checkpoint ? (responseDrafts[checkpoint.checkpointId] ?? "") : "";
  const busy = !!read.mutation;
  const terminal = !!selectedJob && isTerminalWorkflowJob(selectedJob.status);
  const allowed = canConfigure || checkpoint?.role === "member";
  const refresh = useCallback(async () => {
    const request = beginWorkflowJobRequest(appAtomRegistry, scope, jobId);
    if (!request) return;
    try {
      settleWorkflowJobRequest(
        appAtomRegistry,
        request,
        await call((client, token) =>
          client.getWorkflowJob({ clerkToken: token, repositoryId: scope.repositoryId, jobId }),
        ),
      );
    } catch (cause) {
      settleWorkflowJobRequest(appAtomRegistry, request, workflowError(cause));
    }
  }, [call, scope, jobId]);
  useEffect(() => {
    activateWorkflowJobView(appAtomRegistry, scope, jobId);
  }, [scope, jobId]);
  useEffect(() => {
    if (read.mutation) return;
    void refresh();
    if (terminal) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 5000);
    const focus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      invalidateWorkflowJobRead(appAtomRegistry, scope, jobId);
    };
  }, [refresh, terminal, read.mutation, scope, jobId]);
  const respond = async (operation: Operation) => {
    if (!selectedJob || busy || (manualState.responsePending && operation !== "cancel")) return;
    if (
      ["approve", "input", "request_changes"].includes(operation) &&
      (!selectedJob.progress?.checkpoint || isTerminalWorkflowJob(selectedJob.status))
    )
      return;
    const request = beginWorkflowJobRequest(appAtomRegistry, scope, jobId, randomUUID());
    if (!request) return;
    const current = appAtomRegistry.get(workflowDraftAtom);
    const checkpoint = selectedJob.progress?.checkpoint;
    let intent = current.manual[key];
    if (operation === "pause" || operation === "resume") {
      intent = workflowManualSubmission(intent ?? null, selectedJob, operation, randomUUID);
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        manual: { ...state.manual, [key]: intent! },
      }));
    }
    const payload =
      operation === "pause" || operation === "resume"
        ? intent!.control
        : operation === "input" || operation === "request_changes"
          ? {
              operation,
              checkpointId: checkpoint!.checkpointId,
              expectedRevision: selectedJob.progress!.revision,
              text: current.responses[key]?.[checkpoint!.checkpointId] ?? "",
            }
          : operation === "approve"
            ? {
                operation,
                checkpointId: checkpoint!.checkpointId,
                expectedRevision: selectedJob.progress!.revision,
              }
            : operation === "retry_action"
              ? {
                  operation,
                  actionId: actionState.action!.actionId,
                  expectedRevision: selectedJob.progress!.revision,
                }
              : operation === "retry_preparation" || operation === "retry_cancellation"
                ? { operation, expectedRevision: selectedJob.progress!.revision }
                : { operation };
    const submitted = {
      checkpointId: checkpoint?.checkpointId ?? null,
      operation,
      userId: scope.accountId,
      text: "text" in payload ? payload.text : null,
    };
    recordWorkflowResponse(appAtomRegistry, scope, jobId, submitted);
    try {
      const next = await call((client, token) =>
        client.respondToWorkflowJob({
          clerkToken: token,
          repositoryId: scope.repositoryId,
          jobId,
          payload,
        }),
      );
      settleWorkflowJobRequest(appAtomRegistry, request, next);
    } catch (cause) {
      settleWorkflowJobRequest(appAtomRegistry, request, workflowError(cause));
    }
  };
  const inspect = (diff: boolean) => {
    if (!selectedJob?.progress || selectedJob.progress.hasThread === false) return;
    const params = {
      environmentId: selectedJob.environmentId,
      threadId: selectedJob.progress.threadId,
    };
    if (diff && checkpoint && checkpoint.kind !== "input") {
      useDiffPanelStore.getState().selectTurn(params, TurnId.make(checkpoint.turnId));
      useRightPanelStore.getState().open(params, "diff");
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params,
      state: (previous) => ({
        ...previous,
        workflowOrigin: { ...scope, jobId, environmentId: selectedJob.environmentId },
      }),
    });
  };
  const setResponse = (text: string) => {
    if (!checkpoint) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      responses: {
        ...state.responses,
        [key]: { ...state.responses[key], [checkpoint.checkpointId]: text },
      },
    }));
  };
  if (!selectedJob)
    return (
      <div className="space-y-3">
        <p>{read.error ?? "Loading run…"}</p>
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
    );
  const target = projects.find(
    (project) =>
      project.environmentId === selectedJob.environmentId &&
      (!selectedJob.workflow || project.projectId === selectedJob.workflow.definition.projectId),
  );
  const checkpointStep = selectedJob.workflow?.definition.steps.find(
    (step) => step.id === (checkpoint?.stepId ?? selectedJob.progress?.stepId),
  );
  const waiting =
    !terminal &&
    !!checkpoint &&
    (manualState.status === "awaiting_input" || manualState.status === "awaiting_review");
  const input = checkpoint?.kind === "input";
  const approval =
    !terminal &&
    !!checkpoint &&
    allowed &&
    (manualState.status === "awaiting_review" ||
      (canConfigure &&
        selectedJob.status === "finishing" &&
        selectedJob.progress?.retryableApproval));
  const oldDrafts = Object.entries(responseDrafts).filter(
    ([id, text]) =>
      (!waiting ||
        !allowed ||
        selectedJob.progress?.approvalPending ||
        id !== checkpoint?.checkpointId) &&
      !!text.trim(),
  );
  return (
    <div className="min-w-0 space-y-6 wrap-anywhere">
      <header>
        <h1 className="text-xl font-semibold">
          {selectedJob.workflow?.definition.name ?? "Workflow run"}
        </h1>
        <WorkflowIssueDetails key={key} job={selectedJob} />
        {selectedJob.origin?.kind === "automation" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Started by workflow
            {selectedJob.workflow ? ` · ${selectedJob.workflow.definition.name}` : ""}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {workflowStatusLabel(selectedJob.status)} ·{" "}
          {target
            ? target.machineLabel + (selectedJob.workflow ? " · " + target.title : "")
            : "Organization execution target"}
        </p>
      </header>
      {read.error ? (
        <p role="alert" className="text-sm text-destructive">
          {read.error} Showing the last acknowledged state.
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-5">
          <section className="space-y-4 rounded-lg border p-5" aria-label="Current workflow task">
            <div>
              <p className="text-xs text-muted-foreground">
                {waiting ? (input ? "Human input" : "Human review") : "Current task"}
              </p>
              <h2 className="mt-1 text-lg font-medium">
                {terminal
                  ? workflowStatusLabel(selectedJob.status)
                  : (checkpointStep?.title ??
                    workflowStatusLabel(manualState.status ?? selectedJob.status))}
              </h2>
            </div>
            {manualState.message ? (
              <p className="text-sm text-warning">{manualState.message}</p>
            ) : null}
            {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
            {selectedJob.progress && selectedJob.progress.hasThread !== false ? (
              <div className="flex flex-wrap gap-2">
                {checkpoint && checkpoint.kind !== "input" ? (
                  <Button variant="outline" onClick={() => inspect(true)}>
                    Inspect saved diff
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => inspect(false)}>
                  Open conversation
                </Button>
              </div>
            ) : null}
            {approval ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy || manualState.checkpointBlocked || selectedJob.progress?.approvalPending
                  }
                  onClick={() => void respond("approve")}
                >
                  {manualState.responsePending
                    ? "Response pending"
                    : selectedJob.progress?.approvalPending
                      ? "Approval pending"
                      : selectedJob.progress?.retryableApproval
                        ? selectedJob.status === "finishing"
                          ? "Retry completion"
                          : "Retry approval"
                        : "Approve result"}
                </Button>
                {waiting && !selectedJob.progress?.approvalPending ? (
                  <Button
                    variant="outline"
                    disabled={busy || manualState.checkpointBlocked}
                    onClick={() => setFeedbackOpen(true)}
                  >
                    Request changes
                  </Button>
                ) : null}
              </div>
            ) : null}
            {waiting &&
            checkpoint &&
            allowed &&
            !selectedJob.progress?.approvalPending &&
            (input || feedbackOpen || !!response) ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void respond(input ? "input" : "request_changes");
                }}
              >
                <label className="block space-y-2">
                  <span className="text-sm font-medium">
                    {input ? checkpoint.question : "Feedback for the agent"}
                  </span>
                  <Textarea
                    aria-label={input ? "Checkpoint answer" : "Rework feedback"}
                    rows={5}
                    maxLength={8000}
                    value={response}
                    onChange={(event) => setResponse(event.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Draft retained until the environment acknowledges it.
                </p>
                <Button
                  type="submit"
                  disabled={busy || manualState.checkpointBlocked || !response.trim()}
                >
                  {manualState.responsePending
                    ? "Response pending"
                    : input
                      ? "Submit answer"
                      : "Send requested changes"}
                </Button>
              </form>
            ) : waiting && !allowed ? (
              <p className="text-sm text-muted-foreground">
                This checkpoint requires a repository maintainer.
              </p>
            ) : null}
            {canConfigure &&
            manualState.status === "paused" &&
            selectedJob.progress?.retryablePreparation ? (
              <Button
                variant="outline"
                disabled={busy || manualState.checkpointBlocked}
                onClick={() => void respond("retry_preparation")}
              >
                Retry preparation
              </Button>
            ) : null}
          </section>
          {oldDrafts.length ? (
            <details className="space-y-3 rounded-lg border p-4">
              <summary className="cursor-pointer text-sm">Retained checkpoint drafts</summary>
              {oldDrafts.map(([id, text]) => (
                <div key={id} className="space-y-2">
                  <Textarea readOnly aria-label="Previous checkpoint draft" value={text} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (
                        !(await confirmWorkflow(
                          "Discard this draft? This removes the unsent response.",
                        ))
                      )
                        return;
                      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
                        const previous = { ...state.responses[key] };
                        delete previous[id];
                        return { ...state, responses: { ...state.responses, [key]: previous } };
                      });
                    }}
                  >
                    Discard previous draft
                  </Button>
                </div>
              ))}
            </details>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canConfigure && actionState.canRetry ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void respond("retry_action")}
              >
                Retry publishing action
              </Button>
            ) : null}
            {selectedJob.progress?.pullRequestUrl ? (
              <a href={selectedJob.progress.pullRequestUrl} target="_blank" rel="noreferrer">
                Open pull request
              </a>
            ) : null}
            {canConfigure && (manualState.canPause || manualState.canResume) ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void respond(manualState.canResume ? "resume" : "pause")}
              >
                {manualState.canResume ? "Resume workflow" : "Pause workflow"}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={read.reading} onClick={() => void refresh()}>
              Refresh
            </Button>
            {canConfigure && !isTerminalWorkflowJob(selectedJob.status) ? (
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  More controls
                </summary>
                <div className="mt-2">
                  <Button
                    variant="destructive-outline"
                    disabled={
                      busy ||
                      (selectedJob.status === "cancelling" &&
                        (manualState.responsePending ||
                          !selectedJob.progress?.retryableCancellation))
                    }
                    onClick={async () => {
                      if (selectedJob.status === "cancelling") void respond("retry_cancellation");
                      else if (
                        await confirmWorkflow(
                          `Cancel this run: ${selectedJob.issueSnapshot?.identifier ?? selectedJob.event?.identifier ?? selectedJob.instruction.slice(0, 140)}?`,
                        )
                      )
                        void respond("cancel");
                    }}
                  >
                    {selectedJob.status === "cancelling"
                      ? selectedJob.progress?.retryableCancellation && !manualState.responsePending
                        ? "Retry cancellation"
                        : "Cancellation pending"
                      : "Cancel run"}
                  </Button>
                </div>
              </details>
            ) : null}
          </div>
          {selectedJob.progress?.responses?.length ? (
            <details className="border-t pt-4">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Checkpoint history
              </summary>
              <ol className="mt-3 space-y-3">
                {selectedJob.progress.responses.map((response) => (
                  <li
                    key={`${response.checkpointId}:${response.operation}`}
                    className="space-y-1 text-sm"
                  >
                    <p>
                      {selectedJob.workflow?.definition.steps.find(
                        (step) => step.id === response.stepId,
                      )?.title ?? "Checkpoint"}{" "}
                      · {response.operation.replaceAll("_", " ")} · attempt{" "}
                      {response.generation + 1}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {response.userId} · {new Date(response.createdAt).toLocaleString()}
                    </p>
                    {response.text ? <p className="whitespace-pre-wrap">{response.text}</p> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
        <aside
          aria-label="Run progress"
          className="min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5"
        >
          <h2 className="mb-3 text-sm font-medium">Progress</h2>
          {selectedJob.workflow ? (
            <WorkflowFlow definition={selectedJob.workflow.definition} job={selectedJob} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Steps are fixed when this run is offered to the environment.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
