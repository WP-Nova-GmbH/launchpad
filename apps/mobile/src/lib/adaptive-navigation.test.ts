import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  isWorkspaceVisible,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
  resolveThreadSelectionOverlayState,
  workflowJobsDestination,
} from "./adaptive-navigation";

describe("split workspace visibility", () => {
  const home = { key: "home", name: "Home" };
  const settings = (jobId: string) => ({
    key: "settings",
    name: "SettingsSheet",
    params: workflowJobsDestination("repo", jobId),
  });
  const preview = { key: "preview", name: "ThreadDevicePreview" };
  const descriptors = {
    home: { options: {} },
    settings: { options: { presentation: "card" as const } },
    preview: { options: { presentation: "fullScreenModal" as const } },
  };

  it("keeps the run list accessible while switching between two settings detail cards", () => {
    expect(isWorkspaceVisible({ routes: [home], index: 0 }, descriptors, "ios")).toBe(true);
    for (const jobId of ["first", "second"]) {
      expect(
        isWorkspaceVisible({ routes: [home, settings(jobId)], index: 1 }, descriptors, "ios"),
      ).toBe(true);
    }
  });

  it("stops exposing the list behind a native modal and restores it when dismissed", () => {
    const routes = [home, settings("first"), preview];
    expect(isWorkspaceVisible({ routes, index: 2 }, descriptors, "ios")).toBe(false);
    expect(isWorkspaceVisible({ routes: routes.slice(0, 2), index: 1 }, descriptors, "ios")).toBe(
      true,
    );
    expect(
      isWorkspaceVisible(
        { routes: [home, settings("first")], index: 1 },
        {
          ...descriptors,
          settings: { options: { presentation: "formSheet" } },
        },
        "ios",
      ),
    ).toBe(false);
  });

  it.each([
    ["ThreadDevicePreview", "fullScreenModal"],
    ["GitOverview", "formSheet"],
  ] as const)("keeps the Android sidebar available beside %s", (name, presentation) => {
    const route = { key: "detail", name };
    expect(
      isWorkspaceVisible(
        { routes: [home, route], index: 1 },
        { ...descriptors, detail: { options: { presentation } } },
        "android",
      ),
    ).toBe(true);
  });

  it("pauses behind draft thread settings on iPad and resumes on dismissal", () => {
    const draft = { key: "draft", name: "NewTaskDraft" };
    const threadSettings = { key: "picker", name: "ThreadSettings" };
    const newTask = {
      key: "new-task",
      name: "NewTaskSheet",
      state: { routes: [draft, threadSettings], index: 1 },
    };
    const routes = [home, newTask];
    expect(isWorkspaceVisible({ routes, index: 1 }, descriptors, "ios")).toBe(false);
    expect(isWorkspaceVisible({ routes, index: 1 }, descriptors, "android")).toBe(true);
    expect(
      isWorkspaceVisible(
        { routes: [home, { ...newTask, state: { routes: [draft], index: 0 } }], index: 1 },
        descriptors,
        "ios",
      ),
    ).toBe(true);
  });

  it("keeps the workspace visible when a deep link makes thread settings the first card", () => {
    const routes = [
      {
        key: "new-task",
        name: "NewTaskSheet",
        state: { routes: [{ key: "picker", name: "ThreadSettings" }], index: 0 },
      },
    ];
    expect(isWorkspaceVisible({ routes, index: 0 }, descriptors, "ios")).toBe(true);
  });
});

