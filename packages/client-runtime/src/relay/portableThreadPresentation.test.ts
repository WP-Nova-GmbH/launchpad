import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadMoveQueueEntry,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import type { EnvironmentThreadShell } from "../state/models.ts";
import {
  beginPortableThreadPlacementRead,
  portableThreadPlacementsAtom,
  createPortableThreadPresentationAtom,
  rememberPortableThreadPlacement,
  canCreateThreadInEnvironment,
  selectPortableThreadPresentation,
} from "./portableThreadPresentation.ts";
import { threadMoveQueuePresentation } from "./threadMoveQueuePresentation.ts";

const relay = "https://relay.example.com";
const placement: RelayPortableThreadPlacement = {
  threadId: "thread",
  organizationId: "org",
  repositoryId: "repo",
  ownerUserId: "owner",
  environmentId: "vm",
  projectId: "project",
  generation: 2,
  operationId: null,
};
const moveEntry: ThreadMoveQueueEntry = {
  kind: "move",
  messageId: MessageId.make("message"),
  destination: { kind: "vm" },
  revision: 1,
  acceptedSequence: 1,
  createdAt: "2026-11-02T12:00:00Z",
  state: "moving",
  operationId: CommandId.make("move"),
};
const moving: RelayPortableThreadPlacement = {
  ...placement,
  operationId: "move",
  moveProgress: [
    {
      threadId: "thread",
      operationId: "move",
      environmentId: "vm",
      generation: 2,
      participant: "source",
      attempt: 1,
      revision: 1,
      stage: "uploading",
      completedBytes: 1024,
      totalBytes: 2048,
      completedArtifacts: 1,
      totalArtifacts: 2,
      updatedAt: "2026-11-02T12:01:00Z",
    },
  ],
};
const shell = (environmentId: string, relayUrl = relay): EnvironmentThreadShell => ({
  id: ThreadId.make("thread"),
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make("project"),
  title: "Same title",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  relayRouting: {
    relayUrl,
    generation: environmentId === "vm" ? 2 : 1,
    phase: environmentId === "vm" ? "active" : "retired",
  },
});
const select = (shells: ReadonlyArray<EnvironmentThreadShell>, proof = placement) =>
  selectPortableThreadPresentation(shells, new Map([[proof.threadId, proof]]), relay);

describe("portable navigation", () => {
  it("keeps one confirmed current conversation and preserves an unrelated relay UUID collision", () => {
    const source = shell("mac"),
      current = shell("vm"),
      unrelated = shell("other", "https://other.example.com");
    expect(select([source, current, unrelated])).toEqual([current, unrelated]);
  });
  it("retains the source while a move is in progress", () => {
    const entries = [shell("mac"), shell("vm")];
    expect(
      select(entries, { ...placement, environmentId: "mac", generation: 1, operationId: "moving" }),
    ).toEqual([entries[0]]);
  });
  it("keeps one recoverable source when the current environment is undiscovered", () => {
    const source = shell("mac");
    const result = select([source, shell("old")]);
    expect(result).toHaveLength(1);
    expect(result[0]?.environmentId).toBe(source.environmentId);
    expect(result[0]?.portableLocation).toMatchObject({
      environmentId: "vm",
      label: "Current machine · unavailable",
    });
  });
  it("never collapses equal UUIDs without placement proof", () => {
    const entries = [shell("mac"), shell("vm")];
    expect(selectPortableThreadPresentation(entries, new Map(), relay)).toBe(entries);
  });
  it("prevents new threads in an assigned VM", () => {
    expect(
      canCreateThreadInEnvironment({
        environment: { threadVm: { threadId: ThreadId.make("thread") } },
      }),
    ).toBe(false);
    expect(canCreateThreadInEnvironment({ environment: {} })).toBe(true);
  });
  it("drops placement proof when the signed-in account changes", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "first", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      rememberPortableThreadPlacement(registry, session, relay, placement);
      const entries = [shell("mac"), shell("vm")];
      const navigation = createPortableThreadPresentationAtom({
        shellsAtom: Atom.make(entries),
        relayUrl: () => relay,
      });
      expect(registry.get(navigation)).toEqual([entries[1]]);
      registry.set(managedRelaySessionAtom, { ...session, accountId: "other" });
      expect(registry.get(navigation)).toEqual(entries);
    } finally {
      registry.dispose();
    }
  });

  it("labels an undiscovered paused VM while retaining the source reference for recovery", () => {
    const source = shell("mac");
    const result = selectPortableThreadPresentation(
      [source],
      new Map([[placement.threadId, placement]]),
      relay,
      new Map([
        [
          placement.threadId,
          {
            state: "paused",
            projectName: "Project",
            activity: "idle",
            observedAt: null,
            lastWorkAt: null,
            lastVerifiedBackupAt: null,
            savedDiskExpiresAt: null,
          },
        ],
      ]),
    );
    expect(result[0]?.environmentId).toBe(source.environmentId);
    expect(result[0]?.portableLocation).toEqual({
      environmentId: "vm",
      generation: 2,
      label: "Private VM · paused",
      machine: "cloud",
    });
  });
  it("uses completed move lineage to recognize an authenticated source relay alias", () => {
    const source = shell("mac", "http://127.0.0.1:8610");
    const current = shell("vm");
    expect(select([source, current])).toHaveLength(2);
    expect(
      select([source, current], {
        ...placement,
        previousLocations: [{ environmentId: "mac", generation: 1 }],
      }),
    ).toEqual([current]);
    expect(
      select([source, current], {
        ...placement,
        previousLocations: [{ environmentId: "mac", generation: 0 }],
      }),
    ).toHaveLength(2);
  });
  it("orders same-generation placement responses across writers and retains the generation guard", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      const oldRead = beginPortableThreadPlacementRead(registry, session, relay);
      const latestRead = beginPortableThreadPlacementRead(registry, session, relay);
      expect(
        rememberPortableThreadPlacement(registry, session, relay, placement, undefined, latestRead),
      ).toBe(true);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          relay,
          { ...placement, operationId: "stale-moving" },
          undefined,
          oldRead,
        ),
      ).toBe(false);
      const lowerGenerationRead = beginPortableThreadPlacementRead(registry, session, relay);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          relay,
          { ...placement, generation: 1 },
          undefined,
          lowerGenerationRead,
        ),
      ).toBe(false);
      expect(
        registry.get(portableThreadPlacementsAtom)?.placements.get(placement.threadId),
      ).toEqual(placement);
    } finally {
      registry.dispose();
    }
  });
  it("rejects an old relay response after a read begins for the new relay", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      const oldRead = beginPortableThreadPlacementRead(registry, session, relay);
      const nextRelay = "https://other-relay.example.com";
      const currentRead = beginPortableThreadPlacementRead(registry, session, nextRelay);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          nextRelay,
          placement,
          undefined,
          currentRead,
        ),
      ).toBe(true);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          relay,
          { ...placement, generation: 3 },
          undefined,
          oldRead,
        ),
      ).toBe(false);
      expect(registry.get(portableThreadPlacementsAtom)?.relayUrl).toBe(nextRelay);
    } finally {
      registry.dispose();
    }
  });
});

