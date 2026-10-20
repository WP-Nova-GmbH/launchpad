import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createThreadVmActionJournal,
  type ThreadVmActionSubmission,
} from "./threadVmActionSubmission.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
const scope = { accountId: "owner", relayUrl: "https://relay.example.test" };
const operationId = "00000000-0000-4000-8000-000000000001";
const allocationId = "00000000-0000-4000-8000-000000000002";
const savedDiskOperationId = "00000000-0000-4000-8000-000000000003";
const request: ThreadVmActionSubmission = {
  environmentId: EnvironmentId.make("old-vm"),
  threadId: ThreadId.make("work"),
  action: {
    type: "restore",
    payload: { operationId, allocationId, savedDiskOperationId, expectedGeneration: 4 },
  },
};
const accepted = {
  status: "accepted",
  restore: {
    operationId,
    allocationId,
    threadId: request.threadId,
    generation: 5,
    phase: "pending",
    errorCode: null,
  },
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
describe("durable VM lifecycle requests", () => {
  it("keeps the owner-selected backup and native point through a lost reply and restart", async () => {
    const disk = storage();
    const selected: ThreadVmActionSubmission = {
      ...request,
      action: {
        type: "restore_backup",
        payload: {
          operationId,
          allocationId,
          expectedGeneration: 4,
          backup: {
            sourceAllocationId: "00000000-0000-4000-8000-000000000005",
            backupOperationId: savedDiskOperationId,
            capturedAt: "2026-10-15T12:00:00.000Z",
            nativeCheckpointOperationId: "00000000-0000-4000-8000-000000000006",
          },
        },
      },
    };
    await createThreadVmActionJournal(disk).prepare(scope, selected);
    const restarted = createThreadVmActionJournal(disk);
    if (selected.action.type !== "restore_backup") throw new Error("Invalid fixture");
    const retry = await restarted.prepare(scope, {
      ...selected,
      action: {
        ...selected.action,
        payload: {
          ...selected.action.payload,
          operationId: "00000000-0000-4000-8000-000000000007",
          backup: { ...selected.action.payload.backup, capturedAt: "2026-10-15T13:00:00.000Z" },
        },
      },
    });
    expect(retry).toEqual(selected);
    await expect(
      restarted.acknowledge(scope, retry, {
        ...accepted,
        restore: { ...accepted.restore, allocationId: "wrong" },
      }),
    ).rejects.toThrow("different");
    expect(await restarted.list(scope)).toEqual([selected]);
    expect(await restarted.acknowledge(scope, retry, accepted)).toBe(true);
    expect(await restarted.list(scope)).toEqual([]);
    await restarted.prepare(scope, selected);
    await expect(
      restarted.acknowledgeBackupCancellation(
        scope,
        {
          threadId: selected.threadId,
          operationId,
        },
        { threadId: selected.threadId, operationId: allocationId, phase: "cancelled" },
      ),
    ).rejects.toThrow("not cancelled");
    expect(await restarted.list(scope)).toEqual([selected]);
    await restarted.acknowledgeBackupCancellation(
      scope,
      {
        threadId: selected.threadId,
        operationId,
      },
      { threadId: selected.threadId, operationId, phase: "cancelled" },
    );
    expect(await restarted.list(scope)).toEqual([]);
  });
  it("persists before submission and reuses exact IDs, disk and generation after restart", async () => {
    const disk = storage(),
      first = createThreadVmActionJournal(disk);
    await first.prepare(scope, request);
    const restarted = createThreadVmActionJournal(disk);
    const retry = await restarted.prepare(scope, {
      ...request,
      environmentId: EnvironmentId.make("new-vm"),
      action: {
        type: "restore",
        payload: {
          ...request.action.payload,
          operationId: "00000000-0000-4000-8000-000000000004",
          allocationId,
          savedDiskOperationId,
          expectedGeneration: 9,
        },
      },
    });
    expect(retry).toEqual(request);
    expect(await restarted.list(scope)).toEqual([request]);
  });
  it("serializes competing choices and never replaces an uncertain restore with deletion", async () => {
    const journal = createThreadVmActionJournal(storage());
    const deletion: ThreadVmActionSubmission = {
      ...request,
      action: {
        type: "delete",
        payload: { operationId, expectedGeneration: 4, confirmWorkspaceLoss: true },
      },
    };
    const outcomes = await Promise.allSettled([
      journal.prepare(scope, request),
      journal.prepare(scope, deletion),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    expect(await journal.list(scope)).toEqual([request]);
  });
  it("only hands an exact accepted restore to relay ownership", async () => {
    const journal = createThreadVmActionJournal(storage());
    await journal.prepare(scope, request);
    for (const change of [
      { threadId: "foreign" },
      { operationId: "wrong" },
      { allocationId: "wrong" },
      { generation: 4 },
    ])
      await expect(
        journal.acknowledge(scope, request, {
          ...accepted,
          restore: { ...accepted.restore, ...change },
        }),
      ).rejects.toThrow("different");
    expect(await journal.list(scope)).toEqual([request]);
    expect(await journal.acknowledge(scope, request, accepted)).toBe(true);
    expect(await journal.list(scope)).toEqual([]);
  });
  it("retains quota requests until the original admission or confirmed cancellation", async () => {
    const journal = createThreadVmActionJournal(storage());
    await journal.prepare(scope, request);
    const replacement = {
      requestId: operationId,
      threadId: request.threadId,
      phase: "awaiting_choice",
      victimAllocationId: null,
      errorCode: null,
    };
    expect(
      await journal.acknowledge(scope, request, {
        status: "quota_reached",
        maxVms: 3,
        reservedVms: 3,
        replacement,
        suggestedReplacement: null,
      }),
    ).toBe(false);
    await expect(
      journal.acknowledgeReplacementCancellation(scope, request.threadId, replacement),
    ).rejects.toThrow("not cancelled");
    await expect(
      journal.acknowledgeReplacementCancellation(scope, request.threadId, {
        ...replacement,
        phase: "cancelled",
        requestId: "wrong",
      }),
    ).rejects.toThrow("not cancelled");
    await journal.acknowledgeReplacementCancellation(scope, request.threadId, {
      ...replacement,
      phase: "cancelled",
    });
    expect(await journal.list(scope)).toEqual([]);
  });
  it("keeps deletion reachable after its index entry is gone until physical cleanup completes", async () => {
    const disk = storage(),
      journal = createThreadVmActionJournal(disk);
    const deletion: ThreadVmActionSubmission = {
      ...request,
      action: {
        type: "delete",
        payload: { operationId, expectedGeneration: 4, confirmWorkspaceLoss: true },
      },
    };
    await journal.prepare(scope, deletion);
    const receipt = {
      operationId,
      threadId: request.threadId,
      generation: 4,
      phase: "cleaning",
      errorCode: null,
    };
    expect(await journal.acknowledge(scope, deletion, receipt)).toBe(false);
    const restarted = createThreadVmActionJournal(disk);
    expect(await restarted.list(scope)).toEqual([deletion]);
    await expect(
      restarted.acknowledge(scope, deletion, { ...receipt, generation: 5 }),
    ).rejects.toThrow("different");
    expect(await restarted.acknowledge(scope, deletion, { ...receipt, phase: "completed" })).toBe(
      true,
    );
  });
  it("does not clear another pending thread, account or relay", async () => {
    const journal = createThreadVmActionJournal(storage()),
      second = { ...request, threadId: ThreadId.make("second") };
    await journal.prepare(scope, request);
    await journal.prepare(scope, second);
    expect(await journal.list({ ...scope, accountId: "other" })).toEqual([]);
    expect(await journal.list({ ...scope, relayUrl: "https://other.test" })).toEqual([]);
    await journal.acknowledge({ ...scope, relayUrl: scope.relayUrl + "/" }, request, accepted);
    expect(await journal.list(scope)).toEqual([second]);
  });
  it("publishes storage changes and fails closed on corrupt or mismatched records", async () => {
    const disk = storage(),
      journal = createThreadVmActionJournal(disk);
    let changes = 0;
    const stop = journal.subscribe(() => changes++);
    await journal.prepare(scope, request);
    await journal.acknowledge(scope, request, accepted);
    expect(changes).toBe(2);
    stop();
    await journal.prepare(scope, request);
    expect(changes).toBe(2);
    await expect(
      createThreadVmActionJournal({ ...disk, read: async () => "broken" }).list(scope),
    ).rejects.toThrow();
    await expect(
      journal.acknowledge(
        scope,
        { ...request, environmentId: EnvironmentId.make("foreign") },
        accepted,
      ),
    ).rejects.toThrow("changed");
  });
});
