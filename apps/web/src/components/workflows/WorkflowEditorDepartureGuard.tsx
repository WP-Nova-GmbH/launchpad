import { useCallback, useEffect, useRef, type RefObject } from "react";
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
  saveRecoveryFocusRef,
  onDepart,
  onDeparturePendingChange,
  onCheckSavedVersion,
}: {
  scope: WorkflowScope;
  id: string;
  reading: boolean;
  saveRecoveryFocusRef?: RefObject<HTMLButtonElement | null>;
  onDepart: () => void;
  onDeparturePendingChange: (pending: boolean) => void;
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
      const leavingCreate =
        current.routeId === "/workflows/$repositoryId/new" &&
        current.params.repositoryId === scope.repositoryId;
      const promotion =
        !!draft?.baseline &&
        state.newWorkflowIds[workflowSessionKey(scope, "new")] === id &&
        leavingCreate &&
        next.routeId === "/workflows/$repositoryId/$workflowId/edit" &&
        next.params.repositoryId === scope.repositoryId &&
        next.params.workflowId === id;
      const needsConfirmation =
        !promotion &&
        current.pathname !== next.pathname &&
        !!draft &&
        (workflowEditorDirty(draft) || !!draft.operation);
      if (needsConfirmation && leavingCreate) onDeparturePendingChange(true);
      return needsConfirmation;
    },
  });
  // A receipt can establish the first saved version while this departure is blocked.
  const leavingNewDraft =
    blocker.status === "blocked" &&
    blocker.current.routeId === "/workflows/$repositoryId/new" &&
    blocker.current.params.repositoryId === scope.repositoryId;
  const canKeepDraft =
    !!current &&
    (!current.baseline || leavingNewDraft) &&
    drafts.newWorkflowIds[workflowSessionKey(scope, "new")] === id;
  // Reset and receipt settlement can render before the router drops this resolver.
  const resolvedExit = useRef<(() => void) | undefined>(undefined);
  const leave = useCallback(
    (discard: boolean) => {
      if (blocker.status !== "blocked" || resolvedExit.current === blocker.proceed) return;
      resolvedExit.current = blocker.proceed;
      onDepart();
      if (discard) discardWorkflowEditor(appAtomRegistry, scope, id);
      blocker.proceed();
      onDeparturePendingChange(false);
    },
    [blocker, id, onDepart, onDeparturePendingChange, scope],
  );
  const stay = () => {
    if (blocker.status !== "blocked" || resolvedExit.current === blocker.proceed) return false;
    resolvedExit.current = blocker.proceed;
    blocker.reset();
    onDeparturePendingChange(false);
    return true;
  };
  useEffect(() => {
    if (!unsaved) leave(false);
  }, [leave, unsaved]);
  const operation = current?.operation;
  const unconfirmed = operation?.state === "uncertain";
  const saveConflict = current?.saveRecovery === "conflict";
  const knownSaveOutcome = unconfirmed && (saveConflict || current?.saveRecovery === "retryable");
  const canCheckSavedVersion = unconfirmed && !knownSaveOutcome && !reading;
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
    !knownSaveOutcome &&
    (!sameWorkflowDefinition(current.definition, operation.definition) ||
      !sameWorkflowAutomation(workflowDraftAutomation(current), automationAfterSave));
  const stayButton = (
    <Button
      key="stay"
      ref={stayButtonRef}
      type="button"
      variant={operation && !canKeepDraft ? "default" : "outline"}
      onClick={() => {
        if (stay() && canCheckSavedVersion) onCheckSavedVersion();
      }}
    >
      {canCheckSavedVersion
        ? "Check saved version"
        : operation && !knownSaveOutcome
          ? "Stay"
          : "Keep editing"}
    </Button>
  );
  const leaveButton = (
    <Button
      key="leave"
      type="button"
      variant={operation && !canKeepDraft ? "outline" : "destructive"}
      onClick={() => leave(true)}
    >
      {operation && !knownSaveOutcome && !canKeepDraft ? "Leave anyway" : "Discard and leave"}
    </Button>
  );
  const keepDraftButton = (
    <Button key="keep" type="button" onClick={() => leave(false)}>
      Keep draft and leave
    </Button>
  );

  return (
    <AlertDialog
      open={blocker.status === "blocked" && unsaved}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogPopup
        initialFocus={stayButtonRef}
        finalFocus={knownSaveOutcome ? saveRecoveryFocusRef : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {knownSaveOutcome
              ? saveConflict
                ? "Saved version changed"
                : "Save didn’t land"
              : unconfirmed
                ? "Save not confirmed"
                : operation
                  ? "Save in progress"
                  : canKeepDraft
                    ? "Leave this draft?"
                    : "Discard unsaved changes?"}
          </AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">
            {knownSaveOutcome ? (
              <>
                The saved version of {workflow} {saveConflict ? "changed" : "is unchanged"}.
                {canKeepDraft ? null : " Your unsaved edits will be lost if you leave."}
              </>
            ) : unconfirmed ? (
              <>
                The save for {workflow} may have completed.
                {canCheckSavedVersion ? " Stay in the editor to check the saved version." : null}
              </>
            ) : operation ? (
              <>The save for {workflow} may still complete after you leave.</>
            ) : canKeepDraft ? (
              <>You have unsaved edits to {workflow}.</>
            ) : (
              <>Your unsaved edits to {workflow} will be lost.</>
            )}
            {canKeepDraft ? (
              <span className="mt-2 block">
                Keep the draft to resume it from the workflow catalog. Discarding removes your
                unsaved edits.
              </span>
            ) : null}
            {operation && !knownSaveOutcome && !canKeepDraft ? (
              <span className="mt-2 block">
                If you leave and the save doesn’t complete, your edits will be lost.
              </span>
            ) : null}
            {hasUnsubmittedEdits && !canKeepDraft ? (
              <span className="mt-2 block">Edits outside that save will be lost if you leave.</span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {canKeepDraft
            ? [leaveButton, stayButton, keepDraftButton]
            : operation
              ? [leaveButton, stayButton]
              : [stayButton, leaveButton]}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
