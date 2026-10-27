import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  ProjectId,
  type ThreadMoveQueueEntry,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement, RelayThreadVmStatus } from "@t3tools/contracts/relay";
import {
  threadMoveQueuePresentation,
  threadMoveQueueOwnership,
} from "./threadMoveQueuePresentation.ts";
import { refreshSavedConversation } from "./portableThreadLibrary.ts";

const threadId = ThreadId.make("thread");
const entry: ThreadMoveQueueEntry = {
  kind: "move",
  messageId: MessageId.make("message"),
  destination: { kind: "vm" },
  revision: 1,
  acceptedSequence: 1,
  createdAt: "2026-10-26T09:00:00Z",
  state: "moving",
  operationId: CommandId.make("move"),
};
const placement: RelayPortableThreadPlacement = {
  threadId,
  environmentId: "mac",
  projectId: "project",
  organizationId: "org",
  repositoryId: "repo",
  ownerUserId: "owner",
  generation: 2,
  operationId: "move",
  moveProgress: [
    {
      threadId,
      operationId: "move",
      environmentId: "mac",
      generation: 2,
      participant: "source",
      attempt: 1,
      revision: 1,
      stage: "uploading",
      completedBytes: 1024,
      totalBytes: 2048,
      completedArtifacts: 0,
      totalArtifacts: 1,
      updatedAt: "2026-10-26T09:00:00Z",
    },
  ],
};
const status: RelayThreadVmStatus = {
  threadId,
  generation: 2,
  allocation: { allocationId: "vm", ownerUserId: "owner", state: "creating" },
  setupPhase: "pending",
  capacityState: "started",
  activity: "unknown",
  pausePhase: null,
  resumePhase: null,
  backupPhase: null,
  lastVerifiedBackupAt: null,
};

