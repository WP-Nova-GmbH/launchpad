import { CloudIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowIssueDetails } from "./WorkflowIssueDetails";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { useCallback, useEffect, useState, useRef, useLayoutEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomCommand } from "../../state/use-atom-command";
import { openPortableThreadChat } from "../../state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  workflowManualControlState,
  workflowActionState,
  workflowManualSubmission,
  workflowViewerControls,
  workflowApprovalPending,
} from "@t3tools/client-runtime/relay/workflow-responses";
import { workflowResultCheckpoint } from "@t3tools/client-runtime/relay/workflow-result";
import {
  workflowDraftAtom,
  workflowJobReadAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  recordWorkflowResponse,
  settleWorkflowJobRequest,
  invalidateWorkflowJobRead,
  emptyWorkflowJobRead,
  workflowStatusLabel,
  workflowJobAccessLost,
  beginWorkflowReview,
  bindWorkflowReviewPlacement,
  requireFreshWorkflowReviewRead,
  workflowReviewApprovalState,
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
  const openResult = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const [openingResult, setOpeningResult] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  const call = useWorkflowClient(scope);
  const reads = useWorkflowJobReads();
  const drafts = useWorkflowDrafts();
  const key = workflowSessionKey(scope, jobId);
  const resultRequest = useRef<{ key: string } | null>(null);
  useLayoutEffect(
    () => () => {
      setResultError(null);
      if (resultRequest.current?.key !== key) return;
      resultRequest.current = null;
      setOpeningResult(false);
    },
    [key],
  );
  const read = reads.jobs[key] ?? emptyWorkflowJobRead;
  const selectedJob = read.job;
  const manualState = workflowManualControlState(selectedJob);
  const actionState = workflowActionState(selectedJob);
  const detail = selectedJob?.detail ?? selectedJob?.progress?.detail ?? actionState.action?.detail;
  const [feedbackView, setFeedbackView] = useState<{ key: string; open: boolean } | null>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const feedbackFocus = useRef<"input" | "button" | null>(null);
  const checkpoint = selectedJob?.progress?.checkpoint;
  const reviewApproval = workflowReviewApprovalState(drafts.reviews[key], read);
  const reviewChanged = reviewApproval === "inspect";
  const checkingReturnedReview = reviewApproval === "checking";
  const viewerControls = workflowViewerControls(selectedJob, canConfigure);
  const approvalPending = workflowApprovalPending(selectedJob);
  const responseDrafts = drafts.responses[key] ?? {};
  const response = checkpoint ? (responseDrafts[checkpoint.checkpointId] ?? "") : "";
  const feedbackKey = `${key}:${checkpoint?.checkpointId ?? ""}`;
  const feedbackOpen = feedbackView?.key === feedbackKey ? feedbackView.open : !!response;
  const waiting =
    !!checkpoint &&
    !!selectedJob &&
    !isTerminalWorkflowJob(selectedJob.status) &&
    (manualState.status === "awaiting_input" || manualState.status === "awaiting_review");
  const input = checkpoint?.kind === "input";
  const composingFeedback =
    waiting && !input && feedbackOpen && viewerControls.canRespond && !approvalPending;
  useLayoutEffect(() => {
    if (feedbackFocus.current === "input") feedbackInput.current?.focus();
    if (feedbackFocus.current === "button") feedbackButton.current?.focus();
    feedbackFocus.current = null;
  });
  const busy = !!read.mutation;
  const terminal = !!selectedJob && isTerminalWorkflowJob(selectedJob.status);
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
      settleWorkflowJobRequest(
        appAtomRegistry,
        request,
        workflowError(cause),
        workflowJobAccessLost(cause),
      );
    }
  }, [call, scope, jobId]);
  useLayoutEffect(() => {
    activateWorkflowJobView(appAtomRegistry, scope, jobId);
    requireFreshWorkflowReviewRead(appAtomRegistry, scope, jobId);
  }, [scope, jobId]);
  useEffect(() => {
    if (read.mutation) return;
    void refresh();
    if (terminal) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 5000);
    const focus = () => {
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, jobId);
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
    const currentRead = appAtomRegistry.get(workflowJobReadAtom).jobs[key] ?? emptyWorkflowJobRead;
    const currentReview = appAtomRegistry.get(workflowDraftAtom).reviews[key];
    if (
      (operation === "approve" &&
        (!viewerControls.canApprove ||
          currentRead.job !== selectedJob ||
          workflowReviewApprovalState(currentReview, currentRead) !== "allowed")) ||
      ((operation === "input" || operation === "request_changes") && !viewerControls.canRespond) ||
      ((operation === "cancel" || operation === "retry_cancellation") && !viewerControls.canCancel)
    )
      return;
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
  const inspect = async (diff: boolean) => {
    if (
      !selectedJob?.progress ||
      selectedJob.progress.hasThread === false ||
      resultRequest.current ||
      (diff && checkingReturnedReview)
    )
      return;
    const session = appAtomRegistry.get(managedRelaySessionAtom);
    const request = { key };
    resultRequest.current = request;
    const owns = () =>
      resultRequest.current === request && appAtomRegistry.get(managedRelaySessionAtom) === session;
    setOpeningResult(true);
    setResultError(null);
    try {
      const runtime = selectedJob.runtime;
      if (!runtime) throw new Error("This run has no available execution binding.");
      const exactReview =
        diff && runtime.kind === "vm" ? workflowResultCheckpoint(checkpoint) : undefined;
      const reviewVisitId = exactReview ? randomUUID() : undefined;
      if (exactReview && reviewVisitId)
        beginWorkflowReview(appAtomRegistry, scope, jobId, reviewVisitId, exactReview);
      const result = await openResult({
        threadId: selectedJob.progress.threadId,
        title: selectedJob.workflow?.definition.name ?? "Workflow result",
        workflowResult:
          runtime.kind === "vm"
            ? { ...scope, jobId }
            : { ...scope, originalEnvironmentId: runtime.environmentId },
      });
      if (!owns()) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const { environmentId, threadId, workflowVmGeneration } = result.value;
      const params = { environmentId, threadId };
      if (reviewVisitId && workflowVmGeneration !== undefined)
        bindWorkflowReviewPlacement(appAtomRegistry, scope, jobId, reviewVisitId, {
          ...params,
          generation: workflowVmGeneration,
        });
      if (diff && checkpoint && checkpoint.kind !== "input") {
        const panel = useDiffPanelStore.getState();
        if (exactReview)
          panel.selectTurn(
            params,
            TurnId.make(checkpoint.turnId),
            undefined,
            exactReview.checkpointTurnCount,
          );
        else panel.selectTurn(params, TurnId.make(checkpoint.turnId));
        useRightPanelStore.getState().open(params, "diff");
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params,
        state: (previous) => ({
          ...previous,
          workflowOrigin: {
            ...scope,
            jobId,
            threadId: params.threadId,
            ...(workflowVmGeneration !== undefined ? { workflowVmResultReader: true } : {}),
            ...(exactReview && reviewVisitId
              ? { reviewCheckpoint: exactReview, reviewVisitId }
              : {}),
          },
        }),
      });
    } catch (cause) {
      if (owns()) setResultError(workflowError(cause));
    } finally {
      if (resultRequest.current === request) {
        resultRequest.current = null;
        setOpeningResult(false);
      }
    }
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
    return read.error ? (
      <WorkflowAlert
        title="Could not load this run"
        actions={
          <>
            <Button variant="outline" disabled={read.reading} onClick={() => void refresh()}>
              Refresh
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                navigate({
                  to: "/workflows/$repositoryId",
                  params: { repositoryId: scope.repositoryId },
                  search: { tab: "runs" },
                })
              }
            >
              Back to runs
            </Button>
          </>
        }
      >
        {read.error}
      </WorkflowAlert>
    ) : (
      <p role="status">Loading run…</p>
    );
  const machine = selectedJob.runtime?.kind === "machine" ? selectedJob.runtime : null;
  const target = projects.find(
    (project) =>
      project.environmentId === machine?.environmentId && project.projectId === machine?.projectId,
  );
  const checkpointStep = selectedJob.workflow?.definition.steps.find(
    (step) => step.id === (checkpoint?.stepId ?? selectedJob.progress?.stepId),
  );
  const stepRepeatsWorkflowName =
    !!checkpointStep && checkpointStep.title === selectedJob.workflow?.definition.name;
  const approval =
    !terminal &&
    !!checkpoint &&
    viewerControls.canApprove &&
    (manualState.status === "awaiting_review" ||
      (canConfigure &&
        selectedJob.status === "finishing" &&
        selectedJob.progress?.retryableApproval));
  const oldDrafts = Object.entries(responseDrafts).filter(
    ([id, text]) =>
      (!waiting ||
        !viewerControls.canRespond ||
        approvalPending ||
        id !== checkpoint?.checkpointId) &&
      !!text.trim(),
  );
  const stepIndex =
    selectedJob.workflow?.definition.steps.findIndex((step) => step.id === checkpointStep?.id) ??
    -1;
  const nextStep =
    stepIndex >= 0 ? selectedJob.workflow?.definition.steps[stepIndex + 1] : undefined;
  const completed = selectedJob.status === "done";
  const confirmationPending =
    approvalPending || manualState.responsePending || !!selectedJob.pendingManualControl;
  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl space-y-6 wrap-anywhere">
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold">
            {selectedJob.workflow?.definition.name ?? "Workflow run"}
          </h1>
          <span role="status" className="text-sm font-medium">
            {workflowStatusLabel(selectedJob.status)}
          </span>
        </div>
        <WorkflowIssueDetails key={key} job={selectedJob} />
        {selectedJob.origin?.kind === "automation" ? (
          <p className="mt-1 text-xs text-muted-foreground">Started by workflow</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            {!target && (selectedJob.vmAdmission || selectedJob.runtime?.kind === "vm") ? (
              <CloudIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span>
              {target
                ? target.machineLabel + (selectedJob.workflow ? " / " + target.title : "")
                : selectedJob.vmAdmission || selectedJob.runtime?.kind === "vm"
                  ? "Workflow VM"
                  : "Organization execution target"}
            </span>
          </span>
          <Tooltip>
            <TooltipTrigger render={<time dateTime={selectedJob.createdAt} />}>
              Submitted {formatRelativeTimeLabel(selectedJob.createdAt)}
            </TooltipTrigger>
            <TooltipPopup>{new Date(selectedJob.createdAt).toLocaleString()}</TooltipPopup>
          </Tooltip>
        </div>
      </header>
      {read.error ? (
        <WorkflowAlert
          title="Could not refresh this run"
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={read.reading}
              onClick={() => void refresh()}
            >
              Retry refresh
            </Button>
          }
        >
          {read.error} Showing the last acknowledged state.
        </WorkflowAlert>
      ) : null}
      <div className="min-w-0 space-y-5">
        <section className="space-y-4 border-t pt-5" aria-label="Current workflow task">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!terminal && stepIndex >= 0 ? (
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">
                  Step {stepIndex + 1} of {selectedJob.workflow!.definition.steps.length}
                </p>
                {composingFeedback && checkpointStep && !stepRepeatsWorkflowName ? (
                  <p className="text-sm text-muted-foreground">{checkpointStep.title}</p>
                ) : null}
              </div>
            ) : (
              <span />
            )}
            <div className="ml-auto">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh run"
                      disabled={read.reading}
                      onClick={() => void refresh()}
                    />
                  }
                >
                  <RefreshCwIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup>Refresh run</TooltipPopup>
              </Tooltip>
            </div>
          </div>
          {!stepRepeatsWorkflowName || composingFeedback || terminal ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">
                {composingFeedback
                  ? "Request changes"
                  : terminal
                    ? completed
                      ? "Workflow completed"
                      : workflowStatusLabel(selectedJob.status)
                    : selectedJob.status === "queued"
                      ? "Waiting for execution"
                      : (checkpointStep?.title ??
                        workflowStatusLabel(manualState.status ?? selectedJob.status))}
              </h2>
              {composingFeedback ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    feedbackFocus.current = "button";
                    setFeedbackView({ key: feedbackKey, open: false });
                  }}
                >
                  Back to review
                </Button>
              ) : null}
            </div>
          ) : null}
          {selectedJob.status === "queued" ? (
            <p className="text-sm text-muted-foreground">
              Waiting for an execution target. No steps have started.
            </p>
          ) : null}
          {manualState.message ? (
            <WorkflowAlert
              title={confirmationPending ? "Waiting for confirmation" : "Run needs attention"}
              variant={confirmationPending ? "info" : "warning"}
            >
              {manualState.message}
            </WorkflowAlert>
          ) : null}
          {selectedJob.status === "failed" ? (
            <WorkflowAlert
              title="Run failed"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    navigate({
                      to: "/workflows/$repositoryId",
                      params: { repositoryId: scope.repositoryId },
                      search: { tab: "runs" },
                    })
                  }
                >
                  Back to runs
                </Button>
              }
            >
              {detail ??
                "This run stopped before completing. Open its conversation to review the result."}
            </WorkflowAlert>
          ) : detail ? (
            <p className="text-sm text-muted-foreground">{detail}</p>
          ) : null}
          {reviewChanged || (checkingReturnedReview && !read.error) ? (
            <WorkflowAlert
              title={reviewChanged ? "Review changed" : "Checking the current review"}
              variant={reviewChanged ? "warning" : "info"}
            >
              {reviewChanged
                ? "Review changed. Inspect the current diff before approving."
                : "Checking the current review…"}
            </WorkflowAlert>
          ) : null}
          {waiting && !input && !composingFeedback && stepIndex >= 0 ? (
            <p className="text-sm text-muted-foreground">
              {nextStep
                ? `Approval continues to “${nextStep.title}”.`
                : "Approval completes this workflow."}
            </p>
          ) : null}
          {completed && selectedJob.progress?.pullRequestUrl ? (
            <Button
              render={
                <a href={selectedJob.progress.pullRequestUrl} target="_blank" rel="noreferrer" />
              }
            >
              Open pull request
            </Button>
          ) : null}

          {!composingFeedback &&
          selectedJob.progress &&
          selectedJob.progress.hasThread !== false ? (
            <div className="flex flex-wrap gap-2">
              {checkpoint && checkpoint.kind !== "input" ? (
                <Button
                  variant={
                    (waiting && !input) || (completed && !selectedJob.progress.pullRequestUrl)
                      ? "default"
                      : "outline"
                  }
                  disabled={openingResult || checkingReturnedReview}
                  onClick={() => void inspect(true)}
                >
                  {completed
                    ? "Inspect result"
                    : selectedJob.runtime?.kind === "vm"
                      ? "Inspect live diff"
                      : "Inspect saved diff"}
                </Button>
              ) : null}
              <Button
                variant={
                  completed &&
                  !selectedJob.progress.pullRequestUrl &&
                  (!checkpoint || checkpoint.kind === "input")
                    ? "default"
                    : "ghost"
                }
                disabled={openingResult}
                onClick={() => void inspect(false)}
              >
                Open conversation
              </Button>
            </div>
          ) : null}
          {resultError ? (
            <WorkflowAlert
              title="Could not open the result"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={openingResult}
                  onClick={() => void inspect(false)}
                >
                  Retry opening result
                </Button>
              }
            >
              {resultError} Retry opening the result.
            </WorkflowAlert>
          ) : null}
          {(approval || (waiting && !input && viewerControls.canRespond && !approvalPending)) &&
          !composingFeedback ? (
            <div className="flex flex-wrap gap-2">
              {approval ? (
                <Button
                  variant={
                    waiting &&
                    selectedJob.runtime?.kind !== "vm" &&
                    checkpoint?.kind !== "input" &&
                    selectedJob.progress?.hasThread !== false
                      ? "outline"
                      : "default"
                  }
                  disabled={
                    busy ||
                    reviewChanged ||
                    checkingReturnedReview ||
                    manualState.checkpointBlocked ||
                    approvalPending
                  }
                  onClick={() => void respond("approve")}
                >
                  {approvalPending
                    ? "Approval pending"
                    : manualState.responsePending
                      ? "Response pending"
                      : selectedJob.progress?.retryableApproval
                        ? selectedJob.status === "finishing"
                          ? "Retry completion"
                          : "Retry approval"
                        : "Approve result"}
                </Button>
              ) : null}
              {waiting && viewerControls.canRespond && !approvalPending ? (
                <Button
                  variant="outline"
                  disabled={busy || manualState.checkpointBlocked}
                  ref={feedbackButton}
                  onClick={() => {
                    feedbackFocus.current = "input";
                    setFeedbackView({ key: feedbackKey, open: true });
                  }}
                >
                  Request changes
                </Button>
              ) : null}
            </div>
          ) : null}
          {waiting &&
          checkpoint &&
          viewerControls.canRespond &&
          !approvalPending &&
          (input || feedbackOpen) ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void respond(input ? "input" : "request_changes");
              }}
            >
              <label className="block space-y-2">
                {input ? (
                  <span className="text-sm font-medium">{checkpoint.question}</span>
                ) : (
                  <span className="sr-only">Feedback for the agent</span>
                )}
                <Textarea
                  ref={feedbackInput}
                  aria-label={input ? "Checkpoint answer" : "Rework feedback"}
                  placeholder={input ? undefined : "Describe the changes…"}
                  rows={5}
                  maxLength={8000}
                  value={response}
                  onChange={(event) => setResponse(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Draft kept until acknowledged.</p>
                <div className="ml-auto">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || manualState.checkpointBlocked || !response.trim()}
                  >
                    {manualState.responsePending
                      ? "Response pending"
                      : input
                        ? "Submit answer"
                        : "Send changes"}
                  </Button>
                </div>
              </div>
            </form>
          ) : waiting && !viewerControls.canRespond && !viewerControls.canApprove ? (
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
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-medium">
                      {selectedJob.workflow?.definition.steps.find(
                        (step) => step.id === response.stepId,
                      )?.title ?? "Checkpoint"}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      Attempt {response.generation + 1}
                    </span>
                  </div>
                  <p>{response.operation.replaceAll("_", " ")}</p>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{response.userId}</span>
                    <time dateTime={response.createdAt}>
                      {new Date(response.createdAt).toLocaleString()}
                    </time>
                  </div>
                  {response.text ? <p className="whitespace-pre-wrap">{response.text}</p> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {selectedJob.workflow ? (
          <details className="border-t pt-4" aria-label="Run progress">
            <summary className="cursor-pointer text-sm font-medium">Workflow progress</summary>
            <div className="mt-4">
              <WorkflowFlow definition={selectedJob.workflow.definition} job={selectedJob} />
            </div>
          </details>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              navigate({
                to: "/workflows/$repositoryId",
                params: { repositoryId: scope.repositoryId },
                search: { tab: "runs" },
              })
            }
          >
            Back to runs
          </Button>
          {canConfigure && actionState.canRetry ? (
            <Button variant="outline" disabled={busy} onClick={() => void respond("retry_action")}>
              Retry publishing action
            </Button>
          ) : null}
          {!completed && selectedJob.progress?.pullRequestUrl ? (
            <a href={selectedJob.progress.pullRequestUrl} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          ) : null}
          {canConfigure && manualState.canResume ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void respond(manualState.canResume ? "resume" : "pause")}
            >
              Resume workflow
            </Button>
          ) : null}
          {(viewerControls.canCancel || (canConfigure && manualState.canPause)) && !terminal ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                More controls
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {canConfigure && manualState.canPause ? (
                  <Button variant="outline" disabled={busy} onClick={() => void respond("pause")}>
                    {["preparing", "running", "waiting_capacity"].includes(manualState.status ?? "")
                      ? "Pause after current step"
                      : "Pause workflow"}
                  </Button>
                ) : null}
                {viewerControls.canCancel ? (
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
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
