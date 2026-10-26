import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimarySessionState } from "../../environments/primary/sessionState";
import { ClientNameButton } from "../auth/ClientNameDialog";
import { SettingsRow } from "./settingsLayout";

/** Self-renaming is available independently of host access-management permissions. */
export function ThisClientSettingsRow({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const session = usePrimarySessionState();
  const current = session.data?.authenticated ? session.data.currentSession : null;
  if (!current) return null;
  return (
    <SettingsRow
      title="This client"
      description={current.client.label ?? "No client name set"}
      control={
        <ClientNameButton
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          initialLabel={current.client.label ?? ""}
          buttonLabel={current.needsClientLabel ? "Name this client" : "Rename"}
          required={current.needsClientLabel}
          onRenamed={session.refresh}
        />
      }
    />
  );
}