describe("move queue presentation", () => {
  it("does not substitute a generic operation ID for restore, reset or final-save controls", () => {
    for (const lifecycle of [
      {
        restore: {
          operationId: "lifecycle",
          phase: "preparing" as const,
          canCancel: true,
          errorCode: "failed",
        },
      },
      { reset: { operationId: "lifecycle", phase: "creating" as const, errorCode: null } },
      {
        finalSave: {
          operationId: "lifecycle",
          phase: "saving" as const,
          reason: "idle" as const,
          errorCode: "failed",
        },
      },
    ]) {
      const current = { ...placement, operationId: "lifecycle" };
      const vm = { ...status, ...lifecycle };
      expect(
        threadMoveQueueOwnership({ entries: [], placement: current, status: vm }),
      ).toMatchObject({ fallback: false, ownsNotice: false });
      expect(threadMoveQueuePresentation({ placement: current, status: vm })).toBeNull();
      expect(
        threadMoveQueueOwnership({
          entries: [{ ...entry, state: "pending" }],
          placement: current,
          status: vm,
        }).ownsNotice,
      ).toBe(false);
    }
  });

  it("lets a verified fallback retain required sign-in without a queue entry", () => {
    const pending = {
      ...status,
      pendingProviderAuth: {
        operationId: "move",
        allocationId: "vm",
        environmentId: EnvironmentId.make("vm"),
        generation: 3,
        instanceId: "codex" as const,
      },
    };
    expect(threadMoveQueuePresentation({ placement, status: pending })).toMatchObject({
      ownsNotice: true,
      label: "Sign in to Codex",
      tone: "attention",
    });
    expect(
      threadMoveQueuePresentation({
        placement: { ...placement, moveProgress: [] },
        status: pending,
      }),
    ).toBeNull();
    expect(
      threadMoveQueueOwnership({
        entries: [{ ...entry, state: "pending" }],
        placement: { ...placement, moveProgress: [] },
        status: pending,
      }).ownsNotice,
    ).toBe(false);
  });

  it("does not hide a notice or expose its action for a stale operation or generation", () => {
    for (const current of [
      { ...placement, operationId: "different", moveProgress: [] },
      { ...placement, generation: 3, moveProgress: [] },
    ])
      expect(
        threadMoveQueueOwnership({ entries: [entry], placement: current, status }).ownsNotice,
      ).toBe(false);
    expect(
      threadMoveQueuePresentation({ entry, placement, status: { ...status, generation: 3 } })
        ?.ownsNotice,
    ).toBe(false);
  });

  it("shows verified transfer receipts, without a total percentage or premature finished steps", () => {
    expect(threadMoveQueuePresentation({ entry, placement, status })).toMatchObject({
      label: "Uploading files",
      detail: "1 KB of 2 KB verified",
      step: 0,
      steps: ["Upload", "Prepare VM", "Switch"],
    });
    const uploaded = {
      ...placement,
      moveProgress: placement.moveProgress!.map((snapshot) => ({
        ...snapshot,
        completedBytes: 2048,
        completedArtifacts: 1,
      })),
    };
    expect(threadMoveQueuePresentation({ entry, placement: uploaded, status })).toMatchObject({
      label: "Preparing VM",
      step: 1,
    });
    expect(
      threadMoveQueuePresentation({ entry, placement: { ...placement, operationId: null } })?.step,
    ).toBeNull();
    expect(
      threadMoveQueuePresentation({ placement: { ...placement, operationId: null } }),
    ).toBeNull();
  });
  it.each([false, true])("shows pending checkout blockers when paused=%s", (queuePaused) => {
    const detail = "Waiting for other work in this checkout: Build API and Fix login.";
    expect(
      threadMoveQueuePresentation({
        entry: { ...entry, state: "pending", waitingForCheckout: true, detail },
        placement,
        status,
        queuePaused,
      }),
    ).toMatchObject({
      label: queuePaused ? "Waiting for the queue to resume" : "Waiting for shared checkout",
      detail,
      tone: "neutral",
      waiting: true,
      step: null,
      completedSteps: [],
    });
  });
  it("preserves ordinary pending notices without marking them as checkout waits", () => {
    const detail = "Local terminal shutdown is unverified. Cancel to continue here.";
    expect(
      threadMoveQueuePresentation({ entry: { ...entry, state: "pending", detail } }),
    ).toMatchObject({ label: "Waiting in queue", detail, tone: "neutral" });
  });
  it("shows a claimed checkout wait instead of VM preparation or transfer progress", () => {
    const detail = "Waiting for other work in this checkout: Build API.";
    expect(
      threadMoveQueuePresentation({
        entry: { ...entry, waitingForCheckout: true, detail },
        placement,
        status,
      }),
    ).toMatchObject({
      label: "Waiting for shared checkout",
      detail,
      tone: "neutral",
      waiting: false,
      step: null,
      completedSteps: [],
    });
  });
  it("returns to verified progress when capture starts after a checkout wait", () => {
    const capturing = {
      ...placement,
      moveProgress: placement.moveProgress!.map((snapshot) => ({
        ...snapshot,
        stage: "capturing" as const,
        totalBytes: null,
      })),
    };
    expect(threadMoveQueuePresentation({ entry, placement: capturing, status })).toMatchObject({
      label: "Saving conversation",
      detail: null,
      tone: "neutral",
      step: 0,
    });
  });
  it("keeps cancellation and failures ahead of a claimed checkout wait", () => {
    const waiting = { ...entry, waitingForCheckout: true, detail: "Waiting for Build API." };
    for (const [cancellation, label] of [
      ["sending", "Requesting cancellation…"],
      ["requested", "Cancelling move…"],
      ["unknown", "Could not confirm cancellation"],
    ] as const)
      expect(
        threadMoveQueuePresentation({ entry: waiting, placement, cancellation }),
      ).toMatchObject({ label, step: null, completedSteps: [] });
    expect(
      threadMoveQueuePresentation({
        entry: { ...waiting, state: "blocked", detail: "Capture failed" },
        placement,
      }),
    ).toMatchObject({ label: "Move needs attention", detail: "Capture failed", tone: "danger" });
    expect(
      threadMoveQueuePresentation({ entry: waiting, placement, error: "Connection unavailable" }),
    ).toMatchObject({
      label: "Could not check move status",
      detail: "Connection unavailable",
      tone: "attention",
    });
  });
  it("never borrows progress from another operation, generation, or a pending move", () => {
    for (const changed of [
      { ...placement, operationId: "older" },
      { ...placement, generation: 7 },
      {
        ...placement,
        moveProgress: placement.moveProgress!.map((snapshot) => ({
          ...snapshot,
          threadId: "other",
        })),
      },
    ])
      expect(threadMoveQueuePresentation({ entry, placement: changed })?.step).toBeNull();
    expect(
      threadMoveQueuePresentation({
        entry: { ...entry, state: "pending" },
        placement,
        status,
        queuePaused: true,
      }),
    ).toMatchObject({ label: "Waiting for the queue to resume", step: null });
  });
  it("prioritizes cancellation, failure and provider sign-in over stale upload progress", () => {
    expect(
      threadMoveQueuePresentation({ entry, placement, cancellation: "requested" }),
    ).toMatchObject({ label: "Cancelling move…", step: null });
    expect(
      threadMoveQueuePresentation({ entry, placement, cancellation: "unknown" }),
    ).toMatchObject({ label: "Could not confirm cancellation", tone: "attention" });
    expect(
      threadMoveQueuePresentation({
        entry: { ...entry, state: "blocked", detail: "Destination offline" },
        placement,
      }),
    ).toMatchObject({
      label: "Move needs attention",
      detail: "Destination offline",
      tone: "danger",
    });
    const binding = {
      operationId: "move",
      allocationId: "vm",
      environmentId: EnvironmentId.make("vm"),
      generation: 3,
      instanceId: "codex" as const,
    };
    expect(
      threadMoveQueuePresentation({
        entry: { ...entry, waitingForCheckout: true },
        placement,
        status: { ...status, pendingProviderAuth: binding },
      }),
    ).toMatchObject({ label: "Sign in to Codex", tone: "attention", step: 1, completedSteps: [] });
    expect(
      threadMoveQueuePresentation({
        entry,
        placement,
        status: { ...status, pendingProviderAuth: { ...binding, operationId: "old" } },
      })?.label,
    ).toBe("Uploading files");
  });
  it.each([false, true])(
    "prioritizes cancellation for a pending move when paused=%s",
    (queuePaused) => {
      const pending = {
        ...entry,
        state: "pending" as const,
        waitingForCheckout: true,
        detail: "Waiting for other work in this checkout: Build API.",
      };
      for (const [cancellation, label] of [
        ["sending", "Requesting cancellation…"],
        ["requested", "Cancelling move…"],
        ["unknown", "Could not confirm cancellation"],
      ] as const) {
        expect(
          threadMoveQueuePresentation({ entry: pending, cancellation, queuePaused }),
        ).toMatchObject({
          label,
          step: null,
          completedSteps: [],
        });
      }
    },
  );
  it("keeps destination restore progress across the committed generation and supports returning home", () => {
    const returning = {
      ...entry,
      destination: {
        kind: "environment" as const,
        environmentId: EnvironmentId.make("home"),
        projectId: ProjectId.make("project"),
      },
    };
    const destination = {
      ...placement.moveProgress![0]!,
      participant: "destination" as const,
      environmentId: "home",
      generation: 3,
      stage: "installing" as const,
      totalBytes: null,
    };
    for (const current of [placement, { ...placement, environmentId: "home", generation: 3 }])
      expect(
        threadMoveQueuePresentation({
          entry: returning,
          placement: { ...current, moveProgress: [...placement.moveProgress!, destination] },
          status,
        }),
      ).toMatchObject({
        label: "Restoring files and conversation",
        step: 1,
        steps: ["Save", "Restore", "Switch"],
        sourceEnvironmentId: "mac",
      });
  });
});

