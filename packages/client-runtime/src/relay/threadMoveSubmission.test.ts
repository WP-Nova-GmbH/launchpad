import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ThreadMoveEnqueueCommand,
  type ThreadQueueEntry,
} from "@t3tools/contracts";
import {
  createThreadMoveSubmissionJournal,
  threadMoveProjectTargets,
  threadMoveProjectTargetAvailability,
  threadMoveOriginalLocationBlocker,
  threadMoveRepositoryCanonicalKey,
  threadMoveProviderSupported,
  threadWorkflowMoveBlocker,
  type ThreadMoveSubmissionStorage,
} from "./threadMoveSubmission.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { PrimaryConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
const scope = {
  accountId: "alice",
  relayUrl: "https://relay.example.test",
  environmentId: EnvironmentId.make("source"),
  threadId: ThreadId.make("thread"),
};
const command = (id = "original"): typeof ThreadMoveEnqueueCommand.Type => ({
  type: "thread.move.enqueue",
  commandId: CommandId.make(id),
  messageId: MessageId.make(id),
  threadId: scope.threadId,
  destination: { kind: "vm" },
  position: "next",
  createdAt: "2026-10-07T00:00:00Z",
});
const queuedMove = (move = command()): ThreadQueueEntry => ({
  kind: "move",
  messageId: move.messageId,
  destination: move.destination,
  state: "pending",
  revision: 1,
  acceptedSequence: 10,
  createdAt: move.createdAt,
});
function storage() {
  const values = new Map<string, string>(),
    locks = new Map<string, Promise<unknown>>();
  const result: ThreadMoveSubmissionStorage = {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    withLock: (key, action) => {
      const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
      locks.set(key, next);
      return next;
    },
  };
  return { values, storage: result };
}
describe("durable queued move submission", () => {
  it("recovers a lost reply after restart with the same IDs and selected timing", async () => {
    const f = storage(),
      sent: string[] = [];
    const failed = createThreadMoveSubmissionJournal(f.storage);
    const send = async (value: typeof ThreadMoveEnqueueCommand.Type) => {
      expect(f.values.size).toBe(1);
      sent.push(value.commandId);
      throw new Error("Lost reply");
    };
    expect(
      await failed.submit(
        scope,
        command,
        send,
        async () => ({ status: "unknown" }),
        () => true,
      ),
    ).toEqual({ status: "unknown" });
    const restarted = createThreadMoveSubmissionJournal(f.storage);
    expect((await restarted.read(scope))?.command).toEqual(command());
    const accepted = await restarted.submit(
      scope,
      () => command("do-not-use"),
      send,
      async (value) => ({
        relay: { commandId: value.commandId, position: 8, receipt: null },
      }),
      () => true,
    );
    expect(accepted).toEqual({ status: "accepted" });
    expect(sent).toEqual(["original", "original"]);
    expect(await restarted.read(scope)).toEqual({
      command: command(),
      originEnvironmentId: scope.environmentId,
      accepted: true,
      acceptedViaRelay: true,
    });
    expect(
      await restarted.observe(scope, (await restarted.read(scope))!, {
        entries: [queuedMove()],
      }),
    ).toBeNull();
  });
  it("does not contact an environment if the account changes during persistence", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    await expect(
      journal.submit(
        scope,
        command,
        async () => {
          throw new Error("Must not send");
        },
        async () => {
          throw new Error("Must not probe");
        },
        () => false,
      ),
    ).rejects.toThrow("Sign in again");
    expect((await journal.read(scope))?.command).toEqual(command());
    expect(await journal.read({ ...scope, accountId: "bob" })).toBeNull();
    expect(
      await journal.read({ ...scope, relayUrl: "https://another-relay.example.test" }),
    ).toBeNull();
  });
  it("retains an uncertain move until its own receipt confirms rejection or acceptance", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    await journal.submit(
      scope,
      command,
      async () => {
        throw new Error("Network");
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    await expect(journal.discardRejected(scope)).rejects.toThrow("uncertain");
    const original = (await journal.read(scope))!;
    await expect(
      journal.reconcile(scope, original, {
        relay: { commandId: "other", position: 9, receipt: null },
      }),
    ).rejects.toThrow("different move");
    await journal.reconcile(scope, original, { status: "rejected", detail: "Access removed" });
    expect((await journal.read(scope))?.rejection).toBe("Access removed");
    await journal.discardRejected(scope);
    expect(await journal.read(scope)).toBeNull();
  });
  it("does not send if the durable write fails", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal({
        ...f.storage,
        write: async () => {
          throw new Error("Storage full");
        },
      });
    let sent = false;
    await expect(
      journal.submit(
        scope,
        command,
        async () => {
          sent = true;
          return { sequence: 1 };
        },
        async () => ({ status: "unknown" }),
        () => true,
      ),
    ).rejects.toThrow("Storage full");
    expect(sent).toBe(false);
  });
  it("preserves the first uncertain intent across concurrent selections", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage),
      sent: string[] = [];
    const send = async (value: typeof ThreadMoveEnqueueCommand.Type) => {
      sent.push(value.commandId);
      throw new Error("Network");
    };
    await Promise.all(
      ["first", "second"].map((id) =>
        journal.submit(
          scope,
          () => command(id),
          send,
          async () => ({ status: "unknown" }),
          () => true,
        ),
      ),
    );
    expect(sent).toEqual(["first", "first"]);
    expect((await journal.read(scope))?.command.commandId).toBe("first");
  });
  it("keeps relay admission across reload and does not send a second selection before projection", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    const sent: string[] = [];
    await journal.submit(
      scope,
      command,
      async (move) => {
        sent.push(move.commandId);
        return { relay: { commandId: move.commandId, position: 1, receipt: null } };
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    const restarted = createThreadMoveSubmissionJournal(f.storage),
      saved = (await restarted.read(scope))!;
    expect(saved).toEqual({
      command: command(),
      originEnvironmentId: scope.environmentId,
      accepted: true,
      acceptedViaRelay: true,
    });
    expect(await restarted.observe(scope, saved, { entries: [] })).toBe(saved);
    await restarted.submit(
      scope,
      () => command("another-destination"),
      async (move) => {
        sent.push(move.commandId);
        return { sequence: 2 };
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    expect(sent).toEqual(["original"]);
    expect(await restarted.read(scope)).toEqual(saved);
    expect(await restarted.observe(scope, saved, { entries: [queuedMove()] })).toBeNull();
  });
  it.each(["unknown", "accepted"] as const)(
    "rejects a new selection if another tab saved a %s request after the picker opened",
    async (status) => {
      const f = storage(),
        firstTab = createThreadMoveSubmissionJournal(f.storage),
        staleTab = createThreadMoveSubmissionJournal(f.storage),
        sent: string[] = [];
      expect(await staleTab.read(scope)).toBeNull();
      await firstTab.submit(
        scope,
        command,
        async (move) => {
          sent.push(move.commandId);
          if (status === "unknown") throw new Error("Reply lost");
          return { relay: { commandId: move.commandId, position: 1, receipt: null } };
        },
        async () => ({ status: "unknown" }),
        () => true,
      );
      const first = await firstTab.read(scope);
      await expect(
        staleTab.submit(
          scope,
          () => command("different-destination"),
          async (move) => {
            sent.push(move.commandId);
            return { sequence: 2 };
          },
          async () => ({ status: "unknown" }),
          () => true,
          { allowExisting: false },
        ),
      ).rejects.toThrow("Another move is already saved");
      expect(sent).toEqual(["original"]);
      expect(await firstTab.read(scope)).toEqual(first);
    },
  );
  it.each(["direct", "relay"] as const)(
    "retains %s admission until an exact owner-local receipt and its paired detail catch up",
    async (transport) => {
      const f = storage(),
        journal = createThreadMoveSubmissionJournal(f.storage),
        source = { ...scope, sourceGeneration: 4 };
      await journal.submit(
        source,
        command,
        async () =>
          transport === "direct"
            ? { sequence: 10 }
            : {
                relay: {
                  commandId: command().commandId,
                  position: 1,
                  receipt: { status: "accepted", sequence: 10 },
                },
              },
        async () => ({ status: "unknown" }),
        () => true,
      );
      const restarted = createThreadMoveSubmissionJournal(f.storage),
        saved = (await restarted.read(source))!,
        placement = { environmentId: source.environmentId, generation: 4, operationId: null },
        projection = { environmentId: source.environmentId, generation: 4, snapshotSequence: 10 },
        executionProof = {
          commandId: command().commandId,
          environmentId: source.environmentId,
          generation: 4,
          sequence: 10,
        };
      expect(saved.acceptedSequence).toBe(10);
      expect(saved.sourceGeneration).toBe(4);
      expect(await restarted.observe(source, saved, { entries: [], placement, projection })).toBe(
        saved,
      );
      const waiting = await restarted.observe(source, saved, {
        entries: [],
        placement,
        executionProof,
        projection: { ...projection, snapshotSequence: 9 },
      });
      expect(waiting?.executionProof).toEqual(executionProof);
      expect(await restarted.read(source)).toEqual(waiting);
      // Readiness stays live: only its paired cursor crosses the receipt sequence.
      expect(
        await restarted.observe(source, waiting!, { entries: [], placement, projection }),
      ).toBeNull();
      expect(await restarted.read(source)).toBeNull();
    },
  );
  it("uses the command's exact queue identity and does not rewrite multiple queued moves", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    await journal.submit(
      scope,
      command,
      async () => ({ sequence: 10 }),
      async () => ({ status: "unknown" }),
      () => true,
    );
    const saved = (await journal.read(scope))!,
      otherMove = queuedMove(command("other"));
    expect(await journal.observe(scope, saved, { entries: [otherMove] })).toEqual(saved);
    const entries = [otherMove, queuedMove()];
    expect(await journal.observe(scope, saved, { entries })).toBeNull();
    expect(entries.map((entry) => entry.messageId)).toEqual(["other", "original"]);
  });
  it.each(["unknown", "admitted"] as const)(
    "keeps a %s request across another participant's move, navigation, reload and tabs",
    async (status) => {
      const f = storage(),
        journal = createThreadMoveSubmissionJournal(f.storage),
        source = { ...scope, sourceGeneration: 4 },
        destination = {
          ...scope,
          relayUrl: "https://RELAY.example.test/",
          environmentId: EnvironmentId.make("destination"),
          sourceGeneration: 5,
        };
      await journal.submit(
        source,
        command,
        async () => {
          if (status === "unknown") throw new Error("Reply lost");
          return { relay: { commandId: command().commandId, position: 1, receipt: null } };
        },
        async () => ({ status: "unknown" }),
        () => true,
      );
      const saved = (await journal.read(source))!;
      expect(
        await journal.observe(source, saved, {
          entries: [],
          placement: { environmentId: destination.environmentId, generation: 5, operationId: null },
          projection: { environmentId: source.environmentId, generation: 4, snapshotSequence: 999 },
        }),
      ).toBe(saved);
      const anotherTab = createThreadMoveSubmissionJournal(f.storage);
      expect(await anotherTab.read(destination)).toEqual(saved);
      await expect(
        anotherTab.submit(
          destination,
          () => command("different"),
          async () => {
            throw new Error("Must not send");
          },
          async () => ({ status: "unknown" }),
          () => true,
          { allowExisting: false },
        ),
      ).rejects.toThrow("Another move is already saved");
      expect(saved.originEnvironmentId).toBe(source.environmentId);
      expect(saved.sourceGeneration).toBe(4);
      expect(
        await anotherTab.observe(destination, saved, { entries: [queuedMove(command("other"))] }),
      ).toBe(saved);
      expect(await anotherTab.observe(destination, saved, { entries: [queuedMove()] })).toBeNull();
      expect(await journal.read(source)).toBeNull();
    },
  );
  it("never mixes command receipts, environments, generations or an in-progress owner", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage),
      destination = {
        ...scope,
        environmentId: EnvironmentId.make("destination"),
        sourceGeneration: 5,
      };
    await journal.submit(
      scope,
      command,
      async () => ({ relay: { commandId: command().commandId, position: 1, receipt: null } }),
      async () => ({ status: "unknown" }),
      () => true,
    );
    const saved = (await journal.read(destination))!,
      placement = { environmentId: destination.environmentId, generation: 5, operationId: null },
      projection = {
        environmentId: destination.environmentId,
        generation: 5,
        snapshotSequence: 100,
      },
      executionProof = {
        commandId: command().commandId,
        environmentId: destination.environmentId,
        generation: 5,
        sequence: 10,
      };
    for (const observation of [
      {
        placement,
        projection,
        executionProof: { ...executionProof, commandId: CommandId.make("other") },
      },
      {
        placement,
        projection,
        executionProof: { ...executionProof, environmentId: scope.environmentId },
      },
      { placement, projection, executionProof: { ...executionProof, generation: 4 } },
      { placement: { ...placement, operationId: "moving" }, projection, executionProof },
    ])
      expect(await journal.observe(destination, saved, { entries: [], ...observation })).toBe(
        saved,
      );
    const proved = (await journal.observe(destination, saved, {
      entries: [],
      placement,
      executionProof,
    }))!;
    expect(proved.executionProof).toEqual(executionProof);
    for (const changedProjection of [
      { ...projection, environmentId: scope.environmentId },
      { ...projection, generation: 4 },
      { ...projection, generation: 6 },
    ])
      expect(
        await journal.observe(destination, proved, {
          entries: [],
          placement,
          projection: changedProjection,
        }),
      ).toBe(proved);
    expect(
      await journal.observe(destination, proved, {
        entries: [],
        placement: { ...placement, generation: 6 },
        projection,
      }),
    ).toBe(proved);
    expect(
      await journal.observe(destination, proved, { entries: [], placement, projection }),
    ).toBeNull();
  });
  it("keeps newer execution evidence when an old machine's read arrives late", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    await journal.submit(
      scope,
      command,
      async () => ({ sequence: 10 }),
      async () => ({ status: "unknown" }),
      () => true,
    );
    const saved = (await journal.read(scope))!,
      proof = {
        commandId: command().commandId,
        environmentId: EnvironmentId.make("destination"),
        generation: 6,
        sequence: 20,
      },
      placement = {
        environmentId: proof.environmentId,
        generation: proof.generation,
        operationId: null,
      };
    const waiting = (await journal.observe(scope, saved, {
      entries: [],
      placement,
      executionProof: proof,
    }))!;
    expect(waiting.executionProof).toEqual(proof);
    const old = { ...proof, environmentId: scope.environmentId, generation: 4, sequence: 10 };
    expect(
      await journal.observe(scope, saved, {
        entries: [],
        placement: { ...placement, environmentId: old.environmentId, generation: old.generation },
        executionProof: old,
      }),
    ).toEqual(waiting);
    expect(
      await journal.observe(scope, waiting, {
        entries: [],
        placement,
        projection: { ...placement, snapshotSequence: 20 },
      }),
    ).toBeNull();
  });
  it("retains a late rejection for explicit discard without letting an earlier admission erase it", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage);
    await journal.submit(
      scope,
      command,
      async () => ({ relay: { commandId: command().commandId, position: 1, receipt: null } }),
      async () => ({ status: "unknown" }),
      () => true,
    );
    const saved = (await journal.read(scope))!;
    await journal.reconcile(scope, saved, {
      relay: {
        commandId: saved.command.commandId,
        position: 1,
        receipt: { status: "rejected", detail: "Repository access removed" },
      },
    });
    const rejected = (await journal.read(scope))!;
    expect(rejected).toEqual({
      command: command(),
      originEnvironmentId: scope.environmentId,
      rejection: "Repository access removed",
    });
    expect(
      await journal.reconcile(scope, saved, {
        relay: { commandId: saved.command.commandId, position: 1, receipt: null },
      }),
    ).toEqual({ status: "rejected", detail: "Repository access removed" });
    expect(await journal.observe(scope, rejected, { entries: [] })).toEqual(rejected);
    await journal.discardRejected(scope);
    expect(await journal.read(scope)).toBeNull();
  });
  it("preserves the original source, IDs, destination and timing when retrying from another machine", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage),
      source = { ...scope, sourceGeneration: 4 },
      destination = {
        ...scope,
        environmentId: EnvironmentId.make("destination"),
        sourceGeneration: 5,
      },
      last = { ...command(), position: "last" as const };
    await journal.submit(
      source,
      () => last,
      async () => {
        throw new Error("Reply lost");
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    const restarted = createThreadMoveSubmissionJournal(f.storage),
      sent: Array<typeof ThreadMoveEnqueueCommand.Type> = [];
    await restarted.submit(
      destination,
      () => command("new-next"),
      async (move) => {
        sent.push(move);
        return { relay: { commandId: move.commandId, position: 2, receipt: null } };
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    expect(sent).toEqual([last]);
    expect(await restarted.read(destination)).toEqual({
      command: last,
      originEnvironmentId: source.environmentId,
      sourceGeneration: 4,
      accepted: true,
      acceptedViaRelay: true,
    });
  });
  it("does not clear another account's request or a newer intent when observation arrives late", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage),
      anotherScope = { ...scope, accountId: "bob" };
    for (const target of [scope, anotherScope])
      await journal.submit(
        target,
        command,
        async () => ({ sequence: 10 }),
        async () => ({ status: "unknown" }),
        () => true,
      );
    const original = (await journal.read(scope))!;
    await journal.observe(scope, original, { entries: [queuedMove()] });
    expect((await journal.read(anotherScope))?.accepted).toBe(true);
    await journal.submit(
      scope,
      () => command("newer"),
      async () => ({ sequence: 20 }),
      async () => ({ status: "unknown" }),
      () => true,
    );
    expect(
      (
        await journal.observe(scope, original, {
          entries: [],
          executionProof: {
            commandId: original.command.commandId,
            environmentId: scope.environmentId,
            generation: 4,
            sequence: 10,
          },
          placement: { environmentId: scope.environmentId, generation: 4, operationId: null },
          projection: { environmentId: scope.environmentId, generation: 4, snapshotSequence: 999 },
        })
      )?.command.commandId,
    ).toBe("newer");
    expect((await journal.read(scope))?.command.commandId).toBe("newer");
  });
  it("retains unknown admission until exact execution is proved and rejects earlier-generation evidence", async () => {
    const f = storage(),
      journal = createThreadMoveSubmissionJournal(f.storage),
      source = { ...scope, sourceGeneration: 5 };
    await journal.submit(
      source,
      command,
      async () => {
        throw new Error("Reply lost");
      },
      async () => ({ status: "unknown" }),
      () => true,
    );
    const saved = (await journal.read(source))!,
      executionProof = {
        commandId: command().commandId,
        environmentId: scope.environmentId,
        generation: 4,
        sequence: 10,
      };
    expect(
      await journal.observe(source, saved, {
        entries: [],
        executionProof,
        placement: { environmentId: scope.environmentId, generation: 4, operationId: null },
        projection: { environmentId: scope.environmentId, generation: 4, snapshotSequence: 999 },
      }),
    ).toBe(saved);
    const currentProof = { ...executionProof, generation: 5 };
    const waiting = await journal.observe(source, saved, {
      entries: [],
      executionProof: currentProof,
      placement: { environmentId: scope.environmentId, generation: 5, operationId: null },
    });
    expect(waiting?.accepted).toBe(true);
    expect(waiting?.executionProof).toEqual(currentProof);
  });
  it("offers only the same repository on other environments without comparing machine paths", () => {
    const project = (environmentId: string, canonicalKey: string): EnvironmentProject => ({
      environmentId: EnvironmentId.make(environmentId),
      id: ProjectId.make(environmentId),
      title: "Repo",
      workspaceRoot: "/different/path",
      repositoryIdentity: {
        canonicalKey,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/team/repo",
        },
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: command().createdAt,
      updatedAt: command().createdAt,
    });
    const source = project("source", "github:team/repo");
    expect(
      threadMoveProjectTargets(
        source,
        [
          source,
          project("destination", "github:team/repo"),
          project("other", "github:other/repo"),
          { ...project("another-vm", "github:team/repo"), id: ProjectId.make("vm:another-thread") },
          project("unopened-vm", "github:team/repo"),
          { ...project("deleted-vm", "github:team/repo"), id: ProjectId.make("vm:deleted-thread") },
          project("stale", "github:team/repo"),
        ],
        [
          {
            entry: {
              target: new RelayConnectionTarget({
                environmentId: EnvironmentId.make("deleted-vm"),
                label: "Deleted VM",
              }),
            },
          },
          {
            entry: {
              target: new RelayConnectionTarget({
                environmentId: EnvironmentId.make("unopened-vm"),
                label: "Unopened VM",
              }),
            },
            serverConfig: {
              environment: { threadVm: { threadId: ThreadId.make("unopened-thread") } },
            },
          },
          {
            entry: {
              target: new PrimaryConnectionTarget({
                environmentId: EnvironmentId.make("destination"),
                label: "My machine",
                httpBaseUrl: "http://localhost",
                wsBaseUrl: "ws://localhost",
              }),
            },
          },
          {
            entry: {
              target: new RelayConnectionTarget({
                environmentId: EnvironmentId.make("another-vm"),
                label: "Another thread VM",
              }),
            },
          },
        ],
        source.repositoryIdentity?.canonicalKey,
      ).map((target) => target.destination),
    ).toEqual([{ kind: "environment", environmentId: "destination", projectId: "destination" }]);
  });
});

