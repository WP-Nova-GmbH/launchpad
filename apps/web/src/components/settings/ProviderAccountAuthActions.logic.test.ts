import { ProviderDriverKind, type ServerProviderAuth } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extractProviderAccountAuthUrls,
  hasProviderAccountSession,
  supportsProviderAccountAuth,
} from "./ProviderAccountAuthActions.logic";

describe("provider account auth actions", () => {
  it("recognizes only the three native account-login drivers", () => {
    expect(supportsProviderAccountAuth(ProviderDriverKind.make("codex"))).toBe(true);
    expect(supportsProviderAccountAuth(ProviderDriverKind.make("claudeAgent"))).toBe(true);
    expect(supportsProviderAccountAuth(ProviderDriverKind.make("cursor"))).toBe(true);
    expect(supportsProviderAccountAuth(ProviderDriverKind.make("opencode"))).toBe(false);
  });

  it("does not present API keys or Bedrock credentials as account sessions", () => {
    const authenticated = (type: string): ServerProviderAuth => ({
      status: "authenticated",
      type,
    });

    expect(
      hasProviderAccountSession(ProviderDriverKind.make("codex"), authenticated("chatgpt")),
    ).toBe(true);
    expect(
      hasProviderAccountSession(ProviderDriverKind.make("codex"), authenticated("apiKey")),
    ).toBe(false);
    expect(
      hasProviderAccountSession(
        ProviderDriverKind.make("claudeAgent"),
        authenticated("Claude Max"),
      ),
    ).toBe(true);
    expect(
      hasProviderAccountSession(ProviderDriverKind.make("claudeAgent"), authenticated("bedrock")),
    ).toBe(false);
  });

  it("extracts only provider-owned sign-in links and removes duplicates", () => {
    expect(
      extractProviderAccountAuthUrls(
        ProviderDriverKind.make("codex"),
        [
          "Open \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m.",
          "Again: https://auth.openai.com/codex/device",
          "Ignore https://example.com/phish",
        ].join("\n"),
      ),
    ).toEqual(["https://auth.openai.com/codex/device"]);
  });
});
