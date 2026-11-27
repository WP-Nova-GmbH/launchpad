import type { WorkflowRun } from "./WorkflowRunStore.ts";

export function workflowTask(run: WorkflowRun) {
  const step = run.workflow.definition.steps[run.sequence?.cursor ?? 0];
  const inputs =
    run.sequence?.responses.filter((response) => {
      const index = run.workflow.definition.steps.findIndex(
        (candidate) => candidate.id === response.stepId,
      );
      return (
        response.operation === "input" &&
        index < (run.sequence?.cursor ?? 0) &&
        run.sequence?.completed.some(
          (completed) =>
            completed.stepId === response.stepId && completed.generation === response.generation,
        )
      );
    }) ?? [];
  return {
    stepInstruction: step?.kind === "agent" ? step.instruction : "",
    jobContext: [
      run.instruction,
      ...inputs.map((response) => {
        const input = run.workflow.definition.steps.find((step) => step.id === response.stepId);
        return `Input for ${input?.title} from ${response.userId}:\n${input?.kind === "input" ? input.question : ""}\nAnswer: ${response.text}`;
      }),
      ...(run.sequence?.completed.filter((step) => step.checkpoint).length
        ? [
            `Valid prior Agent results: ${run.sequence.completed
              .filter((step) => step.checkpoint)
              .map((step) => `${step.stepId} (${step.checkpoint!.checkpointRef})`)
              .join(", ")}`,
          ]
        : []),
      ...(run.sequence?.generation
        ? [
            `Rework attempt ${run.sequence.generation + 1}: earlier conversation messages are history. Only the prior results and inputs listed here remain valid; redo this workflow's suffix from the current step.`,
          ]
        : []),
      ...(run.sequence?.feedback ? [`Requested changes: ${run.sequence.feedback}`] : []),
    ].join("\n\n"),
    reviewConstraint:
      "Keep all changes local. Continue only the current workflow step; human review and input checkpoints are handled by the workflow.",
  };
}
