import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

export function canManageSettingsWorkspace(
  capabilities:
    | Pick<ExecutionEnvironmentDescriptor["capabilities"], "workflowVmResultReader">
    | undefined,
  projectId?: string,
): boolean {
  // A result project can be present in the shell cache before its environment config.
  return capabilities?.workflowVmResultReader !== true && !projectId?.startsWith("vm:workflow:");
}

export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = available.map((entry) => entry.environmentId);
  const next = new Set(ids.filter((id) => selected === null || selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}
