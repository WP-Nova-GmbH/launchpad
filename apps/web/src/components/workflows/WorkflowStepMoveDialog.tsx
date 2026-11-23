import { useRef } from "react";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import type { WorkflowStep } from "@t3tools/contracts/workflows";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  workflowMoveStepTitle,
  type WorkflowStepMoveImpact,
  type WorkflowStepMoveLabel,
} from "./workflowStepMove";

function CurrentStepNumber({ stepNumber }: { stepNumber: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-normal text-xs">
      <span className="sr-only">Current position, </span>
      <span>Step {stepNumber}</span>
    </span>
  );
}

function StepLabel({ label }: { label: WorkflowStepMoveLabel }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="min-w-0 wrap-anywhere">{label.title}</span>
      <CurrentStepNumber stepNumber={label.stepNumber} />
    </span>
  );
}

function DependencyChange({
  title,
  before,
  after,
}: {
  title: string;
  before: WorkflowStepMoveLabel;
  after: WorkflowStepMoveLabel | string;
}) {
  return (
    <div>
      <dt className="text-xs">{title}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5 wrap-anywhere">
        <StepLabel label={before} />
        <ArrowRightIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">changes to</span>
        <strong className="min-w-0 font-medium text-foreground">
          {typeof after === "string" ? after : <StepLabel label={after} />}
        </strong>
      </dd>
    </div>
  );
}

function MoveImpact({ impact, moved }: { impact: WorkflowStepMoveImpact; moved: boolean }) {
  const requiresAgent = impact.kind === "publishing" && impact.agent?.after === null;
  const requiresPush = impact.kind === "publishing" && impact.push?.after === null;
  const hasChanges = impact.kind === "review" || !!(impact.agent?.after || impact.push?.after);

  return (
    <div className="space-y-2">
      {requiresAgent || requiresPush ? (
        <Alert variant="warning" controlAlignment="first-line" role={undefined}>
          <TriangleAlertIcon aria-hidden />
          <AlertTitle role="heading" aria-level={2}>
            <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 wrap-anywhere">
              <span>{impact.stepLabel.title} will be blocked</span>
              <CurrentStepNumber stepNumber={impact.stepLabel.stepNumber} />
            </span>
          </AlertTitle>
          <AlertDescription className="wrap-anywhere">
            {requiresAgent
              ? impact.step.kind === "action" && impact.step.action === "open_pull_request"
                ? "An Agent step must come before Push branch, and Push branch must come before Open PR."
                : `An Agent step must come before ${impact.stepLabel.title}.`
              : "A Push branch step must come after the latest Agent and before Open PR."}
          </AlertDescription>
        </Alert>
      ) : null}
      {hasChanges ? (
        <div className="space-y-1.5 rounded-lg border bg-muted/25 px-3 py-2.5">
          {!moved && !requiresAgent && !requiresPush ? (
            <p className="font-medium text-foreground">
              <StepLabel label={impact.stepLabel} />
            </p>
          ) : null}
          <dl className="space-y-2.5">
            {impact.kind === "review" ? (
              <>
                {impact.result ? (
                  <DependencyChange
                    title="Saved result to review"
                    before={impact.result.before}
                    after={impact.result.after ?? "No earlier Agent"}
                  />
                ) : null}
                {impact.rework ? (
                  <DependencyChange
                    title="Send requested changes back to"
                    before={impact.rework.before}
                    after={
                      impact.rework.after ??
                      (impact.result?.after === null
                        ? "Add an Agent step before Review"
                        : "Choose an earlier Agent")
                    }
                  />
                ) : null}
              </>
            ) : (
              <>
                {impact.agent?.after ? (
                  <DependencyChange
                    title="Saved result to publish"
                    before={impact.agent.before}
                    after={impact.agent.after}
                  />
                ) : null}
                {impact.push?.after ? (
                  <DependencyChange
                    title="Publishes after"
                    before={impact.push.before}
                    after={impact.push.after}
                  />
                ) : null}
              </>
            )}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowStepMoveDialog({
  step,
  destination,
  destinationIndex,
  offset,
  impacts,
  blockedReason,
  onKeep,
  onMove,
  finalFocus,
}: {
  step: WorkflowStep;
  destination: WorkflowStep;
  destinationIndex: number;
  offset: -1 | 1;
  impacts: ReadonlyArray<WorkflowStepMoveImpact>;
  blockedReason: string | null;
  onKeep: () => void;
  onMove: () => void;
  finalFocus: () => HTMLElement | boolean;
}) {
  const keepOrder = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onKeep()}>
      <AlertDialogPopup variant="scrollable" initialFocus={keepOrder} finalFocus={finalFocus}>
        <AlertDialogHeader className="min-h-0 overflow-y-auto overscroll-contain">
          <AlertDialogTitle>Move {workflowMoveStepTitle(step)}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-3 text-left">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 wrap-anywhere">
                {offset === -1 ? "Above" : "Below"}{" "}
                <strong className="font-medium text-foreground">
                  {workflowMoveStepTitle(destination)}
                </strong>
              </p>
              <span className="shrink-0 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs">
                Step {destinationIndex + 1}
              </span>
            </div>
            <ul className="space-y-2">
              {impacts.map((impact) => (
                <li key={impact.step.id}>
                  <MoveImpact impact={impact} moved={impact.step.id === step.id} />
                </li>
              ))}
            </ul>
            <p role="status" className={blockedReason ? "text-sm" : "sr-only"}>
              {blockedReason}
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="shrink-0">
          <Button type="button" variant="outline" ref={keepOrder} onClick={onKeep}>
            Keep current order
          </Button>
          <Button type="button" disabled={!!blockedReason} onClick={onMove}>
            Move step
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