describe("original project move targets", () => {
  const project = (environmentId: string, projectId: string): EnvironmentProject => ({
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(projectId),
    title: "Repo",
    workspaceRoot: `/repos/${projectId}`,
    repositoryIdentity: {
      canonicalKey: "github:team/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/team/repo",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: command().createdAt,
    updatedAt: command().createdAt,
  });
  const source = project("vm", "vm:thread");
  const original = project("mac", "original");
  const sibling = project("mac", "sibling");
  const other = project("other", "other");
  const otherSibling = project("other", "other-sibling");
  const projects = [source, sibling, original, other, otherSibling];
  const environments = ["vm", "mac", "other"].map((environmentId) => ({
    entry: {
      target: new RelayConnectionTarget({
        environmentId: EnvironmentId.make(environmentId),
        label: environmentId,
      }),
    },
  }));
  const originalLocation = { environmentId: original.environmentId, projectId: original.id };
  const targets = (availableProjects = projects, knownEnvironments = environments) =>
    threadMoveProjectTargets(
      source,
      availableProjects,
      knownEnvironments,
      source.repositoryIdentity?.canonicalKey,
      originalLocation,
    );

  it("offers the exact original project once and keeps other machines unchanged", () => {
    expect(targets().map((target) => target.destination)).toEqual([
      { kind: "environment", ...originalLocation },
      { kind: "environment", environmentId: other.environmentId, projectId: other.id },
      {
        kind: "environment",
        environmentId: otherSibling.environmentId,
        projectId: otherSibling.id,
      },
    ]);
    expect(targets()[0]?.project).toBe(original);
  });

  it("keeps the original scoped ID when its project was deleted or recreated at the same path", () => {
    const recreated = { ...original, id: ProjectId.make("recreated") };
    const result = targets([source, sibling, recreated, other]);
    expect(result[0]).toMatchObject({
      destination: { kind: "environment", ...originalLocation },
      original: true,
      project: null,
    });
    expect(result.filter((target) => target.destination.environmentId === "mac")).toHaveLength(1);
  });

  it("keeps the original row without a local machine/project cache or repository status", () => {
    expect(threadMoveProjectTargets(source, [], [], undefined, originalLocation)).toEqual([
      expect.objectContaining({
        destination: { kind: "environment", ...originalLocation },
        original: true,
        project: null,
      }),
    ]);
  });

  it("uses current project metadata and lets the host validate its actual repository root", () => {
    const updated = {
      ...original,
      title: "Renamed project",
      workspaceRoot: "/repos/moved",
      repositoryIdentity: null,
    };
    expect(targets([source, sibling, updated])[0]?.project).toBe(updated);
  });

  it("keeps generic choices for a VM created without an original project", () => {
    expect(
      threadMoveProjectTargets(source, projects, environments, "github:team/repo", null).map(
        (target) => target.destination.projectId,
      ),
    ).toEqual([sibling.id, original.id, other.id, otherSibling.id]);
  });

  it("blocks VM selection until the original location is known and preserves VM-born choices", () => {
    expect(threadMoveOriginalLocationBlocker(true, null)).toBe("Checking thread location…");
    expect(threadMoveOriginalLocationBlocker(true, {})).toBe(
      "Original project could not be determined.",
    );
    expect(threadMoveOriginalLocationBlocker(true, null, "Network failed")).toBe(
      "Could not check the original project. Reopen Run on to retry.",
    );
    expect(threadMoveOriginalLocationBlocker(true, { originalLocation: null })).toBeNull();
    expect(threadMoveOriginalLocationBlocker(true, { originalLocation })).toBeNull();
    expect(threadMoveOriginalLocationBlocker(false, null)).toBeNull();
  });

  it("does not add the current environment as a return destination", () => {
    expect(
      threadMoveProjectTargets(
        original,
        projects,
        environments,
        "github:team/repo",
        originalLocation,
      ).filter((target) => target.destination.environmentId === original.environmentId),
    ).toEqual([]);
  });

  const connected = {
    phase: "connected" as const,
    registered: true,
    enabled: true,
    projectsReady: true,
  };
  it("waits for a live project snapshot before declaring the original project unavailable", () => {
    const missing = targets([source, sibling])[0]!;
    expect(
      threadMoveProjectTargetAvailability(missing, { ...connected, projectsReady: false }),
    ).toEqual({ action: null, detail: "Loading projects…" });
    expect(threadMoveProjectTargetAvailability(missing, connected)).toEqual({
      action: null,
      detail: "Original project is unavailable",
    });
    expect(threadMoveProjectTargetAvailability(targets()[0]!, connected)).toEqual({
      action: "select",
      detail: null,
    });
  });

  it("reconnects the original machine before checking missing project metadata", () => {
    const missing = targets([], [])[0]!;
    expect(
      threadMoveProjectTargetAvailability(missing, { ...connected, phase: "available" }),
    ).toEqual({ action: "check", detail: "Not connected · Check connection" });
    expect(
      threadMoveProjectTargetAvailability(missing, { ...connected, phase: "offline" }),
    ).toEqual({ action: null, detail: "Offline" });
    expect(
      threadMoveProjectTargetAvailability(missing, { ...connected, failureReason: "permission" }),
    ).toEqual({ action: null, detail: "Access required" });
    expect(
      threadMoveProjectTargetAvailability(missing, { ...connected, registered: false }),
    ).toEqual({ action: null, detail: "Original machine is unavailable" });
    expect(threadMoveProjectTargetAvailability(missing, { ...connected, enabled: false })).toEqual({
      action: null,
      detail: "Enable this machine in Connections",
    });
  });

  it("does not change other machines' availability while their project snapshots refresh", () => {
    const otherTarget = targets().find((target) => target.destination.projectId === other.id)!;
    expect(
      threadMoveProjectTargetAvailability(otherTarget, { ...connected, projectsReady: false }),
    ).toEqual({ action: "select", detail: null });
  });
});

describe("uploaded VM move repository", () => {
  const thread = {
    id: ThreadId.make("uploaded-thread"),
    relayRouting: {
      relayUrl: "https://relay.example.test",
      generation: 4,
      phase: "active" as const,
    },
  };
  const source: EnvironmentProject = {
    environmentId: EnvironmentId.make("vm"),
    id: ProjectId.make(`vm:${thread.id}`),
    title: "VM workspace",
    workspaceRoot: "/workspace/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: command().createdAt,
    updatedAt: command().createdAt,
  };
  const environment = { environmentId: source.environmentId, threadVm: { threadId: thread.id } };
  const status = {
    threadId: thread.id,
    generation: 4,
    repository: { canonicalKey: "github.com/team/repo", branch: "main", revision: "a".repeat(40) },
  };
  it("offers the existing Mac checkout after Reset without adding a remote to the uploaded Git bundle", () => {
    const destination: EnvironmentProject = {
      ...source,
      environmentId: EnvironmentId.make("mac"),
      id: ProjectId.make("mac-project"),
      workspaceRoot: "/Users/me/repo",
      repositoryIdentity: {
        canonicalKey: "github.com/team/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:team/repo.git",
        },
      },
    };
    const canonicalKey = threadMoveRepositoryCanonicalKey(source, thread, environment, status);
    expect(canonicalKey).toBe("github.com/team/repo");
    expect(
      threadMoveProjectTargets(
        source,
        [source, destination],
        [
          {
            entry: {
              target: new PrimaryConnectionTarget({
                environmentId: destination.environmentId,
                label: "My Mac",
                httpBaseUrl: "http://localhost",
                wsBaseUrl: "ws://localhost",
              }),
            },
          },
        ],
        canonicalKey,
      ).map((target) => target.destination),
    ).toEqual([{ kind: "environment", environmentId: "mac", projectId: "mac-project" }]);
  });
  it("does not reuse retained upload identity for another thread, generation, or ordinary project", () => {
    expect(
      threadMoveRepositoryCanonicalKey(source, thread, environment, { ...status, generation: 3 }),
    ).toBeUndefined();
    expect(
      threadMoveRepositoryCanonicalKey(source, thread, environment, {
        ...status,
        threadId: ThreadId.make("another"),
      }),
    ).toBeUndefined();
    expect(
      threadMoveRepositoryCanonicalKey(
        source,
        thread,
        { ...environment, threadVm: { threadId: ThreadId.make("another") } },
        status,
      ),
    ).toBeUndefined();
    expect(
      threadMoveRepositoryCanonicalKey(
        source,
        thread,
        { environmentId: source.environmentId },
        status,
      ),
    ).toBeUndefined();
    expect(
      threadMoveRepositoryCanonicalKey(
        { ...source, id: ProjectId.make("ordinary") },
        thread,
        environment,
        status,
      ),
    ).toBeUndefined();
    expect(
      threadMoveRepositoryCanonicalKey(
        source,
        thread,
        { ...environment, environmentId: EnvironmentId.make("other") },
        status,
      ),
    ).toBeUndefined();
  });
});

