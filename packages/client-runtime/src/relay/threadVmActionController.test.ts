import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { createThreadVmActionController } from "./threadVmActionController.ts";
import {
  createThreadVmActionJournal,
  type ThreadVmActionSubmission,
} from "./threadVmActionSubmission.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
import type { ManagedRelaySession } from "./managedRelayState.ts";
const session: ManagedRelaySession = {
  accountId: "owner",
  readClerkToken: () => Effect.succeed("private"),
};
const relayUrl = "https://relay.example.test",
  scope = { accountId: session.accountId, relayUrl };
const request: ThreadVmActionSubmission = {
  environmentId: EnvironmentId.make("old-vm"),
  threadId: ThreadId.make("work"),
  action: {
    type: "restore",
    payload: {
      operationId: "00000000-0000-4000-8000-000000000001",
      allocationId: "00000000-0000-4000-8000-000000000002",
      savedDiskOperationId: "00000000-0000-4000-8000-000000000003",
      expectedGeneration: 4,
    },
  },
};
const response = {
  status: "accepted",
  restore: {
    ...request.action.payload,
    threadId: request.threadId,
    generation: 5,
    phase: "pending",
    errorCode: null,
  },
};
const until = (
  controller: ReturnType<typeof createThreadVmActionController>,
  ready: (state: ReturnType<typeof controller.getSnapshot>) => boolean,
) => {
  if (ready(controller.getSnapshot())) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (ready(controller.getSnapshot())) {
        unsubscribe();
        resolve();
      }
    });
  });
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
describe("account-scoped VM action presentation", () => {
  it("saves before sending, serializes repeated clicks, and recovers a lost reply", async () => {
    const journal = createThreadVmActionJournal(storage()),
      arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    const controller = createThreadVmActionController(journal, session, relayUrl, async (input) => {
      expect(await journal.list(scope)).toEqual([request]);
      expect(input.accountId).toBe("owner");
      calls++;
      if (calls === 1) {
        arrived.resolve();
        await release.promise;
        throw new Error("Lost response");
      }
      return response;
    });
    const dispose = controller.mount();
    await until(controller, (state) => state.ready);
    const pending = controller.run(request);
    await arrived.promise;
    expect(await controller.run(request)).toBe(false);
    expect(calls).toBe(1);
    release.resolve();
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().error).toBe("Lost response");
    expect(await journal.list(scope)).toEqual([request]);
    expect(await controller.run(request)).toBe(true);
    expect(await journal.list(scope)).toEqual([]);
    dispose();
  });
  it("does not consume a late acceptance after disposal or Strict Mode remount", async () => {
    const journal = createThreadVmActionJournal(storage()),
      arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const controller = createThreadVmActionController(journal, session, relayUrl, async () => {
      arrived.resolve();
      await release.promise;
      return response;
    });
    const dispose = controller.mount();
    await until(controller, (state) => state.ready);
    const pending = controller.run(request);
    await arrived.promise;
    dispose();
    const remount = controller.mount();
    await until(controller, (state) => state.ready);
    release.resolve();
    expect(await pending).toBe(false);
    expect(await journal.list(scope)).toEqual([request]);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(await controller.run(request)).toBe(true);
    remount();
  });
  it("keeps another account empty and blocks actions when storage cannot be verified", async () => {
    const disk = storage(),
      journal = createThreadVmActionJournal(disk);
    await journal.prepare(scope, request);
    const other = createThreadVmActionController(
      journal,
      { ...session, accountId: "other" },
      relayUrl,
      async () => {
        throw new Error("Must not submit");
      },
    );
    const stop = other.mount();
    await until(other, (state) => state.ready);
    expect(other.getSnapshot().entries).toEqual([]);
    stop();
    const broken = createThreadVmActionController(
      createThreadVmActionJournal({ ...disk, read: async () => "corrupt" }),
      session,
      relayUrl,
      async () => {
        throw new Error("Must not submit");
      },
    );
    const dispose = broken.mount();
    await until(broken, (state) => state.error !== null);
    expect(await broken.run(request)).toBe(false);
    expect(broken.getSnapshot().ready).toBe(false);
    dispose();
  });
});
