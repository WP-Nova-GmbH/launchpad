import { describe, expect, it } from "vite-plus/test";
import type { RelayMachine, RelayRepositorySummary } from "@t3tools/contracts/relay";

import {
  machineStatusLabel,
  memberLabel,
  unregisteredCheckouts,
  type CheckoutLike,
} from "./OrganizationSettings.logic";

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

describe("memberLabel", () => {
  it("prefers a name, keeping the address as the second line", () => {
    expect(
      memberLabel({ userId: "user_1", identity: { displayName: "Ada", email: "ada@example.com" } }),
    ).toEqual({ primary: "Ada", secondary: "ada@example.com" });
  });

  it("falls back to the address when the profile has no name", () => {
    expect(
      memberLabel({ userId: "user_1", identity: { displayName: null, email: "ada@example.com" } }),
    ).toEqual({ primary: "ada@example.com", secondary: null });
  });

  it("falls back to the subject id when the directory did not answer", () => {
    expect(memberLabel({ userId: "user_1", identity: null })).toEqual({
      primary: "user_1",
      secondary: null,
    });
  });
});

describe("machineStatusLabel", () => {
  const machine = (overrides: Partial<RelayMachine>): RelayMachine =>
    ({
      machineId: "machine-1",
      organizationId: "organization-1",
      role: "agent_executor",
      label: "Executor 1",
      status: "awaiting_enrollment",
      computeKind: "docker",
      environmentId: null,
      endpoint: null,
      createdByUserId: "user_1",
      createdAt: "2026-08-19T00:00:00.000Z",
      enrolledAt: null,
      seedExpiresAt: "2026-08-20T00:00:00.000Z",
      deprovisionedAt: null,
      ...overrides,
    }) as RelayMachine;
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  it("labels the lifecycle states", () => {
    expect(machineStatusLabel(machine({}), now)).toBe("Waiting to enroll");
    expect(
      machineStatusLabel(machine({ status: "ready", enrolledAt: "2026-08-19T01:00:00.000Z" }), now),
    ).toBe("Ready");
    expect(
      machineStatusLabel(
        machine({ status: "deprovisioned", deprovisionedAt: "2026-08-19T02:00:00.000Z" }),
        now,
      ),
    ).toBe("Deprovisioned");
  });

  it("calls out a machine whose enrollment window already closed", () => {
    expect(machineStatusLabel(machine({ seedExpiresAt: "2026-08-19T00:30:00.000Z" }), now)).toBe(
      "Enrollment expired",
    );
  });
});