describe("move provider eligibility", () => {
  it("limits fresh private VMs to default Codex while keeping named normal transfers", () => {
    const named = { instanceId: "codex-work", driver: "codex" };
    const standard = { instanceId: "codex", driver: "codex" };
    expect(threadMoveProviderSupported(named, "vm")).toBe(false);
    expect(threadMoveProviderSupported(named, "environment")).toBe(true);
    expect(threadMoveProviderSupported(standard, "vm")).toBe(true);
    // Leaving a VM for an ordinary environment remains available.
    expect(threadMoveProviderSupported(standard, "environment")).toBe(true);
  });
  it("requires a real Codex driver even if another provider uses the default name", () => {
    for (const provider of [
      undefined,
      ...["claudeAgent", "cursor", "grok", "opencode", "antigravity"].map((driver) => ({
        instanceId: "codex",
        driver,
      })),
    ]) {
      expect(threadMoveProviderSupported(provider, "vm")).toBe(false);
      expect(threadMoveProviderSupported(provider, "environment")).toBe(false);
    }
  });
});

it("blocks moves until workflow ownership is released, including terminal state awaiting cleanup", () => {
  for (const status of ["running", "awaiting_review", "paused", "cancelling", "done"]) {
    expect(
      threadWorkflowMoveBlocker({ workflowJob: { jobId: "job", repositoryId: "repo", status } }),
    ).not.toBeNull();
  }
  expect(threadWorkflowMoveBlocker({ workflowJob: null })).toBeNull();
  expect(threadWorkflowMoveBlocker({})).toBeNull();
});
