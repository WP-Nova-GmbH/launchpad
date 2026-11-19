import type { ReactNode } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import {
  isTerminalWorkflowJob,
  workflowAllStepsFinished,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { workflowApprovalPending } from "@t3tools/client-runtime/relay/workflow-responses";
import { cn } from "../../lib/utils";

export type WorkflowRecoveryOperation = "retry_saving" | "approve";

export interface WorkflowRecovery {
  context: string;
  count: string | null;
  title: string;
  description: string;
  details?: ReadonlyArray<string | undefined>;
  blocked: boolean;
  retrying: boolean;
  stepId?: string;
}

export function workflowCompletionRecovery(
  job: RepositoryWorkflowJob,
  finishing: boolean,
  pendingRetry?: WorkflowRecoveryOperation,
): WorkflowRecovery | null {
  const { progress, status } = job;
  if (status === "cancelling") return null;

  const saving = progress?.resultSaving;
  const steps = job.workflow?.definition.steps ?? [];
  const executorDetail = progress?.detail?.trim();
  const relayDetail = job.detail?.trim();
  const distinctRelayDetail =
    relayDetail &&
    relayDetail !== executorDetail &&
    relayDetail !== "Response saved; waiting for the environment."
      ? relayDetail
      : undefined;

  if (saving && saving.state !== "saved") {
    const index = saving.resultId ? steps.findIndex(({ id }) => id === saving.stepId) : -1;
    const step = steps[index];
    const activeAgent =
      step?.kind === "agent" && status === "awaiting_review" && step.id === progress?.stepId;
    const nextTitle = activeAgent ? steps[index + 1]?.title : undefined;
    const queued = saving.state === "failed" && job.resultSaveRetryPending === true;
    const retrying = queued || pendingRetry === "retry_saving";
    const blocked = saving.state === "failed" && !retrying;
    const saveSubject = saving.resultId ? "step result" : "run state";
    const saveError = blocked
      ? saving.detail
          ?.replace(/^(Could not save the result\. )?Retry saving( to continue)?\.$/, "")
          .replace(/ Retry saving( to continue)?\.$/, "")
      : undefined;
    const description = retrying
      ? "Waiting for the environment to confirm the save retry."
      : blocked
        ? nextTitle
          ? `“${nextTitle}” is waiting for this result to be saved.`
          : saveError || `The environment couldn’t save the ${saveSubject}.`
        : nextTitle
          ? `This step finished. “${nextTitle}” starts once the result is saved.`
          : `The environment is saving the ${saveSubject}.`;
    return {
      context: step?.title || (saving.resultId ? "Step result" : "Workflow storage"),
      count: index >= 0 ? `Step ${index + 1} of ${steps.length}` : null,
      title: queued
        ? "Waiting for retry confirmation"
        : blocked
          ? `Couldn’t save ${saveSubject}`
          : `Saving ${saveSubject}`,
      description,
      details: [
        saveError,
        !isTerminalWorkflowJob(status) && status !== "paused"
          ? (distinctRelayDetail ?? executorDetail)
          : undefined,
      ],
      blocked,
      retrying,
      ...(activeAgent ? { stepId: step.id } : {}),
    };
  }

  if (!finishing) return null;
  const retrying = pendingRetry === "approve" || workflowApprovalPending(job);
  // A final check can stop with guidance to cancel even when the executor offers no retry.
  const blocked = !retrying && (progress?.retryableApproval === true || !!executorDetail);
  const completionDetail =
    retrying && progress?.retryableApproval
      ? undefined
      : executorDetail
          ?.replace(
            /^Result verification could not finish\. Retry approval\.$/,
            "The environment couldn’t verify the final result.",
          )
          .replace(/ Retry approval\.$/, "");
  return {
    context: "Final checks",
    count: workflowAllStepsFinished(job)
      ? `${steps.length} of ${steps.length} steps finished`
      : null,
    title: blocked ? "Completion blocked" : "Finishing run",
    description:
      completionDetail ||
      distinctRelayDetail ||
      (blocked
        ? "The environment couldn’t verify the final result."
        : "Waiting for the environment to finish final checks."),
    details: [distinctRelayDetail],
    blocked,
    retrying,
  };
}

export function WorkflowCompletionRecovery({
  recovery,
  action,
}: {
  recovery: WorkflowRecovery;
  action?: ReactNode;
}) {
  const Icon = recovery.blocked ? TriangleAlertIcon : ClockIcon;
  return (
    <div className="rounded-lg border bg-card text-card-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium">{recovery.context}</span>
        {recovery.count ? (
          <span className="text-xs text-muted-foreground">{recovery.count}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2">
          <Icon
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0",
              recovery.blocked ? "text-warning" : "text-info",
            )}
          />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold">{recovery.title}</h2>
            <p className="text-sm text-muted-foreground">{recovery.description}</p>
            {[...new Set(recovery.details)].map((detail) =>
              detail && detail !== recovery.description ? (
                <p key={detail} className="text-xs text-muted-foreground">
                  {detail}
                </p>
              ) : null,
            )}
          </div>
        </div>
        {action}
      </div>
    </div>
  );
}