describe("portable move progress", () => {
  it.each(["uploading", "downloading"] as const)(
    "keeps %s progress visible across a newer sparse library summary",
    (stage) => {
      const registry = AtomRegistry.make();
      try {
        const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
        registry.set(managedRelaySessionAtom, session);
        const receipt = {
          ...moving.moveProgress![0]!,
          stage,
          ...(stage === "downloading"
            ? { participant: "destination" as const, environmentId: "next-vm", generation: 3 }
            : {}),
        };
        const detailed = { ...moving, moveProgress: [receipt] };
        rememberPortableThreadPlacement(registry, session, relay, detailed);
        const expected = {
          label: stage === "uploading" ? "Uploading files" : "Downloading files",
          detail: "1 KB of 2 KB verified",
        };
        expect(
          threadMoveQueuePresentation({ entry: moveEntry, placement: detailed }),
        ).toMatchObject(expected);

        rememberPortableThreadPlacement(registry, session, `${relay}/`, {
          ...placement,
          operationId: "move",
        });
        expect(
          threadMoveQueuePresentation({
            entry: moveEntry,
            placement: registry.get(portableThreadPlacementsAtom)?.placements.get("thread"),
          }),
        ).toMatchObject(expected);

        rememberPortableThreadPlacement(registry, session, relay, {
          ...detailed,
          moveProgress: [{ ...receipt, revision: 2, completedBytes: 1536 }],
        });
        expect(
          threadMoveQueuePresentation({
            entry: moveEntry,
            placement: registry.get(portableThreadPlacementsAtom)?.placements.get("thread"),
          }),
        ).toMatchObject({ ...expected, detail: "2 KB of 2 KB verified" });
      } finally {
        registry.dispose();
      }
    },
  );

  it("retains an active failure across a sparse summary and honors explicit clears", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      const failed: RelayPortableThreadPlacement = {
        ...moving,
        moveFailureDetail: "Upload could not finish",
        moveFailures: [
          {
            environmentId: "vm",
            generation: 2,
            attempt: 1,
            detail: "Upload could not finish",
            reportedAt: "2026-11-02T12:01:00Z",
            active: true,
          },
        ],
      };
      rememberPortableThreadPlacement(registry, session, relay, failed);
      rememberPortableThreadPlacement(registry, session, relay, {
        ...placement,
        operationId: "move",
      });
      const cached = registry.get(portableThreadPlacementsAtom)?.placements.get("thread");
      expect(cached?.moveFailures).toEqual(failed.moveFailures);
      expect(threadMoveQueuePresentation({ entry: moveEntry, placement: cached })).toMatchObject({
        label: "Move needs attention",
        detail: "Upload could not finish",
      });

      const cleared = {
        ...placement,
        operationId: "move",
        moveProgress: [],
        moveFailureDetail: null,
        moveFailures: [],
      };
      rememberPortableThreadPlacement(registry, session, relay, cleared);
      const current = registry.get(portableThreadPlacementsAtom)?.placements.get("thread");
      expect(current).toEqual(cleared);
      expect(threadMoveQueuePresentation({ entry: moveEntry, placement: current })).toMatchObject({
        label: "Moving thread…",
        detail: null,
        previousErrors: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it("accepts real progress resets when a new attempt starts a different stage", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      rememberPortableThreadPlacement(registry, session, relay, moving);
      const retry: RelayPortableThreadPlacement = {
        ...moving,
        moveProgress: [
          {
            ...moving.moveProgress![0]!,
            attempt: 2,
            stage: "packing",
            completedBytes: 0,
            totalBytes: null,
            completedArtifacts: 0,
            totalArtifacts: null,
          },
        ],
        moveFailureDetail: null,
        moveFailures: [],
      };
      rememberPortableThreadPlacement(registry, session, relay, retry);
      const current = registry.get(portableThreadPlacementsAtom)?.placements.get("thread");
      expect(current).toEqual(retry);
      expect(threadMoveQueuePresentation({ entry: moveEntry, placement: current })).toMatchObject({
        label: "Preparing files",
        detail: null,
      });
    } finally {
      registry.dispose();
    }
  });

  it.each([
    ["thread", { threadId: "other-thread" }],
    ["organization", { organizationId: "other-org" }],
    ["repository", { repositoryId: "other-repo" }],
    ["owner", { ownerUserId: "other-owner" }],
    ["environment", { environmentId: "other-environment" }],
    ["project", { projectId: "other-project" }],
    ["generation", { generation: 3 }],
    ["operation", { operationId: "reset" }],
    ["completed operation", { operationId: null }],
  ] satisfies ReadonlyArray<readonly [string, Partial<RelayPortableThreadPlacement>]>)(
    "does not carry move progress across a changed %s",
    (_field, changed) => {
      const registry = AtomRegistry.make();
      try {
        const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
        registry.set(managedRelaySessionAtom, session);
        rememberPortableThreadPlacement(registry, session, relay, moving);
        const next = { ...placement, operationId: "move", ...changed };
        rememberPortableThreadPlacement(registry, session, relay, next);
        expect(registry.get(portableThreadPlacementsAtom)?.placements.get(next.threadId)).toEqual(
          next,
        );
      } finally {
        registry.dispose();
      }
    },
  );

  it.each(["session", "account", "relay"] as const)(
    "does not carry move progress across a changed %s scope",
    (changed) => {
      const registry = AtomRegistry.make();
      try {
        const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
        registry.set(managedRelaySessionAtom, session);
        rememberPortableThreadPlacement(registry, session, relay, moving);
        const nextSession =
          changed === "relay"
            ? session
            : { ...session, accountId: changed === "account" ? "other-owner" : session.accountId };
        registry.set(managedRelaySessionAtom, nextSession);
        const next = { ...placement, operationId: "move" };
        rememberPortableThreadPlacement(
          registry,
          nextSession,
          changed === "relay" ? "https://other-relay.example.com" : relay,
          next,
        );
        expect(registry.get(portableThreadPlacementsAtom)?.placements.get("thread")).toEqual(next);
      } finally {
        registry.dispose();
      }
    },
  );

  it("does not retain historical move fields when neither placement has an active operation", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      rememberPortableThreadPlacement(registry, session, relay, { ...moving, operationId: null });
      rememberPortableThreadPlacement(registry, session, relay, placement);
      expect(registry.get(portableThreadPlacementsAtom)?.placements.get("thread")).toEqual(
        placement,
      );
    } finally {
      registry.dispose();
    }
  });

  it("advances read ordering for a sparse summary while retaining its accepted progress", () => {
    const registry = AtomRegistry.make();
    try {
      const session = { accountId: "owner", readClerkToken: () => Effect.succeed("token") };
      registry.set(managedRelaySessionAtom, session);
      rememberPortableThreadPlacement(registry, session, relay, moving);
      const oldRead = beginPortableThreadPlacementRead(registry, session, relay);
      const summaryRead = beginPortableThreadPlacementRead(registry, session, relay);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          relay,
          { ...placement, operationId: "move" },
          undefined,
          summaryRead,
        ),
      ).toBe(true);
      expect(
        rememberPortableThreadPlacement(
          registry,
          session,
          relay,
          {
            ...moving,
            moveProgress: [{ ...moving.moveProgress![0]!, revision: 2, completedBytes: 1536 }],
          },
          undefined,
          oldRead,
        ),
      ).toBe(false);
      const proofs = registry.get(portableThreadPlacementsAtom);
      expect(proofs?.reads.get("thread")).toBe(summaryRead);
      expect(proofs?.placements.get("thread")?.moveProgress).toEqual(moving.moveProgress);
    } finally {
      registry.dispose();
    }
  });
});
