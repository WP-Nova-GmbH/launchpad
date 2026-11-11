import { SavedWorkflowResults } from "./SavedWorkflowResults";
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CloudIcon,
  MessageSquareIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { WorkflowIssueDetails } from "./WorkflowIssueDetails";
import {
  WorkflowCheckpointHistory,
  WorkflowUnsentDrafts,
  type RetainedCheckpointDraft,
} from "./WorkflowCheckpoints";
import { WorkflowQueuedTask, workflowQueuedTasks } from "./WorkflowQueuedTask";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { useCallback, useEffect, useState, useRef, useLayoutEffect, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomCommand } from "../../state/use-atom-command";
import { openPortableThreadChat } from "../../state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  clearAcknowledgedWorkflowDraft,
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
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { WorkflowProgress } from "./WorkflowProgress";
import {
  useWorkflowClient,
  useWorkflowDrafts,
  useWorkflowJobReads,
  workflowError,
  confirmWorkflow,
} from "./workflowState";

type Operation = Exclude<WorkflowControl["operation"], "start" | "status">;

/** Keep focus in the run when an update moves or removes the focused action. */
function useRunActionFocus<
  Action extends HTMLButtonElement | HTMLAnchorElement = HTMLButtonElement,
>(runKey: string, fallback?: RefObject<HTMLElement | null>) {
  const action = useRef<Action | null>(null);
  const focusedRun = useRef<string | null>(null);
  const registerAction = useCallback(
    (node: Action | null) => {
      const previous = action.current;
      if (!node && previous && previous.ownerDocument.activeElement === previous) {
        focusedRun.current = runKey;
      }
      action.current = node;
    },
    [runKey],
  );
  useLayoutEffect(() => {
    const target = action.current ?? fallback?.current;
    if (
      focusedRun.current === runKey &&
      target &&
      !("disabled" in target && target.disabled) &&
      target.ownerDocument.activeElement === target.ownerDocument.body
    ) {
      target.focus();
    }
    focusedRun.current = null;
  });
  return registerAction;
}

