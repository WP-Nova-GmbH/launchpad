import { isElectron } from "../../env";
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, LockIcon, WorkflowIcon } from "lucide-react";
import type { ExecutionEnvironmentDescriptor, ThreadWorkflowJob } from "@t3tools/contracts";
import {
  isTerminalWorkflowJob,
  workflowIsFinishing,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
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
import { workflowRunsReturnForJob } from "./workflowRunsNavigation";
import { useWorkflowClient, WORKFLOW_REVIEW_ANCHOR } from "./workflowState";
import {
  sameWorkflowResultCheckpoint,
  workflowResultCheckpoint,
  workflowResultOrigin,
  type WorkflowResultCheckpoint,
  type WorkflowResultOrigin,
} from "@t3tools/client-runtime/relay/workflow-result";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workflowOrigin?: WorkflowResultOrigin | undefined;
    workflowReviewReturn?: WorkflowResultCheckpoint | undefined;
    workflowMachineReviewVisitId?: string | undefined;
  }
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
  const accountId = session?.accountId;
  const origin = useMemo(
    () =>
      hasCloudPublicConfig()
        ? workflowResultOrigin({ workflowOrigin: routeOrigin }, accountId, threadId)
        : null,
    [routeOrigin, accountId, threadId],
  );
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

  const status =
    threadJob === undefined
      ? undefined
      : threadJob?.jobId === origin.jobId && threadJob.repositoryId === origin.repositoryId
        ? threadJob.status
        : null;
  const { workflowVmResultReader: readOnly } = workflowResultGitAccess({
    capabilities,
    origin,
    threadId: threadId ?? null,
  });
  return {
    origin,
    title: job?.workflow?.definition.name ?? threadTitle ?? "Workflow run",
    repository: repository.name,
    job,
    readOnly,
    status,
  };
}

export function WorkflowConversationHeader({
  conversation,
}: {
  conversation: NonNullable<ReturnType<typeof useWorkflowConversation>>;
}) {
  const { origin, title, repository, readOnly, status } = conversation;
  const call = useWorkflowClient(origin);
  const runsReturn = useLocation({ select: ({ state }) => state.workflowRunsReturn });
  const returnContext = workflowRunsReturnForJob(origin, origin.jobId, runsReturn);
  const review = origin.reviewCheckpoint;
  const machineReviewVisitId = useLocation({
    select: ({ state }) => state.workflowMachineReviewVisitId,
  });
  const vmReview =
    !machineReviewVisitId &&
    (origin.workflowVmResultReader === true || origin.reviewVisitId !== undefined);
  const reviewReadSource = useMemo(
    () =>
      review &&
      !vmReview &&
      (status === undefined || status === "awaiting_review" || status === "paused")
        ? { origin, call }
        : null,
    [review, vmReview, status, origin, call],
  );
  const [reviewRead, setReviewRead] = useState<{
    source: NonNullable<typeof reviewReadSource>;
    job: RepositoryWorkflowJob;
  } | null>(null);
  useEffect(() => {
    if (!reviewReadSource) return;
    const { origin, call } = reviewReadSource;
    let disposed = false;
    let reading = false;
    // Reviews can advance without a thread status change, including between adjacent Review steps.
    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const job = await call((client, token) =>
          client.getWorkflowJob({
            clerkToken: token,
            repositoryId: origin.repositoryId,
            jobId: origin.jobId,
          }),
        );
        if (!disposed) setReviewRead({ source: reviewReadSource, job });
      } catch {
        if (!disposed) setReviewRead(null);
      } finally {
        reading = false;
      }
    };
    const refreshOnVisibility = () => void refresh();
    void refresh();
    const timer = window.setInterval(refreshOnVisibility, 5000);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [reviewReadSource]);
  const freshJob = reviewRead?.source === reviewReadSource ? reviewRead.job : null;
  const job = freshJob ?? conversation.job;
  const checkpoint = job?.progress?.checkpoint;
  const current = workflowResultCheckpoint(checkpoint);
  const pinned = review ?? origin.savedDiffCheckpoint;
  const matchesCurrent = pinned && current && sameWorkflowResultCheckpoint(pinned, current);
  const activeMachineReview =
    freshJob?.runtime?.kind === "machine" &&
    freshJob.progress?.threadId === origin.threadId &&
    !isTerminalWorkflowJob(freshJob.status) &&
    freshJob.status !== "cancelling" &&
    !workflowIsFinishing(freshJob) &&
    (!freshJob.progress.resultSaving || freshJob.progress.resultSaving.state === "saved") &&
    (freshJob.progress.underlyingStatus ?? freshJob.progress.status) === "awaiting_review";
  const returnToReview = !!review && (vmReview || (!!matchesCurrent && activeMachineReview));
  const reviewTitle =
    returnToReview && checkpoint?.checkpointId === review?.checkpointId
      ? job?.workflow?.definition.steps.find((step) => step.id === checkpoint?.stepId)?.title
      : undefined;
  const checkpointTitle = returnToReview
    ? (reviewTitle ?? "Review checkpoint")
    : pinned
      ? job && !matchesCurrent
        ? "Earlier checkpoint"
        : "Saved checkpoint"
      : null;
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
            {checkpointTitle ? (
              <>
                <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{checkpointTitle}</span>
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
            {returnToReview ? "Read-only" : "Read-only result"}
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
              hash={returnToReview ? WORKFLOW_REVIEW_ANCHOR : ""}
              state={{
                ...(review && !vmReview
                  ? {
                      workflowReviewReturn: review,
                      workflowMachineReviewVisitId: machineReviewVisitId,
                    }
                  : {}),
                ...(returnContext ? { workflowRunsReturn: returnContext } : {}),
              }}
              hashScrollIntoView={false}
            />
          }
        >
          <ArrowLeftIcon aria-hidden="true" />
          {returnToReview ? "Return to review" : "Back to run"}
        </Button>
      </div>
    </WorkspacePageHeader>
  );
}
