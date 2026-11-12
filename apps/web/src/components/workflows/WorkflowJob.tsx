import { SavedWorkflowResults } from "./SavedWorkflowResults";
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  CloudIcon,
  MessageSquareIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareIcon,
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
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { WorkflowProgress } from "./WorkflowProgress";
import {
  useWorkflowClient,
  useWorkflowDrafts,
  useWorkflowJobReads,
  workflowError,
} from "./workflowState";

type Operation = Exclude<WorkflowControl["operation"], "start" | "status">;

/** Keep focus in the run when an update moves or removes the focused action. */
function useRunActionFocus<Action extends HTMLElement = HTMLButtonElement>(
  runKey: string,
  fallback?: RefObject<HTMLElement | null>,
) {
  const action = useRef<Action | null>(null);
  const focusedRun = useRef<string | null>(null);
  const registerAction = useCallback(
    (node: Action | null) => {
      const previous = action.current;
      if (!node && previous) {
        const focused = previous.ownerDocument.activeElement;
        if (focused === previous || previous.contains?.(focused)) focusedRun.current = runKey;
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
  const checkpointForm = useRunActionFocus<HTMLFormElement>(key, runHeading);
  const retryPublishingButton = useRunActionFocus(key, runHeading);
  const retryCancellationButton = useRunActionFocus(key, runHeading);
  const runControlsTrigger = useRef<HTMLButtonElement>(null);
  const [cancelDialogKey, setCancelDialogKey] = useState<string | null>(null);
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
  const [collapsedDraftKey, setCollapsedDraftKey] = useState<string | null>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const feedbackFocus = useRef<"input" | "button" | null>(null);
  const checkpoint = selectedJob?.progress?.checkpoint;
  const reviewApproval = workflowReviewApprovalState(drafts.reviews[key], read);
  const reviewChanged = reviewApproval === "inspect";
  const checkingReturnedReview = reviewApproval === "checking";
  const viewerControls = workflowViewerControls(selectedJob, canConfigure);
  const cancelling = selectedJob?.status === "cancelling";
  const terminal = !!selectedJob && isTerminalWorkflowJob(selectedJob.status);
  const canCancelRun = viewerControls.canCancel && !terminal && !cancelling;
  if (cancelDialogKey !== null && (cancelDialogKey !== key || !canCancelRun)) {
    setCancelDialogKey(null);
  }
  const approvalPending = workflowApprovalPending(selectedJob);
  const responseDrafts = drafts.responses[key] ?? {};
  const response = checkpoint ? (responseDrafts[checkpoint.checkpointId] ?? "") : "";
  const feedbackKey = `${key}:${checkpoint?.checkpointId ?? ""}`;
  const feedbackOpen = feedbackView?.key === feedbackKey ? feedbackView.open : !!response;
  const manualHold =
    selectedJob?.status === "paused" && selectedJob.progress?.manualPause?.state === "paused";
  if (collapsedDraftKey !== null && (!manualHold || collapsedDraftKey !== feedbackKey)) {
    setCollapsedDraftKey(null);
  }
  const waiting =
    !!checkpoint &&
    !terminal &&
    !cancelling &&
    (manualState.status === "awaiting_input" || manualState.status === "awaiting_review");
  const input = checkpoint?.kind === "input";
  useLayoutEffect(() => {
    if (feedbackFocus.current === "input") feedbackInput.current?.focus();
    if (feedbackFocus.current === "button") feedbackButton.current?.focus();
    feedbackFocus.current = null;
  });
  const busy = !!read.mutation;
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
    const currentReads = appAtomRegistry.get(workflowJobReadAtom);
    const currentRead = currentReads.jobs[key] ?? emptyWorkflowJobRead;
    if (operation === "cancel" || operation === "retry_cancellation") {
      const currentJob = currentRead.job;
      if (
        currentReads.activeKey !== key ||
        !currentJob ||
        !workflowViewerControls(currentJob, canConfigure).canCancel ||
        isTerminalWorkflowJob(currentJob.status)
      )
        return;
      if (operation === "cancel" && currentJob.status === "cancelling") return;
      if (
        operation === "retry_cancellation" &&
        (currentRead.job !== selectedJob ||
          currentJob.status !== "cancelling" ||
          currentJob.responsePending ||
          !currentJob.progress?.retryableCancellation)
      )
        return;
    }
    const currentReview = appAtomRegistry.get(workflowDraftAtom).reviews[key];
    if (
      (operation === "approve" &&
        (!viewerControls.canApprove ||
          currentRead.job !== selectedJob ||
          workflowReviewApprovalState(currentReview, currentRead) !== "allowed")) ||
      ((operation === "input" || operation === "request_changes") && !viewerControls.canRespond)
    )
      return;
    if (
      ["approve", "input", "request_changes"].includes(operation) &&
      (!selectedJob.progress?.checkpoint || terminal || cancelling || manualState.checkpointBlocked)
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
    recordWorkflowResponse(appAtomRegistry, scope, jobId, {
      checkpointId: checkpoint?.checkpointId ?? null,
      operation,
      userId: scope.accountId,
      text: "text" in payload ? payload.text : null,
      requestEpoch: request.epoch,
    });
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
  const keepPausedFeedbackOpenOnResume = () => {
    if (manualHold && !input && !feedbackOpen) setFeedbackView({ key: feedbackKey, open: true });
  };
  const setResponse = (text: string) => {
    if (!checkpoint) return;
    keepPausedFeedbackOpenOnResume();
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
  const checkpointOperation = input ? "input" : "request_changes";
  const submission = checkpoint ? drafts.submitted[key]?.[checkpoint.checkpointId] : undefined;
  const ownSend =
    submission?.userId === scope.accountId && submission.operation === checkpointOperation
      ? submission
      : undefined;
  const sendingCheckpoint = !!read.mutation && ownSend?.requestEpoch === read.epoch;
  const unknownCheckpointResponse =
    manualState.responsePending &&
    selectedJob.pendingResponseOperation === undefined &&
    !selectedJob.pendingManualControl &&
    (!selectedJob.progress?.resultSaving || selectedJob.progress.resultSaving.state === "saved");
  const checkpointResponsePending =
    waiting &&
    !approvalPending &&
    (sendingCheckpoint ||
      unknownCheckpointResponse ||
      (manualState.responsePending &&
        selectedJob.pendingResponseOperation === checkpointOperation));
  const submittedResponse =
    checkpointResponsePending && ownSend && (sendingCheckpoint || ownSend.acceptedPending)
      ? ownSend.text
      : null;
  const checkpointConfirmationTitle = "Waiting for confirmation";
  const composingFeedback =
    waiting &&
    !checkpointResponsePending &&
    !manualHold &&
    !input &&
    feedbackOpen &&
    viewerControls.canRespond &&
    !approvalPending;
  const approval =
    !terminal &&
    !cancelling &&
    !!checkpoint &&
    viewerControls.canApprove &&
    (manualState.status === "awaiting_review" ||
      (canConfigure &&
        selectedJob.status === "finishing" &&
        selectedJob.progress?.retryableApproval));
  const oldDrafts = Object.entries(responseDrafts)
    .filter(([id, text]) => {
      if (!text.trim()) return false;
      if (id !== checkpoint?.checkpointId) return true;
      if (checkpointResponsePending) return text !== submittedResponse;
      return !waiting || !viewerControls.canRespond || approvalPending;
    })
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
  const pausedBeforeStep = manualHold && manualState.status === "waiting_capacity" && !checkpoint;
  const showPauseDetail = manualHold && !confirmationPending;
  const statusLabel = workflowStatusLabel(selectedJob.status);
  const runName = selectedJob.workflow?.definition.name ?? "Workflow run";
  const runIssue = selectedJob.issueSnapshot ?? selectedJob.event;
  const runContext = runIssue
    ? `${runIssue.identifier} ${runIssue.title}`
    : selectedJob.instruction;
  const canPauseRun = canConfigure && manualState.canPause;
  const cancellationNeedsAttention =
    selectedJob.progress?.retryableCancellation === true && !manualState.responsePending;
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
    : checkpointResponsePending
      ? (checkpointStep?.title ?? (input ? "Input checkpoint" : "Review checkpoint"))
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
  const checkpointPanel = composingFeedback || checkpointResponsePending;
  const TaskIcon = checkpointPanel ? (input ? MessageSquareIcon : ClipboardCheckIcon) : StatusIcon;
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
              (waiting && !input && !checkpointResponsePending) ||
              (completed && !selectedJob.progress.pullRequestUrl)
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
  const draftOpen = !manualHold || collapsedDraftKey !== feedbackKey;
  const checkpointResponse = checkpointResponsePending ? (
    <div className="space-y-3">
      {checkpoint?.kind === "input" ? (
        <p className="text-sm font-medium">{checkpoint.question}</p>
      ) : null}
      <WorkflowAlert title={checkpointConfirmationTitle} variant="info" announce={false}>
        {unknownCheckpointResponse
          ? "The run will update when the environment confirms the response."
          : input
            ? "The workflow continues once the environment confirms the answer."
            : "Rework starts once the environment confirms the feedback."}
      </WorkflowAlert>
      {submittedResponse !== null ? (
        <div className="space-y-1 rounded-md border bg-muted/25 px-3 py-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {sendingCheckpoint
              ? input
                ? "Answer being sent"
                : "Feedback being sent"
              : input
                ? "Your last submitted answer"
                : "Your last submitted feedback"}
          </h3>
          <p className="whitespace-pre-wrap text-sm">{submittedResponse}</p>
        </div>
      ) : null}
    </div>
  ) : waiting &&
    checkpoint &&
    viewerControls.canRespond &&
    !approvalPending &&
    (input || feedbackOpen || (manualHold && !!response.trim())) ? (
    <details
      key={feedbackKey}
      open={draftOpen}
      className={cn(manualHold && "space-y-2 border-t pt-3")}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (!manualHold || open === draftOpen) return;
        setCollapsedDraftKey(open ? null : feedbackKey);
      }}
    >
      <summary hidden={!manualHold} className="cursor-pointer text-sm font-medium">
        {manualHold ? (input ? "Answer draft" : "Feedback draft") : null}
      </summary>
      <form
        ref={checkpointForm}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void respond(input ? "input" : "request_changes");
        }}
      >
        <label className="block space-y-2">
          <span className="text-sm font-medium">
            {checkpoint.kind === "input" ? checkpoint.question : "Feedback for the agent"}
          </span>
          <Textarea
            ref={feedbackInput}
            placeholder={input ? undefined : "Describe the changes…"}
            rows={input ? 3 : 4}
            maxLength={8000}
            value={response}
            onFocus={keepPausedFeedbackOpenOnResume}
            onChange={(event) => setResponse(event.target.value)}
          />
        </label>
        {!manualHold ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {composingFeedback ? (
              <div className="mr-auto">
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
              </div>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={busy || manualState.checkpointBlocked || !response.trim()}
            >
              {input ? "Submit answer" : "Send feedback"}
            </Button>
          </div>
        ) : null}
      </form>
    </details>
  ) : waiting && !viewerControls.canRespond && !viewerControls.canApprove ? (
    <p className="text-sm text-muted-foreground">
      This checkpoint requires a repository maintainer.
    </p>
  ) : null;
  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl space-y-6 wrap-anywhere">
      {runNavigation}
      <AlertDialog
        open={canCancelRun && cancelDialogKey === key}
        onOpenChange={(open) => {
          if (!open) setCancelDialogKey(null);
        }}
      >
        <AlertDialogPopup
          finalFocus={() =>
            runControlsTrigger.current && !runControlsTrigger.current.disabled
              ? runControlsTrigger.current
              : runHeading.current
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              <span className="block font-medium text-popover-foreground">{runName}</span>
              <span className="mt-0.5 mb-2 line-clamp-3">
                {runContext.length > 200 ? `${runContext.slice(0, 200).trimEnd()}…` : runContext}
              </span>
              This stops the workflow. Results already saved remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setCancelDialogKey(null)}>
              Keep run
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !canCancelRun}
              onClick={() => {
                setCancelDialogKey(null);
                void respond("cancel");
              }}
            >
              Cancel run
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <header>
        <span role="status" className="sr-only">
          {checkpointResponsePending
            ? checkpointConfirmationTitle
            : queuedTask
              ? `${statusLabel}. ${queuedTask.title}`
              : statusLabel}
        </span>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 ref={runHeading} tabIndex={-1} className="text-xl font-semibold">
            {runName}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            {!TaskIcon && !cancelling ? (
              <span aria-hidden className="text-sm font-medium">
                {statusLabel}
              </span>
            ) : null}
            {canPauseRun || canCancelRun ? (
              <Menu>
                <MenuTrigger
                  ref={runControlsTrigger}
                  disabled={busy}
                  render={<Button size="sm" variant="outline" />}
                >
                  Run controls
                  <ChevronDownIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  {canPauseRun ? (
                    <MenuItem disabled={busy} onClick={() => void respond("pause")}>
                      <PauseIcon aria-hidden />
                      {manualState.status === "awaiting_input" ||
                      manualState.status === "awaiting_review"
                        ? "Pause at this checkpoint"
                        : "Pause after current step"}
                    </MenuItem>
                  ) : null}
                  {canCancelRun ? (
                    <MenuItem
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setCancelDialogKey(key)}
                    >
                      <SquareIcon aria-hidden />
                      Cancel run
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
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
          {cancelling ? (
            <WorkflowAlert
              title={cancellationNeedsAttention ? "Cancellation needs attention" : "Canceling run"}
              variant={cancellationNeedsAttention ? "warning" : "info"}
              actions={
                cancellationNeedsAttention && viewerControls.canCancel ? (
                  <Button
                    ref={retryCancellationButton}
                    size="sm"
                    variant="outline"
                    aria-disabled={busy}
                    onClick={() => void respond("retry_cancellation")}
                  >
                    <RotateCwIcon aria-hidden />
                    Retry cancellation
                  </Button>
                ) : undefined
              }
            >
              {selectedJob.detail ??
                selectedJob.progress?.detail ??
                (cancellationNeedsAttention
                  ? "The environment couldn’t confirm that the run stopped."
                  : "Waiting for the environment to confirm the run has stopped.")}
            </WorkflowAlert>
          ) : queuedTask ? (
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
                TaskIcon
                  ? "space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
                  : "space-y-3 border-t pt-5"
              }
            >
              {TaskIcon || (!terminal && stepIndex >= 0) ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {TaskIcon ? (
                    <span
                      aria-hidden={!composingFeedback}
                      className={cn(
                        "inline-flex items-center gap-2 text-sm font-medium",
                        (needsInput || composingFeedback) &&
                          !checkpointResponsePending &&
                          "text-warning-foreground",
                        running && "text-info-foreground",
                      )}
                    >
                      <TaskIcon aria-hidden className="size-4" />
                      {checkpointResponsePending
                        ? input
                          ? "Input"
                          : "Review"
                        : composingFeedback
                          ? (checkpointStep?.title ?? "Review")
                          : statusLabel}
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
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  {taskTitle ? (
                    <h2 className={TaskIcon ? "text-base font-semibold" : "text-sm font-medium"}>
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
                {conversationInTask ? conversationActions : null}
                {paused ? resumeAction : null}
              </div>
              {checkpointResponse}
            </div>
          )}
          {selectedJob.status === "queued" && !queuedTask ? (
            <p className="text-sm text-muted-foreground">
              Waiting for an execution target. No steps have started.
            </p>
          ) : null}
          {!cancelling && !checkpointResponsePending && manualState.message && !showPauseDetail ? (
            <WorkflowAlert
              title={confirmationPending ? "Waiting for confirmation" : "Run needs attention"}
              variant={confirmationPending ? "info" : "warning"}
            >
              {manualState.message}
            </WorkflowAlert>
          ) : null}
          {!cancelling &&
          !failed &&
          !publishingFailure &&
          !cancelledVm &&
          !queuedTask &&
          detail &&
          !(
            checkpointResponsePending && detail === "Response saved; waiting for the environment."
          ) &&
          !(pausedBeforeStep && detail === "Waiting for executor capacity.") ? (
            <p className="text-sm text-muted-foreground">{detail}</p>
          ) : null}
          {!cancelling &&
          ((reviewChanged && selectedJob.runtime?.kind !== "vm") ||
            (checkingReturnedReview && reviewingCurrentResult && !read.error)) ? (
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
          !manualHold &&
          !input &&
          !composingFeedback &&
          !checkpointResponsePending &&
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
          {!cancelling && selectedJob.progress?.resultSaving ? (
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
          !manualHold &&
          !composingFeedback &&
          !checkpointResponsePending &&
          (selectedJob.runtime?.kind !== "vm" || reviewingCurrentResult) ? (
            <div className="flex flex-wrap items-center gap-2">
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
              {waiting && !input && viewerControls.canRespond && response.trim() ? (
                <p className="text-xs text-muted-foreground">Feedback draft kept</p>
              ) : null}
            </div>
          ) : null}
          {!cancelling &&
          canConfigure &&
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
          activeCheckpointId={checkpointResponsePending ? checkpoint?.checkpointId : undefined}
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
        </div>
      </div>
    </div>
  );
}
