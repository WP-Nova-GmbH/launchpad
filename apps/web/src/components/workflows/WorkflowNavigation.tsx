import { isElectron } from "../../env";
import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  hasUnsavedWorkflowWork,
} from "@t3tools/client-runtime/relay/workflow-session";
import { useManagedRelayOrganizationCatalog } from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import * as Schema from "effect/Schema";

const WorkflowOrigin = Schema.Struct({
  accountId: Schema.String,
  organizationId: Schema.String,
  repositoryId: Schema.String,
  jobId: Schema.String,
  environmentId: Schema.String,
});
const isWorkflowOrigin = Schema.is(WorkflowOrigin);
function workflowOrigin(state: unknown) {
  return typeof state === "object" &&
    state !== null &&
    "workflowOrigin" in state &&
    isWorkflowOrigin(state.workflowOrigin)
    ? state.workflowOrigin
    : null;
}
/** Mounted with the application shell so draft protection also covers result inspection. */
export function WorkflowDraftUnloadGuard() {
  const drafts = useAtomValue(workflowDraftAtom);
  const dirty = hasUnsavedWorkflowWork(drafts);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (isElectron && window.confirm("Close this window and discard unsaved workflow drafts?"))
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return null;
}

export function WorkflowResultReturn() {
  const origin = useLocation({ select: (location) => workflowOrigin(location.state) });
  return origin && hasCloudPublicConfig() ? <ConfiguredWorkflowResultReturn /> : null;
}

function ConfiguredWorkflowResultReturn() {
  const session = useAtomValue(managedRelaySessionAtom);
  const location = useLocation();
  const navigate = useNavigate();
  const catalog = useManagedRelayOrganizationCatalog();
  const origin = workflowOrigin(location.state);
  if (
    !origin ||
    origin.accountId !== session?.accountId ||
    !location.pathname.startsWith(`/${origin.environmentId}/`) ||
    !catalog.data?.repositories.some(
      (entry) =>
        entry.repository.repositoryId === origin.repositoryId &&
        entry.repository.organizationId === origin.organizationId,
    )
  )
    return null;
  return (
    <WorkspacePageHeader electron={isElectron} className="border-b">
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          navigate({
            to: "/workflows/$repositoryId/jobs/$jobId",
            params: { repositoryId: origin.repositoryId, jobId: origin.jobId },
          })
        }
      >
        ← Back to workflow
      </Button>
    </WorkspacePageHeader>
  );
}
