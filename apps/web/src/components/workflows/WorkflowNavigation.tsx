import { isElectron } from "../../env";
import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, LockIcon, WorkflowIcon } from "lucide-react";
import type { ExecutionEnvironmentDescriptor, ThreadWorkflowJob } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  hasUnsavedWorkflowWork,
  workflowJobReadAtom,
  workflowSessionKey,
  workflowStatusLabel,
} from "@t3tools/client-runtime/relay/workflow-session";
import { useManagedRelayOrganizationCatalog } from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { workflowResultGitAccess } from "../../lib/workflowResultGitAccess";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WORKFLOW_REVIEW_ANCHOR } from "./workflowState";
import {
  workflowResultOrigin,
  type WorkflowResultOrigin,
} from "@t3tools/client-runtime/relay/workflow-result";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workflowOrigin?: WorkflowResultOrigin | undefined;
  }
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

export function useWorkflowConversation({
  threadId,
  threadTitle,
  threadJob,
  capabilities,
}: {
  threadId: string | undefined;
  threadTitle: string | undefined;
  threadJob: typeof ThreadWorkflowJob.Type | null | undefined;
  capabilities: ExecutionEnvironmentDescriptor["capabilities"] | undefined;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  const routeOrigin = useLocation({ select: (location) => location.state.workflowOrigin });
  const origin = hasCloudPublicConfig()
    ? workflowResultOrigin({ workflowOrigin: routeOrigin }, session?.accountId, threadId)
    : null;
  const catalog = useManagedRelayOrganizationCatalog({
    allowMissingProjects: true,
    enabled: origin !== null,
  });
  const repository = catalog.data?.repositories.find(
    ({ repository }) =>
      origin &&
      repository.repositoryId === origin.repositoryId &&
      repository.organizationId === origin.organizationId,
  )?.repository;
  const job = useAtomValue(workflowJobReadAtom, (read) =>
    origin && read.accountId === origin.accountId
      ? (read.jobs[workflowSessionKey(origin, origin.jobId)]?.job ?? null)
      : null,
  );
  if (!origin || !repository) return null;

  const review = origin.reviewCheckpoint;
  const checkpoint = job?.progress?.checkpoint;
  const checkpointTitle =
    review && checkpoint?.checkpointId === review.checkpointId
      ? job?.workflow?.definition.steps.find((step) => step.id === checkpoint.stepId)?.title
      : undefined;
  const { workflowVmResultReader: readOnly } = workflowResultGitAccess({
    capabilities,
    origin,
    threadId: threadId ?? null,
  });
  const status =
    threadJob?.jobId === origin.jobId && threadJob.repositoryId === origin.repositoryId
      ? threadJob.status
      : null;
  return {
    origin,
    title: job?.workflow?.definition.name ?? threadTitle ?? "Workflow run",
    repository: repository.name,
    reviewTitle: review ? (checkpointTitle ?? "Review checkpoint") : null,
    readOnly,
    status,
  };
}

export function WorkflowConversationHeader({
  conversation,
}: {
  conversation: NonNullable<ReturnType<typeof useWorkflowConversation>>;
}) {
  const { origin, title, repository, reviewTitle, readOnly, status } = conversation;
  const liveStatus = !readOnly && status ? workflowStatusLabel(status) : null;
  return (
    <WorkspacePageHeader
      electron={isElectron}
      reserveNativeControls={false}
      className="justify-between border-b bg-background max-sm:h-auto max-sm:flex-wrap max-sm:gap-1.5 max-sm:py-1.5"
      style={{ paddingRight: "calc(var(--workspace-controls-right) + var(--spacing) * 25)" }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <WorkflowIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="truncate text-sm leading-tight font-medium">{title}</h2>
          <div className="flex items-center gap-1 text-xs leading-tight text-muted-foreground">
            <span className="truncate">{repository}</span>
            {reviewTitle ? (
              <>
                <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{reviewTitle}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <span role="status" className="sr-only">
        {liveStatus}
      </span>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
        {readOnly ? (
          <Badge variant="secondary">
            <LockIcon aria-hidden="true" />
            {reviewTitle ? "Read-only" : "Read-only result"}
          </Badge>
        ) : liveStatus ? (
          <Badge aria-hidden variant={status === "running" ? "info" : "secondary"}>
            {liveStatus}
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/workflows/$repositoryId/jobs/$jobId"
              params={{ repositoryId: origin.repositoryId, jobId: origin.jobId }}
              hash={reviewTitle ? WORKFLOW_REVIEW_ANCHOR : ""}
              hashScrollIntoView={false}
            />
          }
        >
          <ArrowLeftIcon aria-hidden="true" />
          {reviewTitle ? "Return to review" : "Back to run"}
        </Button>
      </div>
    </WorkspacePageHeader>
  );
}
