import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadPresence from "./ThreadPresence.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const alice = { userId: "user_alice", displayName: "Alice", imageUrl: null };

describe("ThreadPresenceService", () => {
  it.effect("tracks one participant per connection and drops it on clear", () =>
    Effect.gen(function* () {
      const presence = yield* ThreadPresence.ThreadPresenceService;
      yield* presence.report({
        connectionId: "c1",
        user: alice,
        clientLabel: null,
        threadId: threadA,
        typing: false,
      });
      yield* presence.report({
        connectionId: "c2",
        user: null,
        clientLabel: "Launchpad Desktop",
        threadId: threadB,
        typing: true,
      });
      const before = yield* presence.snapshot;
      expect(before.participants.map((p) => [p.connectionId, p.threadId, p.typing])).toEqual([
        ["c1", threadA, false],
        ["c2", threadB, true],
      ]);

      yield* presence.clear("c1");
      yield* presence.report({
        connectionId: "c2",
        user: null,
        clientLabel: "Launchpad Desktop",
        threadId: null,
        typing: false,
      });
      const after = yield* presence.snapshot;
      expect(after.participants).toEqual([]);
    }).pipe(Effect.provide(ThreadPresence.layer)),
  );

  it.effect("publishes a snapshot only when something visible changed", () =>
    Effect.gen(function* () {
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const { latest, changes } = yield* presence.subscribe;
      expect(latest.participants).toEqual([]);
      const collector = yield* changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;

      const typing = {
        connectionId: "c1",
        user: alice,
        clientLabel: null,
        threadId: threadA,
        typing: true,
      };
      yield* presence.report(typing);
      // Renewing a live typing lease is not news to anyone.
      yield* presence.report(typing);
      yield* presence.report({ ...typing, typing: false });

      const published = Array.from(yield* Fiber.join(collector));
      expect(published.map((snapshot) => snapshot.participants[0]?.typing)).toEqual([true, false]);
    }).pipe(Effect.scoped, Effect.provide(ThreadPresence.layer)),
  );

  it.effect("lets a typing lease lapse without a report", () =>
    Effect.gen(function* () {
      const presence = yield* ThreadPresence.ThreadPresenceService;
      const { changes } = yield* presence.subscribe;
      const collector = yield* changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* presence.report({
        connectionId: "c1",
        user: alice,
        clientLabel: null,
        threadId: threadA,
        typing: true,
      });
      yield* TestClock.adjust(ThreadPresence.TYPING_LEASE_MILLIS + 2_000);
      const published = Array.from(yield* Fiber.join(collector));
      expect(published.map((snapshot) => snapshot.participants[0]?.typing)).toEqual([true, false]);
    }).pipe(Effect.scoped, Effect.provide(ThreadPresence.layer)),
  );
});
