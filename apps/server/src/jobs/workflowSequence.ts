import { WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT } from "@t3tools/contracts/workflows";
import type { WorkflowRun } from "./WorkflowRunStore.ts";

export const activeWorkflowStep = (run: WorkflowRun) =>
  run.workflow.definition.steps[run.sequence?.cursor ?? 0];

export function workflowPromptId(run: WorkflowRun) {
  const sequence = run.sequence;
  return !sequence ||
    (sequence.generation === 0 && !sequence.completed.some((step) => step.checkpoint))
    ? `workflow:${run.jobId}:prompt`
    : `workflow:${run.jobId}:step:${activeWorkflowStep(run)?.id}:${sequence.generation}:prompt`;
}

/** Move only after saving the current step's result or human response. */
export function advanceWorkflow(run: WorkflowRun): WorkflowRun {
  const sequence = run.sequence!;
  const step = activeWorkflowStep(run);
  const latestResult = sequence.completed.findLast((entry) => entry.checkpoint !== null);
  const status = !step
    ? "finishing"
    : step.kind === "agent"
      ? "waiting_capacity"
      : step.kind === "input"
        ? "awaiting_input"
        : "awaiting_review";
  const checkpointId = step
    ? `workflow:${run.jobId}:checkpoint:${step.id}:${sequence.generation}`
    : `workflow:${run.jobId}:completion:${sequence.generation}`;
  const checkpoint =
    step?.kind === "input"
      ? {
          checkpointId,
          kind: "input" as const,
          stepId: step.id,
          generation: sequence.generation,
          role: step.role,
          question: step.question,
        }
      : (step?.kind === "review" || !step) && latestResult?.checkpoint
        ? {
            ...latestResult.checkpoint,
            checkpointId,
            kind: "review" as const,
            stepId: step?.id ?? latestResult.stepId,
            generation: sequence.generation,
            role: step?.kind === "review" ? step.role : ("maintainer" as const),
          }
        : null;
  return {
    ...run,
    promptDispatched: false,
    executionReserved: false,
    preparedHead: latestResult?.head ?? run.preparedHead,
    progress: {
      ...run.progress,
      revision: run.progress.revision + 1,
      status,
      stepId: step?.id,
      generation: sequence.generation,
      checkpoint,
      approvalPending: false,
      retryableApproval: false,
      retryablePreparation: false,
      detail: status === "waiting_capacity" ? "Waiting for executor capacity." : null,
    },
  };
}

/** Summaries are bounded; full answers remain in the environment's durable record. */
export function workflowProgress(run: WorkflowRun): WorkflowRun["progress"] {
  const sequence = run.sequence;
  if (!sequence) return run.progress;
  return {
    ...run.progress,
    hasThread: sequence.started,
    steps: run.workflow.definition.steps.map((step, index) => ({
      stepId: step.id,
      generation:
        sequence.completed.find((entry) => entry.stepId === step.id)?.generation ??
        sequence.generation,
      status: sequence.completed.some((entry) => entry.stepId === step.id)
        ? ("completed" as const)
        : index === sequence.cursor && !["cancelled", "failed"].includes(run.progress.status)
          ? ["running", "preparing"].includes(run.progress.status)
            ? ("running" as const)
            : ("waiting" as const)
          : ("pending" as const),
    })),
    responses: sequence.responses.slice(-100).map((response) => ({
      ...response,
      text: response.text?.slice(0, WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT) ?? null,
    })),
  };
}
