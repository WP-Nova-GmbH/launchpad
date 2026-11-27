import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationGetCommandReceiptResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "../state/threadState.ts";
import {
  createThreadMoveSubmissionJournal,
  type ThreadMoveSubmissionStorage,
} from "./threadMoveSubmission.ts";
import {
  recoverThreadMove,
  threadMoveObservation,
  threadMoveSnapshotReached,
} from "./threadMoveRecovery.ts";

const environmentId = EnvironmentId.make("current-machine");
const threadId = ThreadId.make("thread");
const scope = { accountId: "alice", relayUrl: "https://relay.test", environmentId, threadId };
const at = "2026-10-21T10:00:00.000Z";
const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Moved thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  pullRequests: [],
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const route = { relayUrl: scope.relayUrl, generation: 2, phase: "active" as const };
const placement = { environmentId, generation: 2, operationId: null };
const detail = (sequence: number) => ({
  ...EMPTY_ENVIRONMENT_THREAD_STATE,
  status: "live" as const,
  snapshotSequence: sequence,
  data: Option.some(thread),
});

async function harness(admission: "local" | "relay" | "lost" = "relay") {
  const values = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();
  const storage: ThreadMoveSubmissionStorage = {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    withLock: (key, action) => {
      const result = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
      locks.set(key, result);
      return result;
    },
  };
  const journal = createThreadMoveSubmissionJournal(storage);
  await journal.submit(
    scope,
    () => ({
      type: "thread.move.enqueue",
      commandId: CommandId.make("move-command"),
      messageId: MessageId.make("move-message"),
      threadId,
      position: "next",
      destination: { kind: "vm" },
      createdAt: at,
    }),
    async (command) => {
      if (admission === "lost") throw new Error("Reply lost");
      return admission === "local"
        ? { sequence: 70 }
        : { relay: { commandId: command.commandId, position: 1, receipt: null } };
    },
    async () => ({ status: "unknown" }),
    () => true,
  );
  const saved = (await journal.read(scope))!;
  let snapshot = detail(60);
  let location = placement;
  let receipt: typeof OrchestrationGetCommandReceiptResult.Type = {
    status: "accepted",
    sequence: 70,
  };
  let receiptReads = 0;
  let current = true;
  const options = {
    checkLocation: async () => location,
    readReceipt: async () => {
      receiptReads++;
      return receipt;
    },
    readObservation: () => threadMoveObservation(environmentId, snapshot, location, route),
    isCurrent: () => current,
  };
  return {
    journal,
    saved,
    options,
    setSnapshot: (sequence: number) => {
      snapshot = detail(sequence);
    },
    setLocation: (value: typeof placement) => {
      location = value;
    },
    setReceipt: (value: typeof receipt) => {
      receipt = value;
    },
    signOut: () => {
      current = false;
    },
    receiptReads: () => receiptReads,
  };
}

