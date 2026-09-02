import { describe, expect, it } from "vite-plus/test";
import type { RelayProviderAccount } from "@t3tools/contracts/relay";

import {
  PROVIDER_ACCOUNT_PRESENTATIONS,
  providerAccountDescription,
} from "./OrganizationSettings.logic";

function account(overrides: Partial<RelayProviderAccount> = {}): RelayProviderAccount {
  return {
    provider: "codex",
    kind: "auth_store",
    label: "dev@example.test",
    version: "v1",
    updatedByUserId: "user-1",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("PROVIDER_ACCOUNT_PRESENTATIONS", () => {
  it("lists every provider an organization can hold an account for, once", () => {
    expect(PROVIDER_ACCOUNT_PRESENTATIONS.map((entry) => entry.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "opencode",
    ]);
  });

  it("offers a key for every provider and a shareable sign-in for all but Cursor", () => {
    for (const entry of PROVIDER_ACCOUNT_PRESENTATIONS) {
      expect(entry.keyNames.length).toBeGreaterThan(0);
      expect(entry.shareable).toBe(entry.provider !== "cursor");
    }
  });
});

describe("providerAccountDescription", () => {
  it("says what is missing when nothing is shared", () => {
    expect(providerAccountDescription(null)).toMatch(/^Not shared\./);
  });

  it("names a shared sign-in by its label and date", () => {
    expect(providerAccountDescription(account())).toBe(
      "Sign-in shared 2026-09-02: dev@example.test. Executors pick up changes within a few minutes.",
    );
  });

  it("distinguishes a key from a sign-in", () => {
    expect(providerAccountDescription(account({ kind: "env", label: "OPENAI_API_KEY" }))).toMatch(
      /^Key shared 2026-09-02: OPENAI_API_KEY\./,
    );
  });
});
