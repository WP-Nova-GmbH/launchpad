import { LinkIcon } from "lucide-react";
import { useAuth } from "@clerk/react";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { OwnerSources } from "../workflows/WorkflowOwnerSources";
export function WorkflowSourcesSettings() {
  const { isLoaded, userId } = useAuth();
  return (
    <SettingsSection {...searchableSetting("workflow-sources")} icon={<LinkIcon />}>
      {userId && isLoaded ? (
        <OwnerSources key={userId} accountId={userId} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Sign in to manage workflow sources.
        </p>
      )}
    </SettingsSection>
  );
}
