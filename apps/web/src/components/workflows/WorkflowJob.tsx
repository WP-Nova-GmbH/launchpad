import { SavedWorkflowResults } from "./SavedWorkflowResults";
import { WorkflowVmFollowUpButton } from "./WorkflowVmFollowUpButton";
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  ClockIcon,
  CloudIcon,
  FileDiffIcon,
  GitBranchIcon,
  LockKeyholeIcon,
  MessageSquareIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Settings2Icon,
  SquareIcon,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowOutcome } from "./WorkflowOutcome";
import {
  WorkflowCompletionRecovery,
  workflowCompletionRecovery,
  type WorkflowRecoveryOperation,
} from "./WorkflowCompletionRecovery";
import { WorkflowIssueDetails } from "./WorkflowIssueDetails";
import {
  WorkflowCheckpointHistory,
  WorkflowUnsentDrafts,
  type RetainedCheckpointDraft,
} from "./WorkflowCheckpoints";
import { WorkflowQueuedTask, workflowQueuedTasks } from "./WorkflowQueuedTask";
import { WorkflowVmRecoveryStatus, workflowVmRecoveryTask } from "./WorkflowVmRecovery";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  useMemo,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
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
import {
  sameWorkflowResultCheckpoint,
  workflowResultCheckpoint,
  type WorkflowResultCheckpoint,
} from "@t3tools/client-runtime/relay/workflow-result";
import { savedWorkflowThreadState } from "@t3tools/client-runtime/relay/workflow-saved-results";
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
  requireFreshWorkflowReviewRead,
  workflowReviewApprovalState,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  isTerminalWorkflowJob,
  workflowApprovalCanRetry,
  workflowIsFinishing,
  type RepositoryWorkflowJob,
  type WorkflowControl,
} from "@t3tools/contracts/workflows";
import { TurnId } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
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
import { Spinner } from "../ui/spinner";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { searchableSetting } from "../settings/settingsSearch";
import { WorkflowProgress } from "./WorkflowProgress";
import {
  WORKFLOW_REVIEW_ANCHOR,
  useWorkflowClient,
  useWorkflowDrafts,
  useWorkflowJobReads,
  workflowError,
} from "./workflowState";

type Operation = Exclude<WorkflowControl["operation"], "start" | "status">;
type SavedReviewRender = { key: string; visitId: string };
type MachineResultDestination =
  | { kind: "conversation" }
  | { kind: "diff"; checkpoint: WorkflowResultCheckpoint; review: boolean };
type MachineResultOpening = { destination: MachineResultDestination } & (
  | { status: "opening" }
  | { status: "failed"; detail: string }
);

const checkingCheckpointAccess = "Checking who can respond…";
const unconfirmedCheckpointAccess =
  "Response access couldn’t be confirmed. Refresh the run to try again.";

const matchesSavedReviewRender = (
  render: SavedReviewRender | null,
  key: string | null,
  visitId: string | undefined,
) => render !== null && render.key === key && render.visitId === visitId;

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

function publishedBranchName(branchUrl: string) {
  try {
    const url = new URL(branchUrl);
    if (url.origin !== "https://github.com") return undefined;
    const ref = /^\/[^/]+\/[^/]+\/tree\/([^/]+)$/u.exec(url.pathname)?.[1];
    return ref ? decodeURIComponent(ref) : undefined;
  } catch {
    return undefined;
  }
}

// A publishing receipt can accompany an unrelated cancellation detail.
const relayPublishingCancellationDetails = new Set([
  "The branch was pushed before cancellation.",
  "Could not verify whether the branch was pushed before cancellation.",
  "The pull request was opened before cancellation.",
  "Could not verify whether the pull request was opened before cancellation.",
]);

function CancelledVmPublication({
  outcome,
  detail,
  progressPullRequestUrl,
}: {
  outcome: NonNullable<RepositoryWorkflowJob["publicationOutcome"]>;
  detail: string | undefined;
  progressPullRequestUrl: string | null | undefined;
}) {
  const { branchUrl, pullRequestUrl } = outcome;
  const unconfirmed = outcome.state === "unknown";
  const branchName = branchUrl ? publishedBranchName(branchUrl) : undefined;
  const pullRequestNumber = pullRequestUrl
    ? parseChangeRequestUrl(pullRequestUrl)?.number
    : undefined;
  const pullRequestLabel = pullRequestNumber === undefined ? undefined : `PR #${pullRequestNumber}`;
  const branchInFooter = !!branchUrl && (unconfirmed || !!pullRequestUrl);
  const summary = detail ?? (unconfirmed ? "GitHub may have received the last action." : undefined);
  const pullRequestSummary =
    unconfirmed && pullRequestUrl
      ? `Previously confirmed ${pullRequestLabel ?? "pull request"}`
      : pullRequestLabel;
  const summaryBranch = branchInFooter ? undefined : branchName;
  const branchAction = branchUrl ? (
    <Button
      size="sm"
      variant={branchInFooter ? "outline" : "default"}
      render={<a href={branchUrl} target="_blank" rel="noreferrer" />}
    >
      Open branch
      <ArrowUpRightIcon aria-hidden />
    </Button>
  ) : null;
  const primaryBranchAction = branchInFooter ? null : branchAction;
  const recordedPullRequestUrl = pullRequestUrl ?? progressPullRequestUrl;
  const pullRequestAction = recordedPullRequestUrl ? (
    <Button
      size="sm"
      variant={pullRequestUrl && !unconfirmed ? "default" : "outline"}
      render={<a href={recordedPullRequestUrl} target="_blank" rel="noreferrer" />}
    >
      {pullRequestUrl ? "Open pull request" : "Open recorded pull request"}
      <ArrowUpRightIcon aria-hidden />
    </Button>
  ) : null;

  return (
    <WorkflowOutcome
      title={
        unconfirmed
          ? "Last publishing action unconfirmed"
          : pullRequestUrl
            ? "Pull request confirmed"
            : branchUrl
              ? "Branch published"
              : "Published to GitHub"
      }
      tone={unconfirmed ? "warning" : "neutral"}
      icon={
        unconfirmed
          ? undefined
          : pullRequestUrl
            ? PullRequestGlyph.pullRequest
            : branchUrl
              ? GitBranchIcon
              : undefined
      }
      announce={false}
      actions={
        primaryBranchAction || pullRequestAction ? (
          <>
            {primaryBranchAction}
            {pullRequestAction}
          </>
        ) : null
      }
      footer={
        branchInFooter ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2">
              <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 wrap-anywhere">
                {unconfirmed ? (
                  <p className="text-xs font-medium">Previously published branch</p>
                ) : null}
                {branchName ? (
                  <code
                    className={cn(
                      "block text-xs",
                      unconfirmed ? "text-warning-foreground" : "text-muted-foreground",
                    )}
                  >
                    {branchName}
                  </code>
                ) : unconfirmed ? null : (
                  <p className="text-xs text-muted-foreground">Published branch</p>
                )}
              </div>
            </div>
            {branchAction}
          </div>
        ) : undefined
      }
    >
      {summary || pullRequestSummary || summaryBranch ? (
        <>
          {summary ? <p>{summary}</p> : null}
          {pullRequestSummary ? <p>{pullRequestSummary}</p> : null}
          {summaryBranch ? <code className="wrap-anywhere">{summaryBranch}</code> : null}
        </>
      ) : null}
    </WorkflowOutcome>
  );
}