export function WorkflowJob({
  scope,
  jobId,
  projects,
  canConfigure,
  organizationAdmin,
  refreshCatalog,
}: {
  scope: WorkflowScope;
  jobId: string;
  projects: ReadonlyArray<RelayOrganizationProject>;
  canConfigure: boolean;
  organizationAdmin: boolean;
  refreshCatalog: () => void;
}) {
  const navigate = useNavigate();
  const openResult = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const [openingResult, setOpeningResult] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  const call = useWorkflowClient(scope);
  const reads = useWorkflowJobReads();
  const drafts = useWorkflowDrafts();
  const key = workflowSessionKey(scope, jobId);
  const conversationButton = useRunActionFocus(key);
  const resumeButton = useRunActionFocus(key);
  const runHeading = useRef<HTMLHeadingElement>(null);
  const retryPublishingButton = useRunActionFocus(key, runHeading);
  const queuedRecoveryLink = useRunActionFocus<HTMLAnchorElement>(key, runHeading);
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
  const [reviewingCurrentResult, setReviewingCurrentResult] = useState(true);
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
    if (terminal && selectedJob?.progress?.resultSaving?.state !== "saving") return;
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
  }, [refresh, terminal, selectedJob?.progress?.resultSaving?.state, read.mutation, scope, jobId]);
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
    if (
      operation === "retry_saving" &&
      (!canConfigure || !selectedJob.progress?.resultSaving?.retryable)
    )
      return;
    if (
      operation === "retry_action" &&
      (!canConfigure || !actionState.canRetry || currentRead.job !== selectedJob)
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
      operation === "retry_saving"
        ? {
            operation,
            publicationId: selectedJob.progress!.resultSaving!.publicationId,
            expectedRevision: selectedJob.progress!.revision,
          }
        : operation === "pause" || operation === "resume"
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
  const backToRuns = () =>
    navigate({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: "runs" },
    });
  const refreshRun = () => {
    refreshCatalog();
    void refresh();
  };
  const runNavigation = (
    <nav className="flex items-center justify-between gap-2" aria-label="Run navigation">
      <Button type="button" variant="ghost" size="sm" onClick={backToRuns}>
        <ArrowLeftIcon aria-hidden />
        Back to runs
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh run"
              disabled={read.reading || busy}
              onClick={refreshRun}
            />
          }
        >
          <RefreshCwIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup>Refresh run</TooltipPopup>
      </Tooltip>
    </nav>
  );
  if (!selectedJob)
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {runNavigation}
        {read.error ? (
          <WorkflowAlert
            title="Could not load this run"
            actions={
              <Button variant="outline" disabled={read.reading} onClick={refreshRun}>
                Retry refresh
              </Button>
            }
          >
            {read.error}
          </WorkflowAlert>
        ) : (
          <p role="status">Loading run…</p>
        )}
      </div>
    );
  const machine = selectedJob.runtime?.kind === "machine" ? selectedJob.runtime : null;
  const target = projects.find(
    (project) =>
      project.environmentId === machine?.environmentId && project.projectId === machine?.projectId,
  );
  const failed = selectedJob.status === "failed";
  const cancelledVm = selectedJob.status === "cancelled" && selectedJob.runtime?.kind === "vm";
  const stepId = failed
    ? selectedJob.progress?.stepId
    : (checkpoint?.stepId ?? selectedJob.progress?.stepId);
  const checkpointStep = selectedJob.workflow?.definition.steps.find((step) => step.id === stepId);
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
  const oldDrafts = Object.entries(responseDrafts)
    .filter(
      ([id, text]) =>
        (!waiting ||
          !viewerControls.canRespond ||
          approvalPending ||
          id !== checkpoint?.checkpointId) &&
        !!text.trim(),
    )
    .map(([id, text]) => ({
      id,
      text,
      deliveryUnconfirmed: drafts.submitted[key]?.[id]?.text === text,
    }));
  const changeRetainedDraft = (draft: RetainedCheckpointDraft, restore: boolean) => {
    const currentReads = appAtomRegistry.get(workflowJobReadAtom);
    const currentJob = currentReads.jobs[key]?.job;
    if (currentReads.activeKey !== key || !currentJob) return false;

    let changed = false;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.responses[key] ?? {};
      const existing = current[draft.id];
      if (restore ? existing !== undefined : existing !== draft.text) return state;

      const next = { ...current };
      if (restore) {
        next[draft.id] = draft.text;
        const submission = state.submitted[key]?.[draft.id];
        if (
          submission &&
          clearAcknowledgedWorkflowDraft(next, submission, currentJob.progress) !== next
        )
          return state;
      } else {
        delete next[draft.id];
      }
      changed = true;
      return { ...state, responses: { ...state.responses, [key]: next } };
    });
    return changed;
  };
  const stepIndex =
    selectedJob.workflow?.definition.steps.findIndex((step) => step.id === checkpointStep?.id) ??
    -1;
  const nextStep =
    stepIndex >= 0 ? selectedJob.workflow?.definition.steps[stepIndex + 1] : undefined;
  const completed = selectedJob.status === "done";
  const confirmationPending =
    approvalPending || manualState.responsePending || !!selectedJob.pendingManualControl;
  const running = selectedJob.status === "running";
  const needsInput = selectedJob.status === "awaiting_input";
  const paused = selectedJob.status === "paused";
  const action = actionState.action;
  const publishingFailure =
    paused &&
    action &&
    (actionState.canRetry || action.state === "failed" || action.state === "uncertain")
      ? action
      : null;
  const publishingStep = publishingFailure?.operation === "push" ? "Push branch" : "Open PR";
  const publishingTitle =
    publishingFailure?.operation === "push"
      ? publishingFailure.state === "uncertain"
        ? "Couldn’t confirm the branch push"
        : "Couldn’t push branch"
      : publishingFailure?.state === "uncertain"
        ? "Couldn’t confirm the pull request"
        : "Couldn’t open pull request";
  const canRetryPublishing = canConfigure && actionState.canRetry;
  const StatusIcon = running
    ? ActivityIcon
    : needsInput
      ? MessageSquareIcon
      : paused && !publishingFailure
        ? PauseIcon
        : null;
  const manualHold = paused && selectedJob.progress?.manualPause?.state === "paused";
  const pausedBeforeStep = manualHold && manualState.status === "waiting_capacity" && !checkpoint;
  const showPauseDetail = manualHold && !confirmationPending;
  const statusLabel = workflowStatusLabel(selectedJob.status);
  const queueReason = selectedJob.queueReason?.code;
  const queueReasonTask =
    queueReason &&
    (selectedJob.status === "queued" ||
      (selectedJob.status === "preparing" && queueReason === "source_reconnect"))
      ? workflowQueuedTasks[queueReason]
      : undefined;
  // The dispatcher can update the detail after a failed retry while retaining the queue reason.
  const queuedTask =
    queueReasonTask && (!detail || queueReasonTask.relayDetails.includes(detail))
      ? queueReasonTask
      : undefined;
  const taskTitle = composingFeedback
    ? "Request changes"
    : terminal
      ? completed
        ? "Workflow completed"
        : statusLabel
      : selectedJob.status === "queued"
        ? "Waiting for execution"
        : stepRepeatsWorkflowName
          ? null
          : (checkpointStep?.title ??
            (StatusIcon ? null : workflowStatusLabel(manualState.status ?? selectedJob.status)));
  const conversationInTask = running && !checkpoint;
  const inputInTask = !!StatusIcon && input;
  const resumeAction =
    canConfigure && manualState.canResume ? (
      <Button
        type="button"
        ref={resumeButton}
        variant={paused ? "default" : "outline"}
        disabled={busy}
        onClick={() => void respond("resume")}
      >
        <PlayIcon aria-hidden />
        Resume workflow
      </Button>
    ) : null;
  const conversationActions =
    !composingFeedback &&
    selectedJob.runtime?.kind === "machine" &&
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
            {completed ? "Inspect result" : "Inspect saved diff"}
          </Button>
        ) : null}
        <Button
          ref={conversationButton}
          variant={
            failed ||
            (completed &&
              !selectedJob.progress.pullRequestUrl &&
              (!checkpoint || checkpoint.kind === "input"))
              ? "default"
              : conversationInTask
                ? "outline"
                : "ghost"
          }
          disabled={openingResult}
          onClick={() => void inspect(false)}
        >
          Open conversation
          {conversationInTask || failed ? <ArrowUpRightIcon aria-hidden /> : null}
        </Button>
      </div>
    ) : null;
  const checkpointResponse =
    waiting &&
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
            rows={input ? 3 : 5}
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
    ) : null;
  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl space-y-6 wrap-anywhere">
      {runNavigation}
      <header>
        <span role="status" className="sr-only">
          {queuedTask ? `${statusLabel}. ${queuedTask.title}` : statusLabel}
        </span>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 ref={runHeading} tabIndex={-1} className="text-xl font-semibold">
            {selectedJob.workflow?.definition.name ?? "Workflow run"}
          </h1>
          {!StatusIcon ? (
            <span aria-hidden className="text-sm font-medium">
              {statusLabel}
            </span>
          ) : null}
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
            <Button variant="outline" size="sm" disabled={read.reading} onClick={refreshRun}>
              Retry refresh
            </Button>
          }
        >
          {read.error} Showing the last acknowledged state.
        </WorkflowAlert>
      ) : null}
      <div className="min-w-0 space-y-5">
        <section className="space-y-4" aria-label="Current workflow task">
          {queuedTask ? (
            <WorkflowQueuedTask
              task={queuedTask}
              organizationAdmin={organizationAdmin}
              recoveryLinkRef={queuedRecoveryLink}
            />
          ) : failed ? (
            <WorkflowOutcome
              title={checkpointStep ? `${checkpointStep.title} failed` : "Run failed"}
              tone="error"
              actions={conversationActions}
            >
              <p>{detail ?? "This run stopped before completing."}</p>
            </WorkflowOutcome>
          ) : publishingFailure ? (
            <WorkflowOutcome
              title={publishingTitle}
              tone="warning"
              actions={
                <>
                  {canRetryPublishing ? (
                    <Button
                      ref={retryPublishingButton}
                      disabled={busy}
                      onClick={() => void respond("retry_action")}
                    >
                      <RotateCwIcon aria-hidden />
                      Retry publishing action
                    </Button>
                  ) : (
                    resumeAction
                  )}
                  {conversationActions}
                </>
              }
            >
              {detail ? <p>{detail}</p> : null}
              {canRetryPublishing ? <p>Retry starts at {publishingStep}.</p> : null}
            </WorkflowOutcome>
          ) : cancelledVm ? null : (
            <div
              className={
                StatusIcon
                  ? "space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
                  : "space-y-3 border-t pt-5"
              }
            >
              {StatusIcon || (!terminal && stepIndex >= 0) ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {StatusIcon ? (
                    <span
                      aria-hidden
                      className={cn(
                        "inline-flex items-center gap-2 text-sm font-medium",
                        needsInput && "text-warning-foreground",
                        running && "text-info-foreground",
                      )}
                    >
                      <StatusIcon aria-hidden className="size-4" />
                      {statusLabel}
                    </span>
                  ) : null}
                  {!terminal && stepIndex >= 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {pausedBeforeStep ? "Next step" : "Step"} {stepIndex + 1} of{" "}
                      {selectedJob.workflow!.definition.steps.length}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {composingFeedback && checkpointStep && !stepRepeatsWorkflowName ? (
                <p className="text-sm text-muted-foreground">{checkpointStep.title}</p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  {taskTitle ? (
                    <h2 className={StatusIcon ? "text-base font-semibold" : "text-sm font-medium"}>
                      {taskTitle}
                    </h2>
                  ) : null}
                  {conversationInTask && nextStep ? (
                    <p className="text-xs text-muted-foreground">Up next is {nextStep.title}.</p>
                  ) : null}
                  {showPauseDetail ? (
                    <p className="text-xs text-muted-foreground">
                      Setup and previews remain running.
                    </p>
                  ) : null}
                </div>
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
                {conversationInTask ? conversationActions : null}
                {paused ? resumeAction : null}
              </div>
              {inputInTask ? checkpointResponse : null}
            </div>
          )}
          {selectedJob.status === "queued" && !queuedTask ? (
            <p className="text-sm text-muted-foreground">
              Waiting for an execution target. No steps have started.
            </p>
          ) : null}
          {manualState.message && !showPauseDetail ? (
            <WorkflowAlert
              title={confirmationPending ? "Waiting for confirmation" : "Run needs attention"}
              variant={confirmationPending ? "info" : "warning"}
            >
              {manualState.message}
            </WorkflowAlert>
          ) : null}
          {!failed &&
          !publishingFailure &&
          !cancelledVm &&
          !queuedTask &&
          detail &&
          !(pausedBeforeStep && detail === "Waiting for executor capacity.") ? (
            <p className="text-sm text-muted-foreground">{detail}</p>
          ) : null}
          {(reviewChanged && selectedJob.runtime?.kind !== "vm") ||
          (checkingReturnedReview && reviewingCurrentResult && !read.error) ? (
            <WorkflowAlert
              title={reviewChanged ? "Review changed" : "Checking the current review"}
              variant={reviewChanged ? "warning" : "info"}
            >
              {reviewChanged
                ? "Review changed. Inspect the current diff before approving."
                : "Checking the current review…"}
            </WorkflowAlert>
          ) : null}
          {waiting &&
          !input &&
          !composingFeedback &&
          (selectedJob.runtime?.kind !== "vm" || reviewingCurrentResult) &&
          stepIndex >= 0 ? (
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
          {!composingFeedback && selectedJob.runtime?.kind === "vm" ? (
            <SavedWorkflowResults
              key={`${scope.accountId}:${scope.repositoryId}:${jobId}`}
              scope={scope}
              job={selectedJob}
              refresh={refresh}
              canConfigure={canConfigure}
              onReviewTargetChange={setReviewingCurrentResult}
            />
          ) : null}
          {selectedJob.progress?.resultSaving ? (
            <WorkflowAlert
              title={
                selectedJob.progress.resultSaving.state === "failed"
                  ? "Couldn’t save result"
                  : "Saving result"
              }
              variant={selectedJob.progress.resultSaving.state === "failed" ? "error" : "info"}
              actions={
                canConfigure && selectedJob.progress.resultSaving.retryable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void respond("retry_saving")}
                  >
                    Retry saving
                  </Button>
                ) : undefined
              }
            >
              {selectedJob.progress.resultSaving.detail ??
                "The next step starts after this result is saved. Cancel remains available."}
            </WorkflowAlert>
          ) : null}
          {!conversationInTask && !failed && !publishingFailure ? conversationActions : null}
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
          !composingFeedback &&
          (selectedJob.runtime?.kind !== "vm" || reviewingCurrentResult) ? (
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
          {!inputInTask ? checkpointResponse : null}
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
        <WorkflowUnsentDrafts
          key={`drafts:${key}`}
          drafts={oldDrafts}
          fallbackFocus={runHeading}
          onDiscard={(draft) => changeRetainedDraft(draft, false)}
          onRestore={(draft) => changeRetainedDraft(draft, true)}
        />
        <WorkflowCheckpointHistory
          key={`history:${key}`}
          responses={selectedJob.progress?.responses}
          steps={selectedJob.workflow?.definition.steps}
          accountId={scope.accountId}
        />
        {!completed && selectedJob.progress?.pullRequestUrl ? (
          <a href={selectedJob.progress.pullRequestUrl} target="_blank" rel="noreferrer">
            Open pull request
          </a>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t pt-3">
          <WorkflowProgress key={key} job={selectedJob} />
          {!paused ? resumeAction : null}
          {(viewerControls.canCancel || (canConfigure && manualState.canPause)) && !terminal ? (
            <details className="ml-auto min-w-0">
              <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
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
