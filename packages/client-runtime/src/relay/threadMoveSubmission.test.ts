import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ThreadMoveEnqueueCommand,
} from "@t3tools/contracts";
import {
  createThreadMoveSubmissionJournal,
  threadMoveProjectTargets,
  threadMoveRepositoryCanonicalKey,
  threadMoveProviderSupported,
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
    expect(await restarted.read(scope)).toBeNull();
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
