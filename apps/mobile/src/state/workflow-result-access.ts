import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";

const THREAD_WORKSPACE_ROUTES = new Set([
  "ThreadTerminal",
  "ThreadDevicePreview",
  "ThreadFiles",
  "ThreadFile",
  "GitOverview",
  "GitCommit",
  "GitBranches",
  "GitConfirm",
]);

function routeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Scope live workspace access to the scene's target, including on a cold deep link. */
export function threadWorkspaceRouteTarget(route: {
  readonly name: string;
  readonly params?: object | undefined;
}) {
  if (!THREAD_WORKSPACE_ROUTES.has(route.name)) return null;
  const params = route.params ?? {};
  const environmentId = routeId("environmentId" in params ? params.environmentId : null);
  const threadId = routeId("threadId" in params ? params.threadId : null);
  return {
    environmentId: environmentId === null ? null : EnvironmentId.make(environmentId),
    threadId: threadId === null ? null : ThreadId.make(threadId),
  };
}

export function resolveWorkflowResultAccess(
  capabilities: { readonly workflowVmResultReader?: boolean } | null,
  origin: WorkflowResultOrigin | null | undefined,
  threadId: string | null,
) {
  // Cold VM-result links may have neither configuration nor navigation state.
  // Machine workflow threads have an additional :agent suffix.
  const readOnly =
    capabilities?.workflowVmResultReader ??
    ((capabilities === null && /^workflow:[^:]+$/.test(threadId ?? "")) ||
      (origin != null &&
        origin.threadId === threadId &&
        (origin.workflowVmResultReader === true || origin.reviewVisitId !== undefined)));
  // A deep link can load its thread before the environment descriptor arrives.
  return { readOnly, workspaceEnabled: capabilities !== null && !readOnly };
}
