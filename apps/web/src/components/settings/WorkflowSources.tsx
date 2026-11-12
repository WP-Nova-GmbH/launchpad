import { LinkIcon } from "lucide-react";
import { useAuth } from "@clerk/react";
import { type RelayOrganizationId } from "@t3tools/contracts/relay";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { OwnerSources } from "../workflows/WorkflowOwnerSources";
export function WorkflowSourcesSettings({
  organizationId,
  isAdmin,
}: {
  organizationId: RelayOrganizationId;
  isAdmin: boolean;
}) {
  const { isLoaded, userId } = useAuth();
  return (
    <SettingsSection
      {...searchableSetting("workflow-sources")}
      icon={<LinkIcon className="size-4" aria-hidden />}
    >
      {userId && isLoaded && isAdmin ? (
        <OwnerSources
          key={JSON.stringify([userId, organizationId])}
          accountId={userId}
          organizationId={organizationId}
          settingsRow={SettingsRow}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {userId && isLoaded
            ? "Ask an organization admin to manage Linear for workflows."
            : "Sign in to manage workflow sources."}
        </p>
      )}
    </SettingsSection>
  );
}
