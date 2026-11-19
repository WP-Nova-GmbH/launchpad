import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { canUseLiveProjectWorkspace } from "../../lib/workflowResultGitAccess";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";

/** Settings uses the same logical projects as the sidebar, sorted by display name. */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    return buildSidebarProjectSnapshots({
      projects: projects.filter((project) =>
        canUseLiveProjectWorkspace({
          projectId: project.id,
          capabilities: serverConfigs.get(project.environmentId)?.environment.capabilities,
        }),
      ),
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryEnvironmentId, projects, serverConfigs, settings]);
}
