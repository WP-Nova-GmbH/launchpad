import { useRef } from "react";
import type { WorkflowStep } from "@t3tools/contracts/workflows";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { WorkflowAlert } from "./WorkflowAlert";
import { workflowRemovalStepLabel, type WorkflowStepRemovalImpact } from "./workflowStepRemoval";

function removalImpactCopy(steps: ReadonlyArray<WorkflowStep>, impact: WorkflowStepRemovalImpact) {
  const name = workflowRemovalStepLabel(steps, impact.step);
  switch (impact.kind) {
    case "review-agent":
      return {
        title: `${name} loses its rework Agent`,
        detail: "Add or move an Agent before this Review step.",
      };
    case "review-rework":
      return {
        title: `${name} loses its rework Agent`,
        detail: impact.resultReplacement
          ? `Choose another earlier Agent to handle requested changes. This step will review the saved result from ${workflowRemovalStepLabel(steps, impact.resultReplacement)}.`
          : "Choose another earlier Agent to handle requested changes.",
      };
    case "review-result":
      return {
        title: `${name} will inspect a different saved result`,
        detail: `This step will review the saved result from ${workflowRemovalStepLabel(steps, impact.replacement)}.`,
      };
    case "review-retargeted":
      return {
        title: `${name} will send rework to ${workflowRemovalStepLabel(steps, impact.replacement)}`,
        detail: `This step will also review the saved result from ${workflowRemovalStepLabel(steps, impact.replacement)}.`,
      };
    case "publishing-agent":
      return {
        title: `${name} will be blocked`,
        detail: "Add or move an Agent before this publishing step.",
      };
    case "publishing-push":
      return {
        title: `${name} will be blocked`,
        detail: `Add Push branch after the latest Agent and before ${name}.`,
      };
    case "publishing-retargeted":
      return {
        title: `${name} will publish a different saved result`,
        detail: `This step will use the saved result from ${workflowRemovalStepLabel(steps, impact.replacement)}.`,
      };
  }
}

export function WorkflowStepRemovalDialog({
  step,
  steps,
  impacts,
  blockedReason,
  onKeep,
  onRemove,
  finalFocus,
}: {
  step: WorkflowStep;
  steps: ReadonlyArray<WorkflowStep>;
  impacts: ReadonlyArray<WorkflowStepRemovalImpact>;
  blockedReason: string | null;
  onKeep: () => void;
  onRemove: () => void;
  finalFocus: () => HTMLElement | boolean;
}) {
  const keepStep = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <AlertDialogPopup variant="scrollable" initialFocus={keepStep} finalFocus={finalFocus}>
        <AlertDialogHeader className="min-h-0 overflow-y-auto overscroll-contain">
          <AlertDialogTitle>Remove {workflowRemovalStepLabel(steps, step)}?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-2">
            <ul className="space-y-2">
              {impacts.map((impact) => {
                const { title, detail } = removalImpactCopy(steps, impact);
                return (
                  <li key={impact.step.id}>
                    <WorkflowAlert title={title} variant="warning" announce={false}>
                      {detail}
                    </WorkflowAlert>
                  </li>
                );
              })}
            </ul>
            <p role="status" className={blockedReason ? "text-sm" : "sr-only"}>
              {blockedReason}
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="shrink-0">
          <Button type="button" variant="outline" ref={keepStep} onClick={onKeep}>
            Keep step
          </Button>
          <Button type="button" variant="destructive" disabled={!!blockedReason} onClick={onRemove}>
            Remove step
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
