import type { WorkflowStep, WorkflowTarget } from "@t3tools/contracts/workflows";
import { Button } from "../ui/button";
import { WorkflowAlert } from "./WorkflowAlert";

export function WorkflowTargetSwitchNotice({
  destination,
  steps,
  issues,
  disabled,
  onReviewModel,
  registerReviewButton,
}: {
  destination?: WorkflowTarget["kind"];
  steps: ReadonlyArray<WorkflowStep>;
  issues: ReadonlyArray<{ stepId: string; detail: string }>;
  disabled: boolean;
  onReviewModel: (stepId: string, opener: HTMLButtonElement) => void;
  registerReviewButton?: (stepId: string, node: HTMLButtonElement | null) => void;
}) {
  if (!issues.length) return null;

  return (
    <WorkflowAlert title="Agent models need attention" variant="warning">
      {destination === "vm" ? (
        <p className="mb-2">Review these models before saving the switch.</p>
      ) : null}
      <ul className="divide-y divide-warning/25">
        {issues.map((issue) => {
          const stepIndex = steps.findIndex((step) => step.id === issue.stepId);
          const step = steps[stepIndex];
          const model = step?.kind === "agent" ? step.modelSelection?.model : undefined;
          const name = step?.title.trim();
          const stepLabel = stepIndex >= 0 ? `Agent step ${stepIndex + 1}` : "Agent step";
          const title = name ? `${stepLabel}: ${name}` : stepLabel;
          return (
            <li
              key={issue.stepId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">{title}</p>
                <p className="text-xs text-foreground">
                  {model ? (
                    <>
                      <span className="font-mono">{model}</span>{" "}
                    </>
                  ) : null}
                  {issue.detail}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Review model for ${title}`}
                disabled={disabled}
                data-workflow-validation-action
                ref={
                  registerReviewButton
                    ? (node) => registerReviewButton(issue.stepId, node)
                    : undefined
                }
                onClick={(event) => onReviewModel(issue.stepId, event.currentTarget)}
              >
                Review model
              </Button>
            </li>
          );
        })}
      </ul>
    </WorkflowAlert>
  );
}
