import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  createActiveWorkflowRuns,
  managedRelaySessionAtom,
  readActiveWorkflowRunsPage,
  type ManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import { workflowRunStatus } from "@t3tools/client-runtime/relay/workflow-session";
import type { ActiveWorkflowRun } from "@t3tools/contracts/workflows";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { AppState, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { workflowJobsDestination } from "../../lib/adaptive-navigation";
import { cn } from "../../lib/cn";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ThreadListV2Section } from "./thread-list-v2-items";

type Pane = "screen" | "sidebar";

const runIcons = {
  blocked: "exclamationmark.triangle",
  checkpoint: "eye",
  running: "play",
  paused: "pause",
  waiting: "clock",
} as const;

// The iPad list has its own navigation tree for its native header. Capture the
// workspace navigator before passing the footer into either thread list.
export function useWorkflowRunsShelf(pane: Pane, visible: boolean) {
  const session = useAtomValue(managedRelaySessionAtom);
  const navigation = useNavigation();
  if (!session || !visible) return null;
  return (
    <WorkflowRunsShelf
      session={session}
      pane={pane}
      onOpen={(job) =>
        navigation.navigate("SettingsSheet", workflowJobsDestination(job.repositoryId, job.jobId))
      }
    />
  );
}

function subscribeAppState(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

function WorkflowRunsShelf(props: {
  session: ManagedRelaySession;
  pane: Pane;
  onOpen: (job: ActiveWorkflowRun) => void;
}) {
  const { pane, session } = props;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const expanded = loaded && preferences.value.workflowRunsShelfExpanded !== false;
  const runs = useMemo(
    () =>
      createActiveWorkflowRuns((query, signal) =>
        runtime.runPromise(readActiveWorkflowRunsPage(session, query), { signal }),
      ),
    [session],
  );
  const page = useSyncExternalStore(runs.subscribe, runs.getSnapshot);
  const foreground = useSyncExternalStore(
    subscribeAppState,
    () => AppState.currentState === "active",
  );
  useFocusEffect(
    useCallback(() => {
      if (loaded && foreground) return runs.watch(expanded);
    }, [runs, expanded, loaded, foreground]),
  );

  const sidebar = pane === "sidebar";
  const muted = sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const inset = sidebar ? "px-3" : "px-5";
  const title = page.total === null ? "Workflow Runs" : `Workflow Runs (${page.total})`;
  return (
    <View>
      <ThreadListV2Section
        label={title}
        pane={pane}
        disclosure={{
          accessibilityLabel: title,
          accessibilityHint: expanded ? "Collapse workflow runs" : "Expand workflow runs",
          disabled: !loaded,
          expanded,
          onToggle: () =>
            savePreferences({
              transform: (current) => ({
                workflowRunsShelfExpanded: current.workflowRunsShelfExpanded === false,
              }),
            }),
        }}
      />
      {expanded && (
        <View className={inset}>
          {page.jobs.map((job) => {
            const { label, kind } = workflowRunStatus(job);
            return (
              <Pressable
                key={job.jobId}
                accessibilityRole="button"
                className="min-h-[44px] flex-row items-center gap-2.5 py-1.5 active:opacity-60 android:min-h-[48px]"
                onPress={() => props.onOpen(job)}
              >
                <SymbolView
                  name={runIcons[kind]}
                  size={15}
                  tintColorClassName={
                    kind === "blocked" || kind === "checkpoint"
                      ? "accent-warning-foreground"
                      : sidebar
                        ? "accent-drawer-foreground-muted"
                        : "accent-icon-muted"
                  }
                />
                <View className="min-w-0 flex-1">
                  <Text
                    numberOfLines={1}
                    className={cn(
                      "text-sm font-t3-medium",
                      sidebar ? "text-drawer-foreground" : "text-foreground",
                    )}
                  >
                    {job.issueIdentifier ? `${job.issueIdentifier} · ${job.title}` : job.title}
                  </Text>
                  <Text numberOfLines={1} className={cn("text-xs", muted)}>
                    {job.repositoryName} · {label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {page.error ? (
            <View className="flex-row items-center justify-between">
              <Text className={cn("min-w-0 flex-1 text-xs", muted)}>{page.error}</Text>
              <Pressable
                accessibilityRole="button"
                className="min-h-[44px] min-w-[44px] items-center justify-center px-2 android:min-h-[48px] android:min-w-[48px]"
                onPress={() => void runs.refresh()}
              >
                <Text className={cn("text-sm", muted)}>Retry</Text>
              </Pressable>
            </View>
          ) : !page.jobs.length ? (
            <Text className={cn("py-1.5 text-xs", muted)}>
              {page.pending ? "Loading runs…" : "No active runs"}
            </Text>
          ) : null}
          {page.nextCursor && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: page.pending }}
              className="min-h-[44px] justify-center android:min-h-[48px]"
              disabled={page.pending}
              onPress={() => void runs.loadMore()}
            >
              <Text className={cn("text-sm", muted)}>Show more runs</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
