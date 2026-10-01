import type { ServerProviderVersionAdvisory } from "@t3tools/contracts";

/** Keep manual update guidance useful when connected to an older server. */
export function getManualProviderUpdateMessage(
  advisory: ServerProviderVersionAdvisory | undefined,
): string | null {
  if (!advisory || advisory.canUpdate) return null;
  const message = advisory.message?.trim();
  // Older servers sent this action prompt even when no updater was available.
  return message && message !== "Install the update now or review provider settings."
    ? message
    : "Launchpad cannot update this installation. Update it using its original installation method on this environment's machine.";
}
