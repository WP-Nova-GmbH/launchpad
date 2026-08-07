import { describe, expect, it } from "vite-plus/test";
import type { RelayRepositorySummary } from "@t3tools/contracts/relay";

import { unregisteredCheckouts, type CheckoutLike } from "./OrganizationSettings.logic";

function repository(name: string, canonicalKeys: ReadonlyArray<string>): RelayRepositorySummary {
  return {
    repository: {
      repositoryId: `repository-${name}` as RelayRepositorySummary["repository"]["repositoryId"],
      organizationId: "organization-1" as RelayRepositorySummary["repository"]["organizationId"],
      name,
      canonicalKeys,
      createdAt: "2026-08-05T00:00:00.000Z",
    },
    role: "maintainer",
  };
}

function checkout(title: string, canonicalKey: string | null, name?: string): CheckoutLike {
  return {
    title,
    repositoryIdentity: canonicalKey
      ? {
          canonicalKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${canonicalKey}.git`,
          },
          ...(name ? { name } : {}),
        }
      : null,
  };
}

describe("unregisteredCheckouts", () => {
  it("leaves out checkouts a repository already answers to", () => {
    expect(
      unregisteredCheckouts(
        [checkout("app", "github.com/acme/app")],
        [repository("app", ["github.com/acme/app"])],
      ),
    ).toEqual([]);
  });

  it("recognises a mirror through the repository's other key", () => {
    expect(
      unregisteredCheckouts(
        [checkout("app", "gitlab.acme.internal/acme/app")],
        [repository("app", ["github.com/acme/app", "gitlab.acme.internal/acme/app"])],
      ),
    ).toEqual([]);
  });

  it("reports an unregistered checkout once, however many times it is cloned", () => {
    expect(
      unregisteredCheckouts(
        [
          checkout("app", "github.com/acme/app", "app"),
          checkout("app copy", "github.com/acme/app", "app"),
        ],
        [],
      ),
    ).toEqual([{ canonicalKey: "github.com/acme/app", suggestedName: "app" }]);
  });

  it("ignores a checkout with no remote, which has no repository identity at all", () => {
    expect(unregisteredCheckouts([checkout("scratch", null)], [])).toEqual([]);
  });

  it("falls back to the project title when the remote carries no name", () => {
    expect(unregisteredCheckouts([checkout("Scratchpad", "github.com/acme/app")], [])).toEqual([
      { canonicalKey: "github.com/acme/app", suggestedName: "Scratchpad" },
    ]);
  });
});
