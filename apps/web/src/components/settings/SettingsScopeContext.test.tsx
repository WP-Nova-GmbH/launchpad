import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  environments: vi.fn(),
  projects: vi.fn(),
  configs: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: fixtures.environments() }),
  usePrimaryEnvironmentId: () => "local",
}));
vi.mock("../../state/entities", () => ({
  useProjects: fixtures.projects,
  useServerConfigs: fixtures.configs,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));

import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";

it("keeps a workflow result out of All environments and the writable repository group", async () => {
  const local = EnvironmentId.make("local");
  const guest = EnvironmentId.make("guest");
  const environment = (id: EnvironmentId, workflowVmResultReader: boolean) => ({
    environmentId: id,
    label: id,
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { workflowVmResultReader } },
      settings: DEFAULT_SERVER_SETTINGS,
    },
  });
  const environments = [environment(local, false), environment(guest, true)];
  const project = (environmentId: EnvironmentId, id: string) => ({
    environmentId,
    id: ProjectId.make(id),
    title: "Repository",
    workspaceRoot: "/repo",
    repositoryIdentity: { canonicalKey: "github.com/owner/repo" },
  });
  fixtures.environments.mockReturnValue(environments);
  fixtures.configs.mockReturnValue(
    new Map(environments.map((e) => [e.environmentId, e.serverConfig])),
  );
  fixtures.projects.mockReturnValue([
    project(local, "local-project"),
    project(guest, "vm:workflow:job"),
  ]);

  let resolved: ReturnType<typeof useSettingsScope> | undefined;
  function Probe() {
    const current = useSettingsScope();
    useLayoutEffect(() => {
      resolved = current;
    }, [current]);
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <SettingsScopeProvider search={{}} onChange={() => {}}>
          <Probe />
        </SettingsScopeProvider>,
      );
    });
    expect(resolved?.targets.map((target) => target.environmentId)).toEqual([local]);
    expect(
      resolved?.groups.map((group) => group.memberProjects.map((member) => member.id)),
    ).toEqual([["local-project"]]);
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
