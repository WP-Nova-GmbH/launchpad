import { createFileRoute } from "@tanstack/react-router";

import { PortableThreadLibrary } from "../components/chat/PortableThreadLibrary";
import { SettingsPageContainer, SettingsSearchTarget } from "../components/settings/settingsLayout";

function VmThreadsSettings() {
  return (
    <SettingsPageContainer>
      <SettingsSearchTarget id="vm-threads" data-portable-thread-library>
        <PortableThreadLibrary />
      </SettingsSearchTarget>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/vms")({
  component: VmThreadsSettings,
});
