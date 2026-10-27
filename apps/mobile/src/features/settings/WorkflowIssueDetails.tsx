import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { workflowIssueUrl, type RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { AppText as Text } from "../../components/AppText";

export function WorkflowIssueDetails({ job }: { job: RepositoryWorkflowJob }) {
  const [expanded, setExpanded] = useState(false);
  const issue = job.issueSnapshot ?? job.event;
  if (job.origin?.kind !== "automation" || !issue)
    return <Text className="text-foreground">{job.instruction}</Text>;
  const snapshot = job.issueSnapshot;
  const awaitingSnapshot =
    !snapshot && job.status === "queued" && job.workflow === null && job.progress === null;
  const url = workflowIssueUrl(issue.url);
  return (
    <View className="gap-2">
      <Text className="text-foreground">
        {issue.identifier}: {issue.title}
      </Text>
      {url ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
          <Text className="text-foreground underline">Open in Linear</Text>
        </Pressable>
      ) : null}
      {!awaitingSnapshot ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((value) => !value)}
          >
            <Text className="font-semibold text-foreground">Issue details</Text>
          </Pressable>
          {expanded ? (
            snapshot ? (
              <View className="gap-2">
                <Text className="text-xs text-foreground-muted">
                  Saved for this run · {snapshot.retrievedAt}
                </Text>
                <Text className="text-foreground">
                  Team: {snapshot.team.name} · Status: {snapshot.status.name}
                </Text>
                <Text className="text-foreground">
                  Labels: {snapshot.labels.map((label) => label.name).join(", ") || "None"}
                </Text>
                <Text className="text-foreground">{snapshot.description || "No description."}</Text>
              </View>
            ) : (
              <View className="gap-2">
                <Text className="text-xs text-foreground-muted">
                  No issue snapshot was saved for this job. Its stored instructions are shown below.
                </Text>
                <Text className="text-foreground">{job.instruction}</Text>
              </View>
            )
          ) : null}
        </>
      ) : (
        <Text className="text-xs text-foreground-muted">
          Issue details will be read before this job starts.
        </Text>
      )}
    </View>
  );
}
