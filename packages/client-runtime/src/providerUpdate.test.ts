import { describe, expect, it } from "vite-plus/test";

import { getManualProviderUpdateMessage } from "./providerUpdate.ts";

const advisory = {
  status: "behind_latest" as const,
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  canUpdate: false,
  updateCommand: null,
  checkedAt: null,
  message: null,
};

describe("manual provider update guidance", () => {
  it.each([null, "", "   ", "Install the update now or review provider settings."])(
    "provides a manual fallback for legacy or missing guidance: %s",
    (message) => {
      expect(getManualProviderUpdateMessage({ ...advisory, message })).toBe(
        "Launchpad cannot update this installation. Update it using its original installation method on this environment's machine.",
      );
    },
  );

  it("preserves the server's explanation of app ownership", () => {
    const message = "This installation is managed by ChatGPT. Check for updates in ChatGPT.";
    expect(getManualProviderUpdateMessage({ ...advisory, message })).toBe(message);
  });

  it("does not add manual instructions when an updater is available or status is missing", () => {
    expect(getManualProviderUpdateMessage({ ...advisory, canUpdate: true })).toBeNull();
    expect(getManualProviderUpdateMessage(undefined)).toBeNull();
  });
});
