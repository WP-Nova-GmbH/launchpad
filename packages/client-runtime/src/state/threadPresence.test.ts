import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type ThreadPresenceParticipant } from "@t3tools/contracts";

import { collapseThreadPresence, threadPresenceLabel } from "./threadPresence.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");

function participant(
  overrides: Partial<ThreadPresenceParticipant> & { readonly connectionId: string },
): ThreadPresenceParticipant {
  return {
    threadId,
    user: null,
    clientLabel: null,
    typing: false,
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

const alice = { userId: "user_alice", displayName: "Alice", imageUrl: null };
const bob = { userId: "user_bob", displayName: "Bob", imageUrl: "https://img/bob.png" };

describe("collapseThreadPresence", () => {
  it("keeps only this thread and merges one user's connections", () => {
    const people = collapseThreadPresence(
      [
        participant({ connectionId: "c1", user: alice }),
        participant({ connectionId: "c2", user: alice, typing: true }),
        participant({ connectionId: "c3", user: bob, threadId: otherThreadId }),
      ],
      threadId,
      null,
    );
    expect(people).toEqual([
      { key: "user:user_alice", displayName: "Alice", imageUrl: null, typing: true },
    ]);
  });

  it("drops the viewer's own user but keeps sessions without a user", () => {
    const people = collapseThreadPresence(
      [
        participant({ connectionId: "c1", user: alice }),
        participant({ connectionId: "c2", clientLabel: "Launchpad Desktop" }),
      ],
      threadId,
      alice.userId,
    );
    expect(people).toEqual([
      { key: "connection:c2", displayName: "Launchpad Desktop", imageUrl: null, typing: false },
    ]);
  });
});

describe("threadPresenceLabel", () => {
  it("is silent when alone", () => {
    expect(threadPresenceLabel([])).toBeNull();
  });

  it("prefers typing over viewing and names everyone", () => {
    const viewing = { key: "a", displayName: "Alice", imageUrl: null, typing: false };
    const typing = { key: "b", displayName: "Bob", imageUrl: null, typing: true };
    expect(threadPresenceLabel([viewing])).toBe("Alice is here");
    expect(threadPresenceLabel([viewing, { ...typing, typing: false }])).toBe(
      "Alice and Bob are here",
    );
    expect(threadPresenceLabel([viewing, typing])).toBe("Bob is typing…");
    expect(
      threadPresenceLabel([
        { ...viewing, typing: true },
        typing,
        { key: "c", displayName: null, imageUrl: null, typing: true },
      ]),
    ).toBe("Alice, Bob, and Someone are typing…");
  });
});
