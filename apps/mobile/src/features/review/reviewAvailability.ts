import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  workflowResultOrigin,
  type WorkflowResultOrigin,
} from "@t3tools/client-runtime/relay/workflow-result";

export function savedWorkflowDiffParams(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  origin: WorkflowResultOrigin | undefined,
): { environmentId: EnvironmentId; threadId: ThreadId; workflowOrigin?: WorkflowResultOrigin } {
  const params = { environmentId, threadId };
  if (origin?.threadId !== threadId) return params;
  // Browsing saved turns keeps the job link without locking to an approval visit.
  const { reviewVisitId: _visit, reviewCheckpoint: _checkpoint, ...workflowOrigin } = origin;
  return { ...params, workflowOrigin };
}

export function resolveWorkflowReviewRoute(
  routeOrigin: WorkflowResultOrigin | undefined,
  accountId: string | undefined,
  threadId: string,
) {
  const origin = workflowResultOrigin({ workflowOrigin: routeOrigin }, accountId, threadId);
  return {
    origin,
    blocked: routeOrigin?.reviewVisitId !== undefined && !origin?.reviewCheckpoint,
  };
}

export function resolveReviewAvailability(input: {
  readonly hasEnvironmentPresentation: boolean;
  readonly isEnvironmentConnected: boolean;
  readonly hasCachedSelectedDiff: boolean;
  readonly hasAnyCachedDiff: boolean;
}): {
  readonly showConnectionNotice: boolean;
  readonly showSectionToolbar: boolean;
} {
  const showConnectionNotice =
    input.hasEnvironmentPresentation &&
    !input.isEnvironmentConnected &&
    !input.hasCachedSelectedDiff;

  return {
    showConnectionNotice,
    showSectionToolbar: !showConnectionNotice || input.hasAnyCachedDiff,
  };
}