it("can reopen the same sidebar run after Back to jobs without stacking duplicate details", () => {
  // Load the installed native router without loading a simulator renderer.
  const require = NodeModule.createRequire(import.meta.url);
  const fromNative = NodeModule.createRequire(
    require.resolve("@react-navigation/native/package.json"),
  );
  const fromCore = NodeModule.createRequire(
    fromNative.resolve("@react-navigation/core/package.json"),
  );
  const { StackRouter, CommonActions } = fromCore("@react-navigation/routers") as Pick<
    typeof import("@react-navigation/native"),
    "StackRouter" | "CommonActions"
  >;
  const router = StackRouter({ initialRouteName: "Settings" });
  const options = {
    routeNames: ["Settings", "SettingsWorkflowJobs"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let content = router.getInitialState(options);
  function open(repositoryId: string, jobId?: string) {
    const { params } = workflowJobsDestination(repositoryId, jobId);
    const next = router.getStateForAction(
      content,
      CommonActions.navigate(params.screen, params.params),
      options,
    );
    if (!next) throw new Error("Native stack rejected the workflow destination.");
    content = router.getRehydratedState(next, options);
    return content.routes[content.index];
  }
  const first = open("repo-a", "run-a");
  const second = open("repo-b", "run-b");
  expect(second?.key).toBe(first?.key);
  expect(second?.params).toEqual({ repositoryId: "repo-b", jobId: "run-b" });
  expect(open("repo-b")?.params).toEqual({ repositoryId: "repo-b" });
  expect(open("repo-b", "run-b")).toEqual(second);
  expect(content.routes).toHaveLength(2);
});

describe("isBaseThreadRoute", () => {
  it("recognizes only the thread detail route", () => {
    expect(isBaseThreadRoute("/threads/environment/thread")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/files")).toBe(false);
    expect(isBaseThreadRoute("/threads/environment/thread/review")).toBe(false);
  });
});

describe("resolveThreadSelectionNavigationAction", () => {
  it("updates params when a persistent sidebar selects a peer thread", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("set-params");
  });

  it("replaces nested thread content when a persistent sidebar selects a peer", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread/files/path",
      }),
    ).toBe("replace");
  });

  it("pushes from Home so the back stack survives collapsing to compact", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/",
      }),
    ).toBe("push");
  });

  it("pushes compact list selections onto the native stack", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: false,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("push");
  });
});

describe("resolveFileSelectionNavigationAction", () => {
  it("replaces the wide file browser with the selected preview", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: true })).toBe(
      "replace",
    );
  });

  it("pushes a preview above the compact file browser", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: false })).toBe(
      "push",
    );
  });
});

describe("resolveThreadSelectionOverlayState", () => {
  const stack = {
    key: "workspace",
    type: "stack",
    stale: false as const,
    routeNames: ["Home", "Thread", "ThreadFiles", "SettingsSheet", "SettingsLegal"],
  };
  const home = { key: "home", name: "Home" };
  const thread = {
    key: "thread",
    name: "Thread",
    params: { environmentId: "environment", threadId: "old-thread" },
  };
  const files = { key: "files", name: "ThreadFiles", params: thread.params };
  const settings = { key: "settings", name: "SettingsSheet" };
  const params = { environmentId: "environment", threadId: "new-thread" };

  it("replaces the underlying file route and dismisses every overlay above it", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: {
          ...stack,
          index: 4,
          routes: [home, thread, files, settings, { key: "legal", name: "SettingsLegal" }],
        },
        workspaceRouteKey: files.key,
        action: "replace",
        params,
      }),
    ).toEqual({ ...stack, index: 2, routes: [home, thread, { name: "Thread", params }] });
  });

  it("dismisses an overlay when selecting the current thread without replacing its route key", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: { ...stack, index: 2, routes: [home, thread, settings] },
        workspaceRouteKey: thread.key,
        action: "set-params",
        params: thread.params,
      }),
    ).toEqual({ ...stack, index: 1, routes: [home, thread] });
  });

  it.each([home, files])(
    "keeps $name in the back stack when pushing from beneath a sheet",
    (route) => {
      expect(
        resolveThreadSelectionOverlayState({
          state: { ...stack, index: 1, routes: [route, settings] },
          workspaceRouteKey: route.key,
          action: "push",
          params,
        }),
      ).toEqual({ ...stack, index: 1, routes: [route, { name: "Thread", params }] });
    },
  );

  it("leaves ordinary thread selection alone when no overlay is present", () => {
    expect(
      resolveThreadSelectionOverlayState({
        state: { ...stack, index: 2, routes: [home, thread, files] },
        workspaceRouteKey: files.key,
        action: "replace",
        params,
      }),
    ).toBeNull();
  });
});
