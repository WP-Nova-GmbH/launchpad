import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useBlocker } from "@tanstack/react-router";
import {
  workflowDraftAtom,
  workflowSessionKey,
  workflowEditorDirty,
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
  onDiscard,
}: {
  scope: WorkflowScope;
  id: string;
  onDiscard: () => void;
}) {
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
  const submitted = !!current?.operation;
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your unsaved workflow changes will be lost.
            {submitted ? " A submitted Save may still complete; leaving does not cancel it." : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={() => blocker.reset?.()}>
            Keep editing
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onDiscard();
              discardWorkflowEditor(appAtomRegistry, scope, id);
              blocker.proceed?.();
            }}
          >
            Discard and leave
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
