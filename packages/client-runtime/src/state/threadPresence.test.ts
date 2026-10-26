import { describe, expect, it } from "vite-plus/test";
import { AuthSessionId, ThreadId, type ThreadPresenceParticipant } from "@t3tools/contracts";
import {
  collapseThreadPresence,
  threadPresenceInitials,
  threadPresenceLabel,
  threadPresenceName,
  type ThreadPresencePerson,
} from "./threadPresence.ts";
const threadId = ThreadId.make("thread-1");
const viewer = { sessionId: AuthSessionId.make("viewer-session"), userId: "alice" };
function participant(
  overrides: Partial<ThreadPresenceParticipant> & { connectionId: string },
): ThreadPresenceParticipant {
  return {
    sessionId: AuthSessionId.make(overrides.connectionId),
    clientDeviceType: "desktop",
    clientOs: "macOS",
    clientBrowser: "Chrome",
    threadId,
    user: null,
    clientLabel: null,
    typing: false,
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}
function person(overrides: Partial<ThreadPresencePerson>): ThreadPresencePerson {
  return {
    key: "a",
    displayName: "Alice",
    imageUrl: null,
    email: null,
    userId: null,
    clientDetails: null,
    isSelf: false,
    typing: false,
    ...overrides,
  };
}
describe("collapseThreadPresence", () => {
  it("groups verified accounts, merges enriched profiles and typing, and uses this environment's viewer", () => {
    const input = [
      participant({
        connectionId: "c1",
        user: { userId: "alice", displayName: null, imageUrl: null },
      }),
      participant({
        connectionId: "c2",
        user: {
          userId: "alice",
          displayName: "Alice Smith",
          imageUrl: "https://img/alice.png",
          email: "alice@example.com",
        },
        typing: true,
      }),
      participant({ connectionId: "c3", threadId: ThreadId.make("other") }),
    ];
    expect(collapseThreadPresence(input, threadId, viewer)).toEqual([]);
    const all = collapseThreadPresence(input, threadId, viewer, true);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      displayName: "Alice Smith",
      email: "alice@example.com",
      imageUrl: "https://img/alice.png",
      isSelf: true,
      typing: true,
    });
    expect(
      collapseThreadPresence(input, threadId, { ...viewer, userId: "someone-else" }),
    ).toHaveLength(1);
  });
  it("deduplicates anonymous tabs by session, keeps different clients, and marks the viewer", () => {
    const own = participant({
      connectionId: "own",
      sessionId: viewer.sessionId,
      clientLabel: "My phone",
    });
    const input = [
      own,
      { ...own, connectionId: "second-tab", typing: true },
      participant({ connectionId: "other", clientLabel: "My phone" }),
    ];
    expect(collapseThreadPresence(input, threadId, { ...viewer, userId: null })).toHaveLength(1);
    const all = collapseThreadPresence(input, threadId, { ...viewer, userId: null }, true);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      isSelf: true,
      typing: true,
      displayName: "My phone",
      clientDetails: "macOS · Chrome",
    });
  });
  it("never treats an editable client name as verified identity", () => {
    const [verified, anonymous] = collapseThreadPresence(
      [
        participant({
          connectionId: "verified",
          clientLabel: "Alice",
          user: { userId: "user", displayName: null, imageUrl: null, email: "bob@example.com" },
        }),
        participant({ connectionId: "anonymous" }),
      ],
      threadId,
      null,
    );
    expect(threadPresenceName(verified!)).toBe("bob@example.com");
    expect(threadPresenceInitials(verified!)).toBe("B");
    expect(threadPresenceName(anonymous!)).toBe("macOS · Chrome");
    expect(threadPresenceInitials(person({ displayName: "Alice Smith" }))).toBe("AS");
    expect(threadPresenceName(person({ displayName: null }))).toBe("Member");
  });
});
describe("threadPresenceLabel", () => {
  it("is silent alone and preserves readable viewing/typing descriptions", () => {
    expect(threadPresenceLabel([])).toBeNull();
    const alice = person({});
    const bob = person({ key: "b", displayName: "Bob", typing: true });
    expect(threadPresenceLabel([alice])).toBe("Alice is here");
    expect(threadPresenceLabel([alice, bob])).toBe("Bob is typing…");
    expect(threadPresenceLabel([alice, { ...bob, typing: false }])).toBe("Alice and Bob are here");
  });
});