export function WorkflowJob({
  scope: { accountId, organizationId, repositoryId },
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
  const returningToReview = useLocation({ select: ({ hash }) => hash === WORKFLOW_REVIEW_ANCHOR });
  const returnCheckpoint = useLocation({
    select: ({ hash, state }) =>
      hash === WORKFLOW_REVIEW_ANCHOR ? state?.workflowReviewReturn : undefined,
  });
  const openResult = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const [machineResult, setMachineResult] = useState<MachineResultOpening | null>(null);
  const openingResult = machineResult?.status === "opening" ? machineResult.destination.kind : null;
  const resultError = machineResult?.status === "failed" ? machineResult : null;
  const retryResultButton = useRef<HTMLButtonElement>(null);
  const resultActions = useRef<HTMLDivElement>(null);
  const restoreOpeningFocus = useRef(false);
  // A catalog refresh can recreate an equivalent scope while the run read is still in flight.
  const scope = useMemo(
    () => ({ accountId, organizationId, repositoryId }),
    [accountId, organizationId, repositoryId],
  );
  const call = useWorkflowClient(scope);
  const reads = useWorkflowJobReads();
  const drafts = useWorkflowDrafts();
  const key = workflowSessionKey(scope, jobId);
  const reviewReturn = useMemo(
    () =>
      returnCheckpoint
        ? {
            key,
            checkpoint: returnCheckpoint,
            after: appAtomRegistry.get(workflowJobReadAtom).sequence,
          }
        : null,
    [key, returnCheckpoint],
  );
  const runHeading = useRef<HTMLHeadingElement>(null);
  const conversationButton = useRunActionFocus(
    key,
    resultError?.destination.kind === "conversation" ? retryResultButton : runHeading,
  );
  const inspectResultButton = useRunActionFocus(
    key,
    resultError?.destination.kind === "diff" ? retryResultButton : runHeading,
  );
  const resumeButton = useRunActionFocus(key);
  const reviewSection = useRef<HTMLElement>(null);
  const handledReviewReturn = useRef<string | null>(null);
  const checkpointForm = useRunActionFocus<HTMLFormElement>(key, runHeading);
  const retryCompletionButton = useRunActionFocus(key, runHeading);
  const retrySavingButton = useRunActionFocus(key, runHeading);
  const [pendingRetry, setPendingRetry] = useState<{
    key: string;
    epoch: number;
    operation: WorkflowRecoveryOperation | "retry_preparation";
  } | null>(null);
  const retryPublishingButton = useRunActionFocus(key, runHeading);
  const retryCancellationButton = useRunActionFocus(key, runHeading);
  const retryPreparationButton = useRunActionFocus(key, runHeading);
  const runControlsTrigger = useRef<HTMLButtonElement>(null);
  const [cancelDialogKey, setCancelDialogKey] = useState<string | null>(null);
  const [checkpointAccessCheck, setCheckpointAccessCheck] = useState<{
    key: string;
    checkpointId: string;
    epoch: number;
  } | null>(null);
  const recoverySettingsLink = useRunActionFocus<HTMLAnchorElement>(key, runHeading);
  const savedResultsButton = useRunActionFocus(key, runHeading);
  const savedResults = useRef<HTMLElement>(null);
  const [availableSavedResultsKey, setAvailableSavedResultsKey] = useState<string | null>(null);
  const onSavedResultsAvailableChange = useCallback(
    (available: boolean) => setAvailableSavedResultsKey(available ? key : null),
    [key],
  );
  const read = reads.jobs[key] ?? emptyWorkflowJobRead;
  const selectedJob = read.job;
  const followUpAction = selectedJob?.viewerControls?.canContinueInVm ? (
    <WorkflowVmFollowUpButton
      key={key}
      scope={scope}
      jobId={jobId}
      title={selectedJob.workflow?.definition.name ?? "Workflow workspace"}
    />
  ) : null;
  const resultEnvironmentId =
    selectedJob?.runtime?.kind === "machine" ? selectedJob.runtime.environmentId : undefined;
  const resultThreadId =
    selectedJob?.progress?.hasThread === false ? undefined : selectedJob?.progress?.threadId;
  const resultRequest = useRef<{ key: string } | null>(null);
  useLayoutEffect(() => {
    if (!resultEnvironmentId || !resultThreadId) return;
    return () => {
      if (resultRequest.current?.key === key) resultRequest.current = null;
      setMachineResult(null);
      restoreOpeningFocus.current = false;
    };
  }, [key, resultEnvironmentId, resultThreadId]);
  useLayoutEffect(() => {
    if (!openingResult || !restoreOpeningFocus.current) return;
    restoreOpeningFocus.current = false;
    const target = resultActions.current?.querySelector<HTMLButtonElement>(
      'button[aria-busy="true"]',
    );
    if (target && target.ownerDocument.activeElement === target.ownerDocument.body) target.focus();
  }, [openingResult]);
  const manualState = workflowManualControlState(selectedJob);
  const vmRecovery = manualState.recovery;
  const actionState = workflowActionState(selectedJob);
  const detail = selectedJob?.detail ?? selectedJob?.progress?.detail ?? actionState.action?.detail;
  const [reviewingCurrentResult, setReviewingCurrentResult] = useState(true);
  const [feedbackView, setFeedbackView] = useState<{ key: string; open: boolean } | null>(null);
  const [collapsedDraftKey, setCollapsedDraftKey] = useState<string | null>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const feedbackFocus = useRef<"input" | "button" | null>(null);
  const checkpoint = selectedJob?.progress?.checkpoint;
  const vmReview = selectedJob?.runtime?.kind === "vm";
  const savedReviewKey =
    selectedJob?.runtime?.kind === "vm" && checkpoint && checkpoint.kind !== "input"
      ? JSON.stringify([
          key,
          selectedJob.runtime.threadId,
          checkpoint.checkpointId,
          checkpoint.turnId,
          checkpoint.checkpointTurnCount,
          checkpoint.checkpointRef,
        ])
      : null;
  const currentSavedReviewRender = useRef<SavedReviewRender | null>(null);
  const [savedReviewRender, setSavedReviewRender] = useState<SavedReviewRender | null>(null);
  const onSavedReviewRenderChange = useCallback(
    (renderedCheckpoint: WorkflowResultCheckpoint | null) => {
      const currentCheckpoint = workflowResultCheckpoint(
        appAtomRegistry.get(workflowJobReadAtom).jobs[key]?.job?.progress?.checkpoint,
      );
      const review = appAtomRegistry.get(workflowDraftAtom).reviews[key];
      const proof =
        savedReviewKey &&
        renderedCheckpoint &&
        currentCheckpoint &&
        review?.verified &&
        sameWorkflowResultCheckpoint(renderedCheckpoint, currentCheckpoint)
          ? { key: savedReviewKey, visitId: review.id }
          : null;
      currentSavedReviewRender.current = proof;
      setSavedReviewRender(proof);
    },
    [key, savedReviewKey],
  );
  const waitingForSavedReviewRender =
    vmReview &&
    !matchesSavedReviewRender(savedReviewRender, savedReviewKey, drafts.reviews[key]?.id);
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
  const saving = selectedJob?.progress?.resultSaving;
  const hasResultSave = !!saving && saving.state !== "saved";
  const finishing = workflowIsFinishing(selectedJob);
  const completionRetryable = finishing && workflowApprovalCanRetry(selectedJob?.progress);
  const atCheckpoint =
    manualState.status === "awaiting_input" || manualState.status === "awaiting_review";
  const waiting =
    !hasResultSave && !finishing && !!checkpoint && !terminal && !cancelling && atCheckpoint;
  const input = checkpoint?.kind === "input";
  const readOnlyCheckpoint =
    waiting && checkpoint && !viewerControls.canRespond && (input || !viewerControls.canApprove)
      ? checkpoint
      : null;
  const responseAccessUnconfirmed =
    !selectedJob?.viewerControls &&
    (selectedJob?.vmAdmission || selectedJob?.runtime?.kind === "vm");
  const currentCheckpointAccessCheck =
    waiting &&
    checkpointAccessCheck?.key === key &&
    checkpointAccessCheck.checkpointId === checkpoint?.checkpointId &&
    checkpointAccessCheck.epoch === read.epoch
      ? checkpointAccessCheck
      : null;
  if (checkpointAccessCheck && !currentCheckpointAccessCheck) setCheckpointAccessCheck(null);
  const runLoaded = selectedJob !== null;
  const showingReview = waiting && !input;
  const returnReadAccepted = !reviewReturn || read.acceptedReadEpoch > reviewReturn.after;
  const returnReadPending =
    reviewReturn &&
    !returnReadAccepted &&
    (read.epoch <= reviewReturn.after || read.reading || read.mutation);
  const reviewAtReturn = reviewReturn ? workflowResultCheckpoint(checkpoint) : undefined;
  const expectedReviewOnReturn =
    !reviewReturn ||
    (returnReadAccepted &&
      reviewAtReturn &&
      sameWorkflowResultCheckpoint(reviewAtReturn, reviewReturn.checkpoint));
  useLayoutEffect(() => {
    if (!returningToReview) {
      handledReviewReturn.current = null;
      return;
    }
    if (!runLoaded || returnReadPending || handledReviewReturn.current === key) return;
    const target =
      showingReview && expectedReviewOnReturn ? reviewSection.current : runHeading.current;
    if (!target) return;
    handledReviewReturn.current = key;
    const { activeElement, body } = target.ownerDocument;
    if (activeElement !== body && activeElement !== target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [key, returningToReview, runLoaded, returnReadPending, showingReview, expectedReviewOnReturn]);
  useLayoutEffect(() => {
    if (feedbackFocus.current === "input") feedbackInput.current?.focus();
    if (feedbackFocus.current === "button") feedbackButton.current?.focus();
    feedbackFocus.current = null;
  });
  const busy = !!read.mutation;
  const refresh = useCallback(
    async (onStart?: (epoch: number) => void) => {
      const request = beginWorkflowJobRequest(appAtomRegistry, scope, jobId);
      if (!request) return;
      onStart?.(request.epoch);
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
    },
    [call, scope, jobId],
  );
  useLayoutEffect(() => {
    activateWorkflowJobView(appAtomRegistry, scope, jobId);
    requireFreshWorkflowReviewRead(appAtomRegistry, scope, jobId);
  }, [scope, jobId]);
  useEffect(() => {
    if (read.mutation) return;
    void refresh();
    if (terminal && saving?.state !== "saving" && !selectedJob?.resultSaveRetryPending) return;
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
  }, [
    refresh,
    terminal,
    saving?.state,
    selectedJob?.resultSaveRetryPending,
    read.mutation,
    scope,
    jobId,
  ]);
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
          (finishing && !completionRetryable) ||
          currentRead.job !== selectedJob ||
          (vmReview &&
            !matchesSavedReviewRender(
              currentSavedReviewRender.current,
              savedReviewKey,
              currentReview?.id,
            )) ||
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
      (!canConfigure ||
        cancelling ||
        selectedJob.resultSaveRetryPending ||
        saving?.state !== "failed" ||
        !saving.retryable ||
        currentReads.activeKey !== key ||
        currentRead.job !== selectedJob)
    )
      return;
    if (
      operation === "retry_action" &&
      (!canConfigure || !actionState.canRetry || currentRead.job !== selectedJob)
    )
      return;
    if (
      operation === "retry_preparation" &&
      (!canConfigure ||
        currentReads.activeKey !== key ||
        currentRead.job !== selectedJob ||
        selectedJob.status !== "paused" ||
        selectedJob.progress?.status !== "paused" ||
        !selectedJob.progress.retryablePreparation ||
        manualState.checkpointBlocked ||
        vmRecovery)
    )
      return;
    const request = beginWorkflowJobRequest(appAtomRegistry, scope, jobId, randomUUID());
    if (!request) return;
    if (
      operation === "retry_preparation" ||
      operation === "retry_saving" ||
      (operation === "approve" && finishing)
    ) {
      setPendingRetry({ key, epoch: request.epoch, operation });
    }
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
  const inspect = async (destination: MachineResultDestination) => {
    if (
      !resultEnvironmentId ||
      !resultThreadId ||
      resultRequest.current ||
      (destination.kind === "diff" && checkingReturnedReview)
    )
      return;
    const session = appAtomRegistry.get(managedRelaySessionAtom);
    const request = { key };
    resultRequest.current = request;
    const owns = () => {
      const current = appAtomRegistry.get(workflowJobReadAtom).jobs[key]?.job;
      return (
        resultRequest.current === request &&
        appAtomRegistry.get(managedRelaySessionAtom) === session &&
        current?.runtime?.kind === "machine" &&
        current.runtime.environmentId === resultEnvironmentId &&
        current.progress?.threadId === resultThreadId &&
        current.progress.hasThread !== false
      );
    };
    const retry = retryResultButton.current;
    restoreOpeningFocus.current = !!retry && retry.ownerDocument.activeElement === retry;
    setMachineResult({ status: "opening", destination });
    let failure: string | undefined;
    try {
      const result = await openResult({
        threadId: resultThreadId,
        title: selectedJob?.workflow?.definition.name ?? "Workflow result",
        workflowResult: { ...scope, originalEnvironmentId: resultEnvironmentId },
      });
      if (!owns()) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const { environmentId, threadId, workflowVmGeneration } = result.value;
      const params = { environmentId, threadId };
      if (destination.kind === "diff") {
        useDiffPanelStore.getState().selectTurn(params, TurnId.make(destination.checkpoint.turnId));
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
            ...(destination.kind === "diff"
              ? destination.review
                ? { reviewCheckpoint: destination.checkpoint }
                : { savedDiffCheckpoint: destination.checkpoint }
              : {}),
          },
        }),
      });
    } catch (cause) {
      if (owns()) failure = workflowError(cause);
    } finally {
      if (resultRequest.current === request) {
        resultRequest.current = null;
        setMachineResult(
          failure === undefined ? null : { status: "failed", destination, detail: failure },
        );
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
    void refresh(
      responseAccessUnconfirmed && readOnlyCheckpoint
        ? (epoch) =>
            setCheckpointAccessCheck({ key, checkpointId: readOnlyCheckpoint.checkpointId, epoch })
        : undefined,
    );
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
  const publicationOutcome = cancelledVm ? selectedJob.publicationOutcome : undefined;
  const cancellationDetail = selectedJob.detail ?? selectedJob.progress?.detail;
  const publishingCancellationDetail =
    publicationOutcome &&
    cancellationDetail &&
    relayPublishingCancellationDetails.has(cancellationDetail)
      ? cancellationDetail
      : undefined;
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
  const pendingOperation = selectedJob.pendingResponseOperation;
  const acknowledgedResponse =
    manualState.responsePending &&
    (pendingOperation === checkpointOperation || (!input && pendingOperation === "approve"));
  const vmCheckpointRecovery =
    waiting && selectedJob.runtime?.kind === "vm" && selectedJob.vmRecovery
      ? workflowVmRecoveryTask(selectedJob.vmRecovery, acknowledgedResponse)
      : null;
  const showingCheckpointConfirmation =
    checkpointResponsePending &&
    (!vmCheckpointRecovery ||
      (!acknowledgedResponse && !vmRecovery?.pending && !vmRecovery?.warning));
  const checkpointConfirmationTitle = vmCheckpointRecovery
    ? "Waiting for confirmation"
    : (vmRecovery?.title ?? "Waiting for confirmation");
  const responseKind = input ? "answer" : "feedback";
  const matchesPendingResponse =
    selectedJob.pendingResponseId !== undefined &&
    selectedJob.pendingResponseId === ownSend?.acceptedPendingResponseId;
  const submittedResponse =
    checkpointResponsePending &&
    ownSend &&
    (sendingCheckpoint ||
      (selectedJob.runtime?.kind === "vm" ? matchesPendingResponse : ownSend.acceptedPending))
      ? ownSend.text
      : null;
  const responseReceipt =
    submittedResponse === null
      ? undefined
      : {
          text: submittedResponse,
          label: sendingCheckpoint
            ? input
              ? "Answer being sent"
              : "Feedback being sent"
            : vmCheckpointRecovery && matchesPendingResponse
              ? `Saved ${responseKind}`
              : `Your last submitted ${responseKind}`,
        };
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
    (finishing
      ? (canConfigure || manualState.status === "awaiting_review") && completionRetryable
      : manualState.status === "awaiting_review");
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
  const pullRequestUrl = selectedJob.progress?.pullRequestUrl;
  const completionTitle = pullRequestUrl ? "Pull request opened" : "Workflow completed";
  const pullRequestNumber =
    completed && pullRequestUrl ? parseChangeRequestUrl(pullRequestUrl)?.number : undefined;
  const confirmationPending =
    approvalPending || manualState.responsePending || !!selectedJob.pendingManualControl;
  const maintainerRequired =
    readOnlyCheckpoint &&
    !responseAccessUnconfirmed &&
    !canConfigure &&
    readOnlyCheckpoint.role !== "member";
  const maintainerAction = input ? "answer" : "review the result";
  const showCheckpointAccess =
    !checkpointResponsePending &&
    !confirmationPending &&
    (!manualState.checkpointBlocked || manualHold);
  const checkpointAccessMessage =
    readOnlyCheckpoint && showCheckpointAccess
      ? responseAccessUnconfirmed
        ? read.reading
          ? checkingCheckpointAccess
          : unconfirmedCheckpointAccess
        : maintainerRequired
          ? manualHold
            ? `Only a repository maintainer can ${maintainerAction}.`
            : `Waiting for a repository maintainer to ${maintainerAction}.`
          : input
            ? "You don’t have access to answer this checkpoint."
            : "You don’t have access to respond to this review."
      : null;
  const checkpointAccessAnnouncement =
    currentCheckpointAccessCheck && showCheckpointAccess
      ? read.reading
        ? checkingCheckpointAccess
        : read.acceptedReadEpoch !== currentCheckpointAccessCheck.epoch || responseAccessUnconfirmed
          ? unconfirmedCheckpointAccess
          : (checkpointAccessMessage ?? "Your response access is confirmed.")
      : "";
  const running = selectedJob.status === "running";
  const needsInput = selectedJob.status === "awaiting_input";
  const needsReview = selectedJob.status === "awaiting_review" && waiting;
  const paused = selectedJob.status === "paused";
  const activeRetry =
    read.mutation && pendingRetry?.key === key && pendingRetry.epoch === read.epoch
      ? pendingRetry.operation
      : undefined;
  const recovery = workflowCompletionRecovery(
    selectedJob,
    finishing,
    activeRetry === "retry_preparation" ? undefined : activeRetry,
  );
  const recoveryInTask = !!recovery && !terminal && !paused;
  const recoveryRetry = hasResultSave ? "retry_saving" : "approve";
  const canRetryRecovery = hasResultSave
    ? canConfigure && saving.state === "failed" && saving.retryable
    : approval && (selectedJob.runtime?.kind !== "vm" || reviewingCurrentResult);
  const recoveryCard = recovery ? (
    <WorkflowCompletionRecovery
      recovery={recovery}
      action={
        canRetryRecovery && (recovery.blocked || recovery.retrying) ? (
          <Button
            ref={hasResultSave ? retrySavingButton : retryCompletionButton}
            aria-disabled={
              busy ||
              recovery.retrying ||
              manualState.responsePending ||
              (!hasResultSave &&
                (reviewChanged ||
                  checkingReturnedReview ||
                  waitingForSavedReviewRender ||
                  manualState.checkpointBlocked))
            }
            onClick={() => {
              if (!recovery.retrying) void respond(recoveryRetry);
            }}
          >
            <RotateCwIcon aria-hidden />
            {recovery.retrying ? "Retrying…" : hasResultSave ? "Retry saving" : "Retry completion"}
          </Button>
        ) : undefined
      }
    />
  ) : null;
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
      : needsReview
        ? ClipboardCheckIcon
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
  const preparationFailed =
    paused &&
    selectedJob.progress?.status === "paused" &&
    selectedJob.progress.retryablePreparation === true;
  // Older relays report only that a response is pending. An unsaved publication
  // can also have a retry pending, so keep confirmation generic when both coexist.
  const preparationRetryRequested =
    preparationFailed &&
    manualState.responsePending &&
    !selectedJob.pendingResponseOperation &&
    !selectedJob.resultSaveRetryPending &&
    !hasResultSave &&
    !approvalPending;
  const preparationInTask =
    !queuedTask &&
    !publishingFailure &&
    !vmRecovery &&
    !selectedJob.progress?.manualPause &&
    !selectedJob.pendingManualControl &&
    (preparationFailed ||
      (selectedJob.status === "preparing" && !recovery && !confirmationPending));
  const sendingPreparationRetry = activeRetry === "retry_preparation";
  const preparationRetrying = sendingPreparationRetry || preparationRetryRequested;
  const preparationSteps = selectedJob.workflow?.definition.steps;
  const preparingStep =
    selectedJob.progress?.status === "preparing"
      ? preparationSteps?.find(({ id }) => id === selectedJob.progress?.stepId)
      : undefined;
  const preparingWorkspace =
    machine &&
    selectedJob.progress?.generation === 0 &&
    preparingStep?.kind === "agent" &&
    preparingStep === preparationSteps?.find(({ kind }) => kind === "agent");
  const preparationTitle = preparationRetryRequested
    ? "Retry requested"
    : sendingPreparationRetry
      ? "Requesting retry…"
      : preparationFailed
        ? "Couldn’t prepare the workspace"
        : preparingWorkspace
          ? "Preparing the workspace"
          : preparingStep
            ? `Preparing “${preparingStep.title}”`
            : "Preparing run";
  const preparationAnnouncement = paused
    ? [statusLabel, preparationTitle, recovery?.title].filter(Boolean).join(". ")
    : preparationTitle;
  const preparationFailureDetail = selectedJob.progress?.detail ?? detail;
  const preparationRelayDetail =
    selectedJob.detail !== preparationFailureDetail &&
    selectedJob.detail !== "Response saved; waiting for the environment."
      ? selectedJob.detail
      : null;
  const taskTitle = composingFeedback
    ? "Request changes"
    : waiting && (!stepRepeatsWorkflowName || checkpointResponsePending)
      ? (checkpointStep?.title ?? (input ? "Input checkpoint" : "Review checkpoint"))
      : terminal
        ? statusLabel
        : selectedJob.status === "queued"
          ? "Waiting for execution"
          : stepRepeatsWorkflowName
            ? null
            : (checkpointStep?.title ??
              (StatusIcon ? null : workflowStatusLabel(manualState.status ?? selectedJob.status)));
  const conversationInTask = running && !checkpoint;
  const inspectReviewInTask =
    needsReview &&
    !!machine &&
    !manualHold &&
    !confirmationPending &&
    !checkpointResponsePending &&
    !composingFeedback;
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
  const diffCheckpoint = workflowResultCheckpoint(checkpoint);
  const resultOpeningLabel =
    openingResult === "diff" ? "Opening saved diff…" : "Opening conversation…";
  const failedDestination = resultError?.destination;
  const failedDiff = failedDestination?.kind === "diff";
  const earlierDiff =
    failedDestination?.kind === "diff" &&
    diffCheckpoint !== undefined &&
    !sameWorkflowResultCheckpoint(failedDestination.checkpoint, diffCheckpoint);
  const conversationActions =
    resultEnvironmentId && resultThreadId && (!composingFeedback || openingResult) ? (
      <div ref={resultActions} className="flex min-w-0 flex-wrap gap-2 empty:hidden">
        {openingResult === "diff" ||
        (!composingFeedback && diffCheckpoint && (!failedDiff || earlierDiff)) ? (
          <Button
            ref={inspectResultButton}
            variant={
              (waiting && !input && !checkpointResponsePending) || (completed && !pullRequestUrl)
                ? "default"
                : "outline"
            }
            aria-busy={openingResult === "diff" || undefined}
            aria-disabled={openingResult === "diff" || undefined}
            disabled={
              openingResult === "conversation" || (!openingResult && checkingReturnedReview)
            }
            onClick={() => {
              if (diffCheckpoint)
                void inspect({ kind: "diff", checkpoint: diffCheckpoint, review: showingReview });
            }}
          >
            {openingResult === "diff" ? (
              <Spinner aria-hidden />
            ) : completed ? (
              <FileDiffIcon aria-hidden />
            ) : null}
            {openingResult === "diff"
              ? resultOpeningLabel
              : completed
                ? "Inspect result"
                : "Inspect saved diff"}
          </Button>
        ) : null}
        {openingResult === "conversation" ||
        (!composingFeedback && failedDestination?.kind !== "conversation") ? (
          <Button
            ref={conversationButton}
            variant={
              failed ||
              (completed && !pullRequestUrl && (!checkpoint || checkpoint.kind === "input"))
                ? "default"
                : conversationInTask
                  ? "outline"
                  : "ghost"
            }
            aria-busy={openingResult === "conversation" || undefined}
            aria-disabled={openingResult === "conversation" || undefined}
            disabled={openingResult === "diff"}
            onClick={() => void inspect({ kind: "conversation" })}
          >
            {openingResult === "conversation" ? (
              <Spinner aria-hidden />
            ) : completed ? (
              <MessageSquareIcon aria-hidden />
            ) : null}
            {openingResult === "conversation" ? resultOpeningLabel : "Open conversation"}
            {openingResult !== "conversation" && (conversationInTask || failed) ? (
              <ArrowUpRightIcon aria-hidden />
            ) : null}
          </Button>
        ) : null}
      </div>
    ) : null;
  const draftOpen = !manualHold || collapsedDraftKey !== feedbackKey;
  const openSavedResults = () => {
    const results = savedResults.current;
    if (!results) return;
    results.scrollIntoView({ block: "start" });
    results.focus({ preventScroll: true });
  };
  const vmRecoveryActions =
    selectedJob.vmRecovery?.state === "waiting_codex" && organizationAdmin ? (
      <Button
        variant="outline"
        size="sm"
        render={
          <Link
            ref={recoverySettingsLink}
            to="/settings/organization"
            hash={searchableSetting("organization-codex-vms").id}
          />
        }
      >
        <Settings2Icon aria-hidden />
        Open Codex for VMs
      </Button>
    ) : selectedJob.vmRecovery?.state === "recovery_error" &&
      !composingFeedback &&
      savedWorkflowThreadState(selectedJob) === "available" ? (
      <Button ref={savedResultsButton} variant="outline" size="sm" onClick={openSavedResults}>
        <FileDiffIcon aria-hidden />
        Open saved results
      </Button>
    ) : undefined;
  const checkpointResponse = checkpointResponsePending ? (
    <>
      {checkpoint?.kind === "input" ? (
        <p className="text-sm font-medium">{checkpoint.question}</p>
      ) : null}
      {showingCheckpointConfirmation ? (
        <WorkflowAlert
          title={checkpointConfirmationTitle}
          variant={vmRecovery?.warning ? "warning" : "info"}
          announce={false}
        >
          {(!vmCheckpointRecovery && vmRecovery?.message) ||
            (unknownCheckpointResponse
              ? "The run will update when the environment confirms the response."
              : input
                ? "The workflow continues once the environment confirms the answer."
                : "Rework starts once the environment confirms the feedback.")}
        </WorkflowAlert>
      ) : null}
      {responseReceipt && !vmCheckpointRecovery ? (
        <div className="space-y-1 rounded-md border bg-muted/25 px-3 py-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">{responseReceipt.label}</h3>
          <p className="whitespace-pre-wrap text-sm">{responseReceipt.text}</p>
        </div>
      ) : null}
    </>
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
  ) : readOnlyCheckpoint ? (
    <>
      {readOnlyCheckpoint.kind === "input" ? (
        <p className="text-sm font-medium">{readOnlyCheckpoint.question}</p>
      ) : null}
      {checkpointAccessMessage ? (
        <div className="flex items-start gap-2 border-t pt-3 text-sm text-muted-foreground">
          <LockKeyholeIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{checkpointAccessMessage}</p>
        </div>
      ) : null}
    </>
  ) : null;
  return (
    <div className="mx-auto min-w-0 w-full max-w-3xl space-y-6 wrap-anywhere">
      {runNavigation}
      <p role="status" aria-label="Checkpoint response access" className="sr-only">
        {checkpointAccessAnnouncement}
      </p>
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
          {recoveryInTask
            ? recovery.title
            : vmCheckpointRecovery
              ? [
                  ...(showingCheckpointConfirmation ? [checkpointConfirmationTitle] : []),
                  vmCheckpointRecovery.title,
                  vmCheckpointRecovery.message,
                ].join(". ")
              : showingCheckpointConfirmation
                ? checkpointConfirmationTitle
                : queuedTask
                  ? `${statusLabel}. ${queuedTask.title}`
                  : preparationInTask
                    ? preparationAnnouncement
                    : recovery
                      ? `${statusLabel}. ${recovery.title}`
                      : completed
                        ? completionTitle
                        : statusLabel}
        </span>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 ref={runHeading} tabIndex={-1} className="text-xl font-semibold">
            {runName}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            {(!TaskIcon || preparationInTask) &&
            !completed &&
            !vmCheckpointRecovery &&
            !cancelling &&
            !recoveryInTask ? (
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
                      {atCheckpoint ? "Pause at this checkpoint" : "Pause after current step"}
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
        <section
          ref={showingReview ? reviewSection : undefined}
          id={showingReview ? WORKFLOW_REVIEW_ANCHOR : undefined}
          tabIndex={showingReview ? -1 : undefined}
          className={cn(
            "space-y-4",
            vmCheckpointRecovery && "rounded-lg border bg-card p-4 text-card-foreground",
          )}
          aria-label="Current workflow task"
        >
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
              recoveryLinkRef={recoverySettingsLink}
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
          ) : recoveryInTask ? (
            recoveryCard
          ) : preparationInTask ? (
            <WorkflowOutcome
              title={preparationTitle}
              announce={false}
              tone={preparationFailed && !preparationRetrying ? "warning" : "neutral"}
              icon={preparationFailed && !preparationRetrying ? undefined : ClockIcon}
              actions={
                preparationFailed && !preparationRetrying && canConfigure ? (
                  <Button
                    ref={retryPreparationButton}
                    size="sm"
                    variant="outline"
                    disabled={busy || manualState.checkpointBlocked}
                    onClick={() => void respond("retry_preparation")}
                  >
                    <RotateCwIcon aria-hidden />
                    Retry preparation
                  </Button>
                ) : undefined
              }
            >
              <p className="wrap-anywhere">
                {preparationRetryRequested
                  ? target
                    ? `Waiting for ${target.machineLabel} to confirm the retry.`
                    : "Waiting for the environment to confirm the retry."
                  : sendingPreparationRetry
                    ? "Sending the preparation retry request."
                    : preparationFailed
                      ? (preparationFailureDetail ?? "Workspace setup failed.")
                      : (detail ??
                        (preparingStep && !preparingWorkspace
                          ? "Waiting for the execution environment to start this step."
                          : "Waiting for the execution environment to get the run ready."))}
              </p>
              {preparationFailed && preparationRelayDetail ? (
                <p className="wrap-anywhere">{preparationRelayDetail}</p>
              ) : null}
            </WorkflowOutcome>
          ) : completed ? (
            <WorkflowOutcome
              title={completionTitle}
              tone="success"
              icon={pullRequestUrl ? PullRequestGlyph.pullRequest : undefined}
              announce={false}
              actions={
                <>
                  {pullRequestUrl ? (
                    <Button render={<a href={pullRequestUrl} target="_blank" rel="noreferrer" />}>
                      Open pull request
                      <ArrowUpRightIcon aria-hidden />
                    </Button>
                  ) : null}
                  {selectedJob.runtime?.kind === "vm" &&
                  availableSavedResultsKey === key &&
                  savedWorkflowThreadState(selectedJob) === "available" &&
                  (!pullRequestUrl || followUpAction) ? (
                    <Button
                      ref={savedResultsButton}
                      variant={pullRequestUrl ? "outline" : "default"}
                      onClick={openSavedResults}
                    >
                      <FileDiffIcon aria-hidden />
                      Open saved results
                    </Button>
                  ) : pullRequestUrl ? null : (
                    conversationActions
                  )}
                  {followUpAction}
                </>
              }
            >
              {pullRequestNumber !== undefined ? <p>PR #{pullRequestNumber}</p> : null}
            </WorkflowOutcome>
          ) : cancelledVm ? (
            publicationOutcome ? (
              <CancelledVmPublication
                outcome={publicationOutcome}
                detail={publishingCancellationDetail}
                progressPullRequestUrl={pullRequestUrl}
              />
            ) : null
          ) : (
            <div
              className={
                vmCheckpointRecovery
                  ? "space-y-3"
                  : TaskIcon
                    ? "space-y-3 rounded-lg border bg-card p-4 text-card-foreground"
                    : "space-y-3 border-t pt-5"
              }
            >
              {vmCheckpointRecovery ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b pb-3">
                  <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    {input ? (
                      <MessageSquareIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <ClipboardCheckIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    {composingFeedback
                      ? "Request changes"
                      : (checkpointStep?.title ??
                        (input ? "Input checkpoint" : "Review checkpoint"))}
                  </h2>
                  {stepIndex >= 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Step {stepIndex + 1} of {selectedJob.workflow!.definition.steps.length}
                    </p>
                  ) : null}
                </div>
              ) : TaskIcon || (!terminal && stepIndex >= 0) ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {TaskIcon ? (
                    <span
                      aria-hidden={!composingFeedback}
                      className={cn(
                        "inline-flex items-center gap-2 text-sm font-medium",
                        (needsInput || needsReview || composingFeedback) &&
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
              {vmCheckpointRecovery ? (
                <WorkflowVmRecoveryStatus
                  task={vmCheckpointRecovery}
                  receipt={responseReceipt}
                  actions={vmRecoveryActions}
                />
              ) : (
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
              )}
              {checkpointResponse}
              {inspectReviewInTask ? conversationActions : null}
            </div>
          )}
          {selectedJob.status === "queued" && !queuedTask ? (
            <p className="text-sm text-muted-foreground">
              Waiting for an execution target. No steps have started.
            </p>
          ) : null}
          {vmCheckpointRecovery ? null : vmRecovery &&
            !checkpointResponsePending &&
            (!cancelling || vmRecovery.warning) ? (
            <WorkflowAlert
              title={vmRecovery.title}
              variant={vmRecovery.warning ? "warning" : "info"}
            >
              {vmRecovery.message}
            </WorkflowAlert>
          ) : !cancelling &&
            !checkpointResponsePending &&
            (!recoveryInTask || selectedJob.pendingManualControl) &&
            !(preparationInTask && preparationRetryRequested) &&
            !selectedJob.resultSaveRetryPending &&
            manualState.message &&
            !showPauseDetail ? (
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
          !recoveryInTask &&
          !preparationInTask &&
          detail &&
          !(
            checkpointResponsePending && detail === "Response saved; waiting for the environment."
          ) &&
          detail !== vmRecovery?.message &&
          !(pausedBeforeStep && detail === "Waiting for executor capacity.") ? (
            <p className="text-sm text-muted-foreground">{detail}</p>
          ) : null}
          {!cancelling &&
          !hasResultSave &&
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
          viewerControls.canApprove &&
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
          {!completed ? followUpAction : null}
          {!composingFeedback && selectedJob.runtime?.kind === "vm" ? (
            <SavedWorkflowResults
              key={`${scope.accountId}:${scope.repositoryId}:${jobId}`}
              scope={scope}
              job={selectedJob}
              refresh={refresh}
              canConfigure={canConfigure}
              onReviewTargetChange={setReviewingCurrentResult}
              onReviewRenderChange={onSavedReviewRenderChange}
              onResultsAvailableChange={completed ? onSavedResultsAvailableChange : undefined}
              showCancellationDetail={publishingCancellationDetail === undefined}
              resultsRef={savedResults}
            />
          ) : null}
          {!recoveryInTask ? recoveryCard : null}
          {!conversationInTask &&
          !inspectReviewInTask &&
          !failed &&
          !publishingFailure &&
          (!completed || pullRequestUrl)
            ? conversationActions
            : null}
          {/* Keep result feedback in place as the action row moves between run states. */}
          {resultEnvironmentId && resultThreadId ? (
            <span role="status" className="sr-only">
              {openingResult ? resultOpeningLabel : ""}
            </span>
          ) : null}
          {resultError ? (
            <WorkflowAlert
              title={
                earlierDiff
                  ? "Couldn’t open the earlier saved diff"
                  : failedDiff
                    ? "Couldn’t open the saved diff"
                    : "Couldn’t open the conversation"
              }
              actions={
                <Button
                  ref={retryResultButton}
                  variant="outline"
                  size="sm"
                  disabled={failedDiff && checkingReturnedReview}
                  onClick={() => void inspect(resultError.destination)}
                >
                  <RotateCwIcon aria-hidden />
                  {failedDiff ? "Retry saved diff" : "Retry conversation"}
                </Button>
              }
            >
              {resultError.detail}
            </WorkflowAlert>
          ) : null}
          {!recovery &&
          (approval || (waiting && !input && viewerControls.canRespond && !approvalPending)) &&
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
                    waitingForSavedReviewRender ||
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
                        ? "Retry approval"
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
        {!completed && !publicationOutcome && pullRequestUrl ? (
          <a href={pullRequestUrl} target="_blank" rel="noreferrer">
            Open pull request
          </a>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t pt-3">
          <WorkflowProgress
            key={key}
            job={selectedJob}
            recovery={recovery}
            preparing={preparationInTask}
          />
          {!paused ? resumeAction : null}
        </div>
      </div>
    </div>
  );
}
