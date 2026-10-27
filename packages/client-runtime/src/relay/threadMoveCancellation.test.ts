import { CommandId, MessageId, ThreadId, type ThreadMoveQueueEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createThreadMoveCancellation } from "./threadMoveCancellation.ts";

const scope = JSON.stringify(["alice", "https://relay.example", "source", "thread"]);
const entry: ThreadMoveQueueEntry = {
  kind: "move",
  messageId: MessageId.make("move"),
  destination: { kind: "vm" },
  revision: 1,
  acceptedSequence: 4,
  createdAt: "2026-10-22T10:00:00Z",
  state: "moving",
};
const command = (id = "cancel", revision = entry.revision) => ({
  threadId: ThreadId.make("thread"),
  messageId: entry.messageId,
  commandId: CommandId.make(id),
  expectedRevision: revision,
  createdAt: "2026-10-22T11:00:00Z",
});

describe("move cancellation feedback", () => {
  it("keeps accepted receipt state across a later failed or still-pending read", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.acknowledge(scope, first, { status: "accepted", sequence: 8 });
    cancellation.failed(scope, first);
    cancellation.acknowledge(scope, first, { status: "unknown" });
    expect(cancellation.pending(scope)).toEqual([first]);
    expect(cancellation.phase(scope, entry.messageId)).toBe("requested");
    expect(cancellation.prepare(scope, { ...entry, revision: 9 }, command)).toBeNull();
  });

  it("applies receipts before interpreting a lagging or terminal queue projection", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.failed(scope, first);
    const receipt = {
      commandId: first.commandId,
      position: 1,
      receipt: { status: "accepted" as const, sequence: 8 },
    };
    expect(
      cancellation.observe(scope, [entry], [{ commandId: first.commandId, receipt }]).changed,
    ).toBe(true);
    expect(cancellation.phase(scope, entry.messageId)).toBe("requested");
    expect(cancellation.observe(scope, [], [{ commandId: first.commandId, receipt }]).changed).toBe(
      true,
    );
    expect(cancellation.pending(scope)).toEqual([]);

    const rejectedCancellation = createThreadMoveCancellation();
    const rejected = rejectedCancellation.prepare(scope, entry, () => command("rejected"))!;
    rejectedCancellation.failed(scope, rejected);
    expect(
      rejectedCancellation.observe(
        scope,
        [],
        [
          {
            commandId: rejected.commandId,
            receipt: {
              commandId: rejected.commandId,
              position: 2,
              receipt: { status: "rejected", detail: "Too late to cancel" },
            },
          },
        ],
      ),
    ).toEqual({ changed: true, rejection: "Too late to cancel" });
    expect(rejectedCancellation.pending(scope)).toEqual([]);
  });

  it("blocks duplicate clicks while sending and after relay staging, including progress updates", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    expect(cancellation.prepare(scope, entry, () => command("duplicate"))).toBeNull();
    expect(
      cancellation.acknowledge(scope, first, {
        relay: { commandId: first.commandId, position: 7, receipt: null },
      }),
    ).toEqual({ status: "accepted" });
    expect(cancellation.phase(scope, entry.messageId)).toBe("requested");
    const progress = { ...entry, revision: 8, detail: "Preparing workspace" };
    expect(cancellation.observe(scope, [progress], []).changed).toBe(false);
    expect(cancellation.prepare(scope, progress, () => command("duplicate", 8))).toBeNull();
    const cancelling = { ...progress, state: "cancelling" as const };
    expect(cancellation.observe(scope, [cancelling], []).changed).toBe(true);
    expect(cancellation.prepare(scope, cancelling, () => command("duplicate"))).toBeNull();
  });

  it("retries the complete original input after a transport failure or unknown receipt", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.failed(scope, first);
    expect(cancellation.phase(scope, entry.messageId)).toBe("unknown");
    const retry = cancellation.prepare(scope, { ...entry, revision: 8 }, () => {
      throw new Error("Must reuse the same ID, timestamp and expected revision");
    })!;
    expect(retry).toBe(first);
    expect(cancellation.acknowledge(scope, retry, { status: "unknown" })).toEqual({
      status: "unknown",
    });
    expect(cancellation.prepare(scope, { ...entry, revision: 9 }, command)).toBe(first);
  });

  it("allows a fresh attempt after an explicit local rejection with the current revision", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.failed(scope, first);
    expect(
      cancellation.acknowledge(scope, first, {
        status: "rejected",
        detail: "The move revision changed.",
      }),
    ).toEqual({ status: "rejected", detail: "The move revision changed." });
    expect(cancellation.phase(scope, entry.messageId)).toBeUndefined();
    expect(
      cancellation.prepare(scope, { ...entry, revision: 8 }, () => command("fresh", 8)),
    ).toEqual(command("fresh", 8));
  });

  it("shows a later environment rejection and releases only the rejected cancellation", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.acknowledge(scope, first, {
      relay: { commandId: first.commandId, position: 7, receipt: null },
    });
    expect(
      cancellation.observe(
        scope,
        [entry],
        [
          {
            commandId: "another-command",
            receipt: {
              commandId: "another-command",
              position: 6,
              receipt: { status: "rejected", detail: "Unrelated error" },
            },
          },
        ],
      ).changed,
    ).toBe(false);
    expect(
      cancellation.observe(
        scope,
        [entry],
        [
          {
            commandId: first.commandId,
            receipt: {
              commandId: first.commandId,
              position: 7,
              receipt: { status: "rejected", detail: "Cancellation is no longer permitted." },
            },
          },
        ],
      ),
    ).toEqual({ changed: true, rejection: "Cancellation is no longer permitted." });
    expect(cancellation.prepare(scope, entry, () => command("fresh"))).toEqual(command("fresh"));
  });

  it("drops feedback once the move disappears and ignores replies for a different client scope", () => {
    const cancellation = createThreadMoveCancellation();
    const first = cancellation.prepare(scope, entry, command)!;
    cancellation.acknowledge(scope, first, { sequence: 10 });
    expect(cancellation.observe(scope, [], []).changed).toBe(true);
    expect(cancellation.phase(scope, entry.messageId)).toBeUndefined();
    cancellation.prepare(scope, entry, command);
    const other = JSON.stringify(["bob", "https://other-relay.example", "target", "thread"]);
    const second = cancellation.prepare(other, entry, () => command("other"))!;
    expect(cancellation.acknowledge(scope, first, { sequence: 11 })).toBeNull();
    cancellation.failed(scope, first);
    expect(cancellation.phase(other, entry.messageId)).toBe("sending");
    cancellation.acknowledge(other, second, { sequence: 12 });
    expect(cancellation.phase(other, entry.messageId)).toBe("requested");
  });
});
