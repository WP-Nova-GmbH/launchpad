import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useBlocker } from "@tanstack/react-router";
import {
  workflowDraftAtom,
  workflowSessionKey,
  workflowEditorDirty,
  workflowDraftAutomation,
  sameWorkflowAutomation,
  sameWorkflowDefinition,
  discardWorkflowEditor,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/** All application entry points share the router; window close uses the shell's unload guard. */
export function WorkflowEditorDepartureGuard({
  scope,
  id,
  reading,
  onDiscard,
  onCheckSavedVersion,
}: {
  scope: WorkflowScope;
  id: string;
  reading: boolean;
  onDiscard: () => void;
  onCheckSavedVersion: () => void;
}) {
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const drafts = useAtomValue(workflowDraftAtom);
  const current =
    drafts.accountId === scope.accountId
      ? drafts.editors[workflowSessionKey(scope, id)]
      : undefined;
  const unsaved = !!current && (workflowEditorDirty(current) || !!current.operation);
  const blocker = useBlocker({
    withResolver: true,
    enableBeforeUnload: false,
    shouldBlockFn: ({ current, next }) => {
      const state = appAtomRegistry.get(workflowDraftAtom);
      const draft =
        state.accountId === scope.accountId
          ? state.editors[workflowSessionKey(scope, id)]
          : undefined;
      // Create-to-edit keeps this same editor after recovering its first Save.
      const promotion =
        !!draft?.baseline &&
        state.newWorkflowIds[workflowSessionKey(scope, "new")] === id &&
        current.routeId === "/workflows/$repositoryId/new" &&
        next.routeId === "/workflows/$repositoryId/$workflowId/edit" &&
        next.params.repositoryId === scope.repositoryId &&
        next.params.workflowId === id;
      return (
        !promotion &&
        current.pathname !== next.pathname &&
        !!draft &&
        (workflowEditorDirty(draft) || !!draft.operation)
      );
    },
  });
  useEffect(() => {
    if (blocker.status === "blocked" && !unsaved) blocker.proceed();
  }, [blocker, unsaved]);
  const operation = current?.operation;
  const unconfirmed = operation?.state === "uncertain";
  const canCheckSavedVersion = unconfirmed && !reading;
  const name =
    operation?.definition.name.trim() ||
    current?.definition.name.trim() ||
    current?.baseline?.definition.name.trim();
  const workflow = name ? (
    <strong className="font-medium text-popover-foreground">{name}</strong>
  ) : (
    "this workflow"
  );
  const automationAfterSave = operation?.includesAutomation
    ? operation.automation
    : current?.baseline?.automation;
  const hasUnsubmittedEdits =
    current &&
    operation &&
    (!sameWorkflowDefinition(current.definition, operation.definition) ||
      !sameWorkflowAutomation(workflowDraftAutomation(current), automationAfterSave));
  const stayButton = (
    <Button
      key="stay"
      ref={stayButtonRef}
      type="button"
      variant={operation ? "default" : "outline"}
      onClick={() => {
        blocker.reset?.();
        if (canCheckSavedVersion) onCheckSavedVersion();
      }}
    >
      {canCheckSavedVersion ? "Check saved version" : operation ? "Stay" : "Keep editing"}
    </Button>
  );
  const leaveButton = (
    <Button
      key="leave"
      type="button"
      variant={operation ? "outline" : "destructive"}
      onClick={() => {
        onDiscard();
        discardWorkflowEditor(appAtomRegistry, scope, id);
        blocker.proceed?.();
      }}
    >
      {operation ? "Leave anyway" : "Discard and leave"}
    </Button>
  );

  return (
    <AlertDialog
      open={blocker.status === "blocked" && unsaved}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogPopup initialFocus={stayButtonRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {unconfirmed
              ? "Save not confirmed"
              : operation
                ? "Save in progress"
                : "Discard unsaved changes?"}
          </AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">
            {unconfirmed ? (
              <>
                The save for {workflow} may have completed.
                {canCheckSavedVersion ? " Stay in the editor to check the saved version." : null}
              </>
            ) : operation ? (
              <>The save for {workflow} may still complete after you leave.</>
            ) : (
              <>Your unsaved edits to {workflow} will be lost.</>
            )}
            {operation ? (
              <span className="mt-2 block">
                If you leave and the save doesn’t complete, your edits will be lost.
              </span>
            ) : null}
            {hasUnsubmittedEdits ? (
              <span className="mt-2 block">Edits outside that save will be lost if you leave.</span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {operation ? [leaveButton, stayButton] : [stayButton, leaveButton]}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
