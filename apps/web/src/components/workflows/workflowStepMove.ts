import { workflowPublishingPrerequisites, type WorkflowStep } from "@t3tools/contracts/workflows";

export type WorkflowStepMoveLabel = { title: string; stepNumber: number };

type DependencyChange = { before: WorkflowStepMoveLabel; after: WorkflowStepMoveLabel | null };

export type WorkflowStepMoveImpact = { step: WorkflowStep; stepLabel: WorkflowStepMoveLabel } & (
  | { kind: "review"; result: DependencyChange | null; rework: DependencyChange | null }
  | { kind: "publishing"; agent: DependencyChange | null; push: DependencyChange | null }
);

export function workflowMoveStepTitle(step: WorkflowStep) {
  return step.title.trim() || "Untitled step";
}

function reviewDependencies(
  steps: ReadonlyArray<WorkflowStep>,
  index: number,
  reworkStepId: string | undefined,
) {
  const agents = steps.slice(0, index).filter((step) => step.kind === "agent");
  const result = agents.at(-1);
  return {
    result,
    rework: reworkStepId ? agents.find((agent) => agent.id === reworkStepId) : result,
  };
}

export function workflowStepMoveImpacts(
  before: ReadonlyArray<WorkflowStep>,
  after: ReadonlyArray<WorkflowStep>,
): ReadonlyArray<WorkflowStepMoveImpact> {
  // Keep the position from the current order to distinguish steps even when their titles match.
  function label(step: WorkflowStep): WorkflowStepMoveLabel {
    return {
      title: workflowMoveStepTitle(step),
      stepNumber: before.findIndex((candidate) => candidate.id === step.id) + 1,
    };
  }

  function changed(previous: WorkflowStep | undefined, next: WorkflowStep | undefined) {
    return previous && previous.id !== next?.id
      ? { before: label(previous), after: next ? label(next) : null }
      : null;
  }

  const impacts: WorkflowStepMoveImpact[] = [];
  for (const [index, step] of after.entries()) {
    const previousIndex = before.findIndex((candidate) => candidate.id === step.id);
    if (previousIndex < 0) continue;

    if (step.kind === "review") {
      const previous = reviewDependencies(before, previousIndex, step.reworkStepId);
      const next = reviewDependencies(after, index, step.reworkStepId);
      const result = changed(previous.result, next.result);
      const rework = changed(previous.rework, next.rework);
      if (result || rework)
        impacts.push({ kind: "review", step, stepLabel: label(step), result, rework });
    } else if (step.kind === "action") {
      const previous = workflowPublishingPrerequisites(before, previousIndex);
      const usesPush = step.action === "open_pull_request";
      const next = workflowPublishingPrerequisites(after, index);
      // An already-blocked PR can still lose its Agent. Retargeting is meaningful once publishing is ready.
      const agent =
        !usesPush || previous.push || !next.agent ? changed(previous.agent, next.agent) : null;
      const push = usesPush ? changed(previous.push, next.push) : null;
      if (agent || push)
        impacts.push({ kind: "publishing", step, stepLabel: label(step), agent, push });
    }
  }
  return impacts;
}
