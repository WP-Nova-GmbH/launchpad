import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadCurrentQueue } from "@t3tools/contracts/relay";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { createThreadQueueControlJournal } from "./threadQueueControlSubmission.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
const threadId = ThreadId.make("queue-thread"),
  commandId = CommandId.make("original-resume");
const scope = { accountId: "owner", relayUrl: "https://relay.example.test", threadId };
const current: RelayThreadCurrentQueue = {
  threadId,
  generation: 2,
  cursor: 1000,
  appliedCommandId: null,
  queue: { ...emptyThreadPromptQueue(), revision: 9, enabled: false },
};
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
  it("settles on a newer opposite choice instead of waiting for the requested boolean forever", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, current, () => command);
    await journal.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "accepted", sequence: 42 },
    });
    expect(
      await journal.observe(scope, {
        ...current,
        appliedCommandId: commandId,
        queue: { ...current.queue, revision: 11, enabled: false },
      }),
    ).toBeNull();
    const pause = await journal.prepare(
      scope,
      { ...current, queue: { ...current.queue, revision: 11 } },
      () => ({
        ...command,
        commandId: CommandId.make("next-control"),
        type: "thread.queue.pause",
      }),
    );
    expect(pause.command.commandId).toBe("next-control");
    expect(pause.accepted).toBe(false);
  });
  it("never re-prepares an accepted command while waiting for a current queue", async () => {
    const disk = storage(),
      journal = createThreadQueueControlJournal(disk);
    await journal.prepare(scope, current, () => command);
    const accepted = await journal.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "accepted", sequence: 42 },
    });
    const reloaded = createThreadQueueControlJournal(disk);
    expect(
      await reloaded.prepare(scope, null, () => {
        throw new Error("must not create another command");
      }),
    ).toEqual(accepted);
    // An accepted command only refreshes the projection, even after a failed read and restart.
    await expect(
      reloaded.refresh(
        scope,
        async () => {
          throw new Error("offline");
        },
        async () => {
          throw new Error("must not recheck an accepted command");
        },
      ),
    ).rejects.toThrow("offline");
    expect(await reloaded.read(scope)).toEqual(accepted);
    expect(
      await reloaded.acknowledge(scope, command, { commandId, position: 4, receipt: null }),
    ).toEqual(accepted);
    expect(
      await reloaded.observe(scope, {
        ...current,
        generation: 1,
        appliedCommandId: CommandId.make("another-command"),
      }),
    ).toEqual(accepted);
    expect(
      await reloaded.refresh(
        scope,
        async (id) => ({
          ...current,
          generation: 3,
          appliedCommandId: id ?? null,
          queue: { ...current.queue, revision: 0 },
        }),
        async () => {
          throw new Error("must not recheck an accepted command");
        },
      ),
    ).toBeNull();
  });
  it("recovers a lost reply with its exact command ID before reading the uploaded queue", async () => {
    const disk = storage(),
      journal = createThreadQueueControlJournal(disk);
    await journal.prepare(scope, current, () => command);
    const reloaded = createThreadQueueControlJournal(disk);
    const receiptIds: string[] = [],
      queueIds: (CommandId | undefined)[] = [];
    const waiting = await reloaded.refresh(
      scope,
      async (id) => {
        queueIds.push(id);
        return current;
      },
      async (id) => {
        receiptIds.push(id);
        return { commandId, position: 4, receipt: { status: "accepted", sequence: 42 } };
      },
    );
    expect(receiptIds).toEqual([commandId]);
    expect(queueIds).toEqual([commandId]);
    expect(waiting?.accepted).toBe(true);
    expect(waiting?.command).toEqual(command);
    expect(
      await reloaded.refresh(
        scope,
        async () => ({
          ...current,
          appliedCommandId: commandId,
          queue: { ...current.queue, revision: 10, enabled: true },
        }),
        async () => {
          throw new Error("accepted command must not be retried");
        },
      ),
    ).toBeNull();
  });
  it("waits for our Pause even when a teammate's earlier Resume has already advanced the queue", async () => {
    const journal = createThreadQueueControlJournal(storage());
    const pause = { ...command, type: "thread.queue.pause" as const };
    await journal.prepare(scope, current, () => pause);
    const accepted = await journal.acknowledge(scope, pause, {
      commandId,
      position: 4,
      receipt: { status: "accepted", sequence: 50 },
    });
    // Receipt is persisted, but only the earlier Resume has reached relay history.
    expect(
      await journal.observe(scope, {
        ...current,
        cursor: 999999,
        appliedCommandId: CommandId.make("earlier-resume"),
        queue: { ...current.queue, revision: 10, enabled: true },
      }),
    ).toEqual(accepted);
    // A later Resume is also valid current state; it must not wait for the requested false.
    expect(
      await journal.observe(scope, {
        ...current,
        cursor: 2,
        appliedCommandId: commandId,
        queue: { ...current.queue, revision: 12, enabled: true },
      }),
    ).toBeNull();
  });
  it("waits for the exact command when a request prepared before a move executes on its new owner", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, { ...current, generation: 1 }, () => command);
    const accepted = await journal.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "accepted", sequence: 5 },
    });
    expect(
      await journal.observe(scope, {
        ...current,
        generation: 2,
        cursor: 500,
        queue: { ...current.queue, revision: 99 },
      }),
    ).toEqual(accepted);
    expect(
      await journal.observe(scope, {
        ...current,
        generation: 3,
        appliedCommandId: CommandId.make("someone-elses-command"),
      }),
    ).toEqual(accepted);
    expect(
      await journal.observe(scope, { ...current, generation: 2, appliedCommandId: commandId }),
    ).toBeNull();
  });
  it("does not confuse newer queue data with confirmation of an uncertain command", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, current, () => command);
    const newer = {
      ...current,
      appliedCommandId: commandId,
      queue: { ...current.queue, revision: 12 },
    };
    expect((await journal.observe(scope, newer))?.accepted).toBe(false);
    await expect(journal.observe(scope, { ...newer, threadId: "foreign" })).rejects.toThrow(
      "another thread",
    );
    await expect(
      journal.acknowledge(
        scope,
        { ...command, threadId: ThreadId.make("foreign") },
        {
          commandId,
          position: 4,
          receipt: { status: "accepted", sequence: 42 },
        },
      ),
    ).rejects.toThrow("another queue request");
    await expect(
      journal.acknowledge(
        scope,
        { ...command, commandId: CommandId.make("wrong") },
        {
          commandId: "wrong",
          position: 4,
          receipt: { status: "accepted", sequence: 42 },
        },
      ),
    ).rejects.toThrow("saved queue request changed");
    expect((await journal.read(scope))?.command.commandId).toBe(commandId);
  });

  it("keeps the exact resume revision through restart and competing choices", async () => {
    const disk = storage(),
      first = createThreadQueueControlJournal(disk),
      restarted = createThreadQueueControlJournal(disk);
    const replies = await Promise.all([
      first.prepare(scope, current, () => command),
      restarted.prepare(scope, current, () => ({
        ...command,
        type: "thread.queue.pause",
        commandId: CommandId.make("different"),
      })),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    expect((await restarted.read(scope))?.command).toEqual(command);
    await expect(first.discardRejected(scope)).rejects.toThrow("uncertain");
  });
  it("retains admission and applied receipts through reload until the exact command is projected", async () => {
    const disk = storage(),
      journal = createThreadQueueControlJournal(disk);
    await journal.prepare(scope, current, () => command);
    expect(
      (await journal.acknowledge(scope, command, { commandId, position: 4, receipt: null }))
        ?.command,
    ).toEqual(command);
    const reloaded = createThreadQueueControlJournal(disk);
    expect((await reloaded.read(scope))?.command).toEqual(command);
    const accepted = await reloaded.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "accepted", sequence: 42 },
    });
    expect(accepted?.accepted).toBe(true);
    const restarted = createThreadQueueControlJournal(disk);
    expect(await restarted.observe(scope, { ...current, cursor: 99999 })).toEqual(accepted);
    expect((await restarted.read(scope))?.accepted).toBe(true);
    expect(
      await restarted.observe(scope, {
        ...current,
        appliedCommandId: commandId,
        queue: { ...current.queue, revision: 10, enabled: true },
      }),
    ).toBeNull();
    expect(await restarted.read(scope)).toBeNull();
  });
  it("keeps the request identity for a delayed revision rejection after admission", async () => {
    const disk = storage(),
      journal = createThreadQueueControlJournal(disk);
    await journal.prepare(scope, current, () => command);
    await journal.acknowledge(scope, command, { commandId, position: 4, receipt: null });
    const reloaded = createThreadQueueControlJournal(disk);
    const result = await reloaded.acknowledge(scope, command, {
      commandId,
      position: 4,
      receipt: { status: "rejected", detail: "Queue revision changed." },
    });
    expect(result?.rejection).toBe("Queue revision changed.");
    expect((await reloaded.read(scope))?.command).toEqual(command);
  });
  it("retains a rejected request until the user dismisses it", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, current, () => command);
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
    await journal.prepare(scope, current, () => command);
    await expect(
      journal.acknowledge(scope, command, { commandId: "wrong", position: 4, receipt: null }),
    ).rejects.toThrow("another");
    const raw = JSON.stringify({
      command: { ...command, threadId: "foreign" },
      rejection: null,
      accepted: false,
    });
    await expect(
      createThreadQueueControlJournal({ ...disk, read: async () => raw }).read(scope),
    ).rejects.toThrow("another thread");
    expect((await journal.read(scope))?.command.commandId).toBe(commandId);
  });
  it("recovers existing requests without the optional accepted marker", async () => {
    const disk = storage();
    let firstWrite = true;
    const journal = createThreadQueueControlJournal({
      ...disk,
      write: async (key, value) => {
        await disk.write(key, firstWrite ? JSON.stringify({ command, rejection: null }) : value);
        firstWrite = false;
      },
    });
    await journal.prepare(scope, current, () => command);
    expect((await journal.read(scope))?.accepted).toBeUndefined();
    expect(
      await journal.refresh(
        scope,
        async (id) => ({ ...current, appliedCommandId: id ?? null }),
        async () => ({
          commandId,
          position: 4,
          receipt: { status: "accepted" as const, sequence: 50 },
        }),
      ),
    ).toBeNull();
    expect(await journal.read(scope)).toBeNull();
  });
  it("scopes drafts to account, relay and logical thread, without tying them to a host", async () => {
    const journal = createThreadQueueControlJournal(storage());
    await journal.prepare(scope, current, () => command);
    expect(await journal.read({ ...scope, accountId: "other" })).toBeNull();
    expect(await journal.read({ ...scope, relayUrl: "https://foreign.example.test" })).toBeNull();
    expect(await journal.read({ ...scope, threadId: ThreadId.make("other-thread") })).toBeNull();
    expect((await journal.read({ ...scope, relayUrl: scope.relayUrl + "/" }))?.command).toEqual(
      command,
    );
  });
});