describe("saved move recovery on the current machine", () => {
  it("clears the accepted initial move when live source detail has caught up after cancellation", async () => {
    const h = await harness("local");
    const before = detail(69);
    const after = detail(71);
    expect(threadMoveSnapshotReached(environmentId, before, h.saved, null)).toBe(false);
    expect(
      await h.journal.observe(
        scope,
        h.saved,
        threadMoveObservation(environmentId, before, null, null),
      ),
    ).toEqual(h.saved);
    expect(threadMoveSnapshotReached(environmentId, after, h.saved, null)).toBe(true);
    expect(
      await h.journal.observe(
        scope,
        h.saved,
        threadMoveObservation(environmentId, after, null, null),
      ),
    ).toBeNull();
    expect(await h.journal.read(scope)).toBeNull();
    const next = {
      ...h.saved.command,
      commandId: CommandId.make("retry-command"),
      messageId: MessageId.make("retry-message"),
    };
    expect(
      await h.journal.submit(
        scope,
        () => next,
        async () => ({ sequence: 72 }),
        async () => ({ status: "unknown" }),
        () => true,
        { allowExisting: false },
      ),
    ).toEqual({ status: "accepted", sequence: 72 });
    expect((await h.journal.read(scope))?.command).toEqual(next);
  });

  it("keeps the initial move when detail is cached, belongs to a different source, or has a competing placement", async () => {
    const h = await harness("local");
    for (const observation of [
      threadMoveObservation(environmentId, { ...detail(71), status: "cached" }, null, null),
      threadMoveObservation(EnvironmentId.make("other"), detail(71), null, null),
      threadMoveObservation(
        environmentId,
        {
          ...detail(71),
          data: Option.some({ ...thread, id: ThreadId.make("other-thread") }),
        },
        null,
        null,
      ),
      threadMoveObservation(environmentId, detail(71), placement, null),
      threadMoveObservation(environmentId, detail(71), null, route),
    ]) {
      expect(await h.journal.observe(scope, h.saved, observation)).toEqual(h.saved);
    }
  });

  it("keeps relay admission on the routed recovery path even after reading an execution receipt", async () => {
    const h = await harness();
    await h.journal.reconcile(scope, h.saved, {
      status: "accepted",
      sequence: 70,
    });
    const saved = (await h.journal.read(scope))!;
    expect(saved.acceptedViaRelay).toBe(true);
    expect(
      await h.journal.observe(
        scope,
        saved,
        threadMoveObservation(environmentId, detail(71), null, null),
      ),
    ).toEqual(saved);
  });

  it("checks a recovered initial local receipt without asking the relay for placement", async () => {
    const h = await harness("lost");
    await h.journal.reconcile(scope, h.saved, { status: "accepted", sequence: 70 });
    let sequence = 69;
    const options = {
      ...h.options,
      checkLocation: async () => {
        throw new Error("Thread has no relay placement");
      },
      readObservation: () => threadMoveObservation(environmentId, detail(sequence), null, null),
    };
    expect(await recoverThreadMove(h.journal, scope, h.saved, options)).toMatchObject({
      accepted: true,
      acceptedSequence: 70,
    });
    sequence = 71;
    expect(await recoverThreadMove(h.journal, scope, h.saved, options)).toBeNull();
  });

  it("retains execution proof until the paired snapshot catches up, without another receipt RPC", async () => {
    const h = await harness();
    const pending = await recoverThreadMove(h.journal, scope, h.saved, h.options);
    expect(pending?.executionProof).toMatchObject({ environmentId, generation: 2, sequence: 70 });
    expect(threadMoveSnapshotReached(environmentId, detail(60), pending, route)).toBe(false);
    expect(threadMoveSnapshotReached(environmentId, detail(70), pending, route)).toBe(true);
    expect(
      threadMoveSnapshotReached(environmentId, detail(70), pending, { ...route, generation: 3 }),
    ).toBe(false);
    const resolved = await h.journal.observe(
      scope,
      pending!,
      threadMoveObservation(environmentId, detail(70), placement, route),
    );
    expect(resolved).toBeNull();
    expect(h.receiptReads()).toBe(1);
  });

  it("resolves a completed imported request with the current machine's receipt sequence", async () => {
    const h = await harness();
    h.setSnapshot(75);
    expect(await recoverThreadMove(h.journal, scope, h.saved, h.options)).toBeNull();
  });

  it("publishes a changed location without reading a receipt on the old machine", async () => {
    const h = await harness();
    h.setLocation({
      ...placement,
      environmentId: EnvironmentId.make("next-machine"),
      generation: 3,
    });
    const pending = await recoverThreadMove(h.journal, scope, h.saved, h.options);
    expect(pending?.command).toEqual(h.saved.command);
    expect(pending?.executionProof).toBeUndefined();
    expect(h.receiptReads()).toBe(0);
  });

  it("does not reuse a receipt when ownership changes during the read", async () => {
    const h = await harness();
    const pending = await recoverThreadMove(h.journal, scope, h.saved, {
      ...h.options,
      readReceipt: async () => {
        h.setLocation({ ...placement, generation: 3 });
        return { status: "accepted", sequence: 70 };
      },
    });
    expect(pending?.executionProof).toBeUndefined();
    expect(await h.journal.read(scope)).not.toBeNull();
  });

  it("keeps pending and unknown results while a handoff is unfinished", async () => {
    const h = await harness();
    h.setReceipt({ status: "unknown" });
    expect(
      (await recoverThreadMove(h.journal, scope, h.saved, h.options))?.executionProof,
    ).toBeUndefined();
    expect(h.receiptReads()).toBe(1);
    expect(
      await recoverThreadMove(h.journal, scope, h.saved, {
        ...h.options,
        checkLocation: async () => ({ ...placement, operationId: "handoff" }),
      }),
    ).not.toBeNull();
    expect(h.receiptReads()).toBe(1);
  });

  it("retains a confirmed rejection for explicit discard", async () => {
    const h = await harness();
    h.setReceipt({ status: "rejected", sequence: 70, detail: "Cannot move this thread" });
    const rejected = await recoverThreadMove(h.journal, scope, h.saved, h.options);
    expect(rejected?.rejection).toBe("Cannot move this thread");
  });

  it("ignores late results after the account changes", async () => {
    const h = await harness();
    await expect(
      recoverThreadMove(h.journal, scope, h.saved, {
        ...h.options,
        readReceipt: async () => {
          h.signOut();
          return { status: "accepted", sequence: 70 };
        },
      }),
    ).rejects.toThrow("account changed");
    expect((await h.journal.read(scope))?.executionProof).toBeUndefined();
  });

  it("does not use cached or retired queue detail as execution evidence", () => {
    expect(
      threadMoveObservation(environmentId, { ...detail(70), status: "cached" }, placement, route),
    ).toEqual({ entries: [] });
    expect(
      threadMoveObservation(environmentId, detail(70), placement, { ...route, phase: "retired" }),
    ).toEqual({ entries: [] });
  });
  it("does not hand a saved move to a stale source queue after ownership changed", async () => {
    const h = await harness();
    const queuedThread: OrchestrationThread = {
      ...thread,
      promptQueue: {
        enabled: true,
        revision: 1,
        pauseReason: null,
        handoff: null,
        awaitingTurnId: null,
        admissions: [],
        finalizedTurnId: null,
        entries: [
          {
            kind: "move",
            messageId: h.saved.command.messageId,
            destination: h.saved.command.destination,
            state: "pending",
            revision: 1,
            acceptedSequence: 70,
            createdAt: at,
          },
        ],
      },
    };
    const queuedState = { ...detail(70), data: Option.some(queuedThread) };
    for (const confirmed of [
      null,
      { ...placement, environmentId: "other", generation: 3 },
      { ...placement, operationId: "moving" },
    ]) {
      const observation = threadMoveObservation(environmentId, queuedState, confirmed, route);
      expect(observation.entries).toEqual([]);
      expect(await h.journal.observe(scope, h.saved, observation)).not.toBeNull();
    }
    const valid = threadMoveObservation(environmentId, queuedState, placement, route);
    expect(await h.journal.observe(scope, h.saved, valid)).toBeNull();
  });
});
