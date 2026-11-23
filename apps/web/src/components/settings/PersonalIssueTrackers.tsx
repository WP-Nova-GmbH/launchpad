import { useAuth } from "@clerk/react";
import { useIssueTrackers } from "../../cloud/issueTrackers";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { T3ConnectSignInButton } from "../clerk/T3ConnectSignInButton";
import { IssueTrackersSection } from "./IssueTrackersSection";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function OwnerConnections() {
  const trackers = useIssueTrackers();
  return <IssueTrackersSection {...trackers} />;
}

function ConfiguredConnections() {
  const { isLoaded, userId } = useAuth();
  if (isLoaded && userId) return <OwnerConnections key={userId} />;
  return (
    <SettingsSection {...searchableSetting("personal-issue-trackers")}>
      <div className="px-4 py-3 text-sm">
        <p className="mb-3 text-muted-foreground">
          Sign in to connect your own Jira and Linear accounts.
        </p>
        <T3ConnectSignInButton />
      </div>
    </SettingsSection>
  );
}

export function PersonalIssueTrackers() {
  return hasCloudPublicConfig() ? <ConfiguredConnections /> : null;
}
