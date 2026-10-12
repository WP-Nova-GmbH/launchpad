import type { WorkflowRun } from "./WorkflowRunStore.ts";

export function workflowTask(run: WorkflowRun) {
  return {
    stepInstruction: run.workflow.definition.steps[0].instruction,
    jobContext: run.instruction,
    reviewConstraint:
      "Keep all changes local. The workflow requires human review before further work.",
  };
}
