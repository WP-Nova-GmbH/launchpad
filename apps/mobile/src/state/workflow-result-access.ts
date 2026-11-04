import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";

export function resolveWorkflowResultAccess(
  capabilities: { readonly workflowVmResultReader?: boolean } | null,
  origin: WorkflowResultOrigin | null | undefined,
  threadId: string | null,
) {
  const readOnly =
    capabilities?.workflowVmResultReader ??
    (origin != null &&
      origin.threadId === threadId &&
      (origin.workflowVmResultReader === true || origin.reviewVisitId !== undefined));
  // A deep link can load its thread before the environment descriptor arrives.
  return { readOnly, workspaceEnabled: capabilities !== null && !readOnly };
}
