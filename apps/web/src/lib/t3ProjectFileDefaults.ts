import { type EnvironmentId, type ResolvedProjectFile } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/** Reads the same cached, optimistic repository config used by Settings and script imports. */
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ResolvedProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.projectConfig({ environmentId, cwd: workspaceRoot }),
    { reportDefect: false, reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
}