describe("saved conversation refresh", () => {
  it("reads placement first and stays pending until every independent section settles", async () => {
    const nextPlacement = Promise.withResolvers<RelayPortableThreadPlacement>();
    const nextStatus = Promise.withResolvers<void>();
    const calls: string[] = [];
    let finished = false;
    const refresh = refreshSavedConversation({
      signal: new AbortController().signal,
      placement: () => {
        calls.push("location");
        return nextPlacement.promise;
      },
      status: async (current) => {
        expect(current.environmentId).toBe("destination");
        calls.push("status");
        await nextStatus.promise;
      },
      queue: async () => {
        calls.push("queue");
        throw new Error("Queue unavailable");
      },
      history: async () => {
        calls.push("history");
      },
    }).then((result) => {
      finished = true;
      return result;
    });
    expect(calls).toEqual(["location"]);
    nextPlacement.resolve({ ...placement, environmentId: "destination" });
    await nextPlacement.promise;
    await Promise.resolve();
    expect(finished).toBe(false);
    nextStatus.resolve();
    expect(await refresh).toEqual([{ section: "Queue", detail: "Queue unavailable" }]);
    expect(calls).toEqual(["location", "queue", "history", "status"]);
  });
  it("still reads history when placement fails, and never reads VM status without a verified placement", async () => {
    const calls: string[] = [];
    const result = await refreshSavedConversation({
      signal: new AbortController().signal,
      placement: async () => {
        throw new Error("Location unavailable");
      },
      status: async () => {
        calls.push("status");
      },
      queue: async () => {
        calls.push("queue");
      },
      history: async () => {
        calls.push("history");
      },
    });
    expect(calls).toEqual(["queue", "history"]);
    expect(result).toEqual([{ section: "Location", detail: "Location unavailable" }]);
  });
  it("drops late results after account, thread or relay scope is aborted", async () => {
    const abort = new AbortController();
    const next = Promise.withResolvers<RelayPortableThreadPlacement>();
    const calls: string[] = [];
    const refresh = refreshSavedConversation({
      signal: abort.signal,
      placement: () => next.promise,
      status: async () => {
        calls.push("status");
      },
      queue: async () => {
        calls.push("queue");
      },
      history: async () => {
        calls.push("history");
      },
    });
    abort.abort();
    next.resolve(placement);
    expect(await refresh).toEqual([]);
    expect(calls).toEqual([]);
  });
});
