import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { WorkflowScope } from "@t3tools/client-runtime/relay/workflow-session";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { View } from "react-native";

export type WorkflowResultOrigin = WorkflowScope & { readonly jobId: string };

/** Returning through the job screen re-resolves repository access before loading the job. */
export function WorkflowResultReturn({ origin }: { origin: WorkflowResultOrigin | undefined }) {
  const session = useAtomValue(managedRelaySessionAtom);
  const navigation = useNavigation();
  if (!origin || origin.accountId !== session?.accountId) return null;
  return (
    <View className="border-b border-outline">
      <SettingsActionRow
        icon="chevron.left"
        label="Back to workflow"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: {
              screen: "SettingsWorkflowJobs",
              params: { repositoryId: origin.repositoryId, jobId: origin.jobId },
            },
          })
        }
      />
    </View>
  );
}
