import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { createThreadQueueControlJournal } from "./threadQueueControlSubmission.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
const threadId = ThreadId.make("queue-thread"),
  commandId = CommandId.make("original-resume");
const scope = { accountId: "owner", relayUrl: "https://relay.example.test", threadId };
const command = {
  type: "thread.queue.resume" as const,
  threadId,
  commandId,
  createdAt: "2026-10-08T00:00:00Z",
  expectedRevision: 9,
};
function storage() {
  const data = new Map<string, string>(),
    locks = new Map<string, Promise<unknown>>();
  const store: ThreadMoveSubmissionStorage = {
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
    withLock: (key, action) => {
      const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
      locks.set(key, next);
      return next;
    },
  };
  return store;
}
describe("durable saved queue controls", () => {
  it("keeps the exact resume revision through restart and competing choices", async () => {
    const disk = storage(),
      first = createThreadQueueControlJournal(disk),
      restarted = createThreadQueueControlJournal(disk);
    const replies = await Promise.all([
      first.prepare(scope, () => command),
      restarted.prepare(scope, () => ({
        ...command,
        type: "thread.queue.pause",
        commandId: CommandId.make("different"),
      })),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    expect((await restarted.read(scope))?.command).toEqual(command);
    await expect(first.discardRejected(scope)).rejects.toThrow("uncertain");
  });
  it("clears a staged acceptance without inventing an execution sequence", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, () => command);
    expect(
      await journal.acknowledge(scope, command, { commandId, position: 4, receipt: null }),
    ).toBeNull();
    expect(await journal.read(scope)).toBeNull();
  });
  it("retains a rejected request until the user dismisses it", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, () => command);
    const rejected = await journal.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "rejected", detail: "Queue revision changed." },
    });
    expect(rejected?.rejection).toBe("Queue revision changed.");
    await journal.discardRejected(scope);
    expect(await journal.read(scope)).toBeNull();
  });
  it("rejects a mismatched relay acknowledgement and another thread's stored command", async () => {
    const disk = storage(),
      journal = createThreadQueueControlJournal(disk);
    await journal.prepare(scope, () => command);
    await expect(
      journal.acknowledge(scope, command, { commandId: "wrong", position: 4, receipt: null }),
    ).rejects.toThrow("another");
    const raw = JSON.stringify({ command: { ...command, threadId: "foreign" }, rejection: null });
    await expect(
      createThreadQueueControlJournal({ ...disk, read: async () => raw }).read(scope),
    ).rejects.toThrow("another thread");
    expect((await journal.read(scope))?.command.commandId).toBe(commandId);
  });
  it("scopes drafts to account, relay and logical thread, without tying them to a host", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, () => command);
    expect(await journal.read({ ...scope, accountId: "other" })).toBeNull();
    expect(await journal.read({ ...scope, relayUrl: "https://foreign.example.test" })).toBeNull();
    expect(await journal.read({ ...scope, threadId: ThreadId.make("other-thread") })).toBeNull();
    expect((await journal.read({ ...scope, relayUrl: scope.relayUrl + "/" }))?.command).toEqual(
      command,
    );
  });
});
