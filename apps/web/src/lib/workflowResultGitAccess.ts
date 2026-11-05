import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { createContext } from "react";

/** A workflow result can display history and checkpoints without opening the live workspace. */
export const LiveWorkspaceContext = createContext(true);

type WorkflowVmCapabilities = Pick<
  ExecutionEnvironmentDescriptor["capabilities"],
  "workflowVmResultReader"
>;

export function canUseLiveProjectWorkspace(input: {
  readonly projectId: string;
  readonly capabilities: WorkflowVmCapabilities | undefined;
}): boolean {
  // A workflow VM project can be cached before the environment descriptor arrives.
  return !input.capabilities?.workflowVmResultReader && !input.projectId.startsWith("vm:workflow:");
}

export function workflowResultGitAccess(input: {
  readonly capabilities: WorkflowVmCapabilities | undefined;
  readonly origin?: WorkflowResultOrigin | undefined;
  readonly threadId: string | null;
}) {
  const workflowVmResultReader =
    input.capabilities?.workflowVmResultReader ??
    (input.origin?.workflowVmResultReader === true && input.origin.threadId === input.threadId);
  return {
    workflowVmResultReader,
    // Completed jobs retain their workflow thread id after ownership metadata disappears.
    canReadCheckoutGit:
      !workflowVmResultReader &&
      (input.capabilities !== undefined || !input.threadId?.startsWith("workflow:")),
  };
}
