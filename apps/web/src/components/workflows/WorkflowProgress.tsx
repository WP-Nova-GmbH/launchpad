import { isTerminalWorkflowJob, type RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { workflowApprovalPending } from "@t3tools/client-runtime/relay/workflow-responses";
import {
  workflowStatusLabel,
  workflowStepState,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  ActivityIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  MinusIcon,
  SquareIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

const completedStep = { label: "Completed", Icon: CheckIcon, tone: "text-success-foreground" };
const upcomingStep = { label: "Upcoming", Icon: MinusIcon, tone: "text-muted-foreground" };
const notReachedStep = { ...upcomingStep, label: "Not reached" };
const incompleteStep = { ...upcomingStep, label: "Incomplete" };
const unknownStep = { ...upcomingStep, label: "Status unavailable" };
const activeStep = { Icon: ActivityIcon, tone: "text-info-foreground" };
const waitingStep = { Icon: ClockIcon, tone: "text-warning-foreground" };
const attentionStep = { Icon: CircleAlertIcon, tone: "text-error-foreground" };

function workflowProgressStatus(job: RepositoryWorkflowJob, allStepsComplete: boolean) {
  const { status, progress, pendingManualControl, pendingResponseOperation } = job;
  if (status === "failed") return { ...attentionStep, label: "Failed" };
  if (status === "cancelled") return { ...upcomingStep, Icon: SquareIcon, label: "Canceled" };
  if (status === "done" || status === "cancelling")
    return { ...activeStep, label: workflowStatusLabel(status) };

  if (pendingManualControl) {
    return {
      ...waitingStep,
      label: pendingManualControl.operation === "pause" ? "Pause requested" : "Resume requested",
    };
  }

  const saving = progress?.resultSaving?.state;
  if (saving === "failed") return { ...attentionStep, label: "Couldn’t save result" };
  if (saving === "saving") return { ...activeStep, label: "Saving result" };

  const approvalPending = workflowApprovalPending(job);
  if (status === "finishing" || (status === "awaiting_review" && allStepsComplete)) {
    return progress?.retryableApproval && !approvalPending
      ? { ...attentionStep, label: "Completion needs attention" }
      : { ...activeStep, label: "Finishing" };
  }

  if (status === "awaiting_input" || status === "awaiting_review") {
    if (status === "awaiting_review" && approvalPending)
      return { ...waitingStep, label: "Approval pending" };
    if (
      (status === "awaiting_input" && pendingResponseOperation === "input") ||
      (status === "awaiting_review" && pendingResponseOperation === "request_changes")
    )
      return { ...waitingStep, label: "Response pending" };
    if (job.responsePending && pendingResponseOperation === undefined)
      return { ...waitingStep, label: "Waiting for confirmation" };
    if (status === "awaiting_review" && progress?.retryableApproval)
      return { ...attentionStep, label: "Approval needs attention" };

    return {
      ...waitingStep,
      label: status === "awaiting_input" ? "Waiting for input" : "Waiting for review",
    };
  }

  return { ...activeStep, label: workflowStatusLabel(status) };
}

export function WorkflowProgress({ job }: { job: RepositoryWorkflowJob }) {
  const steps = job.workflow?.definition.steps;
  if (!steps?.length) return null;

  const progress = job.progress;
  const recordedSteps = new Set(progress?.steps?.map(({ stepId }) => stepId));
  const rows = steps.map((step) => ({
    step,
    state: recordedSteps.has(step.id) ? workflowStepState(job, step.id) : null,
  }));
  const complete = rows.filter(({ state }) => state === "completed").length;
  const hasCompleteCount = rows.every(({ state }) => state !== null);
  const failed = job.status === "failed";
  const canceled = job.status === "cancelled";
  const stopped = failed || canceled;
  const terminal = isTerminalWorkflowJob(job.status);
  const waitingForInput = job.status === "awaiting_input";
  const waitingForReview = job.status === "awaiting_review";
  const waiting = waitingForInput || waitingForReview;
  const saving = progress?.resultSaving?.state;
  const resultSavePending = saving === "saving" || saving === "failed";
  const checkpoint = progress?.checkpoint;
  const waitingKind = waitingForInput ? "input" : "review";
  const checkpointStepId =
    waiting && checkpoint && (checkpoint.kind ?? "review") === waitingKind
      ? checkpoint.stepId
      : undefined;
  const reportedStep = resultSavePending
    ? (progress?.stepId ?? checkpointStepId)
    : (checkpointStepId ?? progress?.stepId);
  const activeRows = rows.filter(({ state }) => state === "running" || state === "waiting");
  const currentId =
    reportedStep ?? (!terminal && activeRows.length === 1 ? activeRows[0]?.step.id : undefined);
  const currentIndex = rows.findIndex(
    ({ step, state }) =>
      step.id === currentId &&
      state !== "completed" &&
      (!waiting || resultSavePending || step.kind === waitingKind),
  );
  const pointedStep = rows[currentIndex];
  const current =
    !terminal || (stopped && (progress?.hasThread !== false || pointedStep?.step.kind === "input"))
      ? pointedStep
      : undefined;

  const currentStep = workflowProgressStatus(job, hasCompleteCount && complete === steps.length);
  const statusLabel = currentStep.label;
  const title = current?.step.title || "Untitled step";
  let context = statusLabel;
  if (current) {
    if (stopped) context = `${statusLabel} at ${title}`;
    else if (statusLabel === "Approval pending" || statusLabel === "Response pending")
      context = `${statusLabel} for ${title}`;
    else if (statusLabel === "Waiting for input") context = `${title} needs an answer`;
    else if (statusLabel === "Waiting for review") context = `${title} needs a decision`;
    else if (statusLabel === "Running") context = `${title} is running`;
    else context = `${title} (${statusLabel})`;
  }

  const completionCount = hasCompleteCount ? `${complete} of ${steps.length} steps complete` : null;
  const reworked =
    (progress?.generation ?? 0) > 0 || progress?.steps?.some(({ generation }) => generation > 0);
  const laterStep = reworked
    ? { ...notReachedStep, label: "Not reached on this attempt" }
    : notReachedStep;

  return (
    <div className="min-w-0 flex-[1_1_20rem]">
      <span role="status" className="sr-only">
        {completionCount ? `${context}. ${completionCount}` : current ? context : null}
      </span>
      <details
        aria-label="Run progress"
        className="group rounded-lg border bg-muted/20 text-sm wrap-anywhere"
      >
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 rounded-md px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[auto_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 self-center text-muted-foreground group-open:rotate-90"
          />
          <span className="font-medium">Workflow progress</span>
          {completionCount ? (
            <span className="col-start-2 text-xs text-muted-foreground sm:col-start-3">
              {completionCount}
            </span>
          ) : null}
          <span className="col-start-2 col-end-3 text-xs text-muted-foreground sm:col-end-4">
            {context}
          </span>
        </summary>
        <ol aria-label="Workflow steps" className="divide-y border-t">
          {rows.map((row, index) => {
            const isCurrent = row === current;
            let presentation = unknownStep;
            if (row.state === "completed") presentation = completedStep;
            else if (isCurrent) presentation = currentStep;
            else if (stopped && row.state !== null) {
              presentation =
                pointedStep && index > currentIndex && row.state === "pending"
                  ? laterStep
                  : incompleteStep;
            } else if (!terminal && row.state === "pending") presentation = upcomingStep;
            const { label, Icon, tone } = presentation;
            return (
              <li
                key={row.step.id}
                aria-current={isCurrent && !terminal ? "step" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-2 px-4 py-2",
                  isCurrent && "bg-muted/40",
                )}
              >
                <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
                <span className={cn("min-w-0 flex-1", isCurrent && "font-medium")}>
                  {row.step.title || "Untitled step"}
                </span>
                <span className={cn("max-w-32 text-right text-xs", tone)}>{label}</span>
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}
