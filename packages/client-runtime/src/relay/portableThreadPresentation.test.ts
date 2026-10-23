import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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
