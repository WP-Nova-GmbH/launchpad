import { RequestActionButton } from "./RequestActionButton";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * Shown in place of the composer when the server rejected a new task. The
 * prompt and attachments are already back in the project draft, so the only
 * action is reopening it.
 */
export function ThreadCreationFailedCard(props: {
  readonly reason: string;
  readonly onEditTask: () => void;
  readonly uncertain?: boolean;
}) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-border-subtle bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground">
        {props.uncertain ? "Acceptance unknown" : "Could not start task"}
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.reason}
      </Text>
      <Text className="font-sans text-xs leading-normal text-foreground-secondary">
        {props.uncertain
          ? "The original prompt and available files remain saved on this device. Sending a copy may repeat work if the original was accepted."
          : "Your prompt was kept in the project draft."}
      </Text>
      <View className="flex-row">
        <RequestActionButton
          label={props.uncertain ? "Copy to new draft" : "Edit task"}
          onPress={props.onEditTask}
        />
      </View>
    </View>
  );
}
