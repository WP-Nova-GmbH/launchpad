import type { NavigationState } from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import type { Platform } from "react-native";

export type AdaptiveNavigationAction = "push" | "replace" | "set-params";

const BASE_THREAD_ROUTE_PATTERN = /^\/threads\/[^/]+\/[^/]+\/?$/;

/** UIKit can present over the split workspace. Android hosts its stack fragments in the detail pane. */
export function isWorkspaceVisible(
  state: Pick<NavigationState, "routes" | "index">,
  descriptors: Readonly<Record<string, { options: NativeStackNavigationOptions }>>,
  platform: typeof Platform.OS,
): boolean {
  if (platform !== "ios") return true;

  // The native stack always presents its first route as a card, including on a deep link.
  const hasRootSheet = state.routes.slice(1, state.index + 1).some((route) => {
    return (descriptors[route.key]?.options.presentation ?? "card") !== "card";
  });
  if (hasRootSheet) return false;

  // A regular-width new-task card hosts its own native stack. Its thread settings
  // picker presents over the workspace on iOS, including pushes inside the picker.
  const activeRoute = state.routes[state.index];
  if (activeRoute?.name !== "NewTaskSheet") return true;
  const draft = activeRoute.state;
  if (!draft) return true;
  return !draft.routes
    .slice(1, draft.index === undefined ? undefined : draft.index + 1)
    .some((route) => route.name === "ThreadSettings");
}

/** Omitting the job opens its repository's run list in the current settings pane. */
export function workflowJobsDestination(repositoryId: string, jobId?: string) {
  return {
    screen: "SettingsContent",
    params: {
      screen: "SettingsWorkflowJobs",
      params: jobId ? { repositoryId, jobId } : { repositoryId },
    },
  } as const;
}

export function isBaseThreadRoute(pathname: string): boolean {
  return BASE_THREAD_ROUTE_PATTERN.test(pathname);
}

/**
 * A persistent sidebar selects a peer destination in place. A compact list
 * drills into a new destination so the native back stack remains available.
 * From Home the selection pushes (never replaces) so Home stays beneath the
 * thread — collapsing back to a compact width keeps a sane back stack.
 */
export function resolveThreadSelectionNavigationAction(input: {
  readonly usesSplitView: boolean;
  readonly pathname: string;
}): AdaptiveNavigationAction {
  if (!input.usesSplitView || input.pathname === "/") {
    return "push";
  }

  return isBaseThreadRoute(input.pathname) ? "set-params" : "replace";
}

/** Dismiss sheets and select their underlying workspace destination in one stack update. */
export function resolveThreadSelectionOverlayState(input: {
  readonly state: NavigationState | undefined;
  readonly workspaceRouteKey: string | undefined;
  readonly action: AdaptiveNavigationAction;
  readonly params: ReactNavigation.RootParamList["Thread"];
}) {
  if (input.state === undefined) return null;
  const workspaceIndex = input.state.routes.findIndex(
    (route) => route.key === input.workspaceRouteKey,
  );
  if (workspaceIndex < 0 || workspaceIndex >= input.state.index) return null;

  const workspaceRoute = input.state.routes[workspaceIndex];
  const routes = input.state.routes.slice(0, workspaceIndex + (input.action === "push" ? 1 : 0));
  return {
    ...input.state,
    index: routes.length,
    routes: [
      ...routes,
      input.action === "set-params" && workspaceRoute?.name === "Thread"
        ? { ...workspaceRoute, params: { ...workspaceRoute.params, ...input.params } }
        : { name: "Thread", params: input.params },
    ],
  };
}

/**
 * On regular-width layouts, the file browser and preview occupy one workspace
 * destination. Replacing the browser route keeps a single back step to chat.
 * Compact layouts retain the browser as the previous stack screen.
 */
export function resolveFileSelectionNavigationAction(input: {
  readonly hasPersistentFileInspector: boolean;
}): AdaptiveNavigationAction {
  return input.hasPersistentFileInspector ? "replace" : "push";
}
