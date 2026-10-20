import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { portableThreadCommands } from "../../state/threads";

export function PortableThreadCommandStatus({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const state = useAtomValue(portableThreadCommands.viewAtom(environmentId, threadId));
  if (
    !state ||
    !(
      state.waitingForRelay ||
      state.waitingForEnvironment ||
      state.rejections.length ||
      state.error
    )
  )
    return null;
  return (
    <View accessibilityLiveRegion="polite" className="px-4 py-2">
      {state.waitingForRelay > 0 ? (
        <Text className="text-xs text-muted-foreground">
          Waiting to confirm {state.waitingForRelay} change{state.waitingForRelay === 1 ? "" : "s"}{" "}
          with Launchpad Connect.
        </Text>
      ) : null}
      {state.waitingForEnvironment > 0 ? (
        <Text className="text-xs text-muted-foreground">
          {state.waitingForEnvironment}
          {state.hasMore ? "+" : ""} change
          {state.waitingForEnvironment === 1 && !state.hasMore ? "" : "s"} waiting for this
          environment.
        </Text>
      ) : null}
      {state.rejections.map(({ commandId, detail }) => (
        <Text key={commandId} className="text-xs text-destructive">
          {detail}
        </Text>
      ))}
      {state.error ? (
        <Text className="text-xs text-destructive">
          Queued changes could not be refreshed. {state.error}
        </Text>
      ) : null}
    </View>
  );
}
