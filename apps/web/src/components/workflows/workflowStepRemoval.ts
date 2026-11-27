import { workflowPublishingPrerequisites, type WorkflowStep } from "@t3tools/contracts/workflows";

export type WorkflowStepRemovalImpact =
  | {
      kind: "review-agent" | "publishing-agent" | "publishing-push";
      step: WorkflowStep;
    }
  | { kind: "review-rework"; step: WorkflowStep; resultReplacement?: WorkflowStep }
  | {
      kind: "review-result" | "review-retargeted" | "publishing-retargeted";
      step: WorkflowStep;
      replacement: WorkflowStep;
    };

function stepTitle(step: WorkflowStep) {
  return step.title.trim() || "Untitled step";
}

export function workflowRemovalStepLabel(steps: ReadonlyArray<WorkflowStep>, step: WorkflowStep) {
  const title = stepTitle(step);
  const index = steps.findIndex(({ id }) => id === step.id);
  return index >= 0 &&
    steps.some((candidate) => candidate.id !== step.id && stepTitle(candidate) === title)
    ? `${title} (step ${index + 1})`
    : title;
}

export function workflowStepRemovalImpacts(
  steps: ReadonlyArray<WorkflowStep>,
  removedId: string,
): ReadonlyArray<WorkflowStepRemovalImpact> {
  const removedIndex = steps.findIndex((step) => step.id === removedId);
  const removed = steps[removedIndex];
  if (removed?.kind !== "agent" && !(removed?.kind === "action" && removed.action === "push"))
    return [];

  const remaining = steps.filter((step) => step.id !== removedId);
  const impacts: WorkflowStepRemovalImpact[] = [];
  for (const [index, step] of remaining.entries()) {
    if (index < removedIndex) continue;
    if (step.kind === "review" && removed.kind === "agent") {
      const previous = steps
        .slice(0, index + 1)
        .findLast((candidate) => candidate.kind === "agent");
      const changesResult = previous?.id === removedId;
      const losesRework = step.reworkStepId === removedId;
      if (!changesResult && !losesRework) continue;
      const replacement = remaining
        .slice(0, index)
        .findLast((candidate) => candidate.kind === "agent");
      if (!replacement) impacts.push({ kind: "review-agent", step });
      else if (losesRework)
        impacts.push({
          kind: "review-rework",
          step,
          ...(changesResult ? { resultReplacement: replacement } : {}),
        });
      else
        impacts.push({
          kind: step.reworkStepId ? "review-result" : "review-retargeted",
          step,
          replacement,
        });
    } else if (step.kind === "action") {
      const before = workflowPublishingPrerequisites(steps, index + 1);
      const after = workflowPublishingPrerequisites(remaining, index);
      if (before.agent && !after.agent) impacts.push({ kind: "publishing-agent", step });
      else if (step.action === "open_pull_request" && before.push && !after.push)
        impacts.push({ kind: "publishing-push", step });
      else if (
        before.agent?.id === removedId &&
        after.agent &&
        (step.action === "push" || (before.push && after.push))
      )
        impacts.push({ kind: "publishing-retargeted", step, replacement: after.agent });
    }
  }
  return impacts;
}
