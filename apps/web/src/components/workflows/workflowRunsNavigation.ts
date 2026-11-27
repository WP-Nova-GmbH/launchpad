import {
  workflowSessionKey,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import type { WorkflowJobListView } from "@t3tools/contracts/workflows";

export interface WorkflowRunsReturn {
  scopeKey: string;
  view: WorkflowJobListView;
  row: {
    jobId: string;
    createdAt?: string;
    index: number;
    nextJobId?: string;
    previousJobId?: string;
  } | null;
  loadedCount: number;
  scrollTop: number;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    workflowRunsReturn?: WorkflowRunsReturn | undefined;
  }
}

export function workflowRunsReturnForJob(
  scope: WorkflowScope,
  jobId: string | undefined,
  returnContext: WorkflowRunsReturn | undefined,
) {
  return jobId !== undefined &&
    returnContext?.scopeKey === workflowSessionKey(scope, "runs") &&
    returnContext.row?.jobId === jobId
    ? returnContext
    : undefined;
}

export function workflowRunsBackLocation(
  scope: WorkflowScope,
  jobId: string | undefined,
  returnContext: WorkflowRunsReturn | undefined,
) {
  const workflowRunsReturn: WorkflowRunsReturn = workflowRunsReturnForJob(
    scope,
    jobId,
    returnContext,
  ) ?? {
    scopeKey: workflowSessionKey(scope, "runs"),
    view: "active",
    row: null,
    loadedCount: 0,
    scrollTop: 0,
  };
  return {
    to: "/workflows/$repositoryId" as const,
    params: { repositoryId: scope.repositoryId },
    search: { tab: "runs" as const },
    state: { workflowRunsReturn },
  };
}
